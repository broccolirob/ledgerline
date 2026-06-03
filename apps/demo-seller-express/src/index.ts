// Demo x402 seller behind Circle Gateway Nanopayments, with Ledgerline raw_event capture.
// dev: pnpm dev   (-> tsx watch --env-file-if-exists=../../.env src/index.ts)
import express, { type Request, type Response, type RequestHandler } from 'express';
import { Pool } from 'pg';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { ledgerlineRecorder } from '@ledgerline/express';
import { makePostgresSink } from '@ledgerline/seller-client';
import { createReceiptIssuer, type ReceiptIssuer } from '@ledgerline/x402-receipts';

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
  // M6b (optional): sign captured events when an adapter key is configured (`pnpm adapter:keygen`).
  // Unsigned by default; recognition only ENFORCES signatures when requireAdapterSignature is set.
  const hasKey = Boolean(process.env.ADAPTER_SIGNING_KEY);
  const hasKeyId = Boolean(process.env.ADAPTER_KEY_ID);
  if (hasKey !== hasKeyId) {
    console.warn(
      '[demo-seller] only one of ADAPTER_SIGNING_KEY / ADAPTER_KEY_ID is set — signing is OFF. Set both (from `pnpm adapter:keygen`) or neither.',
    );
  }
  const signer =
    hasKey && hasKeyId
      ? { keyId: process.env.ADAPTER_KEY_ID!, privateKeyPem: process.env.ADAPTER_SIGNING_KEY! }
      : undefined;
  console.log(`[demo-seller] adapter signing ${signer ? `ENABLED (keyId=${signer.keyId})` : 'disabled'}`);
  const sink = makePostgresSink(pool, { tenantId, signer }); // throws at boot if the key is malformed

  // M6c (Path B): when a dedicated receipt-signing key is configured, ALSO issue the OFFICIAL x402
  // EIP-712 signed offer/receipt per paid call and capture them alongside the analog (approach B —
  // running parallel to Circle's createGatewayMiddleware, which still owns the 402 + settlement).
  // RECEIPT_SIGNING_KEY is a secp256k1 EOA key DISTINCT from the seller's receive address (spec
  // requirement); it only SIGNS offers/receipts and never settles. No key -> analog-only (unchanged).
  const NETWORK = 'eip155:5042002';
  let receiptIssuer: ReceiptIssuer | undefined;
  if (process.env.RECEIPT_SIGNING_KEY) {
    receiptIssuer = createReceiptIssuer({
      privateKey: process.env.RECEIPT_SIGNING_KEY as `0x${string}`, // viem validates; boot fails loudly if malformed
      network: NETWORK,
    });
    if (receiptIssuer.address.toLowerCase() === sellerAddress.toLowerCase()) {
      // Fail loudly at boot (not a warning): the x402 spec requires the offer/receipt signer to be
      // DISTINCT from payTo. Reusing the receive key to sign artifacts is a key-segregation failure.
      throw new Error(
        '[demo-seller] RECEIPT_SIGNING_KEY resolves to the seller address (payTo) — use a DISTINCT ' +
          'dedicated key (x402 spec: the offer/receipt signer MUST NOT be payTo).',
      );
    }
    console.log(`[demo-seller] official x402 offer/receipt issuance ENABLED (signer=${receiptIssuer.address})`);
  } else {
    console.log('[demo-seller] official x402 offer/receipt issuance disabled (set RECEIPT_SIGNING_KEY to enable Path B)');
  }

  app.post(
    '/api/company-brief',
    gateway.require('$0.003') as unknown as RequestHandler, // 3000 atomic USDC units
    ledgerlineRecorder({
      endpointId: 'company-brief-v1',
      schemaVersion: 'm1.1',
      payTo: sellerAddress,
      sink, // captured on res 'finish' -> writeRawEvent into Postgres
      // Path B issuance (only when RECEIPT_SIGNING_KEY is set); errors here never lose the analog.
      ...(receiptIssuer
        ? {
            issueOfficialArtifacts: async (ctx) => ({
              signedOffer: await receiptIssuer!.issueSignedOffer(ctx.resourcePath, {
                network: ctx.network,
                asset: ctx.asset,
                payTo: ctx.payTo ?? sellerAddress,
                amount: ctx.amountAtomic,
              }),
              signedReceipt: await receiptIssuer!.issueSignedReceipt(
                ctx.resourcePath,
                ctx.payer,
                ctx.network,
                ctx.settlementReference,
              ),
            }),
          }
        : {}),
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
