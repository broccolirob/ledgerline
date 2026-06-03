// M5/M6b security tests (§19) — recognition + capture layer.
// T8 split overflow/dust · T1 fingerprint binding · parseReceipt fuzz · T9 export · T6 adapter-sig (POSITIVE control).
// DB-backed tests use a throwaway database (T9 export; T6 signing — sign/verify, registry, round-trip).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { allocateSplit, parseReceipt, runRecognitionPass, resolveDemoConfig, type SplitRuleRow, type RawEventRow } from '@ledgerline/recognition';
import { generateCsvExports } from '../src/export-csv';
import {
  computeRequestFingerprint,
  generateAdapterKeyPair,
  buildRawEventFromCapture,
  signRawEvent,
  writeRawEvent,
  verifyRawEventSignature,
  makePostgresSink,
  type LedgerlineCaptureInput,
} from '@ledgerline/seller-client';
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

// ----------------------------------------------------------------------------
// T6 — adapter-event signing IS verified (M6b). Was a negative gap test; now a positive control.
// ----------------------------------------------------------------------------

/** A delivered demo capture for the demo tenant, distinct per settlementReference. */
function demoCapture(settlementReference: string): LedgerlineCaptureInput {
  return {
    endpointId: 'company-brief-v1',
    schemaVersion: 'm1.1',
    method: 'POST',
    resourcePath: '/api/company-brief',
    payment: {
      verified: true,
      payer: '0x' + 'b'.repeat(40),
      amountAtomic: '3000',
      network: 'eip155:5042002',
      asset: 'USDC',
      payTo: '0xseller',
      settlementReference,
      paymentSignatureHeader: `hdr-${settlementReference}`,
    },
    delivery: { status: 'delivered', httpStatus: 200, latencyMs: 1 },
    occurredAt: new Date('2026-05-29T00:00:00.000Z'),
  };
}

async function registerKey(pool: Pool, keyId: string, publicKeyPem: string, status = 'active'): Promise<void> {
  await pool.query(
    `insert into adapter_keys (tenant_id, key_id, public_key, status) values ($1,$2,$3,$4)
     on conflict (tenant_id, key_id) do nothing`,
    [TENANT, keyId, publicKeyPem, status],
  );
}

describe('T6 — adapter-event signing IS verified (positive control)', () => {
  const TEST_DB = 'ledgerline_sec_t6_pos';
  let pool: Pool;
  beforeAll(async () => {
    pool = await setupDatabase(TEST_DB);
  }, 60_000);
  afterAll(async () => {
    await dropDatabase(pool, TEST_DB);
  });

  it('only a validly-signed event from an active registered key becomes revenue; everything else is rejected', async () => {
    const valid = generateAdapterKeyPair();
    const revoked = generateAdapterKeyPair();
    const unknown = generateAdapterKeyPair(); // never registered
    await registerKey(pool, valid.keyId, valid.publicKeyPem, 'active');
    await registerKey(pool, revoked.keyId, revoked.publicKeyPem, 'active');
    await pool.query(`update adapter_keys set status='revoked', revoked_at=now() where tenant_id=$1 and key_id=$2`, [
      TENANT,
      revoked.keyId,
    ]);

    // (1) valid signed → recognized
    await writeRawEvent(
      pool,
      signRawEvent(buildRawEventFromCapture(TENANT, demoCapture('t6-valid')), {
        keyId: valid.keyId,
        privateKeyPem: valid.privateKeyPem,
      }),
    );
    // (2) unsigned → rejected
    await writeRawEvent(pool, buildRawEventFromCapture(TENANT, demoCapture('t6-unsigned')));
    // (3) forged: signed by the valid key, then payload tampered AFTER signing → rejected
    const signed = signRawEvent(buildRawEventFromCapture(TENANT, demoCapture('t6-forged')), {
      keyId: valid.keyId,
      privateKeyPem: valid.privateKeyPem,
    });
    await writeRawEvent(pool, {
      ...signed,
      payloadRedacted: {
        ...signed.payloadRedacted,
        payment: { ...(signed.payloadRedacted.payment as Record<string, unknown>), amountAtomic: '9999' },
      },
    });
    // (4) signed by an UNREGISTERED key → rejected
    await writeRawEvent(
      pool,
      signRawEvent(buildRawEventFromCapture(TENANT, demoCapture('t6-unknown')), {
        keyId: unknown.keyId,
        privateKeyPem: unknown.privateKeyPem,
      }),
    );
    // (5) signed by a REVOKED key → rejected (resolveAdapterKeys returns only active keys)
    await writeRawEvent(
      pool,
      signRawEvent(buildRawEventFromCapture(TENANT, demoCapture('t6-revoked')), {
        keyId: revoked.keyId,
        privateKeyPem: revoked.privateKeyPem,
      }),
    );

    const cfg = { ...(await resolveDemoConfig(pool, TENANT)), requireAdapterSignature: true };
    const summary = await runRecognitionPass(pool, cfg);

    expect(summary.total).toBe(5);
    expect(summary.recognized).toBe(1); // only the validly-signed event
    expect(summary.rejectedUnsigned).toBe(4); // unsigned + forged + unknown-key + revoked-key
    expect(summary.errors).toHaveLength(0);

    const rev = await pool.query<{ n: string }>(`select count(*) n from revenue_events where tenant_id=$1`, [TENANT]);
    expect(rev.rows[0]!.n).toBe('1'); // exactly one revenue event — the valid one
  });
});

describe('T6 — signature verification is opt-in (backward-compat)', () => {
  const TEST_DB = 'ledgerline_sec_t6_compat';
  let pool: Pool;
  beforeAll(async () => {
    pool = await setupDatabase(TEST_DB);
  }, 60_000);
  afterAll(async () => {
    await dropDatabase(pool, TEST_DB);
  });

  it('with requireAdapterSignature OFF (default), an UNSIGNED event still recognizes — existing captures unaffected', async () => {
    await writeRawEvent(pool, buildRawEventFromCapture(TENANT, demoCapture('t6-compat')));
    const cfg = await resolveDemoConfig(pool, TENANT); // requireAdapterSignature undefined → off
    const summary = await runRecognitionPass(pool, cfg);
    expect(summary.recognized).toBe(1);
    expect(summary.rejectedUnsigned).toBe(0);
  });
});

describe('M6b — makePostgresSink fails fast on a malformed signing key (no silent capture loss)', () => {
  it('throws at sink construction for an invalid Ed25519 private key', () => {
    expect(() =>
      makePostgresSink({} as never, { tenantId: TENANT, signer: { keyId: 'k', privateKeyPem: 'not-a-valid-pem' } }),
    ).toThrow(/invalid adapter signing key/i);
  });
  it('accepts a valid keypair without throwing', () => {
    const kp = generateAdapterKeyPair();
    expect(() =>
      makePostgresSink({} as never, { tenantId: TENANT, signer: { keyId: kp.keyId, privateKeyPem: kp.privateKeyPem } }),
    ).not.toThrow();
  });
  it('throws when ADAPTER_KEY_ID does not match the private key (else events would be silently rejected)', () => {
    const a = generateAdapterKeyPair();
    const b = generateAdapterKeyPair(); // a different key's id paired with a's private key
    expect(() =>
      makePostgresSink({} as never, { tenantId: TENANT, signer: { keyId: b.keyId, privateKeyPem: a.privateKeyPem } }),
    ).toThrow(/does not match/i);
  });
});

describe('T6 — a signed event survives the DB round-trip (jsonb/text) and verifies', () => {
  const TEST_DB = 'ledgerline_sec_t6_rt';
  let pool: Pool;
  beforeAll(async () => {
    pool = await setupDatabase(TEST_DB);
  }, 60_000);
  afterAll(async () => {
    await dropDatabase(pool, TEST_DB);
  });

  it('verifies after sign → writeRawEvent → reload; a tampered reload fails', async () => {
    const kp = generateAdapterKeyPair();
    await registerKey(pool, kp.keyId, kp.publicKeyPem, 'active');
    await writeRawEvent(
      pool,
      signRawEvent(buildRawEventFromCapture(TENANT, demoCapture('t6-rt')), {
        keyId: kp.keyId,
        privateKeyPem: kp.privateKeyPem,
      }),
    );

    const row = (
      await pool.query<{ idempotency_key: string; payload_redacted: Record<string, unknown>; adapter_signature: string }>(
        `select idempotency_key, payload_redacted, adapter_signature from raw_events where tenant_id=$1 and adapter_key_id=$2`,
        [TENANT, kp.keyId],
      )
    ).rows[0]!;

    // the signed bytes survive the jsonb/text round-trip
    expect(
      verifyRawEventSignature(
        { tenantId: TENANT, idempotencyKey: row.idempotency_key, payloadRedacted: row.payload_redacted },
        row.adapter_signature,
        kp.publicKeyPem,
      ),
    ).toBe(true);

    // tampering the reloaded payload breaks verification
    const tampered = {
      ...row.payload_redacted,
      payment: { ...(row.payload_redacted.payment as Record<string, unknown>), amountAtomic: '9999' },
    };
    expect(
      verifyRawEventSignature(
        { tenantId: TENANT, idempotencyKey: row.idempotency_key, payloadRedacted: tampered },
        row.adapter_signature,
        kp.publicKeyPem,
      ),
    ).toBe(false);

    // the (tenantId, idempotencyKey) binding is load-bearing: a valid signature does NOT verify when
    // transplanted onto a different event identity (replay / cross-event / cross-tenant transplant).
    expect(
      verifyRawEventSignature(
        { tenantId: TENANT, idempotencyKey: `${row.idempotency_key}-other`, payloadRedacted: row.payload_redacted },
        row.adapter_signature,
        kp.publicKeyPem,
      ),
    ).toBe(false);
    expect(
      verifyRawEventSignature(
        { tenantId: '00000000-0000-4000-8000-0000000000ff', idempotencyKey: row.idempotency_key, payloadRedacted: row.payload_redacted },
        row.adapter_signature,
        kp.publicKeyPem,
      ),
    ).toBe(false);
  });
});
