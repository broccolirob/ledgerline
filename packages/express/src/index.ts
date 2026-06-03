// @ledgerline/express — the reference Ledgerline capture adapter for Express.
// Records ONE Ledgerline receipt analog (Path C) per paid call, on response finish. A thin shell over
// @ledgerline/seller-client (the framework-agnostic capture contract). See ./README.md.
import type { RequestHandler } from 'express';
import type { LedgerlineCaptureInput } from '@ledgerline/seller-client';

/** The payment context Circle's createGatewayMiddleware attaches to the request (confirmed shape). */
interface CircleReqPayment {
  verified: boolean;
  payer: string;
  amount: string;
  network: string;
  transaction?: string;
}

/** Context for the optional official-artifact issuer (M6c, Path B). Derived from the confirmed
 *  req.payment + request, so the demo can issue the EIP-712 offer/receipt WITHOUT this package
 *  depending on x402 — the issuer closure is injected (see @ledgerline/x402-receipts). */
export interface OfficialArtifactContext {
  resourcePath: string;
  network: string;
  asset: string;
  amountAtomic: string;
  payTo?: string;
  payer: string;
  settlementReference?: string;
}

/** The official x402 EIP-712 artifacts to capture alongside the analog. Either may be omitted. */
export interface OfficialArtifacts {
  signedOffer?: unknown;
  signedReceipt?: unknown;
}

export interface LedgerlineExpressOptions {
  endpointId: string;
  schemaVersion?: string;
  routeConfigVersion?: number;
  /** Seller's receive address (payTo); not present on req.payment, so supplied here. */
  payTo?: string;
  /** Where captured analogs go: a local Postgres sink (demo) or a hosted-API POST (prod). */
  sink: (input: LedgerlineCaptureInput) => void | Promise<void>;
  /** Optional (M6c, Path B): issue the OFFICIAL x402 EIP-712 offer/receipt to capture ALONGSIDE the
   *  analog. Called only on a delivered (2xx) paid response. Injected as a hook so THIS package keeps
   *  no x402 dependency; the demo supplies it via @ledgerline/x402-receipts. Issuance failures are
   *  logged and swallowed — they never block the response (already finished) nor lose the analog. */
  issueOfficialArtifacts?: (ctx: OfficialArtifactContext) => OfficialArtifacts | Promise<OfficialArtifacts>;
}

/**
 * Returns Express middleware that, AFTER the response finishes, builds the Ledgerline receipt
 * analog from `req.payment` + the request + the delivery outcome and hands it to `sink`.
 *
 * Load-bearing invariant: delivery_status='delivered' requires a 2xx final status. Capture runs
 * on `res.on('finish')` (so it sees the real status) and NEVER throws into the response path —
 * failures are logged only. Mount it AFTER the payment middleware (so `req.payment` is set) and
 * BEFORE the handler.
 */
export function ledgerlineRecorder(opts: LedgerlineExpressOptions): RequestHandler {
  return (req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      // Run the whole capture (incl. optional official-artifact issuance) OFF the response path. The
      // response has finished, so awaiting here cannot affect it; every error is logged, never thrown.
      void (async () => {
        try {
          const payment = (req as unknown as { payment?: CircleReqPayment }).payment;
          if (!payment) return; // unpaid / free path — nothing to capture
          const httpStatus = res.statusCode;
          const delivered = httpStatus >= 200 && httpStatus < 300;
          const sigHeader = req.headers['payment-signature'];
          const input: LedgerlineCaptureInput = {
            endpointId: opts.endpointId,
            schemaVersion: opts.schemaVersion ?? 'm1.1',
            method: req.method,
            resourcePath: req.path,
            routeConfigVersion: opts.routeConfigVersion,
            payment: {
              verified: Boolean(payment.verified),
              payer: payment.payer,
              amountAtomic: payment.amount,
              network: payment.network,
              asset: 'USDC',
              payTo: opts.payTo,
              settlementReference: payment.transaction,
              paymentSignatureHeader: typeof sigHeader === 'string' ? sigHeader : undefined,
            },
            delivery: {
              status: delivered ? 'delivered' : 'failed',
              httpStatus,
              latencyMs: Date.now() - startedAt,
            },
            occurredAt: new Date(),
          };
          // M6c (Path B): issue the official EIP-712 offer/receipt for a DELIVERED paid call only (a
          // failed/non-2xx delivery has no receipt). A failure here must not lose the analog.
          if (delivered && opts.issueOfficialArtifacts) {
            try {
              const arts = await opts.issueOfficialArtifacts({
                resourcePath: input.resourcePath,
                network: input.payment.network,
                asset: input.payment.asset ?? 'USDC',
                amountAtomic: input.payment.amountAtomic,
                payTo: input.payment.payTo,
                payer: input.payment.payer,
                settlementReference: input.payment.settlementReference,
              });
              input.signedOffer = arts.signedOffer;
              input.signedReceipt = arts.signedReceipt;
            } catch (e) {
              console.error('[ledgerline] official-artifact issuance failed (analog still captured):', e);
            }
          }
          await opts.sink(input);
        } catch (e) {
          console.error('[ledgerline] capture error (response unaffected):', e);
        }
      })();
    });
    next();
  };
}
