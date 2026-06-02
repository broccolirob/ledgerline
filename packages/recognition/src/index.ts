// @ledgerline/recognition — Milestone 2.
// Turns a DELIVERED (2xx) + verified + settled `raw_event` (the M1 Path-C receipt analog) into a
// recognized `revenue_event` and a balanced double-entry `journal_transaction` + `ledger_entries`.
//
// Runs OFF the response critical path (a subledger, not middleware): it reads already-persisted
// raw_events. Integer atomic-unit (bigint) math only; numeric(78,0) bound as strings; 0x-prefixed
// hex stripped before bytea binds. No-overclaim throughout (no Circle-issued signed offer/receipt).
//
// NOTE ON FILE LAYOUT: the plan (§8) listed a separate `templates.ts`/`types.ts`; they are folded
// into this single module so the test-imported entry point has ZERO internal relative imports —
// sidestepping the NodeNext / Vite `.js`-relative-resolution friction the plan flagged in §7.1.
// The declarative leg-spec design is preserved as the "POSTING TEMPLATES" section below.

import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
// Type-only re-use of the seller-client `Db` seam (pg Pool | PoolClient); erased at runtime.
import { verifyRawEventSignature, type Db } from '@ledgerline/seller-client';

export type { Db };

/** Demo tenant seeded by migration 0002. */
export const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
/** Demo seed identities resolved by {@link resolveDemoConfig} (migration 0004). */
export const DEMO_PRICING_NAME = 'company-brief-exact';
export const DEMO_SPLIT_GROUP_NAME = 'company-brief-default';
/** The only receipt-analog event the recognition pass consumes. */
export const RECEIPT_ANALOG_EVENT_TYPE = 'ledgerline.receipt_analog.v1';

// ============================================================================
// TYPES
// ============================================================================

/** Row shape of raw_events as returned by pg. id is TEXT (string); event_seq is bigserial (string). */
export interface RawEventRow {
  id: string;
  tenant_id: string;
  event_type: string;
  event_source: string;
  occurred_at: Date;
  payload_redacted: Record<string, unknown>;
  event_seq: string;
  idempotency_key?: string; // loaded for adapter-signature verification (M6b)
  adapter_key_id?: string | null;
  adapter_signature?: string | null;
}

export interface RecognitionConfig {
  tenantId: string;
  pricingModelId: string;
  splitGroupId: string;
  splitGroupVersion: number;
  /** M6b/T6: when true, every raw event must carry a valid adapter signature from an active registry
   *  key; unsigned/forged/unknown-key/revoked events are rejected (no revenue). Default false keeps
   *  the local/OSS pipeline backward-compatible with existing unsigned captures. */
  requireAdapterSignature?: boolean;
  /** keyId -> Ed25519 SPKI public-key PEM (the tenant's active keys; see resolveAdapterKeys). When
   *  requireAdapterSignature is set and this is absent, runRecognitionPass resolves it once. */
  adapterKeys?: Map<string, string>;
}

export type DeliveryStatus = 'delivered' | 'failed' | 'canceled';

/** Parsed revenue signals lifted out of raw_events.payload_redacted. *Hex fields are 0x-prefixed. */
export interface ParsedReceipt {
  rawEventId: string;
  idempotencyAnchor: string; // settlementReference ?? paymentSignatureHash ?? requestFingerprint
  requestFingerprintHex: string;
  amountAtomic: bigint;
  asset: string;
  network: string;
  payerHashHex: string;
  paymentSignatureHashHex?: string;
  settlementReference?: string;
  payTo?: string;
  verified: boolean; // recognition requires === true
  deliveryStatus: DeliveryStatus;
  httpStatus: number;
  responseBodyHashHex?: string;
  latencyMs?: number;
  occurredAt: Date;
}

/** A split_rules row as read from the DB (percentage_bps is int → number; amounts → string). */
export interface SplitRuleRow {
  id: string;
  recipient_id: string;
  role: string;
  percentage_bps: number | null;
  fixed_amount_atomic: string | null;
}

export interface SupplierShare {
  recipientId: string;
  role: string;
  amountAtomic: bigint;
}

export interface SplitAllocation {
  grossAmountAtomic: bigint;
  publisherRecipientId: string;
  sellerShare: bigint; // publisher amount (includes dust when dust → publisher)
  supplierShares: SupplierShare[]; // non-publisher, non-zero
  dustRecipientId: string;
  dustAtomic: bigint;
}

export type Direction = 'debit' | 'credit';

// owner_type is restricted to what the live R1' + agent_net fixture actually use. 'platform' is
// intentionally absent: there is no platform value-chain role (§18.2) and no live M2 leg is platform-owned.
export interface AccountSelector {
  account_type: 'receivable' | 'revenue' | 'expense_cogs' | 'expense_referral' | 'payable';
  owner_type: 'seller' | 'supplier';
  owner_id?: string; // recipient_id ONLY on supplier payable legs
}

export type AmountSource =
  | { kind: 'gross' }
  | { kind: 'seller_share' }
  | { kind: 'split_share'; recipientId: string };

export interface LegSpec {
  direction: Direction;
  account: AccountSelector;
  amount: AmountSource;
  memo: string;
}

export interface PostingContext {
  revenueEvent: { id: string; tenantId: string; grossAmountAtomic: bigint; asset: string };
  treatment: 'principal_gross' | 'agent_net';
  allocation: SplitAllocation;
}

export type RecognitionOutcome = 'recognized' | 'replayed' | 'F1_skipped' | 'rejected_unsigned';

export interface RecognitionResult {
  rawEventId: string;
  interactionId?: string; // absent when an event is rejected before any interaction is created (T6)
  outcome: RecognitionOutcome;
  revenueEventId?: string;
  journalTxnId?: string;
  legCount?: number;
}

export interface RecognitionPassSummary {
  total: number;
  recognized: number;
  replayed: number;
  f1Skipped: number;
  rejectedUnsigned: number; // M6b/T6: events rejected for a missing/invalid/unknown-key signature
  errors: Array<{ rawEventId: string; message: string }>;
  maxEventSeq?: string;
}

// ============================================================================
// PARSE + HEX (pure)
// ============================================================================

function asRecord(v: unknown, ctx: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`parseReceipt: expected an object at "${ctx}"`);
  }
  return v as Record<string, unknown>;
}
function asString(v: unknown, ctx: string): string {
  if (typeof v !== 'string') throw new Error(`parseReceipt: expected a string at "${ctx}"`);
  return v;
}
function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asNumber(v: unknown, ctx: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`parseReceipt: expected a finite number at "${ctx}"`);
  }
  return v;
}

/** Pure parse + validation. Throws on malformed/zero/negative/non-integer amount or bad shape. */
export function parseReceipt(rawEvent: RawEventRow): ParsedReceipt {
  const p = asRecord(rawEvent.payload_redacted, 'payload_redacted');
  const pay = asRecord(p.payment, 'payment');
  const del = asRecord(p.delivery, 'delivery');

  const amountStr = asString(pay.amountAtomic, 'payment.amountAtomic');
  // Positive integer, no leading zero / sign / decimal / 0x / exponent (LCJ numeric discipline).
  if (!/^[1-9][0-9]*$/.test(amountStr)) {
    throw new Error(`parseReceipt: payment.amountAtomic must be a positive integer string, got "${amountStr}"`);
  }
  const amountAtomic = BigInt(amountStr);

  const requestFingerprintHex = asString(p.requestFingerprint, 'requestFingerprint');
  const payerHashHex = asString(pay.payerHash, 'payment.payerHash');
  const paymentSignatureHashHex = optString(pay.paymentSignatureHash);
  const settlementReference = optString(pay.settlementReference);

  const statusRaw = asString(del.status, 'delivery.status');
  if (statusRaw !== 'delivered' && statusRaw !== 'failed' && statusRaw !== 'canceled') {
    throw new Error(`parseReceipt: unexpected delivery.status "${statusRaw}"`);
  }

  return {
    rawEventId: rawEvent.id,
    idempotencyAnchor: settlementReference ?? paymentSignatureHashHex ?? requestFingerprintHex,
    requestFingerprintHex,
    amountAtomic,
    asset: optString(pay.asset) ?? 'USDC',
    network: asString(pay.network, 'payment.network'),
    payerHashHex,
    paymentSignatureHashHex,
    settlementReference,
    payTo: optString(pay.payTo),
    verified: pay.verified === true,
    deliveryStatus: statusRaw,
    httpStatus: asNumber(del.httpStatus, 'delivery.httpStatus'),
    responseBodyHashHex: optString(del.responseBodyHash),
    latencyMs: typeof del.latencyMs === 'number' ? del.latencyMs : undefined,
    occurredAt: rawEvent.occurred_at,
  };
}

/** Strip a leading '0x' (if present) and return a Buffer for a bytea bind. */
export function hexToBytea(hex0x: string): Buffer {
  const hex = hex0x.startsWith('0x') ? hex0x.slice(2) : hex0x;
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`hexToBytea: invalid hex "${hex0x}"`);
  }
  return Buffer.from(hex, 'hex');
}

// ============================================================================
// SPLIT ALLOCATION (pure, bigint, largest-remainder dust)
// ============================================================================

/**
 * Pure integer (bigint) split allocation. M2 supports pure-percentage rules only; any fixed-amount
 * or mixed rule is runtime-rejected (deferred §18.14). Dust (gross − Σfloors) is allocated
 * deterministically to `dustRecipientId`, defaulting to the publisher/seller. Zero-amount supplier
 * shares are omitted. sellerShare = the publisher recipient's amount (incl. dust when default).
 */
export function allocateSplit(
  grossAmountAtomic: bigint,
  rules: SplitRuleRow[],
  dustRecipientId?: string,
): SplitAllocation {
  if (grossAmountAtomic <= 0n) throw new Error('allocateSplit: gross must be a positive integer');
  if (rules.length === 0) throw new Error('allocateSplit: no split rules');

  let bpsSum = 0;
  const seen = new Set<string>();
  for (const r of rules) {
    if (r.percentage_bps === null || r.fixed_amount_atomic !== null) {
      throw new Error(`allocateSplit: rule ${r.id} is fixed/mixed — only pure-percentage is supported in M2 (§18.14 deferred)`);
    }
    if (r.percentage_bps < 0 || r.percentage_bps > 10000) {
      throw new Error(`allocateSplit: rule ${r.id} percentage_bps out of range`);
    }
    if (seen.has(r.recipient_id)) {
      throw new Error(`allocateSplit: duplicate recipient_id ${r.recipient_id} in split group`);
    }
    seen.add(r.recipient_id);
    bpsSum += r.percentage_bps;
  }
  // Pure-percentage groups must allocate exactly 100%. Rejecting under-100% (not just over-100%)
  // prevents a misconfigured group from silently dumping a STRUCTURAL shortfall into the publisher
  // via the dust path — dust is only the floor-rounding remainder (≤ recipient count), never a bps gap.
  if (bpsSum !== 10000) throw new Error(`allocateSplit: total bps must equal 10000 (100%), got ${bpsSum}`);

  const publisherRules = rules.filter((r) => r.role === 'publisher');
  if (publisherRules.length !== 1) {
    throw new Error(`allocateSplit: expected exactly one 'publisher' rule, found ${publisherRules.length}`);
  }
  const publisherRule = publisherRules[0]!;

  // Integer floor per rule.
  const amounts = new Map<string, bigint>();
  let floorSum = 0n;
  for (const r of rules) {
    const amt = (grossAmountAtomic * BigInt(r.percentage_bps!)) / 10000n;
    amounts.set(r.recipient_id, amt);
    floorSum += amt;
  }
  const dust = grossAmountAtomic - floorSum; // >= 0; pure floor-rounding remainder (bpsSum === 10000)

  const dustRid = dustRecipientId ?? publisherRule.recipient_id;
  if (!amounts.has(dustRid)) {
    throw new Error(`allocateSplit: dustRecipientId ${dustRid} is not a recipient in this split group`);
  }
  amounts.set(dustRid, amounts.get(dustRid)! + dust);

  const sellerShare = amounts.get(publisherRule.recipient_id)!;
  const supplierShares: SupplierShare[] = rules
    .filter((r) => r.recipient_id !== publisherRule.recipient_id)
    .map((r) => ({ recipientId: r.recipient_id, role: r.role, amountAtomic: amounts.get(r.recipient_id)! }))
    .filter((s) => s.amountAtomic > 0n); // zero-amount legs omitted (§18.14)

  return {
    grossAmountAtomic,
    publisherRecipientId: publisherRule.recipient_id,
    sellerShare,
    supplierShares,
    dustRecipientId: dustRid,
    dustAtomic: dust,
  };
}

// ============================================================================
// POSTING TEMPLATES (declarative leg specs) — §18.6 / §18.7
// ============================================================================

const REFERRAL_ROLES = new Set(['referrer', 'marketplace']);

/**
 * Build the declarative leg specs for a treatment. R1' principal_gross is wired live; R1 agent_net
 * is exercised only as a test fixture (never invoked by the recognition module). No amounts are
 * hardcoded — they resolve from the context via {@link resolveLegAmount}.
 *
 * R1' principal_gross: Dr Receivable=gross, Cr Revenue=gross; per supplier a balanced
 *   Dr COGS|Referral(seller) / Cr Payable(supplier) pair. The publisher share is NOT a leg
 *   (the seller keeps it implicitly as margin). COGS/Referral debits are SELLER-owned (single
 *   account each); the per-supplier distinction lives in the memo, not a separate account.
 * R1 agent_net (fixture): Dr Receivable=gross, Cr Revenue=sellerShare; per supplier Cr Payable only.
 */
export function buildPostingLegs(ctx: PostingContext): LegSpec[] {
  const legs: LegSpec[] = [];
  legs.push({
    direction: 'debit',
    account: { account_type: 'receivable', owner_type: 'seller' },
    amount: { kind: 'gross' },
    memo: 'Receivable — seller',
  });

  if (ctx.treatment === 'principal_gross') {
    legs.push({
      direction: 'credit',
      account: { account_type: 'revenue', owner_type: 'seller' },
      amount: { kind: 'gross' },
      memo: 'Revenue — seller',
    });
    for (const s of ctx.allocation.supplierShares) {
      const isReferral = REFERRAL_ROLES.has(s.role);
      legs.push({
        direction: 'debit',
        account: { account_type: isReferral ? 'expense_referral' : 'expense_cogs', owner_type: 'seller' },
        amount: { kind: 'split_share', recipientId: s.recipientId },
        memo: isReferral ? `Referral / marketplace expense — ${s.role}` : `COGS — ${s.role} share`,
      });
      legs.push({
        direction: 'credit',
        account: { account_type: 'payable', owner_type: 'supplier', owner_id: s.recipientId },
        amount: { kind: 'split_share', recipientId: s.recipientId },
        memo: `Payable — ${s.role}`,
      });
    }
  } else {
    // agent_net (fixture only): revenue credit is the net seller/publisher share; no expense legs.
    legs.push({
      direction: 'credit',
      account: { account_type: 'revenue', owner_type: 'seller' },
      amount: { kind: 'seller_share' },
      memo: 'Revenue — seller (net)',
    });
    for (const s of ctx.allocation.supplierShares) {
      legs.push({
        direction: 'credit',
        account: { account_type: 'payable', owner_type: 'supplier', owner_id: s.recipientId },
        amount: { kind: 'split_share', recipientId: s.recipientId },
        memo: `Payable — ${s.role}`,
      });
    }
  }
  return legs;
}

/** Resolve a leg's AmountSource to a concrete bigint amount from the posting context. */
export function resolveLegAmount(src: AmountSource, ctx: PostingContext): bigint {
  switch (src.kind) {
    case 'gross':
      return ctx.revenueEvent.grossAmountAtomic;
    case 'seller_share':
      return ctx.allocation.sellerShare;
    case 'split_share': {
      const s = ctx.allocation.supplierShares.find((x) => x.recipientId === src.recipientId);
      if (!s) throw new Error(`resolveLegAmount: no supplier share for recipient ${src.recipientId}`);
      return s.amountAtomic;
    }
  }
}

export interface ResolvedLeg {
  direction: Direction;
  account: AccountSelector;
  amountAtomic: bigint;
  asset: string;
  memo: string;
}

/** Resolve declarative legs to concrete amounts, dropping any zero-amount leg (§18.14). */
export function resolveLegs(ctx: PostingContext): ResolvedLeg[] {
  return buildPostingLegs(ctx)
    .map((l) => ({
      direction: l.direction,
      account: l.account,
      amountAtomic: resolveLegAmount(l.amount, ctx),
      asset: ctx.revenueEvent.asset,
      memo: l.memo,
    }))
    .filter((l) => l.amountAtomic > 0n);
}

/** Invariant 1: ΣDr == ΣCr PER ASSET. Throws if unbalanced (§18.16 refuse-to-persist). Grouping by
 *  asset matches audit.sql and the plan's "per asset" wording; in M2 every leg is USDC (one bucket). */
export function assertBalanced(legs: ResolvedLeg[]): void {
  const byAsset = new Map<string, { debits: bigint; credits: bigint }>();
  for (const l of legs) {
    const b = byAsset.get(l.asset) ?? { debits: 0n, credits: 0n };
    if (l.direction === 'debit') b.debits += l.amountAtomic;
    else b.credits += l.amountAtomic;
    byAsset.set(l.asset, b);
  }
  for (const [asset, b] of byAsset) {
    if (b.debits !== b.credits) {
      throw new Error(`assertBalanced: unbalanced journal for asset ${asset} — ΣDr=${b.debits} ΣCr=${b.credits}`);
    }
  }
}

// ============================================================================
// DB: account resolution + recognition
// ============================================================================

const NULL_OWNER_SENTINEL = '00000000-0000-0000-0000-000000000000';

function accountName(sel: AccountSelector): string {
  switch (sel.account_type) {
    case 'receivable':
      return 'Receivable — seller';
    case 'revenue':
      return 'Revenue — seller';
    case 'expense_cogs':
      return 'COGS — seller';
    case 'expense_referral':
      return 'Referral / marketplace expense — seller';
    case 'payable':
      return `Payable — ${sel.owner_id ?? 'supplier'}`;
  }
}

/**
 * Resolve (or create) the canonical ledger account for a selector. Idempotent via the natural-key
 * EXPRESSION index (§2.3): the `on conflict (...)` clause restates the exact index expression, and
 * because `do nothing` returns no row on a hit we fall back to a SELECT to read the id. Seller-owned
 * legs bind owner_id NULL → the sentinel collapses them onto a single account.
 * Live R1' path only ever passes owner_type in {seller, supplier}; never 'platform'.
 */
export async function resolveLedgerAccount(
  db: Db,
  tenantId: string,
  sel: AccountSelector,
  asset: string,
): Promise<string> {
  const ownerId = sel.owner_id ?? null;
  const ins = await db.query<{ id: string }>(
    `insert into ledger_accounts (id, tenant_id, account_type, owner_type, owner_id, asset, name)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (tenant_id, account_type, owner_type, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), asset)
       do nothing
     returning id`,
    [randomUUID(), tenantId, sel.account_type, sel.owner_type, ownerId, asset, accountName(sel)],
  );
  const inserted = ins.rows[0];
  if (inserted) return inserted.id;

  const sel2 = await db.query<{ id: string }>(
    `select id from ledger_accounts
      where tenant_id=$1 and account_type=$2 and owner_type=$3
        and coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce($4::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        and asset=$5`,
    [tenantId, sel.account_type, sel.owner_type, ownerId, asset],
  );
  const found = sel2.rows[0];
  if (!found) throw new Error(`resolveLedgerAccount: failed to resolve account ${sel.account_type}/${sel.owner_type}`);
  return found.id;
}

/**
 * Recognize ONE raw_event. Idempotency is anchored on the interaction-existence gate: recognizeOne
 * runs in a single transaction, so "interaction already exists" ⟺ "the full consistent set for this
 * event already committed" → a clean replay no-op (covers service_deliveries, which has no unique
 * key). Unique constraints on interaction / artifact / revenue_event / posting_key / collection_state
 * are DB-level backstops.
 *
 * Transaction control: a PoolClient (test injection) is used as-is — the caller owns BEGIN/COMMIT.
 * A Pool acquires its own client and runs BEGIN…COMMIT/ROLLBACK internally.
 */
export async function recognizeOne(
  db: Db,
  cfg: RecognitionConfig,
  rawEvent: RawEventRow,
): Promise<RecognitionResult> {
  if ('release' in db) {
    // Caller owns BEGIN/COMMIT. Wrap in a SAVEPOINT so a throw rolls back ONLY this call's work and
    // leaves the caller's surrounding transaction usable (safe multi-call composition on one client).
    await db.query('savepoint ll_recognize');
    try {
      const result = await recognizeOnClient(db, cfg, rawEvent);
      await db.query('release savepoint ll_recognize');
      return result;
    } catch (e) {
      try {
        await db.query('rollback to savepoint ll_recognize');
      } catch {
        /* preserve the original error */
      }
      throw e;
    }
  }
  const client = await (db as Pool).connect();
  let failed = false;
  try {
    await client.query('begin');
    const result = await recognizeOnClient(client, cfg, rawEvent);
    await client.query('commit');
    return result;
  } catch (e) {
    failed = true;
    // Guard the rollback so a broken-connection rollback error can't MASK the real error `e`.
    try {
      await client.query('rollback');
    } catch {
      /* connection likely dead; it is destroyed via release(true) below */
    }
    throw e;
  } finally {
    // release(true) DESTROYS a poisoned client instead of returning it to the pool for reuse.
    client.release(failed || undefined);
  }
}

async function recognizeOnClient(
  client: PoolClient,
  cfg: RecognitionConfig,
  rawEvent: RawEventRow,
): Promise<RecognitionResult> {
  // Per-tenant advisory lock narrows the gate's TOCTOU window. SCOPE: on the Pool path recognizeOne
  // runs one txn PER ROW, so this xact-scoped lock serializes the per-row gate check, not a whole
  // pass — concurrent same-tenant passes still interleave at row boundaries. The interaction unique
  // constraint is the actual duplicate-recognition backstop; the lock just avoids wasted rollbacks.
  // Different tenants never block each other. Released at the row's COMMIT/ROLLBACK.
  await client.query('select pg_advisory_xact_lock(hashtext($1))', [cfg.tenantId]);

  // M6b / T6: gate on the adapter signature BEFORE parsing or writing anything, so a forged/unsigned
  // event never becomes revenue and never creates a row. Default-off (requireAdapterSignature) keeps
  // the OSS pipeline backward-compatible with existing unsigned captures.
  if (cfg.requireAdapterSignature) {
    const keyId = rawEvent.adapter_key_id ?? undefined;
    const sig = rawEvent.adapter_signature ?? undefined;
    const pubPem = keyId ? cfg.adapterKeys?.get(keyId) : undefined;
    const ok =
      typeof keyId === 'string' &&
      typeof sig === 'string' &&
      typeof pubPem === 'string' &&
      typeof rawEvent.idempotency_key === 'string' &&
      verifyRawEventSignature(
        {
          tenantId: rawEvent.tenant_id,
          idempotencyKey: rawEvent.idempotency_key,
          payloadRedacted: rawEvent.payload_redacted,
        },
        sig,
        pubPem,
      );
    if (!ok) return { rawEventId: rawEvent.id, outcome: 'rejected_unsigned' };
  }

  const r = parseReceipt(rawEvent);
  // Weak-anchor observability: with neither a Gateway settlementReference nor a paymentSignatureHash,
  // the idempotency anchor degrades to the request fingerprint, which is identical across two distinct
  // purchases of the same request — so a genuine second sale would be swallowed as a 'replayed' no-op.
  // Unreachable in the demo (Gateway always supplies settlementReference); warn so it is observable.
  if (!r.settlementReference && !r.paymentSignatureHashHex) {
    console.warn(
      `[recognition] weak idempotency anchor for raw_event ${r.rawEventId}: no settlementReference or ` +
        `paymentSignatureHash — deduping on requestFingerprint, which cannot distinguish two identical requests`,
    );
  }
  const recognize = r.verified && r.deliveryStatus === 'delivered';
  const interactionStatus = recognize ? 'delivered' : r.deliveryStatus === 'canceled' ? 'canceled' : 'failed';

  // 1. interaction — the idempotency gate.
  const insInteraction = await client.query<{ id: string }>(
    `insert into interactions
       (id, tenant_id, endpoint_id, interaction_type, request_fingerprint, payment_identifier,
        payer_address_hash, status, raw_event_id, created_at, updated_at)
     values ($1,$2,NULL,'purchase',$3,$4,$5,$6,$7,now(),now())
     on conflict (tenant_id, payment_identifier) do nothing
     returning id`,
    [
      randomUUID(),
      cfg.tenantId,
      hexToBytea(r.requestFingerprintHex),
      r.idempotencyAnchor,
      hexToBytea(r.payerHashHex),
      interactionStatus,
      r.rawEventId,
    ],
  );

  const freshInteraction = insInteraction.rows[0];
  if (!freshInteraction) {
    // Replay: the full consistent set already committed in a prior run (single-txn atomicity).
    const existing = await client.query<{ id: string }>(
      `select id from interactions where tenant_id=$1 and payment_identifier=$2`,
      [cfg.tenantId, r.idempotencyAnchor],
    );
    const id = existing.rows[0];
    if (!id) throw new Error('recognizeOne: interaction conflict but no existing row found');
    return { rawEventId: r.rawEventId, interactionId: id.id, outcome: 'replayed' };
  }
  const interactionId = freshInteraction.id;

  // 2. x402 payment artifact (no-overclaim: 'payment_signature', not signed_receipt).
  // The artifact dedup key (artifact_hash) differs from the interaction gate key (payment_identifier):
  // a fresh interaction could still hit an artifact conflict if a PRIOR interaction shared this
  // paymentSignatureHash under a different settlementReference. That would leave this recognized
  // revenue with no artifact row, so treat a conflict here as an invariant violation and fail loudly
  // (mirrors the journal-insert guard below). Atomic: the whole txn rolls back.
  const artifactHashHex = r.paymentSignatureHashHex ?? r.requestFingerprintHex;
  const insArtifact = await client.query(
    `insert into x402_payment_artifacts
       (id, tenant_id, interaction_id, artifact_type, artifact_hash, network, asset, amount_atomic,
        pay_to_address, payment_identifier, settlement_reference, issued_at)
     values ($1,$2,$3,'payment_signature',$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (tenant_id, artifact_type, artifact_hash) do nothing`,
    [
      randomUUID(),
      cfg.tenantId,
      interactionId,
      hexToBytea(artifactHashHex),
      r.network,
      r.asset,
      r.amountAtomic.toString(),
      r.payTo ?? null,
      r.idempotencyAnchor,
      r.settlementReference ?? null,
      r.occurredAt,
    ],
  );
  if (insArtifact.rowCount === 0) {
    throw new Error(
      `recognizeOne: fresh interaction ${interactionId} but payment artifact_hash ${artifactHashHex} ` +
        `already exists under another interaction — cross-key collision (paymentSignatureHash reused ` +
        `across distinct settlementReferences)`,
    );
  }

  // 3. service_delivery — this row IS the §18.11 failure record on the F1 path.
  await client.query(
    `insert into service_deliveries
       (id, tenant_id, interaction_id, endpoint_id, delivery_status, http_status, response_body_hash,
        latency_ms, delivered_at)
     values ($1,$2,$3,NULL,$4,$5,$6,$7,$8)`,
    [
      randomUUID(),
      cfg.tenantId,
      interactionId,
      r.deliveryStatus,
      r.httpStatus,
      r.responseBodyHashHex ? hexToBytea(r.responseBodyHashHex) : null,
      r.latencyMs ?? null,
      recognize ? r.occurredAt : null,
    ],
  );

  // 4. F1 — not (verified && delivered): failure record only, NO journal/revenue/collection_state.
  if (!recognize) {
    return { rawEventId: r.rawEventId, interactionId, outcome: 'F1_skipped' };
  }

  // 5. Invariant 2 — exact-pricing tie-out: settled gross == configured fixed price.
  const pm = await client.query<{ fixed_amount_atomic: string }>(
    `select fixed_amount_atomic from pricing_models where id=$1 and tenant_id=$2 and pricing_type='exact'`,
    [cfg.pricingModelId, cfg.tenantId],
  );
  const pmRow = pm.rows[0];
  if (!pmRow || pmRow.fixed_amount_atomic === null) {
    throw new Error('recognizeOne: exact pricing_model not found for config.pricingModelId');
  }
  if (BigInt(pmRow.fixed_amount_atomic) !== r.amountAtomic) {
    throw new Error(
      `recognizeOne: Invariant 2 tie-out failed — settled gross ${r.amountAtomic} != pricing_models.fixed_amount_atomic ${pmRow.fixed_amount_atomic}`,
    );
  }

  // 6. revenue_event (earned).
  const insRevenue = await client.query<{ id: string }>(
    `insert into revenue_events
       (id, tenant_id, interaction_id, revenue_source, pricing_model_id, gross_amount_atomic, asset,
        network, revenue_status, earned_at)
     values ($1,$2,$3,'x402_purchase',$4,$5,$6,$7,'earned',$8)
     on conflict (tenant_id, interaction_id, revenue_source) do nothing
     returning id`,
    [randomUUID(), cfg.tenantId, interactionId, cfg.pricingModelId, r.amountAtomic.toString(), r.asset, r.network, r.occurredAt],
  );
  let revenueEventId = insRevenue.rows[0]?.id;
  if (!revenueEventId) {
    const sel = await client.query<{ id: string }>(
      `select id from revenue_events where tenant_id=$1 and interaction_id=$2 and revenue_source='x402_purchase'`,
      [cfg.tenantId, interactionId],
    );
    revenueEventId = sel.rows[0]?.id;
    if (!revenueEventId) throw new Error('recognizeOne: revenue_event conflict but no existing row found');
  }

  // 7. split rules → allocation.
  const rulesRes = await client.query<SplitRuleRow>(
    `select id, recipient_id, role, percentage_bps, fixed_amount_atomic
       from split_rules where split_group_id=$1 and tenant_id=$2 order by priority, role`,
    [cfg.splitGroupId, cfg.tenantId],
  );
  const allocation = allocateSplit(r.amountAtomic, rulesRes.rows);

  // 8. journal_transaction (recognition, principal_gross).
  const postingKey = `recognition:${revenueEventId}`;
  const insJournal = await client.query<{ id: string }>(
    `insert into journal_transactions
       (id, tenant_id, txn_type, posting_key, revenue_event_id, interaction_id, effective_at,
        revenue_treatment, split_group_id, split_group_version)
     values ($1,$2,'recognition',$3,$4,$5,$6,'principal_gross',$7,$8)
     on conflict (tenant_id, posting_key) do nothing
     returning id`,
    [randomUUID(), cfg.tenantId, postingKey, revenueEventId, interactionId, r.occurredAt, cfg.splitGroupId, cfg.splitGroupVersion],
  );
  const journalRow = insJournal.rows[0];
  if (!journalRow) {
    // UNREACHABLE on a consistent DB: posting_key derives from the just-minted revenueEventId, which
    // is keyed off this freshly-inserted interaction. Reaching here means the interaction-gate
    // invariant (deviation #2) was already violated (partial commit / concurrent anomaly). Fail
    // loudly rather than return a dishonest 'recognized' with no ledger legs.
    throw new Error(
      `recognizeOne: invariant violation — fresh interaction ${interactionId} but posting_key '${postingKey}' already exists`,
    );
  }
  const journalTxnId = journalRow.id;

  // 9. ledger_entries (R1' principal_gross), balance-asserted before insert.
  const ctx: PostingContext = {
    revenueEvent: { id: revenueEventId, tenantId: cfg.tenantId, grossAmountAtomic: r.amountAtomic, asset: r.asset },
    treatment: 'principal_gross',
    allocation,
  };
  const legs = resolveLegs(ctx);
  if (legs.length === 0) {
    throw new Error('recognizeOne: refusing to post an empty journal (no non-zero legs)');
  }
  assertBalanced(legs); // refuse to persist an unbalanced transaction (§18.16)
  for (const leg of legs) {
    const accountId = await resolveLedgerAccount(client, cfg.tenantId, leg.account, r.asset);
    await client.query(
      `insert into ledger_entries (id, tenant_id, entry_group_id, account_id, direction, amount_atomic, asset, memo)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), cfg.tenantId, journalTxnId, accountId, leg.direction, leg.amountAtomic.toString(), r.asset, leg.memo],
    );
  }

  // 10. collection_state (open_receivable; never advances in M2).
  await ensureCollectionState(client, revenueEventId);

  return { rawEventId: r.rawEventId, interactionId, outcome: 'recognized', revenueEventId, journalTxnId, legCount: legs.length };
}

async function ensureCollectionState(client: PoolClient, revenueEventId: string): Promise<void> {
  await client.query(
    `insert into revenue_collection_state (revenue_event_id, status) values ($1,'open_receivable')
     on conflict (revenue_event_id) do nothing`,
    [revenueEventId],
  );
}

/** Batch pass: select un-recognized receipt analogs by event_seq and recognizeOne each. */
export async function runRecognitionPass(
  db: Db,
  cfg: RecognitionConfig,
  opts?: { sinceEventSeq?: bigint },
): Promise<RecognitionPassSummary> {
  const params: Array<string> = [cfg.tenantId];
  let where = `where tenant_id=$1 and event_type=$2 and event_source='seller_sdk'`;
  params.push(RECEIPT_ANALOG_EVENT_TYPE);
  if (opts?.sinceEventSeq !== undefined) {
    where += ` and event_seq > $3`;
    params.push(opts.sinceEventSeq.toString());
  }
  const res = await db.query<RawEventRow>(
    `select id, tenant_id, event_type, event_source, occurred_at, payload_redacted, event_seq,
            idempotency_key, adapter_key_id, adapter_signature
       from raw_events ${where} order by event_seq`,
    params,
  );

  // M6b: if signatures are required but keys weren't supplied, resolve the tenant's active keys once
  // for this pass. NOTE: a per-pass snapshot — a key revoked mid-pass still verifies for the rest of
  // THIS pass (excluded on the next). Fine for short OSS passes; M7 continuous ingestion should
  // re-resolve periodically. Required-but-no-keys fails CLOSED (empty map → every event rejected).
  const effectiveCfg: RecognitionConfig =
    cfg.requireAdapterSignature && !cfg.adapterKeys
      ? { ...cfg, adapterKeys: await resolveAdapterKeys(db, cfg.tenantId) }
      : cfg;
  const summary: RecognitionPassSummary = { total: 0, recognized: 0, replayed: 0, f1Skipped: 0, rejectedUnsigned: 0, errors: [] };
  // maxEventSeq is a SAFE resume cursor: it advances only across the unbroken prefix of committed
  // rows (recognized / replayed / F1 are all durable outcomes). The FIRST error halts cursor
  // advancement, so a later pass with opts.sinceEventSeq re-attempts the failed row (and everything
  // after it — idempotent replays) instead of silently skipping a never-recognized event. This also
  // makes a transient DB outage safe: the cursor stops at the first failure rather than racing ahead.
  let cursorOpen = true;
  for (const row of res.rows) {
    summary.total++;
    try {
      const result = await recognizeOne(db, effectiveCfg, row);
      if (result.outcome === 'recognized') summary.recognized++;
      else if (result.outcome === 'replayed') summary.replayed++;
      // rejected_unsigned advances the resume cursor like a durable outcome. The OSS default re-scans
      // all rows each pass (no sinceEventSeq), so a later-registered key still picks it up; M7
      // persisted-cursor ingestion must decide whether to re-evaluate rejected events.
      else if (result.outcome === 'rejected_unsigned') summary.rejectedUnsigned++;
      else summary.f1Skipped++;
      if (cursorOpen) summary.maxEventSeq = row.event_seq;
    } catch (e) {
      summary.errors.push({ rawEventId: row.id, message: e instanceof Error ? e.message : String(e) });
      cursorOpen = false; // stop advancing the resume cursor past a failed row
    }
  }
  return summary;
}

/** Resolve the demo RecognitionConfig from the 0004 seed by natural key. */
export async function resolveDemoConfig(db: Db, tenantId: string = DEMO_TENANT_ID): Promise<RecognitionConfig> {
  const pm = await db.query<{ id: string }>(
    `select id from pricing_models where tenant_id=$1 and name=$2 and version=1 and pricing_type='exact'`,
    [tenantId, DEMO_PRICING_NAME],
  );
  const pmId = pm.rows[0]?.id;
  if (!pmId) throw new Error(`resolveDemoConfig: pricing_models '${DEMO_PRICING_NAME}' not found — run migration 0004`);

  const sg = await db.query<{ id: string; version: number }>(
    `select id, version from split_groups where tenant_id=$1 and name=$2 and version=1`,
    [tenantId, DEMO_SPLIT_GROUP_NAME],
  );
  const sgRow = sg.rows[0];
  if (!sgRow) throw new Error(`resolveDemoConfig: split_groups '${DEMO_SPLIT_GROUP_NAME}' not found — run migration 0004`);

  return { tenantId, pricingModelId: pmId, splitGroupId: sgRow.id, splitGroupVersion: sgRow.version };
}

/** Load the active adapter public keys for a tenant: keyId -> Ed25519 SPKI PEM (M6b / T6). */
export async function resolveAdapterKeys(db: Db, tenantId: string): Promise<Map<string, string>> {
  const res = await db.query<{ key_id: string; public_key: string }>(
    `select key_id, public_key from adapter_keys where tenant_id=$1 and status='active'`,
    [tenantId],
  );
  return new Map(res.rows.map((row) => [row.key_id, row.public_key]));
}
