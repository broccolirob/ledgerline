-- §18.16 audit. Must return ZERO rows. Two violation classes:
--   (a) Invariant 1  — every journal transaction balances per asset (ΣDr == ΣCr).
--   (b) Invariant 3B — principal_gross recognition tie-out: revenue credit == receivable debit,
--                       AND Σ(payable credits) == Σ(expense debits), per journal.
-- (a) catches sign/amount errors that still balance overall; (b) catches a journal that balances
-- but credits the wrong split (e.g. revenue != gross), which (a) alone would miss.

-- (a) per-asset balance
select 'balance'::text as violation, le.entry_group_id, le.asset,
       sum(case when le.direction = 'debit'  then le.amount_atomic else 0 end) as debits,
       sum(case when le.direction = 'credit' then le.amount_atomic else 0 end) as credits
from ledger_entries le
group by le.entry_group_id, le.asset
having sum(case when le.direction = 'debit'  then le.amount_atomic else 0 end)
    <> sum(case when le.direction = 'credit' then le.amount_atomic else 0 end)

union all

-- (b) principal_gross recognition tie-out (Invariant 3B)
select 'recognition_tieout'::text as violation, jt.id as entry_group_id, le.asset,
       sum(case when la.account_type = 'receivable' and le.direction = 'debit'  then le.amount_atomic else 0 end) as debits,
       sum(case when la.account_type = 'revenue'    and le.direction = 'credit' then le.amount_atomic else 0 end) as credits
from journal_transactions jt
join ledger_entries le on le.entry_group_id = jt.id
join ledger_accounts la on la.id = le.account_id
where jt.txn_type = 'recognition' and jt.revenue_treatment = 'principal_gross'
group by jt.id, le.asset
having
  -- revenue credit != receivable debit
  sum(case when la.account_type = 'revenue'    and le.direction = 'credit' then le.amount_atomic else 0 end)
  <> sum(case when la.account_type = 'receivable' and le.direction = 'debit' then le.amount_atomic else 0 end)
  -- OR Σ(payable credits) != Σ(expense debits)
  or sum(case when la.account_type = 'payable' and le.direction = 'credit' then le.amount_atomic else 0 end)
  <> sum(case when la.account_type in ('expense_cogs', 'expense_referral') and le.direction = 'debit' then le.amount_atomic else 0 end);
