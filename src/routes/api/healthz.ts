/**
 * GET /api/healthz — app-owned alias of GET /healthz.
 *
 * WHY THIS EXISTS: on the production hosting the platform proxy answers
 * GET /healthz itself (plain-text "OK") before the request reaches the app,
 * so the real JSON probe can never be observed on the public URL. This alias
 * serves the IDENTICAL handler — same plain health probe, no auth, 503 on db
 * failure — at a path the proxy does not shadow, so uptime monitors and the
 * smoke suite (scripts/test-smoke.ts) can always probe the app's actual
 * health. /healthz stays as-is for the platform's own checks.
 *
 * See src/routes/healthz.ts for the full contract:
 *   200 { ok: true,  db: true,  uptimeSec, timestamp } — database answered
 *   503 { ok: false, db: false, uptimeSec, timestamp } — probe failed/timed out
 *   405 for non-GET. Opaque body; Cache-Control: no-store.
 *
 * PROBE CALL PATH (prod-500 postmortem): calls the PLAIN `runHealthProbe()`
 * directly — never the `healthCheckFn` RPC wrapper, which in the production
 * build compiles to an HTTP self-call (createSsrRpc) that 500s here.
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
      message: "Use GET — /api/healthz is a liveness probe.",
    },
    { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } },
  );
}

export const Route = createFileRoute("/api/healthz")({
  server: {
    handlers: {
      GET: () => handleGet(),
      POST: () => methodNotAllowed(),
      PUT: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
});
