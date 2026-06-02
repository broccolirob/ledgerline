-- M6b (build-plan Milestone 6b): adapter-event signing key registry — closes threat T6.
-- The capturing adapter signs each raw_event with a per-tenant Ed25519 key; the recognition pass
-- verifies the signature against this registry before recognizing (recognition: requireAdapterSignature).
-- This is the OSS/local half of T6: the schema + reference verifier are public; the OPERATED registry
-- service, automated rotation/revocation, and hosted-ingestion verification are M7/private (see
-- COMMERCIAL_BOUNDARY.md). Only public keys live here — adapter PRIVATE keys never touch the DB.
--
-- Idempotent (the runner re-applies every *.sql on every migrate): `create … if not exists`.

create table if not exists adapter_keys (
  tenant_id  uuid not null references tenants(id),
  key_id     text not null,                                   -- short id (first 16 hex of sha256(pubkey))
  public_key text not null,                                   -- Ed25519 SPKI PEM
  algorithm  text not null default 'ed25519' check (algorithm = 'ed25519'),
  status     text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (tenant_id, key_id)
);

-- Rotation = insert a new active key; revocation = update status='revoked', revoked_at=now().
create index if not exists adapter_keys_tenant_status_idx on adapter_keys (tenant_id, status);
