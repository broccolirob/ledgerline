# Ledgerline Milestone 5 — Grant-ready: demo script, threat model, security tests, integration guide

**Implementation plan (approved). Phase 5 of the build plan: presentation + hardening of what's
shipped — NOT new infrastructure.**

## Context

M0–M4 are complete and the full §21 pipeline is **live on Arc Testnet** (D-0010): a paid x402 call →
recognized revenue + double-entry ledger → Merkle batch committed on-chain (tx
`0x7ee7c6a74bb491eab3da395813661925976316613c959aceb7cad5170d06233a`) → `verify --onchain` PASS all 14
steps. What's missing is **presentation + hardening** — the Phase 5 (build-plan Milestone 5) work that
turns "it runs on my machine" into "here is it running, here's the threat model, here's how you
integrate it in a day." The Circle grant explicitly rewards "show us what you've shipped," so M5 makes
the shipped thing legible and demonstrably safe.

**Scope decisions (confirmed):**
- **LEAN boundary.** Present + harden *what exists*. Build **no** new infra — specifically NOT the
  hosted ingestion API (`POST /v1/events`), API-key management, adapter-event signing/verification, or
  the §9 encryption envelope. Those presuppose a hosted service M2 deliberately deferred; they are
  M6+. M5 is honest about that line, not papered over it.
- **RESILIENT demo script.** The runnable §21 sequence does the live `402 → pay → 200` loop when buyer
  creds + Gateway funding are present; otherwise it starts from already-captured `raw_events` (2 real
  ones from M0/M1) and runs recognize → build → submit → verify. Always runnable for a presenter; shows
  the live loop when funded.

## What already exists (reuse, do not rebuild)

- **Pipeline entry points** (all tenant-scoped, all chainable): `recognition/src/index.ts`
  `runRecognitionPass` / `resolveDemoConfig`; `anchor/src/index.ts` `buildBatch`, `submitNextBatch`,
  `verify`, `generateVerifierPackage`. The CLIs (`recognize`, `anchor:build`, `anchor:submit`,
  `verify`, `export:csv`) already wrap these; the demo script orchestrates them.
- **Throwaway-DB test harness:** `anchor/test/helpers.ts` `setupDatabase`/`dropDatabase`/`seedRecognized`
  (fresh DB per file, migrated, seeded with recognized M2 output). The security suite reuses this
  pattern — no new harness.
- **Security primitives already enforced** (M5 *tests* them, doesn't add them): tenant-scoped queries
  (`where tenant_id = $1` throughout), the §12 leaf omit-list (`canonical/src/index.ts`
  `omitted_from_leaf: account_name;memo;units;raw_urls;customer_id`; leaf builders exclude
  memo/account_name), integer-only split with dust-to-publisher, `posting_key` idempotency, the
  contract's role gate + chain enforcement.
- `infra/docker-compose.yml` (Postgres 16, port 5433); root `README.md` exists (M0-era, needs a real
  rewrite); `.env.example` documents all creds.

## Deliverables

### 1. The runnable demo script — `pnpm demo`

New `scripts/demo.ts` (run via `tsx`; add root script `"demo"`). One narrated, idempotent, end-to-end
run of the §21 nine steps, each printing a labeled banner + the real artifact (tx hashes, ledger
table, verifier checklist). Resilient entry:

- **Preflight:** detect buyer creds (`BUYER_PRIVATE_KEY` + Gateway balance) and anchor creds
  (`ARC_RPC_URL`/`ANCHOR_COMMITTER_KEY`/`ANCHOR_CONTRACT_ADDRESS`). Print a capability banner (LIVE-PAY
  vs CAPTURED-START; ON-CHAIN vs OFFLINE) so the presenter knows the mode. Fail fast (clear message) if
  Postgres is down.
- **Steps 1–3 (paid call):** if buyer-funded, drive the live demo-buyer pay loop; else skip with
  "using N captured receipt analogs from M0/M1".
- **Steps 4–5 (recognize + split):** `runRecognitionPass` → print the earned `revenue_event` + the
  4-way split / balanced journal (3000 → 2100/600/210/90, ΣDr=ΣCr=3900).
- **Step 6 (ledger view):** print ledger entries + recipient statement to the console (the dashboard's
  CLI substitute, §15) — no UI.
- **Step 7 (export):** `export:csv` → the two CSVs.
- **Step 8 (commit):** `buildBatch` if needed, then `submitNextBatch` when anchor creds present (real
  Arc tx) else print the built batch root + "run with anchor creds to commit live".
- **Step 9 (verify):** `verify --onchain` when live (PASS anchor-verified) else offline PASS with the
  honest qualifier. End on the §21 tagline.

Idempotent: re-run safe (recognize/build/submit are all replay-no-op). Reads env, never writes secrets.

### 2. `docs/THREAT_MODEL.md` — T1–T16 with honest status

Table mapping each §16 threat to **ENFORCED / TESTED / DESIGNED-DEFERRED**, citing the specific code or
test. Auditor-credible honesty, not green-washing:
- ENFORCED+TESTED: T1 (PID replay — fingerprint binding + `unique(tenant_id,payment_identifier)`), T2
  (dup — `posting_key` + interaction gate), T3 (paid-not-delivered — F1 path, 2xx gate), T7 (split
  tamper — versioned `split_group` + immutable allocations + on-chain root), T8 (dust — integer math),
  T9 (Arc metadata leak — §12 omit-list), T11 (cross-tenant — tenant-scoped queries), T16 (canon
  divergence — frozen §17.5 vectors + `vectors:check`).
- PARTIAL / honest-scope: T4 (Path C analog, no official receipt — D-0001), T5 (hashed at capture; §9
  envelope deferred), T6 (adapter signing schema-only, NOT verified server-side — headline M6 gap),
  T10 (committer = single EOA; `revokeRole` exists; KMS/multisig deferred), T12 (seller-reported units
  trusted in MVP).
- DESIGNED-DEFERRED: T13 (SIWX schema only), T14 (Gateway reconciliation design only), T15 (P1/F2 race
  — Invariant 10 gates on the deferred cash milestone; lock discipline documented).

### 3. Security test suite — `packages/*/test/*.security.test.ts` (§19)

Reuse the throwaway-DB harness. Test the architecture's *actual* defenses, with **negative** tests that
prove a deferred control is absent so the threat model can't drift into overclaim:
- **Cross-tenant isolation (T11):** seed tenant A; verify/build/export scoped to B sees none of A's
  rows; a batch built for B never includes A's leaves.
- **Split overflow / dust (T8):** `allocateSplit` rejects >10000 and <10000 bps; tiny-gross dust
  balances and never goes negative.
- **Raw-URL-not-in-leaf (T9):** build a leaf from a row whose source contains a URL/customer id; assert
  the canonical leaf bytes contain no omit-list field.
- **Fingerprint collision (T1):** requests differing only by trailing-slash/query-order produce the
  documented same/different fingerprint per §8.
- **Parse fuzz (T16/parse):** `parseReceipt` + `parseCanonicalJson` over malformed payloads reject,
  never crash-with-stack or coerce.
- **Adapter-sig honesty (T6):** an explicit assertion that `adapter_signature` is currently unverified
  (column written null) — documents the gap.
- Add `pnpm test:security` (vitest filtered to `*.security.test.ts`).

### 4. Integration guide + README rewrite + presenter script

- `docs/INTEGRATION.md`: the seller's path — `@ledgerline/express` `ledgerlineRecorder` + a sink, the
  `raw_events` contract, then the recognize → build → verify lifecycle. Copy-paste runnable.
- Rewrite root `README.md`: what Ledgerline is (1 paragraph), live-on-Arc status + the real tx hash,
  the `pnpm demo` quickstart, package map, honest "what's deferred" line.
- `docs/DEMO.md`: presenter's 9-step narration referencing `pnpm demo`.

## Critical files

- **New:** `scripts/demo.ts`; `docs/THREAT_MODEL.md`, `docs/INTEGRATION.md`, `docs/DEMO.md`;
  `packages/recognition/test/recognition.security.test.ts`,
  `packages/canonical/test/canonical.security.test.ts`,
  `packages/anchor/test/anchor.security.test.ts`.
- **Edited:** root `package.json` (`"demo"`, `"test:security"`); root `README.md`; `DECISION_LOG.md`
  (D-0011); `CLAUDE.md` (status → M5).
- **Reused, not modified:** `anchor/test/helpers.ts`, all pipeline entry points above.

## Verification (definition of done)

1. `pnpm demo` runs clean in CAPTURED-START + OFFLINE mode (no creds) — all 9 steps print, ends green.
2. With anchor creds present, `pnpm demo` reaches a real `--onchain` PASS (re-run idempotent).
3. `pnpm test` green (118 + new security tests); `pnpm test:security` passes; the T6 negative test
   correctly asserts the adapter-sig gap.
4. `THREAT_MODEL.md` — every T1–T16 row cites a real file/test or names the deferral; no overclaim.
5. A cold reader can follow `README.md` + `docs/INTEGRATION.md` to capture → recognize → verify.
6. typecheck 9/9, forge 13/13 unchanged; `vectors:check` OK.

## Out of scope (NOT M5 — named so the threat model stays honest)

- Hosted ingestion API (`POST /v1/events`), API-key management, adapter-event signing + server-side
  verification (T6), §9 encryption envelope (T5 full) — **M6+**.
- Dashboard UI (§15 CLI/CSV substitute stands), JSON export.
- SIWX runtime (T13), Gateway transfer-query reconciliation (T14), P1/F2 + Invariant-10 (T15), Path B
  official signed receipts (D-0001).
- Any change to frozen canonicalization / committed roots.
