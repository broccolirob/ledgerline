// @ledgerline/seller-client — Milestone 1.
// Framework-agnostic seller-side capture: request fingerprinting (§8), the Ledgerline
// receipt analog (Path C), the raw_events write path, and the demo split helper.
import { createHash, randomUUID, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** Minimal pg seam — satisfied by both `pg.Pool` and `pg.PoolClient`. */
export type Db = Pool | PoolClient;

// ---- canonicalization / hashing (M0 placeholder, NOT a standards JCS serializer) --------

/**
 * Deterministic JSON with recursively-sorted object keys. Unlike
 * `JSON.stringify(obj, Object.keys(obj).sort())` (whose array replacer is a top-level
 * allowlist that silently drops nested keys), this recurses and sorts at every depth.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function sha256hex(input: string): string {
  return '0x' + createHash('sha256').update(input).digest('hex');
}

/** sha256 over JSON with recursively-sorted keys (M0 placeholder serializer). */
export function canonicalHash(payload: Record<string, unknown>): Buffer {
  return createHash('sha256').update(stableStringify(payload)).digest();
}

// ---- request fingerprint (§8) ----------------------------------------------

export interface RequestFingerprintInput {
  tenantId: string;
  endpointId: string;
  method: string;
  resourcePath: string;
  scheme?: string;
  network?: string;
  asset?: string;
  amountAtomic?: string;
  payTo?: string;
  routeConfigVersion?: number;
}

/** Normalized, deterministic request-identity hash (hex). Drives replay/idempotency safety. */
export function computeRequestFingerprint(i: RequestFingerprintInput): string {
  const canonical = stableStringify({
    v: 1,
    tenantId: i.tenantId,
    endpointId: i.endpointId,
    method: i.method.toUpperCase(),
    resourcePath: i.resourcePath,
    scheme: i.scheme ?? '',
    network: i.network ?? '',
    asset: i.asset ?? '',
    amountAtomic: i.amountAtomic ?? '',
    payTo: (i.payTo ?? '').toLowerCase(),
    routeConfigVersion: i.routeConfigVersion ?? 0,
  });
  return sha256hex(canonical);
}

// ---- raw_event write path ---------------------------------------------------

export interface RawEventInput {
  id: string;
  tenantId: string;
  eventType: string;
  eventSource: 'seller_sdk' | 'gateway_snapshot' | 'arc_indexer' | 'admin';
  sourceVersion?: string;
  idempotencyKey: string;
  occurredAt: Date;
  payloadRedacted: Record<string, unknown>;
  schemaVersion: string;
  adapterKeyId?: string;
  adapterSignature?: string;
}

/**
 * Writes ONE raw_event row. Idempotent on (tenant_id, idempotency_key) via the table's unique
 * constraint + ON CONFLICT DO NOTHING. The payload is JSON-normalized once so the stored jsonb
 * and the canonical_hash are computed over the identical bytes (no `undefined`-key skew).
 */
export async function writeRawEvent(db: Db, ev: RawEventInput): Promise<void> {
  const clean = JSON.parse(JSON.stringify(ev.payloadRedacted)) as Record<string, unknown>;
  await db.query(
    `insert into raw_events
       (id, tenant_id, event_type, event_source, source_version, idempotency_key,
        occurred_at, canonical_hash, payload_redacted, schema_version,
        adapter_key_id, adapter_signature)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
     on conflict (tenant_id, idempotency_key) do nothing`,
    [
      ev.id,
      ev.tenantId,
      ev.eventType,
      ev.eventSource,
      ev.sourceVersion ?? null,
      ev.idempotencyKey,
      ev.occurredAt.toISOString(),
      canonicalHash(clean),
      JSON.stringify(clean),
      ev.schemaVersion,
      ev.adapterKeyId ?? null,
      ev.adapterSignature ?? null,
    ],
  );
}

// ---- adapter-event signing (M6b — closes T6) -------------------------------
// Ed25519 over a deterministic message binding the tenant, the event identity (idempotency key), and
// the full redacted payload (which itself carries schemaVersion + the request fingerprint). The signer
// (the adapter) holds the private key; the verifier (recognition) holds only the public key via the
// adapter_keys registry. SEPARATE from canonicalHash (raw-event integrity) and the M4
// @ledgerline/canonical LCJ+keccak committed-leaf format — three distinct roles, do not conflate.

export interface AdapterSigner {
  keyId: string;
  privateKeyPem: string;
}

/** The exact bytes signed/verified for an adapter event. payloadRedacted carries schemaVersion + the
 *  request fingerprint, so binding it covers schema + tamper; occurredAt is excluded to avoid Date
 *  round-trip precision skew (identity is already bound by tenantId + idempotencyKey). */
export function adapterSigningMessage(parts: {
  tenantId: string;
  idempotencyKey: string;
  payloadRedacted: Record<string, unknown>;
}): Buffer {
  // Normalize through JSON.parse(JSON.stringify(...)) so the signed bytes match the jsonb-stored form
  // (Postgres jsonb drops `undefined` keys exactly as JSON.stringify does). This makes sign (raw
  // payload) and verify (payload reloaded from jsonb) symmetric across the DB round-trip — the same
  // cleaning writeRawEvent applies before insert.
  const payload = JSON.parse(JSON.stringify(parts.payloadRedacted)) as Record<string, unknown>;
  return Buffer.from(
    stableStringify({
      v: 1,
      tenantId: parts.tenantId,
      idempotencyKey: parts.idempotencyKey,
      payloadRedacted: payload,
    }),
    'utf8',
  );
}

/** Generate an Ed25519 adapter keypair. keyId = first 32 hex chars (128 bits) of sha256(public-key
 *  PEM) — wide enough that accidental collisions are negligible. Authenticity rests on the signature,
 *  not the keyId; the keyId is only the registry lookup handle. */
export function generateAdapterKeyPair(): { keyId: string; publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const keyId = createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 32);
  return { keyId, publicKeyPem, privateKeyPem };
}

/** Sign a raw event: returns a copy with adapterKeyId + base64 adapterSignature set (Ed25519). */
export function signRawEvent(ev: RawEventInput, signer: AdapterSigner): RawEventInput {
  const msg = adapterSigningMessage({
    tenantId: ev.tenantId,
    idempotencyKey: ev.idempotencyKey,
    payloadRedacted: ev.payloadRedacted,
  });
  const signature = edSign(null, msg, signer.privateKeyPem); // Ed25519 takes algorithm = null
  return { ...ev, adapterKeyId: signer.keyId, adapterSignature: signature.toString('base64') };
}

/** Verify an adapter signature over the event. Returns false on any malformation (never throws). */
export function verifyRawEventSignature(
  parts: { tenantId: string; idempotencyKey: string; payloadRedacted: Record<string, unknown> },
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  try {
    return edVerify(null, adapterSigningMessage(parts), publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

// ---- Ledgerline receipt analog (Path C) ------------------------------------
// Circle's middleware surfaces no Payment-Identifier and no official signed offer/receipt
// (confirmed). The analog = request fingerprint + the confirmed req.payment context (incl. the
// opaque Gateway settlement reference) + a hash of the buyer's payment-authorization header +
// the delivery record. The payment-authorization hash is NOT a "signed receipt".

export interface LedgerlineCaptureInput {
  endpointId: string;
  schemaVersion: string;
  method: string;
  resourcePath: string;
  routeConfigVersion?: number;
  payment: {
    verified: boolean;
    payer: string; // raw buyer address — hashed before storage, never stored raw
    amountAtomic: string;
    network: string;
    asset?: string;
    payTo?: string; // seller's own receive address
    settlementReference?: string; // req.payment.transaction (opaque Gateway transfer id)
    paymentSignatureHeader?: string; // raw base64 'payment-signature' header — hashed, never stored raw
  };
  delivery: {
    status: 'delivered' | 'failed' | 'canceled';
    httpStatus: number;
    latencyMs?: number;
    responseBodyHash?: string;
  };
  // M6c (Path B): the OFFICIAL x402 EIP-712 artifacts issued for this paid call, if any. Stored
  // verbatim under payloadRedacted.x402Official so the verifier can re-verify their EIP-712 signatures
  // offline. Either may be absent (backward-compatible: analog-only captures omit them). NOTE: the
  // receipt's `payer` is, by x402 spec, the buyer's address — so unlike the analog (which hashes the
  // payer) these artifacts carry it in the clear; at-rest encryption is deferred to M7 / §9.
  signedOffer?: unknown;
  signedReceipt?: unknown;
  occurredAt: Date;
}

/** Build the raw_event row for one paid call. Hashes/redacts sensitive fields per §9. */
export function buildRawEventFromCapture(tenantId: string, c: LedgerlineCaptureInput): RawEventInput {
  const fingerprint = computeRequestFingerprint({
    tenantId,
    endpointId: c.endpointId,
    method: c.method,
    resourcePath: c.resourcePath,
    scheme: 'exact',
    network: c.payment.network,
    asset: c.payment.asset,
    amountAtomic: c.payment.amountAtomic,
    payTo: c.payment.payTo,
    routeConfigVersion: c.routeConfigVersion,
  });
  const paymentSignatureHash = c.payment.paymentSignatureHeader
    ? sha256hex(c.payment.paymentSignatureHeader)
    : undefined;

  // Idempotency anchor: prefer the unique Gateway settlement reference; else the unique
  // payment-authorization hash; else the fingerprint (least robust — distinct purchases of the
  // same request would collide, so only used if neither unique signal is present).
  const anchor = c.payment.settlementReference ?? paymentSignatureHash ?? fingerprint;

  // M6c: carry the official artifacts verbatim when present. undefined here is dropped by the
  // JSON normalization in writeRawEvent, so analog-only captures store no x402Official key (and the
  // canonical_hash / adapter signature stay identical to pre-M6c for unchanged inputs).
  const officialArtifacts =
    c.signedOffer != null || c.signedReceipt != null
      ? { signedOffer: c.signedOffer ?? null, signedReceipt: c.signedReceipt ?? null }
      : undefined;

  const payloadRedacted: Record<string, unknown> = {
    schemaVersion: c.schemaVersion,
    kind: 'ledgerline_receipt_analog', // NOT a signed receipt (no-overclaim)
    endpointId: c.endpointId,
    method: c.method.toUpperCase(),
    requestFingerprint: fingerprint,
    resourceHash: sha256hex(c.resourcePath),
    payment: {
      verified: c.payment.verified,
      network: c.payment.network,
      asset: c.payment.asset ?? 'USDC',
      amountAtomic: c.payment.amountAtomic,
      payTo: c.payment.payTo, // seller's own receive address
      payerHash: sha256hex(c.payment.payer.toLowerCase()), // buyer hashed (§9 / §7.5)
      settlementReference: c.payment.settlementReference,
      paymentSignatureHash, // hash of the buyer's signed authorization (NOT a signed receipt)
    },
    delivery: {
      status: c.delivery.status,
      httpStatus: c.delivery.httpStatus,
      latencyMs: c.delivery.latencyMs,
      responseBodyHash: c.delivery.responseBodyHash,
    },
    x402Official: officialArtifacts, // dropped when undefined (analog-only) — see note above
  };

  return {
    id: randomUUID(),
    tenantId,
    eventType: 'ledgerline.receipt_analog.v1',
    eventSource: 'seller_sdk',
    idempotencyKey: `ledgerline-receipt-analog:v1:${anchor}`,
    occurredAt: c.occurredAt,
    payloadRedacted,
    schemaVersion: c.schemaVersion,
  };
}

/** A sink that persists each captured analog to Postgres via {@link writeRawEvent}. */
export function makePostgresSink(
  db: Db,
  opts: { tenantId: string; signer?: AdapterSigner },
): (c: LedgerlineCaptureInput) => Promise<void> {
  if (opts.signer) {
    // Fail fast on a malformed/unsupported signing key (e.g. a PEM pasted with escaped \n) at sink
    // construction. Otherwise signRawEvent would throw on every res.finish and the captured paid call
    // would be silently dropped (writeRawEvent never runs) — losing a delivered-and-charged event.
    try {
      edSign(null, Buffer.from('ledgerline-adapter-signer-check'), opts.signer.privateKeyPem);
    } catch (e) {
      throw new Error(
        `makePostgresSink: invalid adapter signing key (ADAPTER_SIGNING_KEY must be a valid Ed25519 PEM): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return async (c: LedgerlineCaptureInput): Promise<void> => {
    let ev = buildRawEventFromCapture(opts.tenantId, c);
    if (opts.signer) ev = signRawEvent(ev, opts.signer); // M6b: sign before persist when configured
    await writeRawEvent(db, ev);
  };
}

// ---- demo split helper ------------------------------------------------------

export interface Split {
  publisher: number;
  modelProvider: number;
  dataProvider: number;
  marketplaceReferrer: number;
}

/**
 * Trivial M0 demo split on an atomic USDC amount (6 decimals).
 * 3000 atomic ($0.003) -> 2100 / 600 / 210 / 90  (70% / 20% / 7% / 3%).
 * Integer math only; rounding dust goes to the publisher.
 */
export function allocateOneSplit(amountAtomic: number): Split {
  if (!Number.isInteger(amountAtomic) || amountAtomic < 0) {
    throw new Error('amountAtomic must be a non-negative integer (USDC atomic units)');
  }
  const modelProvider = Math.floor((amountAtomic * 20) / 100);
  const dataProvider = Math.floor((amountAtomic * 7) / 100);
  const marketplaceReferrer = Math.floor((amountAtomic * 3) / 100);
  const publisher = amountAtomic - modelProvider - dataProvider - marketplaceReferrer;
  return { publisher, modelProvider, dataProvider, marketplaceReferrer };
}
