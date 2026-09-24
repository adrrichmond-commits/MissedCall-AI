/**
 * Plain (non-RPC) health probe — the single source of truth for /healthz and
 * /api/healthz (Phase 3 reliability pass).
 *
 * WHY THIS EXISTS (prod-500 postmortem): in the production build the Start
 * compiler rewrites every `createServerFn` export into an RPC stub — inside
 * SSR/server code too (`createSsrRpc("<id>")`, i.e. an HTTP self-call to
 * /_serverFn/<id>). A route handler that calls `healthCheckFn()` therefore
 * makes a fetch to the app's own RPC endpoint from inside a request, which
 * fails in prod (the hosting proxy only forwards browser-like requests) and
 * surfaced as 500 {"unhandled":true,"message":"HTTPError"} on /api/healthz.
 * Dev never showed this because the dev module graph calls the handler
 * directly. Lesson: route server-handlers must call PLAIN server functions,
 * never createServerFn wrappers — the RPC wrapper is for browser callers.
 *
 * This module is a plain server module (NOT a server-fn provider): it is
 * imported only from server-side code (the two healthz route handlers and
 * healthCheckFn's handler body), so no client/RPC split applies to it.
 *
 * Honesty rules (unchanged):
 *   - db=true ONLY after a real `SELECT 1` round trip against the database.
 *   - Any failure (connect error, timeout) → db:false / ok:false; the error
 *     itself is swallowed — the response never carries connection strings,
 *     driver messages, or stack traces. The server log keeps the detail.
 *   - The probe is time-boxed (2.5s) so a hung database can't hang monitors.
 */
import { sql } from "~/db/queries/shared";

/** Client-safe health payload — no error detail by design. */
export interface HealthReport {
  ok: boolean;
  db: boolean;
  uptimeSec: number;
  timestamp: string;
}

/** Hard ceiling on the DB probe so /healthz always answers promptly. */
const DB_PROBE_TIMEOUT_MS = 2500;

/**
 * Liveness + DB readiness probe. Unauthenticated by design: monitors, load
 * balancers, and uptime checks must be able to reach it with no session and
 * no cookie. Answers in one small query round trip.
 */
export async function runHealthProbe(): Promise<HealthReport> {
  const report = (db: boolean): HealthReport => ({
    ok: db,
    db,
    uptimeSec: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = sql().query("SELECT 1");
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("db probe timed out")),
        DB_PROBE_TIMEOUT_MS,
      );
    });
    await Promise.race([probe, timeout]);
    return report(true);
  } catch (e) {
    // Detail to the server log only — the public payload stays opaque.
    console.error(
      "[healthz] db probe failed:",
      e instanceof Error ? e.message : e,
    );
    return report(false);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
// ---------------------------------------------------------------------------
// P4-I: DEEP readiness probe (/api/healthz/ready).
//
// Liveness (/api/healthz) answers "is the process up"; readiness answers
// "can the product actually serve customers": DB reachable, every critical
// table present (migrations applied), and a recent-error count from the
// system_errors sink. Monitors point at liveness for alerting-on-down and
// at readiness for alerting-on-degraded. Unauthenticated like liveness —
// the payload carries counts/booleans only, never rows or error text.
// ---------------------------------------------------------------------------
/** Tables the product cannot serve a customer without (migration 016 included). */
export const CRITICAL_TABLES = [
  "businesses",
  "users",
  "sessions",
  "leads",
  "conversations",
  "appointments",
  "notifications",
  "system_errors",
] as const;
export interface ReadinessReport {
  ok: boolean;
  db: boolean;
  /** One entry per critical table: true when the table exists (migration applied). */
  tables: Record<string, boolean>;
  /** system_errors rows in the trailing window; null when the table is missing. */
  recentErrors: number | null;
  /** Minutes the error count covers (fixed, part of the monitor contract). */
  errorWindowMinutes: number;
  uptimeSec: number;
  timestamp: string;
}
const READINESS_TIMEOUT_MS = 5000;
export const READINESS_ERROR_WINDOW_MINUTES = 60;
export async function runReadinessProbe(): Promise<ReadinessReport> {
  const timestamp = new Date().toISOString();
  const uptimeSec = Math.floor(process.uptime());
  const tables = Object.fromEntries(CRITICAL_TABLES.map((t) => [t, false])) as Record<string, boolean>;
  let db = false;
  let recentErrors: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = (async () => {
      // One round trip for liveness + table presence (to_regclass never throws
      // for a missing table — it returns NULL).
      const selects = CRITICAL_TABLES.map(
        (t) => `to_regclass('public.${t}') IS NOT NULL AS ${t}`,
      ).join(", ");
      const rows = (await sql().query(`SELECT ${selects}`)) as unknown as Array<Record<string, boolean>>;
      const row = rows[0] ?? {};
      for (const t of CRITICAL_TABLES) tables[t] = row[t] === true;
      // Error count — only when the sink table itself exists.
      if (tables["system_errors"]) {
        const errRows = (await sql().query(
          `SELECT count(*)::int AS n FROM system_errors WHERE created_at > now() - ('1 hour')::interval`,
        )) as unknown as Array<{ n: number }>;
        recentErrors = errRows[0]?.n ?? 0;
      }
    })();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("readiness probe timed out")), READINESS_TIMEOUT_MS);
    });
    await Promise.race([probe, timeout]);
    db = true;
  } catch (e) {
    console.error(
      "[healthz-ready] probe failed:",
      e instanceof Error ? e.message : e,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
  const allTablesOk = CRITICAL_TABLES.every((t) => tables[t]);
  const ok = db && allTablesOk;
  return { ok, db, tables, recentErrors, errorWindowMinutes: READINESS_ERROR_WINDOW_MINUTES, uptimeSec, timestamp };
}
