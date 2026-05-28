// Demo buyer that pays for the seller's x402 route over Arc Testnet.
// dev: pnpm dev:buyer   (-> tsx --env-file-if-exists=../../.env src/index.ts)
import { GatewayClient } from '@circle-fin/x402-batching/client';

async function main(): Promise<void> {
  // ---- CREDENTIAL BOUNDARY --------------------------------------------------
  // BUYER_PRIVATE_KEY is TESTNET-ONLY and supplied by Track A. Until it lands, exit early
  // so this script runs cleanly (no crash) before credentials arrive.
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  if (!privateKey) {
    console.warn(
      '[demo-buyer] BUYER_PRIVATE_KEY not set — buyer is code-ready but cannot pay yet. ' +
        'Blocked on Track A (wallet + faucet USDC + one-time Gateway deposit).',
    );
    return;
  }

  // chain NAME 'arcTestnet' (a SupportedChainName, GATEWAY_DOMAINS.arcTestnet = 26) on the
  // buyer side — do NOT use the CAIP-2 id 'eip155:5042002' here. Confirmed in dist/client/index.d.mts.
  const gateway = new GatewayClient({
    chain: 'arcTestnet',
    privateKey: privateKey as `0x${string}`,
  });

  // Confirmed API: getBalances() -> { wallet, gateway: { available: bigint, ... } }.
  const balances = await gateway.getBalances();
  console.log('gateway available (atomic):', balances.gateway.available.toString());

  if (balances.gateway.available <= 0n) {
    console.warn(
      '[demo-buyer] No Gateway balance — run the ONE-TIME on-chain deposit first, e.g. ' +
        "await gateway.deposit('1'). On Arc Testnet, USDC is the gas token (fund USDC only); " +
        'the deposit tx must confirm before pay() works. Then re-run pnpm dev:buyer.',
    );
    // One-time deposit (opt-in; uncomment once funded — do NOT leave on or it re-deposits each run):
    // await gateway.deposit('1');
    return;
  }

  const url = process.env.SELLER_URL ?? 'http://localhost:4021/api/company-brief';
  // pay() drives the full 402 -> sign (EIP-3009) -> retry -> 200 loop. The route is POST.
  const result = await gateway.pay(url, { method: 'POST', body: { company: 'Acme Corp' } });
  console.log(
    'paid:',
    result.formattedAmount,
    'USDC | status',
    result.status,
    '| data:',
    result.data,
  );
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
