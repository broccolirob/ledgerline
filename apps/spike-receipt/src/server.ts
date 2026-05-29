// SPIKE (Path B): can we produce + independently verify the OFFICIAL x402 Signed Offer/Receipt
// on an x402ResourceServer wired to Circle's BatchFacilitatorClient + GatewayEvmScheme?
// Run: pnpm --filter @ledgerline/spike-receipt start   (no payment, no USDC spent)
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { SchemeNetworkServer } from '@x402/core/types';
import { BatchFacilitatorClient, GatewayEvmScheme } from '@circle-fin/x402-batching/server';
import {
  OFFER_RECEIPT,
  createEIP712OfferReceiptIssuer,
  createOfferReceiptExtension,
  verifyOfferSignatureEIP712,
  verifyReceiptSignatureEIP712,
  isEIP712SignedOffer,
  isEIP712SignedReceipt,
  type SignTypedDataFn,
} from '@x402/extensions/offer-receipt';

const NETWORK = 'eip155:5042002'; // Arc Testnet
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'https://gateway-api-testnet.circle.com';
const USDC = '0x3600000000000000000000000000000000000000';
const PAYER_PLACEHOLDER = '0x000000000000000000000000000000000000dEaD';

async function main(): Promise<void> {
  // 1) Dedicated offer/receipt signing key — DISTINCT from any payment/receive address (spec requirement).
  const signer = privateKeyToAccount(generatePrivateKey());
  console.log('[spike] dedicated signing address:', signer.address);
  const signTypedData: SignTypedDataFn = (params) =>
    signer.signTypedData(params as Parameters<typeof signer.signTypedData>[0]);
  const kid = `did:pkh:eip155:5042002:${signer.address}`;

  // 2) Official issuer + extension.
  const issuer = createEIP712OfferReceiptIssuer(kid, signTypedData);
  const extension = createOfferReceiptExtension(issuer);

  // 3) Produce the official artifacts and verify them independently (recover the signer address).
  const offer = await issuer.issueOffer('/api/company-brief', {
    acceptIndex: 0,
    scheme: 'exact',
    network: NETWORK,
    asset: USDC,
    payTo: signer.address,
    amount: '3000',
  });
  const receipt = await issuer.issueReceipt('/api/company-brief', PAYER_PLACEHOLDER, NETWORK, 'gateway-transfer-uuid');
  if (!isEIP712SignedOffer(offer) || !isEIP712SignedReceipt(receipt)) {
    throw new Error('expected EIP-712 artifacts');
  }
  const offerV = await verifyOfferSignatureEIP712(offer);
  const receiptV = await verifyReceiptSignatureEIP712(receipt);
  const offerOk = offerV.signer.toLowerCase() === signer.address.toLowerCase();
  const receiptOk = receiptV.signer.toLowerCase() === signer.address.toLowerCase();
  console.log('[spike] OFFER verified — recovered signer matches dedicated key:', offerOk);
  console.log('[spike]   offer payload:', JSON.stringify(offerV.payload));
  console.log('[spike] RECEIPT verified — recovered signer matches dedicated key:', receiptOk);
  console.log('[spike]   receipt payload:', JSON.stringify(receiptV.payload));

  // 4) Does the extension compose with Circle's facilitator + Gateway scheme on a real server?
  const facilitator = new BatchFacilitatorClient({ url: FACILITATOR_URL });
  // KNOWN TYPE-SKEW (Path B finding): @circle-fin/x402-batching bundles its own slightly-older
  // x402 interfaces, so its FacilitatorClient/SchemeNetworkServer aren't type-assignable to
  // @x402/core@2.13.0's. Runtime is compatible (this spike runs green); the casts paper over the
  // type drift. Real fix for the B milestone: pin @x402/core to the version Circle built against.
  const server = new x402ResourceServer(facilitator as unknown as FacilitatorClient)
    .register(NETWORK, new GatewayEvmScheme() as unknown as SchemeNetworkServer)
    .registerExtension(extension);
  console.log('[spike] registered extension key:', OFFER_RECEIPT, '| hasExtension:', server.hasExtension(OFFER_RECEIPT));
  await server.initialize();
  console.log('[spike] server.initialize() OK — offer-receipt extension composes with Circle facilitator + GatewayEvmScheme');

  const verdict = offerOk && receiptOk;
  console.log(`[spike] RESULT: ${verdict ? 'PASS' : 'FAIL'} — official x402 Signed Offer + Receipt produced AND independently verified; extension registered + server initialized against Circle Gateway testnet.`);
  if (!verdict) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[spike] FAILED:', e);
  process.exit(1);
});
