// Ledgerline grant demo — the §21 nine-step sequence, end to end.
//   pnpm demo
// Resilient + idempotent: runs the live 402->pay->200 loop when the buyer is funded, else starts from
// the already-captured raw_events (M0/M1); commits + verifies on Arc Testnet when anchor creds are
// present, else stays offline. Re-running is safe (recognize/build/submit are replay-no-ops).
//
// Orchestration ONLY — every step calls an existing, tested entry point. Reads env, never writes secrets.
// Lives in @ledgerline/anchor (it resolves recognition+canonical+anchor); child `pnpm` calls run at the
// repo root via REPO_ROOT so the root scripts (dev:buyer, export:csv) resolve.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import {
  resolveDemoConfig,
  runRecognitionPass,
  DEMO_TENANT_ID,
} from '@ledgerline/recognition';
import {
  buildBatch,
  submitNextBatch,
  verify,
  formatVerifyResult,
} from '@ledgerline/anchor';

const DEFAULT_DSN = 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TENANT = (process.env.LEDGERLINE_TENANT_ID || undefined) ?? DEMO_TENANT_ID;

function banner(n: number | string, title: string): void {
  console.log(`\n${'═'.repeat(78)}\n  STEP ${n} — ${title}\n${'═'.repeat(78)}`);
}
function line(s = ''): void {
  console.log(s);
}

/** True when the anchor on-chain client has its full Track-A env. */
function anchorCredsPresent(): boolean {
  return Boolean(process.env.ARC_RPC_URL && process.env.ANCHOR_COMMITTER_KEY && process.env.ANCHOR_CONTRACT_ADDRESS);
}

/** Quick liveness probe of the demo seller's /healthz, so live-pay is only attempted when it can succeed. */
async function sellerReachable(): Promise<boolean> {
  const base = (process.env.SELLER_URL ?? 'http://localhost:4021/api/company-brief').replace(/\/api\/.*$/, '');
  try {
    const ctrl = AbortSignal.timeout(1500);
    const res = await fetch(`${base}/healthz`, { signal: ctrl });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DSN });

  // ---- preflight ----------------------------------------------------------
  try {
    await pool.query('select 1');
  } catch {
    console.error('[demo] Postgres not reachable. Run `pnpm db:up && pnpm db:migrate` first.');
    await pool.end();
    process.exit(1);
  }

  const buyerFunded = Boolean(process.env.BUYER_PRIVATE_KEY); // Gateway balance re-checked by demo-buyer
  const onchain = anchorCredsPresent();
  const cfg = await resolveDemoConfig(pool, TENANT);

  line('\n╔══════════════════════════════════════════════════════════════════════════╗');
  line('║  LEDGERLINE — x402 revenue subledger, anchored on Arc Testnet            ║');
  line('║  §21 grant demo: paid call → recognized → split → exported → Arc-anchored ║');
  line('╚══════════════════════════════════════════════════════════════════════════╝');
  line(`  Payment: ${buyerFunded ? 'buyer creds present (live-pay attempted if seller up)' : 'CAPTURED-START (replay M0/M1 receipt analogs)'}`);
  line(`  Anchor:  ${onchain ? 'ON-CHAIN (Arc Testnet)' : 'OFFLINE (DB-consistent only)'}`);
  line(`  Tenant:  ${TENANT}`);

  // ---- steps 1-3: the paid x402 call --------------------------------------
  banner('1-3', 'Paid x402 call over Circle Gateway Nanopayments (Arc Testnet)');
  const capturedCount = await pool.query<{ c: string }>(
    `select count(*) c from raw_events where tenant_id=$1 and event_type='ledgerline.receipt_analog.v1'`,
    [TENANT],
  );
  // Only attempt the live loop when the buyer has creds AND the seller's /healthz is reachable, so a
  // not-running seller is a quiet, expected fallback — not a child-process error that looks like a crash.
  const sellerUp = buyerFunded && (await sellerReachable());
  if (sellerUp) {
    line('Buyer funded + seller up — running the live 402 → pay → 200 loop...');
    // Output is CAPTURED (not inherited) so a non-zero buyer exit doesn't surface pnpm's ELIFECYCLE
    // banner. demo-buyer exits 0 even when it can't pay (e.g. no Gateway balance), so success is
    // judged by its 'paid:' marker — NOT exit status — to avoid narrating a no-op as a live payment.
    const r = spawnSync('pnpm', ['--filter', '@ledgerline/demo-buyer', 'start'], { encoding: 'utf8', env: process.env, cwd: REPO_ROOT });
    const out = (r.stdout || '') + (r.stderr || '');
    if (r.status === 0 && /\bpaid:/.test(out)) {
      line(out.trim().split('\n').filter((l) => /paid:/.test(l)).join('\n'));
    } else {
      line('live pay loop did not complete (balance/deposit needed) — continuing from captured events.');
    }
  } else if (buyerFunded) {
    line('Buyer creds present but seller not reachable on /healthz — start it with `pnpm dev`.');
    line(`Continuing from ${capturedCount.rows[0]!.c} captured receipt analog(s) from the live M0/M1 runs.`);
  } else {
    line(`No buyer creds — using ${capturedCount.rows[0]!.c} captured receipt analog(s) from the live M0/M1 runs.`);
    line('(Steps 1–3 were proven live on Arc Testnet at M0; see DECISION_LOG D-0004.)');
  }

  // ---- steps 4-5: recognition + split -------------------------------------
  banner('4-5', 'Revenue recognition + 4-way split → balanced double-entry ledger');
  const summary = await runRecognitionPass(pool, cfg);
  line(`recognized=${summary.recognized} replayed=${summary.replayed} f1_skipped=${summary.f1Skipped} errors=${summary.errors.length}`);
  if (summary.errors.length) line(`⚠ errors: ${JSON.stringify(summary.errors)}`);

  const re = await pool.query<{ id: string; gross_amount_atomic: string; asset: string; revenue_status: string }>(
    `select id, gross_amount_atomic, asset, revenue_status from revenue_events
      where tenant_id=$1 and revenue_status='earned' order by created_at limit 1`,
    [TENANT],
  );
  if (re.rows.length === 0) {
    line('No earned revenue_event found — nothing to anchor. (Capture or pay first.)');
    await pool.end();
    process.exit(1);
  }
  const reId = re.rows[0]!.id;
  line(`\nearned revenue_event ${reId}: gross=${re.rows[0]!.gross_amount_atomic} ${re.rows[0]!.asset} (${re.rows[0]!.revenue_status})`);

  const split = await pool.query<{ role: string; amount_atomic: string; direction: string; account_type: string }>(
    `select la.account_type, le.direction, le.amount_atomic, le.memo as role
       from ledger_entries le
       join journal_transactions jt on jt.id = le.entry_group_id
       join ledger_accounts la on la.id = le.account_id
      where jt.tenant_id=$1 and jt.revenue_event_id=$2 and jt.txn_type='recognition'
      order by le.created_at`,
    [TENANT, reId],
  );
  line('\nrecognition journal (principal_gross R1′):');
  let dr = 0n;
  let cr = 0n;
  for (const r of split.rows) {
    const amt = BigInt(r.amount_atomic);
    if (r.direction === 'debit') dr += amt;
    else cr += amt;
    line(`  ${r.direction.padEnd(6)} ${String(r.amount_atomic).padStart(5)}  ${r.account_type.padEnd(16)} ${r.role}`);
  }
  line(`  ΣDr=${dr}  ΣCr=${cr}  ${dr === cr ? '✓ balanced (Invariant 1)' : '✗ UNBALANCED'}`);

  // ---- step 6: ledger / recipient view ------------------------------------
  banner('6', 'Recipient statement (per-payable rollup)');
  const recip = await pool.query<{ owner_id: string | null; total: string }>(
    `select la.owner_id, sum(le.amount_atomic) total
       from ledger_entries le
       join journal_transactions jt on jt.id = le.entry_group_id
       join ledger_accounts la on la.id = le.account_id
      where jt.tenant_id=$1 and la.account_type='payable' and le.direction='credit'
      group by la.owner_id order by total desc`,
    [TENANT],
  );
  if (recip.rows.length === 0) line('  (no supplier payables yet)');
  for (const r of recip.rows) line(`  recipient ${r.owner_id} → owed ${r.total} atomic`);

  // ---- step 7: export -----------------------------------------------------
  banner('7', 'Finance export (CSV — reconciles revenue ↔ receipt/delivery)');
  const ex = spawnSync('pnpm', ['export:csv'], { stdio: 'inherit', env: process.env, cwd: REPO_ROOT });
  if (ex.status !== 0) line('⚠ export:csv failed (non-fatal for the demo).');

  // ---- step 8: commit to Arc ----------------------------------------------
  banner('8', 'Commit Merkle batch root to Arc Testnet');
  const build = await buildBatch(pool, TENANT);
  if (build.built) line(`built batch #${build.batchNumber}: ${build.eventCount} leaves, root ${build.merkleRootHex}`);
  else line(`(no new batch to build — ${build.reason})`);

  if (onchain) {
    const sub = await submitNextBatch(pool, TENANT);
    if (sub.submitted) line(`✓ committed batch #${sub.batchNumber} on Arc Testnet — tx ${sub.txHash}`);
    else line(`(submit: ${sub.reason})`);
  } else {
    const head = await pool.query<{ batch_number: string; status: string; root: string }>(
      `select batch_number, status, '0x'||encode(merkle_root,'hex') root from commitment_batches
        where tenant_id=$1 order by batch_number desc limit 1`,
      [TENANT],
    );
    if (head.rows.length) line(`built batch #${head.rows[0]!.batch_number} (status=${head.rows[0]!.status}) root ${head.rows[0]!.root}`);
    line('OFFLINE — set ARC_RPC_URL + ANCHOR_COMMITTER_KEY + ANCHOR_CONTRACT_ADDRESS to commit live.');
  }

  // ---- step 9: verify -----------------------------------------------------
  banner('9', `Verifier — prove the revenue event is in the ${onchain ? 'Arc-committed' : 'committed'} root`);
  const result = await verify(pool, reId, { onchain });
  line(formatVerifyResult(result));

  line('\n' + '─'.repeat(78));
  line('  This x402 payment is not just paid. It is reconcilable, auditable,');
  line('  split-ready, and Arc-anchored.');
  line('─'.repeat(78));

  await pool.end();
  if (!result.pass) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
