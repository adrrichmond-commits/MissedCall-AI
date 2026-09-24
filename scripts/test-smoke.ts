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
 * configured environment (DATABASE_URL set) — /api/healthz must answer 200.
 *
 * Exercises, in order:
 *   1. GET /api/healthz        → 200, {ok:true, db:true, timestamp} (unauthenticated)
 *   2. GET /healthz            → app JSON on self-hosted targets; on the
 *                                production host the platform proxy answers
 *                                this path with plain "OK" before the app
 *                                sees it, so non-localhost targets accept
 *                                either shape
 *   3. anonymous /dashboard    → bounced to /login (session gate holds)
 *   4. anonymous /admin        → bounced to /login (admin gate holds)
 *   5. signupFn (RPC)          → fresh timestamped account (rerun-idempotent) + session cookie
 *   6. dashboard/leads/inbox/appointments/analytics/billing for that account → 200
 *   7. loginFn (RPC)           → the seeded demo account (Dana Whitfield) + session cookie
 *   8. Dana's dashboard        → 200 and her name renders
 *
 * Wire format notes (verified against a captured browser request AND against
 * the shipped prod bundle):
 *   - TanStack Start server-fn RPCs are POST /_serverFn/<fn id> with a
 *     seroval/crossJSON body {"t":{obj},"f":63,"m":[]}. The encoders below
 *     build that shape for flat string payloads.
 *   - The fn id differs by build mode. DEV: base64url-encoded JSON
 *     {file, export} where file is the module id WITH the
 *     "?tss-serverfn-split" query. PROD: sha256 over
 *     "<path.relative(root, module) WITHOUT the query>--<export name>" —
 *     @tanstack/start-plugin-core handleCreateServerFn strips the split
 *     query before hashing (`path.relative(context.root, baseFilename)`),
 *     so including the query here 500s on every prod build. Verified
 *     against the shipped bundle: sha256("src/lib/server/authFns.ts--…")…
 *     appears verbatim in the client chunk; the with-query hash does not.
 *     The suite tries the prod id first and falls back to the dev id.
 *   - The production hosting proxy only forwards browser-like requests, so
 *     the suite sends the headers every real browser sends: Origin, Referer,
 *     and Sec-Fetch-Site. Without them the proxy 403s the RPC before the app.
 */
import { createHash } from "node:crypto";

const BASE = (process.argv[2] ?? process.env.SMOKE_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const BASE_HOST = new URL(BASE).hostname;
const IS_LOCAL = ["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"].includes(BASE_HOST);

let checks = 0;
let failures = 0;
function checkTrue(name: string, cond: boolean, detail = ""): void {
  checks++;
  // One unambiguous line per check — grep "FAIL" for failures only.
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  } else {
    console.log("PASS " + name);
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
/**
 * PROD compiler id: sha256("<root-relative path>--<export name>") hex where
 * the path is the module id WITHOUT the "?tss-serverfn-split" query and
 * without a leading slash (matches handleCreateServerFn's
 * `path.relative(root, baseFilename)`).
 */
function prodFnId(file: string, exportName: string): string {
  const relPath = file.split("?")[0].replace(/^\//, "");
  return createHash("sha256")
    .update(`${relPath}--${exportName}`)
    .digest("hex");
}
/** DEV compiler id: base64url of JSON {file, export} (file keeps the query). */
function devFnId(file: string, exportName: string): string {
  return Buffer.from(JSON.stringify({ file, export: exportName }))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
/** POST /_serverFn/<id> — prod id first, dev id as fallback. */
function fnUrls(file: string, exportName: string): string[] {
  return [`${BASE}/_serverFn/${prodFnId(file, exportName)}`, `${BASE}/_serverFn/${devFnId(file, exportName)}`];
}

const AUTH_FNS = "/src/lib/server/authFns.ts?tss-serverfn-split";
const SIGNUP_URLS = fnUrls(AUTH_FNS, "signupFn_createServerFn_handler");
const LOGIN_URLS = fnUrls(AUTH_FNS, "loginFn_createServerFn_handler");

interface FnResponse {
  status: number;
  cookies: string[];
  text: string;
}
/**
 * POST the RPC to each candidate fn id until one answers 200 (dev and prod
 * builds register different ids; a wrong id 500s without executing the fn).
 * Headers mirror what every real browser sends — the production hosting
 * proxy 403s non-browser-like RPC POSTs (missing Origin / Sec-Fetch-Site).
 */
async function callFn(urls: string[], keys: string[], values: string[]): Promise<FnResponse> {
  let last: FnResponse | undefined;
  for (const url of urls) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tsr-serverfn": "true",
        accept: "application/x-tss-framed, application/x-ndjson, application/json",
        origin: BASE,
        referer: BASE + "/login",
        "sec-fetch-site": "same-origin",
      },
      body: rpcBody(keys, values),
    });
    const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
    const cookies = typeof getSetCookie === "function" ? getSetCookie.call(res.headers) : [];
    last = { status: res.status, cookies, text: await res.text() };
    if (res.status === 200) return last;
  }
  return last as FnResponse;
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

// 1. /api/healthz — the app-owned probe (never shadowed by the hosting proxy).
const healthStarted = Date.now();
const healthRes = await fetch(`${BASE}/api/healthz`);
const healthMs = Date.now() - healthStarted;
const healthBody = (await healthRes.json().catch(() => null)) as
  | { ok?: boolean; db?: boolean; uptimeSec?: number; timestamp?: string }
  | null;
checkTrue("healthz /api/healthz: HTTP 200", healthRes.status === 200, `got ${healthRes.status}`);
checkTrue("healthz /api/healthz: ok=true db=true", healthBody?.ok === true && healthBody?.db === true, JSON.stringify(healthBody));
checkTrue("healthz /api/healthz: timestamp present", typeof healthBody?.timestamp === "string" && healthBody.timestamp.length > 0);
checkTrue("healthz /api/healthz: no cache", (healthRes.headers.get("cache-control") ?? "").includes("no-store"));
checkTrue("healthz /api/healthz: responds fast (<3000ms incl. dev compile)", healthMs < 3000, `${healthMs}ms`);

// 2. Bare /healthz — platform portability check. On the production host the
// proxy answers this path with plain "OK" before the app is reached; local
// targets must serve the app's real JSON here.
{
  const res = await fetch(`${BASE}/healthz`);
  const text = (await res.text()).trim();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // plain-text platform response — handled below
  }
  const isHealthJson =
    !!json && typeof json === "object" && (json as { ok?: unknown }).ok === true && (json as { db?: unknown }).db === true;
  const isPlatformOk = res.status === 200 && text === "OK";
  if (IS_LOCAL) {
    checkTrue("healthz /healthz (bare): app JSON 200", res.status === 200 && isHealthJson, `status ${res.status} body ${text.slice(0, 60)}`);
  } else {
    checkTrue(
      "healthz /healthz (bare): reachable (app JSON or platform OK)",
      res.status === 200 && (isHealthJson || isPlatformOk),
      `status ${res.status} body ${text.slice(0, 60)}`,
    );
  }
}

// 3. Session gate: anonymous dashboard bounces to login.
const anonDash = await getPage("/dashboard");
checkTrue(
  "gate: anonymous /dashboard lands on /login",
  anonDash.status === 200 && (new URL(anonDash.url).pathname === "/login" || anonDash.html.includes("Log in")),
  `status ${anonDash.status} url ${anonDash.url}`,
);

// 4. Admin gate: anonymous /admin is NOT the admin surface.
const anonAdmin = await getPage("/admin");
checkTrue(
  "gate: anonymous /admin does not expose admin UI",
  anonAdmin.status === 200 && (new URL(anonAdmin.url).pathname === "/login" || !anonAdmin.html.includes("Viewing as")),
  `status ${anonAdmin.status} url ${anonAdmin.url}`,
);

// 5. Signup — fresh, timestamped (rerun-idempotent), gets a session.
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const smokeEmail = `smoke+${stamp}@smoke-test.example.com`;
const businessName = `Smoke Test Plumbing ${stamp}`;
const signup = await callFn(SIGNUP_URLS, ["businessName", "fullName", "email", "password"], [
  businessName,
  "Smoke Tester",
  smokeEmail,
  "smoke-password-1234",
]);
const signupCookie = cookieHeader(signup.cookies);
checkTrue("signup: RPC answered 200", signup.status === 200, `got ${signup.status}: ${signup.text.slice(0, 120)}`);
checkTrue("signup: session cookie issued", signupCookie.length > 0, signup.text.slice(0, 120));

// 6. The fresh account's app pages all render.
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

// 7. Demo login — the seeded Rapid Rooter owner (Dana Whitfield).
const demo = await callFn(LOGIN_URLS, ["email", "password"], [
  "dana@rapidrooter.example.com",
  "demo-password-1234",
]);
const demoCookie = cookieHeader(demo.cookies);
checkTrue("demo login: RPC answered 200", demo.status === 200, `got ${demo.status}: ${demo.text.slice(0, 120)}`);
checkTrue("demo login: session cookie issued", demoCookie.length > 0, demo.text.slice(0, 120));

// 8. Dana's dashboard — authenticated, seeded business, her identity.
const demoDash = await getPage("/dashboard", demoCookie);
checkTrue("demo: dashboard renders", demoDash.status === 200 && new URL(demoDash.url).pathname === "/dashboard", `status ${demoDash.status} url ${demoDash.url}`);
checkTrue("demo: dashboard shows Dana Whitfield", demoDash.html.includes("Dana Whitfield"));
const demoLeads = await getPage("/leads", demoCookie);
checkTrue("demo: leads page renders seeded CRM", demoLeads.status === 200 && new URL(demoLeads.url).pathname === "/leads");

console.log(`\nSMOKE ${failures === 0 ? "PASS" : "FAIL"} — ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);

export {};
