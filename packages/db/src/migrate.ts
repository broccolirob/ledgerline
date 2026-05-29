// Dependency-light migration runner: applies every migrations/*.sql in sorted order.
// Run: pnpm db:migrate  (or, from this package: pnpm --filter @ledgerline/db migrate)
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';

const DEFAULT_DSN = 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';
const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DSN;
  const dir = join(here, 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const f of files) {
      const sql = await readFile(join(dir, f), 'utf8');
      await client.query(sql);
      console.log('applied', f);
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
