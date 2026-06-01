// CSV export (§6): revenue_events.csv + ledger_entries.csv, scoped by tenant_id.
// Run: pnpm export:csv   (-> tsx --env-file-if-exists=../../.env src/export-csv.ts)
// Integer atomic units are rendered as-is (no float formatting); RFC-4180 quoting.
import { Pool } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_TENANT_ID, type Db } from './index.js';

const DEFAULT_DSN = 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';

/** RFC-4180: quote a field if it contains comma/quote/newline; double internal quotes. */
function csvField(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (Buffer.isBuffer(v)) s = '0x' + v.toString('hex');
  else s = String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvField(row[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

const REVENUE_COLUMNS = [
  'revenue_event_id', 'tenant_id', 'interaction_id', 'raw_event_id', 'revenue_source',
  'pricing_model_id', 'gross_amount_atomic', 'asset', 'network', 'revenue_status', 'earned_at',
  'service_delivery_id', 'delivery_status', 'http_status', 'collection_status', 'created_at',
];

const LEDGER_COLUMNS = [
  'ledger_entry_id', 'tenant_id', 'entry_group_id', 'txn_type', 'posting_key', 'revenue_treatment',
  'account_type', 'owner_type', 'owner_id', 'account_name', 'direction', 'amount_atomic', 'asset',
  'memo', 'effective_at', 'created_at',
];

/** Generate the two finance CSVs for a tenant (the exact bytes the CLI writes). Pure read + render,
 *  so it is unit-testable without the filesystem. */
export async function generateCsvExports(
  db: Db,
  tenantId: string,
): Promise<{ revenueCsv: string; ledgerCsv: string; revenueRows: number; ledgerRows: number }> {
  // revenue_events.csv — join-traceable back to receipt/delivery (acceptance line).
  // service_deliveries has no unique key on interaction_id; recognition writes exactly one today,
  // but DISTINCT ON (re.id) guards this finance export from double-counting a revenue_event if an
  // interaction ever gains a second delivery row (picks the earliest delivery deterministically).
  // Wrapped so the CSV keeps created_at ordering while DISTINCT ON requires re.id-led ordering.
  const revenue = await db.query(
    `select * from (
       select distinct on (re.id)
              re.id as revenue_event_id, re.tenant_id, re.interaction_id, i.raw_event_id,
              re.revenue_source, re.pricing_model_id, re.gross_amount_atomic, re.asset, re.network,
              re.revenue_status, re.earned_at, sd.id as service_delivery_id, sd.delivery_status,
              sd.http_status, cs.status as collection_status, re.created_at
         from revenue_events re
         join interactions i on i.id = re.interaction_id
         left join service_deliveries sd on sd.interaction_id = i.id
         left join revenue_collection_state cs on cs.revenue_event_id = re.id
        where re.tenant_id = $1
        order by re.id, sd.created_at nulls last
     ) t
     order by created_at, revenue_event_id`,
    [tenantId],
  );

  const ledger = await db.query(
    `select le.id as ledger_entry_id, le.tenant_id, le.entry_group_id, jt.txn_type, jt.posting_key,
            jt.revenue_treatment, la.account_type, la.owner_type, la.owner_id, la.name as account_name,
            le.direction, le.amount_atomic, le.asset, le.memo, jt.effective_at, le.created_at
       from ledger_entries le
       join journal_transactions jt on jt.id = le.entry_group_id
       join ledger_accounts la on la.id = le.account_id
      where le.tenant_id = $1
      order by jt.effective_at, jt.id, le.id`,
    [tenantId],
  );

  return {
    revenueCsv: toCsv(REVENUE_COLUMNS, revenue.rows),
    ledgerCsv: toCsv(LEDGER_COLUMNS, ledger.rows),
    revenueRows: revenue.rows.length,
    ledgerRows: ledger.rows.length,
  };
}

async function main(): Promise<void> {
  const tenantId = (process.env.LEDGERLINE_TENANT_ID || undefined) ?? DEMO_TENANT_ID;
  const outDir = resolve(process.env.EXPORT_DIR ?? 'exports');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DSN });
  try {
    const { revenueCsv, ledgerCsv, revenueRows, ledgerRows } = await generateCsvExports(pool, tenantId);
    await mkdir(outDir, { recursive: true });
    const revPath = join(outDir, 'revenue_events.csv');
    const ledPath = join(outDir, 'ledger_entries.csv');
    await writeFile(revPath, revenueCsv);
    await writeFile(ledPath, ledgerCsv);
    console.log(`[export:csv] wrote ${revenueRows} revenue row(s) -> ${revPath}`);
    console.log(`[export:csv] wrote ${ledgerRows} ledger entry row(s) -> ${ledPath}`);
  } finally {
    await pool.end();
  }
}

// Run the CLI only when this file is executed directly (tsx src/export-csv.ts), NOT when a test
// imports generateCsvExports from it. Without this guard, importing the module ran main() as a side
// effect — opening a DB connection and, on any failure, calling process.exit(1) mid-test (which
// failed the whole vitest run in CI against a non-migrated database, and silently wrote exports/
// on every local `pnpm test`).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
