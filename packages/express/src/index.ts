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

export interface LedgerlineExpressOptions {
  endpointId: string;
  schemaVersion?: string;
  routeConfigVersion?: number;
  /** Seller's receive address (payTo); not present on req.payment, so supplied here. */
  payTo?: string;
  /** Where captured analogs go: a local Postgres sink (demo) or a hosted-API POST (prod). */
  sink: (input: LedgerlineCaptureInput) => void | Promise<void>;
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
      try {
        const payment = (req as unknown as { payment?: CircleReqPayment }).payment;
        if (!payment) return; // unpaid / free path — nothing to capture
        const httpStatus = res.statusCode;
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
            status: httpStatus >= 200 && httpStatus < 300 ? 'delivered' : 'failed',
            httpStatus,
            latencyMs: Date.now() - startedAt,
          },
          occurredAt: new Date(),
        };
        const maybe = opts.sink(input);
        if (maybe instanceof Promise) {
          maybe.catch((e: unknown) =>
            console.error('[ledgerline] sink error (response unaffected):', e),
          );
        }
      } catch (e) {
        console.error('[ledgerline] capture error (response unaffected):', e);
      }
    });
    next();
  };
}
