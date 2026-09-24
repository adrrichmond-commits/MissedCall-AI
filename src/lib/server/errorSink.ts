/**
 * In-app error sink (P4-I, owner requirement 18/20).
 *
 * One honest place where unhandled route/server errors land:
 *   1. a structured log line (logger.ts, JSON), AND
 *   2. a row in the `system_errors` table (migration 016) so /admin/health
 *      can show recent failures without any external tool, AND
 *   3. when ERROR_MONITOR_DSN is set, a best-effort fire-and-forget POST of
 *      the error JSON to that URL (generic HTTP sink; a Sentry/SDK swap is a
 *      single-file change here). Unset → step 3 no-ops. NO paid service is
 *      required — the product is fully observable without one.
 *
 * HARD RULE: recording an error must never throw and never fail the
 * user-facing flow. Every DB/monitor call here is wrapped; worst case a
 * log line is emitted. Recording must also never block a response longer
 * than a short timeout — the sink is called from request paths.
 */
import { log } from "./logger";
import { sql } from "~/db/queries/shared";
export type SystemErrorSource =
  | "server_fn"
  | "api_route"
  | "sms_delivery"
  | "voice_call"
  | "billing"
  | "rate_limit"
  | "auth"
  | "other";
export interface SystemErrorInput {
  source: SystemErrorSource | string;
  message: string;
  severity?: "error" | "warning";
  /** The business the error belongs to, when one is known from context. */
  businessId?: string | null;
  /** Structured context (ids, statuses, provider codes) — NEVER secrets. */
  detail?: Record<string, unknown>;
}
const MONITOR_TIMEOUT_MS = 2000;
let monitorWarned = false;
/** True when an external monitor endpoint is configured (env-gated). */
export function externalMonitorConfigured(): boolean {
  return Boolean(process.env.ERROR_MONITOR_DSN);
}
/**
 * Forward one error to the external monitor endpoint, fire-and-forget.
 * No-ops when ERROR_MONITOR_DSN is unset (the keyless default). Failures
 * are logged and swallowed — monitoring must never take the app down.
 */
export function notifyExternalMonitor(input: SystemErrorInput): void {
  const dsn = process.env.ERROR_MONITOR_DSN;
  if (!dsn) return;
  const payload = {
    ts: new Date().toISOString(),
    source: input.source,
    severity: input.severity ?? "error",
    message: input.message,
    businessId: input.businessId ?? null,
    detail: input.detail ?? {},
  };
  try {
    void fetch(dsn, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(MONITOR_TIMEOUT_MS),
    }).catch((err) => {
      if (!monitorWarned) {
        monitorWarned = true;
        log.warn("external error monitor unreachable (will not warn again this process)", {
          error: String(err),
        });
      }
    });
  } catch (err) {
    log.warn("external error monitor dispatch failed", { error: String(err) });
  }
}
/**
 * Record one error: log line + system_errors row + optional monitor POST.
 * Resolves (never rejects) even when the DB write fails — callers may
 * `await` it safely inside catch blocks on request paths.
 */
export async function recordSystemError(input: SystemErrorInput): Promise<void> {
  const severity = input.severity ?? "error";
  log.error("system error", {
    source: input.source,
    severity,
    businessId: input.businessId ?? undefined,
    message: input.message,
    detail: input.detail,
  });
  notifyExternalMonitor(input);
  try {
    await sql()`INSERT INTO system_errors (business_id, source, severity, message, detail)
      VALUES (${input.businessId ?? null}, ${input.source}, ${severity}, ${input.message}, ${JSON.stringify(input.detail ?? {}) ?? "{}"}::jsonb)`;
  } catch (err) {
    // The DB itself is the failing dependency more often than not — the log
    // line above already carries the event. Never surface this failure.
    log.warn("system_errors insert failed (error kept in logs only)", { error: String(err) });
  }
}
/** Fire-and-forget variant for hot paths (webhooks, SMS sends). */
export function captureSystemError(input: SystemErrorInput): void {
  void recordSystemError(input);
}
/**
 * Wrap an API route handler so an unexpected throw is RECORDED (log +
 * system_errors) and answered as a plain 500 JSON — the route contract
 * (JSON status payloads, no stack traces) holds even on unhandled errors.
 * Use for JSON routes only; the voice webhook needs TwiML answers and
 * wraps its own handler.
 */
export function guardApiRoute(
  source: string,
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    try {
      return await handler(request);
    } catch (err) {
      await recordSystemError({
        source,
        message: err instanceof Error ? err.message : String(err),
        detail: { url: new URL(request.url).pathname },
      });
      return Response.json(
        { error: "internal_error", message: "Something went wrong. The failure was recorded and the owner can see it in /admin/health." },
        { status: 500 },
      );
    }
  };
}
