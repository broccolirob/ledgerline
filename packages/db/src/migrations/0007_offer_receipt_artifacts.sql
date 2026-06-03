-- 0007_offer_receipt_artifacts.sql — Milestone 6c (official x402 Signed Offer & Receipt, Path B).
--
-- Capture the OFFICIAL x402 EIP-712 Signed Offer & Receipt ALONGSIDE the Path-C analog
-- (artifact_type='payment_signature'). Two changes to x402_payment_artifacts (§7.6):
--
--   1) artifact_json: the full signed artifact (envelope + payload + signature), so the verifier can
--      RE-VERIFY the EIP-712 signature offline (@ledgerline/x402-receipts). The analog row leaves this
--      NULL — it carries only a hash of the buyer's payment authorization, not a signed artifact.
--      NOT Arc-committed (the frozen §17.5 leaf format is unchanged); §9 at-rest encryption of
--      artifact_json — which by spec includes the receipt's `payer` — is deferred to M7.
--   2) artifact_type CHECK: all three types are real now (0003 had only a comment). Existing rows are
--      all 'payment_signature', so the CHECK adds cleanly.
--
-- Idempotent (add column if not exists / drop-then-add constraint), matching the repo's re-runnable
-- migration convention.

alter table x402_payment_artifacts
  add column if not exists artifact_json jsonb;

alter table x402_payment_artifacts
  drop constraint if exists x402_payment_artifacts_artifact_type_check;

alter table x402_payment_artifacts
  add constraint x402_payment_artifacts_artifact_type_check
  check (artifact_type in ('signed_offer', 'payment_signature', 'signed_receipt'));
