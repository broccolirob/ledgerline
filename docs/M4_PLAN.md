# Ledgerline Milestone 4 — Arc Commitment + Verifier

**Implementation PLAN (approve, audit, then build). No production code below — exact DDL, signatures,
formulas, leaf schemas, and the contract interface only. Implement after a plan-audit/`/review` pass.**

Milestone-label note: this is build-plan **Milestone 4** (spec **§17 canonicalization + Merkle, §12 Arc
commitment + verifier, §7.12 `commitment_batches`, §18.15 Invariant 11, §20/§21 demo steps 8–9**).
Integer atomic-unit (`bigint` / `numeric(78,0)`) math only; no-overclaim discipline throughout.

---

## Context — why M4, and why now

The grant demo is a 9-step sequence (§21). Steps 1–7 ship today: unpaid→402, pay→200, receipt analog
captured, **earned `revenue_event`, 4-way split into a balanced double-entry ledger, CSV export**
(M0–M2, all green: 57 tests, live on Arc Testnet). The punchline — **steps 8 and 9** — does not exist:

> 8. Batch root commits to Arc Testnet.
> 9. Verifier proves one revenue event is in the Arc-committed root.

The tagline is "reconcilable, auditable, split-ready, **and Arc-anchored**." Right now we can prove the
first three. The fourth — the thing that makes this an *Arc* demo and not just a Postgres ledger — is
unbuilt: `contracts/` is a stub README, and there is zero canonicalization / Merkle / verifier code.

M4 closes that gap: a deterministic canonicalization + keccak256 Merkle library, a `commitment_batches`
table + batch builder, `RevenueBatchAnchor.sol` on Arc Testnet with previous-root chaining, and an
independent verifier that proves a recognized revenue event is included in an Arc-committed root.

## Decisions locked (carried from the three planning Q&As; recorded as DECISION_LOG entries)

- **D-0005 — LCJ serializer in-house, no deps.** LCJ v1 is an **RFC-8785-*based* restricted profile**
  (not full RFC 8785). Rationale: LCJ forbids bare numbers / floats / null (§17 Rules 2/3/5), which
  removes RFC 8785's only hard part (IEEE-754 double canonicalization). What remains is sorted-key
  emission over a closed ASCII-ish schema + Ledgerline-specific validation that no JCS library does.
  Keep the verifier zero-dependency for independent third-party reproduction. **No-overclaim:** say
  "LCJ v1, RFC-8785-based," never "full RFC 8785 compliance."
- **D-0006 — canonicalizer scoped to the new Merkle leaves only.** Build LCJ+keccak for the committed
  leaves (`revenue_events`, `ledger_entries`). **Leave the M1 `raw_events.canonical_hash` placeholder
  (`seller-client`'s sha256+`stableStringify`) untouched** — it is a capture-time dedup field, never an
  on-chain leaf. Even a future `raw_events` batch would re-canonicalize fresh at batch time. The
  seller-client retrofit is a separate future task.
- **D-0007 — on-chain anchoring is Track-A-gated, credential-free core.** Ship canonicalization +
  Merkle + batch builder + verifier (all DB-local, fully tested) + `RevenueBatchAnchor.sol` + Foundry
  tests now. The `anchor:submit` CLI is wired but prints "blocked on Track A" without
  `ARC_RPC_URL` + a funded committer key — mirroring `demo-buyer`. On-chain verification is an optional
  `--onchain` flag. **Correction to the planning framing:** Foundry IS installed locally
  (`forge 1.6.0-nightly`), so `forge test` runs today; only the live deploy/submit + on-chain read are
  credential-gated.
- **D-0008 — the demo batch is a `mixed` batch** containing one `revenue_event` leaf + all
  `ledger_entries` legs of its recognition journal. This directly satisfies §21 step 9 ("prove one
  revenue event is in the root") **and** Invariant 11 (a journal's full leg set must be co-located so
  step-9 balance is provable). Alternative (ledger-entries-only batch) noted in §2.6; mixed is the
  spec-faithful default.

---

## Repo facts this plan is built against (verified against the live tree)

- **Foundry present:** `forge 1.6.0-nightly`. Contract tests are local; only live Arc deploy needs creds.
- `contracts/` contains only `README.md`. Needs `forge init --force` + sources/tests/`foundry.toml` +
  an OpenZeppelin remapping (`RevenueBatchAnchor` imports `AccessControl`).
- `viem` is a dep of `apps/demo-buyer`, `apps/demo-seller-express`, `apps/spike-receipt` (Arc Testnet
  chain usage). Reuse it for the anchor on-chain client; `recognition`/`canonical` have no viem.
- Leaf-source columns (migration `0003`): `revenue_events(id uuid, tenant_id, interaction_id,
  revenue_source, pricing_model_id, gross_amount_atomic numeric(78,0), asset, network, units,
  revenue_status, earned_at, …)`; `ledger_entries(id uuid, tenant_id, entry_group_id, account_id,
  direction, amount_atomic numeric(78,0), asset, memo, …)`; `journal_transactions(… effective_at
  timestamptz not null …)` — `effective_at` drives ledger-leaf ordering (§17.3).
- `pg` returns `numeric(78,0)`/`bigint` as JS **strings**; atomic amounts stay strings → `bigint`,
  never JS floats. All payload hashes elsewhere are `0x`-prefixed hex.
- `migrate.ts` re-runs every `*.sql` on every invocation (simple-query, no bind params, no
  applied-tracking). 0005 must be all `create … if not exists` / `insert … on conflict do nothing`.
- Packages export raw TS (`exports: './src/index.ts'`), run via `tsx`, no build step; NodeNext +
  `verbatimModuleSyntax` + `isolatedModules`. Tests use vitest with `@ledgerline/*` aliases in
  `vitest.config.ts` (extend it for the two new packages). Root has `test`/`recognize`/`export:csv`/
  `audit:balance` scripts; Node ≥22, pnpm 10. Postgres on host **port 5433**.

---

## 1. Overview + commitment data flow

```
revenue_events + ledger_entries (M2 output, per tenant)
   │  batch builder selects un-committed records, groups by journal_transaction (Invariant 11)
   ▼
@ledgerline/canonical: LCJ(record) → canonical_record_hash → leaf_hash    [keccak256, domain-tagged]
   ▼  RFC-9162-style Merkle tree (0x00 leaf / 0x01 node prefixes, no odd-leaf dup), canonical leaf order
merkle_root  +  schema_hash  +  metadata_policy_hash  +  batch_id  +  previous_merkle_root(chain)
   ▼
commitment_batches row (status: built → committed)     [migration 0005]
   ▼  anchor:submit CLI  (Track-A-gated: ARC_RPC_URL + funded committer key)
RevenueBatchAnchor.commitBatch(...) on Arc Testnet  → arc_tx_hash, committed_at
   ▼
verifier package (per revenue_event): disclosed records + merkle_proof + batch metadata
   ▼  verify CLI runs the 14-step §17.6 checklist (Path-C re-scoped); --onchain reads the live root
PASS / FAIL
```

Two distinct hashes (§17.3): `canonical_record_hash` = stable identity; `leaf_hash` = tree membership.
Computed once, single-sourced.

---

## 2. `@ledgerline/canonical` — LCJ v1 + keccak256 + Merkle (pure, no DB, no viem)

New package `packages/canonical/` (mirrors conventions: `exports: './src/index.ts'`, tsx, no build).
**Only dependency: `@noble/hashes` (`keccak_256`)** — the audited primitive viem itself wraps; tiny,
zero-transitive-dep. In-house the *serialization* (LCJ makes it simple); use a vetted lib for the
*hash primitive* (never hand-roll crypto). This is the independently-auditable core of the verifier.

### 2.1 LCJ v1 serializer (§17.2)
`lcj(record): Uint8Array` (UTF-8 bytes). Rules enforced by a **validate-then-emit** pass:
- Rule 1: RFC-8785 base — recursively **sorted object keys** (UTF-16 code-unit order = JS default
  `.sort()`), whitespace-free, leaf strings via `JSON.stringify` (already RFC-8785-escaping-compatible).
- Rule 2: **no bare JSON numbers** — every numeric is a string matching `^(0|[1-9][0-9]*)$`. Reject
  actual JS `number`s.
- Rule 3: **no floats**; Rule 5: **no `null`** (omit optional fields entirely); Rule 6: booleans allowed.
- Rule 7: **strings preserved as-is** (no NFC/normalize/trim/lowercase inside the serializer).
- Rule 10: **closed schema** — unknown fields rejected (not ignored); Rule 11: **duplicate keys rejected**.
- Rule 9 encodings: 32-byte hashes + EVM addresses = lowercase `0x`-hex fixed length.

### 2.2 Hashing (§17.2 Rule 12, §17.4) — domain tags frozen on first commit
```
canonical_record_hash = keccak256( keccak256("LEDGERLINE_CANONICAL_RECORD_V1") || lcj(record) )
schema_hash           = keccak256( keccak256("LEDGERLINE_SCHEMA_DESCRIPTOR_V1") || lcj(schema_descriptor) )
metadata_policy_hash  = keccak256( keccak256("LEDGERLINE_METADATA_POLICY_V1")   || lcj(metadata_policy_descriptor) )
data_availability_uri_hash = keccak256( keccak256("LEDGERLINE_DATA_AVAILABILITY_URI_V1") || lcj({uri}) )
batch_id              = keccak256( keccak256("LEDGERLINE_BATCH_ID_V1") || tenant_commitment(32) || uint64_be(batch_number)(8) || merkle_root(32) )
tenant_commitment     = keccak256( keccak256("LEDGERLINE_TENANT_COMMITMENT_V1") || tenant_salt(32) || utf8(tenant_id) )   // §16 salted; salt from 0005
```
(`batch_id` and `tenant_commitment` are **raw byte concatenation**, not LCJ. Only record + descriptor
hashes use LCJ.)

### 2.3 Merkle (§17.3) — `merkleRoot(leafHashes)`, `merkleProof(leafHashes, index)`, `verifyProof(...)`
- `leaf_hash = keccak256(0x00 || canonical_record_hash)`; `node_hash = keccak256(0x01 || left32 || right32)`.
- RFC-9162 recursive split: empty batch **disallowed**; 1 leaf → its leaf_hash; n>1 → `k` = largest
  power of two `< n`, `node_hash(MTH(D[0:k]), MTH(D[k:n]))`. **No Bitcoin odd-leaf duplication.**

### 2.4 Closed leaf schemas (§17 Rule 10) — the two committable record types for M4
Define explicit `schema_version`'d field sets (all numerics as decimal strings; timestamps as
integer-ms decimal strings per Rule 4; never raw URLs/names — §12 never-commit list):
- `revenue_event_leaf.v1`: `{ schema_version, id, tenant_commitment, interaction_id, revenue_source,
  gross_amount_atomic, asset, network?, revenue_status, earned_at_ms }`.
- `ledger_entry_leaf.v1`: `{ schema_version, id, tenant_commitment, journal_transaction_id, txn_type,
  revenue_treatment, account_type, owner_type, owner_id?, direction, amount_atomic, asset,
  effective_at_ms }` — note `account_name`/`memo` carry role strings and are **excluded** from the
  leaf (kept in the off-chain verifier package only), honoring the never-commit list.

### 2.5 schema_descriptor + metadata_policy_descriptor (§17.4) — committed preimages
`schema_descriptor`: LCJ version, hash-fn id (`keccak256`), Merkle-tree version, leaf record types +
schema versions in the batch, canonical field-order policy, encoding rules, domain-separation scheme,
**batch ordering rule**. `metadata_policy_descriptor`: which fields raw/hashed/encrypted/omitted,
envelope version, retention/redaction policy version. Both frozen and reproduced by the verifier.

### 2.6 Leaf ordering & the mixed-batch key (§17.3, D-0008)
Mixed batch ordering = `canonical_batch_order_key` = `(record_type_rank, type_key)` where rank 0 =
`revenue_event` (ordered by `id`), rank 1 = `ledger_entry` (ordered by `effective_at_ms`, then
`journal_transaction_id`, then `id`) — i.e. the §17.3 ledger order, prefixed by type rank. The ordering
rule is part of `schema_descriptor`. (Ledger-only batch is the documented fallback if mixed proves
fiddly; both keep all legs of one journal co-located per Invariant 11.)

### 2.7 Cross-language test vectors (§17.5) — mandatory, ship as JSON fixtures
`packages/canonical/vectors/*.json`, each `{ input, expected_lcj (utf-8/hex), expected_canonical_record_hash,
expected_leaf_hash }`, covering the full §17.5 list: simple revenue event, principal/gross journal txn,
agent/net journal txn, optional-omitted, boolean, max-size atomic string, unicode-preserved, rejected
null / bare-number / unknown-field / duplicate-key, odd-leaf tree, three-leaf proof, previous-root chain.
These are the cross-impl contract (and the future Solidity/Go verifier contract).

---

## 3. Migration `0005_commitment_batches.sql`

Verbatim §7.12 `commitment_batches` DDL (idempotent `create table if not exists`): `batch_number bigint`,
`batch_type text` (`mixed` for the demo), `from_event_seq`/`to_event_seq` (null for mixed),
`event_count int check (>0)`, `previous_merkle_root`/`merkle_root`/`schema_hash`/`metadata_policy_hash`
`bytea check (octet_length=32)`, `data_availability_uri_hash bytea` (nullable, 32 if present),
`arc_chain_id bigint`, `arc_contract_address text`, `arc_tx_hash text`, `committed_at timestamptz`,
`unique (tenant_id, batch_number)`. Plus, for M4 bookkeeping (not in §7.12, added with comments):
- `batch_id bytea check (octet_length=32)` — the derived contract key (reproducible; stored for joins).
- `status text not null default 'built' check (status in ('built','committed'))` — built locally vs
  on-chain confirmed.
- a `batch_leaves` join table: `(batch_id_fk, leaf_index int, record_type text, record_id uuid,
  leaf_hash bytea check octet_length=32)` so the verifier-package generator can reproduce the exact
  committed leaf set + ordering. (Records which rows went into which batch; the "un-committed" query
  is `revenue_events/ledger_entries NOT IN (select record_id from batch_leaves)`.)
- **`tenants.tenant_commitment_salt bytea`** added here (nullable; §16 salted commitments), with a
  deterministic seed for the demo tenant via `update … where … is null` guarded to stay idempotent
  (or a dedicated seed file `0006`). First-batch `previous_merkle_root` = 32 zero bytes.

> Note: `batch_id`/`status`/`batch_leaves` are an M4 superset of §7.12 (which only sketched the core
> columns). Flag in the plan-audit that this extends canonical schema; all additive, no rewrite.

---

## 4. `@ledgerline/anchor` — batch builder + on-chain client + verifier (DB-aware)

New package `packages/anchor/`. Deps: `@ledgerline/canonical` (workspace), `pg` (direct), `viem`
(on-chain client + Arc Testnet chain). Type-only `Db` from `seller-client`.

### 4.1 Batch builder (`buildBatch`) — Invariant 11 enforced
- Select un-committed `revenue_events` (status `earned`) + their recognition `journal_transactions` +
  all `ledger_entries` for those journals, scoped by tenant. **Group by `journal_transaction`; a
  journal's full leg set is atomic** — never split across batches (Invariant 11; reject a partial set).
- Map each row → its closed leaf record (§2.4) with `tenant_commitment` + `_ms` timestamps; order by
  the mixed `canonical_batch_order_key` (§2.6); compute `leaf_hash[]` → `merkle_root`.
- Resolve `previous_merkle_root` = tenant's latest committed `merkle_root` (or 32 zero bytes for the
  first batch); compute `schema_hash`, `metadata_policy_hash`, `batch_id`.
- Persist a `commitment_batches` row (`status='built'`) + `batch_leaves`. Idempotent on
  `(tenant_id, batch_number)`; re-running with no new records is a no-op.

### 4.2 On-chain client (`onchain.ts`, viem) — Track-A-gated
- `getCommitterClient()` reads `ARC_RPC_URL` + `ANCHOR_COMMITTER_KEY` + `ANCHOR_CONTRACT_ADDRESS`;
  returns null + a clear "blocked on Track A" message when absent (mirrors `demo-buyer`).
- `submitBatch(batch)` → `commitBatch(...)` write; records `arc_tx_hash`, `arc_chain_id`,
  `arc_contract_address`, `committed_at`, flips `status='committed'`.
- `readLatestRoot(tenantCommitment)` / `readBatch(batchId)` for the verifier `--onchain` path.

### 4.3 CLIs (root scripts)
- `anchor:build` → `buildBatch` (DB-local, always runnable).
- `anchor:submit` → `submitBatch` (gated; prints the Track-A notice + exits 0 without creds).
- `verify` → run the verifier on a `--revenue-event <id>` (offline by default; `--onchain` reads the
  live root).
- `vectors:check` → assert the §17.5 vectors (also a vitest).

### 4.4 Verifier package generator (`verifier-package.ts`, §12)
For a given `revenue_event`, emit a self-contained bundle: disclosed redacted records
(`revenue_event.json`, `ledger_entries.json`, `interaction.json`, `service_delivery.redacted.json`,
`x402_payment_artifact.redacted.json` — the **Path-C analog**, never "signed receipt"),
`commitment_leaf.json`, `merkle_proof.json`, `arc_batch.json` (batch metadata + `batch_id` + roots +
`arc_tx_hash`), and `verification.md` (human-readable, no-overclaim copy).

### 4.5 Verifier (`verify.ts`) — the 14-step §17.6 checklist, Path-C re-scoped (see §7)

---

## 5. `contracts/` — `RevenueBatchAnchor.sol` (Foundry, MIT)

`forge init --force` in `contracts/`; OpenZeppelin remapping for `AccessControl`. Implement the §12
contract verbatim:
- `COMMITTER_ROLE`; `struct Batch{ tenantCommitment, batchId, batchNumber(uint64), previousMerkleRoot,
  merkleRoot, eventCount(uint64), schemaHash, metadataPolicyHash, dataAvailabilityUriHash,
  committedAt(uint64) }`; `mapping(bytes32=>Batch) batches`; `mapping(bytes32=>bytes32) latestRootByTenant`;
  `event BatchCommitted(...)`; errors `BatchAlreadyCommitted`, `InvalidEventCount`, `PreviousRootMismatch`.
- `commitBatch(...) onlyRole(COMMITTER_ROLE)`: revert if `batches[batchId].committedAt != 0`; revert if
  `eventCount == 0`; revert if `latestRootByTenant[tenantCommitment] != previousMerkleRoot`; store;
  `latestRootByTenant[tenantCommitment] = merkleRoot`; emit. This is what enforces the previous-root chain
  on-chain.
- **Foundry tests** (`forge test`, runs locally today): happy-path commit; `BatchAlreadyCommitted`;
  `InvalidEventCount`; `PreviousRootMismatch`; multi-batch chain continuity; `COMMITTER_ROLE` access control.
- A `script/Deploy.s.sol` (Track-A-gated; needs `ARC_RPC_URL` + deployer key to actually broadcast).

---

## 6. Track A handoff (env) + the credential boundary

`.env.example` additions (Track A — live anchor only): `ARC_RPC_URL=`, `ANCHOR_COMMITTER_KEY=`
(testnet-only EOA granted `COMMITTER_ROLE`; USDC-gas on Arc), `ANCHOR_CONTRACT_ADDRESS=` (filled after
deploy). **Credential-free now:** `@ledgerline/canonical` (+ vectors), `buildBatch`, the verifier
(offline), and `forge test` all run with zero creds. **Track-A-gated:** `script/Deploy.s.sol` broadcast,
`anchor:submit`, and `verify --onchain`. When creds land, the live anchor lights up with no code change —
same pattern as M0's `SELLER_ADDRESS`/`BUYER_PRIVATE_KEY`.

---

## 7. Verifier checklist — exact §17.6 14-step Path-C re-scope

Honest mapping for the **Path-C analog** (no Circle-issued signed offer/receipt — D-0001):
- **0. Canonical reproduction** — re-`lcj` each disclosed record under the committed `schema_version`/
  `schema_hash`; recomputed `canonical_record_hash` + `leaf_hash` must match the proof bit-for-bit. *(full)*
- **1–3 (signed offer/receipt) → RE-SCOPED:** the `x402_payment_artifact` (`artifact_type='payment_signature'`)
  exists and its `artifact_hash` reproduces; the request-fingerprint ↔ payment-identifier binding holds.
  **Output says "Ledgerline receipt analog," never "Signed Receipt."** Official Path-A/B is deferred.
- **4** payment-identifier ↔ request fingerprint; **5** delivery ↔ interaction; **6** revenue ↔ paid delivery. *(full)*
- **7A** exact-pricing tie-out: `gross_amount_atomic == pricing_models.fixed_amount_atomic` (= M2 Invariant 2). *(full; 7B upto deferred)*
- **8B** principal_gross tie-out: seller revenue credit == gross; Σ(payable credits) == Σ(COGS/referral debits). *(full; 8A agent_net = test-only)*
- **9** journal balances per asset — **requires all legs in the committed batch (Invariant 11)**; a
  proof set missing a leg FAILS. *(full)*
- **10** split allocation matches the committed `split_group_version`. *(full)*
- **11** no Ledgerline fee as a value-chain recipient — **vacuous** (fee omitted in demo, Invariant 4).
- **12** `previous_merkle_root` == tenant's prior committed root (chain continuity; first batch = zero hash). *(full)*
- **13** leaf included in the Merkle root — offline: against the disclosed root in the package; `--onchain`:
  the disclosed root == on-chain `batches[batchId].merkleRoot` / `latestRootByTenant`. *(full)*
- **14** Arc tx final — **only with `--onchain`**; offline marks it "not checked (offline)".

---

## 8. Test plan

- **canonical (vitest):** LCJ rejects bare numbers/floats/null/unknown-fields/duplicate-keys; preserves
  strings/unicode; numeric-string regex; `canonical_record_hash` stable & matches vectors; `leaf_hash`
  derivation; descriptor-hash change-detection; full §17.5 vector set; Merkle (single=leaf, two=node,
  three-leaf RFC-9162 split, odd-not-duplicated, empty rejected, domain-prefix separation, tampered
  record/order fails proof, prev-root chain).
- **anchor (vitest, throwaway DB per `helpers.ts` pattern):** `buildBatch` Invariant-11 (whole journals;
  rejects partial leg set); deterministic mixed ordering; first-batch zero prev-root + chain on 2nd batch;
  verifier-package generator; **verifier 14-step PASS** on the demo revenue event; tampered leaf → step
  0/13 FAIL; broken chain → step 12 FAIL; missing leg → step 9 FAIL; no-overclaim copy assertion.
- **contract (`forge test`, local):** the 6 cases in §5.
- **e2e:** recognize the 2 live analogs → `anchor:build` → verifier package → `verify` PASS;
  (gated) `anchor:submit` → `verify --onchain` against the live root.

---

## 9. File-by-file change list

**New:**
- `packages/canonical/{package.json, tsconfig.json, src/index.ts, vectors/*.json, test/*.test.ts}` —
  LCJ v1, domain-tagged keccak hashing, Merkle, leaf schemas, §17.5 vectors. Dep: `@noble/hashes`.
- `packages/anchor/{package.json, tsconfig.json, src/index.ts (buildBatch + DAO), src/onchain.ts,
  src/anchor-cli.ts, src/verify.ts, src/verify-cli.ts, src/verifier-package.ts, test/*.test.ts}`.
  Deps: `@ledgerline/canonical`, `pg`, `viem`.
- `packages/db/src/migrations/0005_commitment_batches.sql` (+ `batch_leaves`, `tenants.tenant_commitment_salt`).
- `contracts/foundry.toml`, `contracts/src/RevenueBatchAnchor.sol`, `contracts/test/RevenueBatchAnchor.t.sol`,
  `contracts/script/Deploy.s.sol`, `contracts/remappings.txt`.

**Edited:**
- `package.json` — scripts `anchor:build`, `anchor:submit`, `verify`, `vectors:check`; add `@noble/hashes`.
- `vitest.config.ts` — alias `@ledgerline/canonical` + `@ledgerline/anchor` → their `src/index.ts`.
- `.env.example` — `ARC_RPC_URL`, `ANCHOR_COMMITTER_KEY`, `ANCHOR_CONTRACT_ADDRESS` (Track A).
- `DECISION_LOG.md` — D-0005..D-0008. `CLAUDE.md` — status → M4 in progress.

**Verify-only:** `migrate.ts` auto-picks 0005; `pnpm-workspace.yaml` auto-includes the new packages.

---

## 10. Explicitly deferred (NOT-M4)

- `seller-client` `raw_events` canonicalization retrofit (D-0006) — placeholder stays.
- Official x402 Signed Receipt (Path A/B) — verifier stays the Path-C analog.
- `raw_events`/`revenue_events`-only batch types (only the `mixed` demo batch ships).
- On-chain (Solidity) verifier — off-chain TS verifier only.
- Automatic commitment worker/poller (manual CLI, like `recognize`); ArcaneVM / private on-chain state;
  ZK proofs; multi-tenant enumeration hardening beyond the salt; P1 Gateway settlement reconciliation.

---

## 11. Verification (end-to-end)

```
pnpm db:up && pnpm db:migrate          # applies 0005 (commitment_batches, batch_leaves, salt)
pnpm test                              # canonical + anchor vitest (incl. §17.5 vectors, 14-step verifier)
(cd contracts && forge test)           # RevenueBatchAnchor unit tests (local; Foundry present)
pnpm recognize                         # ensure the 2 live analogs are recognized (idempotent)
pnpm anchor:build                      # build a mixed batch (revenue_event + its 8 ledger legs)
pnpm verify --revenue-event <id>       # offline 14-step → PASS
# Track A (when creds present):
(cd contracts && forge script script/Deploy.s.sol --broadcast --rpc-url $ARC_RPC_URL)
pnpm anchor:submit                     # commitBatch on Arc Testnet → arc_tx_hash
pnpm verify --revenue-event <id> --onchain   # disclosed root == on-chain root, tx final → PASS
```

Acceptance (build-plan M4): batch commits to Arc Testnet; inclusion proof verifies; modified event
fails proof; previous-root chain validates. Plus M4-specific: §17.5 vectors pass; verifier copy honors
no-overclaim; Invariant 11 holds (missing-leg proof fails).

---

## Post-approval workflow

1. **(done)** This plan saved as `docs/M4_PLAN.md`.
2. Run the plan-audit + `/review`-style adversarial pass on `docs/M4_PLAN.md` (same loop that hardened
   the M2 plan/build), focusing on: LCJ determinism vs the §17.5 vectors, Invariant-11 batch atomicity,
   the Path-C verifier re-scope, the schema-superset flag (§3), and the Track-A gating.
3. Implement against the audited plan; keep everything green (vitest + `forge test`) at each step.
