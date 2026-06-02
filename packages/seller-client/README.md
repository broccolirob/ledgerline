# @ledgerline/seller-client

The **framework-agnostic capture core** for Ledgerline. It turns one paid x402 call into a normalized,
privacy-safe `raw_events` row — the input to the recognition → ledger → Arc-anchor → verify pipeline.
Framework adapters such as [`@ledgerline/express`](../express/README.md) are thin shells over this
core.

> **Path C.** This produces the **Ledgerline receipt analog** (request fingerprint + redacted payment
> context + delivery record), **not** an official x402 Signed Receipt (`DECISION_LOG.md` D-0001).

## Status / packaging

Workspace package, exports TypeScript directly (`exports: "./src/index.ts"`, run via `tsx`, no build
step), **not yet published to npm** (`private: true`). Consume from a checkout of this monorepo for
now.

## The capture contract

To support any framework, do exactly two things: **(1)** map your request/response to a
`LedgerlineCaptureInput`, **(2)** write it with `makePostgresSink` (local) or your own sink. That is
the entire adapter.

### 1. Build a `LedgerlineCaptureInput`

| Field | Type | Notes |
|---|---|---|
| `endpointId` | `string` | Stable id for the route; part of the fingerprint. |
| `schemaVersion` | `string` | e.g. `m1.1`. |
| `method` | `string` | HTTP method. |
| `resourcePath` | `string` | Route path; **hashed** before storage (never stored raw). |
| `routeConfigVersion` | `number?` | Bump on pricing/config change; part of the fingerprint. |
| `payment.verified` | `boolean` | From the payment middleware. |
| `payment.payer` | `string` | Raw buyer address — **hashed** before storage. |
| `payment.amountAtomic` | `string` | Integer atomic units (no floats). |
| `payment.network` | `string` | e.g. `eip155:5042002`. |
| `payment.asset` | `string?` | Defaults to `USDC`. |
| `payment.payTo` | `string?` | Seller's own receive address. |
| `payment.settlementReference` | `string?` | Opaque Gateway transfer id (`req.payment.transaction`). |
| `payment.paymentSignatureHeader` | `string?` | Raw `payment-signature` header — **hashed** before storage. |
| `delivery.status` | `'delivered' \| 'failed' \| 'canceled'` | `delivered` requires a 2xx final status. |
| `delivery.httpStatus` | `number` | The final response status. |
| `delivery.latencyMs` | `number?` | Optional. |
| `delivery.responseBodyHash` | `string?` | Optional. |
| `occurredAt` | `Date` | Capture time. |

### 2. Persist it

```ts
import { makePostgresSink } from '@ledgerline/seller-client';
const sink = makePostgresSink(pool, { tenantId });
await sink(input); // = writeRawEvent(db, buildRawEventFromCapture(tenantId, input))
```

Or call the two primitives directly (e.g. to POST to your own collector instead of Postgres):

```ts
import { buildRawEventFromCapture, writeRawEvent } from '@ledgerline/seller-client';
const ev = buildRawEventFromCapture(tenantId, input);
await writeRawEvent(db, ev); // or: await fetch(myCollector, { method: 'POST', body: JSON.stringify(ev) })
```

### What `buildRawEventFromCapture` does (so adapters don't have to)

- Computes the **request fingerprint** over tenant + endpoint + method + resource + scheme + network +
  asset + amount + payTo + routeConfigVersion. Drives replay/idempotency binding (§8).
- **Hashes sensitive fields** (§9): `payerHash = sha256(payer.toLowerCase())`,
  `resourceHash = sha256(resourcePath)`, `paymentSignatureHash = sha256(payment-signature header)`.
  The raw payer / resource / header are never stored.
- Derives the **idempotency key** `ledgerline-receipt-analog:v1:<anchor>`, where
  `anchor = settlementReference ?? paymentSignatureHash ?? fingerprint`. The table's
  `unique(tenant_id, idempotency_key)` + `ON CONFLICT DO NOTHING` makes re-capture a no-op.
- Stamps `eventType='ledgerline.receipt_analog.v1'`, `eventSource='seller_sdk'`.

### The `raw_events` row it writes

| column | value |
|---|---|
| `id` | random UUID |
| `tenant_id` | your tenant |
| `event_type` | `ledgerline.receipt_analog.v1` |
| `event_source` | `seller_sdk` |
| `idempotency_key` | `ledgerline-receipt-analog:v1:<anchor>` |
| `occurred_at` | capture time |
| `canonical_hash` | `canonicalHash(payload_redacted)` (see the hashing-layers note below) |
| `payload_redacted` | the redacted analog — hashes only; no raw payer/resource/header |
| `adapter_key_id` / `adapter_signature` | **null today** — adapter-event signing is M6b (closes T6) |
| `schema_version` | e.g. `m1.1` |

### Hashing layers — do not conflate

`canonicalHash` here is an **M0 placeholder** serializer (sha256 over recursively-sorted-key JSON) used
for the `raw_events` integrity hash. It is **not** the committed-leaf hash. The committed Arc leaves
use [`@ledgerline/canonical`](../canonical) (LCJ v1 + keccak256), a separate, **frozen** format. Keep
the two distinct: the capture hash binds the raw event; the canonical leaf hash binds what goes
on-chain.

## Exports

- Types: `LedgerlineCaptureInput`, `RawEventInput`, `RequestFingerprintInput`, `Db`
- Capture: `buildRawEventFromCapture(tenantId, input)`, `writeRawEvent(db, ev)`,
  `makePostgresSink(db, { tenantId })`
- Primitives: `computeRequestFingerprint(input)`, `canonicalHash(payload)`
- M0 demo helper: `allocateOneSplit(amountAtomic)` (illustrative; the real split engine is in
  `@ledgerline/recognition`)
