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
