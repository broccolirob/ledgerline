// Test helpers. NOTE: test/ is NOT in tsconfig `include`, so it is not typechecked by
// `pnpm typecheck`; vitest (esbuild) runs it. Relative imports here may be extensionless.
//
// Isolation: a dedicated throwaway DATABASE (not a schema). A schema sharing the server with the
// dev `public` schema breaks `create table if not exists` — Postgres sees the table via search_path
// in public and skips creating it in the test schema. A fresh database has an empty public schema.
import pg from 'pg'; // default import: most reliable CJS interop under vitest/esbuild
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { RawEventRow } from '../src/index';

const ADMIN_DSN = process.env.DATABASE_URL ?? 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'src', 'migrations');

export const TENANT = '00000000-0000-4000-8000-000000000001';

function dsnFor(dbName: string): string {
  const u = new URL(ADMIN_DSN);
  u.pathname = '/' + dbName;
  return u.toString();
}

/** Create a fresh throwaway database, migrate it, and return a Pool connected to it. */
export async function setupDatabase(dbName: string): Promise<Pool> {
  const admin = new pg.Pool({ connectionString: ADMIN_DSN });
  try {
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.query(`create database ${dbName}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: dsnFor(dbName) });
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
    await pool.query(sql);
  }
  return pool;
}

export async function dropDatabase(pool: Pool, dbName: string): Promise<void> {
  await pool.end();
  const admin = new pg.Pool({ connectionString: ADMIN_DSN });
  try {
    await admin.query(`drop database if exists ${dbName} with (force)`);
  } finally {
    await admin.end();
  }
}

/** Deterministic 32-byte (0x-prefixed) hex from a seed, so fixtures get distinct hashes. */
function hex32(seed: string): string {
  return '0x' + createHash('sha256').update(seed).digest('hex');
}

/** Build a receipt-analog raw_event row matching the M1 payload shape (hashes are 0x-prefixed). */
export function makeRawEvent(overrides?: {
  id?: string;
  amountAtomic?: string;
  verified?: boolean;
  deliveryStatus?: 'delivered' | 'failed' | 'canceled';
  httpStatus?: number;
  settlementReference?: string;
  /** Omit settlementReference AND paymentSignatureHash so the anchor degrades to requestFingerprint. */
  omitAnchors?: boolean;
}): RawEventRow {
  const seed = overrides?.settlementReference ?? `settle-${Math.floor(Math.random() * 1e9)}`;
  const id = overrides?.id ?? `raw-${seed}`;
  const payment: Record<string, unknown> = {
    asset: 'USDC',
    payTo: '0xb5e1ffa698b8458260Af9D6316971b83CD72a72C',
    network: 'eip155:5042002',
    verified: overrides?.verified ?? true,
    payerHash: hex32(`payer:${seed}`),
    amountAtomic: overrides?.amountAtomic ?? '3000',
  };
  if (!overrides?.omitAnchors) {
    payment.settlementReference = seed;
    payment.paymentSignatureHash = hex32(`sig:${seed}`); // UNIQUE per event (artifact_hash)
  }
  return {
    id,
    tenant_id: TENANT,
    event_type: 'ledgerline.receipt_analog.v1',
    event_source: 'seller_sdk',
    occurred_at: new Date('2026-05-29T00:00:00.000Z'),
    event_seq: '1', // ignored by insertRawEvent (event_seq is bigserial/auto)
    payload_redacted: {
      kind: 'ledgerline_receipt_analog',
      method: 'POST',
      endpointId: 'company-brief-v1',
      schemaVersion: 'm1.1',
      requestFingerprint: hex32(`fp:${seed}`),
      resourceHash: hex32('resource:company-brief'),
      payment,
      delivery: {
        status: overrides?.deliveryStatus ?? 'delivered',
        latencyMs: 1,
        httpStatus: overrides?.httpStatus ?? 200,
      },
    },
  };
}

/** Insert a raw_event row so the pass / CSV / audit can read it (event_seq is auto-assigned). */
export async function insertRawEvent(pool: Pool, ev: RawEventRow): Promise<void> {
  const settlementReference = (ev.payload_redacted as { payment: { settlementReference: string } }).payment.settlementReference;
  await pool.query(
    `insert into raw_events
       (id, tenant_id, event_type, event_source, idempotency_key, occurred_at, canonical_hash,
        payload_redacted, schema_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     on conflict (tenant_id, idempotency_key) do nothing`,
    [
      ev.id,
      ev.tenant_id,
      ev.event_type,
      ev.event_source,
      `ledgerline-receipt-analog:v1:${settlementReference}`,
      ev.occurred_at,
      Buffer.from('00', 'hex'),
      JSON.stringify(ev.payload_redacted),
      'm1.1',
    ],
  );
}
