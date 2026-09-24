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
