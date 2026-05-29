// One-shot: deposit USDC into the Circle Gateway Wallet for the demo buyer.
//   pnpm deposit                 -> deposits 1 USDC (default)
//   DEPOSIT_USDC=5 pnpm deposit  -> deposits 5 USDC
// NOT idempotent: each run deposits again. Fund once, then `pnpm dev` + `pnpm dev:buyer` to pay.
import { GatewayClient } from '@circle-fin/x402-batching/client';

async function main(): Promise<void> {
  const privateKey = process.env.BUYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error('[deposit] BUYER_PRIVATE_KEY not set in .env (testnet only). Fill it before depositing.');
    process.exit(1);
  }
  const amount = process.env.DEPOSIT_USDC ?? '1';

  // chain NAME 'arcTestnet' on the buyer side (not the CAIP-2 id).
  const gateway = new GatewayClient({
    chain: 'arcTestnet',
    privateKey: privateKey as `0x${string}`,
  });

  const before = await gateway.getBalances();
  console.log('Gateway available before (atomic):', before.gateway.available.toString());
  console.log(`Depositing ${amount} USDC (approve + deposit txs; gas paid in USDC on Arc Testnet)...`);

  const result = await gateway.deposit(amount);
  console.log('deposit tx:', result.depositTxHash, '| amount (atomic):', result.amount.toString());

  const after = await gateway.getBalances();
  console.log('Gateway available after (atomic):', after.gateway.available.toString());
  console.log('Funded. Now run `pnpm dev` (seller) + `pnpm dev:buyer` (pay).');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
