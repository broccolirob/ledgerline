# DECISION LOG — Ledgerline

## D-0001 — Signed Offers & Receipts capture path (A / B / C)

- **Status:** DECIDED — 2026-05-29. **Path B is achievable (spike-proven); A is ruled out; C is the working interim.**
- **Context:** Milestone 0 must decide and document how (if at all) we capture the OFFICIAL
  x402 Signed Offers & Receipts artifact, vs. a Ledgerline receipt analog.
- **Path A — RULED OUT.** Circle's convenience `createGatewayMiddleware` exposes no
  `registerExtension` seam and `req.payment` carries no signed offer/receipt (only
  `{ verified, payer, amount, network, transaction }`). The official extension cannot attach to it.
- **Path B — ACHIEVABLE (spike-proven, `apps/spike-receipt`).** The official x402 *Signed Offers &
  Receipts* extension ships in `@x402/extensions@2.13.0` (`./offer-receipt`, version-aligned with
  `@x402/core@2.13.0`). The spike (run 2026-05-29):
  - produced an **EIP-712 signed offer + receipt** with a **dedicated signing key** (distinct from
    the payment address) and **independently verified both** — the recovered signer matches the
    dedicated key (third-party-verifiable without trusting our DB);
  - registered the extension on `new x402ResourceServer(BatchFacilitatorClient).register(
    'eip155:5042002', GatewayEvmScheme).registerExtension(offerReceipt)` and ran `server.initialize()`
    **successfully against Circle's live testnet facilitator** — the official extension **composes
    with Circle's stack**.
  - **Known wrinkle (real):** `@circle-fin/x402-batching` bundles slightly-older x402 interfaces, so
    its `FacilitatorClient`/`SchemeNetworkServer` are **type-incompatible** with `@x402/core@2.13.0`
    (runtime-compatible). The B implementation should pin `@x402/core` to the version Circle built
    against (or keep narrow, documented casts).
  - **Remaining (low-risk, not an achievability blocker):** the live HTTP loop — the extension's
    `enrichPaymentRequiredResponse` / `enrichSettlementResponse` hooks firing on a real 402/200 via
    `paymentMiddleware` + `RouteConfig.extensions`, and the buyer extracting the receipt. Registration
    + initialization succeeded, so this is integration work for the B milestone.
- **Path C — WORKING INTERIM.** The M1 Ledgerline receipt analog (request fingerprint + redacted
  `req.payment` + delivery, idempotent on the Gateway settlement UUID) is built and live in
  `@ledgerline/seller-client` + `@ledgerline/express`. Honest fallback; never called a "signed receipt".
- **Decision:** pursue **B** for official, independently-verifiable receipts (the §12 moat).
  Recommended sequencing: ship the grant demo on **C now** (working, no-overclaim), implement **B** as
  the next receipt milestone (lower-level `x402ResourceServer` + `paymentMiddleware`, `@x402/core`
  version-pinned). **Founder confirmed (2026-05-29):** the demo ships on **C**; **B is the next
  post-demo receipt milestone** (not a demo blocker).
- **Evidence:** `apps/spike-receipt/src/server.ts` — output 2026-05-29: offer + receipt verified
  (recovered signer == dedicated key), `hasExtension('offer-receipt') = true`, `server.initialize()` OK.
- **No-overclaim:** until B's HTTP loop ships and verifies end-to-end, external copy says
  "Ledgerline receipt analog," not "signed receipt".

## D-0002 — Toolchain pins (decided 2026-05-28)

- TypeScript pinned `^5.7` (resolved 5.9.3; latest is 6.0.3) — deferring the TS 6 major to keep the M0 build green.
- `dotenv` dropped in favor of Node 22's native `--env-file-if-exists` (removed an unverified dependency).
- Internal packages export TypeScript source (`./src/index.ts`) for M0 dev (run via `tsx`,
  typecheck via `tsc --noEmit`); build/publish config is added when the OSS packages are first published.

## D-0003 — Local Postgres host port = 5433 (decided 2026-05-28)

- The dev machine already runs a native Postgres bound to `localhost:5432` (IPv4 + IPv6), which
  shadows Docker's proxy for `localhost` and caused `role "ledgerline" does not exist` on migrate.
- Fix: map the container to host port **5433** (`5433:5432`) and point `DATABASE_URL` / the migrate
  default DSN at `localhost:5433`. Also avoids the common Homebrew/Postgres.app-on-5432 clash on any machine.
- The `db:wait` gate uses an authed `psql -c 'select 1'` (inside the container) rather than `pg_isready`,
  which falsely reported ready during the first-start init bootstrap.

## D-0004 — Milestone 0 complete (2026-05-29)

M0 gate — all items met:
- unpaid request → 402; paid → 200 over Circle Gateway Nanopayments on Arc Testnet (verified live).
- sub-cent `$0.003` pricing parses + settles (verified live).
- payment context → one `raw_events` row per paid call (the M1 Ledgerline receipt analog; idempotent on the Gateway settlement UUID).
- Payment-Identifier: documented SDK limitation (not surfaced by Circle's middleware).
- one split allocation derivable (`allocateOneSplit(3000)` → 2100/600/210/90).
- capture-path A/B/C decided + documented (D-0001).
- no-overclaim rule in force.

**The demo ships on Path C** (the Ledgerline receipt analog). Path B (official x402 signed receipts,
spike-proven achievable) is the next receipt milestone, not a demo blocker. Next build is the
founder's call: **M2** (revenue recognition — `raw_events` → `revenue_events` + double-entry ledger)
or the **Path B** receipt route.

## D-0005 — Canonicalization: LCJ v1 in-house, no deps (decided 2026-05-31, M4)

- **LCJ v1 is an RFC-8785-*based* restricted profile, NOT full RFC 8785.** LCJ forbids bare numbers /
  floats / null (§17 Rules 2/3/5), which removes RFC 8785's only hard part (IEEE-754 double
  canonicalization). What remains — sorted-key emission over closed schemas + Ledgerline
  closed-schema / duplicate-key / numeric-string validation that no JCS lib does — is implemented
  in-house in `@ledgerline/canonical` (zero serialization deps), keeping the verifier independently
  auditable.
- **Hash primitive is vetted, not hand-rolled:** keccak256 via `@noble/hashes` `keccak_256` (the EVM
  keccak — cross-checked byte-for-byte against viem's `keccak256` in the anchor tests). In-house the
  serialization; never the crypto.
- **No-overclaim:** say "LCJ v1, RFC-8785-based," never "full RFC 8785 compliance."
- Frozen §17.5 vectors ship at `packages/canonical/vectors/lcj-vectors.json`; `pnpm vectors:check`
  (and a vitest) fail on any byte drift, since drift would invalidate every committed Arc root.

## D-0006 — M4 canonicalizer scoped to new Merkle leaves only (decided 2026-05-31)

- The committed leaves are `revenue_event_leaf.v1` + `ledger_entry_leaf.v1`, re-canonicalized fresh at
  batch time under LCJ+keccak. The M1 `raw_events.canonical_hash` placeholder (`seller-client`'s
  sha256 + `stableStringify`) is **left untouched** — it is a capture-time dedup field, never an
  on-chain leaf. The seller-client retrofit is a separate future task (not in M4).

## D-0007 — Arc anchoring is Track-A-gated; credential-free core (decided 2026-05-31)

- Canonicalization + Merkle + `buildBatch` + the verifier (offline) + `pnpm contracts:test` all run
  with **zero credentials**. `pnpm anchor:submit` and `pnpm verify --onchain` are gated on
  `ARC_RPC_URL` + `ANCHOR_COMMITTER_KEY` + `ANCHOR_CONTRACT_ADDRESS`; without them, `anchor:submit`
  prints "blocked on Track A" and exits 0 (mirrors `demo-buyer`). When creds land, the live anchor
  lights up with no code change.
- **Correction to the planning framing:** Foundry IS installed locally (`forge 1.6.0`), so contract
  tests run today; only the live deploy/submit + on-chain read are credential-gated.
- `RevenueBatchAnchor.sol` uses a **minimal inline role gate** (COMMITTER_ROLE + admin) instead of an
  OpenZeppelin `AccessControl` import — zero external deps, hermetic `forge test`. Single-commit is
  guarded by `batchExists[batchId]` (not `committedAt != 0`) so a 0-timestamp/genesis edge can't make
  a batch re-committable. `contracts/lib/` (forge-std) is gitignored (`forge install` on fresh clone);
  `forge test` is scoped via `--match-contract RevenueBatchAnchorTest` (`pnpm contracts:test`) because
  forge-std ships its own suite under `lib/`.

## D-0008 — Demo batch is a `mixed` batch (decided 2026-05-31)

- One commitment batch contains the `revenue_event` leaf + all `ledger_entries` legs of its
  recognition journal. This satisfies §21 step 9 ("prove one revenue event is in the root") **and**
  Invariant 11 (a journal's full leg set co-located so the step-9 balance check is provable). Leaf
  order: revenue_event leaves (by id), then ledger_entry leaves (by effective_at_ms, journal id, id).
- **Schema superset (flagged):** `0005_commitment_batches.sql` adds `batch_id`, `status`, `batchExists`
  bookkeeping, and a `batch_leaves` join table beyond the §7.12 sketch — additive, no rewrite. Plus a
  salted `tenants.tenant_commitment_salt` (§16; deterministic demo seed — production uses a per-tenant
  secret).
- **Verified live (credential-free):** `anchor:build` committed an 18-leaf mixed batch (2
  revenue_events + 16 ledger legs); `pnpm verify` passes all 14 §17.6 steps offline (canonical
  reproduction of 18 leaves, principal_gross tie-out, Invariant-11 leg co-location, first-batch
  zero previous-root, offline inclusion proof). Submit + on-chain finality are the Track-A steps.

## D-0009 — M4 adversarial-review hardening (decided 2026-05-31)

A 6-dimension multi-agent review of the M4 build (20 confirmed/partial of 27 findings) drove these
fixes (all green: canonical+anchor vitest, 13 forge tests, e2e verify):
- **Canonicalization:** `parseCanonicalJson` now rejects malformed `\u` escapes (was silently
  coercing `\uZZZZ`→NUL, weakening the verifier's defensive ingest); atomic-amount leaf fields are
  uint256-range-checked (`atomicStr`), so a non-representable amount can't enter the frozen root.
- **Batch builder:** the whole select→leg-read→root-compute→insert sequence now runs inside one
  transaction behind a per-tenant `pg_advisory_xact_lock` (was read-compute-write across the Pool —
  concurrent builds could anchor a stale/partial set). Added a pre-anchor per-asset balance gate so an
  unbalanced/torn journal is never committed as final.
- **Contract:** `commitBatch` now binds `batchId` to its canonical derivation
  (`keccak(domain‖tc‖uint64_be(num)‖root)`) and enforces a monotonic per-tenant `batchNumber`
  (`latestBatchNumberByTenant + 1`); added `revokeRole` (compromised-committer removal); exposed the
  per-batch `batches(batchId)` getter. Single-commit guard is `batchExists` (D-0007).
- **Verifier:** step 0 also re-derives + binds `batch_id`; step 12 no longer treats a missing
  predecessor as genesis (only `batch_number == 1` may chain from the zero root — closes a
  forged-non-genesis false-accept); step 13 `--onchain` reads the SPECIFIC batch root via
  `batches(batchId)` instead of `latestRootByTenant` (closes a false-REJECT of every non-latest batch
  once a tenant has >1 batch); `submitNextBatch`/`commitBatchOnchain` now assert `receipt.status ===
  'success'` (a mined-but-reverted commit no longer records as 'committed'); `generateVerifierPackage`
  builds leaves densely with a contiguity assert (was an opaque sparse-array crash).
- **Deferred (documented, not reached by shipped code):** symmetric leg-aware idempotency filter in
  `buildBatch` (current filter keys only the revenue_event leaf — only bites a manual partial-commit);
  re-deriving the canonical leaf ORDER in the verifier (ordering is builder-trusted today — a builder
  sort regression would self-verify; the frozen leaf-hash vectors do not pin batch order); on-chain
  `eventCount` is advisory (the root commits to leaf hashes, not their count — the off-chain verifier
  binds count==leaves at step 0).

## D-0010 — Anchor live on Arc Testnet (decided 2026-06-01, M4)

The M4 commitment layer is no longer Track-A-gated in principle — it is **live on Arc Testnet**:
- `RevenueBatchAnchor` deployed at **`0x3Bd5966789CA3F00ecB25D262099c9DDE0e90EC4`** (chain id 5042002),
  deploy tx `0x7918414793556c35500bf78eebe033ad6c31f48ec21aaddd720b75d0abf48010`. The deployer EOA
  `0x74F8ACbb186187419eA254dc27919Cb35FB92077` is admin + `COMMITTER_ROLE` (the `anchor:submit` signer);
  it pays gas in USDC directly from its balance (USDC is Arc's native gas — NOT the M0 Gateway deposit
  flow). Fresh dedicated testnet-only committer EOA, distinct from the M0 payment-rail wallets.
- Batch #1 (18 leaves, root `0x2701389ec4c16ac971540e4ad99bb7b6bf7a8ce49070b2c81795c025762e672b`)
  committed on-chain via `commitBatch` tx
  **`0x7ee7c6a74bb491eab3da395813661925976316613c959aceb7cad5170d06233a`**.
- `pnpm verify --onchain` → **PASS (anchor-verified)**, all 14 §17.6 steps, including step 13
  (on-chain batch root read via `batches(batchId)` matches) and step 14 (tx final). Offline `pnpm
  verify` still passes with the honest "DB-consistent; run --onchain" qualifier.
- Demo §21 steps 8 (commit to Arc) + 9-onchain (verifier proves inclusion in the Arc-committed root)
  are now demonstrable end-to-end with a real block-explorer tx hash.

**Bug found by going live (fixed):** all 5 CLIs resolved the tenant via
`process.env.LEDGERLINE_TENANT_ID ?? DEMO_TENANT_ID`, which only falls back on `undefined`. A
set-but-empty `LEDGERLINE_TENANT_ID=` in `.env` passed `''` through → `invalid input syntax for type
uuid: ""`. Fixed to `(process.env.LEDGERLINE_TENANT_ID || undefined) ?? DEMO_TENANT_ID` across
anchor-build/submit/verify CLIs + recognition recognize/export CLIs.

Secrets (`ANCHOR_COMMITTER_KEY`, RPC) live only in the gitignored `.env`; the contract address + tx
hashes above are public testnet identifiers, safe to record.
