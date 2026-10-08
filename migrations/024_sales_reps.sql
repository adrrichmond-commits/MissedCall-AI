-- 024_sales_reps.sql — Admin sales tab: outside sales reps, account
-- attribution, and the payouts ledger (the honest comp backbone).
--
--   1) sales_reps — the outside sales reps. The comp schedule lives ON THE
--      ROW AS DATA (never hard-coded): bounty per plan, monthly rate per
--      plan, and the optional step-down variant. Cents, integers — money is
--      never a float. A rep with all-zero rates renders the attribution and
--      an honest "no comp schedule set" note; zero is also the shipped
--      default because the tab ships with ZERO reps (seeded by hand later).
--
--   2) sales_rep_payouts — append-only ledger of money actually paid to a
--      rep. Recording a payout NEVER edits accrual: OWED NOW is always
--      computed as (accrued − sum of this ledger), so history stays auditable.
--
--   3) businesses.sales_rep_id (+ sales_rep_attributed_at) — one nullable
--      attribution column instead of a junction table. One current rep per
--      business is the deal model (who brought this account); reattribution
--      is a single UPDATE that re-stamps the date. ON DELETE SET NULL:
--      deleting a rep unattributes its businesses rather than deleting the
--      businesses (attribution is bookkeeping, ownership is not).
--
--   4) admin_audit.action CHECK widened (007→021→023 convention) for the six
--      new privileged actions the tab writes.
--
-- REPLAY SAFETY: every statement is idempotent against a 001→023 replay AND
-- against this file itself — CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT
-- EXISTS, DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT. There is NO data
-- backfill and NO dependency on columns created by later files. Re-running
-- this file alone is a no-op.
--
-- NOT APPLIED TO NEON BY THIS BUILD — the lead applies and verifies.
CREATE TABLE IF NOT EXISTS sales_reps (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                          text NOT NULL,
  contact                       text,
  -- false = deactivated: kept for history, no longer assignable in the UI.
  active                        boolean NOT NULL DEFAULT true,
  -- Comp schedule, stored as data on the rep row (cents).
  bounty_starter_cents          integer NOT NULL DEFAULT 0,
  bounty_pro_cents              integer NOT NULL DEFAULT 0,
  monthly_starter_cents         integer NOT NULL DEFAULT 0,
  monthly_pro_cents             integer NOT NULL DEFAULT 0,
  -- Optional step-down variant: monthly rate drops to the step-down rate
  -- starting with the month AFTER the account's Nth paid month.
  -- NULL = no step-down (the step-down monthly rates are then ignored).
  step_down_after_months        integer,
  step_down_monthly_starter_cents integer,
  step_down_monthly_pro_cents     integer,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_reps_step_down_shape CHECK (
    (step_down_after_months IS NULL) OR
    (step_down_after_months >= 1 AND
     step_down_monthly_starter_cents IS NOT NULL AND
     step_down_monthly_pro_cents IS NOT NULL)
  ),
  CONSTRAINT sales_reps_amounts_non_negative CHECK (
    bounty_starter_cents >= 0 AND bounty_pro_cents >= 0 AND
    monthly_starter_cents >= 0 AND monthly_pro_cents >= 0 AND
    (step_down_monthly_starter_cents IS NULL OR step_down_monthly_starter_cents >= 0) AND
    (step_down_monthly_pro_cents IS NULL OR step_down_monthly_pro_cents >= 0)
  )
);
CREATE TRIGGER trg_sales_reps_updated_at
  BEFORE UPDATE ON sales_reps
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS sales_rep_payouts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id        uuid NOT NULL REFERENCES sales_reps(id) ON DELETE CASCADE,
  amount_cents  integer NOT NULL,
  -- Free-text period/context note the owner writes when recording ("Oct 2026",
  -- "bounties for the two October signups", ...). Never parsed — display only.
  note          text,
  paid_at       timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_rep_payouts_amount_positive CHECK (amount_cents > 0)
);
CREATE INDEX IF NOT EXISTS sales_rep_payouts_rep_paid_idx
  ON sales_rep_payouts (rep_id, paid_at DESC);
CREATE TRIGGER trg_sales_rep_payouts_updated_at
  BEFORE UPDATE ON sales_rep_payouts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Attribution: one current rep per business (nullable — most businesses have
-- none). Deleting a rep unattributes rather than cascades into businesses.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS sales_rep_id uuid REFERENCES sales_reps(id) ON DELETE SET NULL;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS sales_rep_attributed_at timestamptz;
CREATE INDEX IF NOT EXISTS businesses_sales_rep_idx
  ON businesses (sales_rep_id) WHERE sales_rep_id IS NOT NULL;

-- Admin audit: the six new privileged actions (same widening convention as
-- the notifications type check in 007/021/023 — text + CHECK, not an enum).
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
      'sales_payout_recorded'
    )
  );
