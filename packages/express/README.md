# @ledgerline/express

The reference Ledgerline capture adapter for Express. It records one **Ledgerline receipt analog**
(Path C) per paid x402 call, after the response finishes, and hands it to a sink. It is a thin shell
over the framework-agnostic capture core in
[`@ledgerline/seller-client`](../seller-client/README.md) — that package's README documents the
**capture contract** an adapter for any other framework must satisfy.

> **Path C.** The analog is a request fingerprint + redacted payment context + delivery record. It is
> **not** an official x402 Signed Receipt (see `DECISION_LOG.md` D-0001). Never call it a "signed
> receipt." Official receipts are the M6c milestone (see `docs/M6_PLAN.md`).

## Status / packaging

These are workspace packages that export TypeScript directly (`exports: "./src/index.ts"`, run via
`tsx`, no build step) and are **not yet published to npm** (`private: true`). Today you consume them
from a checkout of this monorepo (or by vendoring the two source files). A published npm build is a
near-term follow-up; the public API below is the contract that build will expose.

## Use

Mount `ledgerlineRecorder` **after** your x402 payment middleware (so `req.payment` is set) and
**before** your handler:

```ts
import { ledgerlineRecorder } from '@ledgerline/express';
import { makePostgresSink } from '@ledgerline/seller-client';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.post(
  '/api/company-brief',
  gateway.require('$0.003'),                 // your x402 middleware — sets req.payment
  ledgerlineRecorder({
    endpointId: 'company-brief-v1',          // stable id for this route (drives the fingerprint)
    payTo: process.env.SELLER_ADDRESS,       // your receive address (not present on req.payment)
    sink: makePostgresSink(pool, { tenantId: process.env.LEDGERLINE_TENANT_ID! }),
  }),
  async (req, res) => res.json(await handler(req.body)),  // 2xx == delivered
);
```

## `ledgerlineRecorder(options)`

| Option | Type | Required | Notes |
|---|---|---|---|
| `endpointId` | `string` | yes | Stable id for the route; part of the request fingerprint. |
| `sink` | `(input: LedgerlineCaptureInput) => void \| Promise<void>` | yes | Where the analog goes: `makePostgresSink` (local) or your own POST-to-collector. |
| `payTo` | `string` | no | Seller's receive address; not on `req.payment`, so supplied here. |
| `schemaVersion` | `string` | no | Defaults to `m1.1`. |
| `routeConfigVersion` | `number` | no | Bump when the route's pricing/config changes; part of the fingerprint. |

## Guarantees

- **Captures only paid calls** — no-ops when `req.payment` is absent (free/unpaid path).
- **2xx == delivered (load-bearing).** Capture runs on `res.on('finish')` so it sees the final
  status; `delivery_status='delivered'` requires a 2xx. Non-2xx is captured as `failed` and is never
  recognized as revenue.
- **Never throws into your response path.** Sink/capture errors are logged only; the buyer's response
  is unaffected.
- **No raw secrets stored.** The payer address, resource path, and payment-authorization header are
  hashed by the capture core before storage (see the capture contract).

## Another framework?

`ledgerlineRecorder` is ~40 lines: it maps Express's `req`/`res` to a `LedgerlineCaptureInput` and
calls the sink. To support FastAPI, Hono, Fastify, Go, etc., do the same mapping for your framework and
reuse the same core. The normative shape is in
[`@ledgerline/seller-client`](../seller-client/README.md#the-capture-contract).
