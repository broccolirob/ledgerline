# DECISION LOG — Ledgerline

## D-0001 — Signed Offers & Receipts capture path (A / B / C)

- **Status:** OPEN (decide after the timeboxed wiring attempt; see `SPIKE.md` §E).
- **Context:** Milestone 0 must decide and document how (if at all) we capture the OFFICIAL
  x402 Signed Offers & Receipts artifact, vs. falling back to a Ledgerline receipt analog.
- **Finding (2026-05-28, from the installed `@circle-fin/x402-batching@3.0.4` types):**
  - `req.payment` exposes only `{ verified, payer, amount, network, transaction? }` — **no
    Payment-Identifier, no signed offer/receipt**. So Circle's middleware alone cannot yield
    the official artifact, and Payment-Identifier capture is **not available** via the middleware
    (SDK limitation documented — satisfies the M0 gate).
  - `createGatewayMiddleware` exposes **no extension seam**. The official path most likely
    requires the lower-level `new x402ResourceServer([new BatchFacilitatorClient({url})])
    .register('eip155:5042002', new GatewayEvmScheme())` and registering the offer-receipt
    extension there — structurally closer to Path B than Path A.
- **Options:**
  - **Path A** — official extension on the same server Circle's middleware fronts. Likely NOT
    possible via `createGatewayMiddleware` (no seam); would mean dropping to `x402ResourceServer`.
  - **Path B** — parallel `x402ResourceServer` wired to `BatchFacilitatorClient` + `GatewayEvmScheme`,
    register the official extension there. Plausible given the exported building blocks; UNVERIFIED
    end-to-end. Timebox ~2-3 days.
  - **Path C** — Ledgerline receipt analog (request fingerprint + delivery record; no Payment-Identifier
    available). Buildable today from `req.payment` + request metadata. Never called a "signed receipt".
- **Timebox rule:** attempt the official path (B-shaped) ~2-3 days; if it resists, ship Path C.
- **Decision:** _TBD_  | **Evidence:** _link spike code / output_  | **Date / decider:** _TBD / founder_

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
