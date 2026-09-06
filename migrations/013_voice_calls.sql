-- 013_voice_calls.sql — Phase 3 build P3-E: AI voice receptionist call records.
--
-- One row per inbound voice call the AI receptionist handles (Twilio voice
-- webhook → TwiML flow). The transcript jsonb carries the full exchange —
-- caller utterances AND what the AI said — with per-turn classification
-- stamps shaped exactly like the SMS path's message classification
-- (MessageClassification jsonb; see src/db/schema.ts).
--
-- REPLAY SAFETY: this file is idempotent — it replays cleanly against a
-- database that has run 001→012 AND against itself. Every statement is
-- CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP TRIGGER IF
-- EXISTS + CREATE TRIGGER / DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT.
-- NO destructive operations (no drops of tables/columns, no data rewrites).
--
-- Column notes (names fixed by the P3-E brief):
--   call_sid      Twilio CallSid, UNIQUE — the webhook idempotency key.
--   status        what WE observed: 'in_progress' while the AI conversation
--                 runs, then 'completed' | 'transfered' | 'voicemail' |
--                 'no_answer' | 'failed' from the dial/record/hangup
--                 callbacks. Deliberately NOT a Twilio mirror — honest local
--                 state, editable CHECK (text + check, not a PG enum).
--   transfered_to E.164 number the caller was <Dial>ed to, NULL when the
--                 call never transferred. (Spelled per the brief.)
--   lead_id       the lead captured from this call — ON DELETE SET NULL so
--                 deleting a lead keeps the call history (same deliberate
--                 design as conversations → lead in 001).
--   transcript    jsonb document {turns: [...], flow: {...}}: turns is the
--                 exchange ({role, text, at, classification?} per turn) and
--                 flow is the receptionist's live flow state so an interrupted
--                 call resumes honestly.
--   ai_summary    post-call AI summary of the transcript (P3-E deliverable 4),
--                 NULL when no summary could be produced — never a guess.
--   duration_sec  seconds; filled from Twilio call-duration fields when the
--                 final callbacks provide them, else from created_at math.
--
-- USAGE NOTE: a handled voice call meters calls_handled (usage_counters, 012)
-- in the app layer — SOFT behavior (log-only at the limit; a live call is
-- never dropped over billing). See src/lib/server/voiceReceptionist.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  call_sid      text NOT NULL,
  from_number   text,
  to_number     text,
  status        text NOT NULL DEFAULT 'in_progress',
  duration_sec  integer,
  recording_url text,
  transcript    jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_summary    text,
  lead_id       uuid REFERENCES leads(id) ON DELETE SET NULL,
  transfered_to text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calls_call_sid_key UNIQUE (call_sid),
  CONSTRAINT calls_status_check CHECK (
    status IN ('in_progress', 'completed', 'transfered', 'voicemail', 'no_answer', 'failed')
  )
);

-- Dashboard/history reads are per-business, newest first.
CREATE INDEX IF NOT EXISTS idx_calls_business_created
  ON calls (business_id, created_at DESC);
-- Lead linkage (call → lead join for the CRM detail view).
CREATE INDEX IF NOT EXISTS idx_calls_lead
  ON calls (lead_id) WHERE lead_id IS NOT NULL;

CREATE TRIGGER trg_calls_updated_at
  BEFORE UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
