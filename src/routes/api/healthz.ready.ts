/**
 * Deep readiness probe — GET /api/healthz/ready (P4-I, owner req. 18/20).
 *
 * Companion to /api/healthz (liveness): answers 200 only when the DB is
 * reachable AND every critical table exists (migrations current). The JSON
 * payload adds the recent system_errors count (trailing hour) so an external
 * uptime monitor can also alert on a degraded-but-up app. Unauthenticated
 * by design (monitors have no session); the payload carries counts/booleans
 * only — never error text, rows, or connection details. Never cached.
 *
 * Route shape: createFileRoute(...).options.server.handlers (same as
 * healthz.ts; plain probe import, never the RPC wrapper — see healthProbe.ts
 * for the prod-build postmortem behind that rule).
 */
import { createFileRoute } from "@tanstack/react-router";
import { runReadinessProbe } from "~/lib/server/healthProbe";
async function handleGet(): Promise<Response> {
  const report = await runReadinessProbe();
  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
function methodNotAllowed(): Response {
  return Response.json(
    { error: "method_not_allowed", message: "Use GET — /api/healthz/ready is a readiness probe." },
    { status: 405, headers: { Allow: "GET", "Cache-Control": "no-store" } },
  );
}
export const Route = createFileRoute("/api/healthz/ready")({
  server: {
    handlers: {
      GET: () => handleGet(),
      POST: () => methodNotAllowed(),
      PUT: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
});
