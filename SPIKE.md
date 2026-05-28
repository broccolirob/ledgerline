# SPIKE — Week-1 SDK Surface Confirmation (Ledgerline M0)

Goal: answer these against the **installed, pinned** packages (read `node_modules`, run
code) BEFORE building any Ledgerline abstraction. `[x]` = confirmed from the installed
type definitions (`@circle-fin/x402-batching@3.0.4`, read 2026-05-28). `[ ]` = still
RUNTIME-only (needs the live Arc Testnet loop, i.e. Track A credentials).

## A. Package resolution & exports
- [x] `@circle-fin/x402-batching` resolves to **3.0.4**; `exports` exposes `.`, `./server`, `./client` (dual ESM/CJS).
- [x] `createGatewayMiddleware` exported from `./server`; `GatewayClient` from `./client` (read `dist/{server,client}/index.d.mts`).
- [x] `arcTestnet` chain name is **moot for viem/chains** — the SDK ships its own `CHAIN_CONFIGS`/`GATEWAY_DOMAINS` keyed by `SupportedChainName` (`arcTestnet` = Gateway domain 26). The buyer uses the SDK chain name, not `viem/chains`.
- [x] peer deps `viem ^2`, `@x402/core ^2.3`, `@x402/evm ^2.3` installed (pnpm auto-install-peers default).

## B. Seller middleware surface
- [x] `createGatewayMiddleware({ sellerAddress: string; networks?: string|string[]; facilitatorUrl?: string; description? }) -> GatewayMiddleware`.
- [x] `gateway.require(price: string) -> MiddlewareFunction` (also exposes `.verify`, `.settle`).
- [x] `facilitatorUrl` DEFAULTS TO MAINNET (`https://gateway-api.circle.com`); the testnet URL `https://gateway-api-testnet.circle.com` must be passed explicitly (confirmed in the `.d.mts` doc comment). The seller code does this.
- [x] The middleware wires the facilitator + scheme internally. Lower-level path (relevant to §E): `new x402ResourceServer([new BatchFacilitatorClient({url})]).register('eip155:5042002', new GatewayEvmScheme())`.
- [ ] **RUNTIME (core M0 assumption):** does `gateway.require('$0.003')` (sub-cent / 3000 atomic) parse, or reject >2 decimals? The type accepts any string; `parsePrice` behavior at 3 decimals is unconfirmed. **Test in the live loop.**

## C. Payment context for the raw_event (M0 ACCEPTANCE GATE item)
- [x] `req.payment` shape CONFIRMED: `{ verified: boolean; payer: string; amount: string; network: string; transaction?: string }`.
- [x] **No Payment-Identifier and no signed offer/receipt are surfaced by Circle's middleware.** -> SDK limitation **DOCUMENTED** (satisfies the M0 gate "Payment-Identifier captured OR limitation documented"). The raw_event idempotency key must be a **Ledgerline receipt analog** (Path C, DECISION_LOG D-0001).
- [ ] **RUNTIME:** is `transaction` populated at 200-time, given Nanopayments settle ASYNCHRONOUSLY (batched)? Likely not. Record what's observable in the live loop.
- [x] `canonicalHash()` preserves NESTED keys via a recursive `stableStringify` (regression guard lives in `@ledgerline/seller-client`; add a unit test).

## D. Buyer client surface
- [x] `new GatewayClient({ chain: SupportedChainName; privateKey: Hex; rpcUrl? })`; `'arcTestnet'` valid (domain 26).
- [x] `pay(url, { method?, body?, headers? }) -> PayResult { data, amount: bigint, formattedAmount, transaction, status }`.
- [x] `getBalances() -> { wallet:{balance,formatted}, gateway:{ available: bigint, total, withdrawable, ... } }` — buyer uses `gateway.available` (bigint) for the zero-balance guard.
- [x] `deposit(amount: string) -> DepositResult`; also `getTransferById`, `searchTransfers` (reconciliation, deferred).
- [ ] **RUNTIME:** does `pay()` complete the 402 -> sign (EIP-3009) -> retry -> 200 loop on Arc Testnet? Needs a funded, deposited buyer (Track A).

## E. Signed Offers & Receipts capture-path investigation (Path A/B/C)
- **Finding (type-level):** `createGatewayMiddleware` exposes **no `registerExtension` / `x402ResourceServer` seam**. But the package exports `BatchFacilitatorClient` + `GatewayEvmScheme`, and the `.d.mts` documents the lower-level pattern `new x402ResourceServer([circleClient]).register('eip155:5042002', new GatewayEvmScheme())`. So **Path A likely requires dropping from the convenience middleware down to the `x402ResourceServer` level** and registering the official offer-receipt extension there (this is closer to "Path B" in structure). **Decision stays OPEN** pending the timeboxed wiring attempt.
- [ ] DEDICATED SIGNING KEY: provision a separate EOA (never the payment address) for the offer/receipt issuer.
- [ ] Attempt the `x402ResourceServer` + offer-receipt-extension wiring (TIMEBOX ~2-3 days). If it resists, fall back to Path C.
- [x] PATH C — Ledgerline receipt analog (request fingerprint + delivery record, no Payment-Identifier available) is buildable purely from `req.payment` + request metadata. Guaranteed fallback that satisfies the M0 gate.

## F. Decision
- [ ] Record the A/B/C decision + evidence in `DECISION_LOG.md` (D-0001) after the timeboxed attempt.
