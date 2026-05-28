-- Milestone 0: the three tables the demo needs (tenants, seller_endpoints, raw_events).
create extension if not exists pgcrypto;  -- provides gen_random_uuid()

create table if not exists tenants (
  id uuid primary key,
  name text not null,
  slug text unique not null,
  created_at timestamptz not null default now(),
  kms_key_ref text,
  hmac_key_ref text,
  metadata_retention_days integer not null default 365,
  status text not null default 'active'
);

create table if not exists seller_endpoints (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  external_id text not null,
  name text not null,
  method text not null,
  route_pattern text not null,
  default_pricing_model_id uuid,
  default_split_group_id uuid,
  pay_to_address text not null,
  default_network text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, external_id)
);

create table if not exists raw_events (
  id text primary key,                  -- ULID or UUIDv7
  tenant_id uuid not null references tenants(id),
  event_type text not null,
  event_source text not null,           -- seller_sdk, gateway_snapshot, arc_indexer, admin
  source_version text,
  idempotency_key text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  canonical_hash bytea not null,
  payload_redacted jsonb not null,
  encrypted_payload_uri text,
  adapter_key_id text,
  adapter_signature text,
  schema_version text not null,
  event_seq bigserial,
  unique (tenant_id, idempotency_key)
);
