-- 012_usage_and_billing_history.sql — Phase 3 build P3-F: billing completeness.
--
--   1) usage_counters — per-business, per-period metered-usage counters for
--      the plan-metered axes (sms_sent, ai_turns, calls_handled). One row per
--      (business_id, period_start); the row is created on first increment of
--      the period and its counters move ONLY by single-statement increments
--      (UPDATE ... SET x = x + N RETURNING), never read-modify-write, so
--      concurrent webhooks and retried sends cannot lose counts.
--
--      PERIOD ANCHOR: the subscription billing period. In this build the
--      anchor is the month since the business's trial/subscription start —
--      computed by the caller (src/lib/server/usage.ts) from
--      businesses.trial_ends_at / created_at, because 001/004/009 already
--      own those columns and the anchor must be a pure, unit-tested rule.
--      When live Stripe billing lands, current_period_start can be carried on
--      businesses and passed in unchanged — the row key is just a timestamp.
--
--   2) billing_events — a per-business billing history ledger. Rows come from
--      two honest sources only:
--        a) the Stripe webhook path (already-deduped by stripe_events) and
--        b) local subscription lifecycle changes made in the app
--           (cancel / reactivate / plan change requests).
--      Nothing here is invented: no row is written for a state nobody set.
--      The billing page reads this ledger plus stripe_events to render
--      history. CHECK constrains event_type to the values the app acts on.
--
-- REPLAY SAFETY (011 lesson): every statement is idempotent against a
-- 001→011 replay AND against this file itself — CREATE TABLE IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS, DROP CONSTRAINT IF EXISTS + ADD CONSTRAINT.
-- There is NO data backfill and NO dependency on column values created by
-- later files, so re-running the whole chain into a fresh database produces
-- the same schema. Re-running this file alone is a no-op.
--
-- NOT APPLIED TO NEON BY THIS BUILD — the lead applies and verifies.

CREATE TABLE IF NOT EXISTS usage_counters (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  sms_sent     integer NOT NULL DEFAULT 0,
  ai_turns     integer NOT NULL DEFAULT 0,
  calls_handled integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- The uniqueness IS the counter: one row per business per period. The
-- increment path upserts on this key and then updates by the same key.
CREATE UNIQUE INDEX IF NOT EXISTS usage_counters_business_period_key
  ON usage_counters (business_id, period_start);

-- Gating reads resolve "this period's row for this business" — covered by the
-- unique index above; this range index also serves history scans.
CREATE INDEX IF NOT EXISTS usage_counters_business_period_idx
  ON usage_counters (business_id, period_start DESC);

CREATE TRIGGER trg_usage_counters_updated_at
  BEFORE UPDATE ON usage_counters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS billing_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_type   text NOT NULL,
  -- 'checkout_completed' | 'subscription_updated' | 'subscription_canceled'
  -- | 'payment_failed' | 'plan_change' | 'reactivated'
  source       text NOT NULL DEFAULT 'local',
  -- 'stripe' (webhook path) | 'local' (in-app lifecycle action)
  description  text,
  payload      jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- History is read newest-first per business.
CREATE INDEX IF NOT EXISTS billing_events_business_occurred_idx
  ON billing_events (business_id, occurred_at DESC);

ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_event_type_check;
ALTER TABLE billing_events
  ADD CONSTRAINT billing_events_event_type_check
  CHECK (event_type IN (
    'checkout_completed',
    'subscription_updated',
    'subscription_canceled',
    'payment_failed',
    'plan_change',
    'reactivated'
  ));

ALTER TABLE billing_events DROP CONSTRAINT IF EXISTS billing_events_source_check;
ALTER TABLE billing_events
  ADD CONSTRAINT billing_events_source_check
  CHECK (source IN ('stripe', 'local'));
