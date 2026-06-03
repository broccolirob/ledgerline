// @ledgerline/x402-receipts — issue + verify the OFFICIAL x402 EIP-712 Signed Offer & Receipt (Path B).
// Fully offline: no DB, no network, no USDC. Proves the promoted spike logic round-trips and that
// tamper / mismatch are detected.
import { describe, it, expect } from 'vitest';
import {
  createReceiptIssuer,
  generateReceiptSigningKey,
  verifySignedOffer,
  verifySignedReceipt,
  receiptMatchesOffer,
  offerReceiptArtifactHash,
  type EIP712SignedOffer,
  type EIP712SignedReceipt,
} from '../src/index.js';

const NETWORK = 'eip155:5042002'; // Arc Testnet
const USDC = '0x3600000000000000000000000000000000000000';
const PAY_TO = '0x000000000000000000000000000000000000bEEF';
const PAYER = '0x000000000000000000000000000000000000dEaD';
const RESOURCE = '/api/company-brief';

function newIssuer() {
  return createReceiptIssuer({ privateKey: generateReceiptSigningKey(), network: NETWORK });
}

describe('issue + verify (round-trip)', () => {
  it('verifies an offer back to the dedicated signing address with intact terms', async () => {
    const issuer = newIssuer();
    const offer = await issuer.issueSignedOffer(RESOURCE, {
      network: NETWORK,
      asset: USDC,
      payTo: PAY_TO,
      amount: '3000',
    });
    expect(offer.format).toBe('eip712');
    const v = await verifySignedOffer(offer);
    expect(v).not.toBeNull();
    expect(v!.signer.toLowerCase()).toBe(issuer.address.toLowerCase());
    expect(v!.payload.resourceUrl).toBe(RESOURCE);
    expect(v!.payload.amount).toBe('3000');
    expect(v!.payload.network).toBe(NETWORK);
    expect(v!.payload.payTo).toBe(PAY_TO);
    expect(v!.payload.asset).toBe(USDC);
  });

  it('verifies a receipt back to the dedicated signing address with the settlement ref', async () => {
    const issuer = newIssuer();
    const receipt = await issuer.issueSignedReceipt(RESOURCE, PAYER, NETWORK, 'gateway-transfer-uuid');
    expect(receipt.format).toBe('eip712');
    const v = await verifySignedReceipt(receipt);
    expect(v).not.toBeNull();
    expect(v!.signer.toLowerCase()).toBe(issuer.address.toLowerCase());
    expect(v!.payload.resourceUrl).toBe(RESOURCE);
    expect(v!.payload.payer).toBe(PAYER);
    expect(v!.payload.network).toBe(NETWORK);
    expect(v!.payload.transaction).toBe('gateway-transfer-uuid');
  });

  it('the signing key is distinct from payTo (spec requirement)', async () => {
    const issuer = newIssuer();
    expect(issuer.address.toLowerCase()).not.toBe(PAY_TO.toLowerCase());
    expect(issuer.kid).toContain(issuer.address);
  });

  it('two issuers recover to different signers', async () => {
    const a = newIssuer();
    const b = newIssuer();
    expect(a.address.toLowerCase()).not.toBe(b.address.toLowerCase());
  });
});

describe('tamper detection', () => {
  it('a tampered offer payload recovers a signer that is NOT the dedicated key', async () => {
    const issuer = newIssuer();
    const offer = await issuer.issueSignedOffer(RESOURCE, {
      network: NETWORK,
      asset: USDC,
      payTo: PAY_TO,
      amount: '3000',
    });
    const forged: EIP712SignedOffer = { ...offer, payload: { ...offer.payload, amount: '1' } };
    const v = await verifySignedOffer(forged);
    // ECDSA still recovers *an* address from the (now-wrong) hash — it just isn't the issuer's.
    expect(v).not.toBeNull();
    expect(v!.signer.toLowerCase()).not.toBe(issuer.address.toLowerCase());
  });

  it('a structurally-broken signature returns null', async () => {
    const issuer = newIssuer();
    const offer = await issuer.issueSignedOffer(RESOURCE, {
      network: NETWORK,
      asset: USDC,
      payTo: PAY_TO,
      amount: '3000',
    });
    const broken: EIP712SignedOffer = { ...offer, signature: '0xdeadbeef' };
    expect(await verifySignedOffer(broken)).toBeNull();
  });

  it('non-EIP-712 / garbage input returns null', async () => {
    expect(await verifySignedOffer(null)).toBeNull();
    expect(await verifySignedOffer({ format: 'jws', signature: 'x' })).toBeNull();
    expect(await verifySignedReceipt(undefined)).toBeNull();
    expect(await verifySignedReceipt({})).toBeNull();
  });
});

describe('receipt-matches-offer bind', () => {
  it('holds for a matching resource + network pair', async () => {
    const issuer = newIssuer();
    const offer = await issuer.issueSignedOffer(RESOURCE, {
      network: NETWORK,
      asset: USDC,
      payTo: PAY_TO,
      amount: '3000',
    });
    const receipt = await issuer.issueSignedReceipt(RESOURCE, PAYER, NETWORK, 'gateway-transfer-uuid');
    expect(receiptMatchesOffer(receipt, offer)).toBe(true);
  });

  it('fails when the resourceUrl differs', async () => {
    const issuer = newIssuer();
    const offer = await issuer.issueSignedOffer(RESOURCE, {
      network: NETWORK,
      asset: USDC,
      payTo: PAY_TO,
      amount: '3000',
    });
    const receipt = await issuer.issueSignedReceipt('/api/other', PAYER, NETWORK, 'gateway-transfer-uuid');
    expect(receiptMatchesOffer(receipt, offer)).toBe(false);
  });

  it('fails when the network differs', async () => {
    const issuer = newIssuer();
    const offer = await issuer.issueSignedOffer(RESOURCE, {
      network: NETWORK,
      asset: USDC,
      payTo: PAY_TO,
      amount: '3000',
    });
    const receipt = await issuer.issueSignedReceipt(RESOURCE, PAYER, 'eip155:1', 'gateway-transfer-uuid');
    expect(receiptMatchesOffer(receipt, offer)).toBe(false);
  });

  it('returns false for non-artifact inputs', () => {
    expect(receiptMatchesOffer(null, {})).toBe(false);
    expect(receiptMatchesOffer({ format: 'jws' }, { format: 'jws' })).toBe(false);
  });
});

describe('artifact hash (sha256 over JCS-canonical form)', () => {
  it('is stable for the same artifact and key-order-independent', async () => {
    const issuer = newIssuer();
    const offer = await issuer.issueSignedOffer(RESOURCE, {
      network: NETWORK,
      asset: USDC,
      payTo: PAY_TO,
      amount: '3000',
    });
    const h1 = offerReceiptArtifactHash(offer);
    // Re-order the top-level keys: JCS canonicalization must yield the identical hash.
    const reordered: EIP712SignedOffer = {
      signature: offer.signature,
      payload: offer.payload,
      acceptIndex: offer.acceptIndex,
      format: offer.format,
    };
    const h2 = offerReceiptArtifactHash(reordered);
    expect(h1.length).toBe(32);
    expect(h1.equals(h2)).toBe(true);
  });

  it('differs when the artifact differs', async () => {
    const issuer = newIssuer();
    const offer = await issuer.issueSignedOffer(RESOURCE, {
      network: NETWORK,
      asset: USDC,
      payTo: PAY_TO,
      amount: '3000',
    });
    const other = await issuer.issueSignedOffer(RESOURCE, {
      network: NETWORK,
      asset: USDC,
      payTo: PAY_TO,
      amount: '4000',
    });
    expect(offerReceiptArtifactHash(offer).equals(offerReceiptArtifactHash(other))).toBe(false);
  });

  it('hashes a receipt too', async () => {
    const issuer = newIssuer();
    const receipt: EIP712SignedReceipt = await issuer.issueSignedReceipt(RESOURCE, PAYER, NETWORK, 'ref');
    expect(offerReceiptArtifactHash(receipt).length).toBe(32);
  });
});
