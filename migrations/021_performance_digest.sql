-- P5-5: Performance reporting + retention value digests.
--
-- notifications_type_check widens again (007 -> 009 -> 017 -> 020 -> here):
-- the new 'performance_digest' in-app notification type — the retention-layer
-- digest (daily/weekly recap of leads captured, jobs booked, estimated
-- revenue recovered) recorded through the standard notification path.
--
-- Also adds the lookup indexes the digest sweep + digest state reads use:
-- the per-business newest-digest lookup and the period-idempotency check
-- (payload->>'periodKey') both scan performance_digest rows only.
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
      'ai_loop_detected',
      'takeover_needed',
      'performance_digest'
    )
  );

CREATE INDEX IF NOT EXISTS idx_notifications_business_type
  ON notifications (business_id, type, created_at DESC);
