// Arc Testnet on-chain client (viem) — Track-A-gated. Imported ONLY by the submit CLI and by
// verify(--onchain) via dynamic import, so the offline build/verify/test path never loads viem.
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const ARC_TESTNET_CHAIN_ID = 5042002;

/** Arc Testnet — USDC is the gas token. nativeCurrency decimals (18) is cosmetic for our writes
 *  (no value transfer); verify against Arc docs if fee display matters. */
export function arcTestnet(rpcUrl: string) {
  return defineChain({
    id: ARC_TESTNET_CHAIN_ID,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export const ANCHOR_ABI = [
  {
    type: 'function',
    name: 'commitBatch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tenantCommitment', type: 'bytes32' },
      { name: 'batchId', type: 'bytes32' },
      { name: 'batchNumber', type: 'uint64' },
      { name: 'previousMerkleRoot', type: 'bytes32' },
      { name: 'merkleRoot', type: 'bytes32' },
      { name: 'eventCount', type: 'uint64' },
      { name: 'schemaHash', type: 'bytes32' },
      { name: 'metadataPolicyHash', type: 'bytes32' },
      { name: 'dataAvailabilityUriHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'latestRootByTenant',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    // Per-batch getter (auto-generated from `mapping(bytes32 => Batch) public batches`). Lets the
    // verifier read the SPECIFIC committed batch's root by batchId, not just the tenant's chain tip.
    type: 'function',
    name: 'batches',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'tenantCommitment', type: 'bytes32' },
      { name: 'batchId', type: 'bytes32' },
      { name: 'batchNumber', type: 'uint64' },
      { name: 'previousMerkleRoot', type: 'bytes32' },
      { name: 'merkleRoot', type: 'bytes32' },
      { name: 'eventCount', type: 'uint64' },
      { name: 'schemaHash', type: 'bytes32' },
      { name: 'metadataPolicyHash', type: 'bytes32' },
      { name: 'dataAvailabilityUriHash', type: 'bytes32' },
      { name: 'committedAt', type: 'uint64' },
    ],
  },
] as const;

export interface TrackAEnv {
  rpcUrl: string;
  key: Hex;
  contract: Hex;
}

/** Read the Track-A env. Returns null (no throw) when any var is missing — mirrors demo-buyer. */
export function getEnv(): TrackAEnv | null {
  const rpcUrl = process.env.ARC_RPC_URL;
  const key = process.env.ANCHOR_COMMITTER_KEY;
  const contract = process.env.ANCHOR_CONTRACT_ADDRESS;
  if (!rpcUrl || !key || !contract) return null;
  return { rpcUrl, key: key as Hex, contract: contract as Hex };
}

export interface CommitArgs {
  tenantCommitment: string;
  batchId: string;
  batchNumber: bigint;
  previousMerkleRoot: string;
  merkleRoot: string;
  eventCount: bigint;
  schemaHash: string;
  metadataPolicyHash: string;
  dataAvailabilityUriHash: string;
}

/** Submit one batch via commitBatch and wait for the receipt. Throws if Track-A env is absent. */
export async function commitBatchOnchain(a: CommitArgs): Promise<{ txHash: string; contract: string; chainId: number }> {
  const env = getEnv();
  if (!env) throw new Error('commitBatchOnchain: Track-A env missing (ARC_RPC_URL / ANCHOR_COMMITTER_KEY / ANCHOR_CONTRACT_ADDRESS)');
  const chain = arcTestnet(env.rpcUrl);
  const wallet = createWalletClient({ account: privateKeyToAccount(env.key), chain, transport: http(env.rpcUrl) });
  const pub = createPublicClient({ chain, transport: http(env.rpcUrl) });
  const txHash = await wallet.writeContract({
    address: env.contract,
    abi: ANCHOR_ABI,
    functionName: 'commitBatch',
    args: [
      a.tenantCommitment as Hex, a.batchId as Hex, a.batchNumber, a.previousMerkleRoot as Hex, a.merkleRoot as Hex,
      a.eventCount, a.schemaHash as Hex, a.metadataPolicyHash as Hex, a.dataAvailabilityUriHash as Hex,
    ],
    chain,
  });
  // waitForTransactionReceipt RESOLVES on a mined-but-REVERTED tx (status:'reverted') — it does not
  // throw. Assert success, else a reverted commit (bad prev-root, dup batchId, missing role) would be
  // recorded by submitNextBatch as 'committed', corrupting anchor state + diverging the local chain.
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`commitBatchOnchain: tx ${txHash} reverted on-chain (status=${receipt.status}); batch left uncommitted`);
  }
  return { txHash, contract: env.contract, chainId: ARC_TESTNET_CHAIN_ID };
}

/** Per-batch committed merkle root from the contract's `batches(batchId)` getter; null if env absent
 *  or the batch is not on-chain (all-zero merkleRoot). This is the batch-SPECIFIC root, so verifying a
 *  historical (non-latest) batch no longer false-rejects against the tenant's moving chain tip. */
export async function readOnchainBatchRoot(batchIdHex: string): Promise<string | null> {
  const env = getEnv();
  if (!env) return null;
  const pub = createPublicClient({ chain: arcTestnet(env.rpcUrl), transport: http(env.rpcUrl) });
  const b = (await pub.readContract({
    address: env.contract,
    abi: ANCHOR_ABI,
    functionName: 'batches',
    args: [batchIdHex as Hex],
  })) as readonly unknown[];
  const merkleRoot = b[4] as string; // struct field order: [tc, batchId, num, prevRoot, merkleRoot, ...]
  if (!merkleRoot || /^0x0{64}$/.test(merkleRoot)) return null; // uncommitted batchId
  return merkleRoot;
}

/** latestRootByTenant(tenant_commitment) → 0x-hex, or null if Track-A env absent. */
export async function readOnchainRoot(tenantCommitmentHex: string): Promise<string | null> {
  const env = getEnv();
  if (!env) return null;
  const pub = createPublicClient({ chain: arcTestnet(env.rpcUrl), transport: http(env.rpcUrl) });
  const root = await pub.readContract({ address: env.contract, abi: ANCHOR_ABI, functionName: 'latestRootByTenant', args: [tenantCommitmentHex as Hex] });
  return root as string;
}

/** A tx is "final" for the demo when its receipt confirms success. */
export async function isTxFinal(txHash: string): Promise<boolean> {
  const env = getEnv();
  if (!env) return false;
  const pub = createPublicClient({ chain: arcTestnet(env.rpcUrl), transport: http(env.rpcUrl) });
  try {
    const r = await pub.getTransactionReceipt({ hash: txHash as Hex });
    return r.status === 'success';
  } catch {
    return false;
  }
}
