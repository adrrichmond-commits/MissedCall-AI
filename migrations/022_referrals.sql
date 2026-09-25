-- P5-7: Referral foundation.
--
-- Two pieces, both real and minimal:
--   1. businesses.referral_code — one STABLE, stored code per business
--      (assigned lazily on first read / at signup; never rotated by the app).
--   2. referrals — attribution of a signup to the business whose referral
--      link/code was used. The row belongs to the REFERRED (new) business,
--      keeping the business-scoped isolation convention: queries for "who did
--      THIS business refer" read by referrer_business_id; queries for "was
--      THIS business referred" read by business_id.
--
-- No incentives exist yet (the owner has not decided real terms) — the schema
-- records only the fact of the referral, never a promised reward.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS referral_code TEXT;

-- Codes are unique where present; NULL (not yet assigned) is allowed and the
-- partial index keeps lookups exact and cheap.
CREATE UNIQUE INDEX IF NOT EXISTS businesses_referral_code_key
  ON businesses (referral_code) WHERE referral_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The REFERRED (new) business — this attribution describes its signup.
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- The business whose referral code/link the signup came through.
  referrer_business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- The code as presented at signup — an audit trail that survives any later
  -- change on the referrer's own code.
  referral_code TEXT NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One attribution per business (a business signs up once).
  CONSTRAINT referrals_one_attribution_per_business UNIQUE (business_id),
  -- A business can never refer itself.
  CONSTRAINT referrals_no_self_referral CHECK (business_id <> referrer_business_id)
);

CREATE INDEX IF NOT EXISTS referrals_referrer_idx
  ON referrals (referrer_business_id, created_at DESC);
