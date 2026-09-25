/**
 * Cron entrypoint for performance digests (P5-5): the daily/weekly "here's
 * what MissedCall AI recovered for you" value notifications.
 *
 * Same contract as /api/cron/sms-workflows: ONE sweep per call, designed to
 * be pinged by an external scheduler (the existing CRON_SECRET pattern).
 * AUTH: requires the `x-cron-secret` header to equal the CRON_SECRET env var.
 * If CRON_SECRET is unset the route answers 503 with an honest message — it
 * never runs unauthenticated and never pretends a sweep happened.
 *
 * ANTI-SPAM: every send decision is made by runPerformanceDigestSweep →
 * digestShouldSend (opt-in config, content gate, minimum interval, period
 * idempotency); delivery flows only through the existing channel gates and
 * the ONE workflow engine. A ping that sends nothing is a NORMAL outcome —
 * the response summarizes honestly what was skipped and why.
 *
 * Route shape: this TanStack Start version wires server handlers through
 * `createFileRoute(...).options.server.handlers` (see /api/cron/sms-workflows).
 */
import { createFileRoute } from "@tanstack/react-router";
import { checkRateLimit, clientIpFromHeaders } from "~/lib/server/rateLimit";
import { runPerformanceDigestSweep } from "~/lib/server/digestSweep";

export const Route = createFileRoute("/api/cron/performance-digest")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) => handleDigestSweep(request),
      GET: ({ request }: { request: Request }) => handleDigestSweep(request),
    },
  },
});

async function handleDigestSweep(request: Request): Promise<Response> {
  // 0. Auth — honest 503 when unconfigured, 401 on a wrong secret.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      {
        ok: false,
        error: "not_configured",
        message:
          "CRON_SECRET is not set - the performance-digest cron is disabled. Set CRON_SECRET and ping this endpoint on a schedule.",
      },
      { status: 503 },
    );
  }
  const provided = request.headers.get("x-cron-secret") ?? "";
  if (provided !== secret) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // 1. Rate limit (permissive: one caller, periodic pings).
  const rl = checkRateLimit("performance_digest_cron", clientIpFromHeaders(request.headers));
  if (!rl.allowed) {
    return Response.json(
      { ok: false, error: "rate_limited", message: "Retry after " + rl.retryAfterSec + "s." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }
  const summary = await runPerformanceDigestSweep(new Date());
  return Response.json({ ok: true, ...summary });
}
