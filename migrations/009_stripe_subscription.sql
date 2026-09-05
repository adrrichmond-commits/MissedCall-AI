-- 009_stripe_subscription.sql — Phase 2 build #5: Stripe webhook activation path.
--
--   1) businesses gains the Stripe identity columns the webhook route links
--      and syncs (migration 004 added trial_ends_at + subscription_status):
--        stripe_customer_id     — the Stripe customer, resolved from checkout
--                                 session metadata.businessId (or email lookup)
--        stripe_subscription_id — the live subscription id (latest seen)
--        current_period_end     — from customer.subscription.* events
--      Both stripe ids get UNIQUE partial indexes: a Stripe customer or a
--      live subscription belongs to exactly one business, and the unique
--      constraint turns an accidental cross-business double-link into a
--      loud DB error instead of silent account crossover.
--   2) businesses.subscription_status (free text since 004) now gets a
--      CHECK constraining it to the Stripe lifecycle values the app acts on:
--        'active'    — paid and in good standing (grants write access)
--        'trialing'  — Stripe-side trial (grants write access)
--        'past_due'  — payment failed, Smart Retries in progress (grace)
--        'canceled'  — subscription ended (read-only; plan reverts to trial)
--      NULL-safe (NULL = never subscribed — every pre-Stripe row) and
--      idempotent (DROP IF EXISTS + ADD) like the rest of the file.
--   3) stripe_events — webhook event-id dedupe. stripe_events.id is Stripe's
--      event id (evt_...); the route INSERTs ON CONFLICT DO NOTHING before
--      processing and skips events already marked processed, so Stripe's
--      at-least-once redeliveries never double-apply. processed_at is stamped
--      AFTER the handlers commit; an event whose processing crashed stays
--      unprocessed and is honestly reprocessed on redelivery.
--   4) notifications_type_check gains 'payment_failed' — invoice.payment_failed
--      creates an in-app notification (the honest, provider-free channel that
--      always exists; email/SMS delivery remains provider-gated).
-- Every statement is idempotent so a partially-applied run can re-apply.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text;
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS current_period_end timestamptz;

ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_subscription_status_check;
ALTER TABLE businesses
  ADD CONSTRAINT businesses_subscription_status_check
  CHECK (subscription_status IS NULL OR subscription_status IN
         ('active', 'trialing', 'past_due', 'canceled'));

CREATE UNIQUE INDEX IF NOT EXISTS businesses_stripe_customer_key
  ON businesses (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS businesses_stripe_subscription_key
  ON businesses (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stripe_events (
  id           text PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_stripe_events_updated_at
  BEFORE UPDATE ON stripe_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_type_check CHECK (
    type IN ('new_lead', 'lead_booked', 'appointment_requested',
             'appointment_confirmed', 'appointment_declined', 'payment_failed')
  );
