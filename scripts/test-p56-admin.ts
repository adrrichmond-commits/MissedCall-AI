#!/usr/bin/env bun
/**
 * P5-6 ADMIN BUSINESS METRICS SUITE.
 *
 * Runs against DATABASE_URL (journey-suite pattern; USE_LOCAL_POSTGRES=1
 * routes through the local-pg shim). Seeds 6 businesses in different states
 * (all CASCADE-deleted on exit) and asserts the /admin/metrics math.
 *
 * Layers:
 *   1. PURE compute checks (no DB): MRR from src/lib/pricing.ts prices (never
 *      literals), honest conversion (null rate when 0 trials — NEVER 0%),
 *      daysLeft flooring, filter sanitization (unknown values fall back).
 *   2. Access control: the gated read REFUSES without an admin session (the
 *      script runs request-less, so requirePlatformAdmin must reject) and
 *      static checks pin the gate ordering + SSR/RPC loader pattern + the
 *      route living under the gated /admin layout (P4 impersonation/audit
 *      rules untouched — this view is read-only and writes nothing).
 *   3. DB metrics checks (BASELINE-DELTA: platform-wide aggregates include
 *      pre-existing rows, so every number is asserted as after-minus-before):
 *      paying Starter+Pro MRR, active trials, conversion events, calls
 *      processed in windows, attention lists (ending soon / expired not
 *      converted / zero activity), demo exclusion, plan + window filters.
 *
 * Run: bun scripts/test-p56-admin.ts   (exit 0 = every check passed)
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import { createBusinessWithOwner } from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import { getPlan } from "../src/lib/pricing";
import {
  computeAdminMetrics,
  daysLeftUntil,
  planPriceCents,
  sanitizeAdminMetricsFilters,
  type AdminMetricsRaw,
} from "../src/lib/server/adminMetrics";
import { adminMetricsPage } from "../src/lib/server/adminReads";
import { adminMetricsRaw } from "../src/db/queries/adminMetrics";
import { readFileSync } from "node:fs";

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

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const NOW = new Date();

// ---------------------------------------------------------------------------
// 1. Pure compute — the honesty rules
// ---------------------------------------------------------------------------

checkEq("pricing: starter price resolves from the config module", planPriceCents("starter"), getPlan("starter")!.priceCents);
checkEq("pricing: pro price resolves from the config module", planPriceCents("pro"), getPlan("pro")!.priceCents);

const RAW_EMPTY: AdminMetricsRaw = {
  planStatusCounts: [],
  totalAccounts: 0,
  signupsInWindow: null,
  callsInWindow: 0,
  callsBusinesses: 0,
  trialStarts: 0,
  paidAccounts: 0,
  activeTrials: 0,
  trialEndingSoon: [],
  trialsExpiredNotConverted: [],
  zeroActivity: [],
  demoCount: 0,
};

// Zero-trial conversion must be null (never a misleading 0%).
const zeroAll = computeAdminMetrics(RAW_EMPTY, { plan: "all", window: "all" }, NOW);
checkEq("honesty: conversion rate with 0 trials is null", zeroAll.conversion.ratePct, null);
checkEq("honesty: MRR with no paying accounts is 0", zeroAll.mrr.cents, 0);

// MRR math: prices × paying accounts, straight from pricing.ts.
const starterPrice = getPlan("starter")!.priceCents;
const proPrice = getPlan("pro")!.priceCents;
const rawPaid: AdminMetricsRaw = {
  ...RAW_EMPTY,
  planStatusCounts: [
    { plan: "starter", subscriptionStatus: "active", n: 2 },
    { plan: "pro", subscriptionStatus: "active", n: 1 },
    { plan: "starter", subscriptionStatus: "past_due", n: 1 },
    { plan: "starter", subscriptionStatus: "canceled", n: 1 },
    { plan: "starter", subscriptionStatus: "trialing", n: 1 },
    { plan: "trial", subscriptionStatus: null, n: 3 },
  ],
  totalAccounts: 9,
  activeTrials: 3,
  trialStarts: 4,
  paidAccounts: 2,
};
const paid = computeAdminMetrics(rawPaid, { plan: "all", window: "all" }, NOW);
checkEq(
  "mrr: 2 starter + 1 pro paying = 2×starter + pro (from pricing.ts)",
  paid.mrr.cents,
  2 * starterPrice + proPrice,
);
checkEq("mrr: paying accounts counted only on active status", paid.mrr.payingAccounts, 3);
checkEq("mrr: past_due surfaces in the accounts breakdown, not MRR", paid.accounts.pastDue, 1);
checkEq("mrr: canceled surfaces in the accounts breakdown", paid.accounts.canceled, 1);
checkEq("mrr: trialing (Stripe) surfaces in the accounts breakdown", paid.accounts.trialing, 1);
checkEq("accounts: trial-plan rows counted", paid.accounts.trial, 3);
checkEq("accounts: noSubscription counts null-status rows", paid.accounts.noSubscription, 3);
checkEq("distribution: trial", paid.planDistribution.trial, 3);
checkEq("distribution: starter", paid.planDistribution.starter, 5);
checkEq("distribution: pro", paid.planDistribution.pro, 1);
checkEq("conversion: 2 paid of 4 starts = 50%", paid.conversion.ratePct, 50);
checkEq("trials: active trials from the raw count", paid.trials.active, 3);

// Conversion rounds, and never divides by zero.
const rawOne: AdminMetricsRaw = { ...RAW_EMPTY, trialStarts: 3, paidAccounts: 1 };
checkEq("conversion: 1/3 rounds to 33%", computeAdminMetrics(rawOne, { plan: "all", window: "all" }, NOW).conversion.ratePct, 33);

// daysLeft: ceils partial days (urgency — "1d left" while < 24h), floors at 0.
checkEq("daysLeft: 6h left = 1 (ceil: less than a day)", daysLeftUntil(new Date(NOW.getTime() + 6 * HOUR).toISOString(), NOW), 1);
checkEq("daysLeft: 30h left = 2", daysLeftUntil(new Date(NOW.getTime() + 30 * HOUR).toISOString(), NOW), 2);
checkEq("daysLeft: past date clamps to 0", daysLeftUntil(new Date(NOW.getTime() - 5 * DAY).toISOString(), NOW), 0);

// Filter sanitization: unknown values fall back to defaults (never raw input → SQL).
checkTrue("filters: garbage plan → all", sanitizeAdminMetricsFilters({ plan: "'; DROP TABLE businesses;--" }).plan === "all");
checkTrue("filters: garbage window → all", sanitizeAdminMetricsFilters({ window: 42 }).window === "all");
checkTrue("filters: valid plan kept", sanitizeAdminMetricsFilters({ plan: "pro" }).plan === "pro");
checkTrue("filters: valid window kept", sanitizeAdminMetricsFilters({ window: "30d" }).window === "30d");

// Plan filter concentrates MRR on the chosen plan.
const rawMix: AdminMetricsRaw = {
  ...RAW_EMPTY,
  planStatusCounts: [
    { plan: "starter", subscriptionStatus: "active", n: 1 },
    { plan: "pro", subscriptionStatus: "active", n: 2 },
  ],
  totalAccounts: 3,
};
checkEq(
  "filters: plan=starter MRR only counts starter rows",
  computeAdminMetrics(rawMix, { plan: "starter", window: "all" }, NOW).mrr.cents,
  starterPrice,
);

// ---------------------------------------------------------------------------
// 2. Access control — no admin session, no metrics
// ---------------------------------------------------------------------------

// Static: the plain read gates FIRST (test-admin.ts convention).
const readsSrc = readFileSync(new URL("../src/lib/server/adminReads.ts", import.meta.url), "utf8");
{
  const seg = readsSrc.slice(readsSrc.indexOf("export async function adminMetricsPage"));
  checkTrue("gate: adminMetricsPage calls requirePlatformAdmin first", /await requirePlatformAdmin\(\)/.test(seg.slice(0, 900)));
  checkTrue("gate: adminMetricsPage gated BEFORE its query", seg.indexOf("requirePlatformAdmin()") < seg.indexOf("adminMetricsRaw("));
}
const fnsSrc = readFileSync(new URL("../src/lib/server/adminFns.ts", import.meta.url), "utf8");
checkTrue("gate: adminMetricsFn delegates to the gated plain fn", /adminMetricsPage\(data\)/.test(fnsSrc));
const routeSrc = readFileSync(new URL("../src/routes/admin/metrics.tsx", import.meta.url), "utf8");
checkTrue("gate: route lives under /admin (layout gate applies)", routeSrc.includes('createFileRoute("/admin/metrics")'));
checkTrue("gate: route loader uses the SSR plain-read branch (PR #27 pattern)", routeSrc.includes("import.meta.env.SSR") && routeSrc.includes('~/lib/server/adminReads'));
checkTrue("gate: route has NO session/cookie code of its own (layout owns auth)", !routeSrc.includes("auth.server") && !routeSrc.includes("getCookie"));
const layoutSrc = readFileSync(new URL("../src/routes/admin.tsx", import.meta.url), "utf8");
checkTrue("gate: /admin layout gate untouched (adminGate in beforeLoad)", layoutSrc.includes("adminGate") && layoutSrc.includes("beforeLoad"));
checkTrue("impersonation: layout still renders the view-as banner", layoutSrc.includes("Viewing as"));
// The SQL layer must be read-only (no writes on the metrics surface) — with
// line AND block comments stripped so prose can't fool the check.
const qSrc = readFileSync(new URL("../src/db/queries/adminMetrics.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/--.*$/gm, "");
checkTrue("read-only: metrics SQL has no INSERT", !/INSERT\s+INTO/i.test(qSrc));
checkTrue("read-only: metrics SQL has no UPDATE/DELETE", !/\bUPDATE\b/i.test(qSrc) && !/DELETE\s+FROM/i.test(qSrc));

// Runtime: with NO request context (this script), the gate must refuse.
{
  const res = await adminMetricsPage({ plan: "all", window: "all" });
  checkTrue("refusal: request-less call is refused", !res.ok, JSON.stringify(res).slice(0, 120));
  checkTrue(
    "refusal: refused with 401/404 (no data leaked)",
    !res.ok && (res.status === 401 || res.status === 404),
    res.ok ? "ok:true" : String(res.status),
  );
  if (!res.ok) checkTrue("refusal: error message is generic", res.error === "Authentication required." || res.error === "Not found.", res.error);
}

// ---------------------------------------------------------------------------
// 3. DB metrics — baseline BEFORE seeding, deltas after
// ---------------------------------------------------------------------------

const pw = await hashPassword("p56-test-password-1234");
const biz: { id: string; name: string }[] = [];

async function metrics(plan: "all" | "starter" | "pro" | "trial", window: "all" | "7d" | "30d" | "90d") {
  const now = new Date();
  return computeAdminMetrics(await adminMetricsRaw({ plan, window }, now), { plan, window }, now);
}

// Sweep any leftover rows from a crashed earlier run (belt and braces; the
// suite is self-cleaning at exit too).
await query(`DELETE FROM businesses WHERE name LIKE 'P56 %'`);

const before = {
  all: await metrics("all", "all"),
  s7: await metrics("all", "7d"),
  s90: await metrics("all", "90d"),
  starter: await metrics("starter", "all"),
  pro7: await metrics("pro", "7d"),
};

async function seed(name: string): Promise<{ id: string }> {
  const { business } = await createBusinessWithOwner({
    businessName: name,
    ownerEmail: `owner-${Date.now()}-${Math.floor(Math.random() * 1e6)}@p56.test`,
    ownerFullName: "P56 Owner",
    passwordHash: pw,
  });
  biz.push({ id: business.id, name });
  return { id: business.id };
}

const B_PAYING_STARTER = await seed("P56 B1 Paying Starter");
const B_PAYING_PRO = await seed("P56 B2 Paying Pro");
const B_ENDING = await seed("P56 B3 Trial Ending");
const B_EXPIRED = await seed("P56 B4 Expired Trial");
const B_DORMANT = await seed("P56 B5 Dormant");

try {
  // Shape the five businesses into distinct states.
  await query(
    `UPDATE businesses SET plan='starter', subscription_status='active',
       trial_ends_at = now() - interval '2 days', stripe_customer_id='cus_p56_1'
     WHERE id=$1`,
    [B_PAYING_STARTER.id],
  );
  await query(
    `UPDATE businesses SET plan='pro', subscription_status='active',
       trial_ends_at = now() - interval '4 days', stripe_customer_id='cus_p56_2'
     WHERE id=$1`,
    [B_PAYING_PRO.id],
  );
  // Ending soon: trial window closes within 2 days (owner logged in once).
  await query(
    `UPDATE businesses SET trial_ends_at = $2::timestamptz, created_at = now() - interval '12 days'
     WHERE id=$1`,
    [B_ENDING.id, new Date(NOW.getTime() + 2 * DAY)],
  );
  await query(`UPDATE users SET last_login_at = now() - interval '1 hour' WHERE business_id=$1`, [B_ENDING.id]);
  // Expired trial, never converted (no activity of any kind).
  await query(
    `UPDATE businesses SET trial_ends_at = $2::timestamptz, created_at = now() - interval '20 days'
     WHERE id=$1`,
    [B_EXPIRED.id, new Date(NOW.getTime() - 3 * DAY)],
  );
  // Dormant: signed up 30 days ago, nothing ever happened, trial long gone.
  await query(
    `UPDATE businesses SET trial_ends_at = $2::timestamptz, created_at = now() - interval '30 days'
     WHERE id=$1`,
    [B_DORMANT.id, new Date(NOW.getTime() - 16 * DAY)],
  );

  // Funnel events (first-occurrence rows): all five started trials; the two
  // paying businesses recorded 'paid'. Plus one DEMO trial_start that must
  // never move the conversion math (excluded by the is_demo=false join).
  for (const b of biz) {
    await query(
      `INSERT INTO funnel_events (business_id, stage) VALUES ($1, 'trial_start')
       ON CONFLICT (business_id, stage) DO NOTHING`,
      [b.id],
    );
  }
  await query(
    `INSERT INTO funnel_events (business_id, stage) VALUES ($1, 'paid') ON CONFLICT (business_id, stage) DO NOTHING`,
    [B_PAYING_STARTER.id],
  );
  await query(
    `INSERT INTO funnel_events (business_id, stage) VALUES ($1, 'paid') ON CONFLICT (business_id, stage) DO NOTHING`,
    [B_PAYING_PRO.id],
  );
  const demoSeed = await query(
    `INSERT INTO businesses (name, plan, trial_ends_at, is_demo)
     VALUES ('P56 DEMO must-not-count', 'trial', now() + interval '5 days', true)
     RETURNING id`,
    [],
  );
  const DEMO_ID = String((demoSeed[0] as { id: string }).id);
  biz.push({ id: DEMO_ID, name: "P56 DEMO must-not-count" });
  await query(
    `INSERT INTO funnel_events (business_id, stage) VALUES ($1, 'trial_start') ON CONFLICT (business_id, stage) DO NOTHING`,
    [DEMO_ID],
  );

  // A voice call on the Pro business (window metrics).
  await query(
    `INSERT INTO calls (business_id, call_sid, status, created_at)
     VALUES ($1, $2, 'completed', now())`,
    [B_PAYING_PRO.id, `CA_p56_${Date.now()}_${Math.floor(Math.random() * 1e6)}`],
  );

  // ---- Deltas: after-minus-before ---------------------------------------
  const all = await metrics("all", "all");
  const s7 = await metrics("all", "7d");
  const s90 = await metrics("all", "90d");
  const starter = await metrics("starter", "all");
  const pro7 = await metrics("pro", "7d");

  // Accounts: +6 seeded rows total; paying +2; trial-plan +4 (grid counts demo).
  checkEq("db: total accounts +6", all.accounts.total - before.all.accounts.total, 6);
  checkEq("db: paying accounts +2 (starter + pro, both active)", all.accounts.paying - before.all.accounts.paying, 2);
  checkEq("db: trial-plan accounts +4 (grid includes the demo row)", all.accounts.trial - before.all.accounts.trial, 4);
  checkEq("db: no subscription +4 (trials carry null status)", all.accounts.noSubscription - before.all.accounts.noSubscription, 4);

  // MRR: exactly one Starter + one Pro paying account seeded.
  checkEq(
    "db: MRR delta = starterPrice + proPrice (prices from pricing.ts)",
    all.mrr.cents - before.all.mrr.cents,
    starterPrice + proPrice,
  );
  checkEq("db: plan=starter MRR delta = starterPrice", starter.mrr.cents - before.starter.mrr.cents, starterPrice);
  checkEq("db: plan=pro MRR (7d window) delta = proPrice", pro7.mrr.cents - before.pro7.mrr.cents, proPrice);

  // Active trials: only B_ENDING sits inside a live window; demo excluded,
  // B_EXPIRED/B_DORMANT lapsed, paying rows left the trial plan.
  checkEq("db: active trials +1 (demo excluded)", all.trials.active - before.all.trials.active, 1);

  // Conversion events: +5 trial_starts ex-demo, +2 paid (demo excluded).
  checkEq("db: trialStarts +5 (demo trial_start NOT counted)", all.conversion.trialStarts - before.all.conversion.trialStarts, 5);
  checkEq("db: paid +2", all.conversion.paid - before.all.conversion.paid, 2);
  if (before.all.conversion.ratePct === null) {
    checkTrue("db: conversion rate now computable", all.conversion.ratePct !== null);
  }
  checkEq(
    "db: conversion rate consistent with its own counts",
    all.conversion.ratePct,
    Math.round((all.conversion.paid / all.conversion.trialStarts) * 100),
  );
  // Direct exclusion proof: the demo row exists but only in the unfiltered table.
  const demoEvents = await query(
    `SELECT count(*)::int AS n FROM funnel_events fe JOIN businesses b ON b.id = fe.business_id
     WHERE b.is_demo = true`,
    [],
  );
  checkTrue("db: demo funnel rows exist but are excluded by the join", Number((demoEvents[0] as { n: number }).n) >= 1);

  // Calls processed: +1 row, +1 business; all-time ≥ 7d window.
  checkEq("db: calls(all time) +1", all.callsProcessed.total - before.all.callsProcessed.total, 1);
  checkEq("db: calls businesses +1", all.callsProcessed.businesses - before.all.callsProcessed.businesses, 1);
  checkEq("db: the seeded call appears in the 7d window", s7.callsProcessed.total - before.s7.callsProcessed.total, 1);
  checkTrue("db: calls(all) ≥ calls(7d)", all.callsProcessed.total >= s7.callsProcessed.total);
  checkTrue("db: plan=pro 7d window counts the pro call", pro7.callsProcessed.total >= 1);

  // Signups in window: paying pair + demo are fresh (in 7d); B_ENDING/EXPIRED/
  // DORMANT were back-dated out of 7d but all six sit inside 90d.
  checkEq("db: signups(7d) +3", s7.signupsInWindow! - before.s7.signupsInWindow!, 3);
  checkEq("db: signups(90d) +6", s90.signupsInWindow! - before.s90.signupsInWindow!, 6);
  checkEq("db: window=all leaves signups null (not a fake 0)", all.signupsInWindow, null);

  // Attention lists contain exactly the seeded businesses.
  const endingIds = all.attention.trialEndingSoon.map((i) => i.businessId);
  checkTrue("attention: B_ENDING listed", endingIds.includes(B_ENDING.id));
  const endingItem = all.attention.trialEndingSoon.find((i) => i.businessId === B_ENDING.id);
  checkTrue(
    "attention: B_ENDING daysLeft is 1–2",
    endingItem !== undefined && endingItem.daysLeft !== undefined && endingItem.daysLeft >= 1 && endingItem.daysLeft <= 2,
  );

  const expiredIds = all.attention.trialsExpiredNotConverted.map((i) => i.businessId);
  checkTrue("attention: B_EXPIRED listed", expiredIds.includes(B_EXPIRED.id));
  checkTrue("attention: B_DORMANT also expired-not-converted", expiredIds.includes(B_DORMANT.id));
  checkTrue("attention: paying starter NOT in expired list", !expiredIds.includes(B_PAYING_STARTER.id));

  const zeroIds = all.attention.zeroActivity.map((i) => i.businessId);
  checkTrue("attention: B_DORMANT flagged zero-activity", zeroIds.includes(B_DORMANT.id));
  checkTrue("attention: B_EXPIRED also zero-activity (nothing ever happened)", zeroIds.includes(B_EXPIRED.id));
  checkTrue("attention: B_ENDING not flagged (owner logged in)", !zeroIds.includes(B_ENDING.id));
  checkTrue("attention: pro business not flagged (has a call)", !zeroIds.includes(B_PAYING_PRO.id));
  checkTrue(
    "attention: demo business NEVER flagged in any list",
    !zeroIds.includes(DEMO_ID) && !endingIds.includes(DEMO_ID) && !expiredIds.includes(DEMO_ID),
  );

  // Plan filter moves the attention lists (trial lists empty under plan=pro).
  const proAll = await metrics("pro", "all");
  checkEq(
    "filters: plan=pro trial attention lists empty",
    proAll.attention.trialEndingSoon.length + proAll.attention.trialsExpiredNotConverted.length,
    0,
  );
  checkEq("filters: plan=starter MRR excludes the pro row", starter.mrr.cents - before.starter.mrr.cents, starterPrice);
  checkTrue("db: view carries no NaN/Infinity anywhere", !JSON.stringify(all).includes("NaN") && !JSON.stringify(all).includes("Infinity"));
} finally {
  // Cleanup — self-cleaning, same contract as the other DB suites.
  for (const b of biz) {
    await query(`DELETE FROM businesses WHERE id=$1`, [b.id]);
  }
  const left = await query(`SELECT count(*)::int AS n FROM businesses WHERE name LIKE 'P56 %'`);
  checkEq("cleanup: all P5-6 test businesses removed", left[0] && (left[0] as { n: number }).n, 0);
  const leftEvents = await query(
    `SELECT count(*)::int AS n FROM funnel_events fe LEFT JOIN businesses b ON b.id = fe.business_id
     WHERE b.id IS NULL`,
    [],
  );
  checkEq("cleanup: no orphaned funnel events", leftEvents[0] && (leftEvents[0] as { n: number }).n, 0);
}

console.log(`\np56-admin: ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
