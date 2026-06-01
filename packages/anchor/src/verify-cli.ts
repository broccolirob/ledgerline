// Run the §17.6 14-step verifier on a committed revenue_event. Offline by default; --onchain reads
// the live Arc root. Run: pnpm verify -- --revenue-event <id> [--onchain]
import { Pool } from 'pg';
import { verify, formatVerifyResult, DEMO_TENANT_ID } from './index.js';

const DEFAULT_DSN = 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const onchain = process.argv.includes('--onchain');
  let revenueEventId = argValue('--revenue-event');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DSN });
  try {
    if (!revenueEventId) {
      // default: the most recently committed revenue_event for the demo tenant
      const tenantId = (process.env.LEDGERLINE_TENANT_ID || undefined) ?? DEMO_TENANT_ID;
      const r = await pool.query<{ record_id: string }>(
        `select bl.record_id from batch_leaves bl
          where bl.tenant_id = $1 and bl.record_type = 'revenue_event'
          order by bl.created_at desc limit 1`,
        [tenantId],
      );
      revenueEventId = r.rows[0]?.record_id;
      if (!revenueEventId) {
        console.error('[verify] no committed revenue_event found — run pnpm anchor:build first (pass --revenue-event <id> to target one)');
        process.exit(1);
      }
    }
    const res = await verify(pool, revenueEventId, { onchain });
    console.log(formatVerifyResult(res));
    if (!res.pass) process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
