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

## Status (2026-06-03)
- **Milestone 0: complete.** Live on Arc Testnet: unpaid→402, paid→200, sub-cent `$0.003`, and each
  paid call captured as a "Ledgerline receipt analog" (`raw_events` row). See `DECISION_LOG.md` + `SPIKE.md`.
- **Milestone 2: complete.** `@ledgerline/recognition` turns delivered+verified paid `raw_events` into
  `earned` `revenue_events` + balanced double-entry `journal_transactions`/`ledger_entries`
  (principal_gross R1′; 3000→2100/600/210/90). Migrations 0003/0004; CSV export + balance audit. Plan: `docs/M2_PLAN.md`.
- **Milestone 4: complete and LIVE on Arc Testnet.** `@ledgerline/canonical`
  (LCJ v1 + keccak256 + RFC-9162 Merkle + §17.5 vectors), `@ledgerline/anchor` (batch builder enforcing
  Invariant 11; the 14-step Path-C verifier + verifier-package generator), migration 0005
  (`commitment_batches` + `batch_leaves` + salted `tenant_commitment`), and
  `contracts/RevenueBatchAnchor.sol` (Foundry). `RevenueBatchAnchor` deployed at
  `0x3Bd5966789CA3F00ecB25D262099c9DDE0e90EC4` (chain 5042002); batch #1 committed via tx
  `0x7ee7c6a7…06233a`; `pnpm verify --onchain` → PASS all 14 steps (D-0010). Offline `pnpm verify` still
  passes with an honest "run --onchain" qualifier. Plan: `docs/M4_PLAN.md`.
- **Milestone 5: complete (grant-ready).** `pnpm demo` runs the §21 nine-step sequence end to end
  (narrated, idempotent, capability-banner); `docs/THREAT_MODEL.md` maps T1–T16 to honest status; a
  security suite (`pnpm test:security`) covers T1/T8/T9/T11/T16 (T6 was a negative test at M5 — closed
  in M6b); `README` + `docs/INTEGRATION.md` + `docs/DEMO.md` round it out. LEAN scope. Plan:
  `docs/M5_PLAN.md` (D-0011).
- **Milestone 6: complete (merged via PR #1, 2026-06-03).** M6a: framework-clean adapter +
  `docs/INTEGRATION.md` + `COMMERCIAL_BOUNDARY.md` (Apache-2.0 declared). M6b: adapter-event signing
  closes T6 — `@ledgerline/seller-client` Ed25519 `signRawEvent`/`verifyRawEventSignature` + per-tenant
  `adapter_keys` registry (migration 0006) + a recognition verify gate (`rejected_unsigned`); T6 is now
  a positive control. M6c: `@ledgerline/x402-receipts` issues + verifies the OFFICIAL x402 EIP-712
  Signed Offer/Receipt (Path B, approach B — alongside Circle's middleware), migration 0007
  (`artifact_json` + `artifact_type` CHECK), verifier steps 1–3 re-verify the official artifact (else
  honest Path-C `na`). Security suite now 45 tests. Two review passes (`/review` + ultrareview) hardened
  verifier authenticity. Plan: `docs/M6_PLAN.md`; decisions D-0012.
- **Receipt path (D-0001/D-0012):** the **default** demo run ships on **Path C** (the analog). **M6c
  implements Path B** — official x402 EIP-712 Signed Offers/Receipts, issued + verified, opt-in via
  `RECEIPT_SIGNING_KEY` and run alongside Circle's middleware. Still NOT live-proven (the real
  payment→receipt loop is Track-A-gated) and NOT identity-pinned (signer-registry pinning deferred to M7).
- **Next candidates (M7+, mostly private/commercial — see `COMMERCIAL_BOUNDARY.md`):** hosted ingestion
  API + API-key management; the §9 at-rest encryption (operated KMS) + receipt-signer registry pinning;
  the M8 moat wedge. Per the `~/Projects/arc/` roadmap these are demand-gated (a committed design
  partner), not more public-repo code.

## M4 anchor/canonical conventions (load-bearing)
- **keccak256 (EVM), not sha256/NIST-sha3** for all M4 committed hashes; `@noble/hashes` `keccak_256`.
- **LCJ v1 is RFC-8785-*based*, not full RFC 8785** (D-0005); never claim full compliance.
- The §17.5 vectors (`packages/canonical/vectors/lcj-vectors.json`) are FROZEN — a change invalidates
  every committed Arc root. `pnpm vectors:check` guards them.
- Verifier copy: the **analog** is never called a "Signed Receipt" (Path-C honest). Since M6c, steps 1–3
  re-verify the OFFICIAL x402 artifact via EIP-712 when present (else honest `na`); the recovered signer
  is NOT pinned to a registered key (verifier emits `receipt_signer_registry_binding=deferred`, M7).
- `forge test` is scoped: `pnpm contracts:test` (= `--match-contract RevenueBatchAnchorTest`), since
  forge-std ships its own suite under the gitignored `contracts/lib/`.

## Conventions (load-bearing)
- **No-overclaim:** never write "signed receipt" for the Path C analog; that term is reserved for the
  official x402 Path A/B artifact.
- **Integer atomic units only** for money (bigint / `numeric(78,0)`), never JS floats.
- Local Postgres is on **host port 5433** (a native Postgres already holds 5432).
- TS / Node 22, pnpm 10; internal packages export `./src/index.ts` (run via `tsx`, no build step).
- Payload hashes are **`0x`-prefixed hex** — strip the `0x` before `decode(...,'hex')` for `bytea`.
- Path B x402: the standalone offer/receipt issuer (`@ledgerline/x402-receipts`, M6c) does NOT trigger
  the `@x402/core`↔`@circle-fin/x402-batching` type-skew, so **no `@x402/core` pin is needed** for the
  production capture path (D-0012). The skew only appears if you compose `x402ResourceServer` + Circle's
  facilitator (the `apps/spike-receipt` path), where the documented casts apply (D-0001).

## Key docs
- `docs/M2_PLAN.md` — the M2 implementation plan (approve, then build). Read before starting M2.
- `DECISION_LOG.md` — D-0001..D-0004 (capture path, toolchain pins, Postgres port, M0-complete).
- `SPIKE.md` — Week-1 SDK findings + the Path-B receipt spike result.
