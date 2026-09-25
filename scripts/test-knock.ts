#!/usr/bin/env bun
/**
 * Unit tests for the Knock notification transport (P4 — wire Knock as the
 * email/notification transport).
 * Run: bun scripts/test-knock.ts — no DB, no network, no real provider keys.
 *
 * Covers: Knock config gating (missing key → not configured, honest error),
 * the triggerKnockEmail request/response contract against a stubbed Knock API
 * (fetch monkey-patch — no network), Knock rejections (404 workflow_not_found
 * when the owner has not published the workflow yet → KnockSendError with
 * Knock's own code), the sendEmail TRANSPORT PRECEDENCE seam (Knock primary
 * over the Resend-style EMAIL_* fallback, fallback still works alone, neither
 * → EmailNotConfiguredError), logEmailStatus naming the active transport, and
 * the notification email hook (emailDelivery) end-to-end over the Knock path
 * against an in-memory store: email_sent_at stamped ONLY on provider-accepted
 * triggers, loud-honest failures, never a throw into the caller.
 */
import {
  EmailNotConfiguredError,
  activeEmailTransport,
  isEmailConfigured,
  logEmailStatus,
  resetEmailRateGateForTests,
  sendEmail,
} from "../src/lib/server/email";
import {
  KnockNotConfiguredError,
  KnockSendError,
  readKnockConfig,
  triggerKnockEmail,
} from "../src/lib/server/knock";
import {
  deliverNotificationEmail,
  type NotificationEmailStore,
} from "../src/lib/server/emailDelivery";

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

function captureLog(run: () => void): string[] {
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  run();
  console.log = origLog;
  return lines;
}

// --- Fetch seam (monkey-patch global fetch, like the provider boundary) -------
const realFetch = globalThis.fetch;
type RecordedRequest = { url: string; method: string; headers: Record<string, string>; body: string };
let requests: RecordedRequest[] = [];

function installFetch(
  opts: { status: number; body: unknown; identifyStatus?: number; identifyBody?: unknown } | null,
  failNetwork = false,
): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k] = v;
    requests.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    if (failNetwork) throw new Error("ECONNREFUSED 127.0.0.1");
    // The identify upsert (PUT /v1/users/{id}) is stubbed to succeed by
    // default so the configured status/body exercises the TRIGGER — that is
    // what every error-path test below intends. identifyStatus/identifyBody
    // override it to test identify rejections.
    if ((init?.method ?? "GET") === "PUT" && String(input).includes("/v1/users/")) {
      if (opts === null) throw new Error("no fetch expected");
      return new Response(JSON.stringify(opts?.identifyBody ?? {}), {
        status: opts?.identifyStatus ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (opts === null) throw new Error("no fetch expected");
    return new Response(JSON.stringify(opts.body), {
      status: opts.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function uninstallFetch(): void {
  globalThis.fetch = realFetch;
  requests = [];
  resetEmailRateGateForTests();
}

/** Pin a clean env — no ambient provider keys leak into these assertions. */
function clearEnv(): void {
  delete process.env.KNOCK_API_KEY;
  delete process.env.KNOCK_WORKFLOW_KEY;
  delete process.env.KNOCK_API_BASE;
  delete process.env.EMAIL_API_KEY;
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_API_BASE;
  delete process.env.EMAIL_PROVIDER;
}

// --- Knock config gating -------------------------------------------------------
clearEnv();
check("knock unconfigured: readKnockConfig null", readKnockConfig(), null);
check("knock unconfigured: transport null", activeEmailTransport(), null);
check("knock unconfigured: isEmailConfigured false", isEmailConfigured(), false);
{
  const lines = captureLog(() => logEmailStatus());
  check(
    "logEmailStatus: unconfigured line names all provider vars + disabled",
    lines.some((l) => l.includes("[email] not configured") && l.includes("KNOCK_API_KEY") && l.includes("EMAIL_API_KEY") && l.includes("disabled")),
    true,
  );
}

process.env.KNOCK_API_KEY = "sk_test_unit_key";
const cfg = readKnockConfig();
check("knock configured: reads key", cfg !== null && cfg.apiKey === "sk_test_unit_key", true);
check("knock configured: default workflow key", cfg?.workflowKey, "missedcall-notify");
check("knock configured: default api base", cfg?.apiBase, "https://api.knock.app");
check("knock configured: activeEmailTransport is knock", activeEmailTransport(), "knock");
process.env.KNOCK_WORKFLOW_KEY = "custom-workflow";
process.env.KNOCK_API_BASE = "https://knock.example.com/";
check("knock configured: KNOCK_WORKFLOW_KEY override", readKnockConfig()?.workflowKey, "custom-workflow");
check("knock configured: KNOCK_API_BASE override + trailing slash stripped", readKnockConfig()?.apiBase, "https://knock.example.com");
delete process.env.KNOCK_WORKFLOW_KEY;
delete process.env.KNOCK_API_BASE;
{
  const lines = captureLog(() => logEmailStatus());
  check(
    "logEmailStatus: knock line says enabled + names workflow",
    lines.some((l) => l.includes("[email] knock configured") && l.includes("outbound email enabled") && l.includes("missedcall-notify")),
    true,
  );
}

// --- triggerKnockEmail contract (stubbed Knock API) -----------------------------
// Every trigger now makes TWO requests: the identify upsert (PUT
// /v1/users/{email}, giving Knock the email property it delivers to) and the
// workflow trigger (POST, recipients as string ids).
installFetch({ status: 200, body: { workflow_run_id: "run_123", workflow: "missedcall-notify" } });
const trig = await triggerKnockEmail({ to: "owner@rapidrooter.example", subject: "New lead", body: "plain body" });
check("trigger: returns the workflow run id", { id: trig.id, workflowKey: trig.workflowKey }, { id: "run_123", workflowKey: "missedcall-notify" });
check("trigger: exactly two requests (identify then trigger)", requests.length, 2);
check("identify: PUT /v1/users/{url-encoded email}", { method: requests[0]?.method, url: requests[0]?.url }, { method: "PUT", url: "https://api.knock.app/v1/users/owner%40rapidrooter.example" });
check("identify: body sets the email property", JSON.parse(requests[0]?.body ?? "{}"), { email: "owner@rapidrooter.example" });
check("identify: Bearer auth from KNOCK_API_KEY", requests[0]?.headers["Authorization"], "Bearer sk_test_unit_key");
check("trigger: POST to /v1/workflows/{key}/trigger", { method: requests[1]?.method, url: requests[1]?.url }, { method: "POST", url: "https://api.knock.app/v1/workflows/missedcall-notify/trigger" });
check("trigger: Bearer auth from KNOCK_API_KEY", requests[1]?.headers["Authorization"], "Bearer sk_test_unit_key");
const trigBody = JSON.parse(requests[1]?.body ?? "{}") as { recipients: string[]; data: Record<string, unknown> };
check("trigger: recipient is a string id (NOT an object — Knock 422s those)", trigBody.recipients, ["owner@rapidrooter.example"]);
check("trigger: data carries subject + body", { subject: trigBody.data.subject, body: trigBody.data.body }, { subject: "New lead", body: "plain body" });
check("trigger: data omits html when not provided", "html" in trigBody.data, false);

requests = [];
installFetch({ status: 200, body: { id: "run_456" } });
const trig2 = await triggerKnockEmail({ to: "a@b.example", subject: "s", body: "b", html: "<p>x</p>" });
check("trigger: falls back to id field when workflow_run_id absent", trig2.id, "run_456");
check("trigger: html forwarded when provided", ("html" in ((JSON.parse(requests[1]?.body ?? "{}") as { data: Record<string, unknown> }).data)), true);

// Identify rejection must fail loudly: without the email property Knock
// accepts the trigger but delivers nowhere, so we never fire it.
requests = [];
installFetch({ status: 200, body: { workflow_run_id: "run_never" }, identifyStatus: 400, identifyBody: { code: "bad_request", message: "malformed user" } });
let identifyErr: Error | null = null;
try {
  await triggerKnockEmail({ to: "owner@rapidrooter.example", subject: "s", body: "b" });
} catch (e) {
  identifyErr = e as Error;
}
check("identify 400: throws KnockSendError", identifyErr instanceof KnockSendError, true);
check("identify 400: carries Knock's own code", (identifyErr as KnockSendError | null)?.providerCode, "bad_request");
check("identify 400: http status preserved", (identifyErr as KnockSendError | null)?.httpStatus, 400);
check("identify 400: the trigger is never sent", requests.length, 1);

// Knock rejection: the exact shape a missing workflow returns.
requests = [];
installFetch({ status: 404, body: { code: "workflow_not_found", message: "Workflow missedcall-notify could not be found" } });
let knockErr: Error | null = null;
try {
  await triggerKnockEmail({ to: "owner@rapidrooter.example", subject: "s", body: "b" });
} catch (e) {
  knockErr = e as Error;
}
check("404: throws KnockSendError", knockErr instanceof KnockSendError, true);
check("404: carries Knock's own code", (knockErr as KnockSendError | null)?.providerCode, "workflow_not_found");
check("404: http status preserved", (knockErr as KnockSendError | null)?.httpStatus, 404);
check("404: message carries Knock's own message", (knockErr as KnockSendError | null)?.message?.includes("could not be found"), true);

// Malformed + network + missing-id failures are honest, never fake success.
installFetch({ status: 502, body: "bad gateway" });
let err2: Error | null = null;
try {
  await triggerKnockEmail({ to: "owner@rapidrooter.example", subject: "s", body: "b" });
} catch (e) {
  err2 = e as Error;
}
check("502 non-JSON body: KnockSendError status 502", err2 instanceof KnockSendError && (err2 as KnockSendError).httpStatus, 502);

installFetch(null, true);
err2 = null;
try {
  await triggerKnockEmail({ to: "owner@rapidrooter.example", subject: "s", body: "b" });
} catch (e) {
  err2 = e as Error;
}
check("network error: KnockSendError status 0", err2 instanceof KnockSendError && (err2 as KnockSendError).httpStatus, 0);

installFetch({ status: 200, body: { ok: true } });
err2 = null;
try {
  await triggerKnockEmail({ to: "owner@rapidrooter.example", subject: "s", body: "b" });
} catch (e) {
  err2 = e as Error;
}
check("2xx missing run id: KnockSendError, no fake success", err2 instanceof KnockSendError && (err2 as KnockSendError).message.includes("missing workflow run id"), true);

// Knock key removed mid-flight → honest not-configured error.
process.env.KNOCK_API_KEY = "sk_test_unit_key";
installFetch({ status: 200, body: { workflow_run_id: "run_x" } });
delete process.env.KNOCK_API_KEY;
err2 = null;
try {
  await triggerKnockEmail({ to: "owner@rapidrooter.example", subject: "s", body: "b" });
} catch (e) {
  err2 = e as Error;
}
check("key removed: KnockNotConfiguredError", err2 instanceof KnockNotConfiguredError, true);

// --- Transport precedence via the sendEmail seam ---------------------------------
// 1. Knock PRIMARY: both Knock and EMAIL_* set → the request goes to Knock.
process.env.KNOCK_API_KEY = "sk_test_unit_key";
process.env.EMAIL_API_KEY = "re_test_unit_key";
process.env.EMAIL_FROM = "MissedCall AI <notifications@missedcall.ai>";
requests = [];
installFetch({ status: 200, body: { workflow_run_id: "run_knock" } });
const viaKnock = await sendEmail({ to: "owner@rapidrooter.example", subject: "New lead", text: "plain body", html: "<p>html</p>" });
check("precedence: knock+email set → knock wins", { transport: activeEmailTransport(), id: viaKnock.id, status: viaKnock.status }, { transport: "knock", id: "run_knock", status: "triggered" });
check("precedence: identify + trigger went to Knock", requests.length, 2);
check("precedence: no Resend-style request made", requests.every((r) => r.url.includes("api.knock.app")), true);
check("precedence: second request is the trigger", { method: requests[1]?.method, url: requests[1]?.url }, { method: "POST", url: "https://api.knock.app/v1/workflows/missedcall-notify/trigger" });
check("precedence: from reflects the knock workflow", viaKnock.from, "knock:missedcall-notify");

// 2. Fallback: only EMAIL_* set → Resend-style path intact, byte-for-byte URL.
delete process.env.KNOCK_API_KEY;
// The rate gate is deliberately transport-agnostic (one email per recipient
// per second regardless of provider) — reset it so this scenario isn't
// throttled by the knock send above to the same recipient.
resetEmailRateGateForTests();
requests = [];
installFetch({ status: 200, body: { id: "email_resend_1", status: "queued" } });
const viaResend = await sendEmail({ to: "owner@rapidrooter.example", subject: "New lead", text: "plain body" });
check("fallback: email-only → resend-style transport", { transport: activeEmailTransport(), id: viaResend.id, from: viaResend.from }, { transport: "resend-style", id: "email_resend_1", from: "MissedCall AI <notifications@missedcall.ai>" });
check("fallback: request went to {EMAIL_API_BASE}/emails", requests[0]?.url, "https://api.resend.com/emails");
check("fallback: Bearer auth from EMAIL_API_KEY", requests[0]?.headers["Authorization"], "Bearer re_test_unit_key");
{
  const lines = captureLog(() => logEmailStatus());
  check(
    "logEmailStatus: resend-style line says enabled",
    lines.some((l) => l.includes("[email]") && l.includes("configured - outbound email enabled")),
    true,
  );
}

// 3. Neither → honest EmailNotConfiguredError naming both var sets.
clearEnv();
check("neither: transport null", activeEmailTransport(), null);
let ncErr: Error | null = null;
try {
  await sendEmail({ to: "x@example.com", subject: "s", text: "t" });
} catch (e) {
  ncErr = e as Error;
}
check("neither: sendEmail throws EmailNotConfiguredError", ncErr instanceof EmailNotConfiguredError, true);
check("neither: message names KNOCK first + fallback vars", (ncErr?.message ?? "").includes("KNOCK_API_KEY") && (ncErr?.message ?? "").includes("EMAIL_API_KEY"), true);

// 4. The Knock path honors the local rate gate too (one per recipient/second).
process.env.KNOCK_API_KEY = "sk_test_unit_key";
requests = [];
installFetch({ status: 200, body: { workflow_run_id: "run_rate" } });
resetEmailRateGateForTests();
await sendEmail({ to: "rate@example.com", subject: "s", text: "t" });
let rateErr: Error | null = null;
try {
  await sendEmail({ to: "rate@example.com", subject: "s", text: "t" });
} catch (e) {
  rateErr = e as Error;
}
check("rate gate applies on the knock path", { calls: requests.length, inst: rateErr instanceof Error && (rateErr as Error).name }, { calls: 2, inst: "EmailSendError" });
uninstallFetch();
clearEnv();

// --- Notification email hook end-to-end over the Knock path ----------------------
interface MemState {
  emailed: Map<string, boolean>;
  stampCalls: number;
  ownerEmail: string | null;
  businessName: string;
}
function makeStore(overrides: Partial<MemState> = {}): { state: MemState; store: NotificationEmailStore } {
  const state: MemState = {
    emailed: new Map(),
    stampCalls: 0,
    ownerEmail: "owner@rapidrooter.example",
    businessName: "Rapid Rooter Plumbing",
    ...overrides,
  };
  const store: NotificationEmailStore = {
    async isNotificationEmailed(businessId, notificationId) {
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
  notificationId: "notif-k1",
  type: "new_lead" as const,
  payload: { leadName: "Dana Reyes", serviceNeed: "Burst pipe" },
};

// Unconfigured → silent skip (no store writes), the expected state.
{
  const { state, store } = makeStore();
  const r = await deliverNotificationEmail({ ...ARGS, store });
  check("hook: no transport → skipped_not_configured", r.outcome, "skipped_not_configured");
  check("hook: skip makes no store writes", state.stampCalls, 0);
}

// Workflow not published yet (owner's real current state): the trigger 404s →
// outcome failed with Knock's own code in the detail; email_sent_at NOT stamped.
process.env.KNOCK_API_KEY = "sk_test_unit_key";
installFetch({ status: 404, body: { code: "workflow_not_found", message: "Workflow missedcall-notify could not be found" } });
{
  const { state, store } = makeStore();
  const r = await deliverNotificationEmail({ ...ARGS, store });
  check("hook: unpublished workflow → failed (loud-honest), not sent", r.outcome, "failed");
  check("hook: failure detail carries Knock's code", (r.detail ?? "").includes("workflow_not_found"), true);
  check("hook: failure never stamps email_sent_at", state.stampCalls, 0);
  check("hook: failure makes the knock requests anyway (identify + trigger)", requests.length, 2);
}
uninstallFetch();

// Published workflow: trigger accepted → sent, email_sent_at stamped once,
// subject/body built by emailDelivery reach Knock's data payload.
installFetch({ status: 200, body: { workflow_run_id: "run_hook_1" } });
{
  const { state, store } = makeStore();
  const r = await deliverNotificationEmail({ ...ARGS, store });
  check("hook: knock success outcome sent with run id", { outcome: r.outcome, emailId: r.emailId }, { outcome: "sent", emailId: "run_hook_1" });
  check("hook: success stamps email_sent_at (once)", state.stampCalls, 1);
  const body = JSON.parse(requests[1]?.body ?? "{}") as { recipients: string[]; data: { subject: string; body: string } };
  check("hook: knock recipient is the owner email as a string id", body.recipients, ["owner@rapidrooter.example"]);
  check("hook: identify upserts the owner user first", { method: requests[0]?.method, url: requests[0]?.url }, { method: "PUT", url: "https://api.knock.app/v1/users/owner%40rapidrooter.example" });
  check("hook: subject names the business", (body.data.subject ?? "").includes("Rapid Rooter Plumbing"), true);
  check("hook: body includes lead details", (body.data.body ?? "").includes("Dana Reyes") && (body.data.body ?? "").includes("Burst pipe"), true);
}
uninstallFetch();
clearEnv();

console.log("\n" + checks + " checks run, " + failures + " failed");
console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
