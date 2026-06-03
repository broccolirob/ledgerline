// Recognition pass CLI: select un-recognized receipt analogs and post them.
// Run: pnpm recognize   (-> tsx --env-file-if-exists=../../.env src/recognize-cli.ts)
// Subledger, not middleware: this runs OFF the response path, over already-persisted raw_events.
import { Pool } from 'pg';
import { resolveDemoConfig, runRecognitionPass, DEMO_TENANT_ID } from './index.js';

const DEFAULT_DSN = 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DSN });
  try {
    const tenantId = (process.env.LEDGERLINE_TENANT_ID || undefined) ?? DEMO_TENANT_ID;
    // M6b/T6: opt in to adapter-signature enforcement without a code edit. When ADAPTER_REQUIRE_SIGNATURE=true,
    // unsigned/forged/unknown-key/revoked events are rejected (no revenue); keys come from adapter_keys.
    const cfg = {
      ...(await resolveDemoConfig(pool, tenantId)),
      requireAdapterSignature: process.env.ADAPTER_REQUIRE_SIGNATURE === 'true',
    };
    const summary = await runRecognitionPass(pool, cfg);
    console.log('[recognize] summary:', JSON.stringify(summary, null, 2));
    if (summary.errors.length > 0) {
      console.error(`[recognize] ${summary.errors.length} event(s) errored — see summary.errors`);
      process.exitCode = 1;
    }
    // T6 enforcement: rejected-unsigned events are NOT "errors", so they wouldn't otherwise surface in
    // the exit code — a cron/CI job (and the operator) would read exit 0 = success even though every
    // event was dropped with no revenue. Signal it with a DISTINCT non-zero code (2), keeping true
    // errors (1) distinguishable from policy rejections.
    if (cfg.requireAdapterSignature && summary.rejectedUnsigned > 0) {
      console.error(
        `[recognize] ${summary.rejectedUnsigned} event(s) REJECTED for adapter-signature failure — no revenue recognized for them (enforcement is ON)`,
      );
      if (process.exitCode !== 1) process.exitCode = 2;
    }
  } finally {
    await pool.end();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
