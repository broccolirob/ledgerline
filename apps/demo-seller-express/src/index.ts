// Demo x402 seller behind Circle Gateway Nanopayments.
// dev: pnpm dev   (-> tsx watch --env-file-if-exists=../../.env src/index.ts)
import express, { type Request, type Response, type RequestHandler } from 'express';
import { createGatewayMiddleware, type PaymentRequest } from '@circle-fin/x402-batching/server';
import { ledgerlineRecorder } from '@ledgerline/express';

const app = express();
app.use(express.json());

// Always-on, credential-free liveness probe (Track B runs this with no creds).
app.get('/healthz', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// ---- CREDENTIAL BOUNDARY ----------------------------------------------------
// SELLER_ADDRESS is supplied by Track A. Until it lands, the paid route is NOT mounted,
// so the server still boots and /healthz responds. The moment SELLER_ADDRESS is set in
// .env, the paid loop comes up with no code change.
//
// IMPORTANT: because the route mounts only when SELLER_ADDRESS is set, the
// "unpaid request -> 402" acceptance check is ALSO Track-A-gated. With no SELLER_ADDRESS,
// POST /api/company-brief is absent and returns 404, NOT 402.
const sellerAddress = process.env.SELLER_ADDRESS;

if (!sellerAddress) {
  console.warn(
    '[demo-seller] SELLER_ADDRESS not set — paid route NOT mounted. Track B is healthy; ' +
      'the live loop is blocked on Track A. /healthz still works; POST /api/company-brief -> 404.',
  );
} else {
  const gateway = createGatewayMiddleware({
    sellerAddress,
    // The SDK defaults facilitatorUrl to MAINNET; pass the testnet URL explicitly.
    // (Confirmed in dist/server/index.d.mts.) Verify against current Circle docs.
    facilitatorUrl: process.env.FACILITATOR_URL ?? 'https://gateway-api-testnet.circle.com',
    networks: ['eip155:5042002'], // Arc Testnet CAIP-2 (chain id 5042002) — SELLER side only
  });

  // gateway.require() returns the SDK's MiddlewareFunction (http-based req/res). It is
  // runtime-compatible with Express; cast to RequestHandler so the static types line up.
  app.post(
    '/api/company-brief',
    gateway.require('$0.003') as unknown as RequestHandler, // 3000 atomic USDC units
    ledgerlineRecorder({ tenantId: process.env.LEDGERLINE_TENANT_ID, schemaVersion: 'm0.1' }),
    (req: Request, res: Response) => {
      // CONFIRMED req.payment shape: { verified, payer, amount, network, transaction? }.
      // No Payment-Identifier and no signed offer/receipt are surfaced — so the raw_event
      // idempotency key must be a Ledgerline receipt analog (request fingerprint + settlement
      // context), per DECISION_LOG D-0001 (Path C). Capture wiring is deferred until the
      // capture-path spike lands; for M0 we return the canned brief.
      const payment = (req as unknown as PaymentRequest).payment;
      void payment; // -> writeRawEvent(...) from @ledgerline/seller-client once Path C is wired

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
