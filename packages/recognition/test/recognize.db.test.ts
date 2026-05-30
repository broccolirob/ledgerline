import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { recognizeOne, runRecognitionPass, resolveDemoConfig, type RecognitionConfig } from '@ledgerline/recognition';
import { setupDatabase, dropDatabase, makeRawEvent, insertRawEvent, TENANT } from './helpers';

const TEST_DB = 'ledgerline_test_recognition';
const here = dirname(fileURLToPath(import.meta.url));

let pool: Pool;
let cfg: RecognitionConfig;

async function count(table: string, where = ''): Promise<number> {
  const r = await pool.query(`select count(*)::int as n from ${table} ${where}`);
  return r.rows[0].n as number;
}

beforeAll(async () => {
  pool = await setupDatabase(TEST_DB);
  cfg = await resolveDemoConfig(pool, TENANT);
}, 60_000);

afterAll(async () => {
  await dropDatabase(pool, TEST_DB);
});

describe('recognizeOne — happy path (R1′ principal_gross)', () => {
  it('recognizes a delivered+verified analog into a balanced 8-leg journal', async () => {
    const ev = makeRawEvent({ settlementReference: 'happy-1' });
    const res = await recognizeOne(pool, cfg, ev);
    expect(res.outcome).toBe('recognized');
    expect(res.legCount).toBe(8);

    const re = await pool.query(`select gross_amount_atomic, asset, revenue_status from revenue_events where id=$1`, [res.revenueEventId]);
    expect(re.rows[0].gross_amount_atomic).toBe('3000');
    expect(re.rows[0].revenue_status).toBe('earned');

    const jt = await pool.query(`select txn_type, revenue_treatment, posting_key from journal_transactions where id=$1`, [res.journalTxnId]);
    expect(jt.rows[0].txn_type).toBe('recognition');
    expect(jt.rows[0].revenue_treatment).toBe('principal_gross');
    expect(jt.rows[0].posting_key).toBe(`recognition:${res.revenueEventId}`);

    const bal = await pool.query(
      `select sum(case when direction='debit' then amount_atomic else 0 end) dr,
              sum(case when direction='credit' then amount_atomic else 0 end) cr
         from ledger_entries where entry_group_id=$1`,
      [res.journalTxnId],
    );
    expect(bal.rows[0].dr).toBe('3900');
    expect(bal.rows[0].cr).toBe('3900');

    const cs = await pool.query(`select status from revenue_collection_state where revenue_event_id=$1`, [res.revenueEventId]);
    expect(cs.rows[0].status).toBe('open_receivable');
  });

  it('account fidelity: no platform account; single shared seller COGS account; supplier payables', async () => {
    const platforms = await count('ledger_accounts', `where owner_type='platform'`);
    expect(platforms).toBe(0);

    const cogs = await pool.query(`select id from ledger_accounts where account_type='expense_cogs' and owner_type='seller'`);
    expect(cogs.rows.length).toBe(1); // both COGS debits resolve to ONE account (not fanned per-supplier)

    const payables = await pool.query(`select distinct owner_type, (owner_id is not null) has_owner from ledger_accounts where account_type='payable'`);
    for (const row of payables.rows) {
      expect(row.owner_type).toBe('supplier');
      expect(row.has_owner).toBe(true);
    }
  });
});

describe('recognizeOne — idempotency (interaction-existence gate)', () => {
  it('a second run is a replay no-op: one of each row, NOT duplicated (esp. service_deliveries)', async () => {
    const ev = makeRawEvent({ settlementReference: 'idem-1' });
    const first = await recognizeOne(pool, cfg, ev);
    expect(first.outcome).toBe('recognized');
    const second = await recognizeOne(pool, cfg, ev);
    expect(second.outcome).toBe('replayed');

    const ix = `where payment_identifier='idem-1'`;
    expect(await count('interactions', ix)).toBe(1);
    const iid = (await pool.query(`select id from interactions where payment_identifier='idem-1'`)).rows[0].id;
    expect(await count('service_deliveries', `where interaction_id='${iid}'`)).toBe(1); // the gap the gate closes
    expect(await count('x402_payment_artifacts', `where payment_identifier='idem-1'`)).toBe(1);
    expect(await count('revenue_events', `where interaction_id='${iid}'`)).toBe(1);
    expect(await count('journal_transactions', `where interaction_id='${iid}'`)).toBe(1);
    const reId = (await pool.query(`select id from revenue_events where interaction_id='${iid}'`)).rows[0].id;
    expect(await count('ledger_entries', `where entry_group_id in (select id from journal_transactions where interaction_id='${iid}')`)).toBe(8);
    expect(await count('revenue_collection_state', `where revenue_event_id='${reId}'`)).toBe(1);
  });

  it('append-only: replay leaves the original ledger entry ids unchanged', async () => {
    const ev = makeRawEvent({ settlementReference: 'append-1' });
    const r1 = await recognizeOne(pool, cfg, ev);
    const before = await pool.query(`select id from ledger_entries where entry_group_id=$1 order by id`, [r1.journalTxnId]);
    await recognizeOne(pool, cfg, ev); // replay
    const after = await pool.query(`select id from ledger_entries where entry_group_id=$1 order by id`, [r1.journalTxnId]);
    expect(after.rows.map((x) => x.id)).toEqual(before.rows.map((x) => x.id));
  });

  it('weak-anchor fallback: no settlementReference/paymentSignatureHash → recognizes on fingerprint, replay holds', async () => {
    const ev = makeRawEvent({ settlementReference: 'degraded-1', omitAnchors: true });
    const fpHex = (ev.payload_redacted as { requestFingerprint: string }).requestFingerprint;
    const r1 = await recognizeOne(pool, cfg, ev);
    expect(r1.outcome).toBe('recognized');
    expect(r1.legCount).toBe(8);
    // both the interaction anchor and the artifact_hash fall back to the requestFingerprint
    const ix = (await pool.query(`select payment_identifier from interactions where id=$1`, [r1.interactionId])).rows[0];
    expect(ix.payment_identifier).toBe(fpHex);
    const art = (await pool.query(`select '0x' || encode(artifact_hash, 'hex') as h from x402_payment_artifacts where interaction_id=$1`, [r1.interactionId])).rows[0];
    expect(art.h).toBe(fpHex);
    // replay dedupes on the fingerprint anchor
    const r2 = await recognizeOne(pool, cfg, ev);
    expect(r2.outcome).toBe('replayed');
  });
});

describe('recognizeOne — F1 failure paths (no journal)', () => {
  it('failed delivery: writes the §18.11 failure record, NO journal/revenue/collection_state', async () => {
    const ev = makeRawEvent({ settlementReference: 'f1-failed', deliveryStatus: 'failed', httpStatus: 500 });
    const res = await recognizeOne(pool, cfg, ev);
    expect(res.outcome).toBe('F1_skipped');

    const iid = (await pool.query(`select id, status from interactions where payment_identifier='f1-failed'`)).rows[0];
    expect(iid.status).toBe('failed');
    const sd = await pool.query(`select delivery_status, http_status from service_deliveries where interaction_id=$1`, [iid.id]);
    expect(sd.rows[0].delivery_status).toBe('failed'); // the failure record
    expect(sd.rows[0].http_status).toBe(500);
    expect(await count('revenue_events', `where interaction_id='${iid.id}'`)).toBe(0);
    expect(await count('journal_transactions', `where interaction_id='${iid.id}'`)).toBe(0);
  });

  it('verified=false on a 2xx still takes F1 (no journal)', async () => {
    const ev = makeRawEvent({ settlementReference: 'f1-unverified', verified: false, deliveryStatus: 'delivered', httpStatus: 200 });
    const res = await recognizeOne(pool, cfg, ev);
    expect(res.outcome).toBe('F1_skipped');
    const iid = (await pool.query(`select id from interactions where payment_identifier='f1-unverified'`)).rows[0].id;
    expect(await count('journal_transactions', `where interaction_id='${iid}'`)).toBe(0);
    expect(await count('service_deliveries', `where interaction_id='${iid}'`)).toBe(1);
  });

  it("forward-compat 'canceled' is handled identically to 'failed'", async () => {
    const ev = makeRawEvent({ settlementReference: 'f1-canceled', deliveryStatus: 'canceled', httpStatus: 499 });
    const res = await recognizeOne(pool, cfg, ev);
    expect(res.outcome).toBe('F1_skipped');
    const ix = (await pool.query(`select id, status from interactions where payment_identifier='f1-canceled'`)).rows[0];
    expect(ix.status).toBe('canceled');
    const sd = await pool.query(`select delivery_status from service_deliveries where interaction_id=$1`, [ix.id]);
    expect(sd.rows[0].delivery_status).toBe('canceled');
    expect(await count('journal_transactions', `where interaction_id='${ix.id}'`)).toBe(0);
  });
});

describe('invariants', () => {
  it('Invariant 2: a settled amount != configured fixed price fails recognition and FULLY rolls back', async () => {
    // capture global counts: the interaction/artifact/service_delivery written before the tie-out
    // throw must ALL roll back (single-transaction atomicity — deviation #2), not just the interaction.
    const before = {
      interactions: await count('interactions'),
      artifacts: await count('x402_payment_artifacts'),
      deliveries: await count('service_deliveries'),
      revenue: await count('revenue_events'),
      journals: await count('journal_transactions'),
      legs: await count('ledger_entries'),
    };
    const ev = makeRawEvent({ settlementReference: 'tieout-fail', amountAtomic: '5000' });
    await expect(recognizeOne(pool, cfg, ev)).rejects.toThrow(/Invariant 2/);
    expect(await count('interactions', `where payment_identifier='tieout-fail'`)).toBe(0);
    expect(await count('interactions')).toBe(before.interactions);
    expect(await count('x402_payment_artifacts')).toBe(before.artifacts);
    expect(await count('service_deliveries')).toBe(before.deliveries);
    expect(await count('revenue_events')).toBe(before.revenue);
    expect(await count('journal_transactions')).toBe(before.journals);
    expect(await count('ledger_entries')).toBe(before.legs);
  });

  it('Invariant 7: a duplicate posting_key is rejected by the DB', async () => {
    const pk = 'recognition:dup-test';
    await pool.query(
      `insert into journal_transactions (id, tenant_id, txn_type, posting_key, effective_at) values (gen_random_uuid(),$1,'recognition',$2, now())`,
      [TENANT, pk],
    );
    await expect(
      pool.query(
        `insert into journal_transactions (id, tenant_id, txn_type, posting_key, effective_at) values (gen_random_uuid(),$1,'recognition',$2, now())`,
        [TENANT, pk],
      ),
    ).rejects.toThrow();
  });

  it('Invariant 6: a zero-amount ledger entry is rejected by the DB CHECK', async () => {
    const jt = (await pool.query(
      `insert into journal_transactions (id, tenant_id, txn_type, posting_key, effective_at) values (gen_random_uuid(),$1,'recognition','recognition:zero-leg', now()) returning id`,
      [TENANT],
    )).rows[0].id;
    // reserve/reserve avoids colliding with the happy-path accounts on the natural-key index.
    const acct = (await pool.query(
      `insert into ledger_accounts (id, tenant_id, account_type, owner_type, asset, name) values (gen_random_uuid(),$1,'reserve','reserve','USDC','zero-leg-probe') returning id`,
      [TENANT],
    )).rows[0].id;
    await expect(
      pool.query(
        `insert into ledger_entries (id, tenant_id, entry_group_id, account_id, direction, amount_atomic, asset) values (gen_random_uuid(),$1,$2,$3,'credit',0,'USDC')`,
        [TENANT, jt, acct],
      ),
    ).rejects.toThrow();
  });

  it('§18.16 audit query returns ZERO rows after recognition', async () => {
    const sql = await readFile(join(here, '..', 'src', 'audit.sql'), 'utf8');
    const res = await pool.query(sql);
    expect(res.rows.length).toBe(0);
  });

  it('§18.16 audit query CATCHES an unbalanced journal (negative control)', async () => {
    const jt = (await pool.query(
      `insert into journal_transactions (id, tenant_id, txn_type, posting_key, effective_at) values (gen_random_uuid(),$1,'recognition','recognition:unbalanced-probe', now()) returning id`,
      [TENANT],
    )).rows[0].id;
    // asset 'PROBE' keeps this account's natural key distinct from the Invariant-6 reserve account.
    const acct = (await pool.query(
      `insert into ledger_accounts (id, tenant_id, account_type, owner_type, asset, name) values (gen_random_uuid(),$1,'reserve','reserve','PROBE','unbalanced-probe') returning id`,
      [TENANT],
    )).rows[0].id;
    await pool.query(
      `insert into ledger_entries (id, tenant_id, entry_group_id, account_id, direction, amount_atomic, asset) values (gen_random_uuid(),$1,$2,$3,'debit',100,'PROBE')`,
      [TENANT, jt, acct],
    );
    const sql = await readFile(join(here, '..', 'src', 'audit.sql'), 'utf8');
    const res = await pool.query(sql);
    expect(res.rows.length).toBeGreaterThan(0); // a one-legged journal is unbalanced -> flagged
    // clean the probe so the audit is green again for any later reader
    await pool.query(`delete from ledger_entries where entry_group_id=$1`, [jt]);
    await pool.query(`delete from journal_transactions where id=$1`, [jt]);
  });
});

describe('seed idempotency', () => {
  it('re-applying 0004 leaves exactly four split_rules (the HIGH fix)', async () => {
    const seed = await readFile(join(here, '..', '..', 'db', 'src', 'migrations', '0004_seed_demo_pricing_split.sql'), 'utf8');
    await pool.query(seed);
    await pool.query(seed);
    expect(await count('split_rules')).toBe(4);
    expect(await count('pricing_models')).toBe(1);
    expect(await count('split_groups')).toBe(1);
  });
});

describe('runRecognitionPass', () => {
  it('processes inserted analogs and reports a summary', async () => {
    await insertRawEvent(pool, makeRawEvent({ settlementReference: 'pass-a' }));
    await insertRawEvent(pool, makeRawEvent({ settlementReference: 'pass-b', deliveryStatus: 'failed', httpStatus: 500 }));
    const summary = await runRecognitionPass(pool, cfg);
    expect(summary.total).toBe(2);
    expect(summary.recognized).toBe(1);
    expect(summary.f1Skipped).toBe(1);
    expect(summary.errors).toEqual([]);
    // re-run is fully idempotent
    const again = await runRecognitionPass(pool, cfg);
    expect(again.recognized).toBe(0);
    expect(again.replayed).toBe(2);
  });
});
