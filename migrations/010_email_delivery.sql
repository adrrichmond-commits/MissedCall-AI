-- Phase 2 build #6: transactional email delivery pre-wire.
--
-- The notification center (007) records in-app events; build #6 adds a
-- fire-and-forget email attempt for the three business-critical types
-- (new_lead, appointment_requested, payment_failed) when EMAIL_API_KEY is
-- configured.
--
-- email_sent_at is the double-send guard: it is stamped ONLY after the
-- provider accepted a send (never on skip or failure), and the delivery hook
-- skips any notification where it is already set. NULL means "email never
-- attempted/succeeded for this notification" — the honest default.
--
-- NOTE (lead): apply after merge — NOT applied to Neon by this PR.

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS email_sent_at timestamptz;

-- Hot-path lookup for the delivery hook's already-sent check.
CREATE INDEX IF NOT EXISTS idx_notifications_email_pending
  ON notifications (id) WHERE email_sent_at IS NULL;
