// Balance audit (§18.16 / §5.3): runs audit.sql; exits non-zero if any journal transaction is
// unbalanced. Run: pnpm audit   (-> tsx --env-file-if-exists=../../.env src/audit.ts)
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_DSN = 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';
const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const sql = await readFile(join(here, 'audit.sql'), 'utf8');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DSN });
  try {
    const res = await pool.query(sql);
    if (res.rows.length > 0) {
      console.error(`[audit] FAIL — ${res.rows.length} unbalanced journal transaction(s):`);
      console.error(res.rows);
      process.exitCode = 1;
    } else {
      console.log('[audit] OK — every journal transaction balances per asset (0 violations).');
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
