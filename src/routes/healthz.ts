/**
 * GET /healthz — unauthenticated liveness/readiness endpoint (Phase 3
 * reliability pass).
 *
 * Contract:
 *   200 { ok: true,  db: true,  uptimeSec, timestamp } — database answered
 *   503 { ok: false, db: false, uptimeSec, timestamp } — probe failed/timed out
 *
 * Deliberately NO auth/session: uptime monitors and load balancers call it
 * anonymously. Deliberately OPAQUE: the body never carries error text,
 * connection strings, or stack traces — only the boolean db bit.
 *
 * PROBE CALL PATH (prod-500 postmortem): this handler calls the PLAIN
 * `runHealthProbe()` from ~/lib/server/healthProbe.ts directly. It must NOT
 * call the `healthCheckFn` RPC wrapper — in the production build that compiles
 * to an HTTP self-call (createSsrRpc) which 500s behind the hosting proxy.
 * All server logic — the `SELECT 1` probe, timeout, error swallowing — lives
 * in ~/lib/server/healthProbe.ts; this file is a thin shim that maps the
 * report onto HTTP status codes. Method routing is
 * honest: non-GET is 405, never a silent 200 (webhook convention).
 */
import { createFileRoute } from "@tanstack/react-router";
import { runHealthProbe } from "~/lib/server/healthProbe";

async function handleGet(): Promise<Response> {
  const report = await runHealthProbe();
  return Response.json(report, {
    status: report.ok ? 200 : 503,
    // Health answers must never be cached — a monitor polls for the truth.
    headers: { "Cache-Control": "no-store" },
  });
}

function methodNotAllowed(): Response {
  return Response.json(
    {
      error: "method_not_allowed",
      message: "Use GET — /healthz is a liveness probe.",
    },
    { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } },
  );
}

export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: () => handleGet(),
      POST: () => methodNotAllowed(),
      PUT: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
});
