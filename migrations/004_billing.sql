-- Phase 1 billing: subscription state on businesses.
-- Stripe checkout/webhooks land in Phase 2; until then these columns are read
-- and written by the in-app billing page (plan changes are recorded on the
-- account; cancel keeps plan data per the product requirement).
--
-- Note: businesses.plan already exists from 001_init.sql as a NOT NULL
-- business_plan enum (default 'trial') — it is reused for plan storage, so
-- only the two genuinely missing nullable columns are added here.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_status text;
