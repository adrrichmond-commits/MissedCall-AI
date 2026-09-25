-- P5-4: Human takeover / escalation for AI conversations.
--
-- 1) conversations gains a handoff state machine:
--      'ai'     (default) the AI assistant owns the thread;
--      'needed' a trigger flagged the thread for a human (emergency, angry
--               customer, unclear request, low-confidence/backstop turn,
--               pricing/policy outside the AI's rules);
--      'human'  a person took over — inbound messages go to the plumber and
--               the AI sends nothing until the thread is handed back.
--    Who took over (handoff_by) and when (handoff_at) are stamped on
--    takeover so the inbox thread can show it. handoff_reason/detail keep
--    the trigger evidence while the flag is open.
--
-- 2) notifications_type_check widens again (007 -> 009 -> here): the new
--    'takeover_needed' in-app notification type, plus 'ai_loop_detected'
--    which the query-layer whitelist already allowed but the DB constraint
--    never did (a latent gap fixed here as part of the same notification
--    path).

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS handoff_status text NOT NULL DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS handoff_reason text,
  ADD COLUMN IF NOT EXISTS handoff_detail jsonb,
  ADD COLUMN IF NOT EXISTS handoff_by text,
  ADD COLUMN IF NOT EXISTS handoff_at timestamptz;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_handoff_status_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_handoff_status_check
  CHECK (handoff_status IN ('ai', 'needed', 'human'));

-- Hot query: the inbox "needs takeover" list. Partial — most threads stay 'ai'.
CREATE INDEX IF NOT EXISTS idx_conversations_handoff
  ON conversations (business_id, handoff_status)
  WHERE handoff_status <> 'ai';

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check CHECK (
    type IN ('new_lead', 'lead_booked', 'appointment_requested',
             'appointment_confirmed', 'appointment_declined', 'payment_failed',
             'ai_loop_detected', 'takeover_needed')
  );
