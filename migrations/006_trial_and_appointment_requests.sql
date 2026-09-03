-- 006_trial_and_appointment_requests.sql — Phase 2: appointment REQUESTED/
-- CONFIRMED lifecycle. (Trial enforcement needs no schema change: migration
-- 004 already added businesses.trial_ends_at + subscription_status, and
-- businesses.plan already carries 'trial' | 'starter' | 'pro'.)
--
-- Relationship to 001_init.sql (extend, don't duplicate):
--   * appointments.status is the PG ENUM appointment_status
--     ('scheduled','confirmed','in_progress','completed','cancelled',
--     'no_show'). The Phase 2 lifecycle is request-driven: AI/customer-initiated
--     bookings are REQUESTS the business confirms, so the set becomes
--     'requested','confirmed','declined','completed'. As in 005, we convert to
--     text + CHECK because Postgres cannot remove enum values and the set must
--     stay editable.
--
-- Backfill (documented here and in the PR):
--   scheduled   -> requested   (booked by AI/customer, business hasn't confirmed)
--   confirmed   -> confirmed
--   in_progress -> confirmed   (a job underway was certainly confirmed)
--   completed   -> completed
--   cancelled   -> declined    (business declined the request)
--   no_show     -> declined    (request fell through; the old distinct
--                               no_show state is absorbed — flag if you need
--                               it back as its own value)
-- New rows default to 'requested' via the DEFAULT below.

ALTER TABLE appointments ALTER COLUMN status TYPE text USING status::text;

UPDATE appointments SET status = 'requested' WHERE status = 'scheduled';
UPDATE appointments SET status = 'confirmed' WHERE status = 'in_progress';
UPDATE appointments SET status = 'declined' WHERE status IN ('cancelled', 'no_show');

ALTER TABLE appointments
  ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('requested', 'confirmed', 'declined', 'completed'));

ALTER TABLE appointments ALTER COLUMN status SET DEFAULT 'requested';
