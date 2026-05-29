# Ledgerline — project context for AI sessions

Public OSS repo for Ledgerline: a seller-side revenue subledger for x402 + Circle Gateway
Nanopayments, demoed on Arc Testnet. This file orients an AI session working in THIS repo.

## Two-repo topology
- **This repo (`ledgerline`, public, Apache-2.0):** the OSS layer — adapter SDK
  (`@ledgerline/express`, `@ledgerline/seller-client`), demo apps, `packages/db` schema/migrations,
  the (M4) canonicalization + verifier libs, `contracts/` (Foundry, MIT). Branch: `master`.
- **`../ledgerline-cloud` (private):** the hosted product + confidential planning docs.
  **Never copy confidential docs into this public repo.** This repo consumes the published
  `@ledgerline/*` packages; it never depends on `ledgerline-cloud`.

## Status (2026-05-29)
- **Milestone 0: complete.** Live on Arc Testnet: unpaid→402, paid→200, sub-cent `$0.003`, and each
  paid call captured as a "Ledgerline receipt analog" (`raw_events` row). See `DECISION_LOG.md` + `SPIKE.md`.
- **Receipt path (D-0001):** the demo ships on **Path C** (the analog). Official x402 Signed Receipts
  (**Path B**) are spike-proven achievable (`apps/spike-receipt/`) and are the next receipt milestone.
- **Next: Milestone 2 — revenue recognition.** Plan in `docs/M2_PLAN.md` (raw_events → revenue_events +
  double-entry ledger). Not yet implemented.

## Conventions (load-bearing)
- **No-overclaim:** never write "signed receipt" for the Path C analog; that term is reserved for the
  official x402 Path A/B artifact.
- **Integer atomic units only** for money (bigint / `numeric(78,0)`), never JS floats.
- Local Postgres is on **host port 5433** (a native Postgres already holds 5432).
- TS / Node 22, pnpm 10; internal packages export `./src/index.ts` (run via `tsx`, no build step).
- Payload hashes are **`0x`-prefixed hex** — strip the `0x` before `decode(...,'hex')` for `bytea`.
- Path B / lower-level x402: pin `@x402/core` to the version Circle's `@circle-fin/x402-batching` built
  against (a known type-skew; see `DECISION_LOG.md` D-0001).

## Key docs
- `docs/M2_PLAN.md` — the M2 implementation plan (approve, then build). Read before starting M2.
- `DECISION_LOG.md` — D-0001..D-0004 (capture path, toolchain pins, Postgres port, M0-complete).
- `SPIKE.md` — Week-1 SDK findings + the Path-B receipt spike result.
