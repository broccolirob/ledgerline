// Anchor test helpers: isolated throwaway DATABASE per file (a schema would break
// `create table if not exists` against the shared public schema), seeded with recognized M2 output.
import pg from 'pg';
import type { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildRawEventFromCapture, writeRawEvent } from '@ledgerline/seller-client';
import { runRecognitionPass, resolveDemoConfig } from '@ledgerline/recognition';

const ADMIN_DSN = process.env.DATABASE_URL ?? 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'src', 'migrations');

export const TENANT = '00000000-0000-4000-8000-000000000001';

function dsnFor(dbName: string): string {
  const u = new URL(ADMIN_DSN);
  u.pathname = '/' + dbName;
  return u.toString();
}

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
  for (const f of files) await pool.query(await readFile(join(MIGRATIONS_DIR, f), 'utf8'));
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

let seq = 0; // module-global so every seeded analog gets a unique settlement reference across calls

/** Capture N receipt analogs, persist them, and run the M2 recognition pass. Returns the NEWLY-created
 *  revenue_event ids (precise — avoids created_at ties when picking "the one I just seeded"). */
export async function seedRecognized(pool: Pool, count = 1): Promise<string[]> {
  const before = new Set(
    (await pool.query<{ id: string }>(`select id from revenue_events where tenant_id = $1`, [TENANT])).rows.map((r) => r.id),
  );
  for (let i = 0; i < count; i++) {
    const n = seq++;
    const ev = buildRawEventFromCapture(TENANT, {
      endpointId: 'company-brief-v1',
      schemaVersion: 'm1.1',
      method: 'POST',
      resourcePath: '/api/company-brief',
      payment: {
        verified: true,
        payer: `0x${(n + 1).toString(16).padStart(40, '0')}`,
        amountAtomic: '3000',
        network: 'eip155:5042002',
        asset: 'USDC',
        payTo: '0xb5e1ffa698b8458260Af9D6316971b83CD72a72C',
        settlementReference: `seed-settle-${n}`,
        paymentSignatureHeader: `sig-header-${n}`,
      },
      delivery: { status: 'delivered', httpStatus: 200, latencyMs: 1 },
      occurredAt: new Date('2026-05-29T01:15:27.611Z'),
    });
    await writeRawEvent(pool, ev);
  }
  const cfg = await resolveDemoConfig(pool, TENANT);
  await runRecognitionPass(pool, cfg);
  const ids = await pool.query<{ id: string }>(`select id from revenue_events where tenant_id = $1 order by created_at, id`, [TENANT]);
  return ids.rows.map((r) => r.id).filter((id) => !before.has(id));
}
