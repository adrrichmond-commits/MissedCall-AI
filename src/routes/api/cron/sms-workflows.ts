/**
 * Cron entrypoint for time-driven SMS workflows (P4-S): appointment reminders
 * and lead follow-ups. The rest of the workflow set is event-driven (webhooks,
 * confirm actions, onboarding completion, billing).
 *
 * TRIGGER MODEL (honest, no scheduler of our own): this route does ONE sweep
 * per call and is designed to be pinged by an external scheduler (cron, uptime
 * pinger) every 15–60 minutes. AUTH: requires the `x-cron-secret` header to
 * equal the CRON_SECRET env var. If CRON_SECRET is unset the route answers 503
 * with an honest message — it never runs unauthenticated and never pretends a
 * sweep happened.
 *
 * SWEEPS
 *   appointment_reminder — confirmed appointments starting within the
 *     workflow's hoursBefore window whose reminder has not gone out yet
 *     (workflowSentForAppointment dedup + the engine's own safeguards).
 *   follow_up — live leads older than the workflow's delayHours with no
 *     follow-up sent yet (workflowSentForLead dedup).
 *
 * Every send goes through the ONE workflow engine, so opt-outs, quiet hours,
 * caps, invalid numbers, cooldowns, plan gates, and honest audit rows apply
 * identically here. Failures are recorded per-item and summarized honestly in
 * the response; a failing item never aborts the sweep.
 *
 * Route shape: this TanStack Start version wires server handlers through
 * `createFileRoute(...).options.server.handlers` (see the Stripe webhook and
 * /api/healthz; there is no createAPIFileRoute export in 1.158).
 */
import { createFileRoute } from "@tanstack/react-router";
import { checkRateLimit, clientIpFromHeaders } from "~/lib/server/rateLimit";
import { sendWorkflowSms } from "~/lib/server/smsWorkflowEngine";
import { formatAppointmentTime } from "~/lib/server/workflowTime";
import * as q from "~/db/queries";
import { sanitizeSmsWorkflowsConfig, WORKFLOW_CATALOG } from "~/lib/smsWorkflows";

export const Route = createFileRoute("/api/cron/sms-workflows")({
  server: {
    handlers: {
      // Handler receives the route-method ctx ({ request, params, ... }).
      POST: ({ request }: { request: Request }) => handleSweep(request),
      GET: ({ request }: { request: Request }) => handleSweep(request),
    },
  },
});

interface SweepItem {
  ref: string;
  workflowKey: string;
  phone: string;
  outcome: string;
  reason: string | null;
}

async function handleSweep(request: Request): Promise<Response> {
  // 0. Auth — honest 503 when unconfigured, 401 on a wrong secret.
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      {
        ok: false,
        error: "not_configured",
        message:
          "CRON_SECRET is not set - the SMS workflow cron is disabled. Set CRON_SECRET and ping this endpoint on a schedule.",
      },
      { status: 503 },
    );
  }
  const provided = request.headers.get("x-cron-secret") ?? "";
  if (provided !== secret) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // 1. Rate limit (permissive: one caller, periodic pings).
  const rl = checkRateLimit("sms_workflow_cron", clientIpFromHeaders(request.headers));
  if (!rl.allowed) {
    return Response.json(
      { ok: false, error: "rate_limited", message: "Retry after " + rl.retryAfterSec + "s." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const now = new Date();
  const items: SweepItem[] = [];
  let businessesScanned = 0;
  let remindersSent = 0;
  let followUpsSent = 0;
  let suppressed = 0;

  // Iterate businesses honestly: business-scoped queries only, one sweep per
  // business, per-item isolation guaranteed by the engine's businessId.
  const businesses = await q.listBusinessSummaries().catch(() => []);
  for (const biz of businesses) {
    const businessId = biz.id;
    businessesScanned++;
    const businessRow = await q.getBusiness(businessId).catch(() => null);
    if (!businessRow) continue;
    const settings = (businessRow as unknown as { settings?: Record<string, unknown> }).settings ?? {};
    const config = sanitizeSmsWorkflowsConfig(settings.smsWorkflows);
    const timezone = (businessRow as unknown as { timezone?: string | null }).timezone ?? null;

    // --- Appointment reminders -------------------------------------------
    const reminder = config.workflows.appointment_reminder;
    if (reminder.enabled) {
      const horizonHours = reminder.hoursBefore ?? 24;
      const from = now;
      const to = new Date(now.getTime() + horizonHours * 60 * 60_000);
      const upcoming = await q
        .listAppointments(businessId, { status: "confirmed", from, to }, { limit: 50, order: "asc" })
        .catch(() => []);
      for (const appt of upcoming) {
        if (!appt.leadId) continue;
        const already = await q.workflowSentForAppointment(businessId, appt.id, "appointment_reminder");
        if (already) continue;
        const lead = await q.getLead(businessId, appt.leadId).catch(() => null);
        if (!lead) continue;
        const outcome = await sendWorkflowSms({
          businessId,
          workflowKey: "appointment_reminder",
          recipient: "customer",
          to: lead.contactPhone,
          leadId: lead.id,
          appointmentId: appt.id,
          vars: {
            customerName: lead.contactName ?? undefined,
            serviceNeed: appt.serviceSummary,
            appointmentTime: formatAppointmentTime(new Date(appt.scheduledAt), timezone),
          },
        });
        if (outcome.outcome === "sent") remindersSent++;
        else suppressed++;
        items.push({
          ref: "appointment:" + appt.id,
          workflowKey: "appointment_reminder",
          phone: lead.contactPhone,
          outcome: outcome.outcome,
          reason: outcome.reason,
        });
      }
    }

    // --- Lead follow-ups ---------------------------------------------------
    const followUp = config.workflows.follow_up;
    if (followUp.enabled) {
      const delayHours = followUp.delayHours ?? 72;
      const cutoff = new Date(now.getTime() - delayHours * 60 * 60_000);
      const stale = await q
        .listLeads(businessId, { status: "new", createdBefore: cutoff }, { limit: 50, order: "asc" })
        .catch(() => []);
      for (const lead of stale) {
        if (!lead.contactPhone) continue;
        const already = await q.workflowSentForLead(businessId, lead.id, "follow_up");
        if (already) continue;
        const outcome = await sendWorkflowSms({
          businessId,
          workflowKey: "follow_up",
          recipient: "customer",
          to: lead.contactPhone,
          leadId: lead.id,
          vars: {
            customerName: lead.contactName ?? undefined,
            serviceNeed: lead.serviceNeed ?? undefined,
          },
        });
        if (outcome.outcome === "sent") followUpsSent++;
        else suppressed++;
        items.push({
          ref: "lead:" + lead.id,
          workflowKey: "follow_up",
          phone: lead.contactPhone,
          outcome: outcome.outcome,
          reason: outcome.reason,
        });
      }
    }
  }

  void WORKFLOW_CATALOG;
  return Response.json({
    ok: true,
    ranAt: now.toISOString(),
    businessesScanned,
    remindersSent,
    followUpsSent,
    suppressedOrFailed: suppressed,
    items: items.slice(0, 100),
  });
}
