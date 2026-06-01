-- M4 (build-plan Milestone 4): Arc commitment batches.
-- §7.12 commitment_batches + an M4 superset (batch_id, status, batch_leaves) + the salted
-- tenant_commitment input (§16). Only Merkle roots + policy hashes ever go on-chain — never raw
-- metadata (§12 never-commit list).
--
-- Idempotent (the runner re-applies every *.sql on every migrate): all `create … if not exists`;
-- `alter table … add column IF NOT EXISTS` is idempotent in Postgres; the salt seed is guarded
-- (`where … is null`). FK order: commitment_batches before batch_leaves.

-- Salted tenant commitment input (§16): keeps tenant_commitment non-enumerable. For the demo a
-- deterministic salt keeps the e2e reproducible; PRODUCTION should use a per-tenant secret (KMS /
-- hmac_key_ref), not a migration constant.
alter table tenants add column if not exists tenant_commitment_salt bytea;

create table if not exists commitment_batches (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  batch_number bigint not null,
  batch_type text not null, -- raw_events, revenue_events, ledger_entries, mixed  (M4 demo: 'mixed')
  from_event_seq bigint,    -- event-ordered batches only; null for mixed
  to_event_seq bigint,
  event_count integer not null check (event_count > 0), -- Merkle leaf count (any batch type)
  previous_merkle_root bytea not null check (octet_length(previous_merkle_root) = 32),
  merkle_root bytea not null check (octet_length(merkle_root) = 32),
  schema_hash bytea not null check (octet_length(schema_hash) = 32),
  metadata_policy_hash bytea not null check (octet_length(metadata_policy_hash) = 32),
  data_availability_uri_hash bytea check (data_availability_uri_hash is null or octet_length(data_availability_uri_hash) = 32),
  -- M4 superset (not in the §7.12 sketch; additive, no rewrite):
  batch_id bytea not null check (octet_length(batch_id) = 32),  -- the reproducible contract key (§17.4)
  status text not null default 'built' check (status in ('built', 'committed')),
  arc_chain_id bigint,
  arc_contract_address text,
  arc_tx_hash text,
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, batch_number),
  unique (tenant_id, batch_id)
);

create index if not exists commitment_batches_tenant_status_idx on commitment_batches (tenant_id, status);

-- The exact committed leaf set + ordering, so the verifier-package generator can reconstruct proofs.
-- A record may be committed at most once (global unique on record identity prevents double-commit).
create table if not exists batch_leaves (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  commitment_batch_id uuid not null references commitment_batches(id),
  leaf_index integer not null check (leaf_index >= 0),
  record_type text not null check (record_type in ('revenue_event', 'ledger_entry')),
  record_id uuid not null,
  leaf_hash bytea not null check (octet_length(leaf_hash) = 32),
  created_at timestamptz not null default now(),
  unique (commitment_batch_id, leaf_index),
  unique (tenant_id, record_type, record_id) -- a record lands in exactly one batch
);

create index if not exists batch_leaves_batch_idx on batch_leaves (commitment_batch_id);

-- Deterministic demo-tenant salt (guarded: only sets when unset, so re-running migrate is a no-op).
-- 32-byte salt = ascii "Ledgerline-demo-tenant-salt-v001" (tenantCommitment requires exactly 32 bytes).
update tenants
   set tenant_commitment_salt = decode('4c65646765726c696e652d64656d6f2d74656e616e742d73616c742d76303031', 'hex')
 where id = '00000000-0000-4000-8000-000000000001'
   and tenant_commitment_salt is null;
