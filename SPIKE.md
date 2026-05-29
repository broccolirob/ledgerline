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
- [x] **RUNTIME CONFIRMED (2026-05-29, live Arc Testnet loop):** `gateway.require('$0.003')` parses sub-cent fine — unpaid POST returned **402**, the buyer paid **0.003 USDC**, and the seller returned **200** with the brief. The full `402 -> pay -> 200` loop works end-to-end. (Buyer funded via a one-time `gateway.deposit('1')`; deposit + pay confirmed.)

## C. Payment context for the raw_event (M0 ACCEPTANCE GATE item)
- [x] `req.payment` shape CONFIRMED: `{ verified: boolean; payer: string; amount: string; network: string; transaction?: string }`.
- [x] **No Payment-Identifier and no signed offer/receipt are surfaced by Circle's middleware.** -> SDK limitation **DOCUMENTED** (satisfies the M0 gate "Payment-Identifier captured OR limitation documented"). The raw_event idempotency key must be a **Ledgerline receipt analog** (Path C, DECISION_LOG D-0001).
- [x] **RUNTIME CONFIRMED (M1 capture, 2026-05-29):** `transaction` IS populated at 200-time — but as an **opaque Gateway transfer UUID** (e.g. `76ec053d-…`), not an on-chain tx hash (consistent with async batched settlement; matches the plan's `settlement_reference` "opaque; do not assume tx hash"). Unique per payment, so it's the idempotency anchor. The buyer's payment authorization arrives in the **`payment-signature`** request header (base64 x402 payload: EIP-3009 authorization + signature + nonce + accepted offer); captured as `paymentSignatureHash`, never raw, never called a "signed receipt".
- [x] **CAPTURE WIRED:** the Express recorder writes ONE `ledgerline.receipt_analog.v1` raw_event per delivered paid call (request fingerprint + redacted `req.payment` + delivery), idempotent on the settlement UUID. Verified live: 2 paid calls → 2 rows; duplicate `(tenant_id, idempotency_key)` rejected; payer / signature / URL stored only as hashes. **Closes the last credential-dependent M0 gate item.**
- [x] `canonicalHash()` preserves NESTED keys via a recursive `stableStringify`; payload is JSON-normalized once so the stored jsonb and `canonical_hash` cover identical bytes (regression guard in `@ledgerline/seller-client`; add a unit test).

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
