-- M1: seed a demo tenant so the demo seller can write raw_events (raw_events.tenant_id -> tenants).
-- Idempotent; the id is the DEMO_TENANT_ID constant in apps/demo-seller-express.
insert into tenants (id, name, slug)
values ('00000000-0000-4000-8000-000000000001', 'Demo Tenant', 'demo')
on conflict (id) do nothing;
