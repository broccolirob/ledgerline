import { describe, it, expect } from 'vitest';
import { allocateSplit, type SplitRuleRow } from '@ledgerline/recognition';

const demoRules: SplitRuleRow[] = [
  { id: 'd1', recipient_id: 'c1', role: 'publisher', percentage_bps: 7000, fixed_amount_atomic: null },
  { id: 'd2', recipient_id: 'c2', role: 'model_provider', percentage_bps: 2000, fixed_amount_atomic: null },
  { id: 'd3', recipient_id: 'c3', role: 'data_provider', percentage_bps: 700, fixed_amount_atomic: null },
  { id: 'd4', recipient_id: 'c4', role: 'referrer', percentage_bps: 300, fixed_amount_atomic: null },
];

function shareOf(a: ReturnType<typeof allocateSplit>, recipientId: string): bigint {
  return a.supplierShares.find((s) => s.recipientId === recipientId)?.amountAtomic ?? 0n;
}

describe('allocateSplit', () => {
  it('demo: 3000 -> publisher 2100, model 600, data 210, referrer 90, dust 0', () => {
    const a = allocateSplit(3000n, demoRules);
    expect(a.sellerShare).toBe(2100n);
    expect(shareOf(a, 'c2')).toBe(600n);
    expect(shareOf(a, 'c3')).toBe(210n);
    expect(shareOf(a, 'c4')).toBe(90n);
    expect(a.dustAtomic).toBe(0n);
    // sum-to-gross
    const total = a.sellerShare + a.supplierShares.reduce((s, x) => s + x.amountAtomic, 0n);
    expect(total).toBe(3000n);
  });

  it('tiny dust: 7 -> floors 4/1/0/0, dust 2 to publisher (default) -> seller 6, zero legs omitted', () => {
    const a = allocateSplit(7n, demoRules);
    expect(a.sellerShare).toBe(6n); // floor 4 + dust 2
    expect(a.dustAtomic).toBe(2n);
    expect(a.dustRecipientId).toBe('c1');
    expect(a.supplierShares.map((s) => s.recipientId)).toEqual(['c2']); // model 1; data/referrer 0 omitted
    expect(shareOf(a, 'c2')).toBe(1n);
    const total = a.sellerShare + a.supplierShares.reduce((s, x) => s + x.amountAtomic, 0n);
    expect(total).toBe(7n);
  });

  it('dust routes to a configured non-publisher recipient', () => {
    const a = allocateSplit(7n, demoRules, 'c2');
    expect(a.dustRecipientId).toBe('c2');
    expect(a.dustAtomic).toBe(2n);
    expect(a.sellerShare).toBe(4n); // publisher floor, no dust
    expect(shareOf(a, 'c2')).toBe(3n); // model floor 1 + dust 2
  });

  it('no negative or zero legs ever appear in supplierShares', () => {
    const a = allocateSplit(7n, demoRules);
    for (const s of a.supplierShares) expect(s.amountAtomic > 0n).toBe(true);
  });

  it('rejects a fixed-amount rule (mixed/fixed deferred §18.14)', () => {
    const rules: SplitRuleRow[] = [
      ...demoRules,
      { id: 'd5', recipient_id: 'c5', role: 'infra', percentage_bps: null, fixed_amount_atomic: '10' },
    ];
    expect(() => allocateSplit(3000n, rules)).toThrow();
  });

  it('rejects total bps over 10000', () => {
    const over = demoRules.map((r) => ({ ...r, percentage_bps: 3000 }));
    expect(() => allocateSplit(3000n, over)).toThrow();
  });

  it('rejects an UNDER-100% split group (structural under-allocation, not rounding dust)', () => {
    // 6000 + 2000 + 700 + 300 = 9000 bps — a real config error that must NOT be silently absorbed.
    const under = demoRules.map((r) => (r.role === 'publisher' ? { ...r, percentage_bps: 6000 } : r));
    expect(() => allocateSplit(3000n, under)).toThrow();
  });

  it('rejects a split group with no publisher rule', () => {
    const noPub = demoRules.filter((r) => r.role !== 'publisher');
    expect(() => allocateSplit(3000n, noPub)).toThrow();
  });

  it('rejects a duplicate recipient_id', () => {
    const dup: SplitRuleRow[] = [
      { id: 'd1', recipient_id: 'c1', role: 'publisher', percentage_bps: 7000, fixed_amount_atomic: null },
      { id: 'd2', recipient_id: 'c1', role: 'model_provider', percentage_bps: 3000, fixed_amount_atomic: null },
    ];
    expect(() => allocateSplit(3000n, dup)).toThrow();
  });
});
