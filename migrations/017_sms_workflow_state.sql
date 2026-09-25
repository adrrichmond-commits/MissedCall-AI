-- P4-S: configurable SMS workflows + safeguard state.
--
-- The workflow CONFIGURATION stays per-business in businesses.settings jsonb
-- (nested `smsWorkflows` blob, same pattern as the receptionist config — no
-- table needed for it). What genuinely needs rows is the safeguard STATE that
-- every send decision is computed from:
--
--   sms_workflow_sends    one row per evaluated workflow send attempt (sent,
--                         failed, or suppressed). Duplicate suppression and
--                         per-customer caps are queried from this table —
--                         counting only outcome='sent' rows — and it doubles
--                         as the audit log for what actually went out.
--   sms_invalid_numbers   numbers detected as non-textable (bad format or the
--                         provider rejected them). A row means: stop texting
--                         this number, surface it honestly in the UI.
--
-- Also widens notifications_type_check with 'ai_loop_detected': when a thread
-- loops on our own AI/template output the engine stops auto-responding and
-- hands the thread to a human through the standard notification path.

-- ---------------------------------------------------------------------------
-- sms_workflow_sends
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_workflow_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  workflow_key text NOT NULL,
  phone text NOT NULL,
  recipient text NOT NULL DEFAULT 'customer',
  outcome text NOT NULL,
  suppress_reason text,
  body text,
  provider_sid text,
  lead_id uuid,
  appointment_id uuid,
  conversation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sms_workflow_sends_dedup
  ON sms_workflow_sends (business_id, phone, workflow_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_workflow_sends_phone
  ON sms_workflow_sends (business_id, phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_workflow_sends_appointment
  ON sms_workflow_sends (business_id, appointment_id, workflow_key)
  WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sms_workflow_sends_lead
  ON sms_workflow_sends (business_id, lead_id, workflow_key)
  WHERE lead_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sms_invalid_numbers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sms_invalid_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  phone text NOT NULL,
  reason text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_sms_invalid_numbers_business
  ON sms_invalid_numbers (business_id, detected_at DESC);

-- ---------------------------------------------------------------------------
-- notifications_type_check gains 'ai_loop_detected'
-- ---------------------------------------------------------------------------
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check CHECK (
    type IN (
      'new_lead',
      'lead_booked',
      'appointment_requested',
      'appointment_confirmed',
      'appointment_declined',
      'payment_failed',
      'ai_loop_detected'
    )
  );
