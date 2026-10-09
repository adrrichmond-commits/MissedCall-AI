#!/usr/bin/env bun
/**
 * Unit tests for the transactional email pre-wire (Phase 2 build #6).
 * Run: bun scripts/test-email.ts — no DB, no network, no real provider keys.
 *
 * Covers: config gating (missing key → not configured, honest error), the
 * sendEmail request/response contract against a stubbed provider (fetch
 * monkey-patch — no network), provider rejections (non-2xx → EmailSendError
 * with the provider's own message), html/text variants, from-address
 * formatting, the local rate gate, and the fire-and-forget notification
 * delivery hook (deliverNotificationEmail / queueNotificationEmail) against
 * an in-memory store mirroring the Neon queries' semantics:
 *   - email_sent_at (the double-send guard) is stamped ONLY on success,
 *   - skipped honestly when unconfigured / no recipient / already sent,
 *   - the caller is NEVER blocked or thrown into.
 *
 * No database is used: the store seam (src/lib/server/emailDelivery.ts) is
 * stubbed in-memory, exactly like the Stripe tests' StripeEventStore seam.
 */
import {
  EmailNotConfiguredError,
  EmailSendError,
  resetEmailRateGateForTests,
  isEmailConfigured,
  logEmailStatus,
  readEmailConfig,
  sendEmail,
} from "../src/lib/server/email";
import {
  deliverNotificationEmail,
  queueNotificationEmail,
  type NotificationEmailStore,
} from "../src/lib/server/emailDelivery";
import { EMAIL_DELIVERY_TYPES } from "../src/db/queries/notifications";

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log("FAIL " + name + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  } else {
    console.log("ok   " + name);
  }
}

// --- Fetch seam (monkey-patch global fetch, like the provider boundary) -------
const realFetch = globalThis.fetch;
type RecordedRequest = { url: string; method: string; headers: Record<string, string>; body: string };
let requests: RecordedRequest[] = [];

function jsonHandler(response: { status: number; body: unknown }, failNetwork = false) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k] = v;
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (failNetwork) throw new Error("ECONNREFUSED 127.0.0.1");
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function stubFetch(response: { status: number; body: unknown } | null, failNetwork = false): void {
  globalThis.fetch = (response === null
    ? async () => {
        throw new Error("no fetch expected");
      }
    : jsonHandler(response, failNetwork)) as typeof fetch;
  if (failNetwork) {
    // Still record the attempt so call-count assertions work.
    const inner = (globalThis.fetch as unknown as (i: string | URL | Request, r?: RequestInit) => Promise<Response>);
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k] = v;
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? init.body : "",
      });
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    void inner;
  }
}

function uninstallFetch(): void {
  globalThis.fetch = realFetch;
  requests = [];
  resetEmailRateGateForTests();
}

// --- Config gating (forced-clean env) -----------------------------------------
// This suite tests the RESEND-STYLE FALLBACK transport in isolation, so the
// KNOCK_* vars (which take precedence over EMAIL_* when set — e.g. in this
// machine's shell where the owner's real Knock key lives) are pinned off for
// the whole run. Knock's own transport has scripts/test-knock.ts.
delete process.env.KNOCK_API_KEY;
delete process.env.KNOCK_WORKFLOW_KEY;
delete process.env.KNOCK_API_BASE;
delete process.env.EMAIL_API_KEY;
delete process.env.EMAIL_FROM;
delete process.env.EMAIL_API_BASE;
delete process.env.EMAIL_PROVIDER;
check("unconfigured: readEmailConfig null", readEmailConfig(), null);
check("unconfigured: isEmailConfigured false", isEmailConfigured(), false);
let threw: Error | null = null;
try {
  await sendEmail({ to: "x@example.com", subject: "s", text: "t" });
} catch (e) {
  threw = e as Error;
}
check("unconfigured: sendEmail throws EmailNotConfiguredError", threw instanceof EmailNotConfiguredError, true);
check("unconfigured: error is typed by name", threw?.name, "EmailNotConfiguredError");
check("unconfigured: message names the env vars", (threw?.message ?? "").includes("EMAIL_API_KEY"), true);

// Log lines are honest about the disabled state.
{
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  logEmailStatus();
  console.log = origLog;
  check(
    "logEmailStatus: unconfigured line says disabled + names vars",
    lines.some((l) => l.includes("[email] not configured") && l.includes("EMAIL_API_KEY")),
    true,
  );
}

process.env.EMAIL_API_KEY = "re_test_unit_key";
process.env.EMAIL_FROM = "MissedCall AI <notifications@missedcall.ai>";
const config = readEmailConfig();
check("configured: reads key + from", config !== null && config.apiKey === "re_test_unit_key" && config.from === "MissedCall AI <notifications@missedcall.ai>", true);
check("configured: default API base is the provider endpoint", config?.apiBase, "https://api.resend.com");
process.env.EMAIL_API_BASE = "https://email.example.com/api";
check("configured: EMAIL_API_BASE override respected", readEmailConfig()?.apiBase, "https://email.example.com/api");
delete process.env.EMAIL_API_BASE;
check("configured: isEmailConfigured true", isEmailConfigured(), true);
{
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  logEmailStatus();
  console.log = origLog;
  check(
    "logEmailStatus: configured line says enabled",
    lines.some((l) => l.includes("[email]") && l.includes("configured - outbound email enabled")),
    true,
  );
}

// --- sendEmail success shape (stubbed provider) --------------------------------
const SEND_BODY = {
  id: "email_id_123",
  status: "queued",
};
stubFetch({ status: 200, body: SEND_BODY });
const sent = await sendEmail({
  to: "owner@rapidrooter.example",
  subject: "New lead",
  text: "plain body",
  html: "<p>html body</p>",
});
check("send: returns provider id + status", { id: sent.id, status: sent.status }, { id: "email_id_123", status: "queued" });
check("send: echoes to + configured from", { to: sent.to, from: sent.from }, { to: "owner@rapidrooter.example", from: "MissedCall AI <notifications@missedcall.ai>" });
check("send: exactly one provider request", requests.length, 1);
check("send: POST to {base}/emails", { method: requests[0]?.method, url: requests[0]?.url }, { method: "POST", url: "https://api.resend.com/emails" });
check("send: Bearer auth from EMAIL_API_KEY", requests[0]?.headers["Authorization"], "Bearer re_test_unit_key");
const okBody = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
check("send: from = EMAIL_FROM verbatim (display-name form)", okBody.from, "MissedCall AI <notifications@missedcall.ai>");
check("send: to wrapped as [address]", okBody.to, ["owner@rapidrooter.example"]);
check("send: subject + text present", { subject: okBody.subject, text: okBody.text }, { subject: "New lead", text: "plain body" });
check("send: html included when provided", okBody.html, "<p>html body</p>");

// Text-only variant omits html entirely.
requests = [];
stubFetch({ status: 200, body: { id: "email_id_456" } });
const textOnly = await sendEmail({ to: "owner2@rapidrooter.example", subject: "s2", text: "t2" });
check("send: text-only accepted, id present", textOnly.id, "email_id_456");
check("send: text-only body omits html key", "html" in (JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>), false);

// Status defaults to "sent" when the provider omits it.
requests = [];
stubFetch({ status: 200, body: { id: "email_id_789" } });
const defaulted = await sendEmail({ to: "owner3@rapidrooter.example", subject: "s3", text: "t3" });
check("send: status defaults to sent when provider omits it", defaulted.status, "sent");

// --- Provider rejection + malformed responses ----------------------------------
requests = [];
stubFetch({ status: 422, body: { message: "The 'to' address is invalid.", name: "validation_error" } });
let sendErr: Error | null = null;
try {
  await sendEmail({ to: "bad@", subject: "s", text: "t" });
} catch (e) {
  sendErr = e as Error;
}
check("non-2xx: throws EmailSendError", sendErr instanceof EmailSendError, true);
check("non-2xx: carries the provider's own message", (sendErr as EmailSendError | null)?.message?.includes("The 'to' address is invalid"), true);
check("non-2xx: provider code + http status preserved", { code: (sendErr as EmailSendError | null)?.providerCode, status: (sendErr as EmailSendError | null)?.httpStatus }, { code: "validation_error", status: 422 });

requests = [];
stubFetch({ status: 500, body: { message: "internal provider failure" } });
sendErr = null;
try {
  await sendEmail({ to: "owner4@rapidrooter.example", subject: "s", text: "t" });
} catch (e) {
  sendErr = e as Error;
}
check("5xx: EmailSendError with provider message", sendErr instanceof EmailSendError && (sendErr.message.includes("internal provider failure")), true);
check("5xx: http status 500", (sendErr as EmailSendError | null)?.httpStatus, 500);

// Malformed JSON body → honest error, never a fake success.
requests = [];
globalThis.fetch = (async () => new Response("<html>gateway timeout</html>", { status: 504 })) as typeof fetch;
sendErr = null;
try {
  await sendEmail({ to: "owner5@rapidrooter.example", subject: "s", text: "t" });
} catch (e) {
  sendErr = e as Error;
}
check("malformed body: EmailSendError (gateway 504)", sendErr instanceof EmailSendError && (sendErr as EmailSendError).httpStatus === 504, true);

// 2xx without a message id is NOT a success.
requests = [];
stubFetch({ status: 200, body: { status: "ok" } });
sendErr = null;
try {
  await sendEmail({ to: "owner6@rapidrooter.example", subject: "s", text: "t" });
} catch (e) {
  sendErr = e as Error;
}
check("2xx missing id: EmailSendError, no fake success", sendErr instanceof EmailSendError && (sendErr.message.includes("missing message id")), true);

// Network failure.
requests = [];
stubFetch(null, true);
sendErr = null;
try {
  await sendEmail({ to: "owner7@rapidrooter.example", subject: "s", text: "t" });
} catch (e) {
  sendErr = e as Error;
}
check("network error: EmailSendError with status 0", { inst: sendErr instanceof EmailSendError, status: (sendErr as EmailSendError | null)?.httpStatus }, { inst: true, status: 0 });

// --- Local rate gate ------------------------------------------------------------
resetEmailRateGateForTests();
requests = [];
stubFetch({ status: 200, body: { id: "email_rate_1" } });
await sendEmail({ to: "same@example.com", subject: "s", text: "t" });
let rateErr: Error | null = null;
try {
  await sendEmail({ to: "same@example.com", subject: "s", text: "t" });
} catch (e) {
  rateErr = e as Error;
}
check("rate gate: second immediate send to same recipient rejected", { inst: rateErr instanceof EmailSendError, code: (rateErr as EmailSendError | null)?.providerCode }, { inst: true, code: "rate_limited" });
uninstallFetch();

// --- Hook: deliverNotificationEmail against an in-memory store ------------------
interface MemState {
  emailed: Map<string, boolean>;
  stampCalls: number;
  guardCalls: number;
  ownerEmail: string | null;
  businessName: string;
}
function makeStore(overrides: Partial<MemState> = {}): { state: MemState; store: NotificationEmailStore } {
  const state: MemState = {
    emailed: new Map(),
    stampCalls: 0,
    guardCalls: 0,
    ownerEmail: "owner@rapidrooter.example",
    businessName: "Rapid Rooter Plumbing",
    ...overrides,
  };
  const store: NotificationEmailStore = {
    async isNotificationEmailed(businessId, notificationId) {
      state.guardCalls++;
      return state.emailed.get(businessId + ":" + notificationId) ?? false;
    },
    async markNotificationEmailed(businessId, notificationId) {
      state.stampCalls++;
      const key = businessId + ":" + notificationId;
      if (state.emailed.get(key)) return false;
      state.emailed.set(key, true);
      return true;
    },
    async getBusinessOwnerEmail() {
      return state.ownerEmail;
    },
    async getBusinessName() {
      return state.businessName;
    },
  };
  return { state, store };
}
const ARGS = {
  businessId: "biz-1",
  notificationId: "notif-1",
  type: "new_lead" as const,
  payload: { leadName: "Dana Reyes", serviceNeed: "Burst pipe" },
};

// Wrong type → skipped before anything else.
stubFetch({ status: 200, body: { id: "nope" } });
{
  const { state, store } = makeStore();
  const r = await deliverNotificationEmail({ ...ARGS, type: "lead_booked", store });
  check("hook: in-app-only type skipped", r.outcome, "skipped_type");
  check("hook: skipped type makes no provider call", requests.length, 0);
  check("hook: skipped type never stamps email_sent_at", state.stampCalls, 0);
}
uninstallFetch();

// Unconfigured → silent skip, no store writes at all.
delete process.env.EMAIL_API_KEY;
{
  const { state, store } = makeStore();
  const r = await deliverNotificationEmail({ ...ARGS, store });
  check("hook: unconfigured provider skipped honestly", r.outcome, "skipped_not_configured");
  check("hook: unconfigured makes no store writes", { stamp: state.stampCalls, guard: state.guardCalls }, { stamp: 0, guard: 0 });
}
process.env.EMAIL_API_KEY = "re_test_unit_key";

// Success path: email sent, email_sent_at stamped exactly once.
stubFetch({ status: 200, body: { id: "email_hook_1", status: "queued" } });
{
  const { state, store } = makeStore();
  const r = await deliverNotificationEmail({ ...ARGS, store });
  check("hook: success outcome sent with provider id", { outcome: r.outcome, emailId: r.emailId }, { outcome: "sent", emailId: "email_hook_1" });
  check("hook: success stamps email_sent_at (once)", state.stampCalls, 1);
  check("hook: success makes exactly one provider call", requests.length, 1);
  check("hook: email addressed to the owner", (JSON.parse(requests[0]?.body ?? "{}") as { to?: string[] }).to?.[0], "owner@rapidrooter.example");
  const body = JSON.parse(requests[0]?.body ?? "{}") as { text?: string; subject?: string };
  check("hook: subject names the business", (body.subject ?? "").includes("Rapid Rooter Plumbing"), true);
  check("hook: text includes lead details", (body.text ?? "").includes("Dana Reyes") && (body.text ?? "").includes("Burst pipe"), true);
}
uninstallFetch();

// Double-send guard: already-stamped notification is never re-sent.
stubFetch({ status: 200, body: { id: "email_hook_dup" } });
{
  const { state, store } = makeStore();
  state.emailed.set("biz-1:notif-1", true);
  const r = await deliverNotificationEmail({ ...ARGS, store });
  check("hook: already-sent notification skipped (no double send)", r.outcome, "skipped_duplicate");
  check("hook: duplicate sends nothing", requests.length, 0);
  check("hook: duplicate stamps nothing", state.stampCalls, 0);
}
uninstallFetch();

// No recipient → skip, no send.
stubFetch({ status: 200, body: { id: "email_hook_norecip" } });
{
  const { state, store } = makeStore({ ownerEmail: null });
  const r = await deliverNotificationEmail({ ...ARGS, store });
  check("hook: no owner email skipped", r.outcome, "skipped_no_recipient");
  check("hook: no recipient → no provider call, no stamp", { calls: requests.length, stamps: state.stampCalls }, { calls: 0, stamps: 0 });
}
uninstallFetch();

// Provider failure → outcome failed, email_sent_at NOT stamped, no throw.
stubFetch({ status: 502, body: { message: "upstream unavailable" } });
{
  const { state, store } = makeStore();
  const r = await deliverNotificationEmail({ ...ARGS, store });
  check("hook: provider failure reported honestly", r.outcome, "failed");
  check("hook: failure detail carries provider message", (r.detail ?? "").includes("upstream unavailable"), true);
  check("hook: failure never stamps email_sent_at", state.stampCalls, 0);
  check("hook: provider failure never throws into the caller", true, true);
}
uninstallFetch();

// Store crash (e.g. DB down) → failed outcome, still never throws.
{
  const { store } = makeStore();
  const brokenStore: NotificationEmailStore = {
    ...store,
    isNotificationEmailed: async () => {
      throw new Error("db down");
    },
  };
  const r = await deliverNotificationEmail({ ...ARGS, store: brokenStore });
  check("hook: store crash becomes failed outcome, caller unblocked", r.outcome, "failed");
  check("hook: store crash detail is honest", (r.detail ?? "").includes("db down"), true);
}

// queueNotificationEmail: fire-and-forget — returns immediately, delivers in
// the background, and NEVER throws (even when the store explodes afterwards).
stubFetch({ status: 200, body: { id: "email_queue_1" } });
{
  const { state, store } = makeStore();
  let uncaught: unknown = null;
  const handler = (e: unknown) => {
    uncaught = e;
  };
  process.on("unhandledRejection", handler);
  const returned = queueNotificationEmail({ ...ARGS, notificationId: "notif-q", store });
  check("queue: returns synchronously (fire-and-forget)", returned, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  check("queue: background delivery happened", { sends: requests.length, stamped: state.emailed.get("biz-1:notif-q") ?? false }, { sends: 1, stamped: true });
  check("queue: no unhandled rejection", uncaught, null);
  process.off("unhandledRejection", handler);
}
uninstallFetch();

// Deliverable types: the three business-critical ones + the P5-5 opt-in
// performance digest (emailDelivery gained a performance_digest subject/body
// in PR #43 but this pin was never widened — CI has been red since). Pin the
// exact set: a new deliverable type must update this list deliberately.
check(
  "hook: deliverable types are new_lead + appointment_requested + payment_failed + performance_digest",
  [...EMAIL_DELIVERY_TYPES].sort(),
  ["appointment_requested", "new_lead", "payment_failed", "performance_digest"],
);

// ---------------------------------------------------------------------------
// Auth token email delivery (audit fix CRITICAL #1, 2026-10-09).
//
// The regression this closes: verification/reset links used to go ONLY to
// server logs (logDeliveryLink) — raw tokens in logs + locked-out pilots.
// These checks pin the replacement:
//   - the configured path rides the SAME transport as every other email
//     (stubbed here; the Knock request shape is proven by the Knock suite),
//   - the unconfigured path is an HONEST skip with an explicit warning,
//   - a raw token NEVER appears in ANY captured log line on ANY path.
// ---------------------------------------------------------------------------
import {
  buildAuthEmailPath,
  buildAuthEmailSubject,
  buildAuthEmailText,
  deliverAuthEmail,
  formatAuthEmailExpiry,
  type AuthEmailTransport,
} from "../src/lib/server/authEmailDelivery";

/** Capture every console line emitted while `fn` runs, then restore. */
async function captureConsole(fn: () => Promise<unknown>): Promise<{ lines: string[]; result: unknown }> {
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = push; console.warn = push; console.error = push; console.info = push;
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    console.log = orig.log; console.warn = orig.warn; console.error = orig.error; console.info = orig.info;
  }
}

/** Boolean-flavored check (this suite predates checkTrue; defined locally). */
function checkTrue(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  } else {
    console.log("ok   " + name);
  }
}

const TOKEN = "RAWTOKEN-audit-fix-do-not-log-8f3b9c";
const ORIGIN = "https://www.answermissedcalls.com";
const VERIFY_TTL = 24 * 60 * 60 * 1000;
const RESET_TTL = 60 * 60 * 1000;
const neverConfigured: AuthEmailTransport = { isConfigured: () => false, label: () => null, send: async () => { throw new Error("should not be called"); } };
const boomTransport: AuthEmailTransport = { isConfigured: () => true, label: () => "stub", send: async () => { throw new Error("provider rejected: 503"); } };

// Builders: minimal, truthful content (brand, purpose, expiry, link).
check("authEmail: paths map to the token routes", buildAuthEmailPath("email-verification") + "|" + buildAuthEmailPath("password-reset"), "/verify-email|/reset-password");
check("authEmail: subjects name the purpose + brand", buildAuthEmailSubject("email-verification") + "|" + buildAuthEmailSubject("password-reset"), "Verify your email for MissedCall AI|Reset your MissedCall AI password");
check("authEmail: expiry formatting from the token TTLs", formatAuthEmailExpiry(VERIFY_TTL) + "|" + formatAuthEmailExpiry(RESET_TTL), "24 hours|1 hour");
{
  const verifyText = buildAuthEmailText("email-verification", ORIGIN + "/verify-email?token=" + TOKEN, VERIFY_TTL);
  const resetText = buildAuthEmailText("password-reset", ORIGIN + "/reset-password?token=" + TOKEN, RESET_TTL);
  checkTrue("authEmail: verification body carries brand, link, expiry, ignore-branch", verifyText.includes("MissedCall AI") && verifyText.includes("/verify-email?token=") && verifyText.includes("expires in 24 hours") && verifyText.includes("didn't create this account"));
  checkTrue("authEmail: reset body carries link, expiry, ignore-branch", resetText.includes("/reset-password?token=") && resetText.includes("expires in 1 hour") && resetText.includes("password stays unchanged"));
}

// 1. NOT configured → honest skip with an explicit warning, NO token anywhere.
{
  const { lines, result } = await captureConsole(() =>
    deliverAuthEmail({ kind: "password-reset", to: "owner@example.com", rawToken: TOKEN, ttlMs: RESET_TTL, origin: ORIGIN, transport: neverConfigured }),
  );
  const r = result as Awaited<ReturnType<typeof deliverAuthEmail>>;
  check("authEmail: unconfigured transport → skipped_not_configured (never faked sent)", r.outcome, "skipped_not_configured");
  checkTrue("authEmail: skip warning is explicit about NOT emailing", (r.detail ?? "").includes("no email transport configured") && lines.some((l) => l.includes("NO EMAIL TRANSPORT CONFIGURED") && l.includes("NOT emailed") && l.includes("NOT logged")));
  checkTrue("authEmail: skip warning names the fix (KNOCK_API_KEY)", lines.some((l) => l.includes("KNOCK_API_KEY") && l.includes("EMAIL_API_KEY")));
  checkTrue("authEmail: NO raw token in ANY log line on the skip path", !lines.some((l) => l.includes(TOKEN)));
}

// 2. No request origin → honest skip (a link nobody can open is not a link).
{
  const { lines, result } = await captureConsole(() =>
    deliverAuthEmail({ kind: "email-verification", to: "owner@example.com", rawToken: TOKEN, ttlMs: VERIFY_TTL, origin: null, transport: boomTransport }),
  );
  const r = result as Awaited<ReturnType<typeof deliverAuthEmail>>;
  check("authEmail: no origin → skipped_no_origin", r.outcome, "skipped_no_origin");
  checkTrue("authEmail: no-origin skip NEVER logs the token", !lines.some((l) => l.includes(TOKEN)));
}

// 3. Configured → sent through the transport; the token lives ONLY in the email.
{
  let sentArgs: { to: string; subject: string; text: string } | null = null;
  const okTransport: AuthEmailTransport = {
    isConfigured: () => true,
    label: () => "knock",
    send: async (args) => { sentArgs = args; return { id: "stub-1" }; },
  };
  const { lines, result } = await captureConsole(() =>
    deliverAuthEmail({ kind: "password-reset", to: "owner@example.com", rawToken: TOKEN, ttlMs: RESET_TTL, origin: ORIGIN, transport: okTransport }),
  );
  const r = result as Awaited<ReturnType<typeof deliverAuthEmail>>;
  check("authEmail: configured transport → sent with provider id", { outcome: r.outcome, id: r.emailId }, { outcome: "sent", id: "stub-1" });
  check("authEmail: email addressed to the account holder with the reset subject", { to: sentArgs!.to, subject: sentArgs!.subject }, { to: "owner@example.com", subject: buildAuthEmailSubject("password-reset") });
  checkTrue("authEmail: the token travels ONLY inside the email body (that is its one job)", sentArgs!.text.includes("/reset-password?token=" + encodeURIComponent(TOKEN)));
  checkTrue("authEmail: success log line is token-free", !lines.some((l) => l.includes(TOKEN)));
  checkTrue("authEmail: success log is honest about transport + recipient", lines.some((l) => l.includes("sent to owner@example.com via knock")));
}

// 4. Provider failure → honest failed outcome; still zero tokens in logs.
{
  const { lines, result } = await captureConsole(() =>
    deliverAuthEmail({ kind: "email-verification", to: "owner@example.com", rawToken: TOKEN, ttlMs: VERIFY_TTL, origin: ORIGIN, transport: boomTransport }),
  );
  const r = result as Awaited<ReturnType<typeof deliverAuthEmail>>;
  check("authEmail: provider failure → failed with the provider's own message", { outcome: r.outcome, detail: r.detail }, { outcome: "failed", detail: "provider rejected: 503" });
  checkTrue("authEmail: failure path NEVER reports a send", !lines.some((l) => l.includes("email sent")));
  checkTrue("authEmail: NO raw token in ANY log line on the failure path", !lines.some((l) => l.includes(TOKEN)));
}

// 5. Wiring pins (source greps, p4a pattern): the old log-only path is GONE
//    and all three token flows call the delivery + rate-limit seams.
{
  const { readFileSync } = await import("node:fs");
  const authFns = readFileSync(new URL("../src/lib/server/authFns.ts", import.meta.url), "utf8");
  const delivery = readFileSync(new URL("../src/lib/server/authEmailDelivery.ts", import.meta.url), "utf8");
  const srcTree = readFileSync(new URL("../src/lib/server/rateLimit.ts", import.meta.url), "utf8");
  checkTrue("authEmail: logDeliveryLink is deleted — no raw-token logging path remains", !authFns.includes("logDeliveryLink"));
  checkTrue("authEmail: signup + forgot-password + resend all ride deliverAuthEmail", (authFns.match(/deliverAuthEmail\(/g) ?? []).length === 3);
  checkTrue("authEmail: delivery module never interpolates a token into a log call", !delivery.includes("`") || !/console\.(log|warn|error|info)\([^)]*\$\{/.test(delivery));
  checkTrue("authEmail: token endpoints are rate-limited (verify/reset/resend buckets)", authFns.includes('enforceAuthRateLimit("auth_verify_email")') && authFns.includes('enforceAuthRateLimit("auth_reset_password")') && authFns.includes('enforceAuthRateLimit("auth_resend_verification")'));
  checkTrue("authEmail: the three buckets exist in the ONE rate-limit config", srcTree.includes("auth_verify_email") && srcTree.includes("auth_reset_password") && srcTree.includes("auth_resend_verification"));
}

console.log("\n" + checks + " checks run, " + failures + " failed");
console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
