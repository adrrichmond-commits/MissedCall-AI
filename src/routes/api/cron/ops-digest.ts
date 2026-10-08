/**
 * Cron entrypoint for the WEEKLY OPS DIGEST: the honest state of the
 * business (trials, leads, appointments, attention items, phone-line
 * rollup) delivered to the platform owner's in-app feed + inbox once a
 * week, so the dashboard becomes optional, not required.
 *
 * Same contract as /api/cron/performance-digest: ONE sweep per call,
 * designed to be pinged by an external scheduler (the existing CRON_SECRET
 * pattern — see .github/workflows/cron-ops-digest.yml, weekly Monday
 * 06:17 UTC).
 * AUTH: requires the `x-cron-secret` header to equal the CRON_SECRET env var.
 * If CRON_SECRET is unset the route answers 503 with an honest message — it
 * never runs unauthenticated and never pretends a digest happened.
 *
 * HONEST SKIPS: no platform admin user, an already-digested period, or an
 * unconfigured email provider are NORMAL outcomes — the response summarizes
 * exactly what was delivered and what was skipped (a ping that delivers
 * nothing never pretends otherwise; every zero is a real zero).
 *
 * Route shape: this TanStack Start version wires server handlers through
 * `createFileRoute(...).options.server.handlers` (same as the other cron
 * routes).
 */
import { createFileRoute } from "@tanstack/react-router";
import { checkRateLimit, clientIpFromHeaders } from "~/lib/server/rateLimit";
import { runWeeklyOpsDigest } from "~/lib/server/opsDigestSweep";

export const Route = createFileRoute("/api/cron/ops-digest")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) => handleOpsDigest(request),
      GET: ({ request }: { request: Request }) => handleOpsDigest(request),
    },
  },
});

async function handleOpsDigest(request: Request): Promise<Response> {
  // 0. Auth — honest 503 when unconfigured, 401 on a wrong secret.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      {
        ok: false,
        error: "not_configured",
        message:
          "CRON_SECRET is not set - the weekly ops digest cron is disabled. Set CRON_SECRET and ping this endpoint on a schedule.",
      },
      { status: 503 },
    );
  }
  const provided = request.headers.get("x-cron-secret") ?? "";
  if (provided !== secret) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // 1. Rate limit (permissive: one caller, weekly ping).
  const rl = checkRateLimit("ops_digest_cron", clientIpFromHeaders(request.headers));
  if (!rl.allowed) {
    return Response.json(
      { ok: false, error: "rate_limited", message: "Retry after " + rl.retryAfterSec + "s." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }
  const result = await runWeeklyOpsDigest(new Date());
  return Response.json({ ok: true, ...result });
}
