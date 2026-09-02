-- Phase 1 settings: per-business configuration JSON (notification prefs today,
-- more settings later). Kept on businesses so business-level isolation stays
-- trivial: one row, one owner, cascade semantics already in place.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;
