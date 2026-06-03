// @ledgerline/anchor — Milestone 4.
// Batch builder (Invariant 11) + verifier (§17.6 14-step, Path-C re-scoped) + verifier-package
// generator. Reads M2 output (revenue_events + ledger_entries), commits Merkle roots via
// @ledgerline/canonical. The on-chain client (viem) lives in ./onchain.ts and is loaded only when
// a credentialed path runs (Track-A-gated) — keeping the offline build/verify path viem-free.

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Db } from '@ledgerline/seller-client';
import {
  type LcjObject,
  revenueEventLeaf,
  ledgerEntryLeaf,
  leafHashOfRecord,
  merkleRoot,
  merkleProof,
  verifyProof,
  schemaHash,
  metadataPolicyHash,
  tenantCommitment,
  batchId as deriveBatchId,
  toHex,
  bytesEqual,
  ZERO_32,
  SCHEMA_DESCRIPTOR,
  METADATA_POLICY_DESCRIPTOR,
  assertClosedLeafSchema,
} from '@ledgerline/canonical';
// M6c (Path B): re-verify the OFFICIAL x402 EIP-712 offer/receipt artifacts (verifier steps 1-3).
import { verifySignedOffer, verifySignedReceipt, receiptMatchesOffer } from '@ledgerline/x402-receipts';

export type { Db };

export const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const ARC_CHAIN_ID = 5042002n;

// ---- txn helper (mirrors recognizeOne: own the txn on a Pool; use an injected PoolClient as-is) ----

async function runInTxn<T>(db: Db, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if ('release' in db) return fn(db);
  const client = await (db as Pool).connect();
  let failed = false;
  try {
    await client.query('begin');
    const r = await fn(client);
    await client.query('commit');
    return r;
  } catch (e) {
    failed = true;
    try {
      await client.query('rollback');
    } catch {
      /* preserve original error */
    }
    throw e;
  } finally {
    client.release(failed || undefined);
  }
}

// ---- tenant commitment (salted, §16) ----

export interface ResolvedTenant {
  tenantId: string;
  tcBytes: Uint8Array;
  tcHex: string;
}

export async function resolveTenantCommitment(db: Db, tenantId: string): Promise<ResolvedTenant> {
  const res = await db.query<{ tenant_commitment_salt: Buffer | null }>(
    `select tenant_commitment_salt from tenants where id = $1`,
    [tenantId],
  );
  const salt = res.rows[0]?.tenant_commitment_salt;
  if (!salt) throw new Error(`resolveTenantCommitment: tenant ${tenantId} has no tenant_commitment_salt (run migration 0005)`);
  const saltBytes = Uint8Array.from(salt);
  const tcBytes = tenantCommitment(saltBytes, tenantId);
  return { tenantId, tcBytes, tcHex: toHex(tcBytes) };
}

// ---- DB row shapes + row→leaf mapping (shared by builder AND verifier — must be identical) ----

interface RevenueEventRow {
  id: string;
  tenant_id: string;
  interaction_id: string;
  revenue_source: string;
  gross_amount_atomic: string;
  asset: string;
  network: string | null;
  revenue_status: string;
  earned_at: Date | null;
  pricing_model_id: string | null;
}

interface LedgerLegRow {
  ledger_entry_id: string;
  journal_id: string;
  txn_type: string;
  revenue_treatment: string;
  effective_at: Date;
  direction: string;
  amount_atomic: string;
  asset: string;
  account_type: string;
  owner_type: string;
  owner_id: string | null;
}

interface CommitmentBatchRow {
  id: string;
  merkle_root: Buffer;
  previous_merkle_root: Buffer;
  batch_number: string;
  batch_id: Buffer;
  event_count: number;
  arc_tx_hash: string | null;
  status: string;
}

interface BatchLeafRow {
  leaf_index: number;
  record_type: string;
  record_id: string;
  leaf_hash: Buffer;
}

function revenueEventLeafFromRow(tcHex: string, r: RevenueEventRow): LcjObject {
  if (!r.earned_at) throw new Error(`revenue_event ${r.id} has no earned_at (not an earned event)`);
  return revenueEventLeaf({
    id: r.id,
    tenantCommitmentHex: tcHex,
    interactionId: r.interaction_id,
    revenueSource: r.revenue_source,
    grossAmountAtomic: r.gross_amount_atomic,
    asset: r.asset,
    network: r.network ?? undefined,
    revenueStatus: r.revenue_status,
    earnedAt: r.earned_at,
  });
}

function ledgerEntryLeafFromRow(tcHex: string, r: LedgerLegRow): LcjObject {
  return ledgerEntryLeaf({
    id: r.ledger_entry_id,
    tenantCommitmentHex: tcHex,
    journalTransactionId: r.journal_id,
    txnType: r.txn_type,
    revenueTreatment: r.revenue_treatment,
    accountType: r.account_type,
    ownerType: r.owner_type,
    ownerId: r.owner_id ?? undefined,
    direction: r.direction,
    amountAtomic: r.amount_atomic,
    asset: r.asset,
    effectiveAt: r.effective_at,
  });
}

const LEDGER_LEG_SELECT = `
  select le.id as ledger_entry_id, jt.id as journal_id, jt.txn_type, jt.revenue_treatment,
         jt.effective_at, le.direction, le.amount_atomic, le.asset,
         la.account_type, la.owner_type, la.owner_id
    from ledger_entries le
    join journal_transactions jt on jt.id = le.entry_group_id
    join ledger_accounts la on la.id = le.account_id`;

// ============================================================================
// Batch builder (§17.3, §18.15 Invariant 11, D-0008 mixed batch)
// ============================================================================

export interface BuildBatchResult {
  built: boolean;
  reason?: string;
  batchNumber?: bigint;
  batchIdHex?: string;
  merkleRootHex?: string;
  previousMerkleRootHex?: string;
  eventCount?: number;
  revenueEventIds?: string[];
}

/**
 * Build ONE mixed commitment batch over all un-committed earned revenue_events for a tenant and the
 * full leg set of each one's recognition journal. Invariant 11: a journal's legs are atomic — every
 * leg is included, never split. Idempotent: re-running with nothing new is a no-op (the global
 * unique on batch_leaves(record) also backstops double-commit).
 */
export async function buildBatch(db: Db, tenantId: string = DEMO_TENANT_ID): Promise<BuildBatchResult> {
  const tc = await resolveTenantCommitment(db, tenantId);

  // Whole read-modify-write runs in ONE transaction behind a per-tenant advisory lock (mirrors
  // recognizeOne), so candidate selection, leg reads, batch_number, and the previous-root read are a
  // consistent snapshot and concurrent builds can't race to the same batch_number / divergent sets.
  return runInTxn(db, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [tenantId]);

    const reRes = await client.query<RevenueEventRow>(
      `select re.id, re.tenant_id, re.interaction_id, re.revenue_source, re.gross_amount_atomic,
              re.asset, re.network, re.revenue_status, re.earned_at, re.pricing_model_id
         from revenue_events re
        where re.tenant_id = $1 and re.revenue_status = 'earned'
          and not exists (
            select 1 from batch_leaves bl
             where bl.tenant_id = re.tenant_id and bl.record_type = 'revenue_event' and bl.record_id = re.id)
        order by re.id`,
      [tenantId],
    );
    if (reRes.rows.length === 0) return { built: false, reason: 'no un-committed earned revenue_events' };

    // revenue_event leaves (rank 0, ordered by id)
    const reLeaves = reRes.rows.map((r) => ({ recordId: r.id, record: revenueEventLeafFromRow(tc.tcHex, r) }));
    reLeaves.sort((a, b) => (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0));

    // ledger_entry leaves (rank 1, ordered by effective_at_ms, journal_id, id) — full leg set per journal
    const leLeaves: { recordId: string; record: LcjObject; effMs: number; journalId: string }[] = [];
    for (const re of reRes.rows) {
      const legs = await client.query<LedgerLegRow>(
        `${LEDGER_LEG_SELECT} where jt.tenant_id = $1 and jt.revenue_event_id = $2 and jt.txn_type = 'recognition' order by le.id`,
        [tenantId, re.id],
      );
      if (legs.rows.length === 0) throw new Error(`buildBatch: Invariant 11 — revenue_event ${re.id} has no recognition ledger legs`);
      // Pre-anchor integrity gate: the recognition journal's legs must balance per asset (ΣDr==ΣCr)
      // BEFORE we anchor them, so a partially-written/corrupted leg set is never committed as final.
      const byAsset = new Map<string, bigint>();
      for (const leg of legs.rows) {
        const signed = leg.direction === 'debit' ? BigInt(leg.amount_atomic) : -BigInt(leg.amount_atomic);
        byAsset.set(leg.asset, (byAsset.get(leg.asset) ?? 0n) + signed);
      }
      for (const [asset, net] of byAsset) {
        if (net !== 0n) throw new Error(`buildBatch: recognition journal for revenue_event ${re.id} is unbalanced for asset ${asset} (net ${net}) — refusing to anchor`);
      }
      for (const leg of legs.rows) {
        leLeaves.push({ recordId: leg.ledger_entry_id, record: ledgerEntryLeafFromRow(tc.tcHex, leg), effMs: leg.effective_at.getTime(), journalId: leg.journal_id });
      }
    }
    leLeaves.sort((a, b) => a.effMs - b.effMs || cmp(a.journalId, b.journalId) || cmp(a.recordId, b.recordId));

    const ordered: { recordType: 'revenue_event' | 'ledger_entry'; recordId: string; record: LcjObject }[] = [
      ...reLeaves.map((x) => ({ recordType: 'revenue_event' as const, recordId: x.recordId, record: x.record })),
      ...leLeaves.map((x) => ({ recordType: 'ledger_entry' as const, recordId: x.recordId, record: x.record })),
    ];
    const leafHashes = ordered.map((x) => leafHashOfRecord(x.record));
    const root = merkleRoot(leafHashes);

    const bnRes = await client.query<{ n: string }>(
      `select coalesce(max(batch_number), 0) + 1 as n from commitment_batches where tenant_id = $1`,
      [tenantId],
    );
    const batchNumber = BigInt(bnRes.rows[0]!.n);
    const prevRes = await client.query<{ merkle_root: Buffer }>(
      `select merkle_root from commitment_batches where tenant_id = $1 order by batch_number desc limit 1`,
      [tenantId],
    );
    const prevRoot = prevRes.rows[0] ? Uint8Array.from(prevRes.rows[0].merkle_root) : ZERO_32;
    const bid = deriveBatchId(tc.tcBytes, batchNumber, root);
    const sh = schemaHash(SCHEMA_DESCRIPTOR);
    const mph = metadataPolicyHash(METADATA_POLICY_DESCRIPTOR);
    const batchRowId = randomUUID();

    await client.query(
      `insert into commitment_batches
         (id, tenant_id, batch_number, batch_type, event_count, previous_merkle_root, merkle_root,
          schema_hash, metadata_policy_hash, batch_id, status, arc_chain_id)
       values ($1,$2,$3,'mixed',$4,$5,$6,$7,$8,$9,'built',$10)`,
      [
        batchRowId, tenantId, batchNumber.toString(), ordered.length,
        Buffer.from(prevRoot), Buffer.from(root), Buffer.from(sh), Buffer.from(mph), Buffer.from(bid),
        ARC_CHAIN_ID.toString(),
      ],
    );
    for (let i = 0; i < ordered.length; i++) {
      const leaf = ordered[i]!;
      await client.query(
        `insert into batch_leaves (id, tenant_id, commitment_batch_id, leaf_index, record_type, record_id, leaf_hash)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), tenantId, batchRowId, i, leaf.recordType, leaf.recordId, Buffer.from(leafHashes[i]!)],
      );
    }

    return {
      built: true,
      batchNumber,
      batchIdHex: toHex(bid),
      merkleRootHex: toHex(root),
      previousMerkleRootHex: toHex(prevRoot),
      eventCount: ordered.length,
      revenueEventIds: reRes.rows.map((r) => r.id),
    };
  });
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ============================================================================
// Verifier (§17.6 14-step checklist, Path-C re-scoped — D-0001 no-overclaim)
// ============================================================================

export type StepStatus = 'pass' | 'fail' | 'skip' | 'na';
export interface VerifyStep {
  n: number;
  name: string;
  status: StepStatus;
  detail: string;
}
export interface VerifyResult {
  revenueEventId: string;
  pass: boolean;
  steps: VerifyStep[];
}

export interface VerifyOptions {
  onchain?: boolean;
}

/** Recompute a leaf_hash from the SOURCE record (not the stored hash) — the basis of step 0. */
async function recomputeLeafHash(db: Db, tcHex: string, recordType: string, recordId: string): Promise<Uint8Array> {
  if (recordType === 'revenue_event') {
    const r = await db.query<RevenueEventRow>(
      `select id, tenant_id, interaction_id, revenue_source, gross_amount_atomic, asset, network,
              revenue_status, earned_at, pricing_model_id from revenue_events where id = $1`,
      [recordId],
    );
    const row = r.rows[0];
    if (!row) throw new Error(`recomputeLeafHash: revenue_event ${recordId} not found`);
    const leaf = revenueEventLeafFromRow(tcHex, row);
    assertClosedLeafSchema(leaf);
    return leafHashOfRecord(leaf);
  }
  if (recordType === 'ledger_entry') {
    const r = await db.query<LedgerLegRow>(`${LEDGER_LEG_SELECT} where le.id = $1`, [recordId]);
    const row = r.rows[0];
    if (!row) throw new Error(`recomputeLeafHash: ledger_entry ${recordId} not found`);
    const leaf = ledgerEntryLeafFromRow(tcHex, row);
    assertClosedLeafSchema(leaf);
    return leafHashOfRecord(leaf);
  }
  throw new Error(`recomputeLeafHash: unknown record_type ${recordType}`);
}

export async function verify(db: Db, revenueEventId: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const steps: VerifyStep[] = [];
  const add = (n: number, name: string, status: StepStatus, detail: string): void => {
    steps.push({ n, name, status, detail });
  };
  const result = (): VerifyResult => ({ revenueEventId, pass: steps.every((s) => s.status !== 'fail'), steps });

  const reRes = await db.query<RevenueEventRow>(
    `select id, tenant_id, interaction_id, revenue_source, gross_amount_atomic, asset, network,
            revenue_status, earned_at, pricing_model_id from revenue_events where id = $1`,
    [revenueEventId],
  );
  const re = reRes.rows[0];
  if (!re) throw new Error(`verify: revenue_event ${revenueEventId} not found`);
  const tc = await resolveTenantCommitment(db, re.tenant_id);

  // locate the batch this revenue_event was committed in
  const blRes = await db.query<{ commitment_batch_id: string; leaf_index: number }>(
    `select commitment_batch_id, leaf_index from batch_leaves
      where tenant_id = $1 and record_type = 'revenue_event' and record_id = $2`,
    [re.tenant_id, revenueEventId],
  );
  const blRow = blRes.rows[0];

  // ---- step 0: canonical reproduction (re-derive ALL batch leaves from source) ----
  let batch: CommitmentBatchRow | undefined;
  const orderedLeafHashes: Uint8Array[] = [];
  let targetIndex = -1;
  if (!blRow) {
    add(0, 'canonical reproduction', 'fail', 'revenue_event is not committed to any batch');
  } else {
    const cbRes = await db.query<CommitmentBatchRow>(
      `select id, merkle_root, previous_merkle_root, batch_number, batch_id, event_count, arc_tx_hash, status
         from commitment_batches where id = $1`,
      [blRow.commitment_batch_id],
    );
    batch = cbRes.rows[0];
    const leavesRes = await db.query<BatchLeafRow>(
      `select leaf_index, record_type, record_id, leaf_hash from batch_leaves
        where commitment_batch_id = $1 order by leaf_index`,
      [blRow.commitment_batch_id],
    );
    // Build leaf hashes DENSELY in leaf_index order; detect a missing/reordered/short leaf set so a
    // tampered batch fails cleanly (never feed a sparse array — with a hole — to merkleRoot).
    const rows = leavesRes.rows;
    let allMatch = true;
    let contiguous = true;
    for (let k = 0; k < rows.length; k++) {
      const lf = rows[k]!;
      if (lf.leaf_index !== k) contiguous = false;
      const h = await recomputeLeafHash(db, tc.tcHex, lf.record_type, lf.record_id);
      orderedLeafHashes.push(h);
      if (!bytesEqual(h, Uint8Array.from(lf.leaf_hash))) allMatch = false;
      if (lf.record_type === 'revenue_event' && lf.record_id === revenueEventId) targetIndex = k;
    }
    const countOk = !!batch && rows.length === batch.event_count;
    const recomputedRoot = orderedLeafHashes.length > 0 ? merkleRoot(orderedLeafHashes) : ZERO_32;
    const rootMatches = !!batch && contiguous && countOk && bytesEqual(recomputedRoot, Uint8Array.from(batch.merkle_root));
    // Bind the stored batch_id to its canonical derivation (tenant_commitment, batch_number, root) —
    // the same identity the on-chain contract is keyed by. Catches a tampered batch_id/batch_number.
    const batchIdMatches =
      !!batch && bytesEqual(deriveBatchId(tc.tcBytes, BigInt(batch.batch_number), recomputedRoot), Uint8Array.from(batch.batch_id));
    add(
      0,
      'canonical reproduction',
      allMatch && rootMatches && batchIdMatches ? 'pass' : 'fail',
      allMatch && rootMatches && batchIdMatches
        ? `re-derived ${rows.length} leaves; recomputed root + batch_id match committed values`
        : `leaf-hash match=${allMatch}, contiguous=${contiguous}, count ${rows.length}/${batch?.event_count ?? '?'}, root match=${rootMatches}, batch_id match=${batchIdMatches}`,
    );
  }

  // ---- steps 1-3: prefer the OFFICIAL x402 Signed Offer/Receipt (Path B, M6c); else the Path-C
  // analog (honest, re-scoped). An interaction MAY hold several artifact rows (one per artifact_type),
  // so load all three deterministically rather than rows[0]. artifact_json (migration 0007) carries
  // the full signed artifact for offline EIP-712 re-verification.
  const artsRes = await db.query<{ artifact_type: string; payment_identifier: string | null; artifact_json: unknown }>(
    `select artifact_type, payment_identifier, artifact_json from x402_payment_artifacts
      where tenant_id = $1 and interaction_id = $2
        and artifact_type in ('payment_signature', 'signed_offer', 'signed_receipt')
      order by created_at`,
    [re.tenant_id, re.interaction_id],
  );
  const analogArt = artsRes.rows.find((a) => a.artifact_type === 'payment_signature');
  const offerArt = artsRes.rows.find((a) => a.artifact_type === 'signed_offer');
  const receiptArt = artsRes.rows.find((a) => a.artifact_type === 'signed_receipt');
  // step-4 binding uses the payment_identifier (all artifact rows share r.idempotencyAnchor).
  const art = analogArt ?? receiptArt ?? offerArt;
  const ixRes = await db.query<{ id: string; request_fingerprint: Buffer | null; payment_identifier: string | null; status: string }>(
    `select id, request_fingerprint, payment_identifier, status from interactions where id = $1`,
    [re.interaction_id],
  );
  const ix = ixRes.rows[0];

  // EIP-712 verification of the official artifacts (null when absent or invalid).
  const vReceipt = receiptArt ? await verifySignedReceipt(receiptArt.artifact_json) : null;
  const vOffer = offerArt ? await verifySignedOffer(offerArt.artifact_json) : null;

  // step 1: a VALID official receipt is present (preferred); else the Path-C analog (honest fallback).
  // The "official" label REQUIRES the EIP-712 signature to verify (vReceipt) — a present-but-invalid
  // signed_receipt row must NOT earn the official label (step 2 also fails it). Review hardening (M6c).
  if (receiptArt && vReceipt) {
    add(1, 'signed receipt present', 'pass', 'official x402 EIP-712 Signed Receipt captured (artifact_type=signed_receipt)');
  } else if (analogArt) {
    add(1, 'receipt analog present (Path C)', 'pass', "Ledgerline receipt analog (artifact_type='payment_signature'); NOT an official x402 Signed Receipt");
  } else if (receiptArt) {
    add(1, 'signed receipt present', 'fail', 'signed_receipt present but its EIP-712 signature does not verify (no valid analog either)');
  } else {
    add(1, 'receipt present', 'fail', 'no signed_receipt or payment_signature artifact for this interaction');
  }

  // step 2: the official receipt's EIP-712 signature verifies (recovers a signer). HONEST SCOPE: this
  // proves the artifact is a well-formed signed receipt and (with step 3) that offer+receipt share one
  // issuer — it does NOT yet pin that issuer to a REGISTERED seller key (the operated receipt-key
  // registry is M7), so step 2 alone is not proof of seller identity. `na` on the pure analog path.
  if (receiptArt) {
    add(2, 'signed receipt valid', vReceipt ? 'pass' : 'fail', vReceipt ? `official x402 receipt EIP-712 signature verifies; recovered signer ${vReceipt.signer}; receipt_signer_registry_binding=deferred/not-checked (M7 — recovered signer is NOT pinned to a registered seller key)` : 'signed_receipt EIP-712 verification failed (malformed/garbage signature)');
  } else {
    add(2, 'signed receipt valid', 'na', 'no official x402 Signed Receipt (Path-C analog path; steps 1-3 re-scoped)');
  }

  // step 3: the official receipt binds to its official offer (same resource+network), both recover to the
  // SAME issuer (tamper-evident across the pair), and the offer amount ties to the committed revenue
  // gross. An official receipt WITHOUT its offer cannot be cross-checked, so it FAILS (not `na`) — that
  // closes the hole where a lone tampered/forged receipt would pass via `na`. `na` is reserved for the
  // pure analog path (no official receipt at all), which stays backward-compatible.
  if (receiptArt && offerArt) {
    const bind = receiptMatchesOffer(receiptArt.artifact_json, offerArt.artifact_json);
    const sameIssuer = !!vReceipt && !!vOffer && vReceipt.signer.toLowerCase() === vOffer.signer.toLowerCase();
    const amountOk = !!vOffer && /^[0-9]+$/.test(String(vOffer.payload.amount)) && BigInt(vOffer.payload.amount) === BigInt(re.gross_amount_atomic);
    const ok = bind && sameIssuer && amountOk;
    add(3, 'receipt matches offer', ok ? 'pass' : 'fail', `receipt↔offer bind=${bind}; same-issuer=${sameIssuer}; offer.amount ${vOffer?.payload.amount ?? '?'} == revenue gross ${re.gross_amount_atomic}=${amountOk}`);
  } else if (receiptArt) {
    add(3, 'receipt matches offer', 'fail', 'official signed_receipt present but no signed_offer to cross-check (cannot bind the receipt to offer terms / a single issuer)');
  } else if (offerArt) {
    add(3, 'receipt matches offer', 'na', 'official signed_offer present but no signed_receipt to cross-check (offer not bound; Path-C analog path)');
  } else {
    add(3, 'receipt matches offer', 'na', 'no official x402 Signed Offer or Receipt (Path-C analog path)');
  }

  // ---- step 4: payment-identifier ↔ request fingerprint ----
  const bindingOk = !!ix && !!ix.request_fingerprint && !!ix.payment_identifier && !!art && art.payment_identifier === ix.payment_identifier;
  add(4, 'payment-identifier ↔ request fingerprint', bindingOk ? 'pass' : 'fail', bindingOk ? 'interaction binds a request fingerprint + payment identifier; artifact shares the identifier' : 'missing/mismatched fingerprint or payment identifier');

  // ---- step 5: delivery ↔ interaction ----
  const sdRes = await db.query<{ delivery_status: string; http_status: number | null }>(
    `select delivery_status, http_status from service_deliveries where interaction_id = $1 order by created_at limit 1`,
    [re.interaction_id],
  );
  const sd = sdRes.rows[0];
  add(5, 'delivery ↔ interaction', sd && sd.delivery_status === 'delivered' ? 'pass' : 'fail', sd ? `delivery_status=${sd.delivery_status}, http_status=${sd.http_status}` : 'no service_delivery for interaction');

  // ---- step 6: revenue ↔ paid delivery ----
  add(6, 'revenue ↔ paid delivery', re.revenue_status === 'earned' && ix?.status === 'delivered' ? 'pass' : 'fail', `revenue_status=${re.revenue_status}, interaction.status=${ix?.status}`);

  // ---- step 7A: exact-pricing tie-out ----
  if (!re.pricing_model_id) {
    add(7, 'exact-pricing tie-out', 'fail', 'revenue_event has no pricing_model_id');
  } else {
    const pmRes = await db.query<{ fixed_amount_atomic: string | null; pricing_type: string }>(
      `select fixed_amount_atomic, pricing_type from pricing_models where id = $1`,
      [re.pricing_model_id],
    );
    const pm = pmRes.rows[0];
    const ok = !!pm && pm.pricing_type === 'exact' && pm.fixed_amount_atomic === re.gross_amount_atomic;
    add(7, 'exact-pricing tie-out', ok ? 'pass' : 'fail', ok ? `gross ${re.gross_amount_atomic} == pricing_models.fixed_amount_atomic` : `gross ${re.gross_amount_atomic} vs fixed ${pm?.fixed_amount_atomic} (type ${pm?.pricing_type})`);
  }

  // ---- load the recognition journal legs (steps 8/9/10) ----
  const legsRes = await db.query<{ journal_id: string; ledger_entry_id: string; direction: string; amount_atomic: string; asset: string; account_type: string; split_group_id: string | null; split_group_version: number | null; txn_type: string }>(
    `select jt.id as journal_id, le.id as ledger_entry_id, le.direction, le.amount_atomic, le.asset,
            la.account_type, jt.split_group_id, jt.split_group_version, jt.txn_type
       from journal_transactions jt
       join ledger_entries le on le.entry_group_id = jt.id
       join ledger_accounts la on la.id = le.account_id
      where jt.tenant_id = $1 and jt.revenue_event_id = $2 and jt.txn_type = 'recognition'`,
    [re.tenant_id, revenueEventId],
  );
  const legs = legsRes.rows;

  // ---- step 8B: principal_gross tie-out ----
  const sumBy = (pred: (r: (typeof legs)[number]) => boolean): bigint => legs.filter(pred).reduce((s, r) => s + BigInt(r.amount_atomic), 0n);
  const revenueCredit = sumBy((r) => r.account_type === 'revenue' && r.direction === 'credit');
  const payableCredits = sumBy((r) => r.account_type === 'payable' && r.direction === 'credit');
  const expenseDebits = sumBy((r) => (r.account_type === 'expense_cogs' || r.account_type === 'expense_referral') && r.direction === 'debit');
  const gross = BigInt(re.gross_amount_atomic);
  const tieOk = legs.length > 0 && revenueCredit === gross && payableCredits === expenseDebits;
  add(8, 'principal_gross tie-out', tieOk ? 'pass' : 'fail', `revenue credit=${revenueCredit} (gross ${gross}); payable credits=${payableCredits} vs expense debits=${expenseDebits}`);

  // ---- step 9: journal balances per asset + all legs in the committed batch (Invariant 11) ----
  const debits = sumBy((r) => r.direction === 'debit');
  const credits = sumBy((r) => r.direction === 'credit');
  let allLegsInBatch = true;
  if (blRow) {
    for (const leg of legs) {
      const inBatch = await db.query<{ n: string }>(
        `select count(*) as n from batch_leaves where commitment_batch_id = $1 and record_type = 'ledger_entry' and record_id = $2`,
        [blRow.commitment_batch_id, leg.ledger_entry_id],
      );
      if (inBatch.rows[0]!.n === '0') allLegsInBatch = false;
    }
  } else {
    allLegsInBatch = false;
  }
  add(9, 'journal balances + legs co-located (Inv 11)', debits === credits && allLegsInBatch ? 'pass' : 'fail', `ΣDr=${debits} ΣCr=${credits}; all ${legs.length} legs in batch=${allLegsInBatch}`);

  // ---- step 10: split allocation matches committed split group version ----
  const sg = legs[0];
  if (sg && sg.split_group_id && sg.split_group_version != null) {
    const sgRes = await db.query<{ n: string }>(
      `select count(*) as n from split_groups where id = $1 and version = $2`,
      [sg.split_group_id, sg.split_group_version],
    );
    add(10, 'split group version', sgRes.rows[0]!.n === '1' ? 'pass' : 'fail', `split_group ${sg.split_group_id} v${sg.split_group_version}`);
  } else {
    add(10, 'split group version', 'fail', 'recognition journal missing split_group_id/version');
  }

  // ---- step 11: billing-fee separation (vacuous in the demo — fee omitted) ----
  const bfRes = await db.query<{ n: string }>(
    `select count(*) as n from journal_transactions where tenant_id = $1 and revenue_event_id = $2 and txn_type = 'billing_fee'`,
    [re.tenant_id, revenueEventId],
  );
  add(11, 'billing-fee separation (Inv 4)', bfRes.rows[0]!.n === '0' ? 'pass' : 'na', bfRes.rows[0]!.n === '0' ? 'no billing_fee transaction (fee omitted in demo — vacuously satisfied)' : 'billing_fee present (verify it is not a split recipient)');

  // ---- step 12: previous-root chain continuity ----
  if (batch) {
    const prevRoot = Uint8Array.from(batch.previous_merkle_root);
    const priorRes = await db.query<{ merkle_root: Buffer }>(
      `select merkle_root from commitment_batches where tenant_id = $1 and batch_number = $2`,
      [re.tenant_id, (BigInt(batch.batch_number) - 1n).toString()],
    );
    const prior = priorRes.rows[0];
    const isGenesis = BigInt(batch.batch_number) === 1n;
    if (!prior && !isGenesis) {
      // A non-genesis batch (number > 1) whose predecessor row is missing must NOT be treated as
      // genesis: that would let a forged/standalone batch with previous_merkle_root = ZERO pass the
      // chain check. Require the predecessor to exist for every batch after the first.
      add(12, 'previous-root chain continuity', 'fail', `batch_number ${batch.batch_number} > 1 but predecessor batch is missing — chain broken`);
    } else {
      const expected = prior ? Uint8Array.from(prior.merkle_root) : ZERO_32;
      add(12, 'previous-root chain continuity', bytesEqual(prevRoot, expected) ? 'pass' : 'fail', prior ? "previous_merkle_root == prior batch's merkle_root" : 'genesis batch (number 1): previous_merkle_root == all-zero hash');
    }
  } else {
    add(12, 'previous-root chain continuity', 'fail', 'no committed batch');
  }

  // ---- step 13: leaf inclusion (offline proof; --onchain compares to the live root) ----
  if (batch && targetIndex >= 0 && orderedLeafHashes.length > 0) {
    const root = Uint8Array.from(batch.merkle_root);
    const proof = merkleProof(orderedLeafHashes, targetIndex);
    const included = verifyProof(orderedLeafHashes[targetIndex]!, proof, root);
    if (!opts.onchain) {
      add(13, 'leaf inclusion in committed root', included ? 'pass' : 'fail', included ? `Merkle inclusion proof verifies (offline; index ${targetIndex})` : 'inclusion proof failed');
    } else {
      // Read THIS batch's root by batch_id (not the tenant's moving chain tip), so verifying a
      // historical/non-latest batch proves inclusion in the specific committed batch instead of
      // false-rejecting once a newer batch lands.
      const onchain = await import('./onchain.js');
      const liveRootHex = await onchain.readOnchainBatchRoot(toHex(Uint8Array.from(batch.batch_id)));
      const onchainMatch = liveRootHex != null && liveRootHex.toLowerCase() === toHex(root).toLowerCase();
      add(13, 'leaf inclusion in on-chain batch root', included && onchainMatch ? 'pass' : 'fail', `offline proof=${included}; on-chain batch root match=${onchainMatch} (live=${liveRootHex ?? 'n/a — batch not on-chain'})`);
    }
  } else {
    add(13, 'leaf inclusion in committed root', 'fail', 'no committed leaf to prove');
  }

  // ---- step 14: Arc tx finality (only with --onchain) ----
  if (!opts.onchain) {
    add(14, 'Arc transaction final', 'skip', 'not checked (offline) — run with --onchain after submit');
  } else if (batch && batch.arc_tx_hash) {
    const onchain = await import('./onchain.js');
    const final = await onchain.isTxFinal(batch.arc_tx_hash);
    add(14, 'Arc transaction final', final ? 'pass' : 'fail', `arc_tx_hash=${batch.arc_tx_hash} final=${final}`);
  } else {
    add(14, 'Arc transaction final', 'fail', 'batch not submitted on-chain (no arc_tx_hash)');
  }

  return result();
}

// ============================================================================
// Verifier package generator (§12) — self-contained per-revenue_event bundle
// ============================================================================

export interface VerifierPackage {
  revenueEventId: string;
  generatedNote: string;
  records: Record<string, unknown>;
  merkleProof: { leafIndex: number; siblings: { hash: string; side: string }[] };
  batch: Record<string, unknown>;
  verification: VerifyResult;
}

/** Build the disclosed verifier bundle for a revenue_event (in-memory; the CLI writes it to disk). */
export async function generateVerifierPackage(db: Db, revenueEventId: string): Promise<VerifierPackage> {
  const verification = await verify(db, revenueEventId);
  const re = (await db.query(`select * from revenue_events where id = $1`, [revenueEventId])).rows[0] as Record<string, unknown>;
  const tenantId = re.tenant_id as string;
  const tc = await resolveTenantCommitment(db, tenantId);

  const blRow = (await db.query<{ commitment_batch_id: string; leaf_index: number }>(
    `select commitment_batch_id, leaf_index from batch_leaves where tenant_id = $1 and record_type = 'revenue_event' and record_id = $2`,
    [tenantId, revenueEventId],
  )).rows[0];
  if (!blRow) throw new Error('generateVerifierPackage: revenue_event not committed');

  const cb = (await db.query(`select * from commitment_batches where id = $1`, [blRow.commitment_batch_id])).rows[0] as Record<string, unknown>;
  const leavesRes = await db.query<{ leaf_index: number; record_type: string; record_id: string; leaf_hash: Buffer }>(
    `select leaf_index, record_type, record_id, leaf_hash from batch_leaves where commitment_batch_id = $1 order by leaf_index`,
    [blRow.commitment_batch_id],
  );
  // Build densely in row order (rows are `order by leaf_index`) + assert contiguity, so a missing or
  // non-contiguous batch_leaves row fails with a clear error rather than an opaque sparse-array crash
  // inside merkleProof/merkleRoot (mirrors verify() step 0's defensive build).
  const orderedLeafHashes: Uint8Array[] = [];
  for (let k = 0; k < leavesRes.rows.length; k++) {
    const lf = leavesRes.rows[k]!;
    if (lf.leaf_index !== k) {
      throw new Error(`generateVerifierPackage: batch_leaves not contiguous (expected index ${k}, got ${lf.leaf_index})`);
    }
    orderedLeafHashes.push(await recomputeLeafHash(db, tc.tcHex, lf.record_type, lf.record_id));
  }
  const proof = merkleProof(orderedLeafHashes, blRow.leaf_index);

  const ledgerEntries = (await db.query(
    `select le.* from ledger_entries le join journal_transactions jt on jt.id = le.entry_group_id
      where jt.revenue_event_id = $1 and jt.txn_type = 'recognition' order by le.id`,
    [revenueEventId],
  )).rows;
  const interaction = (await db.query(`select id, status, payment_identifier from interactions where id = $1`, [re.interaction_id])).rows[0];
  const delivery = (await db.query(`select delivery_status, http_status from service_deliveries where interaction_id = $1`, [re.interaction_id])).rows[0];
  // M6c: disclose ALL artifact rows incl. artifact_json (so a third party can re-verify the official
  // EIP-712 offer/receipt offline).
  const artifacts = (await db.query(
    `select artifact_type, amount_atomic, settlement_reference, artifact_json
       from x402_payment_artifacts
      where interaction_id = $1 and artifact_type in ('payment_signature', 'signed_offer', 'signed_receipt')
      order by artifact_type`,
    [re.interaction_id],
  )).rows as Array<Record<string, unknown>>;
  // The official-path note must be gated on VALIDITY, not row presence (mirrors verify() step 1): only
  // claim "official ... re-verifiable" when the verifier's official steps 2 (receipt EIP-712 valid) AND
  // 3 (receipt↔offer bind + same issuer + amount tie) both pass. A present-but-invalid receipt row keeps
  // the honest Path-C note.
  const stepStatus = (n: number): StepStatus | undefined => verification.steps.find((s) => s.n === n)?.status;
  const officialVerified = stepStatus(2) === 'pass' && stepStatus(3) === 'pass';

  const toHexBytea = (v: unknown): unknown => (Buffer.isBuffer(v) ? '0x' + v.toString('hex') : v);
  const redact = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toHexBytea(v)]));

  return {
    revenueEventId,
    generatedNote: officialVerified
      ? 'Official x402 EIP-712 Signed Offer/Receipt captured + re-verifiable here (Path B); the revenue_event it produced is tamper-evident via the Arc-committed Merkle root.'
      : 'Ledgerline receipt analog (Path C) — NOT an official x402 Signed Receipt. Tamper-evident via the Arc-committed Merkle root.',
    records: {
      revenue_event: redact(re),
      ledger_entries: ledgerEntries.map((r) => redact(r as Record<string, unknown>)),
      interaction: interaction ? redact(interaction as Record<string, unknown>) : null,
      service_delivery: delivery ?? null,
      x402_payment_artifacts: artifacts.map((a) => redact(a)),
    },
    merkleProof: { leafIndex: blRow.leaf_index, siblings: proof.siblings.map((s) => ({ hash: toHex(s.hash), side: s.side })) },
    batch: {
      batch_number: cb.batch_number,
      batch_id: toHexBytea(cb.batch_id),
      merkle_root: toHexBytea(cb.merkle_root),
      previous_merkle_root: toHexBytea(cb.previous_merkle_root),
      schema_hash: toHexBytea(cb.schema_hash),
      metadata_policy_hash: toHexBytea(cb.metadata_policy_hash),
      status: cb.status,
      arc_tx_hash: cb.arc_tx_hash,
      arc_chain_id: cb.arc_chain_id,
      arc_contract_address: cb.arc_contract_address,
    },
    verification,
  };
}

// ============================================================================
// Submit orchestration (Track-A-gated; dynamic-imports the viem onchain client)
// ============================================================================

export interface SubmitResult {
  submitted: boolean;
  reason?: string;
  txHash?: string;
  batchNumber?: bigint;
}

/**
 * Submit the earliest still-'built' batch for a tenant on-chain (batches must commit in batch_number
 * order — the contract enforces the previous-root chain). Returns {submitted:false} with a clear
 * "blocked on Track A" reason when credentials are absent, mirroring demo-buyer. No code change is
 * needed when creds land.
 */
export async function submitNextBatch(db: Db, tenantId: string = DEMO_TENANT_ID): Promise<SubmitResult> {
  const onchain = await import('./onchain.js');
  if (!onchain.getEnv()) {
    return { submitted: false, reason: 'blocked on Track A (set ARC_RPC_URL + ANCHOR_COMMITTER_KEY + ANCHOR_CONTRACT_ADDRESS, deploy RevenueBatchAnchor first)' };
  }
  const tc = await resolveTenantCommitment(db, tenantId);
  const cbRes = await db.query<{
    id: string; batch_number: string; event_count: number; batch_id: Buffer; previous_merkle_root: Buffer;
    merkle_root: Buffer; schema_hash: Buffer; metadata_policy_hash: Buffer;
  }>(
    `select id, batch_number, event_count, batch_id, previous_merkle_root, merkle_root, schema_hash, metadata_policy_hash
       from commitment_batches where tenant_id = $1 and status = 'built' order by batch_number asc limit 1`,
    [tenantId],
  );
  const cb = cbRes.rows[0];
  if (!cb) return { submitted: false, reason: 'no built batch awaiting submission' };

  const hx = (b: Buffer): string => '0x' + b.toString('hex');
  const { txHash, contract, chainId } = await onchain.commitBatchOnchain({
    tenantCommitment: tc.tcHex,
    batchId: hx(cb.batch_id),
    batchNumber: BigInt(cb.batch_number),
    previousMerkleRoot: hx(cb.previous_merkle_root),
    merkleRoot: hx(cb.merkle_root),
    eventCount: BigInt(cb.event_count),
    schemaHash: hx(cb.schema_hash),
    metadataPolicyHash: hx(cb.metadata_policy_hash),
    dataAvailabilityUriHash: toHex(ZERO_32),
  });

  await db.query(
    `update commitment_batches set status = 'committed', arc_tx_hash = $1, arc_contract_address = $2, arc_chain_id = $3, committed_at = now() where id = $4`,
    [txHash, contract, chainId, cb.id],
  );
  return { submitted: true, txHash, batchNumber: BigInt(cb.batch_number) };
}

/** Pretty one-line-per-step console summary. */
export function formatVerifyResult(r: VerifyResult): string {
  const icon = (s: StepStatus): string => (s === 'pass' ? 'PASS' : s === 'fail' ? 'FAIL' : s === 'skip' ? 'SKIP' : ' NA ');
  const lines = r.steps.map((s) => `  [${icon(s.status)}] ${s.n}. ${s.name} — ${s.detail}`);
  // An OFFLINE pass proves DB-internal self-consistency (canonical reproduction + tie-outs + chain),
  // NOT that the root is on Arc — step 13's on-chain compare + step 14 finality only run with
  // --onchain. Qualify the headline so an offline PASS is never misread as anchor-verified.
  const anchorChecked = r.steps.some((s) => s.n === 14 && s.status !== 'skip');
  const verdict = !r.pass ? 'FAIL' : anchorChecked ? 'PASS (anchor-verified)' : 'PASS (offline — DB-consistent; run --onchain to confirm the Arc anchor)';
  return `verify revenue_event ${r.revenueEventId}: ${verdict}\n${lines.join('\n')}`;
}
