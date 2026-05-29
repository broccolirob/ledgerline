// Demo x402 seller behind Circle Gateway Nanopayments, with Ledgerline raw_event capture.
// dev: pnpm dev   (-> tsx watch --env-file-if-exists=../../.env src/index.ts)
import express, { type Request, type Response, type RequestHandler } from 'express';
import { Pool } from 'pg';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { ledgerlineRecorder } from '@ledgerline/express';
import { makePostgresSink } from '@ledgerline/seller-client';

const DEFAULT_DSN = 'postgresql://ledgerline:ledgerline@localhost:5433/ledgerline';
// Demo tenant, seeded by migration 0002. The raw_events FK -> tenants requires this row to exist.
const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const app = express();
app.use(express.json());

// Always-on, credential-free liveness probe (Track B runs this with no creds).
app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ---- CREDENTIAL BOUNDARY ----------------------------------------------------
// SELLER_ADDRESS is supplied by Track A. Until it lands, the paid route is NOT mounted, so the
// server still boots and /healthz responds. With no SELLER_ADDRESS, POST /api/company-brief is
// absent and returns 404 (not 402).
const sellerAddress = process.env.SELLER_ADDRESS;

if (!sellerAddress) {
  console.warn(
    '[demo-seller] SELLER_ADDRESS not set — paid route NOT mounted. Track B is healthy; ' +
      'the live loop is blocked on Track A. /healthz still works; POST /api/company-brief -> 404.',
  );
} else {
  const gateway = createGatewayMiddleware({
    sellerAddress,
    facilitatorUrl: process.env.FACILITATOR_URL ?? 'https://gateway-api-testnet.circle.com',
    networks: ['eip155:5042002'], // Arc Testnet CAIP-2 (chain id 5042002) — SELLER side only
  });

  // Local Postgres sink: each delivered paid call writes ONE raw_event (the Ledgerline receipt
  // analog). The pool is lazy — it only connects on the first capture.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_DSN });
  const tenantId = process.env.LEDGERLINE_TENANT_ID ?? DEMO_TENANT_ID;
  const sink = makePostgresSink(pool, { tenantId });

  app.post(
    '/api/company-brief',
    gateway.require('$0.003') as unknown as RequestHandler, // 3000 atomic USDC units
    ledgerlineRecorder({
      endpointId: 'company-brief-v1',
      schemaVersion: 'm1.1',
      payTo: sellerAddress,
      sink, // captured on res 'finish' -> writeRawEvent into Postgres
    }),
    (_req: Request, res: Response) => {
      // Canned output for M0/M1. The recorder captures the paid-delivery analog on finish.
      res.json({
        company: 'Acme Corp',
        brief: 'Canned M0 company brief. Real generation is deferred past Milestone 0.',
        generatedAt: new Date().toISOString(),
      });
    },
  );
}

const port = Number(process.env.PORT ?? 4021);
app.listen(port, () => {
  console.log(`demo-seller-express listening on :${port}`);
});
