# Ledgerline Milestone 2 — Revenue Recognition + Double-Entry Posting Engine

**Implementation PLAN (approve before coding). No production code below — exact DDL, signatures, and posting-template shapes only.**

> **Post-review revisions (2026-05-29).** Three fixes folded in after a plan/codebase audit:
> 1. **Seed idempotency (HIGH).** `split_rules` has only a `uuid` PK and no natural unique key, and `migrate.ts` re-runs every `*.sql` on every invocation — so a bare `on conflict do nothing` would *not* dedupe it, and each migrate would insert four more rules and corrupt the split. `0004` now seeds `split_rules` with **deterministic literal UUIDs** + `on conflict (id) do nothing`; `pricing_models` / `split_groups` conflict on their `(tenant_id, name, version)` natural key (§2 preamble, §2.2, §8, §7.2 seed-idempotency test).
> 2. **`resolveLedgerAccount` conflict/return contract (MED).** Pinned the insert→`on conflict (<exact natural-key expression>) do nothing`→`select` fallback, since `do nothing` returns no row on a hit and the unique key is an *expression* index (§2.3, §4.2).
> 3. **`endpoint_id` is NULL in M2 (LOW).** No `seller_endpoints` row is seeded and `RecognitionConfig` carries no endpointId, so both `interactions.endpoint_id` and `service_deliveries.endpoint_id` are written NULL against their nullable FKs (§2.4).

Milestone-label note: the build plan numbers the §18.3 ledger DDL + posting templates + invariants as its "Milestone 3 — split accounting"; the prompt collapses recognition (build-plan Milestone 2 "revenue subledger") and posting (build-plan Milestone 3 "split accounting") into one milestone called **M2**. This plan implements that combined scope: a delivered, paid `raw_event` becomes an `earned` `revenue_event` **and** a balanced `journal_transaction` + `ledger_entries`. Integer atomic-unit math only; no-overclaim discipline throughout.

**Repo facts this plan is built against (verified against the live tree):**
- `raw_events.id` is `text primary key` (0001_init.sql), supplied by `randomUUID()` as a string — **not** a `uuid` column. New M2 tables use `uuid` PKs supplied by the recognition module via `randomUUID()`; nothing FKs or joins `raw_events.id` as uuid.
- `raw_events.event_seq` is `bigserial` with **no** `not null` and **no** index. `pg` returns `bigserial`/`numeric` columns as JS **strings** by default.
- All payload hashes written by `@ledgerline/seller-client` are **`0x`-prefixed hex** (`sha256hex` returns `'0x' + digest`): `requestFingerprint`, `payment.payerHash`, `payment.paymentSignatureHash`, `resourceHash`, `delivery.responseBodyHash`. `decode(value,'hex')` throws on a leading `0x`.
- The live recorder (`packages/express/src/index.ts`) maps `httpStatus<200||>=300` → `delivery.status='failed'` and only ever emits `'delivered'` or `'failed'` — never `'canceled'`. It captures `payment.verified` but the M1 path does not gate on it.
- `@ledgerline/seller-client` has **no runtime `pg` dependency** (only `@types/pg` devDep); its `Db` export is a **type-only** re-export of `pg`'s `Pool | PoolClient`. Its only runtime exports are `canonicalHash` and `allocateOneSplit` (a `number`-based helper returning `{publisher, modelProvider, dataProvider, marketplaceReferrer}` — **not reusable** for the bigint allocator M2 needs).
- `0002_seed_demo_tenant.sql` seeds only the tenant. There is **no** seeded `seller_endpoints` row, and `seller_endpoints.default_pricing_model_id` / `default_split_group_id` are plain `uuid` columns with **no FK**.
- `migrate.ts` sends each whole `*.sql` file as one `client.query(sql)` (simple-query protocol → implicit transaction, Postgres splits on `;`, no bind parameters). It re-runs **every** file on every invocation with no applied-tracking table.
- `tsconfig.base.json`: `module/moduleResolution=NodeNext`, `verbatimModuleSyntax: true`, `isolatedModules: true`, `strict`, `noUncheckedIndexedAccess`. Packages export raw TS (`exports: './src/index.ts'`), run via `tsx`, no build step.
- Root `package.json` has **no** test runner / test script. Node `>=22`, pnpm 10.

---

## 1. Overview + recognition data flow

### 1.1 Goal

Turn one DELIVERED (2xx) verified+settled paid `raw_event` — the M1 "receipt analog" — into:

1. an `interaction` (the request/payment/delivery anchor),
2. an `x402_payment_artifact` (the payment-signature analog hash + settlement reference),
3. a `service_delivery` (the 2xx delivery record),
4. a `revenue_event` with `revenue_status = earned`,
5. a balanced `journal_transaction` (`txn_type = recognition`, `revenue_treatment = principal_gross`) + its `ledger_entries`,
6. a `revenue_collection_state` row at `status = open_receivable`.

"A subledger, not middleware": this runs **off** the response critical path, reading already-persisted `raw_events`.

### 1.2 Data flow

```
raw_events (event_type='ledgerline.receipt_analog.v1', event_source='seller_sdk')
   │   payment.verified == true  AND  delivery.status == 'delivered' (httpStatus 2xx)  →  recognize
   │   delivery.status == 'failed'  (or, forward-compat, 'canceled')                    →  F1: failure record, NO journal txn
   │   payment.verified == false                                                        →  F1: failure record, NO journal txn
   ▼
interactions          (interaction_type='purchase', status='delivered')
   ├──► x402_payment_artifacts  (artifact_type='payment_signature', amount/settlement_reference)
   └──► service_deliveries      (delivery_status='delivered', http_status)
   ▼
revenue_events        (revenue_source='x402_purchase', revenue_status='earned',
                       gross_amount_atomic = payment.amountAtomic, asset='USDC')
   ▼  R1′ principal_gross posting template (§18.7) + split allocation (3000 → 2100/600/210/90)
journal_transactions  (txn_type='recognition', revenue_treatment='principal_gross',
                       posting_key='recognition:<revenue_event_id>')
   └──► ledger_entries   (8 legs; ΣDr = ΣCr = 3900 per asset)
   ▼
revenue_collection_state  (status='open_receivable')   ← stays here in M2 (P1 deferred)
```

**Gross amount source (resolving the §18 tie-out precisely).** §18.2/§18.7/Invariant 2 define the exact-pricing tie-out as `revenue_event.gross_amount_atomic = signed_offer.amount`. Per no-overclaim, **there is no Circle-issued signed offer**, and the receipt-analog payload carries no offer amount. Therefore in M2:
- `gross_amount_atomic := payment.amountAtomic` — the **settled** atomic amount, which stands in for `signed_offer.amount` because no signed offer exists. This settled amount is the authoritative source.
- M2 **also** asserts the config tie-out `gross_amount_atomic == pricing_models.fixed_amount_atomic` for the exact pricing model (Invariant 2; demo = 3000). A mismatch fails recognition (the seller's configured price disagrees with what was settled).
- The true signed-offer tie-out is **deferred** with the signed-offer artifact (no such artifact exists in M1/M2).

### 1.3 Two state machines

`revenue_status` (recognition/accrual) and `collection_state.status` (cash/settlement) are **distinct lifecycles** (§18.3) read together at reconciliation time.

| Trigger | `revenue_status` | `collection_state.status` | In M2? |
|---|---|---|---|
| R1′ recognition (this milestone) | `earned` | `open_receivable` | **YES** |
| P1 cash collection | `earned` (unchanged) | `cash_collected` | deferred |
| F2 pre-cash reversal | `reversed` | `reversed_closed` | deferred |
| F2 post-cash reversal | `refunded` | `refund_payable` | deferred |
| manual intervention | (unchanged) | `manual_review` | deferred |
| F1 verified-but-not-delivered / unverified | (no `revenue_event`) | (no `collection_state`) | **YES (no-journal; failure record only)** |

In M2, `collection_state.status` is **always written as `open_receivable` and never advances** — there is no P1 worker, so the receivable is never collected. The table exists now (rather than deferred) because §18.3 explicitly notes the implementation needs "one lockable state record per revenue event or receivable" and lists it as the **optional** collection-state table; M2 chooses create-not-defer **purely for lockability** (it is the future `SELECT … FOR UPDATE` target for P1/F2 + Invariant 10). The `cash_collection_txn_id` / `reversal_txn_id` columns ship and are **never written** in M2. Allowed states are written into the CHECK now; only `open_receivable` is reachable in M2.

---

## 2. Schema — migration `0003_revenue_recognition.sql`

New file: `/Users/broccolirob/Projects/ledgerline/packages/db/src/migrations/0003_revenue_recognition.sql`.

**Idempotency requirement (hard constraint from the runner):** `migrate.ts` re-runs every `*.sql` on every invocation with no applied-tracking table, sending the whole file as one `client.query()` (simple-query protocol; Postgres splits statements on `;`; no bind parameters allowed anywhere in the file). **Every statement must use `create table if not exists` / `create index if not exists` / `insert … on conflict do nothing`.** Inline `check (…)` clauses inside a `create table if not exists` are safe on re-run (the table is skipped if present); do NOT use `alter table … add constraint` (not idempotent without a guard). A single statement error aborts the whole file's implicit transaction, so the `if not exists` guards must all hold on re-run.

**`on conflict do nothing` only dedupes against a constraint that actually fires.** It is a no-op guard, not a magic idempotency switch: an `insert` "does nothing" on re-run only if it violates a real PK/UNIQUE constraint. A seed row therefore needs *either* a natural unique key to conflict on *or* a deterministic literal PK — otherwise the re-run-every-time runner inserts a fresh duplicate every invocation. This bites exactly one table here: `split_rules` has only a `uuid` PK and **no** natural unique key (§2.2), so its seed must use deterministic literal UUIDs and `on conflict (id) do nothing`. `pricing_models` and `split_groups` are safe via their `(tenant_id, name, version)` unique key. Runtime-created `ledger_accounts` dedupe via the natural-key index (§2.3); every other M2 table is written only by the recognition pass, which makes re-runs no-ops via `posting_key` and the other unique constraints (§4.3) — none of them are seeded.

Use `uuid` PKs with no DB-side default generation (the recognition module supplies `randomUUID()`). New tables intentionally use `uuid` PKs; `raw_events.id` stays `text` (legacy) and is never coerced to uuid. `numeric(78,0)` for all atomic amounts, parsed in TS via integer-safe paths (see §4.4).

Order within the file matters (FK targets first): `pricing_models`, `split_groups`, `split_rules`, `ledger_accounts`, `interactions`, `x402_payment_artifacts`, `service_deliveries`, `revenue_events`, `journal_transactions`, `ledger_entries`, `revenue_collection_state`. (`journal_transactions` references `revenue_events`, `interactions`, `split_groups`; `ledger_entries` references `journal_transactions` + `ledger_accounts`; `revenue_collection_state` references both `revenue_events` and `journal_transactions`.)

> `journal_transactions` in §18.3 also FKs `billing_fee_schedules(id)`. That table is **deferred** (B1, Invariant 4). M2 declares `billing_fee_schedule_id uuid` as a plain nullable column **with no FK** (commented note that the FK lands when B1 ships), so 0003 stays self-contained and does not pull billing into scope.

**Runtime-restriction note (schema vs. behavior).** The DDL CHECKs below fully specify deferred surfaces (`upto`/`usage_metered` pricing branches; `reserve_treatment` enum; `agent_net`; `fixed_amount_atomic` / `match_conditions` / `priority` / `rounding_mode` on `split_rules`). These are the **canonical §7.3/§7.10/§18.3 column shapes and are schema-only in M2**: at runtime `pricing_type` is restricted to `exact`, `revenue_treatment` to `principal_gross`, `reserve_treatment` to `none`; mixed fixed+percentage split-base semantics are **rejected at runtime** (deferred §18.14, §18.17). Keeping the full CHECKs (cheap, canonical) does not put those behaviors in scope.

### 2.1 `pricing_models` (§7.3 — exact only at runtime)

```sql
create table if not exists pricing_models (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  name text not null,
  version integer not null,
  pricing_type text not null check (pricing_type in ('exact', 'upto', 'usage_metered')),
  asset text not null default 'USDC',
  network text,
  fixed_amount_atomic numeric(78,0),
  max_amount_atomic numeric(78,0),
  unit_name text,
  unit_price_atomic numeric(78,0),
  active boolean not null default true,
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  check (
    (pricing_type = 'exact'
       and fixed_amount_atomic is not null and fixed_amount_atomic > 0)
    or
    (pricing_type = 'upto'
       and max_amount_atomic is not null and max_amount_atomic > 0)
    or
    (pricing_type = 'usage_metered'
       and max_amount_atomic is not null and max_amount_atomic > 0
       and unit_price_atomic is not null and unit_price_atomic > 0
       and unit_name is not null)
  ),
  check (fixed_amount_atomic is null or fixed_amount_atomic > 0),
  check (max_amount_atomic is null or max_amount_atomic > 0),
  check (unit_price_atomic is null or unit_price_atomic > 0),
  unique (tenant_id, name, version)
);
```

M2 only ever writes `pricing_type='exact'` (runtime-restricted; `upto`/`usage_metered` branches are schema-only, deferred). Tie-out (Invariant 2, §1.2): `revenue_event.gross_amount_atomic == pricing_models.fixed_amount_atomic` (demo = 3000), asserted at runtime in `recognizeOne`.

### 2.2 `split_groups` + `split_rules` (§7.10)

```sql
create table if not exists split_groups (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  name text not null,
  version integer not null,
  revenue_treatment text not null
    check (revenue_treatment in ('principal_gross', 'agent_net')),
  reserve_treatment text not null default 'none'
    check (reserve_treatment in (
      'none',
      'seller_holdback',
      'contra_revenue',
      'refund_liability',
      'pass_through_liability',
      'supplier_payable_holdback'
    )),
  effective_from timestamptz not null,
  effective_to timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, name, version)
);

create table if not exists split_rules (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  split_group_id uuid not null references split_groups(id),
  recipient_id uuid not null,
  role text not null,
    -- canonical role set (§18.2): publisher, model_provider, data_provider, tool_author,
    --            referrer, marketplace, infra, facilitator. NO 'platform' value.
  percentage_bps integer check (percentage_bps is null or (percentage_bps between 0 and 10000)),
  fixed_amount_atomic numeric(78,0) check (fixed_amount_atomic is null or fixed_amount_atomic > 0),
  priority integer not null default 100,
  match_conditions jsonb,
  rounding_mode text not null default 'largest_remainder',
  created_at timestamptz not null default now(),
  check (
    (percentage_bps is not null and fixed_amount_atomic is null)
    or
    (percentage_bps is null and fixed_amount_atomic is not null)
  )
);
```

M2 enforces `revenue_treatment='principal_gross'`, `reserve_treatment='none'` at runtime. `fixed_amount_atomic` / `match_conditions` / `priority` / `rounding_mode` are schema-present but the mixed fixed+percentage base semantics are runtime-rejected (deferred §18.14). Demo group is pure-percentage (`publisher` 7000 / `model_provider` 2000 / `data_provider` 700 / `referrer` 300 bps = 10000), so the deferred fixed-vs-percentage base ambiguity does not bite and dust is zero.

**Seed idempotency (no schema constraint added — keeps canonical §7.10 shape).** `split_rules` deliberately keeps only its `uuid` PK (no natural unique key), exactly as canonical §7.10. M2 never writes `split_rules` at runtime — it is **seed-only** (the recognition module *reads* the demo rules, §4) — so the PK alone is a sufficient idempotency anchor: `0004` seeds the four rows with **deterministic literal UUIDs** (constants in the SQL file) and `on conflict (id) do nothing`. *Considered and rejected:* adding `unique (split_group_id, recipient_id)` would also make the seed idempotent, but it would forbid the legitimate deferred case of one recipient holding both a fixed and a percentage rule (§18.14) — constraining a deferred design surface the plan is otherwise careful to leave open. Deterministic seed UUIDs close the hole without that cost.

### 2.3 `ledger_accounts` (§18.3 canonical — supersedes §7.11)

```sql
create table if not exists ledger_accounts (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  account_type text not null check (account_type in (
    'asset_cash',
    'receivable',
    'revenue',
    'contra_revenue',
    'expense_cogs',
    'expense_referral',
    'expense_software_fee',
    'payable',
    'refund_payable',
    'reserve'
  )),
  owner_type text not null check (owner_type in (
    'seller',
    'supplier',
    'platform',
    'reserve',
    'vendor',
    'customer'
  )),
  owner_id uuid,
  asset text not null,
  name text not null,
  created_at timestamptz not null default now()
);
```

Distinct supplier/referrer payables all share `account_type='payable'` and are disambiguated by `(owner_type, owner_id)` (§18.3: they are *not* separate `account_type` values). Add a partial unique index to make account resolution deterministic and idempotent:

```sql
create unique index if not exists ledger_accounts_natural_key
  on ledger_accounts (tenant_id, account_type, owner_type, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), asset);
```

**Account resolution — the `on conflict` contract (load-bearing for `resolveLedgerAccount`, §4.2).** Because the unique key is an **expression** index, `resolveLedgerAccount`'s `insert … on conflict (…) do nothing` must restate the *exact* inference expression — `(tenant_id, account_type, owner_type, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), asset)` — to match the index, and seller-owned legs must bind `owner_id` as the same sentinel (`'00000000-0000-0000-0000-000000000000'::uuid`) so they collapse onto one row. `on conflict do nothing` returns **no** row on a hit, so account resolution uses the same insert→do-nothing→`select` fallback as `interactions` / `revenue_events` (§4.3), never assuming `RETURNING` produced a row.

**Canonical-account fidelity (§18.3 "Recommended accounts"), load-bearing for the live R1′ path.** The natural-key index keys on `owner_id`; to avoid silently fanning out per-supplier expense accounts, the live R1′ path resolves these **single seller-owned** accounts (owner_type=`seller`, owner_id=NULL) for all expense legs:
- `Receivable — seller` = (`receivable`, `seller`, NULL)
- `Revenue — seller` = (`revenue`, `seller`, NULL)
- `COGS — seller` = (`expense_cogs`, `seller`, NULL) — **one** account; per-supplier distinction lives in the leg `memo` only, not in a separate account.
- `Referral / marketplace expense` = (`expense_referral`, `seller`, NULL) — **one** seller-owned account.

Supplier/referrer **payables** are the only per-recipient accounts on the live path:
- `Payable — <supplier>` = (`payable`, `supplier`, owner_id=`recipient_id`) — used identically for `model_provider`, `data_provider`, and `marketplace/referrer`.

`owner_type='platform'` has **no live use in M2** (it is reserved for seller-operated platform-fee accounts, §18.2/§18.3; there is no `platform` value-chain role). The live R1′ path must **never** create a `platform`-owned account (locked by a test, §7.2).

### 2.4 `interactions` (§7.5)

```sql
create table if not exists interactions (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  endpoint_id uuid references seller_endpoints(id),
  interaction_type text not null, -- purchase, siwx_access, free, test
  request_fingerprint bytea not null,
  payment_identifier text,
  access_grant_id uuid,
  customer_hash bytea,
  payer_address_hash bytea,
  status text not null, -- pending, delivered, failed, canceled, disputed
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, payment_identifier)
);
```

M2 writes `interaction_type='purchase'`, `status='delivered'` on the recognize path; `status='failed'` (forward-compat `'canceled'`) on the F1 path for traceability. `payment_identifier` = the raw_events idempotency anchor (`settlementReference ?? paymentSignatureHash ?? requestFingerprint`), giving a natural per-purchase unique key. `request_fingerprint` and `payer_address_hash` are `bytea`: the hex is **`0x`-prefixed**, so the recognition module **strips the leading `0x` before `decode(hex, 'hex')`** (see §4.4). **`endpoint_id` is written NULL** in M2: no `seller_endpoints` row is seeded (§8) and `RecognitionConfig` carries no endpointId, so both `interactions.endpoint_id` and `service_deliveries.endpoint_id` (§2.6) are left NULL against their nullable FKs. Wiring endpoint defaults is an explicit M1-seed touch, out of M2 scope (§8).

### 2.5 `x402_payment_artifacts` (§7.6)

```sql
create table if not exists x402_payment_artifacts (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  interaction_id uuid references interactions(id),
  artifact_type text not null, -- signed_offer, payment_signature, signed_receipt
  artifact_hash bytea not null,
  encrypted_artifact_uri text,
  network text,
  asset text,
  amount_atomic numeric(78,0),
  pay_to_address text,
  payment_identifier text,
  settlement_reference text, -- opaque; do not assume tx hash
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, artifact_type, artifact_hash)
);
```

M2 writes one row, `artifact_type='payment_signature'` (no-overclaim: there is no Circle-issued `signed_offer`/`signed_receipt`). `artifact_hash` = `payment.paymentSignatureHash` (preferred; `0x`-stripped, decoded), falling back to `requestFingerprint` bytes if absent. `amount_atomic` = `payment.amountAtomic`; `settlement_reference` = `payment.settlementReference`.

**Weak-anchor caveat (parity with the interaction/posting_key dedupe).** The artifact unique key `(tenant_id, artifact_type, artifact_hash)` inherits M1's documented weak-anchor caveat: two distinct purchases of the *identical* request with no `settlementReference` and no `paymentSignatureHash` would share the fingerprint and collide here under ON CONFLICT DO NOTHING. In the demo `settlementReference` (Gateway transfer UUID) is always present, so `artifact_hash` prefers `paymentSignatureHash` and the interaction/posting_key dedupe already gates the journal — this does not bite. **No code change in M2; documented in code comments for parity.**

### 2.6 `service_deliveries` (§7.7)

```sql
create table if not exists service_deliveries (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  interaction_id uuid not null references interactions(id),
  endpoint_id uuid references seller_endpoints(id),
  delivery_status text not null, -- delivered, failed, timeout, canceled
  http_status integer,
  response_body_hash bytea,       -- 0x-stripped before decode
  encrypted_response_metadata_uri text,
  latency_ms integer,
  units jsonb,
  error_code text,
  error_message_hash bytea,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);
```

The `service_delivery` row with `delivery_status='failed'` IS the §18.11 "failure record" for the F1 path (see §3.4).

### 2.7 `revenue_events` (§7.9)

```sql
create table if not exists revenue_events (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  interaction_id uuid not null references interactions(id),
  revenue_source text not null, -- x402_purchase, manual_adjustment, refund_reversal
  pricing_model_id uuid references pricing_models(id),
  gross_amount_atomic numeric(78,0) not null check (gross_amount_atomic > 0),
  asset text not null,
  network text,
  units jsonb,
  revenue_status text not null, -- pending_gateway, earned, disputed, refunded, reversed
  earned_at timestamptz,
  gateway_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, interaction_id, revenue_source)
);
```

`unique (tenant_id, interaction_id, revenue_source)` is the **recognition idempotency backstop** at the revenue layer (the posting layer is idempotent on `posting_key`).

### 2.8 `journal_transactions` (§18.3)

```sql
create table if not exists journal_transactions (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  txn_type text not null check (txn_type in (
    'recognition',
    'cash_collection',
    'billing_fee',
    'reversal',
    'late_collection_after_reversal',
    'supplier_payout',
    'refund_payment'
  )),
  posting_key text not null,
  revenue_event_id uuid references revenue_events(id),
  interaction_id uuid references interactions(id),
  billing_fee_schedule_id uuid, -- FK deferred until B1 ships (billing_fee_schedules not in M2)
  effective_at timestamptz not null,
  revenue_treatment text check (revenue_treatment in ('principal_gross', 'agent_net')),
  split_group_id uuid references split_groups(id),
  split_group_version integer,
  reverses_txn_id uuid references journal_transactions(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, posting_key)   -- Invariant 7
);
```

M2 writes `txn_type='recognition'`, `revenue_treatment='principal_gross'`, `posting_key='recognition:<revenue_event_id>'`, `effective_at = revenue_event.earned_at`.

### 2.9 `ledger_entries` (§18.3)

```sql
create table if not exists ledger_entries (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  entry_group_id uuid not null references journal_transactions(id),  -- Invariant 5: no orphans
  account_id uuid not null references ledger_accounts(id),
  direction text not null check (direction in ('debit', 'credit')),
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),     -- Invariant 6
  asset text not null,
  memo text,
  created_at timestamptz not null default now()
);

create index if not exists ledger_entries_group_idx on ledger_entries (entry_group_id);
```

### 2.10 `revenue_collection_state` (§18.3 "optional collection-state table" — lockable cash record)

```sql
create table if not exists revenue_collection_state (
  revenue_event_id uuid primary key references revenue_events(id),
  status text not null check (status in (
    'open_receivable',
    'cash_collected',
    'reversed_closed',
    'refund_payable',
    'manual_review'
  )),
  cash_collection_txn_id uuid references journal_transactions(id),
  reversal_txn_id uuid references journal_transactions(id),
  updated_at timestamptz not null default now()
);
```

**Modeling choice (resolving §18.3's open question).** §18.3 explicitly calls this the **optional** collection-state table and says the implementation "needs one lockable state record per revenue event or receivable" that "may be modeled directly on `revenue_events`, as a derived receivable row, or as a separate table." M2 chooses the **separate table** purely for lockability: it is the single row that P1/F2 + Invariant 10 will `SELECT … FOR UPDATE` against, and it keeps the two state machines physically separate. **In M2, only the `open_receivable` row-write happens**; `cash_collection_txn_id` / `reversal_txn_id` ship NULL and are never written until P1/F2. No cash-collection or reversal posting is wired (no P1/P2/F2 creep).

### 2.11 `raw_events_event_seq_idx` (scan optimizer, optional-but-recommended)

```sql
create index if not exists raw_events_event_seq_idx on raw_events (event_seq);
```

`event_seq` is `bigserial` with no index. The recognition pass's `where event_seq > :cursor order by event_seq` otherwise full-scans+sorts each run (fine at demo scale). The index is a **best-effort scan optimizer**, not a correctness mechanism — `event_seq` is not guaranteed gap-free or strictly commit-ordered under concurrency, so it is **not** the exactly-once cursor. The authoritative idempotency mechanism is the unique constraints + ON CONFLICT (§4.3).

---

## 3. Posting-template engine (§18.4)

A **declarative, versioned** template: a template maps a `(revenue_event, split allocation)` to an ordered list of leg specs. M2 wires **R1′ principal_gross live** (§18.7); **R1 agent_net is a tested fixture only** (§18.6 — built and asserted in tests, never invoked by the recognition module). This matches the build-plan Milestone-3 deliverable lines exactly.

### 3.1 Template shape (declarative)

Each template is a pure function `(ctx) → LegSpec[]`. A `LegSpec` is `{ direction, accountSelector, amountSource, memo }` — no amounts hardcoded; amounts resolve from the context.

```ts
type Direction = 'debit' | 'credit';

// owner_type is restricted to the values the LIVE R1' + agent_net fixture actually use.
// 'platform' is intentionally NOT in this union: there is no platform value-chain role (§18.2),
// and no live M2 leg is platform-owned.
interface AccountSelector {
  account_type: 'receivable' | 'revenue' | 'expense_cogs' | 'expense_referral' | 'payable';
  owner_type: 'seller' | 'supplier';
  owner_id?: string;   // recipient_id ONLY on supplier payable legs; null/undefined for all seller legs
}

type AmountSource =
  | { kind: 'gross' }                              // revenue_event.gross_amount_atomic
  | { kind: 'split_share'; recipientId: string };  // allocation[recipientId]

interface LegSpec {
  direction: Direction;
  account: AccountSelector;
  amount: AmountSource;
  memo: string;
}

interface PostingContext {
  revenueEvent: { id: string; tenantId: string; grossAmountAtomic: bigint; asset: string };
  treatment: 'principal_gross' | 'agent_net';
  allocation: SplitAllocation;   // { sellerShare, supplierShares: {recipientId, role, amountAtomic}[], dustRecipientId }
}
```

### 3.2 R1′ `principal_gross` template (WIRED LIVE — §18.7)

Legs (in order). The referrer/marketplace role posts its **expense** to the **seller's** single referral-expense account (`expense_referral`/`seller`); `model_provider`/`data_provider`/other supplier roles post their expense to the **seller's** single COGS account (`expense_cogs`/`seller`). **All payables** (including the referrer) are `payable`/`supplier`/owner_id=recipient.

| # | Direction | Account selector | Amount source | Memo |
|---|---|---|---|---|
| 1 | debit | `receivable` / `seller` | `gross` | Receivable — seller |
| 2 | credit | `revenue` / `seller` | `gross` | Revenue — seller |
| 3..k (per non-referrer supplier) | debit | `expense_cogs` / `seller` | `split_share[recipient]` | COGS — `<role>` share |
| same | credit | `payable` / `supplier` / owner_id=recipient | `split_share[recipient]` | Payable — `<role>` |
| k+1 (referrer/marketplace) | debit | `expense_referral` / `seller` | `split_share[referrer]` | Referral/marketplace expense |
| same | credit | `payable` / `supplier` / owner_id=referrer | `split_share[referrer]` | Payable — marketplace/referrer |

**Fidelity corrections from §18.3 "Recommended accounts" (load-bearing — propagates into the §6 CSV that exports owner_type/owner_id):**
- COGS debit legs are **`owner_type='seller'`, `owner_id=NULL`** (the single seller COGS account), **not** `supplier`. The supplier dimension lives only on the payable credit leg; the per-supplier distinction is carried by the **memo** (§18.7), not by a separate account.
- The referral-expense debit is **`owner_type='seller'`** (the seller's own P&L `Referral / marketplace expense`), **not** `platform`.
- The referrer/marketplace **payable** credit is **`owner_type='supplier'`, `owner_id=referrer recipient_id`** (identical treatment to the model/data-provider payables), **not** `platform`. The referrer is a value-chain supplier.

Rule: every supplier/referrer share emits a **balanced Dr expense / Cr payable pair**, so adding suppliers never unbalances. The seller revenue credit always equals gross (Invariant 3B). **Zero-amount shares are omitted entirely** (both their Dr and Cr legs), per §18.14.

### 3.3 WORKED demo posting (gross = 3000)

Allocation (`allocateSplit(3000n, demoRules)`): publisher/seller 2100, model_provider 600, data_provider 210, referrer 90. In `principal_gross`, the **seller revenue credit is gross (3000)**, not the 2100 publisher share — the 2100 net is a P&L margin presentation, not a ledger leg. COGS and referral expense both post to seller-owned accounts (distinction in memo); payables are supplier-owned per recipient.

```text
Dr Receivable — seller            (receivable/seller)            3000
Cr Revenue — seller               (revenue/seller)               3000
Dr COGS — model provider share    (expense_cogs/seller)           600
Cr Payable — model provider       (payable/supplier/model)        600
Dr COGS — data provider share     (expense_cogs/seller)           210
Cr Payable — data provider        (payable/supplier/data)         210
Dr Referral / marketplace expense (expense_referral/seller)        90
Cr Payable — marketplace/referrer (payable/supplier/referrer)      90

ΣDr = 3000 + 600 + 210 + 90 = 3900
ΣCr = 3000 + 600 + 210 + 90 = 3900   ✓ balanced (Invariant 1)
```

Note: both COGS debit legs resolve to the **same** `(expense_cogs, seller, NULL)` account; the natural-key index does not fan them out.

Tie-out (Invariant 3B): seller revenue credit (3000) == gross (3000) ✓; supplier/referrer payable credits (600+210+90=900) == matching COGS+referral debits (600+210+90=900) ✓.

### 3.4 F1 — verified-but-not-delivered / unverified → NO journal (failure record only)

**Trigger (pinned to observable M1 fields).** From the live recorder, only two M2 outcomes are reachable for a captured analog: `delivery.status='delivered'` (2xx) and `delivery.status='failed'` (non-2xx). `'canceled'` is accepted as a **forward-compat enum value handled identically to `failed`** but is never produced by M1 capture. Recognition fires **only** when `payment.verified === true AND delivery.status === 'delivered'`. Any other combination — `delivery.status` in `('failed','canceled')`, **or** `payment.verified === false` even on a 2xx — takes the F1 path.

**Honest scope statement (do NOT overclaim the acceptance line).** Build-plan §18.11 F1 is "payment verified / handler throws / payment is NOT settled" — a verified-but-uncollected case with no money movement, where the rule is "create failure record / create dispute/refund candidate **if needed** / do not create revenue_event / receivable / payables." Build-plan §10 routes "payment settled + service failed" to "dispute/refund candidate (F2 territory)." The M1 receipt analog captures post-settlement events, so a non-2xx analog is "settled + failed," which is strictly F2's domain.

M2 therefore does the following and is explicit about what it does and does not satisfy:
- Writes the `interaction` with `status='failed'` (forward-compat `'canceled'`) and the `service_delivery` with `delivery_status='failed'`/`'canceled'` and the `http_status`. **This `service_delivery` row is the §18.11 "failure record"** — the durable, query-able artifact that a failed-delivery occurred, traceable to its `raw_event` (see §6 CSV linkage).
- Writes **NO** `revenue_event`, `journal_transaction`, `ledger_entries`, or `revenue_collection_state` (`recognizeOne` returns `{ outcome: 'F1_skipped', interactionId }` — the shipped `RecognitionResult` uses an `outcome` enum `'recognized' | 'replayed' | 'F1_skipped'`, not a `{ skipped }` field).
- **Defers the active dispute/refund-candidate *workflow* (a `refund_or_dispute_candidate` record + the F2 reversal economics) to F2 (M2-not-list, §9).** M2 satisfies the Milestone-2 acceptance line "failed delivery creates dispute/refund candidate" **only to the extent of the §18.11 failure record** (the `service_delivery`-failed row, distinguishable from a delivered one and reconcilable in the CSV); the dedicated dispute/refund-candidate object and its downstream reversal are an explicit F2 deferral, **not** claimed as fully met by a silent drop.

### 3.5 Dust handling (§18.14)

All integer (`bigint`) math. The MVP demo is pure-percentage 10000 bps = gross, so **zero dust**. Engine rules still implemented and tested:

- percentage shares computed by integer floor (`gross * bps / 10000n`);
- the remainder `gross − Σ(floored shares)` is the **dust**, allocated deterministically to `dustRecipientId`; if unconfigured, dust → **publisher/seller** (added to the seller revenue/receivable side so gross is fully accounted, per §18.14);
- dust recipient is recorded (memo + allocation field);
- zero-amount legs omitted;
- the balance invariant (Inv 1) is the final safety check after dust allocation.

Mixed fixed+percentage base semantics (§18.14 candidate models A/B) are **runtime-rejected** in M2; only pure-percentage allocation is computed.

### 3.6 R1 agent_net (FIXTURE ONLY — §18.6)

Built and asserted in tests; **never invoked by the recognition module.** Legs: `Dr Receivable / seller` = `gross`; `Cr Revenue / seller` = seller net share (2100); `Cr Payable / supplier / owner_id=recipient` per supplier/referrer (600/210/90), **no expense legs**. The referrer payable in the fixture is also `owner_type='supplier'`, consistent with the corrected R1′ template (so the fixture proves the *same* corrected account dimensions generalize). ΣDr=3000, ΣCr=3000. Tie-out (Inv 3A, reserve=none): seller revenue credits + supplier/referrer payable credits = gross. This proves the engine generalizes without shipping it live.

---

## 4. Recognition module

New internal package: `@ledgerline/recognition` at `/Users/broccolirob/Projects/ledgerline/packages/recognition/` (mirrors existing package conventions: `exports: './src/index.ts'`, `tsx`, no build step, extends `tsconfig.base.json`).

**Dependencies (corrected).** `pg` is a **direct** runtime dependency of `@ledgerline/recognition` (it is not provided by `seller-client`). The `Db` type is imported **type-only** (`import type { Db } from '@ledgerline/seller-client'`), which is a type-only re-export of `pg`'s `Pool | PoolClient` and gives no runtime value. M2 does **not** reuse `allocateOneSplit` (number-based, wrong shape); the new `allocateSplit` is a fresh `bigint` largest-remainder implementation. (Optionally re-export `Db` from a local `types.ts` to avoid any value-level dependency on `seller-client`.)

### 4.1 Hook point — RECOMMENDATION: separate idempotent processing pass

**Recommend a separate, idempotent recognition pass (a CLI/worker), NOT inline-in-sink.** Justification:

- **Subledger, not middleware.** Recognition is an accounting decision over persisted facts; the sink's job is durable capture. Coupling posting into `res.on('finish')` would run double-entry logic per-request in the demo process, where the recorder *swallows all throws* (`console.error` only) — a posting bug would silently drop ledger rows with no signal. A separate pass surfaces failures and can be re-run.
- **Idempotent + replayable.** `event_seq` is a best-effort scan cursor; `unique(tenant_id, posting_key)` + `unique(tenant_id, interaction_id, revenue_source)` make the pass exactly-once regardless of how many times it runs. Re-running over already-recognized events is a safe no-op.
- **Demo simplicity.** No `LISTEN/NOTIFY` or job queue exists. M2 ships a **CLI pass** (`recognize` script) that selects un-recognized `raw_events` and posts them — invoked manually or right after the demo call. A long-running poller is **not** required for M2 (deferred to the hosted ingestion API).

The pass reads: `select * from raw_events where event_type='ledgerline.receipt_analog.v1' and event_source='seller_sdk' [and event_seq > :cursor] order by event_seq`. "Already recognized" is detected by attempting the inserts under the unique constraints (ON CONFLICT DO NOTHING) — no separate processed-marker table needed in M2.

### 4.2 Function signatures

```ts
// packages/recognition/src/index.ts
import type { Db } from '@ledgerline/seller-client'; // type-only (pg Pool | PoolClient)

/** Row shape of raw_events as returned by pg. id is TEXT (string), event_seq is bigserial (string). */
export interface RawEventRow {
  id: string;                 // text PK (NOT uuid)
  tenant_id: string;
  event_type: string;
  event_source: string;
  occurred_at: Date;
  payload_redacted: Record<string, unknown>;
  event_seq: string;          // pg returns bigint/bigserial as string by default
}

export interface RecognitionConfig {
  tenantId: string;
  pricingModelId: string;     // resolved exact pricing model (demo seed)
  splitGroupId: string;       // resolved demo split_group (principal_gross)
  splitGroupVersion: number;
}

/** Parsed revenue signals lifted out of raw_events.payload_redacted. *Hex fields are 0x-prefixed. */
export interface ParsedReceipt {
  rawEventId: string;
  idempotencyAnchor: string;       // settlementReference ?? paymentSignatureHash ?? requestFingerprint
  requestFingerprintHex: string;   // 0x-prefixed; caller strips 0x before decode(...,'hex')
  amountAtomic: bigint;            // integer-parsed from payment.amountAtomic (string) via BigInt()
  asset: string;                   // 'USDC'
  network: string;
  payerHashHex: string;            // 0x-prefixed
  paymentSignatureHashHex?: string;// 0x-prefixed
  settlementReference?: string;
  verified: boolean;               // payment.verified — recognition requires === true
  deliveryStatus: 'delivered' | 'failed' | 'canceled';
  httpStatus: number;
  occurredAt: Date;
}

/** Pure parse + validation. Throws on malformed/zero/negative/non-integer amount. */
export function parseReceipt(rawEvent: RawEventRow): ParsedReceipt;

/** Pure helper: strip a leading '0x' (if present) and return Buffer for a bytea bind. */
export function hexToBytea(hex0x: string): Buffer; // decode after stripping 0x

/** Pure: integer (bigint) split allocation (largest-remainder dust to dustRecipient/publisher). */
export function allocateSplit(
  grossAmountAtomic: bigint,
  rules: SplitRuleRow[],
  dustRecipientId?: string,
): SplitAllocation;

/** Pure: build leg specs for a treatment. R1′ wired; agent_net used only in tests. */
export function buildPostingLegs(ctx: PostingContext): LegSpec[];

/** Resolve (or create) the canonical ledger account for a selector. Idempotent via the natural-key
 *  EXPRESSION index (§2.3): insert with `on conflict (tenant_id, account_type, owner_type,
 *  coalesce(owner_id,'000…000'::uuid), asset) do nothing` — restating the exact index expression —
 *  then `select` the id, because `do nothing` returns no row on a hit. Seller-owned legs bind
 *  owner_id as the sentinel so they collapse onto one account.
 *  Live R1′ path only ever passes owner_type in {seller, supplier}; never 'platform'. */
export function resolveLedgerAccount(
  db: Db, tenantId: string, sel: AccountSelector, asset: string,
): Promise<string>; // account_id

/**
 * Recognize ONE delivered+verified paid raw_event.
 * - verified && delivered  → interaction + artifact + service_delivery + revenue_event(earned)
 *                            + journal_transaction(recognition) + ledger_entries + collection_state(open_receivable)
 * - failed/canceled OR not verified → F1: interaction(status=failed) + service_delivery(failure record) only;
 *                                     NO journal/revenue/collection_state (returns {outcome:'F1_skipped'})
 * Idempotent: ON CONFLICT on (tenant_id, posting_key) and (tenant_id, interaction_id, revenue_source).
 * Asserts gross == resolved pricing_models.fixed_amount_atomic (Invariant 2) and ΣDr==ΣCr per asset
 * (Invariant 1) BEFORE commit (refuses to persist unbalanced — §18.16).
 *
 * Transaction control: if `client` is supplied (an injected PoolClient), recognizeOne runs its
 * statements on that client and does NOT itself BEGIN/COMMIT (the caller owns the txn — used by
 * the CLI pass and by rollback-isolated tests). If `db` is a Pool, recognizeOne acquires its own
 * PoolClient and runs BEGIN…COMMIT internally.
 */
export function recognizeOne(
  db: Db, cfg: RecognitionConfig, rawEvent: RawEventRow,
): Promise<RecognitionResult>;

/** Batch pass: select un-recognized receipt analogs by event_seq and recognizeOne each. */
export function runRecognitionPass(
  db: Db, cfg: RecognitionConfig, opts?: { sinceEventSeq?: bigint },
): Promise<RecognitionPassSummary>;
```

### 4.3 Transaction + idempotency strategy

`recognizeOne` runs all its statements in **one DB transaction** (one `PoolClient`, `BEGIN`…`COMMIT` when it owns the txn; otherwise on the injected client):

1. Insert `interaction` `ON CONFLICT (tenant_id, payment_identifier) DO NOTHING RETURNING id` — if no row returned, `SELECT` the existing id (replay). `status='delivered'` on recognize, `'failed'`/`'canceled'` on F1.
2. Insert `x402_payment_artifact` `ON CONFLICT (tenant_id, artifact_type, artifact_hash) DO NOTHING` (artifact_hash prefers `paymentSignatureHash`, `0x`-stripped).
3. Insert `service_delivery` (the failure record on the F1 path).
4. **If not (verified && delivered) → COMMIT here (F1, no journal).**
5. Assert `gross == pricing_models.fixed_amount_atomic` (Invariant 2; resolve the configured exact model). Insert `revenue_event` `ON CONFLICT (tenant_id, interaction_id, revenue_source) DO NOTHING RETURNING id`; resolve id on replay.
6. Insert `journal_transaction` with `posting_key='recognition:<revenue_event_id>'` `ON CONFLICT (tenant_id, posting_key) DO NOTHING RETURNING id`. **If conflict (already posted) → skip leg insertion and COMMIT (replay no-op).**
7. Resolve accounts (owner_type ∈ {seller, supplier} only); build legs; **assert ΣDr==ΣCr per asset in code** (refuse to persist unbalanced); insert `ledger_entries`.
8. Insert `revenue_collection_state` `status='open_receivable'` `ON CONFLICT (revenue_event_id) DO NOTHING`.
9. `COMMIT` (when owning the txn).

Recognition idempotency is keyed on **`posting_key` (the strongest)**, backstopped by the `revenue_event` and `interaction` unique constraints. The weak-anchor caveat (when `settlementReference` and `paymentSignatureHash` are both absent, the fingerprint anchor can collide across distinct purchases of the identical request) is **inherited from M1's raw_events dedupe** and applies equally to the artifact unique key (§2.5) — documented in code, not solved in M2.

### 4.4 Integer math + hash-encoding discipline

- `payment.amountAtomic` is a JSON string. Parse via `BigInt(string)` (reject non-integer/negative — `parseReceipt` throws). All allocation and balance math uses `bigint`. Write to `numeric(78,0)` columns as strings (`amount.toString()`), never via JS `number`.
- `event_seq` arrives from `pg` as a **string**; the cursor handles it as `string`/`BigInt`, never assuming a JS `number`.
- **Hash encoding (load-bearing).** All `*Hex` payload fields are **`0x`-prefixed** (`sha256hex` returns `'0x'+digest`). Before any `decode(value,'hex')` bind for a `bytea` column (`request_fingerprint`, `payer_address_hash`, `artifact_hash`, `response_body_hash`), the recognition module **strips the leading `0x`** via `hexToBytea()` and binds the resulting `Buffer`. A unit test asserts `hexToBytea('0xab…')` round-trips a `0x`-prefixed input to the same bytes as the un-prefixed hex.

---

## 5. Invariant enforcement + balance audit query

### 5.1 Enforced in M2

| # | Invariant | Mechanism |
|---|---|---|
| 1 | Σdebits == Σcredits per txn per asset | **Runtime assertion** in `recognizeOne` before commit (refuses to persist unbalanced — §18.16) + audit query + test |
| 2 | Exact-pricing amount tie-out: `gross_amount_atomic == pricing_models.fixed_amount_atomic` | **Runtime assertion** in `recognizeOne` (resolve configured exact model, compare; fail recognition on mismatch) + §19.6 test. (No signed offer exists; settled `payment.amountAtomic` is the gross source per §1.2.) |
| 3B | principal_gross tie-out: seller revenue credit == gross; supplier/referrer payable credits == matching COGS/referral debits | Guaranteed by the balanced Dr/Cr pair per share in the R1′ template + dedicated test |
| 5 | No orphan entries | DDL: `entry_group_id uuid NOT NULL references journal_transactions(id)` |
| 6 | Strictly positive amounts | DDL: `amount_atomic numeric(78,0) CHECK (> 0)` + zero-leg omission in engine |
| 7 | Idempotent posting_key | DDL: `unique (tenant_id, posting_key)` + ON CONFLICT DO NOTHING |
| 8 | Append-only | M2 never UPDATEs/DELETEs `ledger_entries`/`journal_transactions`; recognition is insert-only. (Trigger-level immutability deferred with F2.) Test asserts inserts-only behavior. |
| 9 | Original unchanged | Trivially holds in M2 — no reversal path exists to mutate originals. Asserted by the append-only test. |

> 3A (agent_net) is exercised **only as a test fixture** (engine generalizes), since agent_net is not wired live. **Invariant 4 (billing-fee separation):** the demo **deliberately omits** the Ledgerline software fee, so no `billing_fee` transaction is posted and Invariant 4 is **vacuously satisfied**; `billing_fee_schedules` / the `billing_fee_schedule_id` FK / B1 are deferred (§9). The Milestone-3 acceptance line ("software fee, IF demoed, posts as a separate billing_fee journal transaction") is honored by not demoing the fee.

### 5.2 Deferred (state which + why)

- **Invariant 10 (settlement-state atomicity / P1-F2 race):** deferred. There is no cash-collection (P1) or reversal (F2) path in M2, so there is no settlement-state-dependent posting to race. It will be enforced via `SELECT … FOR UPDATE` on the `revenue_collection_state` row (and the consistent lock order of §18.15: interaction → revenue_event → collection_state → journal_transactions) when P1/F2 ship. The table is created now precisely to be that lock target. *(Confirmed correctly gated: §18.15 Invariant 10.)*
- **Invariant 11 (batch atomicity — all legs of a journal_transaction in one Merkle batch):** deferred. There is no Arc commitment or Merkle batch builder in M2 (that is M4). With no batching, there is no partial-leg-commit risk; the §19.3 batch-atomicity and verifier-missing-leg tests belong to the M4 verifier milestone, not here. *(Confirmed correctly assigned to M4.)*

### 5.3 Balance audit query (§18.16 — must return zero rows)

```sql
select
  entry_group_id,
  asset,
  sum(case when direction = 'debit'  then amount_atomic else 0 end) as debits,
  sum(case when direction = 'credit' then amount_atomic else 0 end) as credits
from ledger_entries
group by entry_group_id, asset
having
  sum(case when direction = 'debit'  then amount_atomic else 0 end)
  <>
  sum(case when direction = 'credit' then amount_atomic else 0 end);
```

Shipped as a SQL file + a small `audit` script that fails (non-zero exit) if any rows return. Run in CI/tests after the recognition pass.

---

## 6. CSV export (§20 — M2 deliverable)

New script in the recognition package: `pnpm --filter @ledgerline/recognition export:csv`. Two CSVs to stdout/file, scoped by `tenant_id`. Integer atomic units rendered as-is (no float formatting); RFC-4180 quoting.

**Reconciliation requirement (acceptance line "CSV reconciles revenue to receipt/delivery").** The `revenue_events.csv` must be join-traceable back to the originating receipt/delivery. It therefore includes a link to the `service_delivery` (delivery outcome + http_status) and to the originating `raw_event`, via the `interaction`.

**`revenue_events.csv`** columns:
`revenue_event_id, tenant_id, interaction_id, raw_event_id, revenue_source, pricing_model_id, gross_amount_atomic, asset, network, revenue_status, earned_at, service_delivery_id, delivery_status, http_status, collection_status, created_at`
(join `interactions` → `service_deliveries` for delivery linkage; join `revenue_collection_state` for `collection_status`; `raw_event_id` resolved via the `interaction.payment_identifier` ↔ `raw_events.idempotency_key` anchor, or carried on a nullable `interactions.raw_event_id text` column if added — see note below).

> **raw_event linkage note.** No FK from any M2 table to `raw_events` is created (raw_events.id is `text`). The link is reconstructable through the shared idempotency anchor (`interaction.payment_identifier` derives from the same `settlementReference ?? paymentSignatureHash ?? requestFingerprint` that forms `raw_events.idempotency_key = 'ledgerline-receipt-analog:v1:<anchor>'`). To make the CSV's `raw_event_id` column a direct lookup, the recognition module records the source `raw_events.id` on a nullable `interactions.raw_event_id text` column (added to the §2.4 DDL as `raw_event_id text` — plain text, no FK, populated at recognize time). This is the cheapest way to satisfy "reconciles revenue to receipt/delivery" without coercing the legacy text id.

**`ledger_entries.csv`** columns:
`ledger_entry_id, tenant_id, entry_group_id (journal_transaction_id), txn_type, posting_key, revenue_treatment, account_type, owner_type, owner_id, account_name, direction, amount_atomic, asset, memo, effective_at, created_at` (join `journal_transactions` + `ledger_accounts`). With the §3.2 fidelity fixes, `owner_type` in this export is only ever `seller` or `supplier` on the live path (never `platform`).

Dashboard revenue table is **OPTIONAL / out of scope** (no dashboard exists). CSV is the priority deliverable. (Build-plan M2 lists "basic dashboard revenue event table" as a deliverable; with no dashboard in the repo, the CSV is the in-scope substitute and the dashboard is deferred.)

---

## 7. Test plan + adding vitest

### 7.1 Add the runner (greenfield)

Add **vitest** (matches TS/ESM/`tsx` stack better than `node:test` for fixtures + DB setup). Root `devDependency`; root scripts `"test": "vitest run"` and `"test:watch": "vitest"`. Pin vitest to a version known-good on Node 22 ESM. Tests live in `packages/recognition/test/`.

**Resolution + config (load-bearing under NodeNext + verbatimModuleSyntax).** vitest runs through its own esbuild transform and does not honor `tsx`'s loader; workspace packages export `exports: './src/index.ts'` (raw TS). A root `vitest.config.ts` must make `@ledgerline/*` resolve to their `src/index.ts` — via `resolve.alias` (alias `@ledgerline/recognition` → `packages/recognition/src/index.ts`, `@ledgerline/seller-client` → `packages/seller-client/src/index.ts`) **or** the `vite-tsconfig-paths` plugin. All type-only imports use `import type` (already the convention; required by `verbatimModuleSyntax`/`isolatedModules`). **Add a smoke test** that imports `@ledgerline/recognition` and `@ledgerline/seller-client` to prove resolution before any DB test is written.

**DB-test setup preconditions + isolation (load-bearing).** DB-touching tests require the host Postgres on **port 5433** to be UP (`pnpm db:up && pnpm db:migrate` first); they are **not hermetic** otherwise. The test step (and CI) must run `db:migrate` against the test database before the integration tests. Because `recognizeOne` COMMITs its own transaction when handed a `Pool`, you **cannot** wrap it in an outer rollback. Isolation strategy:
- **DB-integration tests:** run against an **ephemeral throwaway database/schema** that is migrated fresh and dropped/recreated per test file (no outer rollback); `recognizeOne` owns its txn there. *(Alternatively, pass an injected `PoolClient` per the §4.2 contract so the caller controls the txn and the test rolls back — but the per-file fresh-DB approach is the recommended default.)*
- **Pure-math tests** (`parseReceipt`, `hexToBytea`, `allocateSplit`, `buildPostingLegs`, the in-code balance assertion) need **no DB**.

### 7.2 Named tests

**§19.3 — journal/ledger structural:**
- every journal transaction balances per asset (ΣDr==ΣCr);
- every ledger entry has `entry_group_id` (NOT NULL link);
- zero-amount ledger entry is rejected (DDL CHECK);
- negative ledger entry is rejected (DDL CHECK);
- duplicate `posting_key` is rejected (unique constraint; second `recognizeOne` is a no-op, no double-post);
- recognition retry does not double-post (run `recognizeOne` twice on the same raw_event → exactly one journal_transaction, 8 ledger_entries);
- entries are append-only (recognition issues no UPDATE/DELETE).
- *(§19.3 batch-atomicity + verifier-missing-leg tests are M4-owned — explicitly NOT in M2.)*

**Account-resolution fidelity (locks the §3.2 corrections):**
- the live R1′ path only ever resolves/creates `ledger_accounts` with `owner_type ∈ {seller, supplier}` — **never `platform`** (assert no `platform`-owned account exists after a recognition pass);
- the single seller COGS account (`expense_cogs`/`seller`/NULL) and single seller referral-expense account (`expense_referral`/`seller`/NULL) are the canonical targets — both COGS debits resolve to the **same** account id (the natural-key index does not fan out per-supplier expense accounts);
- the referrer payable is `payable`/`supplier`/owner_id=referrer (not `platform`).

**§19.6 — principal/gross (the demo treatment):**
- seller Revenue credit == gross (3000);
- supplier/referrer shares create `expense_cogs` / `expense_referral` debits;
- supplier/referrer payable credits equal matching COGS/referral debits (3B tie-out);
- `revenue_event.gross_amount_atomic` satisfies the exact-pricing amount tie-out (== `pricing_models.fixed_amount_atomic`; Invariant 2);
- billing fee, if present, posts separately (asserted absent in demo);
- journal transaction balances.

**§19.11 — dust:**
- tiny multi-recipient split still balances;
- dust allocated to configured dust recipient;
- dust recipient recorded;
- zero-amount split legs omitted;
- ΣDr==ΣCr after dust allocation.

**Additional M2 tests:**
- F1 (failed): a `delivery.status='failed'` raw_event produces NO journal_transaction / revenue_event / collection_state, **but DOES produce the `service_delivery` failure record** (and `interaction.status='failed'`);
- F1 (unverified-but-2xx): a `delivery.status='delivered'` raw_event with `payment.verified=false` takes the F1 path (no journal/revenue/collection_state; failure record written) — covers the recorder's `verified=false` + 2xx combination;
- forward-compat `'canceled'` status is handled identically to `'failed'`;
- R1 agent_net **fixture** balances (ΣDr=ΣCr=3000), satisfies 3A tie-out, and uses `owner_type='supplier'` payables — proving generalization without wiring it live;
- the §18.16 audit query returns zero rows after a recognition pass;
- `parseReceipt` rejects zero/negative/non-integer amounts (bigint path);
- `hexToBytea` round-trips a `0x`-prefixed hex to the same bytes as the un-prefixed hex (locks the decode fix);
- **seed idempotency:** applying `0004` twice (the runner re-runs every file) leaves **exactly four** `split_rules` and one `pricing_models` / one `split_groups` row for the demo group — locks the §2.2/§8 deterministic-seed-UUID + natural-key `on conflict` fix (a bare `on conflict do nothing` on `split_rules` would silently duplicate);
- workspace-resolution smoke test (imports `@ledgerline/recognition` + `@ledgerline/seller-client`).

---

## 8. File-by-file change list

**New files:**
- `/Users/broccolirob/Projects/ledgerline/packages/db/src/migrations/0003_revenue_recognition.sql` — all §2 DDL (idempotent `create … if not exists`), including `interactions.raw_event_id text` (no FK) and `raw_events_event_seq_idx`.
- `/Users/broccolirob/Projects/ledgerline/packages/db/src/migrations/0004_seed_demo_pricing_split.sql` — seed **only** the demo `pricing_models` (exact, fixed 3000) + `split_groups` (principal_gross, v1) + four `split_rules` (publisher 7000 / model_provider 2000 / data_provider 700 / referrer 300 bps). **Per-table `on conflict` targets are mandatory** (the runner re-runs this file on every migrate, §2 preamble): `pricing_models` and `split_groups` conflict on `(tenant_id, name, version)`; `split_rules` uses **deterministic literal UUIDs** + `on conflict (id) do nothing` (it has no natural unique key — a bare `on conflict do nothing` would duplicate the four rows on every re-run and corrupt the split, §2.2). **Does NOT touch `seller_endpoints`** (no endpoint row is seeded in the repo; endpoint defaults are out of M2 scope — see note below).
- `/Users/broccolirob/Projects/ledgerline/packages/recognition/package.json` — `@ledgerline/recognition`, `exports: './src/index.ts'`, **`pg` as a direct dependency**, `@ledgerline/seller-client` for the type-only `Db` import.
- `/Users/broccolirob/Projects/ledgerline/packages/recognition/tsconfig.json` — extends base, `include: ['src']`.
- `/Users/broccolirob/Projects/ledgerline/packages/recognition/src/index.ts` — `parseReceipt`, `hexToBytea`, `allocateSplit`, `buildPostingLegs`, `resolveLedgerAccount`, `recognizeOne`, `runRecognitionPass`, types (incl. `RawEventRow` with `id: string`, `event_seq: string`).
- `/Users/broccolirob/Projects/ledgerline/packages/recognition/src/templates.ts` — R1′ principal_gross + R1 agent_net leg-spec definitions (corrected owner_types).
- `/Users/broccolirob/Projects/ledgerline/packages/recognition/src/recognize-cli.ts` — entry for `pnpm … recognize` (the separate pass).
- `/Users/broccolirob/Projects/ledgerline/packages/recognition/src/export-csv.ts` — §6 CSV export (with receipt/delivery reconciliation columns).
- `/Users/broccolirob/Projects/ledgerline/packages/recognition/src/audit.ts` + `audit.sql` — §5.3 balance audit (exits non-zero on violations).
- `/Users/broccolirob/Projects/ledgerline/packages/recognition/test/*.test.ts` — §7.2 tests (pure-math + DB-integration files + resolution smoke test).
- `/Users/broccolirob/Projects/ledgerline/vitest.config.ts` (root) — test config with `@ledgerline/*` → `src/index.ts` aliases (or `vite-tsconfig-paths`).

**Edited files:**
- `/Users/broccolirob/Projects/ledgerline/package.json` — add `vitest` (+ `vite-tsconfig-paths` if used) devDep; add `"test"`, `"test:watch"` scripts; add convenience scripts `"recognize"`, `"export:csv"`, `"audit"` filtering `@ledgerline/recognition`.
- `/Users/broccolirob/Projects/ledgerline/packages/db/src/migrations/0001_init.sql` is **NOT** edited (interactions.raw_event_id lives in 0003).

**Verify-only (no change):**
- `/Users/broccolirob/Projects/ledgerline/pnpm-workspace.yaml` — already globs `packages/*`; `packages/recognition/` is auto-included.
- `/Users/broccolirob/Projects/ledgerline/packages/db/src/migrate.ts` — unchanged; new migrations are picked up by the existing `readdir().sort()`. The whole-file simple-query execution is compatible with the all-`if not exists`, no-bind-parameter 0003/0004 files.

**No edits required** to `packages/seller-client/src/index.ts` or `packages/express/src/index.ts` — the recognition module reads persisted `raw_events` and imports only the type-only `Db`.

> **seller_endpoints seed (dropped from M2).** The draft's claim that `seller_endpoints.default_pricing_model_id` / `default_split_group_id` "can point here" is removed: those columns have no FK and **no `seller_endpoints` row is seeded anywhere** (0002 seeds only the tenant). `RecognitionConfig` resolves `pricingModelId` / `splitGroupId` **directly from the 0004 seed** (by `(tenant_id, name, version)`), so endpoint defaults are unnecessary in M2. If endpoint defaults are later wanted, that is a deliberate M1-seed touch and requires first seeding a `seller_endpoints` row — explicitly out of M2 scope.

> *(Optional, demo only)* `/Users/broccolirob/Projects/ledgerline/apps/demo-seller-express/src/index.ts` — leave the sink unchanged (recognition stays a separate pass). Recommend keeping the demo as **`capture → run pass → export CSV`** as three explicit steps. Do NOT add posting into the response path.

---

## 9. Explicitly deferred (NOT-M2 list)

- **Arc commitment + Merkle batch builder + verifier** (M4) — and with it **Invariant 11** (batch atomicity) and the §19.3 batch/verifier tests.
- **P1 cash collection** — `collection_state` stays at `open_receivable`; never advances to `cash_collected`. **Invariant 10** (settlement-state race) deferred with it; `cash_collection_txn_id` ships NULL/unwritten.
- **P2 supplier payout**, **P3 refund payment**, **`late_collection_after_reversal`**.
- **F2 reversal / refund** — including the **active dispute/refund-candidate workflow** (a dedicated `refund_or_dispute_candidate` record + reversal economics for settled-then-failed deliveries, §10/§18.12) and the *active enforcement* of Invariants 8/9 via immutability triggers (M2 satisfies 8/9 by being insert-only). M2's F1 path writes the §18.11 **failure record** (`service_delivery`-failed) but defers the dispute/refund-candidate object.
- **B1 Ledgerline billing fee** — `billing_fee_schedules` table, `billing_fee_schedule_id` FK, and **Invariant 4** (billing-fee separation). Fee OMITTED from the demo (Invariant 4 vacuously satisfied).
- **R1 agent_net LIVE wiring** — fixture/test only.
- **`upto` / `usage_metered` pricing** and their amount tie-outs; mixed fixed+percentage split base semantics (§18.14 candidate models A/B unpinned, runtime-rejected).
- **Reserve treatment** (`reserve_treatment` enforced = `none`); contra_revenue tie-out variant of 3A; reserve allocation mechanism (§18.17).
- **`owner_type='platform'` accounts** — schema-present (canonical §18.3 enum) but with **no live use** in M2.
- **`seller_endpoints` seed / endpoint-default wiring** (M0/M1 surface).
- **Hosted ingestion API / long-running poller / LISTEN-NOTIFY**, **metadata encryption**, **SIWX access (A1)**, **partial refunds**, **asymmetric supplier clawbacks**, **dashboard revenue/split UI + recipient statements** (CSV ships instead).
