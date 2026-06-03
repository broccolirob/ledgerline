# Ledgerline — demo script (presenter's guide)

One command — `pnpm demo` — runs the §21 nine-step sequence end to end and narrates each step. This is
the presenter's companion: what to say at each banner, and what the audience is looking at.

**One-line pitch:** "x402 makes the payment trivial. Ledgerline makes the *revenue* from that payment
reconcilable, auditable, split-ready, and provably anchored on Arc."

## Before you present

```zsh
pnpm db:up && pnpm db:migrate     # Postgres up, schema applied
pnpm demo                         # dry-run it once; it's idempotent, so run it as many times as you like
```

Modes (the demo prints a capability banner up top, so you know which you're in):
- **CAPTURED-START** (no buyer creds) — starts from the 2 real receipt analogs captured during the
  live M0/M1 runs. Steps 1–3 are narrated as "already proven live at M0."
- **LIVE-PAY** (buyer creds + seller running via `pnpm dev`) — runs the real `402 → pay → 200` loop.
- **ON-CHAIN** (anchor creds in `.env`) — submits + verifies against the live contract
  (`0x3Bd5966789CA3F00ecB25D262099c9DDE0e90EC4`). **OFFLINE** otherwise.

For the strongest demo: ON-CHAIN mode (anchor creds set). Step 9 then reads the real Arc root + tx.

## The nine steps — what to say

1–3. **Paid x402 call (Gateway Nanopayments, Arc Testnet).** "An AI agent pays $0.003 USDC for a
   company-brief API call — no account, no API key, no invoice. Sub-cent, gas-free, settled on Arc."
   (LIVE-PAY shows the loop; CAPTURED-START notes it was proven live at M0, D-0004.)

4–5. **Recognition + 4-way split → balanced double-entry ledger.** "Moving the money was the easy
   part. Here's the hard part nobody else does: that one payment becomes an *earned revenue event* and
   a balanced journal — $0.003 split 70/20/7/3 across the API publisher, model provider, data provider,
   and marketplace referrer. ΣDebits = ΣCredits. Real accounting, not a spreadsheet."

6. **Recipient statement.** "Per-recipient: who is owed what, ready for payout — the multi-party split
   that a model router or data marketplace actually needs."

7. **Finance export.** "CSV a controller can open today — revenue events join-traceable back to the
   receipt and delivery. NetSuite/QuickBooks/Xero connectors are the productization path."

8. **Commit to Arc.** "We canonicalize the records, build a keccak Merkle tree, and commit the root
   on-chain to `RevenueBatchAnchor`. Only the root + policy hashes go on-chain — never customer data,
   prompts, or amounts. Here's the real Arc Testnet transaction." (ON-CHAIN prints the tx hash.)

9. **Verifier.** "And here's the moat: an *independent* verifier re-derives every record from source,
   recomputes the root, and proves this revenue event is in the root committed on Arc — 14 checks,
   including the live on-chain root match and transaction finality. Tamper with any record and step 0
   fails." End on: **"This x402 payment is not just paid. It is reconcilable, auditable, split-ready,
   and Arc-anchored."**

## If asked "what's real vs. roadmap?"

Be straight (it builds credibility): the default demo run ships on the **Path C** receipt analog. **M6c**
adds optional capture + verification of the **official x402 signed offer/receipt** (Path B) when
`RECEIPT_SIGNING_KEY` is set — the verifier then checks the real EIP-712 signature, the offer↔receipt
bind, and the amount tie-out. Say it precisely: *captured and verified, with signer-registry pinning
deferred to M7* — M6c does not claim the recovered signer is a registered seller key. No hosted dashboard
yet — CSV is the MVP substitute. Adapter-event authentication (M6b), SIWX, Gateway reconciliation, and
cash-collection/refund flows are deferred and named in `docs/THREAT_MODEL.md`. Everything shown in `pnpm demo` is running
code with passing tests and a real on-chain transaction.

## Backup / troubleshooting

- Seller not up for LIVE-PAY? The demo falls back to CAPTURED-START automatically and says so.
- Want to reset and re-show the on-chain commit? The batch is already committed (idempotent); to
  demo a *fresh* commit, recognize a new paid call first, then `anchor:build` produces batch #2.
- Verifier shows `PASS (offline …)`? You're not in ON-CHAIN mode — set the anchor creds in `.env`.
