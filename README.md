# Ledgerline

Open-source seller-side toolkit for x402 + Circle Gateway Nanopayments. The goal: turn paid
agent/API calls into finance-grade revenue — a drop-in adapter, a verifiable
receipt/commitment pipeline, and an on-chain audit anchor on Arc.

> **Status: Milestone 0 complete (pre-alpha).** The demo flow works end to end: a paid x402 call
> over Circle Gateway Nanopayments on Arc Testnet is captured into Postgres as a **Ledgerline
> receipt analog** (request fingerprint + redacted payment context + delivery). That analog is
> **not** an official x402 *signed receipt* — producing the official artifact (Path B) is
> spike-proven achievable and is the next receipt milestone (see `DECISION_LOG.md` D-0001).
> Canonicalization is still an M0 placeholder, and the split engine, double-entry ledger,
> verifier, and Arc anchor are **planned, not yet built**. The hosted reconciliation/dashboard
> platform is a separate product.

## What's here

| Path | Package | Role |
|------|---------|------|
| `packages/express` | `@ledgerline/express` | Drop-in seller adapter — captures the receipt analog on response finish (M1) |
| `packages/seller-client` | `@ledgerline/seller-client` | Raw-event write path + split helper |
| `packages/db` | `@ledgerline/db` | Local event-store schema + migration |
| `apps/demo-seller-express` | — | Example x402 seller behind Circle Gateway Nanopayments |
| `apps/demo-buyer` | — | Example buyer paying over Arc Testnet |
| `contracts/` | — | `RevenueBatchAnchor` Arc anchor contract (M4, Foundry, MIT) |
| `infra/` | — | Local Postgres 16 via Docker Compose |

## Quickstart (credential-free)

Requires **Node 22+**, **pnpm 10**, **Docker**.

```zsh
pnpm install
pnpm db:up                 # first run pulls postgres:16 (~1 min+)
cp .env.example .env
pnpm db:migrate            # waits for Postgres ("waiting for postgres..." on a cold start is normal),
                           # then creates 3 tables: tenants, seller_endpoints, raw_events
pnpm typecheck
pnpm dev                   # seller on :4021 — curl http://localhost:4021/healthz
pnpm dev:buyer             # prints a friendly "blocked on Track A" message and exits (credential-free)
```

The live `402 → pay → 200` loop needs Arc Testnet wallets + testnet USDC; see `SPIKE.md`
and `.env.example`. Until `SELLER_ADDRESS` is set, the paid route is intentionally not
mounted and the seller only serves `/healthz`.

## License

Apache-2.0. The Arc anchor contract under `contracts/` is MIT. See `LICENSE`.
