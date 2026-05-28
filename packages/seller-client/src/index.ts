// @ledgerline/seller-client — Milestone 0.
// Owns: (a) the raw_events write path, (b) the trivial one-split-allocation helper.
// Both are real (no credentials needed); the caller supplies the payment context, which
// only arrives once the live loop is wired.
import { createHash } from 'node:crypto';
import type { Client } from 'pg';

// ---- raw_event write path ---------------------------------------------------

export interface RawEventInput {
  id: string; // ULID or UUIDv7 supplied by caller
  tenantId: string; // uuid
  eventType: string;
  eventSource: 'seller_sdk' | 'gateway_snapshot' | 'arc_indexer' | 'admin';
  sourceVersion?: string;
  idempotencyKey: string; // Path C: request fingerprint + Payment-Identifier-if-available
  occurredAt: Date;
  payloadRedacted: Record<string, unknown>;
  schemaVersion: string;
  adapterKeyId?: string;
  adapterSignature?: string;
}

/**
 * Deterministic JSON serialization with recursively-sorted object keys.
 * M0 placeholder — NOT a standards JCS canonicalizer. Unlike
 * `JSON.stringify(obj, Object.keys(obj).sort())` (whose array replacer is a top-level
 * allowlist that silently drops nested keys), this recurses and sorts at every depth, so
 * the hash is stable across nested key reorderings.
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

/** sha256 over JSON with recursively-sorted keys (M0 placeholder serializer). */
export function canonicalHash(payload: Record<string, unknown>): Buffer {
  return createHash('sha256').update(stableStringify(payload)).digest();
}

/**
 * Writes ONE raw_event row. Idempotent on (tenant_id, idempotency_key) via the table's
 * unique constraint + ON CONFLICT DO NOTHING.
 */
export async function writeRawEvent(client: Client, ev: RawEventInput): Promise<void> {
  await client.query(
    `insert into raw_events
       (id, tenant_id, event_type, event_source, source_version, idempotency_key,
        occurred_at, canonical_hash, payload_redacted, schema_version,
        adapter_key_id, adapter_signature)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (tenant_id, idempotency_key) do nothing`,
    [
      ev.id,
      ev.tenantId,
      ev.eventType,
      ev.eventSource,
      ev.sourceVersion ?? null,
      ev.idempotencyKey,
      ev.occurredAt.toISOString(),
      canonicalHash(ev.payloadRedacted),
      JSON.stringify(ev.payloadRedacted),
      ev.schemaVersion,
      ev.adapterKeyId ?? null,
      ev.adapterSignature ?? null,
    ],
  );
}

// ---- one-split-allocation helper -------------------------------------------

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
