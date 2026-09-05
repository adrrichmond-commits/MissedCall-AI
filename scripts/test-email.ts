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

// Deliverable types: exactly the three business-critical ones.
check(
  "hook: deliverable types are new_lead + appointment_requested + payment_failed",
  [...EMAIL_DELIVERY_TYPES].sort(),
  ["appointment_requested", "new_lead", "payment_failed"],
);

console.log("\n" + checks + " checks run, " + failures + " failed");
console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
