-- 005_lead_lifecycle.sql — Phase 2 lead lifecycle: priority + status workflow.
--
-- Relationship to 001_init.sql (extend, don't duplicate):
--   * leads.converted_at timestamptz ALREADY EXISTS (001) — nothing to add.
--   * leads.status already exists as the ENUM lead_status
--     ('new','contacted','qualified','converted','lost'). Phase 2 replaces that
--     lifecycle with 'new','contacted','booked','completed','lost'. We convert
--     the column to text + CHECK instead of ALTER TYPE ... ADD VALUE because
--     Postgres cannot remove enum values, and the lifecycle set must be
--     editable going forward (same tradeoff 004 made for businesses columns).
--   * priority is genuinely NEW: a 3-value business triage ranking
--     ('emergency','high','normal'). It is deliberately separate from the
--     4-value customer-reported urgency enum in 001 — urgency is what the
--     caller said; priority is how the shop triages the job.
--
-- Backfill (documented here and in the PR):
--   status:  'converted' rows (the old "won" state, all with appointments)
--            -> 'completed' when a completed appointment exists, else 'booked'
--            (the job is on the books but not finished). 'qualified' meant
--            "vetted, still in pipeline" -> 'contacted'. converted_at is set
--            (now()) for rows moving to booked/completed that lack one.
--   priority: derived from the existing customer-reported urgency —
--            urgency='emergency' -> 'emergency', 'same_day' -> 'high',
--            everything else -> 'normal'.

-- ---------------------------------------------------------------------------
-- 1. status: enum -> text with the Phase 2 lifecycle CHECK
-- ---------------------------------------------------------------------------
ALTER TABLE leads ALTER COLUMN status TYPE text USING status::text;

-- Old-lifecycle rows must be remapped BEFORE the CHECK is added.
UPDATE leads SET status = 'completed', converted_at = coalesce(converted_at, now())
WHERE status = 'converted'
  AND EXISTS (
    SELECT 1 FROM appointments a
    WHERE a.lead_id = leads.id AND a.business_id = leads.business_id
      AND a.status = 'completed'
  );

UPDATE leads SET status = 'booked', converted_at = coalesce(converted_at, now())
WHERE status = 'converted';

UPDATE leads SET status = 'contacted' WHERE status = 'qualified';

ALTER TABLE leads
  ADD CONSTRAINT leads_status_check
  CHECK (status IN ('new', 'contacted', 'booked', 'completed', 'lost'));

-- ---------------------------------------------------------------------------
-- 2. priority: new 3-value triage ranking
-- ---------------------------------------------------------------------------
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal'
  CONSTRAINT leads_priority_check CHECK (priority IN ('emergency', 'high', 'normal'));

UPDATE leads SET priority = 'emergency' WHERE urgency = 'emergency';
UPDATE leads SET priority = 'high' WHERE urgency = 'same_day';

CREATE INDEX IF NOT EXISTS leads_business_priority_idx ON leads (business_id, priority);
