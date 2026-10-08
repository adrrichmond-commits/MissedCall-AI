#!/usr/bin/env bun
/**
 * WEEKLY OPS DIGEST SUITE.
 *
 * Layers:
 *   1. PURE checks (no DB): the 7-day window math, the period key, the
 *      shared conversion-rate honesty rule (null until trials start — the
 *      exact rule /admin/metrics renders as "—"), and buildOpsDigest's
 *      honest empty states: "No trials started yet.", "No new leads this
 *      week.", the quiet-week line, "Nothing needs attention.", "no line
 *      tests recorded yet" — and NEVER a fabricated 0% or invented count.
 *   2. STATIC wiring checks (no DB): the cron route keeps the CRON_SECRET
 *      gate order (503 unset → 401 wrong → rate limit → sweep); ci.yml's
 *      unit suites list contains ops-digest; the workflow pings
 *      /api/cron/ops-digest weekly with the x-cron-secret header; migration
 *      023 widens notifications_type_check; the rate-limit bucket exists;
 *      the sweep's delivery path is the EXISTING one (q.createNotification +
 *      src/lib/server/email.ts sendEmail — the payment-failure provider
 *      path), no new provider integration.
 *   3. DB checks (BASELINE-DELTA, journey-suite pattern): seed one real + one
 *      demo business, assert opsDigestRaw's after-minus-before numbers —
 *      leads in window by source, out-of-window exclusion, appointments by
 *      status, past-due payment failures, waiting takeovers, failed line
 *      tests, the phone-line rollup — and that demo businesses are excluded
 *      everywhere. All seed rows CASCADE-deleted on exit.
 *
 * Run: bun scripts/test-ops-digest.ts   (exit 0 = every check passed)
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import { createBusinessWithOwner } from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import { readFileSync } from "node:fs";
import { opsWeekWindow, opsDigestPeriodKey, buildOpsDigest } from "../src/lib/server/opsDigest";
import { conversionRatePct, computeAdminMetrics, type AdminMetricsRaw } from "../src/lib/server/adminMetrics";
import { opsDigestRaw, findPlatformAdminRecipient, type OpsDigestRaw } from "../src/db/queries/opsDigest";
import { NOTIFICATION_TYPES } from "../src/db/queries/notifications";
import { RATE_LIMITS } from "../src/lib/server/rateLimit";

if (process.env.USE_LOCAL_POSTGRES === "1") await installLocalPostgresShim();

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
function checkEq(name: string, got: unknown, want: unknown): void {
  checkTrue(name, got === want, "got " + String(got) + ", want " + String(want));
}
function checkContains(name: string, hay: string, needle: string): void {
  checkTrue(name, hay.includes(needle), "missing: " + JSON.stringify(needle));
}
function checkNotContains(name: string, hay: string, needle: string): void {
  checkTrue(name, !hay.includes(needle), "unexpected: " + JSON.stringify(needle));
}

// ---------------------------------------------------------------------------
// 1. Pure — window math + the shared honesty rules
// ---------------------------------------------------------------------------
const NOW = new Date("2026-10-12T06:17:00.000Z"); // a Monday 06:17 UTC
const DAY = 24 * 60 * 60_000;

const win = opsWeekWindow(NOW);
checkEq("window: start is exactly 7 days before now", win.startIso, "2026-10-05T06:17:00.000Z");
checkEq("window: end is the send instant", win.endIso, NOW.toISOString());
checkTrue("window: start < end", new Date(win.startIso).getTime() < new Date(win.endIso).getTime());

checkEq("periodKey: keyed by the Monday of the send week (UTC)", opsDigestPeriodKey(NOW), "weekly-2026-10-12");
checkEq(
  "periodKey: a mid-week re-ping resolves to the SAME key (idempotent)",
  opsDigestPeriodKey(new Date(NOW.getTime() + 3 * DAY)),
  "weekly-2026-10-12",
);

checkEq("conversion: 0 trials → null (never 0%)", conversionRatePct(0, 0), null);
checkEq("conversion: 2 paid of 4 starts = 50%", conversionRatePct(4, 2), 50);
const RAW_EMPTY: AdminMetricsRaw = {
  planStatusCounts: [], totalAccounts: 0, signupsInWindow: null, callsInWindow: 0, callsBusinesses: 0,
  trialStarts: 0, paidAccounts: 0, activeTrials: 0, trialEndingSoon: [], trialsExpiredNotConverted: [],
  zeroActivity: [], demoCount: 0,
};
checkEq(
  "p5-6 regression: computeAdminMetrics rate is still null on 0 trials after the extraction",
  computeAdminMetrics(RAW_EMPTY, { plan: "all", window: "all" }, NOW).conversion.ratePct,
  null,
);

// --- the honest quiet week -------------------------------------------------
const RAW_QUIET: OpsDigestRaw = {
  generatedAt: NOW.toISOString(),
  trials: { active: 0, startsToDate: 0, paidToDate: 0, startsThisWeek: 0 },
  leads: { total: 0, bySource: {} },
  appointments: { requested: 0, confirmed: 0 },
  attention: { paymentFailures: [], takeoversWaiting: [], failedLineTests: [] },
  lines: { businesses: 0, withPhone: 0, lineTest: { pass: 0, partial: 0, fail: 0, notConfigured: 0, running: 0, neverRun: 0 } },
};
const quiet = buildOpsDigest(RAW_QUIET, NOW);
checkTrue("quiet: everythingQuiet flag set", quiet.everythingQuiet);
checkContains("quiet: no-trials phrase present", quiet.text, "No trials started yet.");
checkContains("quiet: no-leads phrase present", quiet.text, "No new leads this week.");
checkContains(
  "quiet: the exact honest empty-state line",
  quiet.text,
  "Nothing happened this week — no trials, leads, or alerts. When pilots start signing up, this email fills in.",
);
checkContains("quiet: conversions to date rendered as a real 0 count", quiet.text, "Trial → paid conversions to date: 0 (rate: — — no trials have started yet)");
checkNotContains("quiet: NEVER a fabricated 0% rate", quiet.text, "0%");
checkContains("quiet: nothing-needs-attention line", quiet.text, "Nothing needs attention.");
checkContains("quiet: no line tests recorded", quiet.text, "no line tests recorded yet");
checkContains("quiet: subject marks the quiet week", quiet.subject, "(quiet week)");
checkContains("quiet: source rollup still honest at zero", quiet.text, "missed call: 0");
checkContains("quiet: honesty footer", quiet.text, "nothing is estimated, padded, or invented");

// --- an active week --------------------------------------------------------
const RAW_ACTIVE: OpsDigestRaw = {
  generatedAt: NOW.toISOString(),
  trials: { active: 2, startsToDate: 3, paidToDate: 1, startsThisWeek: 1 },
  leads: { total: 5, bySource: { missed_call: 3, web_form: 2, carrier_pigeon: 1 } },
  appointments: { requested: 2, confirmed: 1 },
  attention: {
    failedLineTests: [{ businessId: "b1", name: "Rapid Rooter", detail: "fail" }],
    takeoversWaiting: [{ businessId: "b1", name: "Rapid Rooter", detail: "emergency" }],
    paymentFailures: [{ businessId: "b2", name: "Acme Plumbing", detail: "pro" }],
  },
  lines: { businesses: 4, withPhone: 3, lineTest: { pass: 2, partial: 0, fail: 1, notConfigured: 1, running: 0, neverRun: 0 } },
};
const active = buildOpsDigest(RAW_ACTIVE, NOW);
checkEq("active: conversion 1/3 → 33%", active.trials.ratePct, 33);
checkNotContains("active: no fake empty-state line when there is activity", active.text, "Nothing happened this week");
checkNotContains("active: subject has no quiet marker", active.subject, "(quiet week)");
checkContains("active: leads by source renders known sources", active.text, "missed call: 3, web form: 2");
checkContains("active: unknown source passes through honestly (never dropped)", active.text, "carrier_pigeon: 1");
checkContains("active: failed line test named", active.text, "Rapid Rooter");
checkContains("active: waiting takeover named + reason", active.text, "waiting for human takeover: 1 thread (latest reason: emergency)");
checkContains("active: payment failure named", active.text, "Acme Plumbing");
checkContains("active: line rollup counts", active.text, "pass 2, partial 0, fail 1");
checkContains("active: phone coverage fraction", active.text, "3 of 4");
checkTrue("active: everythingQuiet false", !active.everythingQuiet);
checkEq("active: periodKey attached to the view", active.periodKey, "weekly-2026-10-12");

// ---------------------------------------------------------------------------
// 2. Static wiring — the cron gate, the scheduler, the migration, the path
// ---------------------------------------------------------------------------
const routeSrc = readFileSync(new URL("../src/routes/api/cron/ops-digest.ts", import.meta.url), "utf8");
checkTrue("cron: gated on x-cron-secret vs CRON_SECRET", routeSrc.includes('headers.get("x-cron-secret")') && routeSrc.includes("process.env.CRON_SECRET"));
checkTrue("cron: honest 503 when CRON_SECRET unset", routeSrc.includes("503"));
checkTrue("cron: 401 on a wrong secret", routeSrc.includes("401"));
checkTrue("cron: rate-limited on the ops_digest_cron bucket", routeSrc.includes('checkRateLimit("ops_digest_cron"'));
checkTrue("cron: delegates to runWeeklyOpsDigest", routeSrc.includes("runWeeklyOpsDigest"));

const ciSrc = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
checkTrue("ci: unit suites list includes ops-digest (suite list is hard-coded)", /suites="[^"]*\bops-digest\b[^"]*"/.test(ciSrc));

const wfSrc = readFileSync(new URL("../.github/workflows/cron-ops-digest.yml", import.meta.url), "utf8");
checkTrue("workflow: weekly Monday 06:17 UTC schedule", wfSrc.includes('cron: "17 6 * * 1"'));
checkTrue("workflow: pings the ops-digest endpoint on the live domain", wfSrc.includes("https://www.answermissedcalls.com/api/cron/ops-digest"));
checkTrue("workflow: sends the x-cron-secret header", wfSrc.includes("x-cron-secret"));
checkTrue("workflow: skips honestly when the CRON_SECRET Actions secret is absent", wfSrc.includes("is not set - scheduler inactive"));

const migSrc = readFileSync(new URL("../migrations/023_ops_digest.sql", import.meta.url), "utf8");
checkTrue("migration: widens notifications_type_check with ops_digest", migSrc.includes("notifications_type_check") && migSrc.includes("'ops_digest'"));

checkTrue("queries: NOTIFICATION_TYPES includes ops_digest (createNotification whitelist)", (NOTIFICATION_TYPES as readonly string[]).includes("ops_digest"));
checkTrue("rateLimit: ops_digest_cron bucket registered", "ops_digest_cron" in RATE_LIMITS);

const sweepSrc = readFileSync(new URL("../src/lib/server/opsDigestSweep.ts", import.meta.url), "utf8");
checkTrue("delivery: in-app via the ONE notification path (createNotification)", sweepSrc.includes("createNotification"));
checkTrue("delivery: email via the EXISTING provider path (lib/server/email sendEmail)", sweepSrc.includes('from "~/lib/server/email"') && sweepSrc.includes("sendEmail("));
checkTrue("delivery: email provider gate isEmailConfigured before sending", sweepSrc.includes("isEmailConfigured()"));
checkTrue("delivery: period idempotency via opsDigestSentForPeriod", sweepSrc.includes("opsDigestSentForPeriod"));
checkTrue("delivery: honest skip when no admin user", sweepSrc.includes("no_admin_user"));

// ---------------------------------------------------------------------------
// 3. DB checks — BASELINE-DELTA (seed, measure deltas, CASCADE-delete)
// ---------------------------------------------------------------------------
const PREFIX = "opsdigest-" + Date.now() + "-";
const passwordHash = await hashPassword("opsdigest-test-password");
let dbChecks = 0;
function dbOk(name: string, cond: boolean, detail = ""): void {
  checks++; dbChecks++;
  if (!cond) { failures++; console.log("FAIL " + name + (detail ? " — " + detail : "")); }
  else console.log("ok   " + name);
}

let realBizId: string | null = null;
let demoBizId: string | null = null;
try {
  const real = await createBusinessWithOwner({
    businessName: PREFIX + "rapid",
    ownerEmail: PREFIX + "owner@missedcall.test",
    ownerFullName: "Ops Digest Test Owner",
    passwordHash,
  });
  realBizId = real.business.id;
  const demo = await createBusinessWithOwner({
    businessName: PREFIX + "demo",
    ownerEmail: PREFIX + "demo@missedcall.test",
    ownerFullName: "Ops Digest Demo Owner",
    passwordHash,
  });
  demoBizId = demo.business.id;
  await query("UPDATE businesses SET is_demo = true WHERE id = $1", [demoBizId]);

  // Baseline read.
  const before = await opsDigestRaw(new Date(Date.now() - 7 * DAY), new Date());

  // Real business: phone, past-due subscription, failed line test.
  await query(
    `UPDATE businesses SET phone = '+13853365359', subscription_status = 'past_due',
       settings = COALESCE(settings, '{}'::jsonb) || $2::jsonb
     WHERE id = $1`,
    [realBizId, JSON.stringify({ lineTest: { status: "fail", finishedAt: new Date().toISOString(), legs: {} } })],
  );
  // Demo business also gets a phone + a lead — must be EXCLUDED everywhere.
  await query("UPDATE businesses SET phone = '+15550001111' WHERE id = $1", [demoBizId]);

  // Leads: 2 missed_call + 1 web_form in window (real biz), 1 out of window, 1 demo (excluded).
  const inWindow = new Date(Date.now() - 1 * DAY).toISOString();
  const outOfWindow = new Date(Date.now() - 8 * DAY).toISOString();
  for (const [source, at, biz] of [
    ["missed_call", inWindow, realBizId],
    ["missed_call", inWindow, realBizId],
    ["web_form", inWindow, realBizId],
    ["missed_call", outOfWindow, realBizId],
    ["missed_call", inWindow, demoBizId],
  ] as const) {
    await query(
      `INSERT INTO leads (business_id, source, service_need, contact_name, contact_phone, created_at)
       VALUES ($1, $2::lead_source, 'clogged drain', 'Test Contact', '+15550002222', $3::timestamptz)`,
      [biz, source, at],
    );
  }

  // Appointments: 1 requested + 1 confirmed created in window; 1 out of window.
  await query(
    `INSERT INTO appointments (business_id, service_summary, scheduled_at, status, created_at)
     VALUES ($1, 'Drain clearing', $2::timestamptz, 'requested', $2::timestamptz)`,
    [realBizId, inWindow],
  );
  await query(
    `INSERT INTO appointments (business_id, service_summary, scheduled_at, status, created_at)
     VALUES ($1, 'Water heater swap', $2::timestamptz, 'confirmed', $2::timestamptz)`,
    [realBizId, inWindow],
  );
  await query(
    `INSERT INTO appointments (business_id, service_summary, scheduled_at, status, created_at)
     VALUES ($1, 'Old job', $2::timestamptz, 'requested', $2::timestamptz)`,
    [realBizId, outOfWindow],
  );

  // A conversation still waiting for a human takeover.
  await query(
    `INSERT INTO conversations (business_id, customer_phone, handoff_status, handoff_reason)
     VALUES ($1, '+15550003333', 'needed', 'emergency')`,
    [realBizId],
  );

  const after = await opsDigestRaw(new Date(Date.now() - 7 * DAY), new Date());

  dbOk("leads: +3 in-window leads counted (out-of-window + demo excluded)", after.leads.total - before.leads.total === 3,
    `delta ${after.leads.total - before.leads.total}`);
  dbOk("leads: by source missed_call +2", (after.leads.bySource["missed_call"] ?? 0) - (before.leads.bySource["missed_call"] ?? 0) === 2);
  dbOk("leads: by source web_form +1", (after.leads.bySource["web_form"] ?? 0) - (before.leads.bySource["web_form"] ?? 0) === 1);
  dbOk("appointments: requested +1 in window", after.appointments.requested - before.appointments.requested === 1);
  dbOk("appointments: confirmed +1 in window", after.appointments.confirmed - before.appointments.confirmed === 1);
  dbOk("attention: past-due payment failure +1", after.attention.paymentFailures.length - before.attention.paymentFailures.length === 1);
  dbOk("attention: waiting takeover +1", after.attention.takeoversWaiting.length - before.attention.takeoversWaiting.length === 1);
  dbOk("attention: failed line test +1 with status detail",
    after.attention.failedLineTests.length - before.attention.failedLineTests.length === 1 &&
    (after.attention.failedLineTests.find((i) => i.businessId === realBizId)?.detail === "fail"));
  // Both seed businesses existed BEFORE the baseline read, so the rollup's
  // business count cannot change across the read pair. The demo-exclusion
  // proof: the real business gains a phone (+1 withPhone) while the demo
  // business ALSO gained one — a demo-inclusive rollup would show +2.
  dbOk("lines: business count stable across the read pair", after.lines.businesses - before.lines.businesses === 0,
    `delta ${after.lines.businesses - before.lines.businesses}`);
  dbOk("lines: withPhone +1 not +2 (demo's phone excluded)", after.lines.withPhone - before.lines.withPhone === 1);
  dbOk("lines: lineTest fail +1", after.lines.lineTest.fail - before.lines.lineTest.fail === 1);
  dbOk("lines: neverRun −1 (the real business left the bucket; the demo one never enters it)",
    after.lines.lineTest.neverRun - before.lines.lineTest.neverRun === -1);

  // The shared P5-6 funnel read keeps its shape (used for conversions-to-date).
  dbOk("shared funnel read returns both counters", typeof before.trials.startsToDate === "number" && typeof before.trials.paidToDate === "number");

  // Recipient resolution: shape only — the real admin email is never printed.
  const recipient = await findPlatformAdminRecipient();
  dbOk("recipient: resolves to null-or-valid shape",
    recipient === null || (typeof recipient.email === "string" && recipient.email.includes("@") && typeof recipient.businessId === "string"));

  // Build the digest from the REAL read for the quiet-week regression: a
  // zero-everything raw must still render the honest empty states.
  const realQuiet = buildOpsDigest(
    { ...before, trials: { ...before.trials, active: 0, startsThisWeek: 0 }, leads: { total: 0, bySource: {} }, appointments: { requested: 0, confirmed: 0 },
      attention: { paymentFailures: [], takeoversWaiting: [], failedLineTests: [] } },
    new Date(),
  );
  dbOk("db-derived quiet digest keeps the honest empty-state line", realQuiet.text.includes("Nothing happened this week"));
} finally {
  // CASCADE-deletes users/leads/appointments/conversations/etc.
  if (realBizId) await query("DELETE FROM businesses WHERE id = $1", [realBizId]);
  if (demoBizId) await query("DELETE FROM businesses WHERE id = $1", [demoBizId]);
}

console.log("");
console.log(`ops-digest: ${checks} checks, ${failures} failed`);
if (failures > 0) process.exit(1);
