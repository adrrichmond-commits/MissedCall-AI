-- P4-V (owner requirement 12: demo mode clearly labeled).
--
-- Marks the seeded demo business so every session in it can render a
-- persistent "DEMO" banner — nobody should ever mistake the sample leads,
-- conversations, and revenue numbers for their own live data.
--
-- The column is NOT NULL DEFAULT false: every real signup business stays
-- unlabeled. Only scripts/seed.ts sets is_demo = true (on Rapid Rooter
-- Plumbing), and CASCADE wipe/re-seed keeps it true.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
