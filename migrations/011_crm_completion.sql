-- 011_crm_completion.sql — Phase 3 build P3-C: CRM completion.
--
-- Three things land here (fold-in specs from Phase 4 areas 6/7 carried in the
-- P3-C brief):
--   1. FULL LEAD LIFECYCLE — leads.status widens from the Phase 2 set
--      ('new','contacted','booked','completed','lost') to the lead-to-job
--      pipeline the shop actually runs:
--        new → contacted → qualified → appointment_scheduled → won
--        (any live state) → follow_up_needed (the "call them back" queue)
--        (any live state) → lost
--      Won and Lost are TERMINAL except reopening to follow_up_needed.
--      Transition legality is enforced in app code
--      (src/lib/server/leadLifecycle.ts); the CHECK here stays the honest
--      value-set boundary. As in 005/006 we convert to text + CHECK because
--      Postgres cannot remove enum values and the set must stay editable.
--
--      Backfill (documented here and in the PR):
--        'booked'    -> 'appointment_scheduled' (the job is on the books)
--        'completed' -> 'won'                    (the job was finished/paid)
--      converted_at already marks when the lead was won — nothing to change.
--
--   2. ESTIMATED JOB VALUE (P3-D Revenue Recovered groundwork): the KB
--      (src/lib/server/kb/services.ts) carries a typical USD range per
--      service. When a lead's classification resolves a KB service, the
--      pipeline stamps the range on the lead; the shop-entered quote
--      (estimated_value_cents) keeps taking precedence. pipeline_value_cents
--      is the single "what is this lead worth" number P3-D sums:
--        won    -> actual_won_value_cents ?? estimated_value_cents ?? est-high
--        lost   -> NULL (nothing recovered)
--        open   -> greatest(estimated_value_cents, est-high) (real quote
--                  outranks the KB guess, never below it)
--      Backfill: pipeline_value_cents = estimated_value_cents where present.
--
--   3. FOLLOW-UP TASKS (the "no scheduler needed — the list IS the surface"
--      queue): one row per promised callback. Auto-created on lead capture
--      (created_reason 'lead_new', due next business day in the business's
--      timezone) and when a lead is flagged follow_up_needed
--      ('status_follow_up', carrying the business's note).
--      ON DELETE design: lead_id CASCADES (unlike appointments → leads SET
--      NULL) because a follow-up task is actionable ONLY while its lead
--      exists — deleting the lead deletes its reminders, so no orphan
--      "call nobody back" rows can ever surface on the dashboard.
-- ---------------------------------------------------------------------------
-- 1. Lead lifecycle: widen the status set
-- ---------------------------------------------------------------------------
ALTER TABLE leads ALTER COLUMN status TYPE text USING status::text;
UPDATE leads SET status = 'appointment_scheduled' WHERE status = 'booked';
UPDATE leads SET status = 'won' WHERE status = 'completed';
ALTER TABLE leads
  ADD CONSTRAINT leads_status_check
  CHECK (status IN (
    'new', 'contacted', 'qualified', 'follow_up_needed',
    'appointment_scheduled', 'won', 'lost'
  ));
-- ---------------------------------------------------------------------------
-- 2. Estimated job value + the single pipeline value P3-D sums
-- ---------------------------------------------------------------------------
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS estimated_job_value_low_cents integer;
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS estimated_job_value_high_cents integer;
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS actual_won_value_cents integer;
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS pipeline_value_cents integer;
-- Money is never negative; a KB range is always low <= high.
ALTER TABLE leads
  ADD CONSTRAINT leads_est_job_value_check
  CHECK (
    (estimated_job_value_low_cents IS NULL AND estimated_job_value_high_cents IS NULL)
    OR (estimated_job_value_low_cents >= 0 AND estimated_job_value_high_cents >= 0
        AND estimated_job_value_low_cents <= estimated_job_value_high_cents)
  );
ALTER TABLE leads
  ADD CONSTRAINT leads_actual_won_value_check
  CHECK (actual_won_value_cents IS NULL OR actual_won_value_cents >= 0);
ALTER TABLE leads
  ADD CONSTRAINT leads_pipeline_value_check
  CHECK (pipeline_value_cents IS NULL OR pipeline_value_cents >= 0);
UPDATE leads SET pipeline_value_cents = estimated_value_cents
WHERE pipeline_value_cents IS NULL AND estimated_value_cents IS NOT NULL;
-- P3-D Revenue Recovered sums pipeline_value_cents per business/status.
CREATE INDEX IF NOT EXISTS leads_business_pipeline_idx
  ON leads (business_id, pipeline_value_cents)
  WHERE pipeline_value_cents IS NOT NULL;
-- ---------------------------------------------------------------------------
-- 3. Follow-up tasks — the callback queue
-- ---------------------------------------------------------------------------
CREATE TABLE follow_up_tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- CASCADE (documented in the header): tasks die with their lead.
  lead_id        uuid        NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  -- Next business day (business timezone) for auto-created tasks; the
  -- business's own date for manual/flagged ones.
  due_at         timestamptz NOT NULL,
  done           boolean     NOT NULL DEFAULT false,
  done_at        timestamptz,
  -- Why the task exists: 'lead_new' (auto on capture), 'status_follow_up'
  -- (auto when flagged), 'manual' (business-added).
  created_reason text        NOT NULL DEFAULT 'manual'
                 CONSTRAINT follow_up_tasks_reason_check
                 CHECK (created_reason IN ('lead_new', 'status_follow_up', 'manual')),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX follow_up_tasks_business_open_idx
  ON follow_up_tasks (business_id, due_at)
  WHERE done = false;
CREATE INDEX follow_up_tasks_lead_idx ON follow_up_tasks (lead_id);
-- Same maintained-updated_at convention as every 001 table.
CREATE TRIGGER trg_follow_up_tasks_updated_at
  BEFORE UPDATE ON follow_up_tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
