import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { keccak256 as viemKeccak } from 'viem';
import type { Pool } from 'pg';
import { keccak256 as canonicalKeccak, toHex } from '@ledgerline/canonical';
import { buildBatch, verify, generateVerifierPackage, submitNextBatch } from '@ledgerline/anchor';
import { createReceiptIssuer, generateReceiptSigningKey, offerReceiptArtifactHash } from '@ledgerline/x402-receipts';
import { setupDatabase, dropDatabase, seedRecognized, TENANT } from './helpers';

const ARC_NET = 'eip155:5042002';
const SEED_PAYTO = '0xb5e1ffa698b8458260Af9D6316971b83CD72a72C';
const SEED_RESOURCE = '/api/company-brief';

/** Insert an official x402 artifact row (with artifact_json) for an interaction — mirrors what the
 *  M6c recognition pass writes, used here to drive the verifier's steps 1-3 offline. */
async function insertArtifact(
  pool: Pool,
  interactionId: string,
  paymentIdentifier: string,
  artifactType: 'signed_offer' | 'signed_receipt',
  artifact: unknown,
): Promise<void> {
  await pool.query(
    `insert into x402_payment_artifacts
       (id, tenant_id, interaction_id, artifact_type, artifact_hash, artifact_json, payment_identifier)
     values (gen_random_uuid(), $1, $2, $3, $4, $5::jsonb, $6)`,
    [TENANT, interactionId, artifactType, offerReceiptArtifactHash(artifact), JSON.stringify(artifact), paymentIdentifier],
  );
}

async function interactionForRevenue(pool: Pool, reId: string): Promise<{ id: string; payment_identifier: string }> {
  return (await pool.query<{ id: string; payment_identifier: string }>(
    `select i.id, i.payment_identifier from interactions i
      join revenue_events re on re.interaction_id = i.id where re.id = $1`,
    [reId],
  )).rows[0]!;
}

const TEST_DB = 'ledgerline_test_anchor';

let pool: Pool;

async function count(table: string, where = ''): Promise<number> {
  const r = await pool.query(`select count(*)::int as n from ${table} ${where}`);
  return r.rows[0].n as number;
}

beforeAll(async () => {
  pool = await setupDatabase(TEST_DB);
}, 60_000);

afterAll(async () => {
  await dropDatabase(pool, TEST_DB);
});

describe('keccak256 primitive', () => {
  it('@ledgerline/canonical keccak256 == viem keccak256 (proves EVM keccak, not NIST sha3)', () => {
    for (const s of ['', 'LEDGERLINE_CANONICAL_RECORD_V1', 'the quick brown fox']) {
      const bytes = new TextEncoder().encode(s);
      expect(toHex(canonicalKeccak(bytes))).toBe(viemKeccak(bytes));
    }
  });
});

describe('buildBatch (Invariant 11, mixed batch)', () => {
  it('commits one revenue_event + its 8 ledger legs as a 9-leaf batch', async () => {
    const [reId] = await seedRecognized(pool, 1);
    const r = await buildBatch(pool, TENANT);
    expect(r.built).toBe(true);
    expect(r.eventCount).toBe(9); // 1 revenue_event + 8 ledger_entries
    expect(r.batchNumber).toBe(1n);
    expect(r.previousMerkleRootHex).toBe('0x' + '00'.repeat(32)); // first batch
    expect(r.revenueEventIds).toContain(reId);

    expect(await count('commitment_batches')).toBe(1);
    expect(await count('batch_leaves')).toBe(9);
    expect(await count('batch_leaves', `where record_type='revenue_event'`)).toBe(1);
    expect(await count('batch_leaves', `where record_type='ledger_entry'`)).toBe(8);
  });

  it('is idempotent: a second build with nothing new is a no-op', async () => {
    const r = await buildBatch(pool, TENANT);
    expect(r.built).toBe(false);
    expect(await count('commitment_batches')).toBe(1);
    expect(await count('batch_leaves')).toBe(9);
  });

  it('chains: a second batch previous_merkle_root == the first batch merkle_root', async () => {
    await seedRecognized(pool, 1); // a new earned revenue_event
    const r2 = await buildBatch(pool, TENANT);
    expect(r2.built).toBe(true);
    expect(r2.batchNumber).toBe(2n);
    const b1 = await pool.query<{ merkle_root: Buffer }>(`select merkle_root from commitment_batches where batch_number=1`);
    expect(r2.previousMerkleRootHex).toBe('0x' + b1.rows[0]!.merkle_root.toString('hex'));
  });

  it('Invariant 11: all 8 legs of a journal land in the same batch as its revenue_event', async () => {
    const reId = (await pool.query<{ id: string }>(`select id from revenue_events order by created_at limit 1`)).rows[0]!.id;
    const batchId = (await pool.query<{ commitment_batch_id: string }>(
      `select commitment_batch_id from batch_leaves where record_type='revenue_event' and record_id=$1`,
      [reId],
    )).rows[0]!.commitment_batch_id;
    const legCount = (await pool.query<{ n: string }>(
      `select count(*) n from batch_leaves bl
        where bl.commitment_batch_id=$1 and bl.record_type='ledger_entry'
          and bl.record_id in (
            select le.id from ledger_entries le join journal_transactions jt on jt.id=le.entry_group_id
             where jt.revenue_event_id=$2 and jt.txn_type='recognition')`,
      [batchId, reId],
    )).rows[0]!.n;
    expect(legCount).toBe('8');
  });
});

describe('verify (§17.6 14-step, Path-C re-scoped)', () => {
  it('a committed revenue_event passes the full offline checklist', async () => {
    const reId = (await pool.query<{ id: string }>(`select id from revenue_events order by created_at limit 1`)).rows[0]!.id;
    const res = await verify(pool, reId);
    const byN = Object.fromEntries(res.steps.map((s) => [s.n, s]));
    expect(res.pass).toBe(true);
    expect(byN[0]!.status).toBe('pass'); // canonical reproduction
    expect(byN[1]!.status).toBe('pass'); // receipt analog present
    expect(byN[2]!.status).toBe('na'); // no official signed receipt (Path C)
    expect(byN[7]!.status).toBe('pass'); // exact-pricing tie-out
    expect(byN[8]!.status).toBe('pass'); // principal_gross tie-out
    expect(byN[9]!.status).toBe('pass'); // balance + legs co-located
    expect(byN[12]!.status).toBe('pass'); // prev-root chain
    expect(byN[13]!.status).toBe('pass'); // leaf inclusion (offline)
    expect(byN[14]!.status).toBe('skip'); // Arc finality not checked offline
  });

  it('official x402 signed offer + receipt (Path B) turn steps 1-3 into REAL passes', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    const ix = await interactionForRevenue(pool, reId!);
    // Issue REAL EIP-712 artifacts with the seeded terms (gross 3000, Arc network, same resource).
    const issuer = createReceiptIssuer({ privateKey: generateReceiptSigningKey(), network: ARC_NET });
    const offer = await issuer.issueSignedOffer(SEED_RESOURCE, { network: ARC_NET, asset: 'USDC', payTo: SEED_PAYTO, amount: '3000' });
    const receipt = await issuer.issueSignedReceipt(SEED_RESOURCE, '0x00000000000000000000000000000000000000a1', ARC_NET, ix.payment_identifier);
    await insertArtifact(pool, ix.id, ix.payment_identifier, 'signed_offer', offer);
    await insertArtifact(pool, ix.id, ix.payment_identifier, 'signed_receipt', receipt);

    const res = await verify(pool, reId!);
    const byN = Object.fromEntries(res.steps.map((s) => [s.n, s]));
    expect(byN[1]!.status).toBe('pass'); // official signed receipt present (no longer the analog)
    expect(byN[2]!.status).toBe('pass'); // EIP-712 signature verifies
    expect(byN[3]!.status).toBe('pass'); // binds the offer, same issuer, offer.amount ties to gross 3000
    expect(byN[4]!.status).toBe('pass'); // payment-identifier binding intact (analog still present)
    expect(res.pass).toBe(true);
    // copy now POSITIVELY names the official artifact on this path (drops the analog hedge)
    expect(`${byN[1]!.name} ${byN[1]!.detail}`).toMatch(/official x402 .*Signed Receipt/i);
  });

  it('a TAMPERED official receipt fails the verifier (step 3 catches the issuer mismatch)', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    const ix = await interactionForRevenue(pool, reId!);
    const issuer = createReceiptIssuer({ privateKey: generateReceiptSigningKey(), network: ARC_NET });
    const offer = await issuer.issueSignedOffer(SEED_RESOURCE, { network: ARC_NET, asset: 'USDC', payTo: SEED_PAYTO, amount: '3000' });
    const receipt = await issuer.issueSignedReceipt(SEED_RESOURCE, '0x00000000000000000000000000000000000000a1', ARC_NET, ix.payment_identifier);
    // Tamper the receipt payload AFTER signing — it now recovers a DIFFERENT signer than the offer.
    const tampered = { ...receipt, payload: { ...receipt.payload, payer: '0x00000000000000000000000000000000000000ff' } };
    await insertArtifact(pool, ix.id, ix.payment_identifier, 'signed_offer', offer);
    await insertArtifact(pool, ix.id, ix.payment_identifier, 'signed_receipt', tampered);

    const res = await verify(pool, reId!);
    const byN = Object.fromEntries(res.steps.map((s) => [s.n, s]));
    expect(byN[3]!.status).toBe('fail'); // tampered receipt recovers a different issuer than the offer
    expect(res.pass).toBe(false);
  });

  it('a VALID official receipt WITHOUT its offer fails the verifier (no lone-receipt pass via na)', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    const ix = await interactionForRevenue(pool, reId!);
    // Issue a perfectly valid receipt but DO NOT capture its offer — it cannot be cross-checked, so the
    // verifier must FAIL (step 3), not silently report `na` and let the whole checklist pass.
    const issuer = createReceiptIssuer({ privateKey: generateReceiptSigningKey(), network: ARC_NET });
    const receipt = await issuer.issueSignedReceipt(SEED_RESOURCE, '0x00000000000000000000000000000000000000a1', ARC_NET, ix.payment_identifier);
    await insertArtifact(pool, ix.id, ix.payment_identifier, 'signed_receipt', receipt);

    const res = await verify(pool, reId!);
    const byN = Object.fromEntries(res.steps.map((s) => [s.n, s]));
    expect(byN[2]!.status).toBe('pass'); // the signature itself verifies
    expect(byN[3]!.status).toBe('fail'); // but with no offer it cannot bind -> fail (not na)
    expect(res.pass).toBe(false);
  });

  it('a malformed official receipt (payload missing payer) does NOT crash verify() — steps 2/3 fail cleanly', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    const ix = await interactionForRevenue(pool, reId!);
    const issuer = createReceiptIssuer({ privateKey: generateReceiptSigningKey(), network: ARC_NET });
    const offer = await issuer.issueSignedOffer(SEED_RESOURCE, { network: ARC_NET, asset: 'USDC', payTo: SEED_PAYTO, amount: '3000' });
    // A receipt that passes a naive envelope check but whose payload has NO payer — the SDK matcher does
    // payload.payer.toLowerCase(), which threw and crashed the whole verifier before the guard/try-catch.
    const malformedReceipt = { format: 'eip712', signature: '0xdeadbeef', payload: { version: 1, network: ARC_NET, resourceUrl: SEED_RESOURCE, issuedAt: 1717200000 } };
    await insertArtifact(pool, ix.id, ix.payment_identifier, 'signed_offer', offer);
    await insertArtifact(pool, ix.id, ix.payment_identifier, 'signed_receipt', malformedReceipt);

    const res = await verify(pool, reId!); // must NOT throw
    const byN = Object.fromEntries(res.steps.map((s) => [s.n, s]));
    expect(byN[2]!.status).toBe('fail'); // invalid receipt
    expect(byN[3]!.status).toBe('fail'); // cannot bind
    expect(res.pass).toBe(false);
  });

  it('verifier package does NOT overclaim "official … re-verifiable" when the receipt signature is invalid', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    const ix = await interactionForRevenue(pool, reId!);
    const issuer = createReceiptIssuer({ privateKey: generateReceiptSigningKey(), network: ARC_NET });
    const offer = await issuer.issueSignedOffer(SEED_RESOURCE, { network: ARC_NET, asset: 'USDC', payTo: SEED_PAYTO, amount: '3000' });
    const validReceipt = await issuer.issueSignedReceipt(SEED_RESOURCE, '0x00000000000000000000000000000000000000a1', ARC_NET, ix.payment_identifier);
    const brokenReceipt = { ...validReceipt, signature: '0xdeadbeef' }; // shape-valid but signature won't verify
    await insertArtifact(pool, ix.id, ix.payment_identifier, 'signed_offer', offer);
    await insertArtifact(pool, ix.id, ix.payment_identifier, 'signed_receipt', brokenReceipt);

    const pkg = await generateVerifierPackage(pool, reId!);
    expect(pkg.generatedNote).not.toMatch(/official x402.*captured \+ re-verifiable/i); // no overclaim on an invalid receipt
    expect(pkg.generatedNote).toMatch(/receipt analog/i); // honest fallback note
    expect(pkg.verification.pass).toBe(false); // step 2 fails on the broken signature
  });

  it('analog-only interaction still passes step 1 (Path C) with steps 2-3 na (backward-compat)', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    const res = await verify(pool, reId!);
    const byN = Object.fromEntries(res.steps.map((s) => [s.n, s]));
    expect(byN[1]!.status).toBe('pass'); // Path-C analog
    expect(byN[2]!.status).toBe('na');
    expect(byN[3]!.status).toBe('na');
    expect(res.pass).toBe(true);
    expect(`${byN[1]!.name} ${byN[1]!.detail}`).toMatch(/receipt analog/i);
  });

  it('no-overclaim: copy calls it a "receipt analog" and explicitly disclaims the official artifact', async () => {
    const reId = (await pool.query<{ id: string }>(`select id from revenue_events order by created_at limit 1`)).rows[0]!.id;
    const res = await verify(pool, reId);
    const joined = res.steps.map((s) => `${s.name} ${s.detail}`).join(' | ');
    expect(joined).toMatch(/receipt analog/i); // named as the analog
    expect(joined).toMatch(/no(t| official)/i); // disclaims the official x402 Signed Receipt (never positively claims it)
    expect(joined).not.toMatch(/official x402 Signed Receipt captured|is an? official.{0,20}Signed Receipt/i);
  });

  it('a tampered ledger amount fails canonical reproduction (step 0) and the balance/tie-out', async () => {
    // Use a fresh isolated revenue_event so we do not corrupt the others.
    const ids = await seedRecognized(pool, 1);
    const reId = ids[ids.length - 1]!;
    await buildBatch(pool, TENANT);
    // tamper: bump a payable leg amount AFTER commit — recomputed leaf no longer matches the stored hash
    await pool.query(
      `update ledger_entries set amount_atomic = '999' where id in (
        select le.id from ledger_entries le join journal_transactions jt on jt.id=le.entry_group_id
         where jt.revenue_event_id=$1 and le.direction='credit' and le.amount_atomic='600' limit 1)`,
      [reId],
    );
    const res = await verify(pool, reId);
    expect(res.pass).toBe(false);
    const byN = Object.fromEntries(res.steps.map((s) => [s.n, s]));
    expect(byN[0]!.status).toBe('fail'); // canonical reproduction breaks
  });

  it('a missing committed leg fails (step 0 + Invariant-11 step 9)', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    // Deterministically remove one ledger leaf from THIS revenue_event's committed batch.
    const target = (await pool.query<{ id: string }>(
      `select id from batch_leaves
        where record_type = 'ledger_entry'
          and commitment_batch_id = (select commitment_batch_id from batch_leaves where record_type='revenue_event' and record_id=$1)
        limit 1`,
      [reId],
    )).rows[0];
    const del = await pool.query(`delete from batch_leaves where id = $1`, [target!.id]);
    expect(del.rowCount).toBe(1); // guard: the test must actually remove a committed leg
    const res = await verify(pool, reId!);
    const byN = Object.fromEntries(res.steps.map((s) => [s.n, s]));
    expect(res.pass).toBe(false);
    expect(byN[0]!.status).toBe('fail'); // canonical reproduction can't rebuild the committed root
    expect(byN[9]!.status).toBe('fail'); // not all journal legs are co-located in the batch (Inv 11)
  });

  it('a changed revenue_event gross_amount fails the verifier (step 0 + the exact-pricing tie-out)', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    expect((await verify(pool, reId!)).pass).toBe(true); // baseline passes
    // tamper the revenue_event's gross AFTER commit — its committed leaf no longer reproduces, and the
    // settled gross no longer matches the configured exact price.
    await pool.query(`update revenue_events set gross_amount_atomic = '4000' where id = $1`, [reId]);
    const res = await verify(pool, reId!);
    const byN = Object.fromEntries(res.steps.map((s) => [s.n, s]));
    expect(res.pass).toBe(false);
    expect(byN[0]!.status).toBe('fail'); // revenue_event leaf no longer reproduces the committed root
    expect(byN[7]!.status).toBe('fail'); // 4000 != pricing_models.fixed_amount_atomic (Invariant 2)
  });

  it('a reshuffled split (value moved between payables, sum preserved) fails the verifier even though it still balances', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    expect((await verify(pool, reId!)).pass).toBe(true);
    // Move 100 atomic from the model_provider payable (600) to the data_provider payable (210),
    // keeping ΣDr=ΣCr and the payable-credit total unchanged — so step 8 tie-out and step 9 balance
    // BOTH still hold. Only the Arc-committed Merkle root (step 0/13) catches this reallocation.
    await pool.query(
      `update ledger_entries set amount_atomic = '500' where id in (
        select le.id from ledger_entries le join journal_transactions jt on jt.id=le.entry_group_id
         where jt.revenue_event_id=$1 and le.direction='credit' and le.amount_atomic='600' limit 1)`,
      [reId],
    );
    await pool.query(
      `update ledger_entries set amount_atomic = '310' where id in (
        select le.id from ledger_entries le join journal_transactions jt on jt.id=le.entry_group_id
         where jt.revenue_event_id=$1 and le.direction='credit' and le.amount_atomic='210' limit 1)`,
      [reId],
    );
    const res = await verify(pool, reId!);
    const byN = Object.fromEntries(res.steps.map((s) => [s.n, s]));
    // The reshuffle preserves balance (step 9) but the committed leaves no longer reproduce: the
    // tamper-evidence is the Arc Merkle root, not the accounting invariants alone.
    expect(byN[9]!.status).toBe('pass'); // still balances — accounting checks alone would MISS this
    expect(byN[0]!.status).toBe('fail'); // canonical reproduction catches the reallocation
    expect(res.pass).toBe(false);
  });
});

describe('verifier package', () => {
  it('generates a self-contained, no-overclaim bundle with a verifying proof', async () => {
    const reId = (await pool.query<{ id: string }>(`select id from revenue_events order by created_at limit 1`)).rows[0]!.id;
    const pkg = await generateVerifierPackage(pool, reId);
    expect(pkg.generatedNote).toMatch(/receipt analog/i);
    expect(pkg.generatedNote).toMatch(/not an official/i); // disclaims, never positively claims
    expect(pkg.generatedNote).not.toMatch(/official x402 Signed Receipt captured/i);
    expect(pkg.records.revenue_event).toBeTruthy();
    expect(Array.isArray(pkg.records.ledger_entries)).toBe(true);
    expect(pkg.merkleProof.siblings.length).toBeGreaterThan(0);
    expect(pkg.batch.merkle_root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pkg.verification.pass).toBe(true);
  });
});

describe('submit (Track-A-gated)', () => {
  it('reports "blocked on Track A" without credentials (no throw)', async () => {
    const r = await submitNextBatch(pool, TENANT);
    expect(r.submitted).toBe(false);
    expect(r.reason).toMatch(/Track A/i);
  });
});

describe('verifier soundness — review-hardening regressions', () => {
  it('step 0 catches a tampered batch_id (verifier binds batch_id to its canonical derivation)', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    const before = await verify(pool, reId!);
    expect(before.pass).toBe(true);
    // tamper: flip the stored batch_id of this revenue_event's batch
    await pool.query(
      `update commitment_batches set batch_id = decode(repeat('ab', 32), 'hex')
        where id = (select commitment_batch_id from batch_leaves where record_type='revenue_event' and record_id=$1)`,
      [reId],
    );
    const after = await verify(pool, reId!);
    expect(after.pass).toBe(false);
    expect(after.steps.find((s) => s.n === 0)!.status).toBe('fail');
  });

  it('step 12 FAILS a non-genesis batch whose predecessor is missing (no genesis-fallback false accept)', async () => {
    const [reId] = await seedRecognized(pool, 1);
    await buildBatch(pool, TENANT);
    // forge a chain break: relabel this batch to a high number whose predecessor cannot exist (the
    // file shares one DB across tests, so low numbers like 2 may have a real predecessor). The
    // previous_merkle_root stays all-zero, which the OLD code wrongly accepted as genesis.
    await pool.query(
      `update commitment_batches set batch_number = 9999
        where id = (select commitment_batch_id from batch_leaves where record_type='revenue_event' and record_id=$1)`,
      [reId],
    );
    const res = await verify(pool, reId!);
    const step12 = res.steps.find((s) => s.n === 12)!;
    expect(step12.status).toBe('fail');
    expect(step12.detail).toMatch(/predecessor batch is missing|chain broken/i);
  });
});
