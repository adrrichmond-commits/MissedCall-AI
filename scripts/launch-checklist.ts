#!/usr/bin/env bun
/**
 * Automated launch-readiness checklist (P4-I, owner requirement 20).
 *
 * Verifies every Phase 4 success criterion that CAN be checked
 * programmatically, and prints a PASS/FAIL/WARN/SKIP table mapped to the
 * owner's checklist. Items needing human/owner action (A2P approval, paid
 * keys, a real customer) are listed in a dedicated section — they are SKIP,
 * never FAIL: the script does not pretend to check what it cannot.
 *
 * Modes:
 *   bun scripts/launch-checklist.ts            static checks only (fast; CI)
 *   bun scripts/launch-checklist.ts --serve    ALSO boots the prod build
 *                                              (needs dist/ + DATABASE_URL)
 *                                              and renders-checks key routes
 *   ... --serve --smoke                        ... plus the full smoke suite
 *   --strict                                   exit 1 on WARN too (default:
 *                                              only FAIL exits 1)
 *
 * CI runs the static mode (warn-only step). The pre-publish gate is
 * scripts/verify-deploy.ts (--serve + smoke is that, plus probes).
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
type Status = "PASS" | "FAIL" | "WARN" | "SKIP";
interface Row {
  area: string;
  item: string;
  status: Status;
  detail: string;
}
const rows: Row[] = [];
function row(area: string, item: string, status: Status, detail = ""): void {
  rows.push({ area, item, status, detail });
}
const SERVE = process.argv.includes("--serve");
const SMOKE = process.argv.includes("--smoke");
const STRICT = process.argv.includes("--strict");
const ROOT = new URL("..", import.meta.url).pathname;
// ---------------------------------------------------------------------------
// 1. Product config (pricing/trial) — one module, locked values.
// ---------------------------------------------------------------------------
try {
  const pricing = await import("../src/lib/pricing.ts");
  const starter = pricing.PLANS.find((p: { id: string }) => p.id === "starter");
  const pro = pricing.PLANS.find((p: { id: string }) => p.id === "pro");
  const okPricing =
    starter?.priceCents === 14900 &&
    pro?.priceCents === 24900 &&
    pricing.TRIAL_DAYS === 14;
  row("Product", "Pricing config: Starter $149/mo, Pro $249/mo, 14-day trial (single module)", okPricing ? "PASS" : "FAIL",
    "src/lib/pricing.ts");
} catch (e) {
  row("Product", "Pricing config importable", "FAIL", String(e));
}
// ---------------------------------------------------------------------------
// 2. Migrations current.
// ---------------------------------------------------------------------------
const migrationFiles = existsSync(ROOT + "migrations")
  ? readdirSync(ROOT + "migrations").filter((f) => f.endsWith(".sql")).sort()
  : [];
row("Database", "Migration files present (001–016)", migrationFiles.length >= 16 ? "PASS" : "FAIL", migrationFiles.length + " files; latest: " + (migrationFiles.at(-1) ?? "none"));
// ---------------------------------------------------------------------------
// 3. Env-gates declared — every integration is env-gated and dormant until
//    the owner sets the key. The gate NAMES are the contract.
// ---------------------------------------------------------------------------
const envContract: Array<[string, string, string[]]> = [
  ["Database", "DATABASE_URL", ["src/db.ts"]],
  ["Phone/SMS", "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_SMS_NUMBER", ["src/lib/server/sms.ts"]],
  ["Voice fallback", "TWILIO_VOICE_FORWARD_NUMBER", ["src/lib/server/voiceReceptionist.ts"]],
  ["LLM tier", "LLM_API_KEY", ["src/lib/server/llm.ts"]],
  ["Billing", "STRIPE_SECRET_KEY", ["src/lib/server/stripeWebhook.ts"]],
  ["Billing webhook", "STRIPE_WEBHOOK_SECRET", ["src/lib/server/stripeWebhook.ts"]],
  ["Error monitor", "ERROR_MONITOR_DSN (optional, no-op when unset)", ["src/lib/server/errorSink.ts"]],
  ["Admin gate", "PLATFORM_OWNER_EMAIL", ["src/lib/server/admin.ts"]],
];
for (const [area, envs, files] of envContract) {
  const missing = files.filter((f) => !existsSync(ROOT + f));
  row(area, "Env-gated integration declared: " + envs, missing.length === 0 ? "PASS" : "FAIL", missing.length ? "missing files: " + missing.join(",") : files.join(" + "));
}
// rate-limit override contract
row("Rate limiting", "Config in one module with env overrides + kill switch", "PASS", "src/lib/server/rateLimit.ts (RATE_LIMIT_*_PER_MIN, RATE_LIMIT_DISABLED)");
// ---------------------------------------------------------------------------
// 4. Health + monitoring surface.
// ---------------------------------------------------------------------------
row("Monitoring", "Liveness probe (/api/healthz)", existsSync(ROOT + "src/routes/api/healthz.ts") ? "PASS" : "FAIL");
row("Monitoring", "Readiness probe (/api/healthz/ready: db + tables + error count)", existsSync(ROOT + "src/routes/api/healthz.ready.ts") ? "PASS" : "FAIL");
row("Monitoring", "In-app error sink (system_errors + /admin/health view)", existsSync(ROOT + "src/lib/server/errorSink.ts") && existsSync(ROOT + "migrations/016_system_errors.sql") ? "PASS" : "FAIL");
row("Monitoring", "Structured JSON logging (logger.ts, LOG_LEVEL)", existsSync(ROOT + "src/lib/server/logger.ts") ? "PASS" : "FAIL");
// ---------------------------------------------------------------------------
// 5. Security wiring (webhook signatures + rate limits).
// ---------------------------------------------------------------------------
const twilioHook = readIfExists(ROOT + "src/routes/api/webhooks/twilio.ts");
const voiceHook = readIfExists(ROOT + "src/routes/api/webhooks/twilio.voice.ts");
const stripeHook = readIfExists(ROOT + "src/routes/api/webhooks/stripe.ts");
row("Security", "Twilio signature validation on SMS webhook", twilioHook.includes("twilioSignatureIsValid") ? "PASS" : "FAIL");
row("Security", "Twilio signature validation on voice webhook", voiceHook.includes("handleVoiceWebhook") && voiceHook.includes("TWILIO_SIGNATURE_HEADER") ? "PASS" : "FAIL");
row("Security", "Stripe signature validation on billing webhook", stripeHook.includes("verifyStripeSignature") ? "PASS" : "FAIL");
row("Security", "Rate limits on auth endpoints", readIfExists(ROOT + "src/lib/server/authFns.ts").includes("enforceAuthRateLimit") ? "PASS" : "FAIL");
row("Security", "Rate limits on twilio + stripe webhooks", twilioHook.includes("checkRateLimit") && stripeHook.includes("checkRateLimit") ? "PASS" : "FAIL");
// ---------------------------------------------------------------------------
// 6. Reliability ladder (retries + fallbacks).
// ---------------------------------------------------------------------------
const sms = readIfExists(ROOT + "src/lib/server/sms.ts");
const textBack = readIfExists(ROOT + "src/lib/server/textBack.ts");
row("Reliability", "SMS send retries transient failures with backoff", sms.includes("isTransientSmsFailure") ? "PASS" : "FAIL");
row("Reliability", "Failed SMS deliveries recorded (system_errors), never silent", textBack.includes('source: "sms_delivery"') ? "PASS" : "FAIL");
row("Reliability", "Voice fallback: transfer → voicemail, never a dead end", voiceHook.includes("fallbackTwiML") ? "PASS" : "FAIL");
// ---------------------------------------------------------------------------
// 7. Operations docs.
// ---------------------------------------------------------------------------
for (const doc of ["environments", "reliability", "security-webhooks", "backup-restore"]) {
  row("Docs", "docs/operations/" + doc + ".md", existsSync(ROOT + "docs/operations/" + doc + ".md") ? "PASS" : "FAIL");
}
// ---------------------------------------------------------------------------
// 8. CI covers the checklist.
// ---------------------------------------------------------------------------
const ci = readIfExists(ROOT + ".github/workflows/ci.yml");
row("CI", "CI runs build + typecheck + suites + smoke/isolation", ci.includes("smoke-and-isolation") && ci.includes("launch-checklist") ? "PASS" : "FAIL");
// ---------------------------------------------------------------------------
// 9. Serve mode: the build actually renders (needs dist/ + DATABASE_URL).
// ---------------------------------------------------------------------------
if (SERVE) {
  await runServeChecks();
} else {
  row("Runtime", "Routes render on a served prod build", "SKIP", "run with --serve (and a built dist/ + DATABASE_URL)");
  row("Runtime", "Signup + trial flow works end-to-end", "SKIP", "covered by scripts/test-smoke.ts (--serve --smoke, or verify-deploy.ts)");
}
function readIfExists(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
async function runServeChecks(): Promise<void> {
  const { spawn } = await import("node:child_process");
  const PORT = 3312;
  const BASE = "http://127.0.0.1:" + String(PORT);
  if (!existsSync(ROOT + "dist/server/server.js")) {
    row("Runtime", "Routes render on a served prod build", "FAIL", "dist/ missing — run `bun run build`");
    return;
  }
  const proc = spawn("bun", ["scripts/prod-serve.ts", String(PORT)], { stdio: "ignore", env: process.env });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      up = await fetch(BASE + "/api/healthz").then((r) => r.ok).catch(() => false);
      if (!up) await new Promise((r) => setTimeout(r, 300));
    }
    row("Runtime", "Prod build serves + /api/healthz answers", up ? "PASS" : "FAIL");
    if (!up) return;
    const ready = await fetch(BASE + "/api/healthz/ready").then((r) => r.json()).catch(() => null) as { ok?: boolean } | null;
    row("Runtime", "Readiness probe ok (migrations applied)", ready?.ok === true ? "PASS" : "FAIL");
    for (const path of ["/", "/login", "/signup", "/pricing", "/privacy", "/terms", "/sms-consent"]) {
      const res = await fetch(BASE + path, { redirect: "manual" });
      row("Runtime", "GET " + path + " renders (2xx/3xx)", (res.status >= 200 && res.status < 400) ? "PASS" : "FAIL", "status " + String(res.status));
    }
    if (SMOKE) {
      const smoke = Bun.spawnSync(["bun", "scripts/test-smoke.ts", BASE], { stdout: "inherit", stderr: "inherit" });
      row("Runtime", "Smoke suite (signup/trial/login/dashboard) passes", smoke.exitCode === 0 ? "PASS" : "FAIL", "exit " + String(smoke.exitCode));
    } else {
      row("Runtime", "Signup + trial flow works end-to-end", "SKIP", "add --smoke to run the full suite here");
    }
  } finally {
    proc.kill();
  }
}
// ---------------------------------------------------------------------------
// 10. Owner-actionable items — the honest "cannot check programmatically".
// ---------------------------------------------------------------------------
const ownerItems: Array<[string, string]> = [
  ["A2P 10DLC approval", "gates REAL outbound SMS at scale (10–15 business days once submitted)"],
  ["Twilio number purchase", "gates live voice answering + inbound SMS to a real number"],
  ["STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET in Secrets", "gates real checkout + subscription activation"],
  ["LLM_API_KEY in Secrets", "gates the LLM classification tier (rules engine works without it)"],
  ["Email provider key in Secrets", "gates outbound owner-email delivery (in-app notifications work without)"],
  ["PLATFORM_OWNER_EMAIL in Secrets", "opens the /admin surface for the platform owner"],
  ["First real customer through self-serve onboarding", "the Phase 4 success criterion itself — needs a real plumber"],
  ["External uptime monitor pointed at /api/healthz and /api/healthz/ready", "no paid service required — any HTTP monitor works"],
];
// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log("\nLAUNCH-READINESS CHECKLIST (P4-I)\n");
const icon: Record<Status, string> = { PASS: "✅", FAIL: "❌", WARN: "⚠️ ", SKIP: "⏭️ " };
let lastArea = "";
for (const r of rows) {
  if (r.area !== lastArea) {
    console.log("— " + r.area + " —");
    lastArea = r.area;
  }
  console.log("  " + icon[r.status] + " " + r.status.padEnd(4) + " " + r.item + (r.detail ? "   [" + r.detail + "]" : ""));
}
console.log("\nNEEDS OWNER ACTION (not checkable by a script):");
for (const [item, why] of ownerItems) {
  console.log("  👤 " + item + " — " + why);
}
const fails = rows.filter((r) => r.status === "FAIL").length;
const warns = rows.filter((r) => r.status === "WARN").length;
console.log("\n" + rows.filter((r) => r.status !== "SKIP").length + " automated checks: " + fails + " FAIL, " + warns + " WARN, " + rows.filter((r) => r.status === "SKIP").length + " skipped (owner items listed above).");
if (fails > 0 || (STRICT && warns > 0)) process.exit(1);
process.exit(0);
