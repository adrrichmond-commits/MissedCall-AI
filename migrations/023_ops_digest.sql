-- Weekly ops digest (owner email): the honest state of the business, weekly,
-- in the platform owner's inbox — so the dashboard becomes optional.
--
-- notifications_type_check widens again (007 -> 009 -> 017 -> 020 -> 021 ->
-- here): the new 'ops_digest' in-app notification type. The weekly ops
-- digest is delivered in-app (on the platform owner's business feed, the
-- same channel every other notification uses) AND attempted by email through
-- the existing provider path (src/lib/server/email.ts — the Knock
-- missedcall-notify transport the payment-failure path uses under the hood).
--
-- No other schema change: the idempotency lookup (one ops_digest per ISO
-- period key) reuses the idx_notifications_business_type index 021 added.
-- The recipient is never stored here — it is resolved fresh from
-- users.is_platform_admin at send time (migration 014's flag; users.role has
-- no 'ADMIN' value — role scopes a user WITHIN one business).

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
      'performance_digest',
      'ops_digest'
    )
  );
