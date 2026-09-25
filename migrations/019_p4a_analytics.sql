-- 019_p4a_analytics.sql — P4-A learning loop: funnel events, per-conversation
-- customer feedback, AI outcome signals + review flags, runtime-editable AI
-- prompts with version history.
--
--   1) funnel_events — one row per (business, stage) FIRST occurrence. The
--      pipeline stages: signup → trial_start → onboarding_completed →
--      phone_connected → first_lead → first_recovered_call → paid. Recording
--      is idempotent (INSERT ... ON CONFLICT DO NOTHING): a business that
--      signs up twice in a test, or saves its phone five times, still counts
--      once. The timestamp is WHEN THE STAGE FIRST HAPPENED. No fake backfill:
--      businesses that existed before this migration simply have no rows yet.
--   2) conversations += owner feedback (thumbs up/down + optional note) and
--      the AI outcome signal blob (ai_outcome jsonb) maintained by the SMS
--      pipeline: classified/failed turn counters, last response latency,
--      contact-captured / emergency-detected / emergency-escalated booleans.
--      NULL ai_outcome = the AI never ran on this conversation (honest).
--   3) ai_review_flags — the review queue. Flags are (re)computed from the
--      outcome signals + feedback by src/lib/analytics/quality.ts rules and
--      stored per conversation; resolving one records who/when.
--   4) prompt_versions — runtime-editable AI system-prompt overlays, one row
--      per version per surface ('lead_capture' | 'receptionist'). Exactly one
--      active row per surface (partial unique index); the code default always
--      remains the fallback and safety guardrails are never replaced by a DB
--      row — the overlay is APPENDED after the guardrail prompt. Versioning
--      records who/when; revert = flip the active pointer to any prior
--      version (no data loss, no redeploy).
-- Every statement is idempotent so a partially-applied run can re-apply.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS funnel_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  stage           text NOT NULL
                  CONSTRAINT funnel_events_stage_check CHECK (stage IN (
                    'signup', 'trial_start', 'onboarding_completed',
                    'phone_connected', 'first_lead', 'first_recovered_call', 'paid')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- First occurrence per (business, stage): the funnel counts BUSINESSES.
CREATE UNIQUE INDEX IF NOT EXISTS funnel_events_business_stage_key ON funnel_events (business_id, stage);
CREATE INDEX IF NOT EXISTS funnel_events_stage_created_idx ON funnel_events (stage, created_at DESC);
DROP TRIGGER IF EXISTS set_updated_at_funnel_events ON funnel_events;
CREATE TRIGGER set_updated_at_funnel_events
  BEFORE UPDATE ON funnel_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Per-conversation owner feedback ("How did MissedCall AI handle this?").
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS feedback_rating text;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_feedback_rating_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_feedback_rating_check
  CHECK (feedback_rating IN ('up', 'down'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS feedback_note text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS feedback_at timestamptz;
-- AI outcome signal blob (see module doc): { capturedContact, emergencyDetected,
-- emergencyEscalated, classifiedTurns, failedTurns, lastLatencyMs }.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_outcome jsonb;
CREATE INDEX IF NOT EXISTS conversations_business_feedback_idx
  ON conversations (business_id, feedback_at DESC) WHERE feedback_rating IS NOT NULL;

-- The AI-quality review queue (owner/admin work list).
CREATE TABLE IF NOT EXISTS ai_review_flags (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reason          text NOT NULL
                  CONSTRAINT ai_review_flags_reason_check CHECK (reason IN (
                    'negative_feedback', 'emergency_without_escalation',
                    'ai_failed_repeatedly', 'no_contact_captured', 'high_latency')),
  detail          text,
  resolved        boolean NOT NULL DEFAULT false,
  resolved_by     text,
  resolved_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_review_flags_business_open_idx
  ON ai_review_flags (business_id, resolved, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_review_flags_conversation_idx ON ai_review_flags (conversation_id);
DROP TRIGGER IF EXISTS set_updated_at_ai_review_flags ON ai_review_flags;
CREATE TRIGGER set_updated_at_ai_review_flags
  BEFORE UPDATE ON ai_review_flags
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Runtime-editable AI prompt overlays with full version history.
CREATE TABLE IF NOT EXISTS prompt_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surface         text NOT NULL
                  CONSTRAINT prompt_versions_surface_check CHECK (surface IN ('lead_capture', 'receptionist')),
  version         integer NOT NULL,
  body            text NOT NULL,
  note            text,
  edited_by       text,
  is_active       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_versions_surface_version_key UNIQUE (surface, version)
);
-- Exactly one active version per surface.
CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_active_key ON prompt_versions (surface) WHERE is_active;
CREATE INDEX IF NOT EXISTS prompt_versions_surface_idx ON prompt_versions (surface, version DESC);
DROP TRIGGER IF EXISTS set_updated_at_prompt_versions ON prompt_versions;
CREATE TRIGGER set_updated_at_prompt_versions
  BEFORE UPDATE ON prompt_versions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
