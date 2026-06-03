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

## D-0011 — Milestone 5 complete: grant-ready (decided 2026-06-01)

Phase 5 shipped as **presentation + hardening of what exists** — explicitly LEAN, no new infra:
- **`pnpm demo`** (`packages/anchor/src/demo-cli.ts`) — the runnable §21 nine-step sequence
  (capture-or-replay → recognize → split → recipient view → CSV export → build → submit → verify),
  narrated + idempotent, with a capability banner (LIVE-PAY vs CAPTURED-START; ON-CHAIN vs OFFLINE).
  Verified end-to-end: PASS (anchor-verified), all 14 steps, against the live D-0010 contract.
- **`docs/THREAT_MODEL.md`** — T1–T16 mapped to ENFORCED/TESTED/PARTIAL/DEFERRED, each row citing real
  code or a test. TESTED: T1,T2,T3,T7,T8,T9,T11,T16. PARTIAL: T4 (Path C),T5,T10,T12. DEFERRED:
  T6,T13,T14,T15. T6 (adapter-event auth) is the named headline M6 gap, backed by a NEGATIVE test.
- **Security suite** (`*.security.test.ts`, 38 tests, `pnpm test:security`) — cross-tenant isolation
  (T11), split overflow/dust + value conservation (T8), raw-metadata-not-in-leaf (T9), fingerprint
  binding (T1), parse-boundary fuzz (T16), and the T6 adapter-sig negative test proving the gap is real.
- **Docs** — root `README.md` rewritten (live-on-Arc status + tx hash + `pnpm demo` quickstart + honest
  deferred list); `docs/INTEGRATION.md` (seller path, <1-day onboarding); `docs/DEMO.md` (presenter
  narration). Plan: `docs/M5_PLAN.md`.

**LEAN boundary (deferred to M6+, named so the threat model stays honest):** hosted ingestion API
(`POST /v1/events`), API-key management, adapter-event signing + server-side verification (T6), the §9
encryption envelope (T5 full), dashboard UI (CSV substitute stands), JSON export. SIWX (T13), Gateway
reconciliation (T14), and P1/F2 cash flows + Invariant 10 (T15) gate on post-demo milestones.

**Bug fixed during M5 (found by `pnpm demo`):** all 5 CLIs resolved the tenant via
`process.env.X ?? DEMO_TENANT_ID`, which only falls back on `undefined`; a set-but-empty
`LEDGERLINE_TENANT_ID=` passed `''` → empty-uuid bind error. (Already recorded under D-0010's CLI fix;
the demo re-exercised and confirmed it.)

Verified: typecheck 9/9, vitest 156/156 (118 + 38 security), forge 13/13, vectors OK, `pnpm demo`
PASS anchor-verified.

## D-0012 — Milestone 6c: official x402 Signed Offer/Receipt implemented, Path B (decided 2026-06-02)

The deferred Path-B receipt milestone (D-0001) is now built — the demo captures + verifies the
**official x402 EIP-712 Signed Offer & Receipt** alongside the Path-C analog. Closes T4 offline.

- **Approach B (founder-chosen): alongside Circle's middleware.** `createGatewayMiddleware` still owns
  the 402 + Gateway settlement (the working live-on-Arc money path is untouched). A parallel issuer
  produces the official signed offer (at request terms) + signed receipt (on 2xx, bound to
  `req.payment.transaction`). Copy never claims Circle delivers the offer in its 402.
- **The issuer is STANDALONE → the D-0001 type-skew is moot here.** `createEIP712OfferReceiptIssuer().
  issueOffer()/issueReceipt()` only sign payloads; they need no `x402ResourceServer` /
  `BatchFacilitatorClient` / `GatewayEvmScheme`. The spike registered the extension on a ResourceServer
  *only to prove it composes with Circle's facilitator*; the production capture path never does, so the
  `@x402/core`↔`@circle-fin/x402-batching` skew never arises and `@ledgerline/x402-receipts` carries
  **no `as unknown` casts** (one documented cast bridges viem's stricter `signTypedData` to the SDK's
  `SignTypedDataFn`). The D-0001 "pin `@x402/core`" wrinkle is therefore **not needed** for B.
- **New OSS package `@ledgerline/x402-receipts`** isolates the x402 deps (`@x402/extensions` + `viem`):
  `createReceiptIssuer` / `generateReceiptSigningKey` / `verifySignedOffer` / `verifySignedReceipt` /
  `receiptMatchesOffer` / `offerReceiptArtifactHash`. Dedicated secp256k1 signing key
  (`RECEIPT_SIGNING_KEY`), distinct from `payTo` (spec requirement; T10).
- **Frozen Arc leaf format UNCHANGED (load-bearing).** The §17.5 LCJ vectors + every committed root
  stay frozen. M6c adds **no** artifact leaf and does not touch the revenue_event/ledger_entry leaves;
  the official artifacts are verified **cryptographically** (EIP-712, verifier steps 2–3) while the
  `revenue_event` they produced remains Arc-committed (steps 0/13). Committing artifact hashes as a new
  leaf type is a deferred canonical extension (would invalidate the frozen roots). `pnpm vectors:check`
  still OK.
- **Verifier un-rescoped (`anchor/src/index.ts` steps 1–3).** Step 1 prefers `signed_receipt` (official)
  → else `payment_signature` (analog, honest); step 2 verifies the receipt's EIP-712 signature; step 3
  binds receipt↔offer + same-issuer + `offer.amount == revenue gross`. Analog-only → steps 2–3 `na`
  (backward-compatible). The "NOT official" hedge is dropped ONLY where the official artifact verifies.
- **Persistence:** migration `0007` adds `artifact_json jsonb` (the source of truth for offline
  re-verification) + the `artifact_type` CHECK (`signed_offer|payment_signature|signed_receipt`).
  Artifacts are NOT Arc-committed; §9 at-rest encryption of `artifact_json` (which by spec carries the
  receipt's `payer`) is deferred to M7.
- **Review hardening (`/review`, 2026-06-02):** two independent adversarial reviewers converged on a
  real gap — the verifier proved "EIP-712 recovers a signer" without anchoring it, so a *lone* tampered
  receipt (no offer → step 3 was `na`, and `na` doesn't fail) passed the whole checklist, and a
  present-but-invalid receipt still earned the "official" label. Fixed: step 1's official label now
  requires a valid signature; an official receipt WITHOUT its offer now FAILS step 3 (not `na`); the
  demo throws (not warns) when `RECEIPT_SIGNING_KEY == payTo`; step 2/3 copy is honest that issuer
  identity is not yet registry-pinned. Added regression tests (lone-receipt fails) + a recognition
  WRITE-path round-trip test (the capture→jsonb→recognize artifact path was previously untested).
- **Signer-registry pinning → M7 (founder decision at `/review`, 2026-06-02).** The canonical M6c claim
  is exactly: **"official x402 signed offer/receipt captured and verified; signer registry pinning
  deferred to M7."** The verifier checks an internally-consistent offer+receipt pair (same recovered
  issuer, bound terms, amount tie) and that it binds to the Ledgerline `revenue_event`, but does NOT pin
  the recovered signer to a *registered* seller key — so steps 2–3 are not standalone proof of seller
  identity (a self-consistent forgery written under an attacker's own key, with DB write access, would
  still pass). The verifier states this explicitly: step 2 emits
  `receipt_signer_registry_binding=deferred/not-checked (M7)`. Closing it needs a trusted receipt-key
  registry (registration/rotation/revocation/tenant ownership, analogous to M6b's `adapter_keys`) — the
  M7 operated-key layer (`COMMERCIAL_BOUNDARY.md`); building a second registry surface now was
  explicitly declined. The Arc-committed `revenue_event` remains the tamper-evident money record.
- **Known edge → concurrency milestone:** EIP-712 offers are deterministic, so two DISTINCT paid calls
  with identical terms in the same wall-clock second produce a byte-identical signed_offer; the global
  `unique(tenant_id, artifact_type, artifact_hash)` keeps only one row, so the second interaction has a
  receipt but no offer and (with the lone-receipt rule above) FAILS step 3. Cannot fire in M6c's surface
  (the demo is sequential; the live loop is Track-A-gated). The fix when real concurrency lands is
  per-interaction uniqueness for official artifacts (a migration splitting the analog's cross-interaction
  dedup from the official rows' per-interaction rows); the analog/money path is unaffected.
- **Out of scope (deferred):** the live end-to-end loop (real buyer + Gateway creds → real receipt) is
  Track-A-gated, like the rest of the live demo; the offline issue→capture→verify→tamper path is fully
  tested. Committing artifact hashes on-chain + hosted ingestion of official artifacts are M7/private.

Verified: typecheck 11/11, vitest 183/183 (incl. 14 `x402-receipts` + anchor official-artifact /
tamper / lone-receipt / backward-compat + recognition write-path tests), `pnpm test:security` 44/44,
`pnpm vectors:check` OK (frozen leaves unchanged), `pnpm contracts:test` 13/13, migration 0007 applies
via the throwaway-DB harness.
