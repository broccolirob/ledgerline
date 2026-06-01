// Submit the next built batch to Arc Testnet (Track-A-gated). Prints "blocked on Track A" and exits
// 0 when credentials are absent — mirroring demo-buyer. Run: pnpm anchor:submit
import { Pool } from 'pg';
import { submitNextBatch, DEMO_TENANT_ID } from './index.js';

const DEFAULT_DSN = 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DSN });
  try {
    const tenantId = (process.env.LEDGERLINE_TENANT_ID || undefined) ?? DEMO_TENANT_ID;
    const r = await submitNextBatch(pool, tenantId);
    if (!r.submitted) {
      console.warn('[anchor:submit] not submitted —', r.reason);
      return;
    }
    console.log(`[anchor:submit] committed batch #${r.batchNumber} on Arc Testnet — tx ${r.txHash}`);
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
