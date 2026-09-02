-- 002_email_verified.sql — Email verification support for Phase 1 auth.
--
-- Adds users.email_verified: signup creates unverified users; verification is
-- a token flow (email_verification_tokens) that flips this flag. Unverified
-- users may still log in (demo-friendly) — the app shows a "verify your email"
-- banner instead of blocking them.
--
-- Existing users (the demo seed) are backfilled to verified: they represent
-- established accounts.
ALTER TABLE users
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false;

UPDATE users SET email_verified = true;
