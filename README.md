# Ledgerline

Open-source seller-side **revenue subledger** for x402 + Circle Gateway Nanopayments, anchored on
Arc. It turns paid agent/API calls into finance-grade revenue: capture each paid call, recognize it as
double-entry revenue, split it across the parties behind the response, export finance-ready records,
and commit a tamper-evident Merkle root to Arc that anyone can independently verify.

> **Status: live on Arc Testnet (M0–M6 complete, pre-alpha).** A paid `$0.003` x402 call over Circle
> Gateway Nanopayments on Arc Testnet is captured, recognized into an `earned` revenue event + a
> balanced double-entry ledger, split four ways, exported to CSV, and committed as a Merkle batch root
> **on-chain** (`RevenueBatchAnchor` at `0x3Bd5966789CA3F00ecB25D262099c9DDE0e90EC4`, chain 5042002;
> batch #1 committed in tx `0x7ee7c6a74bb491eab3da395813661925976316613c959aceb7cad5170d06233a`). An
> independent verifier proves a revenue event is in that on-chain root — every applicable check
> passes (in the default Path-C run, steps 2–3 are N/A — no official signed receipt; **M6c** makes them
> real when official receipts are issued). Run it with **`pnpm demo`**.
>
> **No-overclaim:** the default demo run ships on **Path C** — a *Ledgerline receipt analog* (request
> fingerprint + redacted payment context + delivery record), **not** an official x402 *signed receipt*.
> **M6c** adds optional capture + verification of the **official x402 EIP-712 signed offer/receipt**
> (Path B): set `RECEIPT_SIGNING_KEY` and verifier steps 1–3 check the real artifact's signature,
> offer↔receipt bind, and amount tie-out. The claim is precise: *official x402 signed offer/receipt
> captured and verified; signer registry pinning deferred to M7* — M6c proves the artifacts are
> signature-valid + internally consistent and bind to the revenue event, but does **not** pin the signer
> to a *registered* seller key. See `DECISION_LOG.md` D-0001/D-0012 and `docs/THREAT_MODEL.md` for the
> honest T1–T16 status.

## The pipeline (demo §21, end to end)

```
x402 paid call ──▶ Ledgerline receipt analog (raw_events)        [M0/M1]
   └─▶ recognize ──▶ earned revenue_event + balanced journal       [M2]  3000 → 2100/600/210/90, ΣDr=ΣCr
        └─▶ build  ──▶ canonical leaves → keccak Merkle root        [M4]  LCJ v1 + RFC-9162
             └─▶ submit ─▶ RevenueBatchAnchor.commitBatch (Arc)     [M4]  previous-root chained
                  └─▶ verify ─▶ 14-step inclusion proof vs on-chain  [M4]  offline or --onchain
```

## What's here

| Path | Package | Role |
|------|---------|------|
| `packages/express` | `@ledgerline/express` | Drop-in seller adapter — captures the receipt analog (+ optional official x402 artifacts) on response finish |
| `packages/seller-client` | `@ledgerline/seller-client` | Request fingerprint + raw-event write path + sink + adapter-event signing (M6b) |
| `packages/recognition` | `@ledgerline/recognition` | Recognition pass: `raw_events` → `revenue_events` + double-entry ledger + split |
| `packages/x402-receipts` | `@ledgerline/x402-receipts` | Official x402 EIP-712 Signed Offer/Receipt — issue + verify (Path B, M6c) |
| `packages/canonical` | `@ledgerline/canonical` | LCJ v1 canonicalization + keccak256 + RFC-9162 Merkle + frozen §17.5 vectors |
| `packages/anchor` | `@ledgerline/anchor` | Batch builder, on-chain client, the 14-step verifier, the `pnpm demo` script |
| `packages/db` | `@ledgerline/db` | Postgres schema + migrations (0001–0007) |
| `contracts/` | — | `RevenueBatchAnchor` Arc anchor contract (Foundry, MIT) |
| `apps/demo-seller-express`, `apps/demo-buyer` | — | Example x402 seller + buyer on Arc Testnet |

## Quickstart

Requires **Node 22+**, **pnpm 10**, **Docker**, and (for contract tests) **Foundry**.

```zsh
pnpm install
pnpm db:up && pnpm db:migrate     # Postgres 16 on host port 5433; applies migrations 0001–0007
pnpm demo                         # the §21 nine-step sequence, end to end
```

`pnpm demo` is **resilient + idempotent**: it runs the live `402 → pay → 200` loop when buyer creds +
a running seller are present, otherwise it starts from the already-captured `raw_events` from the live
M0/M1 runs. It commits + verifies on Arc when anchor creds are in `.env`, otherwise it stays offline
(DB-consistent) and tells you so. A capability banner prints the mode.

To integrate Ledgerline into your own x402 seller, see **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.
To present the demo, see **[docs/DEMO.md](docs/DEMO.md)**.

## Commands

| Command | Does |
|---------|------|
| `pnpm demo` | The full §21 sequence (capture → recognize → split → export → commit → verify) |
| `pnpm recognize` | Recognize un-recognized receipt analogs into revenue events + ledger |
| `pnpm anchor:build` | Build a Merkle commitment batch from earned revenue |
| `pnpm anchor:submit` | Commit the built batch to Arc Testnet (Track-A creds) |
| `pnpm verify [--onchain]` | Run the 14-step verifier on a revenue event |
| `pnpm export:csv` | Finance-ready `revenue_events.csv` + `ledger_entries.csv` |
| `pnpm test` · `pnpm test:security` | Full vitest suite · the §19 security subset |
| `pnpm contracts:test` · `pnpm vectors:check` | Foundry contract tests · frozen canonicalization vectors |

## Credentials (Track A)

The credential-free path (capture, recognize, build, offline verify, all tests) runs with **zero
secrets**. Live payment needs Arc Testnet buyer creds; live anchoring needs `ARC_RPC_URL` +
`ANCHOR_COMMITTER_KEY` (a funded testnet EOA — USDC is gas on Arc) + `ANCHOR_CONTRACT_ADDRESS`. See
`.env.example`. Secrets live only in the gitignored `.env`.

## What's deferred (honestly)

Hosted ingestion API + API-key management + the §9 at-rest encryption envelope (M7); the dashboard UI
(CSV is the MVP substitute); SIWX repeat-access, Gateway transfer reconciliation, cash collection /
refund reversals. Official x402 signed offer/receipt capture + verification (Path B) is **implemented in
M6c**, but it is opt-in (`RECEIPT_SIGNING_KEY`), not yet live-proven (the real payment→receipt loop is
Track-A-gated), and pinning the recovered signer to a *registered* seller key (the operated receipt-key
registry) is deferred to **M7**. See `docs/THREAT_MODEL.md` and `DECISION_LOG.md` (D-0012).

## License

Apache-2.0. The Arc anchor contract under `contracts/` is MIT. See `LICENSE`.
