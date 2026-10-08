/**
 * First-run line self-test — server runner.
 *
 * Runs a signed SYNTHETIC probe through the REAL inbound webhook path for one
 * business and records the outcome where the owner can see it
 * (businesses.settings.lineTest — the settings jsonb blob, no migration):
 *
 *   1. Build a Twilio-shaped inbound SMS payload with From = the business's
 *      OWN alert number on file (settings.smsWorkflows.safeguards.ownerSmsNumber
 *      — real, owned, never a stranger) and To = the business's provisioned
 *      line. Body starts with "SYSTEM TEST" (the established convention) and
 *      is worded so the real classifier treats it as a routine, substantive
 *      service question (see src/lib/lineTest.ts).
 *   2. Sign it with TWILIO_AUTH_TOKEN exactly like genuine inbound traffic is
 *      validated (X-Twilio-Signature over the public request URL — the same
 *      compute the webhook's validator inverts) and POST it to the app's own
 *      webhook endpoint via TWILIO_WEBHOOK_BASE_URL.
 *   3. Poll the DB (bounded, ~90s) for the pipeline outcomes: the probe
 *      message stored (matched by its unique fabricated MessageSid), the AI
 *      reply sent on that thread, the lead for that business, and the
 *      owner-alert notification. Record PASS / PARTIAL / FAIL per
 *      evaluateLineTest() with the evidence ids and the webhook's HTTP status.
 *
 * SAFETY/HONESTY:
 *   - No customer is ever messaged: From must be a phone on file for THAT
 *     business, To is its own provisioned line. Without both, the probe
 *     refuses with an honest "not_configured" — it never guesses a number.
 *   - The probe is one synthetic message; the AI's one reply goes to the
 *     business's own alert phone. Repeat runs are deduped by the pipeline's
 *     own duplicate guard and reported as such (never re-counted as new).
 *   - A terminal status is ALWAYS written, even when the runner throws.
 *   - The auto first-run fires ONCE per business (guarded by the stored
 *     result + an in-process lock), from the dashboard data load, and only
 *     when a line is actually assigned. Demo data never auto-probes.
 */
import { randomUUID } from "node:crypto";
import * as q from "~/db/queries";
import { normalizePhone } from "~/lib/smsCommands";
import {
  LINE_TEST_RUNNING_STALE_MS,
  SYSTEM_TEST_BODY_PREFIX,
  buildLineTestBody,
  buildProbeMessageSid,
  buildProbeParams,
  describeStoredLineTest,
  evaluateLineTest,
  webhookUrlForBase,
  type LineTestObservations,
  type StoredLineTest,
} from "~/lib/lineTest";
import { readSmsConfig } from "./sms";
import { computeTwilioSignature } from "./twilioSignature";

/** Settings-blob key the result lives under (businesses.settings.lineTest). */
const SETTINGS_KEY = "lineTest";

/** Bounded polling: ~90s ceiling, 3s interval — the AI turn typically lands in seconds. */
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_ATTEMPTS = 30;

/** In-process lock so a dashboard-load storm or double-click cannot double-fire. */
const inFlight = new Set<string>();

function businessSettings(business: { settings?: unknown } | null): Record<string, unknown> {
  const s = business?.settings;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

/**
 * The business's own alert number on file — the ONLY From the probe may use.
 * Read defensively from the smsWorkflows safeguards blob; garbage → null and
 * the probe honestly reports it cannot run rather than guessing a number.
 */
export function readOwnerAlertPhone(settings: Record<string, unknown>): string | null {
  const root = settings?.smsWorkflows;
  if (!root || typeof root !== "object") return null;
  const safeguards = (root as Record<string, unknown>).safeguards;
  if (!safeguards || typeof safeguards !== "object") return null;
  const raw = (safeguards as Record<string, unknown>).ownerSmsNumber;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function readStoredLineTest(businessId: string): Promise<StoredLineTest | null> {
  const business = await q.getBusiness(businessId).catch(() => null);
  if (!business) return null;
  return describeStoredLineTest(businessSettings(business)[SETTINGS_KEY]);
}

async function writeLineTest(businessId: string, patch: Record<string, unknown>): Promise<void> {
  const business = await q.getBusiness(businessId).catch(() => null);
  if (!business) return;
  const merged = { ...businessSettings(business), [SETTINGS_KEY]: patch };
  await q.updateBusinessSettings(businessId, merged);
}

/** True while a run is in flight and not yet stale (the UI never renders a stale run as progress). */
export function lineTestRunIsFresh(stored: StoredLineTest | null): boolean {
  if (!stored || stored.status !== "running") return false;
  return Date.now() - Date.parse(stored.startedAt) < LINE_TEST_RUNNING_STALE_MS;
}

/**
 * Fire the self-test for a business (background) and return immediately.
 * Refuses (honest result, no run) when prerequisites are missing:
 * no assigned line, no on-file alert phone, or unconfigured Twilio/webhook.
 */
async function runLineTestForBusiness(businessId: string, trigger: "auto_first_run" | "manual"): Promise<void> {
  if (inFlight.has(businessId)) return;
  inFlight.add(businessId);
  try {
    const business = await q.getBusiness(businessId).catch(() => null);
    if (!business) return;

    // Skip 1: no provisioned line yet — record the honest not-configured state.
    const to = business.phone?.trim() ?? "";
    if (!to) {
      await writeLineTest(businessId, {
        status: "not_configured",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        trigger,
        reason: "No phone number is assigned to this business yet. The line test runs once your number is provisioned.",
      });
      return;
    }

    const settings = businessSettings(business);
    const from = readOwnerAlertPhone(settings);
    if (!from) {
      await writeLineTest(businessId, {
        status: "not_configured",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        trigger,
        reason:
          "No owner alert number is on file (Settings → SMS workflows safeguards), so there is no safe, owned number to send the test from.",
      });
      return;
    }

    const config = readSmsConfig();
    const base = (process.env.TWILIO_WEBHOOK_BASE_URL ?? "").trim();
    if (!config || !base) {
      await writeLineTest(businessId, {
        status: "not_configured",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        trigger,
        reason: !config
          ? "Twilio credentials are not configured, so the webhook cannot be exercised."
          : "The public webhook base URL (TWILIO_WEBHOOK_BASE_URL) is not configured, so the probe has nowhere to POST.",
      });
      return;
    }

    const probeSid = buildProbeMessageSid(randomUUID().replace(/-/g, ""));
    const nonce = Date.now().toString(36) + "-" + probeSid.slice(2, 8);
    const body = buildLineTestBody(nonce);
    const startedAt = new Date();
    const running: StoredLineTest = {
      status: "running",
      startedAt: startedAt.toISOString(),
      trigger,
      probeFrom: from,
      probeTo: to,
      probeMessageSid: probeSid,
    };
    await writeLineTest(businessId, running as unknown as Record<string, unknown>);

    // Sign exactly what we send, against exactly the URL the webhook validates
    // (the configured public base + documented path — candidate #1 in the
    // webhook's candidate list).
    const url = webhookUrlForBase(base);
    const params = buildProbeParams({ messageSid: probeSid, from, to, body });
    const signature = await computeTwilioSignature({ url, params, authToken: config.authToken });

    let httpStatus: number | null = null;
    let snippet = "";
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": signature,
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      httpStatus = res.status;
      const text = await res.text().catch(() => "");
      snippet = text.replace(/\s+/g, " ").trim().slice(0, 200);
    } catch (err) {
      snippet = "POST failed: " + (err instanceof Error ? err.message : String(err));
    }

    if (httpStatus !== 200) {
      const result = evaluateLineTest({
        webhookHttpStatus: httpStatus,
        webhookBodySnippet: snippet,
        inboundMessageId: null,
        conversationId: null,
        conversationHandoff: null,
        aiReplyMessageId: null,
        leadThisRun: null,
        priorLead: null,
        notificationThisRun: null,
        priorNotification: null,
      });
      await finish(businessId, trigger, startedAt, from, to, probeSid, httpStatus, snippet, result, null);
      return;
    }

    // Bounded poll for the pipeline outcomes. All reads are business-scoped.
    const cutoff = startedAt.getTime() - 5_000; // small clock skew allowance
    const fromNormalized = normalizePhone(from) ?? from;
    let observations: LineTestObservations | null = null;
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await sleep(attempt === 0 ? 1_500 : POLL_INTERVAL_MS);
      try {
        observations = await observeOnce(businessId, fromNormalized, probeSid, cutoff);
      } catch {
        observations = null; // transient DB hiccup — keep polling honestly
      }
      const done =
        observations &&
        observations.inboundMessageId !== null &&
        observations.aiReplyMessageId !== null &&
        (observations.leadThisRun !== null || observations.priorLead !== null) &&
        (observations.notificationThisRun !== null || observations.priorNotification !== null);
      if (done) break;
    }
    const o: LineTestObservations =
      observations ??
      {
        webhookHttpStatus: httpStatus,
        webhookBodySnippet: snippet,
        inboundMessageId: null,
        conversationId: null,
        conversationHandoff: null,
        aiReplyMessageId: null,
        leadThisRun: null,
        priorLead: null,
        notificationThisRun: null,
        priorNotification: null,
      };
    o.webhookHttpStatus = httpStatus;
    o.webhookBodySnippet = snippet;
    const result = evaluateLineTest(o);
    await finish(businessId, trigger, startedAt, from, to, probeSid, httpStatus, snippet, result, o.conversationId);
  } catch (err) {
    // A terminal status is always written — the card must never hang on "running".
    await writeLineTest(businessId, {
      status: "fail",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      trigger,
      error: "Runner error: " + (err instanceof Error ? err.message : String(err)),
    }).catch(() => undefined);
  } finally {
    inFlight.delete(businessId);
  }
}

async function finish(
  businessId: string,
  trigger: "auto_first_run" | "manual",
  startedAt: Date,
  from: string,
  to: string,
  probeSid: string,
  httpStatus: number | null,
  snippet: string,
  result: ReturnType<typeof evaluateLineTest>,
  conversationId: string | null,
): Promise<void> {
  const prior = await readStoredLineTest(businessId);
  const patch: StoredLineTest = {
    status: result.status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    trigger,
    probeFrom: from,
    probeTo: to,
    probeMessageSid: probeSid,
    legs: result.legs,
  };
  if (httpStatus !== null) patch.webhookHttpStatus = httpStatus;
  if (snippet) patch.webhookBodySnippet = snippet;
  if (conversationId) patch.conversationId = conversationId;
  if (result.firstBroken) patch.firstBroken = result.firstBroken;
  if (result.status === "pass") patch.lastPassAt = patch.finishedAt;
  else if (prior?.lastPassAt) patch.lastPassAt = prior.lastPassAt;
  await writeLineTest(businessId, patch as unknown as Record<string, unknown>);
}

/** One polling pass over the business-scoped evidence, shaped for evaluateLineTest. */
async function observeOnce(
  businessId: string,
  fromNormalized: string,
  probeSid: string,
  cutoffMs: number,
): Promise<LineTestObservations> {
  const conversation = await q.findOrCreateConversationForPhone(businessId, fromNormalized);
  const messages = await q.listMessages(businessId, conversation.id, { limit: 30, order: "desc" });
  const inbound = messages.find((m) => m.externalId === probeSid) ?? null;
  const aiReply =
    messages.find((m) => {
      if (m.direction !== "outbound") return false;
      const t = m.createdAt instanceof Date ? m.createdAt.getTime() : Date.parse(String(m.createdAt));
      return Number.isFinite(t) && t >= cutoffMs;
    }) ?? null;
  const leadAny = await q.getLatestLeadByPhone(businessId, fromNormalized);
  const leadCreatedMs = leadAny?.createdAt instanceof Date ? leadAny.createdAt.getTime() : Date.parse(String(leadAny?.createdAt ?? ""));
  const leadThisRun = leadAny && Number.isFinite(leadCreatedMs) && leadCreatedMs >= cutoffMs
    ? { id: leadAny.id, createdAt: (leadAny.createdAt instanceof Date ? leadAny.createdAt : new Date(leadCreatedMs)).toISOString() }
    : null;
  const priorLead =
    leadAny && !leadThisRun
      ? {
          id: leadAny.id,
          createdAt: (leadAny.createdAt instanceof Date ? leadAny.createdAt : new Date(leadCreatedMs)).toISOString(),
          description: leadAny.description ?? null,
          linkedToThread: conversation.leadId === leadAny.id,
        }
      : null;

  const notifications = await q.listNotifications(businessId, { limit: 20, order: "desc" });
  const alertTypes = new Set(["new_lead", "takeover_needed"]);
  const inWindow = notifications.filter((n) => {
    if (!alertTypes.has(n.type)) return false;
    const t = n.createdAt instanceof Date ? n.createdAt.getTime() : Date.parse(String(n.createdAt));
    return Number.isFinite(t) && t >= cutoffMs;
  });
  const notificationThisRun =
    (leadThisRun ? inWindow.find((n) => (n.payload as Record<string, unknown> | null)?.leadId === leadThisRun.id) : undefined) ??
    inWindow[0] ??
    null;
  const priorNotification =
    leadAny && !notificationThisRun
      ? (notifications.find(
          (n) => alertTypes.has(n.type) && (n.payload as Record<string, unknown> | null)?.leadId === leadAny.id,
        ) ?? null)
      : null;

  return {
    webhookHttpStatus: null,
    webhookBodySnippet: "",
    inboundMessageId: inbound?.id ?? null,
    conversationId: conversation.id,
    conversationHandoff: conversation.handoffStatus,
    aiReplyMessageId: aiReply?.id ?? null,
    leadThisRun,
    priorLead,
    notificationThisRun: notificationThisRun ? { id: notificationThisRun.id, type: notificationThisRun.type } : null,
    priorNotification: priorNotification
      ? {
          id: priorNotification.id,
          type: priorNotification.type,
          createdAt: (priorNotification.createdAt instanceof Date
            ? priorNotification.createdAt
            : new Date(Date.parse(String(priorNotification.createdAt)))
          ).toISOString(),
        }
      : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owner-triggered run. Refuses while a fresh run is already in flight —
 * the honest "already running" answer, never a silent double-probe.
 */
export async function startLineTestFromOwner(
  businessId: string,
): Promise<{ ok: true } | { ok: false; error: "already_running" }> {
  const stored = await readStoredLineTest(businessId);
  if (lineTestRunIsFresh(stored) || inFlight.has(businessId)) return { ok: false, error: "already_running" };
  void runLineTestForBusiness(businessId, "manual");
  return { ok: true };
}

/**
 * The once-per-business auto hook: fired from the dashboard data load. Runs
 * only when the business has a line assigned, has NEVER recorded a real run,
 * and is not the demo business (sample data never pages anyone). A stored
 * "not_configured" does not block forever — once the missing piece (e.g. the
 * assigned number) appears, the hook retries (throttled to once per hour so a
 * genuinely unconfigured business does not re-probe on every page load).
 * Fire-and-forget: the dashboard render never waits on the ~90s probe.
 */
export async function maybeAutoFirstRunLineTest(businessId: string): Promise<void> {
  try {
    if (inFlight.has(businessId)) return;
    const business = await q.getBusiness(businessId).catch(() => null);
    if (!business || business.isDemo) return;
    if (!business.phone?.trim()) return;
    const existing = describeStoredLineTest(businessSettings(business)[SETTINGS_KEY]);
    if (existing) {
      if (existing.status !== "not_configured") return; // already ran for real
      const startedMs = Date.parse(existing.startedAt);
      if (Number.isFinite(startedMs) && Date.now() - startedMs < 60 * 60 * 1000) return; // throttle re-attempts
    }
    void runLineTestForBusiness(businessId, "auto_first_run");
  } catch {
    // The dashboard must never fail because the probe could not start.
  }
}

/** Exported for the UI read path (appFns) — defensive read of the stored blob. */
export async function readLineTestForBusiness(businessId: string): Promise<StoredLineTest | null> {
  return readStoredLineTest(businessId);
}

/** Re-export so callers can render the honest "stale" distinction. */
export { LINE_TEST_RUNNING_STALE_MS, SYSTEM_TEST_BODY_PREFIX };
