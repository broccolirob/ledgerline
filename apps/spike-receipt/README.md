# spike-receipt — Milestone-0 spike (NOT part of the demo)

A kept spike that **proved Path B is achievable** (see `DECISION_LOG.md` D-0001). It produces and
**independently verifies** the official x402 EIP-712 signed offer + receipt
(`@x402/extensions` → `offer-receipt`) on an `x402ResourceServer` wired to Circle's
`BatchFacilitatorClient` + `GatewayEvmScheme`, and confirms `server.initialize()` against Circle's
testnet facilitator. No payment is made (no USDC spent).

```zsh
pnpm --filter @ledgerline/spike-receipt start
```

**Path B is now implemented (M6c, D-0012).** The spike's issue/verify logic has been promoted into the
tested OSS library **`@ledgerline/x402-receipts`**, and the demo seller (`apps/demo-seller-express`)
issues + captures the official EIP-712 offer/receipt **alongside** Circle's middleware (approach B)
when `RECEIPT_SIGNING_KEY` is set; the analog remains a labelled fallback. This app is kept as the
original achievability proof and as the example that registers the extension on an `x402ResourceServer`.

About the "known wrinkle" (the `@x402/core` ↔ `@circle-fin/x402-batching` type-skew): it turned out to
be **moot for the production path**. The offer/receipt **issuer is standalone** (it only signs
payloads), so the capture path never constructs an `x402ResourceServer`/facilitator and the skew never
arises — `@ledgerline/x402-receipts` needs no `as unknown` casts and no `@x402/core` pin. The skew
only appears in *this spike*, because it additionally registers the extension on a ResourceServer to
prove composition with Circle's facilitator (the documented casts in `src/server.ts` stay there).
