/**
 * Health-check server function (Phase 3 reliability pass).
 *
 * The actual probe lives in ./healthProbe.ts as a PLAIN function —
 * `runHealthProbe()` — and is the function the /healthz and /api/healthz
 * route handlers call directly (see that file for the prod-500 postmortem:
 * in the production build a createServerFn call inside a route handler
 * becomes an HTTP self-call to /_serverFn/<id> and 500s).
 *
 * `healthCheckFn` remains exported as the browser-callable RPC form of the
 * same probe for API stability (nothing in the product currently calls it
 * over RPC); its handler simply delegates to the plain probe, so the wire
 * contract is identical wherever it is used.
 *
 * IMPORT-PROTECTION PATTERN (same discipline as P3-G's adminFns/admin split):
 * route modules may only import createServerFn modules from this file; the
 * route handlers import the plain probe from ./healthProbe directly instead.
 */
import { createServerFn } from "@tanstack/react-start";
import { runHealthProbe } from "./healthProbe";
import type { HealthReport } from "./healthProbe";

export type { HealthReport };

/**
 * RPC wrapper around runHealthProbe — for browser callers only. Route
 * handlers must NOT call this (see ./healthProbe.ts header). Unauthenticated
 * by design: monitors may call it with no session and no cookie.
 */
export const healthCheckFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<HealthReport> => runHealthProbe(),
);
