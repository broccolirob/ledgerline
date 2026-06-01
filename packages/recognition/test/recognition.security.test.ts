// M5 security tests (§19) — recognition + capture layer.
// T8 split overflow/dust · T1 fingerprint binding · parseReceipt fuzz · T6 adapter-sig HONESTY (negative).
// Pure (no DB) except the T6 negative test, which asserts the schema-level gap on a throwaway DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { allocateSplit, parseReceipt, runRecognitionPass, resolveDemoConfig, type SplitRuleRow, type RawEventRow } from '@ledgerline/recognition';
import { generateCsvExports } from '../src/export-csv';
import { computeRequestFingerprint } from '@ledgerline/seller-client';
import { setupDatabase, dropDatabase, makeRawEvent, insertRawEvent, TENANT } from './helpers';

const demoRules: SplitRuleRow[] = [
  { id: 'd1', recipient_id: 'c1', role: 'publisher', percentage_bps: 7000, fixed_amount_atomic: null },
  { id: 'd2', recipient_id: 'c2', role: 'model_provider', percentage_bps: 2000, fixed_amount_atomic: null },
  { id: 'd3', recipient_id: 'c3', role: 'data_provider', percentage_bps: 700, fixed_amount_atomic: null },
  { id: 'd4', recipient_id: 'c4', role: 'referrer', percentage_bps: 300, fixed_amount_atomic: null },
];

describe('T8 — split overflow / dust cannot create or destroy value', () => {
  it('rejects a rule set summing to >100% (overflow)', () => {
    const over = demoRules.map((r) => (r.role === 'publisher' ? { ...r, percentage_bps: 9000 } : r)); // 9000+2000+700+300=12000
    expect(() => allocateSplit(3000n, over)).toThrow();
  });

  it('rejects a rule set summing to <100% (silent under-allocation)', () => {
    const under = demoRules.map((r) => (r.role === 'publisher' ? { ...r, percentage_bps: 5000 } : r)); // 8000 total
    expect(() => allocateSplit(3000n, under)).toThrow();
  });

  it('conserves value exactly across many gross amounts (Σ shares == gross, no negative legs)', () => {
    for (const gross of [1n, 2n, 3n, 7n, 100n, 999n, 3000n, 1n * 10n ** 18n + 7n]) {
      const a = allocateSplit(gross, demoRules);
      const total = a.sellerShare + a.supplierShares.reduce((s, x) => s + x.amountAtomic, 0n);
      expect(total).toBe(gross); // dust folded into publisher; nothing created or lost
      for (const s of a.supplierShares) expect(s.amountAtomic > 0n).toBe(true); // no zero/negative legs
      expect(a.sellerShare >= 0n).toBe(true);
    }
  });

  it('tiny gross routes all dust to the publisher and still balances', () => {
    const a = allocateSplit(1n, demoRules); // floors: pub 0+dust, others 0 → all to publisher
    expect(a.sellerShare).toBe(1n);
    expect(a.supplierShares.every((s) => s.amountAtomic > 0n)).toBe(true); // zero legs omitted, not emitted as 0
  });
});

describe('T1 — request fingerprint binding (replay safety)', () => {
  const base = {
    tenantId: TENANT, endpointId: 'company-brief-v1', method: 'POST', resourcePath: '/api/company-brief',
    scheme: 'exact', network: 'eip155:5042002', asset: 'USDC', amountAtomic: '3000', payTo: '0xseller',
  };
  it('identical request fields → identical fingerprint (idempotent retry binds)', () => {
    expect(computeRequestFingerprint({ ...base })).toBe(computeRequestFingerprint({ ...base }));
  });
  it('a different amount → different fingerprint (cannot replay a PID against a new price)', () => {
    expect(computeRequestFingerprint({ ...base })).not.toBe(computeRequestFingerprint({ ...base, amountAtomic: '4000' }));
  });
  it('a different resource path → different fingerprint', () => {
    expect(computeRequestFingerprint({ ...base })).not.toBe(computeRequestFingerprint({ ...base, resourcePath: '/api/other' }));
  });
  it('payTo is lowercased before hashing (case is not a fingerprint axis)', () => {
    expect(computeRequestFingerprint({ ...base, payTo: '0xABC' })).toBe(computeRequestFingerprint({ ...base, payTo: '0xabc' }));
  });
});

describe('parseReceipt fuzz — rejects malformed payloads, never coerces a bad amount', () => {
  const wrap = (payment: Record<string, unknown>, delivery: Record<string, unknown>): RawEventRow => ({
    id: 'r', tenant_id: TENANT, event_type: 'ledgerline.receipt_analog.v1', event_source: 'seller_sdk',
    occurred_at: new Date(0), event_seq: '1',
    payload_redacted: { requestFingerprint: '0x' + 'a'.repeat(64), payment, delivery },
  });
  const goodPay = { asset: 'USDC', network: 'eip155:5042002', verified: true, payerHash: '0x' + '3e'.repeat(32), amountAtomic: '3000', settlementReference: 's' };
  const goodDel = { status: 'delivered', httpStatus: 200 };

  for (const [name, amt] of [['float', '3000.5'], ['negative', '-1'], ['hex', '0xbb8'], ['leading zero', '0300'], ['empty', ''], ['non-numeric', 'abc']] as const) {
    it(`rejects amountAtomic ${name}`, () => {
      expect(() => parseReceipt(wrap({ ...goodPay, amountAtomic: amt }, goodDel))).toThrow();
    });
  }
  it('rejects a missing payment object', () => {
    expect(() => parseReceipt({ id: 'r', tenant_id: TENANT, event_type: 'x', event_source: 's', occurred_at: new Date(0), event_seq: '1', payload_redacted: {} })).toThrow();
  });
  it('rejects an unknown delivery.status', () => {
    expect(() => parseReceipt(wrap(goodPay, { status: 'weird', httpStatus: 200 }))).toThrow();
  });
});

describe('T9 (export) — finance CSV exposes no raw URL / prompt / payer address', () => {
  const TEST_DB = 'ledgerline_sec_export';
  let pool: Pool;
  beforeAll(async () => {
    pool = await setupDatabase(TEST_DB);
    await insertRawEvent(pool, makeRawEvent({ settlementReference: 'export-sec' }));
    await runRecognitionPass(pool, await resolveDemoConfig(pool, TENANT));
  }, 60_000);
  afterAll(async () => {
    await dropDatabase(pool, TEST_DB);
  });

  it('the exact CSV the CLI writes carries no raw URL / payer / prompt — including the free-text memo + account_name columns', async () => {
    const { revenueCsv, ledgerCsv, revenueRows, ledgerRows } = await generateCsvExports(pool, TENANT);
    expect(revenueRows).toBeGreaterThanOrEqual(1);
    expect(ledgerRows).toBeGreaterThanOrEqual(8); // 8 legs of the R1′ journal — guards against a vacuous empty-CSV pass

    // memo + account_name are the ONLY exported columns that carry human-derived free text, so they are
    // the realistic leak channel (a fixed UUID/enum column structurally cannot smuggle a URL). Pull the
    // actual values the CSV renders and assert: the channel is live (non-empty + present in the bytes)
    // AND it carries none of the never-export tokens. This is what makes the byte-scan non-vacuous —
    // a regression that wrote a resource URL or payer address into a memo would surface here and FAIL.
    const freeText = await pool.query<{ memo: string; name: string }>(
      `select le.memo, la.name from ledger_entries le join ledger_accounts la on la.id = le.account_id
        where le.tenant_id = $1`,
      [TENANT],
    );
    expect(freeText.rows.length).toBeGreaterThanOrEqual(8);
    for (const { memo, name } of freeText.rows) {
      expect(memo.length).toBeGreaterThan(0);
      expect(ledgerCsv).toContain(memo); // the (safe) memo is faithfully exported — proves the channel is exercised
      for (const banned of ['://', '/api/', 'prompt', 'company-brief', '0xb5e1ffa698b8458260af9d6316971b83cd72a72c']) {
        expect(memo.toLowerCase()).not.toContain(banned);
        expect(name.toLowerCase()).not.toContain(banned);
      }
    }

    // backstop: the full export bytes carry none of the never-export tokens (resource URL/path, prompt,
    // the hash field names, or the literal demo payer address that capture hashed upstream).
    const both = (revenueCsv + '\n' + ledgerCsv).toLowerCase();
    for (const banned of ['/api/', 'http://', 'https://', 'prompt', 'company-brief', 'resourcehash', 'payerhash']) {
      expect(both).not.toContain(banned);
    }
    expect(both).not.toContain('0xb5e1ffa698b8458260af9d6316971b83cd72a72c');
  });

  it('CSV column headers are exactly the published schema (no surprise column could leak a field)', async () => {
    const { revenueCsv, ledgerCsv } = await generateCsvExports(pool, TENANT);
    expect(revenueCsv.split('\r\n')[0]).toBe(
      'revenue_event_id,tenant_id,interaction_id,raw_event_id,revenue_source,pricing_model_id,gross_amount_atomic,asset,network,revenue_status,earned_at,service_delivery_id,delivery_status,http_status,collection_status,created_at',
    );
    expect(ledgerCsv.split('\r\n')[0]).toBe(
      'ledger_entry_id,tenant_id,entry_group_id,txn_type,posting_key,revenue_treatment,account_type,owner_type,owner_id,account_name,direction,amount_atomic,asset,memo,effective_at,created_at',
    );
  });
});

describe('T6 — adapter-event signing is NOT verified (documented gap, not a control)', () => {
  // NEGATIVE test: proves the deferred control is genuinely absent, so THREAT_MODEL.md cannot
  // claim adapter-event authentication it does not have. When M6 adds server-side verification,
  // this test should flip (and the threat model row moves to ENFORCED).
  const TEST_DB = 'ledgerline_sec_t6';
  let pool: Pool;
  beforeAll(async () => {
    pool = await setupDatabase(TEST_DB);
  }, 60_000);
  afterAll(async () => {
    await dropDatabase(pool, TEST_DB);
  });

  it('recognized events carry NO adapter signature — recognition does not authenticate the capturing adapter', async () => {
    await insertRawEvent(pool, makeRawEvent({ settlementReference: 't6-sec' }));
    const cfg = await resolveDemoConfig(pool, TENANT);
    const summary = await runRecognitionPass(pool, cfg);
    expect(summary.recognized).toBeGreaterThanOrEqual(1); // it recognized WITHOUT any signature check
    // raw_events.adapter_signature is written null by the capture path; recognition never checks it.
    const sig = await pool.query<{ n: string }>(
      `select count(*) n from raw_events where tenant_id=$1 and adapter_signature is not null`,
      [TENANT],
    );
    expect(sig.rows[0]!.n).toBe('0'); // gap is real: no adapter event is signed/verified today
  });
});
