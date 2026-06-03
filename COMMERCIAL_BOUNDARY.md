# Commercial Boundary

This repository (`ledgerline`) is the **open-source layer** of Ledgerline. The hosted commercial
product lives in a separate **private** repository (`ledgerline-cloud`). This document draws the line
so the two stay cleanly separated, and so contributors know what belongs where.

## Two-repo topology

- **`ledgerline` (this repo, public, Apache-2.0):** the OSS reference implementation — the adapter SDK
  (`@ledgerline/express`, `@ledgerline/seller-client`), the recognition / canonicalization / anchor +
  verifier libraries, `packages/db` schema + migrations, the `contracts/` Arc anchor (MIT), and the
  demo apps. This is the trust, adoption, and integration surface.
- **`ledgerline-cloud` (private):** the hosted SaaS — multi-tenant ingestion, auth, operations, and
  customer data. Not published.

## The dependency rule (load-bearing)

> `ledgerline-cloud` **consumes** the published `@ledgerline/*` packages from this repo.
> This repo **never** depends on `ledgerline-cloud`.

The event envelope, the canonical record + Merkle verifier, and the adapter-event signing primitive
are defined here as public packages. The hosted product reuses them; it does not reimplement or
privatize them. If a primitive is part of the integration contract a seller implements against, it is
public, here.

## OSS (public, here) vs commercial (private)

| Layer | OSS (this repo) | Commercial (`ledgerline-cloud`) |
|---|---|---|
| Capture | framework adapters, seller-client capture, request fingerprint | — |
| Recognition / ledger | recognition pass, split engine, double-entry journal | — |
| Proof | LCJ canonicalization, Merkle verifier, `RevenueBatchAnchor` contract, verifier package + CLI | managed proof archive |
| Event signing (T6) | signing envelope + **local reference verifier** (the format + primitive) | **operated** tenant key registry, key rotation/revocation, tenant-scoped verification service |
| Ingestion | local capture → local DB | hosted `POST /v1/events`, API keys, idempotency at scale |
| Multi-tenancy | single-tenant local | tenant auth + isolation enforcement, audit logs, rate limits, dead-letter queues |
| Privacy | field hashing (shipped); the `encrypted-metadata-v1` envelope **format** is a *planned* OSS primitive, **not yet built** (§9; targeted with M7) | operated KMS encryption + key custody |
| Surfaces | demo apps, CLIs, CSV export, integration guide | hosted dashboard, supplier/counterparty portal, accounting connectors |

Rule of thumb: **publish the format, the primitive, and the reference implementation; keep the
operated service, the keys, and the customer data private.**

## Milestone boundary

- **M6 (protocol credibility + secure, framework-clean adapter)** is OSS and lands here: official
  x402 Signed Offers/Receipts, the adapter-event signing envelope + local verifier, adapter cleanup,
  and the integration guide. M6 publishes primitives, not operations.
- **M7 (hosted ingestion + privacy envelope)** is the commercial boundary and lands in
  `ledgerline-cloud`: the operated ingestion API, API-key / tenant auth, KMS-backed encryption, and
  the hosted views. M7 **consumes** the M6 public packages; it does not fork them. (Per the rule above,
  the `encrypted-metadata-v1` envelope **format** is a public primitive — to be defined in this repo
  when built; only the *operated* KMS encryption + key custody that uses it is commercial. Neither
  exists yet.)

## Licensing

- This repo: **Apache-2.0** (`LICENSE`). The Arc contract under `contracts/`: **MIT**
  (`contracts/LICENSE`).
- Apache-2.0 is deliberate. The OSS layer is an **adoption surface** meant to be embedded by sellers,
  so it is permissive: a patent grant and no copyleft friction. Copyleft (e.g. AGPL) is intentionally
  **not** used — the moat is operations, customer relationships, and the hosted product, not code
  secrecy, and a copyleft adapter would chill the embedding it exists to encourage. The valuable
  commercial code is private in `ledgerline-cloud`, which is where defensibility lives.
- Contributions to this repo are accepted under Apache-2.0.

## What this is not

This document describes a technical and licensing boundary only. Confidential business material — GTM
strategy, pricing, prospect lists, design-partner notes, moat-wedge selection — lives in private
planning, never in this public repo.
