// Build one mixed commitment batch over all un-committed earned revenue_events (DB-local; no creds).
// Run: pnpm anchor:build
import { Pool } from 'pg';
import { buildBatch, DEMO_TENANT_ID } from './index.js';

const DEFAULT_DSN = 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DSN });
  try {
    const tenantId = (process.env.LEDGERLINE_TENANT_ID || undefined) ?? DEMO_TENANT_ID;
    const r = await buildBatch(pool, tenantId);
    console.log('[anchor:build]', JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
