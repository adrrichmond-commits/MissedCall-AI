/**
 * Health-check server functions (Phase 3 reliability pass).
 *
 * IMPORT-PROTECTION PATTERN (same discipline as P3-G's adminFns/admin split):
 * route modules may only import createServerFn modules, so every export here
 * is a `createServerFn` (or a pure type). The DB probe lives in this server
 * module; /healthz (src/routes/healthz.ts) is a thin RPC shim over
 * `healthCheckFn` and never imports the query layer directly.
 *
 * Honesty rules:
 *   - db=true ONLY after a real `SELECT 1` round trip against the database.
 *   - Any failure (connect error, timeout) → db:false / ok:false; the error
 *     itself is swallowed — the response never carries connection strings,
 *     driver messages, or stack traces. The server log keeps the detail.
 *   - The probe is time-boxed (2.5s) so a hung database can't hang monitors.
 */
import { createServerFn } from "@tanstack/react-start";
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
 * Liveness + DB readiness. Unauthenticated by design: monitors, load
 * balancers, and uptime checks must be able to call it with no session and
 * no cookie. Answers in one small query round trip.
 */
export const healthCheckFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<HealthReport> => {
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
  },
);
