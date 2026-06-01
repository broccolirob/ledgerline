# Ledgerline — Threat Model (T1–T16)

Maps the build-plan §16 threats to their **current status** in the shipped demo (M0–M5), with the
specific code or test that backs each claim. Status is deliberately honest — the security test suite
(`pnpm test:security`) is the cross-check: every **TESTED** row maps to a passing test, and every
**DEFERRED** control that could be mistaken for present has a *negative* test proving its absence
(e.g. T6).

**Legend**
- **ENFORCED** — a mechanism in shipped code prevents this.
- **TESTED** — ENFORCED *and* covered by an automated test.
- **PARTIAL** — mitigated in the MVP but with a named, deliberate gap.
- **DEFERRED** — schema/design accounts for it; runtime not built (named milestone).

Scope note: the demo is **Path C** (the Ledgerline receipt analog), runs one Express seller + a local
recognition pass + the Arc anchor. There is **no hosted ingestion API, no API-key layer, and no
adapter-event signature verification** yet — those are M6+. This document does not pretend otherwise.

---

| # | Threat | Status | Backing (code / test) |
|---|--------|--------|------------------------|
| **T1** | Payment-Identifier replay against a different request | **TESTED** | Request fingerprint binds tenant+endpoint+method+resource+amount+payTo (`seller-client/src/index.ts` `computeRequestFingerprint`); `interactions.unique(tenant_id, payment_identifier)` (migration 0003) + the recognize idempotency gate. Tests: `recognition.security.test.ts` "T1 — request fingerprint binding" (amount/path change → different fingerprint). |
| **T2** | Duplicate payment processing after retry | **TESTED** | `journal_transactions.unique(tenant_id, posting_key)` + the single-transaction interaction-existence gate (`recognition/src/index.ts` `recognizeOne`); `batch_leaves.unique(tenant_id, record_type, record_id)` blocks double-commit. Tests: M2 `recognize.db.test.ts` replay no-op; M4 `anchor.db.test.ts` build idempotency. |
| **T3** | Payment verified/settled but service not delivered | **TESTED** | Recognition fires only on `payment.verified === true AND delivery.status === 'delivered'` (2xx); else the F1 failure-record path, no revenue/journal. Tests: M2 `recognize.db.test.ts` F1 (failed / unverified-2xx / canceled). |
| **T4** | Service delivered but signed receipt missing | **PARTIAL (by design — Path C)** | No official x402 Signed Receipt exists in the demo (D-0001); the verifier asserts the **Ledgerline receipt analog** (`artifact_type='payment_signature'`) and says so explicitly — never "Signed Receipt". Verifier steps 1–3, `anchor/src/index.ts` `verify`. Official receipts = the deferred Path-B milestone. |
| **T5** | Metadata leakage via resourceUrl/query/prompt/reason | **PARTIAL** | Capture hashes sensitive fields (`resourceHash`, `payerHash`, `paymentSignatureHash`; raw values never stored in public columns — `seller-client/src/index.ts`). The full §9 **encryption envelope** (encrypted off-chain blob + KMS) is **deferred (M6+)**. |
| **T6** | Seller adapter spoofing / event forgery | **DEFERRED — NOT a control yet (M6)** | `raw_events.adapter_key_id` / `adapter_signature` columns exist but are **written null and never verified**. The recognition pass authenticates nothing about the capturing adapter. **Negative test** `recognition.security.test.ts` "T6 — adapter-event signing is NOT verified" asserts the gap so this row cannot drift into a false claim. Closing it (sign + server-side verify) is the headline M6 item. |
| **T7** | Split-rule tampering after revenue is earned | **TESTED** | Splits use versioned `split_groups`/`split_rules`; allocations are immutable (insert-only, append-only reversals); the journal's leaves are committed to the Arc Merkle root, so post-hoc edits fail verification. The verifier's step-0 canonical reproduction + step-10 split-version check (`anchor/src/index.ts` `verify`) detect tampering. Tests: `anchor.db.test.ts` tampered-leaf → step 0 FAIL; a changed `gross_amount_atomic` → step 0 + step-7 exact-pricing tie-out FAIL; a **value-preserving split reshuffle** (100 atomic moved between two payable credits) → step 9 still BALANCES yet step 0 FAILS — i.e. the Arc Merkle root, not the accounting invariants alone, is what catches a reallocation. |
| **T8** | Rounding/dust exploitation in tiny payments | **TESTED** | Integer-only bigint allocation; dust folded deterministically into the publisher; rule set must sum to exactly 10000 bps (over- and under-allocation both rejected). `recognition/src/index.ts` `allocateSplit`. Tests: `recognition.security.test.ts` "T8" (overflow + under-sum rejected; value conserved across many gross amounts incl. 1e18+7). |
| **T9** | Arc commitment leaks sensitive metadata | **TESTED** | Leaves commit only hashes + non-sensitive fields; the §12 never-commit set (`account_name;memo;units;raw_urls;customer_id`) is excluded by the leaf builders (`canonical/src/index.ts` `revenueEventLeaf`/`ledgerEntryLeaf`, `omitted_from_leaf` descriptor). Only roots + policy hashes go on-chain. Tests: `canonical.security.test.ts` + `anchor.security.test.ts` "T9" (leaf bytes contain no banned field; package batch metadata is hashes-only); `recognition.security.test.ts` "T9 (export)" — the finance CSVs the CLI writes carry no raw resource path / URL / prompt / payer address, and their column headers are exactly the published schema (so no surprise column could ever leak a field). |
| **T10** | Signing-key compromise | **PARTIAL** | The Arc committer is a single dedicated testnet EOA (distinct from payment-rail wallets, D-0010); the contract exposes `revokeRole` to evict a compromised committer (`RevenueBatchAnchor.sol`, forge test `testRevokeRole`). KMS/multisig custody is **deferred**. The receipt-analog signing key (Path B) is not in the demo. |
| **T11** | Cross-tenant data leakage | **TESTED** | Every query is `where tenant_id = $1`; `batch_leaves` is partitioned by `tenant_id` and `buildBatch` filters on it; tenant_commitment is salted per tenant. Tests: `anchor.security.test.ts` "T11" seeds + recognizes BOTH tenant A and tenant B, builds a batch for each, and asserts A's batch contains A's revenue_event and NOT B's (and symmetrically), that batches are distinct, no cross-tenant FK, and A/B derive distinct salted tenant_commitments — i.e. it would fail if `buildBatch`'s tenant filter were removed. |
| **T12** | Seller instrumentation misreports usage metrics | **PARTIAL (MVP trust)** | The MVP trusts seller-reported delivery units (the seller is the first customer). Supplier-facing payouts that depend on units are **deferred**; verifiable upstream usage evidence is an M6+ concern. Documented, not enforced. |
| **T13** | SIWX repeat access incorrectly creates new revenue | **DEFERRED (schema-ready)** | `access_grants`/`access_events` exist schema-only; the SIWX runtime flow is not built. The recognition path only recognizes `x402_purchase`, so no SIWX double-count is possible today. Full flow = post-demo. |
| **T14** | Gateway transfer matching ambiguity | **DEFERRED (design-only)** | Per-call x402 events are the source of truth in the MVP; Gateway transfer-query reconciliation is designed (a `SettlementProvider` boundary) but not built, and the hosted backend never holds seller keys. |
| **T15** | Settlement-state race (P1 cash collection vs F2 reversal) | **DEFERRED (gated on the cash milestone)** | There is no P1/F2 path in the demo (recognition only; `revenue_collection_state` stays `open_receivable`), so no race exists yet. Invariant 10's lock discipline (consistent lock order, closed-state check) is documented for when P1/F2 ship (M2 plan §5.2 / build-plan §18.15). |
| **T16** | Canonicalization-determinism divergence | **TESTED** | LCJ v1 pins serialization (sorted keys, no bare numbers/floats/null, strings as-is); keccak256 + 0x00/0x01 leaf/node domain separation; frozen §17.5 vectors are the cross-language contract. `canonical/src/index.ts`; `pnpm vectors:check` + `canonical/test/vectors.test.ts` fail on any byte drift. Tests: `canonical.security.test.ts` parse-boundary fuzz (malformed input rejected, no NUL coercion). |

---

## Honest summary

- **Strong now (TESTED):** T1, T2, T3, T7, T8, T9, T11, T16 — the recognition→ledger→Arc-anchor core is
  replay-safe, value-conserving, tenant-isolated, metadata-minimized on-chain, and
  determinism-pinned, each with a test.
- **Mitigated with a named gap (PARTIAL):** T4 (Path C analog, not official receipt), T5 (hashed but
  no encryption envelope), T10 (single committer EOA + revoke; no KMS), T12 (units trusted in MVP).
- **The one to close next (T6):** adapter events are not authenticated server-side. It is the
  single most defensible M6 addition; until then the negative test keeps this document honest.
- **Deferred by design (T13/T14/T15):** SIWX, Gateway reconciliation, and the P1/F2 cash race gate on
  post-demo milestones; none can fire in the current demo surface.

Re-verify with: `pnpm test:security` (the per-threat tests) + `pnpm vectors:check` + `pnpm contracts:test`.
