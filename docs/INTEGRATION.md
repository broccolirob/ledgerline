# Integrating Ledgerline into your x402 seller

Goal: from a working x402 seller, start capturing finance-grade revenue records in under a day. The
flow is **capture → recognize → build → verify**. Capture is a drop-in middleware (Express today);
the rest is a local pass over Postgres you run on your own cadence.

> **Scope: Path C.** This is the **Ledgerline receipt analog** (request fingerprint + redacted payment
> context + delivery record). It is not an official x402 Signed Receipt — that is the M6c milestone
> (see `docs/M6_PLAN.md`, `DECISION_LOG.md` D-0001). This guide is the open-source, self-run path;
> adapter-event signing + local verification are available (M6b — see *Sign your events*), while hosted
> ingestion, API keys, and the operated key registry are commercial / M7 (see `COMMERCIAL_BOUNDARY.md`).

## 0. Prerequisites & install

- Node 22+, pnpm 10, Docker (Postgres 16 via `pnpm db:up`), and your x402 seller (Express +
  Circle `createGatewayMiddleware`, or any middleware that sets `req.payment`).

**Getting the packages.** `@ledgerline/express` and `@ledgerline/seller-client` are workspace packages
that export TypeScript directly and are **not yet published to npm** (`private: true`, no build step —
run via `tsx`). Until they're published, integrate one of two ways:

- **In-repo (fastest to evaluate):** clone this monorepo, add your route to `apps/demo-seller-express`
  (or a new app), and run via the repo's `tsx` setup. This is the "fresh checkout" path the rest of
  this guide assumes.
- **Vendor:** copy `packages/seller-client/src/index.ts` (the framework-agnostic core) and, for
  Express, `packages/express/src/index.ts` into your project. The public API is small and stable.

A published npm build is a near-term follow-up; the APIs below are the contract it will expose.

**Schema + tenant.** `pnpm db:migrate` creates the schema (tenants, raw_events, revenue/ledger tables,
commitment_batches). The demo tenant `00000000-0000-4000-8000-000000000001` is seeded by migration
0002; for your own tenant, insert a `tenants` row + a `pricing_models` (exact) +
`split_groups`/`split_rules` (use `0004_seed_demo_pricing_split.sql` as the template).

## 1. Capture — mount the recorder after your payment middleware

`@ledgerline/express` `ledgerlineRecorder` runs on response finish, builds the receipt analog from
`req.payment` + the request + the delivery outcome, and hands it to a **sink**. It never throws into
your response path and only captures when `req.payment` is set (paid calls).

```ts
import express from 'express';
import { createGatewayMiddleware } from '@circle-fin/x402-batching/server';
import { ledgerlineRecorder } from '@ledgerline/express';
import { makePostgresSink } from '@ledgerline/seller-client';
import { Pool } from 'pg';

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TENANT_ID = process.env.LEDGERLINE_TENANT_ID!; // your tenants.id

const gateway = createGatewayMiddleware({ sellerAddress: process.env.SELLER_ADDRESS!, networks: ['eip155:5042002'] });

app.post(
  '/api/company-brief',
  gateway.require('$0.003'),                 // your x402 payment middleware (sets req.payment)
  ledgerlineRecorder({
    endpointId: 'company-brief-v1',          // stable id for this route (drives the fingerprint)
    payTo: process.env.SELLER_ADDRESS,       // your receive address (not on req.payment)
    sink: makePostgresSink(pool, { tenantId: TENANT_ID }),  // writes one raw_events row per paid call
  }),
  async (req, res) => res.json(await buildBrief(req.body)),  // your handler — 2xx = delivered
);
```

**What it writes:** one `raw_events` row per paid, delivered call — a redacted analog (hashes only).
The **load-bearing invariant**: `delivery_status='delivered'` requires a 2xx final status; non-2xx
flows to the failure path and is never recognized as revenue. Sensitive fields (payer, resource path,
the payment-authorization header) are hashed before storage — raw values never hit public columns. The
exact row shape and the hashing/fingerprint/idempotency rules are the **capture contract** documented
in [`@ledgerline/seller-client`](../packages/seller-client/README.md#the-capture-contract).

For a hosted setup, swap `makePostgresSink` for your own sink `(input) => Promise<void>` that POSTs the
built event to your collector.

## 1b. Other frameworks (not Express)

The capture core is framework-agnostic. To integrate FastAPI, Hono, Fastify, Go, etc., map your
framework's request/response to a `LedgerlineCaptureInput` and persist it with `makePostgresSink` (or
your own sink) — that is the whole adapter. `@ledgerline/express` is the ~40-line reference. See the
[capture contract](../packages/seller-client/README.md#the-capture-contract). (Note: x402 has native
Python/Go servers, but Circle Gateway Nanopayments is JS-first today — a native non-JS Circle path is
unproven; an event-emitter or sidecar may be the faster route.)

## 1c. Sign your events (optional — M6b, closes T6)

Authenticate the capturing adapter so forged events can't become revenue. Run `pnpm adapter:keygen`
to generate an Ed25519 key (it registers the public key in `adapter_keys` and prints the private key
for your env), then pass a `signer` to the sink:

```ts
const sink = makePostgresSink(pool, {
  tenantId: TENANT_ID,
  signer: { keyId: process.env.ADAPTER_KEY_ID!, privateKeyPem: process.env.ADAPTER_SIGNING_KEY! },
});
```

Then run recognition with `requireAdapterSignature: true` (e.g. `{ ...cfg, requireAdapterSignature: true }`):
unsigned, tampered, unknown-key, and revoked-key events are rejected with no revenue. Default (off)
leaves existing unsigned captures working. Rotate by re-running keygen; revoke with the SQL the CLI
prints. The operated registry/rotation service is the M7 layer.

## 2. Recognize — `raw_events` → revenue + double-entry ledger

Run the recognition pass (a CLI, or call `runRecognitionPass` directly). It is idempotent and
replay-safe — run it after each call, on a timer, or in a worker.

```zsh
pnpm recognize          # recognizes un-recognized receipt analogs for the demo tenant
```

Each delivered+verified analog becomes an `earned` `revenue_event` + a balanced `journal_transaction`
(`recognition`, `principal_gross`) with its `ledger_entries` (the 4-way split: publisher / model /
data / referrer; ΣDr = ΣCr). Failed/unverified analogs get a failure record, no revenue.

```ts
import { resolveDemoConfig, runRecognitionPass } from '@ledgerline/recognition';
const cfg = await resolveDemoConfig(pool, TENANT_ID);     // resolves your pricing + split group
const summary = await runRecognitionPass(pool, cfg);      // { recognized, replayed, f1Skipped, errors }
```

## 3. Build + commit — Merkle batch root to Arc

```zsh
pnpm anchor:build       # canonical leaves → keccak Merkle root → commitment_batches (status 'built')
pnpm anchor:submit      # commitBatch on Arc Testnet (needs ARC_RPC_URL + ANCHOR_COMMITTER_KEY + ANCHOR_CONTRACT_ADDRESS)
```

`anchor:build` is credential-free and always runnable; `anchor:submit` needs the Track-A anchor creds
(deploy `contracts/RevenueBatchAnchor.sol` first — see `contracts/README.md`). Without creds,
`anchor:submit` prints "blocked on Track A" and exits 0.

## 4. Verify + export

```zsh
pnpm verify                       # offline: 14-step checklist, DB-consistent (PASS with "run --onchain" qualifier)
pnpm verify --onchain             # reads the on-chain batch root + tx finality
pnpm export:csv                   # revenue_events.csv + ledger_entries.csv (finance-ready)
```

The verifier re-derives every leaf from source, recomputes the Merkle root + batch_id, and checks the
tie-outs, the previous-root chain, and (with `--onchain`) inclusion in the committed Arc root. The
generated verifier package is a self-contained bundle a third party can check independently. (Under
Path C, verifier steps 1–3 are scoped to the receipt analog; M6c turns them into official-receipt
checks.)

## End-to-end, one command

`pnpm demo` runs all of the above in sequence with narration — the fastest way to see the whole
lifecycle on the demo tenant. Start there, then wire the recorder into your own route.

## Conventions you must follow

- **Integer atomic units only** for money (no JS floats). `numeric(78,0)` columns; parse as `bigint`.
- **Payload hashes are `0x`-prefixed hex.** The recognition layer strips `0x` before `bytea` binds.
- **No-overclaim:** never call the Path-C analog a "signed receipt" in your copy.
- Local Postgres is on **host port 5433** (avoids clashing with a native 5432).
