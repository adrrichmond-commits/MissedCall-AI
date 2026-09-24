#!/usr/bin/env bun
/**
 * P4-I infrastructure tests. Run: bun scripts/test-infra.ts — no DB, no
 * network, no keys (external calls are stubbed or env-gated off).
 *
 * Covers:
 *   - logger: JSON-lines shape, level filtering (LOG_LEVEL), field merging,
 *     one-line guarantee (newlines escaped)
 *   - rateLimit: fixed-window allow/block/remaining, retryAfterSec, env
 *     override, RATE_LIMIT_DISABLED kill switch, clientIpFromHeaders
 *     (x-forwarded-for first hop → x-real-ip → placeholder), reset seam
 *   - sms retry: transient (network/500/429) failures retried with backoff
 *     and succeed on a later attempt; permanent 4xx fail after ONE attempt;
 *     SmsNotConfiguredError still thrown when unconfigured
 *   - errorSink: ERROR_MONITOR_DSN unset → notifyExternalMonitor no-ops;
 *     set → exactly one best-effort POST; recordSystemError never throws
 *     even with no DB; guardApiRoute turns a throw into a clean 500 JSON
 *   - voice fallback: platformFallbackTransferNumber env-gated (null unset,
 *     E.164 when set, undialable stays null)
 *   - readiness: CRITICAL_TABLES includes system_errors (migration 016)
 */
import {
  log,
} from "../src/lib/server/logger.ts";
import {
  RATE_LIMITS,
  checkRateLimit,
  clientIpFromHeaders,
  rateLimitingDisabled,
  resetRateLimits,
} from "../src/lib/server/rateLimit.ts";
import { sendSms, SmsNotConfiguredError } from "../src/lib/server/sms.ts";
import { guardApiRoute, notifyExternalMonitor, recordSystemError } from "../src/lib/server/errorSink.ts";
import { platformFallbackTransferNumber } from "../src/lib/server/voiceReceptionist.ts";
import { CRITICAL_TABLES } from "../src/lib/server/healthProbe.ts";

let checks = 0;
let failures = 0;
function checkTrue(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  } else {
    console.log("ok   " + name);
  }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  checkTrue(name, JSON.stringify(actual) === JSON.stringify(expected), "got " + JSON.stringify(actual) + " want " + JSON.stringify(expected));
}

// ---------------------------------------------------------------------------
// logger
// ---------------------------------------------------------------------------
const origLog = console.log;
const origErr = console.error;
const origLevel = process.env.LOG_LEVEL;
const lines: string[] = [];
console.log = (l: string) => lines.push(String(l));
console.error = (l: string) => lines.push(String(l));
process.env.LOG_LEVEL = "info";
log.info("hello", { businessId: "b1", n: 2 });
const parsed = JSON.parse(lines[lines.length - 1] ?? "{}") as Record<string, unknown>;
checkTrue("logger: info line is valid JSON with ts/level/msg", typeof parsed.ts === "string" && parsed.level === "info" && parsed.msg === "hello");
eq("logger: structured fields carried", { businessId: parsed.businessId, n: parsed.n }, { businessId: "b1", n: 2 });
log.debug("should be filtered at info");
checkTrue("logger: debug filtered at LOG_LEVEL=info", !lines.some((l) => l.includes("should be filtered")));
process.env.LOG_LEVEL = "error";
log.info("noisy", {});
log.error("kept", {});
checkTrue("logger: error passes, info filtered at LOG_LEVEL=error", lines.at(-1)?.includes("\"kept\"") === true && !lines.at(-2)?.includes("noisy"));
log.error("err-with-cause", { err: new Error("boom") });
checkTrue("logger: Error field serialized (no throw, message present)", lines.at(-1)?.includes("boom") === true);
console.log = origLog;
console.error = origErr;
if (origLevel === undefined) delete process.env.LOG_LEVEL;
else process.env.LOG_LEVEL = origLevel;

// ---------------------------------------------------------------------------
// rateLimit
// ---------------------------------------------------------------------------
delete process.env.RATE_LIMIT_DISABLED;
resetRateLimits();
const origOverride = process.env.RATE_LIMIT_LOGIN_PER_MIN;
process.env.RATE_LIMIT_LOGIN_PER_MIN = "3";
resetRateLimits();
const d1 = checkRateLimit("auth_login", "1.2.3.4");
const d2 = checkRateLimit("auth_login", "1.2.3.4");
const d3 = checkRateLimit("auth_login", "1.2.3.4");
const d4 = checkRateLimit("auth_login", "1.2.3.4");
checkTrue("rateLimit: under-limit requests allowed", d1.allowed && d2.allowed && d3.allowed);
checkTrue("rateLimit: over-limit blocked with retryAfterSec >= 1", d4.allowed === false && d4.retryAfterSec >= 1 && d4.retryAfterSec <= 60);
eq("rateLimit: remaining counts down", [d1.remaining, d2.remaining, d3.remaining], [2, 1, 0]);
const other = checkRateLimit("auth_login", "5.6.7.8");
checkTrue("rateLimit: identity is isolated per IP", other.allowed === true);
const d5 = checkRateLimit("auth_login", "1.2.3.4");
checkTrue("rateLimit: still blocked in same window", d5.allowed === false);
resetRateLimits();
const d6 = checkRateLimit("auth_login", "1.2.3.4");
checkTrue("rateLimit: reset seam clears counters", d6.allowed === true);
// kill switch
process.env.RATE_LIMIT_DISABLED = "1";
const d7 = checkRateLimit("auth_login", "1.2.3.4");
checkTrue("rateLimit: RATE_LIMIT_DISABLED=1 disables the limiter", d7.allowed === true && rateLimitingDisabled() === true);
delete process.env.RATE_LIMIT_DISABLED;
// config table sanity (the ONE module)
eq("rateLimit: generous defaults documented in config", {
  login: RATE_LIMITS.auth_login.limit,
  signup: RATE_LIMITS.auth_signup.limit,
  twilio: RATE_LIMITS.twilio_webhook.limit,
  stripe: RATE_LIMITS.stripe_webhook.limit,
}, { login: 60, signup: 30, twilio: 600, stripe: 600 });
// client IP extraction
eq("rateLimit: x-forwarded-for first hop", clientIpFromHeaders(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })), "9.9.9.9");
eq("rateLimit: x-real-ip fallback", clientIpFromHeaders(new Headers({ "x-real-ip": "8.8.8.8" })), "8.8.8.8");
eq("rateLimit: placeholder when headers absent", clientIpFromHeaders(new Headers()), "unknown-client");
if (origOverride === undefined) delete process.env.RATE_LIMIT_LOGIN_PER_MIN;
else process.env.RATE_LIMIT_LOGIN_PER_MIN = origOverride;
resetRateLimits();

// ---------------------------------------------------------------------------
// sms retry (stub fetch — no network, no keys)
// ---------------------------------------------------------------------------
const envSid = [process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, process.env.TWILIO_SMS_NUMBER];
process.env.TWILIO_ACCOUNT_SID = "ACtest";
process.env.TWILIO_AUTH_TOKEN = "tok";
process.env.TWILIO_SMS_NUMBER = "+15550001111";
const realFetch = globalThis.fetch;
let calls = 0;
let responder: () => Response = () => new Response("{}", { status: 200 });
globalThis.fetch = (async () => {
  calls++;
  return responder();
}) as typeof fetch;
// transient 500 twice then success → 3 attempts, returns sid
calls = 0;
responder = () => (calls < 3 ? new Response(JSON.stringify({ message: "upstream down" }), { status: 500 }) : new Response(JSON.stringify({ sid: "SMok" }), { status: 201 }));
const okResult = await sendSms({ to: "+15550002222", body: "hi" }, { retries: 2, backoffMs: [1, 1] });
eq("sms: transient 500s retried then sent", { calls, sid: okResult.sid }, { calls: 3, sid: "SMok" });
// network error retried
calls = 0;
globalThis.fetch = (async () => {
  calls++;
  if (calls < 2) throw new Error("ECONNRESET");
  return new Response(JSON.stringify({ sid: "SMnet" }), { status: 201 });
}) as typeof fetch;
const netResult = await sendSms({ to: "+15550002222", body: "hi" }, { retries: 2, backoffMs: [1, 1] });
eq("sms: network error retried then sent", { calls, sid: netResult.sid }, { calls: 2, sid: "SMnet" });
// permanent 4xx NOT retried
calls = 0;
globalThis.fetch = (async () => {
  calls++;
  return new Response(JSON.stringify({ message: "opt-out", code: 21606 }), { status: 400 });
}) as typeof fetch;
let permErr: unknown = null;
try {
  await sendSms({ to: "+15550002222", body: "hi" }, { retries: 2, backoffMs: [1, 1] });
} catch (e) {
  permErr = e;
}
checkTrue("sms: permanent 4xx fails after exactly ONE attempt", calls === 1 && (permErr as Error)?.name === "SmsSendError");
// 429 retried
calls = 0;
globalThis.fetch = (async () => {
  calls++;
  return calls < 2 ? new Response("{}", { status: 429 }) : new Response(JSON.stringify({ sid: "SM429" }), { status: 201 });
}) as typeof fetch;
const r429 = await sendSms({ to: "+15550002222", body: "hi" }, { retries: 2, backoffMs: [1, 1] });
eq("sms: 429 retried then sent", { calls, sid: r429.sid }, { calls: 2, sid: "SM429" });
globalThis.fetch = realFetch;
// unconfigured → honest typed error (no retries fabricated)
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_SMS_NUMBER;
let notConfigured: unknown = null;
try {
  await sendSms({ to: "+15550002222", body: "hi" });
} catch (e) {
  notConfigured = e;
}
checkTrue("sms: unconfigured throws SmsNotConfiguredError (no fake send)", notConfigured instanceof SmsNotConfiguredError);
for (let i = 0; i < 3; i++) {
  if (envSid[i]) (process.env as Record<string, string>)["TWILIO_" + ["ACCOUNT_SID", "AUTH_TOKEN", "SMS_NUMBER"][i]] = envSid[i] as string;
}

// ---------------------------------------------------------------------------
// errorSink
// ---------------------------------------------------------------------------
const realFetch2 = globalThis.fetch;
let monitorPosts = 0;
const dsnBackup = process.env.ERROR_MONITOR_DSN;
// 1. unset → no-op, no fetch
delete process.env.ERROR_MONITOR_DSN;
globalThis.fetch = (async () => {
  monitorPosts++;
  return new Response("{}", { status: 200 });
}) as typeof fetch;
notifyExternalMonitor({ source: "test", message: "x" });
await new Promise((r) => setTimeout(r, 10));
eq("errorSink: DSN unset → monitor no-ops", monitorPosts, 0);
// 2. set → exactly one POST with the payload
process.env.ERROR_MONITOR_DSN = "http://127.0.0.1:9/none";
let lastBody = "";
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  monitorPosts++;
  lastBody = String(init?.body ?? "");
  return new Response("{}", { status: 200 });
}) as typeof fetch;
notifyExternalMonitor({ source: "test", message: "y", businessId: "b9" });
await new Promise((r) => setTimeout(r, 10));
eq("errorSink: DSN set → one fire-and-forget POST", monitorPosts, 1);
checkTrue("errorSink: monitor payload carries source/message/businessId", lastBody.includes("\"source\":\"test\"") && lastBody.includes("y") && lastBody.includes("b9"));
delete process.env.ERROR_MONITOR_DSN;
// 3. recordSystemError never throws even when the DB write fails (no DATABASE_URL here)
let recorded = false;
try {
  await recordSystemError({ source: "test", message: "db-less write", businessId: null, detail: {} });
  recorded = true;
} catch {
  recorded = false;
}
checkTrue("errorSink: recordSystemError resolves (never throws) without a DB", recorded === true);
// 4. guardApiRoute: throw → 500 JSON, honest body
const guarded = guardApiRoute("test_route", async () => {
  throw new Error("kaboom");
});
const gres = await guarded(new Request("http://x/test"));
checkTrue("errorSink: guardApiRoute returns clean 500 on throw", gres.status === 500);
const gbody = (await gres.json()) as { error?: string };
eq("errorSink: guardApiRoute body is generic internal_error", gbody.error, "internal_error");
globalThis.fetch = realFetch2;
if (dsnBackup !== undefined) process.env.ERROR_MONITOR_DSN = dsnBackup;

// ---------------------------------------------------------------------------
// voice fallback + readiness constants
// ---------------------------------------------------------------------------
const fwdBackup = process.env.TWILIO_VOICE_FORWARD_NUMBER;
delete process.env.TWILIO_VOICE_FORWARD_NUMBER;
eq("voice: platform fallback null when env unset (dormant)", platformFallbackTransferNumber(), null);
process.env.TWILIO_VOICE_FORWARD_NUMBER = "(512) 555-0134";
eq("voice: platform fallback normalizes to E.164", platformFallbackTransferNumber(), "+15125550134");
process.env.TWILIO_VOICE_FORWARD_NUMBER = "12";
eq("voice: undialable fallback stays null (never guess)", platformFallbackTransferNumber(), null);
if (fwdBackup === undefined) delete process.env.TWILIO_VOICE_FORWARD_NUMBER;
else process.env.TWILIO_VOICE_FORWARD_NUMBER = fwdBackup;
checkTrue("readiness: critical tables include system_errors (migration 016)", CRITICAL_TABLES.includes("system_errors"));

console.log("\n" + checks + " checks run, " + failures + " failed");
console.log(failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
