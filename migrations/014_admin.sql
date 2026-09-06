-- 014_admin.sql — Phase 3 build P3-G: internal admin dashboard (owner-only).
--
--   1) users.is_platform_admin — the ONE flag that opens the /admin surface.
--      Default false for every existing and future user; nothing else in the
--      app grants it. It is deliberately a separate axis from users.role:
--      role ('owner'|'manager'|'employee') scopes a user WITHIN one business;
--      is_platform_admin marks THE platform operator who may cross the
--      business-isolation boundary. A business owner is NOT a platform admin.
--
--      SEEDING: no row is flipped here. The platform owner account is
--      promoted at runtime (src/lib/server/admin.ts) by an
--      UPDATE ... WHERE lower(email) = the PLATFORM_OWNER_EMAIL env value —
--      never a hard-coded personal email. When the env is absent the flag
--      stays false everywhere and the gate is CLOSED (admin pages 404 for
--      everyone, admin server fns refuse). The migration stays replay-safe
--      because it hard-codes no email.
--
--   2) businesses.disabled_at — the admin kill switch. NULL = enabled. When
--      set, the session resolver (getSessionFromRequest) returns null for
--      the business's users (kills API + pages immediately) and loginFn
--      refuses new logins. Admin impersonation reads the flag to warn.
--
--   3) admin_audit — append-only log of every privileged admin action
--      (impersonation start/stop, account disable/enable, plan override).
--      No UPDATE path ships: writes are INSERT-only (appendAdminAudit) and
--      the log page is read-only. target_business_id is nullable because
--      some actions (login as, future global actions) target the platform
--      itself.
--
-- REPLAY SAFETY (012/013 convention): every statement is idempotent against
-- a 001→013 replay AND against this file itself — ALTER TABLE ... ADD COLUMN
-- IF NOT EXISTS, CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS.
-- There is NO data backfill, NO destructive op, and NO dependency on column
-- values created by this file. Re-running the file (or replaying the full
-- migration history onto a fresh database) converges to the same schema.
-- ---------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

CREATE TABLE IF NOT EXISTS admin_audit (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id      uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- CHECK-constrained action set (the values admin fns write). Editable via
  -- migration later — text + CHECK, not a PG enum, on purpose.
  action             text        NOT NULL,
  target_business_id uuid        REFERENCES businesses(id) ON DELETE SET NULL,
  detail             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_audit_action_check CHECK (
    action IN (
      'impersonate_start',
      'impersonate_stop',
      'account_disable',
      'account_enable',
      'plan_override'
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_created
  ON admin_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_target
  ON admin_audit (target_business_id) WHERE target_business_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin
  ON admin_audit (admin_user_id, created_at DESC);
