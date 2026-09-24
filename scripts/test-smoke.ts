#!/usr/bin/env bun
/**
 * E2E smoke test (Phase 3 reliability pass). Bun-run, same reporting style
 * as the other test-*.ts suites, but drives a LIVE server over HTTP — it is
 * the launch-readiness check that the whole stack (routes, server fns, RPC,
 * DB, session cookies) actually serves a customer-shaped session.
 *
 * Usage:
 *   bun scripts/test-smoke.ts [baseUrl]
 *   SMOKE_BASE_URL=https://… bun scripts/test-smoke.ts
 * Base URL defaults to http://localhost:3000. The target must be a fully
 * configured environment (DATABASE_URL set) — /healthz must answer 200.
 *
 * Exercises, in order:
 *   1. GET /healthz            → 200, {ok:true, db:true, timestamp} (unauthenticated)
 *   2. anonymous /dashboard    → bounced to /login (session gate holds)
 *   3. anonymous /admin        → bounced to /login (admin gate holds)
 *   4. signupFn (RPC)          → fresh timestamped account (rerun-idempotent) + session cookie
 *   5. dashboard/leads/inbox/appointments/analytics/billing for that account → 200
 *   6. loginFn (RPC)           → the seeded demo account (Dana Whitfield) + session cookie
 *   7. Dana's dashboard        → 200 and her name renders
 *
 * Wire format note: TanStack Start server-fn RPCs are POST
 * /_serverFn/<base64url fn id> with an Origin header (CSRF) and a
 * seroval/crossJSON body {"t":{obj},"f":63,"m":[]}. The encoders below build
 * that shape for flat string payloads — verified against a captured browser
 * request when this suite was written.
 */
const BASE = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

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

// ---------------------------------------------------------------------------
// TanStack Start RPC helpers
// ---------------------------------------------------------------------------

/** Seroval crossJSON: string literal. */
function s(v: string): unknown {
  return { t: 1, s: v };
}
/** Seroval crossJSON: plain object of flat fields. */
function obj(i: number, keys: string[], values: unknown[]): unknown {
  return { t: 10, i, p: { k: keys, v: values }, o: 0 };
}
/** The full RPC body for a server fn whose arg is { data: <flat object> }. */
function rpcBody(keys: string[], values: string[]): string {
  return JSON.stringify({ t: obj(0, ["data"], [obj(1, keys, values.map(s))]), f: 63, m: [] });
}
/** POST /_serverFn/<base64url({file, export})> — the URL the client builds. */
function fnUrl(file: string, exportName: string): string {
  const id = Buffer.from(JSON.stringify({ file, export: exportName }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${BASE}/_serverFn/${id}`;
}

const SIGNUP_URL = fnUrl("/src/lib/server/authFns.ts?tss-serverfn-split", "signupFn_createServerFn_handler");
const LOGIN_URL = fnUrl("/src/lib/server/authFns.ts?tss-serverfn-split", "loginFn_createServerFn_handler");

interface FnResponse {
  status: number;
  cookies: string[];
  text: string;
}
async function callFn(url: string, keys: string[], values: string[]): Promise<FnResponse> {
  const res = await fetch(url, {
    method: "POST",
    // Headers the TanStack client always sends: the marker routes the request
    // into the server-fn handler; the accept list picks the response codec.
    headers: {
      "content-type": "application/json",
      "x-tsr-serverfn": "true",
      accept: "application/x-tss-framed, application/x-ndjson, application/json",
      origin: BASE,
    },
    body: rpcBody(keys, values),
  });
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getSetCookie === "function" ? getSetCookie.call(res.headers) : [];
  return { status: res.status, cookies, text: await res.text() };
}
/** Collapse Set-Cookie headers into one Cookie header value. */
function cookieHeader(cookies: string[]): string {
  return cookies
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function getPage(path: string, cookie?: string): Promise<{ status: number; url: string; html: string; ms: number }> {
  const started = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "follow",
  });
  return { status: res.status, url: res.url, html: await res.text(), ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// The smoke run
// ---------------------------------------------------------------------------

console.log(`Smoke target: ${BASE}`);

// 1. /healthz — anonymous, fast, honest JSON.
const healthStarted = Date.now();
const healthRes = await fetch(`${BASE}/healthz`);
const healthMs = Date.now() - healthStarted;
const healthBody = (await healthRes.json().catch(() => null)) as
  | { ok?: boolean; db?: boolean; uptimeSec?: number; timestamp?: string }
  | null;
checkTrue("healthz: HTTP 200", healthRes.status === 200, `got ${healthRes.status}`);
checkTrue("healthz: ok=true db=true", healthBody?.ok === true && healthBody?.db === true, JSON.stringify(healthBody));
checkTrue("healthz: timestamp present", typeof healthBody?.timestamp === "string" && healthBody.timestamp.length > 0);
checkTrue("healthz: no cache", (healthRes.headers.get("cache-control") ?? "").includes("no-store"));
checkTrue("healthz: responds fast (<3000ms incl. dev compile)", healthMs < 3000, `${healthMs}ms`);

// 2. Session gate: anonymous dashboard bounces to login.
const anonDash = await getPage("/dashboard");
checkTrue(
  "gate: anonymous /dashboard lands on /login",
  anonDash.status === 200 && (new URL(anonDash.url).pathname === "/login" || anonDash.html.includes("Log in")),
  `status ${anonDash.status} url ${anonDash.url}`,
);

// 3. Admin gate: anonymous /admin is NOT the admin surface.
const anonAdmin = await getPage("/admin");
checkTrue(
  "gate: anonymous /admin does not expose admin UI",
  anonAdmin.status === 200 && (new URL(anonAdmin.url).pathname === "/login" || !anonAdmin.html.includes("Viewing as")),
  `status ${anonAdmin.status} url ${anonAdmin.url}`,
);

// 4. Signup — fresh, timestamped (rerun-idempotent), gets a session.
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const smokeEmail = `smoke+${stamp}@smoke-test.example.com`;
const businessName = `Smoke Test Plumbing ${stamp}`;
const signup = await callFn(SIGNUP_URL, ["businessName", "fullName", "email", "password"], [
  businessName,
  "Smoke Tester",
  smokeEmail,
  "smoke-password-1234",
]);
const signupCookie = cookieHeader(signup.cookies);
checkTrue("signup: RPC answered 200", signup.status === 200, `got ${signup.status}: ${signup.text.slice(0, 120)}`);
checkTrue("signup: session cookie issued", signupCookie.length > 0, signup.text.slice(0, 120));

// 5. The fresh account's app pages all render.
const newDash = await getPage("/dashboard", signupCookie);
checkTrue(
  "new account: dashboard renders",
  newDash.status === 200 && ["/dashboard", "/onboarding"].includes(new URL(newDash.url).pathname),
  `status ${newDash.status} url ${newDash.url}`,
);
for (const path of ["/leads", "/inbox", "/appointments", "/analytics", "/billing"]) {
  const page = await getPage(path, signupCookie);
  checkTrue(
    `new account: ${path} renders 200`,
    page.status === 200 && new URL(page.url).pathname === path,
    `status ${page.status} url ${page.url}`,
  );
}

// 6. Demo login — the seeded Rapid Rooter owner (Dana Whitfield).
const demo = await callFn(LOGIN_URL, ["email", "password"], [
  "dana@rapidrooter.example.com",
  "demo-password-1234",
]);
const demoCookie = cookieHeader(demo.cookies);
checkTrue("demo login: RPC answered 200", demo.status === 200, `got ${demo.status}: ${demo.text.slice(0, 120)}`);
checkTrue("demo login: session cookie issued", demoCookie.length > 0, demo.text.slice(0, 120));

// 7. Dana's dashboard — authenticated, seeded business, her identity.
const demoDash = await getPage("/dashboard", demoCookie);
checkTrue("demo: dashboard renders", demoDash.status === 200 && new URL(demoDash.url).pathname === "/dashboard", `status ${demoDash.status} url ${demoDash.url}`);
checkTrue("demo: dashboard shows Dana Whitfield", demoDash.html.includes("Dana Whitfield"));
const demoLeads = await getPage("/leads", demoCookie);
checkTrue("demo: leads page renders seeded CRM", demoLeads.status === 200 && new URL(demoLeads.url).pathname === "/leads");

console.log(`\nSMOKE ${failures === 0 ? "PASS" : "FAIL"} — ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);

export {};
