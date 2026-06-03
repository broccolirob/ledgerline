// adapter:keygen (M6b / T6) — generate an Ed25519 adapter signing keypair, register the PUBLIC key
// in adapter_keys for a tenant, and print the PRIVATE key once for the adapter to hold.
//   pnpm adapter:keygen   (-> tsx --env-file-if-exists=../../.env src/adapter-keygen-cli.ts)
// Only the public key is stored server-side; the private key is printed once and never persisted.
// Put it in the adapter's env as ADAPTER_SIGNING_KEY (+ ADAPTER_KEY_ID) to sign captured events.
import { Pool } from 'pg';
import { generateAdapterKeyPair } from '@ledgerline/seller-client';
import { DEMO_TENANT_ID } from './index.js';

const DEFAULT_DSN = 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';

async function main(): Promise<void> {
  const tenantId = (process.env.LEDGERLINE_TENANT_ID || undefined) ?? DEMO_TENANT_ID;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DSN });
  try {
    const { keyId, publicKeyPem, privateKeyPem } = generateAdapterKeyPair();
    const ins = await pool.query(
      `insert into adapter_keys (tenant_id, key_id, public_key) values ($1,$2,$3)
       on conflict (tenant_id, key_id) do nothing`,
      [tenantId, keyId, publicKeyPem],
    );
    if (ins.rowCount === 0) {
      // ON CONFLICT DO NOTHING hit: key_id already exists. Do NOT print the private key as trusted —
      // the registry would never verify against it. (Astronomically rare with a fresh random keypair.)
      console.error(`[adapter:keygen] key_id ${keyId} already exists for tenant ${tenantId} — nothing registered; re-run for a fresh key.`);
      process.exitCode = 1; // make the (cryptographically unreachable) collision detectable by a wrapping script
      return;
    }
    console.log(`[adapter:keygen] registered an active Ed25519 key for tenant ${tenantId}`);
    console.log(`[adapter:keygen] ADAPTER_KEY_ID=${keyId}`);
    console.log('[adapter:keygen] add the private key below to your adapter env as ADAPTER_SIGNING_KEY');
    console.log('[adapter:keygen] (printed once; only the public key is stored server-side):\n');
    console.log(privateKeyPem.trim());
    console.log('\n[adapter:keygen] to rotate: run again (a new active key). To revoke this one:');
    console.log(
      `  update adapter_keys set status='revoked', revoked_at=now() where tenant_id='${tenantId}' and key_id='${keyId}';`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
