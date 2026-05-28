// @ledgerline/express — STUB for Milestone 0.
//
// Future home of the Ledgerline adapter middleware that records the "Ledgerline
// receipt analog" (request fingerprint + Payment-Identifier-if-available + delivery
// record). The capture path (A/B/C) is decided in DECISION_LOG.md after the SDK spike.
//
// For M0 this is a no-op pass-through so the seller app has a real Ledgerline seam to
// import without depending on the still-unresolved SDK capture surface.
import type { RequestHandler } from 'express';

export interface LedgerlineExpressOptions {
  tenantId?: string;
  /** schemaVersion of the raw_event this adapter will eventually emit. */
  schemaVersion?: string;
}

/**
 * STUB. Returns a pass-through middleware. Does NOT yet write a raw_event — the real
 * capture wiring is blocked on the SPIKE.md SDK-surface answers.
 */
export function ledgerlineRecorder(_opts: LedgerlineExpressOptions = {}): RequestHandler {
  return (_req, _res, next) => next();
}
