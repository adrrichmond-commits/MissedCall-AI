-- 016_system_errors.sql — P4-I: in-app error sink table.
--
-- Records unhandled route/server errors, failed SMS deliveries, and voice
-- degradation events so /admin/health can show recent failures with ZERO
-- external tooling (owner requirement 18: reliability & failover). External
-- monitors (ERROR_MONITOR_DSN) are additive, never required.
--
-- Shape:
--   business_id  NULLABLE — platform-level errors (healthz probes, webhook
--                 signature storms) have no single owner business; nullable
--                 mirrors admin_audit.target_business_id, NOT the business-
--                 scoped NOT NULL rule, because this is a platform surface.
--   source       which subsystem produced it (sms_delivery, api_route, ...).
--   severity     'error' | 'warning' (CHECK-constrained).
--   detail       jsonb context (ids, provider codes) — never secrets.
--
-- REPLAY SAFETY (012–015 convention): CREATE TABLE IF NOT EXISTS, idempotent
-- CREATE INDEX IF NOT EXISTS, DROP TRIGGER IF EXISTS before CREATE TRIGGER.
-- No data backfill, no destructive op.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_errors (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid        REFERENCES businesses(id) ON DELETE SET NULL,
  source      text        NOT NULL,
  severity    text        NOT NULL DEFAULT 'error' CHECK (severity IN ('error', 'warning')),
  message     text        NOT NULL,
  detail      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_system_errors_created_at ON system_errors (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_errors_business   ON system_errors (business_id);
CREATE INDEX IF NOT EXISTS idx_system_errors_source     ON system_errors (source);
DROP TRIGGER IF EXISTS trg_system_errors_updated_at ON system_errors;
CREATE TRIGGER trg_system_errors_updated_at BEFORE UPDATE ON system_errors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
