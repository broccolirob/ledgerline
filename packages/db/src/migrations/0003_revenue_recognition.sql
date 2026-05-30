-- M2 (build-plan Milestone 2 "revenue subledger" + Milestone 3 "split accounting"):
-- revenue recognition + the balanced double-entry posting engine.
--
-- Idempotency (HARD constraint): migrate.ts re-applies EVERY *.sql on EVERY invocation with no
-- applied-tracking table, sending the whole file as one simple-query batch (split on ';', no bind
-- parameters). Every statement here is `create table if not exists` / `create index if not exists`;
-- inline `check (…)` is safe on re-run because the table is skipped when present. No `alter table`.
--
-- Integer atomic units only (numeric(78,0)). All `*hash` payload fields are 0x-prefixed hex in TS;
-- the recognition module strips the leading 0x and binds a Buffer for these bytea columns.
--
-- FK target order matters within this single implicit transaction: pricing_models, split_groups,
-- split_rules, ledger_accounts, interactions, x402_payment_artifacts, service_deliveries,
-- revenue_events, journal_transactions, ledger_entries, revenue_collection_state.

-- 2.1 pricing_models (§7.3) — runtime writes 'exact' only; upto/usage_metered are schema-only.
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

-- 2.2 split_groups + split_rules (§7.10).
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

-- split_rules keeps ONLY its uuid PK (no natural unique key), exactly as canonical §7.10. It is
-- seed-only in M2 (recognition READS it, never writes it), so the seed (0004) uses deterministic
-- literal UUIDs + `on conflict (id) do nothing` for idempotency — see 0004 and §2.2 of the plan.
create table if not exists split_rules (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  split_group_id uuid not null references split_groups(id),
  recipient_id uuid not null,
  role text not null,
    -- canonical role set (§18.2): publisher, model_provider, data_provider, tool_author,
    --   referrer, marketplace, infra, facilitator. NO 'platform' value.
  percentage_bps integer check (percentage_bps is null or (percentage_bps between 0 and 10000)),
  fixed_amount_atomic numeric(78,0) check (fixed_amount_atomic is null or fixed_amount_atomic > 0),
  priority integer not null default 100,
  match_conditions jsonb,
  rounding_mode text not null default 'largest_remainder',
  created_at timestamptz not null default now(),
  -- Each rule is percentage XOR fixed. Mixed fixed+percentage base semantics are runtime-rejected
  -- in M2 (deferred §18.14); the demo group is pure-percentage.
  check (
    (percentage_bps is not null and fixed_amount_atomic is null)
    or
    (percentage_bps is null and fixed_amount_atomic is not null)
  )
);

-- 2.3 ledger_accounts (§18.3 canonical — supersedes the §7.11 placeholder).
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

-- Distinct supplier payables share account_type='payable' and disambiguate by (owner_type, owner_id).
-- The expression natural-key makes account resolution deterministic + idempotent. resolveLedgerAccount
-- must restate this EXACT expression in its `on conflict (...)` inference clause (see §2.3 of the plan).
create unique index if not exists ledger_accounts_natural_key
  on ledger_accounts (tenant_id, account_type, owner_type, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), asset);

-- 2.4 interactions (§7.5). `raw_event_id text` (no FK) is the §6 CSV reconciliation link back to
-- raw_events (raw_events.id is legacy text and is never coerced to uuid). endpoint_id is written
-- NULL in M2 (no seeded seller_endpoints row; RecognitionConfig carries no endpointId).
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
  raw_event_id text,    -- M2 addition: link to raw_events.id (legacy text PK; no FK)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, payment_identifier)
);

-- 2.5 x402_payment_artifacts (§7.6). M2 writes one row, artifact_type='payment_signature'
-- (no-overclaim: no Circle-issued signed_offer/signed_receipt exists).
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

-- 2.6 service_deliveries (§7.7). The delivery_status='failed' row IS the §18.11 failure record (F1).
-- endpoint_id is written NULL in M2 (see interactions note). No unique key (canonical §7.7 allows
-- multiple delivery attempts); recognizeOne's interaction-existence gate prevents replay duplicates.
create table if not exists service_deliveries (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  interaction_id uuid not null references interactions(id),
  endpoint_id uuid references seller_endpoints(id),
  delivery_status text not null, -- delivered, failed, timeout, canceled
  http_status integer,
  response_body_hash bytea,       -- 0x-stripped before bytea bind
  encrypted_response_metadata_uri text,
  latency_ms integer,
  units jsonb,
  error_code text,
  error_message_hash bytea,
  delivered_at timestamptz,
  created_at timestamptz not null default now()
);

-- 2.7 revenue_events (§7.9). unique(tenant_id, interaction_id, revenue_source) is the recognition
-- idempotency backstop at the revenue layer.
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

-- 2.8 journal_transactions (§18.3). billing_fee_schedule_id is a plain nullable column (no FK) until
-- B1 ships. unique(tenant_id, posting_key) is Invariant 7.
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
  unique (tenant_id, posting_key)
);

-- 2.9 ledger_entries (§18.3). entry_group_id NOT NULL (Invariant 5); amount_atomic > 0 (Invariant 6);
-- direction CHECK. Append-only in M2 (Invariants 8/9 hold by insert-only behavior).
create table if not exists ledger_entries (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  entry_group_id uuid not null references journal_transactions(id),
  account_id uuid not null references ledger_accounts(id),
  direction text not null check (direction in ('debit', 'credit')),
  amount_atomic numeric(78,0) not null check (amount_atomic > 0),
  asset text not null,
  memo text,
  created_at timestamptz not null default now()
);

create index if not exists ledger_entries_group_idx on ledger_entries (entry_group_id);

-- 2.10 revenue_collection_state (§18.3 "optional collection-state table" — the lockable cash record).
-- In M2 only the open_receivable row-write happens; cash_collection_txn_id / reversal_txn_id ship
-- NULL and are never written (P1/F2 deferred). The table exists now purely as the future
-- SELECT … FOR UPDATE lock target for Invariant 10.
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

-- 2.11 raw_events scan optimizer (best-effort; event_seq is bigserial with no index). NOT the
-- exactly-once cursor — idempotency is the unique constraints + the interaction-existence gate.
create index if not exists raw_events_event_seq_idx on raw_events (event_seq);
