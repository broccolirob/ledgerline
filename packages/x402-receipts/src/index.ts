// @ledgerline/x402-receipts — issue + verify the OFFICIAL x402 EIP-712 Signed Offer & Receipt (Path B).
//
// Promotes apps/spike-receipt's proven logic into a tested, reusable library. The issuer here is
// STANDALONE: createEIP712OfferReceiptIssuer().issueOffer()/issueReceipt() only sign payloads — there
// is no x402ResourceServer / Circle BatchFacilitatorClient / GatewayEvmScheme in the loop. The spike
// registered the extension on an x402ResourceServer ONLY to prove it composes with Circle's facilitator;
// approach B (M6c) issues artifacts directly ALONGSIDE Circle's createGatewayMiddleware, so the
// @x402/core <-> @circle-fin/x402-batching type-skew (D-0001) never arises on this path and there are
// NO `as unknown` casts here. (The one cast below bridges viem's stricter signTypedData to the SDK's
// looser SignTypedDataFn — a structural, documented bridge, not the version skew.)
//
// No-overclaim: these ARE the official x402 artifacts. The Path-C "Ledgerline receipt analog" remains a
// separate, honestly-labelled fallback (see packages/anchor verifier).
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createHash } from 'node:crypto';
import {
  createEIP712OfferReceiptIssuer,
  verifyOfferSignatureEIP712,
  verifyReceiptSignatureEIP712,
  verifyReceiptMatchesOffer,
  isEIP712SignedOffer,
  isEIP712SignedReceipt,
  canonicalize,
  type SignTypedDataFn,
  type OfferInput,
  type OfferPayload,
  type ReceiptPayload,
  type SignedOffer,
  type SignedReceipt,
  type EIP712SignedOffer,
  type EIP712SignedReceipt,
  type DecodedOffer,
} from '@x402/extensions/offer-receipt';

export type { OfferPayload, ReceiptPayload, SignedOffer, SignedReceipt, EIP712SignedOffer, EIP712SignedReceipt };

/** Economic terms for a signed offer (the spec's OfferInput, with `exact`/index-0 defaults). */
export interface OfferTerms {
  /** Index into the 402's accepts[] this offer corresponds to. Default 0. */
  acceptIndex?: number;
  /** Payment scheme identifier. Default 'exact'. */
  scheme?: string;
  /** CAIP-2 network, e.g. 'eip155:5042002' (Arc Testnet). */
  network: string;
  /** Token contract address or 'native'. */
  asset: string;
  /** Recipient wallet address (the seller's payTo — DISTINCT from the signing key). */
  payTo: string;
  /** Required amount in atomic units, as a decimal string (never a float). */
  amount: string;
  /** Offer validity window in seconds (the SDK default is 300). */
  offerValiditySeconds?: number;
}

/** A standalone EIP-712 offer/receipt issuer bound to one dedicated signing key. */
export interface ReceiptIssuer {
  /** The dedicated signing address; verified artifacts recover to it. DISTINCT from payTo (spec §). */
  readonly address: string;
  /** The did:pkh key identifier embedded in issued artifacts. */
  readonly kid: string;
  issueSignedOffer(resourceUrl: string, terms: OfferTerms): Promise<EIP712SignedOffer>;
  issueSignedReceipt(
    resourceUrl: string,
    payer: string,
    network: string,
    settlementRef?: string,
  ): Promise<EIP712SignedReceipt>;
}

/** The recovered signer address + decoded payload from a verified artifact. */
export interface VerifiedArtifact<T> {
  signer: string;
  payload: T;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// Trust-boundary guards: the verifier/recognition read artifacts back from Postgres `jsonb` (typed
// `unknown`), so narrow the EIP-712 envelope shape here before the SDK verifiers run. (The SDK's own
// isEIP712Signed* guards require an already-typed SignedOffer/Receipt, so they can't accept `unknown`.)
function isEip712Offer(v: unknown): v is EIP712SignedOffer {
  return isObject(v) && v.format === 'eip712' && isObject(v.payload) && typeof v.signature === 'string';
}
function isEip712Receipt(v: unknown): v is EIP712SignedReceipt {
  return isObject(v) && v.format === 'eip712' && isObject(v.payload) && typeof v.signature === 'string';
}

/**
 * Generate a fresh dedicated receipt signing key (secp256k1).
 * Hold it in env (e.g. RECEIPT_SIGNING_KEY); NEVER reuse the seller's payTo / a payment key.
 */
export function generateReceiptSigningKey(): `0x${string}` {
  return generatePrivateKey();
}

/** Create a standalone EIP-712 offer/receipt issuer from a dedicated secp256k1 private key. */
export function createReceiptIssuer(opts: { privateKey: `0x${string}`; network: string }): ReceiptIssuer {
  const account = privateKeyToAccount(opts.privateKey);
  // viem's signTypedData is more strongly typed than the SDK's SignTypedDataFn (whose message is a
  // loose Record<string, unknown>); this single cast bridges the two structurally-identical shapes.
  const signTypedData: SignTypedDataFn = (params) =>
    account.signTypedData(params as Parameters<typeof account.signTypedData>[0]);
  const kid = `did:pkh:${opts.network}:${account.address}`;
  const issuer = createEIP712OfferReceiptIssuer(kid, signTypedData);
  return {
    address: account.address,
    kid,
    async issueSignedOffer(resourceUrl, terms) {
      const input: OfferInput = {
        acceptIndex: terms.acceptIndex ?? 0,
        scheme: terms.scheme ?? 'exact',
        network: terms.network,
        asset: terms.asset,
        payTo: terms.payTo,
        amount: terms.amount,
        ...(terms.offerValiditySeconds != null ? { offerValiditySeconds: terms.offerValiditySeconds } : {}),
      };
      const offer = await issuer.issueOffer(resourceUrl, input);
      if (!isEIP712SignedOffer(offer)) throw new Error('expected an EIP-712 signed offer');
      return offer;
    },
    async issueSignedReceipt(resourceUrl, payer, network, settlementRef) {
      const receipt = await issuer.issueReceipt(resourceUrl, payer, network, settlementRef);
      if (!isEIP712SignedReceipt(receipt)) throw new Error('expected an EIP-712 signed receipt');
      return receipt;
    },
  };
}

/**
 * Verify an EIP-712 signed offer and recover the signer.
 * Returns null when the input is not an EIP-712 offer or the signature is structurally invalid.
 * NOTE: a *tampered payload* still recovers a (wrong) signer — compare `.signer` to the expected
 * dedicated address; it will not match. (ECDSA recovers some address from any 65-byte signature.)
 */
export async function verifySignedOffer(offer: unknown): Promise<VerifiedArtifact<OfferPayload> | null> {
  if (!isEip712Offer(offer)) return null;
  try {
    const { signer, payload } = await verifyOfferSignatureEIP712(offer);
    return { signer, payload };
  } catch {
    return null;
  }
}

/** Verify an EIP-712 signed receipt and recover the signer (see verifySignedOffer for tamper semantics). */
export async function verifySignedReceipt(receipt: unknown): Promise<VerifiedArtifact<ReceiptPayload> | null> {
  if (!isEip712Receipt(receipt)) return null;
  try {
    const { signer, payload } = await verifyReceiptSignatureEIP712(receipt);
    return { signer, payload };
  } catch {
    return null;
  }
}

/**
 * True iff the receipt binds to the offer (same resourceUrl + network), per the x402 spec matcher
 * (verifyReceiptMatchesOffer). The receipt has no amount/payTo fields, so the economic bind
 * (offer.amount === revenue_event amount) is asserted separately by the Ledgerline verifier.
 * Recency is neutralized (Number.MAX_SAFE_INTEGER) so historical artifacts still match offline.
 */
export function receiptMatchesOffer(receipt: unknown, offer: unknown): boolean {
  if (!isEip712Receipt(receipt) || !isEip712Offer(offer)) return false;
  const decoded: DecodedOffer = {
    ...offer.payload,
    signedOffer: offer,
    format: offer.format,
    acceptIndex: offer.acceptIndex,
  };
  // payerAddresses = the receipt's own payer (so the payer check reduces to the resource+network bind).
  return verifyReceiptMatchesOffer(receipt, decoded, [receipt.payload.payer], Number.MAX_SAFE_INTEGER);
}

/**
 * SHA-256 over the JCS-canonical (RFC 8785) form of the full signed artifact, returned as a 32-byte
 * Buffer for x402_payment_artifacts.artifact_hash (bytea). This is NOT an Arc-committed leaf, so it
 * uses sha256 (not the M4 keccak256 rule, which governs only on-chain-committed hashes).
 */
export function offerReceiptArtifactHash(artifact: unknown): Buffer {
  return createHash('sha256').update(canonicalize(artifact), 'utf8').digest();
}
