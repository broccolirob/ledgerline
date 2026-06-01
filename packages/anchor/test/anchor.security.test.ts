// M5 security tests (§19) — anchor layer. Cross-tenant isolation (T11) + raw-metadata-not-in-leaf (T9).
// Reuses the throwaway-DB harness. These assert defenses the architecture ACTUALLY enforces.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  buildBatch,
  verify,
  generateVerifierPackage,
  resolveTenantCommitment,
} from '@ledgerline/anchor';
import { buildRawEventFromCapture, writeRawEvent } from '@ledgerline/seller-client';
import { runRecognitionPass, resolveDemoConfig } from '@ledgerline/recognition';
import { revenueEventLeaf, ledgerEntryLeaf, lcjString, toHex } from '@ledgerline/canonical';
import { setupDatabase, dropDatabase, seedRecognized, TENANT } from './helpers';

const TEST_DB = 'ledgerline_sec_anchor';
const TENANT_B = '00000000-0000-4000-8000-0000000000ff';

let pool: Pool;

/** Clone the demo pricing_model + split_group + split_rules under another tenant, with a distinct
 *  salt, then recognize one paid analog for it. Returns B's revenue_event id. Mirrors what 0004 +
 *  seedRecognized do for the demo tenant, but for an arbitrary tenant — so we can prove A↮B isolation
 *  with BOTH tenants actually populated (not one empty). */
async function seedTenant(tenantId: string, slug: string, saltHex: string, settle: string): Promise<string> {
  await pool.query(
    `insert into tenants (id, name, slug, tenant_commitment_salt) values ($1,$2,$3,decode($4,'hex'))
     on conflict (id) do nothing`,
    [tenantId, slug, slug, saltHex],
  );
  // clone pricing_models / split_groups / split_rules from the demo tenant under the new tenant
  const pmId = randomUUID();
  await pool.query(
    `insert into pricing_models (id, tenant_id, name, version, pricing_type, asset, fixed_amount_atomic, active)
     select $1,$2,name,version,pricing_type,asset,fixed_amount_atomic,active from pricing_models
      where tenant_id=$3 and name='company-brief-exact' and version=1`,
    [pmId, tenantId, TENANT],
  );
  const sgId = randomUUID();
  await pool.query(
    `insert into split_groups (id, tenant_id, name, version, revenue_treatment, reserve_treatment, effective_from, active)
     select $1,$2,name,version,revenue_treatment,reserve_treatment,effective_from,active from split_groups
      where tenant_id=$3 and name='company-brief-default' and version=1`,
    [sgId, tenantId, TENANT],
  );
  await pool.query(
    `insert into split_rules (id, tenant_id, split_group_id, recipient_id, role, percentage_bps, priority)
     select gen_random_uuid(),$1,$2,recipient_id,role,percentage_bps,priority from split_rules
      where tenant_id=$3 and split_group_id=(select id from split_groups where tenant_id=$3 and name='company-brief-default' and version=1)`,
    [tenantId, sgId, TENANT],
  );
  const ev = buildRawEventFromCapture(tenantId, {
    endpointId: 'company-brief-v1', schemaVersion: 'm1.1', method: 'POST', resourcePath: '/api/company-brief',
    payment: { verified: true, payer: '0x' + 'b'.repeat(40), amountAtomic: '3000', network: 'eip155:5042002', asset: 'USDC', payTo: '0xseller', settlementReference: settle, paymentSignatureHeader: `hdr-${settle}` },
    delivery: { status: 'delivered', httpStatus: 200, latencyMs: 1 },
    occurredAt: new Date('2026-05-29T01:15:27.611Z'),
  });
  await writeRawEvent(pool, ev);
  const cfg = await resolveDemoConfig(pool, tenantId);
  const summary = await runRecognitionPass(pool, cfg);
  if (summary.recognized < 1) throw new Error(`seedTenant: ${tenantId} recognized ${summary.recognized}`);
  const re = await pool.query<{ id: string }>(`select id from revenue_events where tenant_id=$1 order by created_at limit 1`, [tenantId]);
  return re.rows[0]!.id;
}

beforeAll(async () => {
  pool = await setupDatabase(TEST_DB);
}, 60_000);

afterAll(async () => {
  await dropDatabase(pool, TEST_DB);
});

describe('T11 — cross-tenant isolation (BOTH tenants populated — non-vacuous)', () => {
  it("tenant A's batch contains ONLY A's leaves; tenant B's batch contains ONLY B's — no bleed either way", async () => {
    const reA = (await seedRecognized(pool, 1))[0]!; // demo tenant A
    // 32-byte salt (64 hex chars) = ascii 'tenant-b-salt-v1-padding-to-32by'
    const reB = await seedTenant(TENANT_B, 'tenant-b', '74656e616e742d622d73616c742d76312d70616464696e672d746f2d33326279', 'B-settle-1');

    const buildA = await buildBatch(pool, TENANT);
    expect(buildA.built).toBe(true);
    const buildB = await buildBatch(pool, TENANT_B);
    expect(buildB.built).toBe(true);

    // A's batch leaves must ALL be A-owned revenue_events/ledger_entries — and crucially must NOT
    // contain B's revenue_event. (This WOULD fail if buildBatch dropped its `where tenant_id=$1`.)
    const aBatchId = (await pool.query<{ cb: string }>(
      `select commitment_batch_id cb from batch_leaves where record_type='revenue_event' and record_id=$1`, [reA],
    )).rows[0]!.cb;
    const aHasB = await pool.query<{ c: string }>(
      `select count(*) c from batch_leaves where commitment_batch_id=$1 and record_id=$2`, [aBatchId, reB],
    );
    expect(aHasB.rows[0]!.c).toBe('0'); // A's batch does NOT contain B's revenue_event
    const aForeignTenant = await pool.query<{ c: string }>(
      `select count(*) c from batch_leaves where commitment_batch_id=$1 and tenant_id<>$2`, [aBatchId, TENANT],
    );
    expect(aForeignTenant.rows[0]!.c).toBe('0');

    // Symmetric: B's batch contains B's revenue_event and none of A's.
    const bBatchId = (await pool.query<{ cb: string }>(
      `select commitment_batch_id cb from batch_leaves where record_type='revenue_event' and record_id=$1`, [reB],
    )).rows[0]!.cb;
    expect(bBatchId).not.toBe(aBatchId); // distinct batches
    const bHasA = await pool.query<{ c: string }>(
      `select count(*) c from batch_leaves where commitment_batch_id=$1 and record_id=$2`, [bBatchId, reA],
    );
    expect(bHasA.rows[0]!.c).toBe('0');

    // Every batch_leaves row references a revenue_event/ledger_entry of its OWN tenant (no cross-FK).
    const crossFk = await pool.query<{ c: string }>(
      `select count(*) c from batch_leaves bl
        where bl.record_type='revenue_event'
          and not exists (select 1 from revenue_events re where re.id=bl.record_id and re.tenant_id=bl.tenant_id)`,
    );
    expect(crossFk.rows[0]!.c).toBe('0');

    // verify() is tenant-bound through the revenue_event's own tenant — both pass independently.
    expect((await verify(pool, reA)).pass).toBe(true);
    expect((await verify(pool, reB)).pass).toBe(true);
  });

  it("A and B derive DISTINCT tenant_commitments (salted per tenant) — roots are not cross-replayable", async () => {
    const tcA = toHex((await resolveTenantCommitment(pool, TENANT)).tcBytes);
    const tcB = toHex((await resolveTenantCommitment(pool, TENANT_B)).tcBytes);
    expect(tcA).not.toBe(tcB);
  });
});

describe('T9 — committed leaves expose ONLY the closed key set (no metadata channel)', () => {
  it('leaf builders emit exactly their closed schema keys — no field could carry memo/URL/customer id', async () => {
    const tc = toHex((await resolveTenantCommitment(pool, TENANT)).tcBytes);
    // The real defense is the CLOSED schema: a leaf has a fixed key set, so there is no free-form
    // field a URL/customer-id/memo could ride in on. Assert the key set EXACTLY (this fails if the
    // schema is ever widened to admit a sensitive field).
    const ledger = ledgerEntryLeaf({
      id: 'le-x', tenantCommitmentHex: tc, journalTransactionId: 'jt-x', txnType: 'recognition',
      revenueTreatment: 'principal_gross', accountType: 'payable', ownerType: 'supplier',
      ownerId: '00000000-0000-4000-8000-0000000000c2', direction: 'credit', amountAtomic: '600',
      asset: 'USDC', effectiveAt: new Date('2026-05-29T00:00:00.000Z'),
    });
    expect(Object.keys(ledger).sort()).toEqual(
      ['account_type', 'amount_atomic', 'asset', 'direction', 'effective_at_ms', 'id', 'journal_transaction_id', 'owner_id', 'owner_type', 'revenue_treatment', 'schema_version', 'tenant_commitment', 'txn_type'].sort(),
    );
    // none of the §12 never-commit field names appear as keys
    for (const banned of ['memo', 'account_name', 'units', 'resource', 'customer', 'payer']) {
      expect(Object.keys(ledger)).not.toContain(banned);
    }

    const re = revenueEventLeaf({
      id: 're-x', tenantCommitmentHex: tc, interactionId: 'ix-x', revenueSource: 'x402_purchase',
      grossAmountAtomic: '3000', asset: 'USDC', network: 'eip155:5042002', revenueStatus: 'earned',
      earnedAt: new Date('2026-05-29T00:00:00.000Z'),
    });
    expect(Object.keys(re).sort()).toEqual(
      ['asset', 'earned_at_ms', 'gross_amount_atomic', 'id', 'interaction_id', 'network', 'revenue_source', 'revenue_status', 'schema_version', 'tenant_commitment'].sort(),
    );
    // and the serialized bytes are case-insensitively free of a URL scheme (guards an uppercase leak too)
    expect(lcjString(re).toLowerCase()).not.toContain('http');
    expect(lcjString(re).toLowerCase()).not.toContain('/api/');
  });

  it('the generated verifier package commits only the leaf — disclosed records are separate, never hashed into the root', async () => {
    const reId = (await pool.query<{ id: string }>(`select id from revenue_events where tenant_id=$1 limit 1`, [TENANT])).rows[0]!.id;
    const pkg = await generateVerifierPackage(pool, reId);
    // batch metadata exposes only hashes (0x...), never raw URLs/names.
    const batchJson = JSON.stringify(pkg.batch);
    expect(batchJson).not.toContain('http');
    expect(batchJson).not.toContain('/api/');
    expect(pkg.batch.merkle_root).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
