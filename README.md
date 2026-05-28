# Ledgerline

Open-source seller-side toolkit for turning x402 + Circle Gateway Nanopayments into
finance-grade revenue: a drop-in adapter, a verifiable receipt/commitment pipeline, and
an on-chain audit anchor on Arc.

> **Status: Milestone 0 (pre-alpha).** This repo is the **OSS layer** — the seller adapter,
> demo apps, the canonicalization + verifier libraries, and the Arc anchor contract. The
> hosted reconciliation/dashboard platform is a separate product.

## What's here

| Path | Package | Role |
|------|---------|------|
| `packages/express` | `@ledgerline/express` | Drop-in seller adapter (M0: stub) |
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
pnpm db:migrate            # creates 3 tables: tenants, seller_endpoints, raw_events
pnpm typecheck
pnpm dev                   # seller on :4021 — curl http://localhost:4021/healthz
```

The live `402 → pay → 200` loop needs Arc Testnet wallets + testnet USDC; see `SPIKE.md`
and `.env.example`. Until `SELLER_ADDRESS` is set, the paid route is intentionally not
mounted and the seller only serves `/healthz`.

## License

Apache-2.0. The Arc anchor contract under `contracts/` is MIT. See `LICENSE`.
