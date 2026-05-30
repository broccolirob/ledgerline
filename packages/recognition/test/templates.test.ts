import { describe, it, expect } from 'vitest';
import {
  allocateSplit,
  resolveLegs,
  assertBalanced,
  type SplitRuleRow,
  type PostingContext,
  type ResolvedLeg,
} from '@ledgerline/recognition';

const demoRules: SplitRuleRow[] = [
  { id: 'd1', recipient_id: 'c1', role: 'publisher', percentage_bps: 7000, fixed_amount_atomic: null },
  { id: 'd2', recipient_id: 'c2', role: 'model_provider', percentage_bps: 2000, fixed_amount_atomic: null },
  { id: 'd3', recipient_id: 'c3', role: 'data_provider', percentage_bps: 700, fixed_amount_atomic: null },
  { id: 'd4', recipient_id: 'c4', role: 'referrer', percentage_bps: 300, fixed_amount_atomic: null },
];

function ctx(gross: bigint, treatment: 'principal_gross' | 'agent_net'): PostingContext {
  return {
    revenueEvent: { id: 're-1', tenantId: 't', grossAmountAtomic: gross, asset: 'USDC' },
    treatment,
    allocation: allocateSplit(gross, demoRules),
  };
}

const sum = (legs: ResolvedLeg[], dir: 'debit' | 'credit') =>
  legs.filter((l) => l.direction === dir).reduce((s, l) => s + l.amountAtomic, 0n);

describe('R1′ principal_gross (live)', () => {
  const legs = resolveLegs(ctx(3000n, 'principal_gross'));

  it('emits 8 balanced legs (ΣDr = ΣCr = 3900)', () => {
    expect(legs.length).toBe(8);
    assertBalanced(legs);
    expect(sum(legs, 'debit')).toBe(3900n);
    expect(sum(legs, 'credit')).toBe(3900n);
  });

  it('seller revenue credit == gross (Invariant 3B)', () => {
    const revenue = legs.find((l) => l.account.account_type === 'revenue')!;
    expect(revenue.direction).toBe('credit');
    expect(revenue.amountAtomic).toBe(3000n);
  });

  it('supplier/referrer payable credits == matching COGS/referral debits (3B tie-out)', () => {
    const payables = legs.filter((l) => l.account.account_type === 'payable');
    const expenses = legs.filter(
      (l) => l.account.account_type === 'expense_cogs' || l.account.account_type === 'expense_referral',
    );
    const payableSum = payables.reduce((s, l) => s + l.amountAtomic, 0n);
    const expenseSum = expenses.reduce((s, l) => s + l.amountAtomic, 0n);
    expect(payableSum).toBe(900n);
    expect(expenseSum).toBe(900n);
  });

  it('never uses a platform owner; COGS/referral debits are seller-owned, payables supplier-owned', () => {
    for (const l of legs) {
      expect((l.account.owner_type as string)).not.toBe('platform');
      if (l.account.account_type === 'expense_cogs' || l.account.account_type === 'expense_referral') {
        expect(l.account.owner_type).toBe('seller');
        expect(l.account.owner_id).toBeUndefined();
      }
      if (l.account.account_type === 'payable') {
        expect(l.account.owner_type).toBe('supplier');
        expect(l.account.owner_id).toBeTruthy();
      }
    }
  });

  it('referrer posts to expense_referral, model/data to expense_cogs', () => {
    expect(legs.some((l) => l.account.account_type === 'expense_referral' && l.amountAtomic === 90n)).toBe(true);
    const cogs = legs.filter((l) => l.account.account_type === 'expense_cogs');
    expect(cogs.map((l) => l.amountAtomic).sort()).toEqual([210n, 600n]);
  });

  it('omits zero-amount legs (tiny gross 7 -> 4 legs)', () => {
    const tiny = resolveLegs(ctx(7n, 'principal_gross'));
    assertBalanced(tiny);
    // receivable 7, revenue 7, cogs(model) 1, payable(model) 1 — data/referrer omitted.
    expect(tiny.length).toBe(4);
    expect(sum(tiny, 'debit')).toBe(8n);
    expect(sum(tiny, 'credit')).toBe(8n);
  });
});

describe('R1 agent_net (fixture only — proves the engine generalizes)', () => {
  const legs = resolveLegs(ctx(3000n, 'agent_net'));

  it('balances (ΣDr = ΣCr = 3000) with revenue = net seller share and payables only', () => {
    assertBalanced(legs);
    expect(sum(legs, 'debit')).toBe(3000n);
    expect(sum(legs, 'credit')).toBe(3000n);
    const revenue = legs.find((l) => l.account.account_type === 'revenue')!;
    expect(revenue.amountAtomic).toBe(2100n); // net publisher share, NOT gross
    // No expense legs in agent_net.
    expect(legs.some((l) => l.account.account_type.startsWith('expense'))).toBe(false);
  });

  it('3A tie-out: seller revenue + supplier payables == gross', () => {
    const revenue = legs.find((l) => l.account.account_type === 'revenue')!.amountAtomic;
    const payables = legs.filter((l) => l.account.account_type === 'payable').reduce((s, l) => s + l.amountAtomic, 0n);
    expect(revenue + payables).toBe(3000n);
  });

  it('payables are supplier-owned (same dimension as the corrected R1′ template)', () => {
    for (const l of legs.filter((x) => x.account.account_type === 'payable')) {
      expect(l.account.owner_type).toBe('supplier');
      expect(l.account.owner_id).toBeTruthy();
    }
  });

  it('dust tie-out: revenue == gross − Σ(supplier payables), dust folded into revenue', () => {
    // gross 7: floors pub4/model1/data0/ref0, dust 2 → publisher → revenue 6, payable(model) 1.
    const tiny = resolveLegs(ctx(7n, 'agent_net'));
    assertBalanced(tiny);
    const revenue = tiny.find((l) => l.account.account_type === 'revenue')!.amountAtomic;
    const payables = tiny.filter((l) => l.account.account_type === 'payable').reduce((s, l) => s + l.amountAtomic, 0n);
    expect(payables).toBe(1n);
    expect(revenue).toBe(7n - payables);
    expect(revenue).toBe(6n);
  });
});

describe('assertBalanced', () => {
  it('throws on an unbalanced leg set', () => {
    const bad: ResolvedLeg[] = [
      { direction: 'debit', account: { account_type: 'receivable', owner_type: 'seller' }, amountAtomic: 100n, asset: 'USDC', memo: '' },
      { direction: 'credit', account: { account_type: 'revenue', owner_type: 'seller' }, amountAtomic: 99n, asset: 'USDC', memo: '' },
    ];
    expect(() => assertBalanced(bad)).toThrow();
  });

  it('checks balance PER ASSET — cross-asset totals that net to equal still throw', () => {
    const mixed: ResolvedLeg[] = [
      { direction: 'debit', account: { account_type: 'receivable', owner_type: 'seller' }, amountAtomic: 100n, asset: 'USDC', memo: '' },
      { direction: 'credit', account: { account_type: 'revenue', owner_type: 'seller' }, amountAtomic: 100n, asset: 'EUROC', memo: '' },
    ];
    // ΣDr=100, ΣCr=100 overall, but USDC is debit-only and EUROC credit-only → unbalanced per asset.
    expect(() => assertBalanced(mixed)).toThrow();
  });
});
