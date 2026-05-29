# spike-receipt — Milestone-0 spike (NOT part of the demo)

A kept spike that **proved Path B is achievable** (see `DECISION_LOG.md` D-0001). It produces and
**independently verifies** the official x402 EIP-712 signed offer + receipt
(`@x402/extensions` → `offer-receipt`) on an `x402ResourceServer` wired to Circle's
`BatchFacilitatorClient` + `GatewayEvmScheme`, and confirms `server.initialize()` against Circle's
testnet facilitator. No payment is made (no USDC spent).

```zsh
pnpm --filter @ledgerline/spike-receipt start
```

This is **not** part of the Path-C demo flow — the demo seller (`apps/demo-seller-express`) ships on
the Ledgerline receipt analog. This app is retained as the **foundation for the post-demo Path B
milestone** (official signed receipts). Known wrinkle to resolve when B is built: pin `@x402/core`
to the version Circle's `x402-batching` was built against (a type-skew, runtime-compatible — see the
documented casts in `src/server.ts`).
