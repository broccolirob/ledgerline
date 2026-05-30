import { describe, it, expect } from 'vitest';
import { parseReceipt, hexToBytea, type RawEventRow } from '@ledgerline/recognition';

function rawEvent(payment: Record<string, unknown>, delivery: Record<string, unknown>, extra?: Record<string, unknown>): RawEventRow {
  return {
    id: 'raw-1',
    tenant_id: '00000000-0000-4000-8000-000000000001',
    event_type: 'ledgerline.receipt_analog.v1',
    event_source: 'seller_sdk',
    occurred_at: new Date('2026-05-29T00:00:00.000Z'),
    event_seq: '1',
    payload_redacted: {
      requestFingerprint: '0x' + 'a'.repeat(64),
      payment,
      delivery,
      ...extra,
    },
  };
}

const goodPayment = {
  asset: 'USDC',
  network: 'eip155:5042002',
  verified: true,
  payerHash: '0x' + '3e'.repeat(32),
  amountAtomic: '3000',
  settlementReference: 'settle-1',
  paymentSignatureHash: '0x' + '36'.repeat(32),
  payTo: '0xSeller',
};
const goodDelivery = { status: 'delivered', httpStatus: 200, latencyMs: 5 };

describe('parseReceipt', () => {
  it('parses a valid delivered receipt analog', () => {
    const p = parseReceipt(rawEvent(goodPayment, goodDelivery));
    expect(p.amountAtomic).toBe(3000n);
    expect(p.verified).toBe(true);
    expect(p.deliveryStatus).toBe('delivered');
    expect(p.httpStatus).toBe(200);
    expect(p.asset).toBe('USDC');
    expect(p.idempotencyAnchor).toBe('settle-1'); // settlementReference wins
  });

  it('anchor precedence: paymentSignatureHash when no settlementReference', () => {
    const { settlementReference, ...noSettle } = goodPayment;
    const p = parseReceipt(rawEvent(noSettle, goodDelivery));
    expect(p.idempotencyAnchor).toBe('0x' + '36'.repeat(32));
  });

  it('anchor precedence: requestFingerprint when neither present', () => {
    const { settlementReference, paymentSignatureHash, ...bare } = goodPayment;
    const p = parseReceipt(rawEvent(bare, goodDelivery));
    expect(p.idempotencyAnchor).toBe('0x' + 'a'.repeat(64));
  });

  it('verified=false is preserved (drives the F1 path)', () => {
    const p = parseReceipt(rawEvent({ ...goodPayment, verified: false }, goodDelivery));
    expect(p.verified).toBe(false);
  });

  it('rejects zero amount', () => {
    expect(() => parseReceipt(rawEvent({ ...goodPayment, amountAtomic: '0' }, goodDelivery))).toThrow();
  });

  it('rejects non-integer amount', () => {
    expect(() => parseReceipt(rawEvent({ ...goodPayment, amountAtomic: '3000.5' }, goodDelivery))).toThrow();
  });

  it('rejects negative / signed amount', () => {
    expect(() => parseReceipt(rawEvent({ ...goodPayment, amountAtomic: '-5' }, goodDelivery))).toThrow();
  });

  it('rejects leading-zero amount', () => {
    expect(() => parseReceipt(rawEvent({ ...goodPayment, amountAtomic: '0300' }, goodDelivery))).toThrow();
  });

  it('rejects 0x / hex amount', () => {
    expect(() => parseReceipt(rawEvent({ ...goodPayment, amountAtomic: '0xbb8' }, goodDelivery))).toThrow();
  });

  it('rejects an unknown delivery.status', () => {
    expect(() => parseReceipt(rawEvent(goodPayment, { status: 'weird', httpStatus: 200 }))).toThrow();
  });

  it('rejects a missing requestFingerprint', () => {
    expect(() =>
      parseReceipt({
        id: 'r', tenant_id: 't', event_type: 'e', event_source: 'seller_sdk',
        occurred_at: new Date('2026-05-29T00:00:00.000Z'), event_seq: '1',
        payload_redacted: { payment: goodPayment, delivery: goodDelivery },
      }),
    ).toThrow();
  });

  it('rejects a missing payment.payerHash', () => {
    const { payerHash, ...noPayer } = goodPayment;
    expect(() => parseReceipt(rawEvent(noPayer, goodDelivery))).toThrow();
  });

  it('rejects a missing payment.network', () => {
    const { network, ...noNet } = goodPayment;
    expect(() => parseReceipt(rawEvent(noNet, goodDelivery))).toThrow();
  });

  it('rejects a missing or non-numeric delivery.httpStatus', () => {
    expect(() => parseReceipt(rawEvent(goodPayment, { status: 'delivered' }))).toThrow();
    expect(() => parseReceipt(rawEvent(goodPayment, { status: 'delivered', httpStatus: '200' }))).toThrow();
  });

  it('treats absent optional fields (latencyMs, responseBodyHash) as undefined', () => {
    const p = parseReceipt(rawEvent(goodPayment, { status: 'delivered', httpStatus: 200 }));
    expect(p.latencyMs).toBeUndefined();
    expect(p.responseBodyHashHex).toBeUndefined();
  });
});

describe('hexToBytea', () => {
  it('strips a leading 0x and matches the un-prefixed hex byte-for-byte', () => {
    const a = hexToBytea('0xabcdef');
    const b = hexToBytea('abcdef');
    expect(a.equals(b)).toBe(true);
    expect(a.equals(Buffer.from('abcdef', 'hex'))).toBe(true);
  });

  it('rejects odd-length hex', () => {
    expect(() => hexToBytea('0xabc')).toThrow();
  });

  it('rejects non-hex characters', () => {
    expect(() => hexToBytea('0xzz')).toThrow();
  });
});
