-- 025_prompt_audit_actions.sql — Audit fix (IMPORTANT #5, 2026-10-09):
-- prompt-version save + revert join the central admin audit trail.
--
-- The /admin/prompts writes (savePromptVersionFn / revertPromptVersionFn)
-- change live AI behavior, but were the two admin writes outside the
-- append-only audit log (they kept a version-history row, so attribution
-- existed — /admin/audit just never showed them). This widens the
-- admin_audit.action CHECK for the two new privileged actions the fns now
-- write, following the exact 024 convention (text + CHECK, not a PG enum).
--
-- REPLAY SAFETY (007→021→023→024 convention): DROP CONSTRAINT IF EXISTS +
-- ADD CONSTRAINT — idempotent against a 001→024 replay AND against this file
-- itself; re-running is a no-op. NO data backfill, NO destructive op.
ALTER TABLE admin_audit DROP CONSTRAINT IF EXISTS admin_audit_action_check;
ALTER TABLE admin_audit
  ADD CONSTRAINT admin_audit_action_check CHECK (
    action IN (
      'impersonate_start',
      'impersonate_stop',
      'account_disable',
      'account_enable',
      'plan_override',
      'sales_rep_created',
      'sales_rep_updated',
      'sales_rep_active_set',
      'sales_attribution_set',
      'sales_attribution_cleared',
      'sales_payout_recorded',
      'prompt_version_saved',
      'prompt_version_reverted'
    )
  );
