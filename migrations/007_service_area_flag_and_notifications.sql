-- 007_service_area_flag_and_notifications.sql — Phase 2 build #3:
--   1) leads.service_area_status — where the caller sits relative to the
--      business's service_areas rows, captured at lead capture time.
--      Tri-state because the capture path cannot always determine it:
--        'in_area'      — address ZIP or city matched a service_areas row
--        'out_of_area'  — address parsed but matched nothing (lead is still
--                         captured, never dropped — the flag just makes it
--                         visible so the shop can decide)
--        'unknown'      — no usable ZIP/city in the address (default for
--                         pre-existing rows and unparseable input)
--      Text + CHECK (not a PG enum) so the set stays editable, matching the
--      005/006 pattern.
--   2) notifications — in-app notification center feed (build #3). Events:
--      new_lead, lead_booked, appointment_requested, appointment_confirmed,
--      appointment_declined. payload carries event details (lead id/name,
--      appointment id, etc) so the UI can render + link without extra joins.
--      In-app delivery is unconditional; email/SMS prefs live in
--      businesses.settings and are provider-pending (no sender exists yet).

ALTER TABLE leads
  ADD COLUMN service_area_status text NOT NULL DEFAULT 'unknown';
ALTER TABLE leads
  ADD CONSTRAINT leads_service_area_status_check
  CHECK (service_area_status IN ('in_area', 'out_of_area', 'unknown'));
CREATE INDEX idx_leads_business_area ON leads (business_id, service_area_status);

CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_type_check CHECK (
    type IN ('new_lead', 'lead_booked', 'appointment_requested',
             'appointment_confirmed', 'appointment_declined')
  )
);
CREATE INDEX idx_notifications_business_created
  ON notifications (business_id, created_at DESC);
-- Partial index for the unread badge count (the hot query).
CREATE INDEX idx_notifications_business_unread
  ON notifications (business_id, created_at DESC) WHERE read_at IS NULL;

CREATE TRIGGER set_updated_at_notifications
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
