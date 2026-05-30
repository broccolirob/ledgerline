-- M2 seed: the demo exact pricing model + the principal_gross 4-way split group.
-- Tenant 00000000-0000-4000-8000-000000000001 is seeded by 0002.
--
-- Idempotency (the runner re-applies this file on EVERY migrate): per-table conflict targets are
-- MANDATORY. pricing_models / split_groups conflict on their (tenant_id, name, version) natural key;
-- split_rules has NO natural unique key, so it uses DETERMINISTIC LITERAL UUIDs + on conflict (id)
-- do nothing (a bare `on conflict do nothing` would duplicate the four rows on every re-run and
-- corrupt the split). Does NOT touch seller_endpoints (no endpoint row is seeded; out of M2 scope).

-- Exact pricing model: $0.003 = 3000 atomic USDC units (the Invariant 2 tie-out target).
insert into pricing_models (id, tenant_id, name, version, pricing_type, asset, fixed_amount_atomic, active)
values (
  '00000000-0000-4000-8000-0000000000a1',
  '00000000-0000-4000-8000-000000000001',
  'company-brief-exact',
  1,
  'exact',
  'USDC',
  3000,
  true
)
on conflict (tenant_id, name, version) do nothing;

-- principal_gross split group v1, reserve_treatment none.
insert into split_groups (id, tenant_id, name, version, revenue_treatment, reserve_treatment, effective_from, active)
values (
  '00000000-0000-4000-8000-0000000000b1',
  '00000000-0000-4000-8000-000000000001',
  'company-brief-default',
  1,
  'principal_gross',
  'none',
  '2026-01-01T00:00:00Z',
  true
)
on conflict (tenant_id, name, version) do nothing;

-- Four value-chain split rules = 10000 bps (pure-percentage; dust is zero on 3000).
-- recipient_id constants: publisher c1 / model_provider c2 / data_provider c3 / referrer c4.
-- rule id constants: d1..d4. on conflict (id) is the idempotency anchor (split_rules has no
-- natural unique key).
insert into split_rules (id, tenant_id, split_group_id, recipient_id, role, percentage_bps, priority)
values
  ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c1', 'publisher',      7000, 100),
  ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c2', 'model_provider', 2000, 100),
  ('00000000-0000-4000-8000-0000000000d3', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c3', 'data_provider',   700, 100),
  ('00000000-0000-4000-8000-0000000000d4', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000c4', 'referrer',        300, 100)
on conflict (id) do nothing;
