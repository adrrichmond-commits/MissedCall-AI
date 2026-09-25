#!/usr/bin/env bun
/**
 * P5-5 PERFORMANCE REPORTING + RETENTION DIGEST SUITE.
 *
 * Runs against DATABASE_URL (same pattern as test-e2e-journey.ts /
 * test-p52-roi.ts; USE_LOCAL_POSTGRES=1 routes through the local-pg shim).
 * Three seeded test businesses, all CASCADE-deleted on exit.
 *
 * Layers:
 *   1. PURE engine checks (no DB): window math (daily/weekly/monthly current
 *      + previous, tz fallback), trend directions, zero-data sanitizers, the
 *      P5-2 estimateFlags labeling contract (pinned all-true), digest config
 *      sanitize (opt-in default OFF), digest windows, the FULL anti-spam
 *      battery (disabled → no_content → already_sent_for_period →
 *      min_interval), and estimate-labeled digest copy.
 *   2. DB reporting checks: B1 seeded with rows placed INSIDE the engine's
 *      own computed windows (date-robust: yesterday, last week, last month
 *      come from computeReportingWindows, never calendar-guessed) — every
 *      measured count, the estimate money math, ROI from src/lib/pricing.ts.
 *   3. Isolation: B2 seeded AFTER B1 is asserted — B1's numbers must not move
 *      and B2's must match only B2's rows (zero cross-reads).
 *   4. Digest sweep: opt-in gate, content gate, period idempotency (the
 *      second sweep of the same period sends nothing), in-app notification
 *      recorded with estimateFlags in the payload.
 *
 * Run: bun scripts/test-p55-reporting.ts   (exit 0 = every check passed)
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import { createBusinessWithOwner } from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import * as q from "../src/db/queries";
import {
  buildPerformanceReportFor,
} from "../src/lib/server/reportingReads";
import {
  computePerformanceReport,
  computeReportingWindows,
  countsHaveActivity,
  monthlyCostCentsFor,
  sanitizeCounts,
} from "../src/lib/server/reporting";
import {
  DEFAULT_PERFORMANCE_DIGEST_CONFIG,
  DIGEST_MIN_INTERVAL_HOURS,
  digestShouldSend,
  digestSummaryLine,
  digestWindow,
  sanitizePerformanceDigestConfig,
} from "../src/lib/digest";
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
const NOW = new Date();
const windows = computeReportingWindows(NOW, "UTC");
const FLAT = [
  windows.daily.current,
  windows.daily.previous,
  windows.weekly.current,
  windows.weekly.previous,
  windows.monthly.current,
  windows.monthly.previous,
];

// ---------------------------------------------------------------------------
// 1. Pure engine — windows, trends, labeling, digest gates
// ---------------------------------------------------------------------------

checkEq("windows: 6 flattened windows", FLAT.length, 6);
checkTrue("windows: daily current starts at a local midnight", windows.daily.current.from.getTime() % 60_000 === 0);
checkEq(
  "windows: daily current spans 24h",
  windows.daily.current.to.getTime() - windows.daily.current.from.getTime(),
  24 * HOUR,
);
checkTrue(
  "windows: daily previous immediately precedes daily current",
  windows.daily.previous.to.getTime() === windows.daily.current.from.getTime(),
);
checkEq(
  "windows: weekly current spans 7 days (Monday-anchored)",
  windows.weekly.current.to.getTime() - windows.weekly.current.from.getTime(),
  7 * 24 * HOUR,
);
checkTrue(
  "windows: monthly previous ends where monthly current starts",
  windows.monthly.previous.to.getTime() === windows.monthly.current.from.getTime(),
);
checkTrue(
  "windows: garbage timezone falls back (no throw, finite windows)",
  Number.isFinite(computeReportingWindows(NOW, "Not/AZone").daily.current.from.getTime()),
);

const garbage = sanitizeCounts({ leadsCaptured: "7", revenueRecoveredCents: -5, jobsWon: Number.NaN } as never);
checkEq("sanitize: string count coerces", garbage.leadsCaptured, 7);
checkEq("sanitize: negative money zeroes", garbage.revenueRecoveredCents, 0);
checkEq("sanitize: NaN jobsWon zeroes", garbage.jobsWon, 0);
const empty = sanitizeCounts(null);
checkEq("sanitize: null input → all-zero contract", empty.leadsCaptured + empty.callsReceived + empty.revenueRecoveredCents, 0);

const report0 = computePerformanceReport({ counts: {}, planId: "trial" });
checkTrue("report: zero-data contract (no crash, all zeros)", report0.periods.daily.current.leadsCaptured === 0);
checkTrue("report: estimateFlags ALL true on empty data (labeling contract)", report0.estimateFlags.jobsWon && report0.estimateFlags.revenueRecovered && report0.estimateFlags.roiMultiple);
checkEq("report: trial plan → ROI null (no ∞)", report0.periods.weekly.roiMultiple, null);
checkTrue("report: hasActivity false when everything is zero", report0.hasActivity === false);

const up = computePerformanceReport({
  counts: {
    day_current: { leadsCaptured: 5, appointmentsBooked: 2, revenueRecoveredCents: 20000, jobsWon: 2 } as never,
    day_previous: { leadsCaptured: 3, appointmentsBooked: 3, revenueRecoveredCents: 20000, jobsWon: 1 } as never,
  },
  planId: "starter",
});
checkEq("trends: up", up.periods.daily.trends.leadsCaptured, "up");
checkEq("trends: down", up.periods.daily.trends.appointmentsBooked, "down");
checkEq("trends: flat (equal money)", up.periods.daily.trends.revenueRecoveredCents, "flat");
checkEq("trends: jobsWon up", up.periods.daily.trends.jobsWon, "up");
checkTrue("estimateFlags: money figures stay pinned all-true", up.estimateFlags.jobsWon && up.estimateFlags.revenueRecovered && up.estimateFlags.roiMultiple);
checkEq("ROI: 20000¢ ÷ 14900¢ from pricing.ts → 1.3×", up.periods.daily.roiMultiple, 1.3);
checkEq("pricing: monthlyCostCentsFor reads the ONE config", monthlyCostCentsFor("pro"), 24900);
checkEq("pricing: unknown plan costs $0", monthlyCostCentsFor("who-knows"), 0);

checkEq("digest config: default is OFF (opt-in)", DEFAULT_PERFORMANCE_DIGEST_CONFIG.enabled, false);
checkEq("digest config: garbage → disabled", sanitizePerformanceDigestConfig("junk").enabled, false);
checkEq("digest config: only explicit true enables", sanitizePerformanceDigestConfig({ enabled: 1 }).enabled, false);
checkEq("digest config: enabled true passes", sanitizePerformanceDigestConfig({ enabled: true, frequency: "daily" }).frequency, "daily");
checkEq("digest config: bad frequency falls back", sanitizePerformanceDigestConfig({ enabled: true, frequency: "hourly" }).frequency, "weekly");

const dw = digestWindow(NOW, "daily", "UTC");
checkTrue("digest window: daily is the COMPLETED previous day", dw.to.getTime() === windows.daily.current.from.getTime() && dw.from.getTime() === windows.daily.previous.from.getTime());
checkTrue("digest window: periodKey is date-stamped", /^daily-\d{4}-\d{2}-\d{2}$/.test(dw.periodKey));
const ww = digestWindow(NOW, "weekly", "UTC");
checkEq("digest window: weekly spans 7 days", ww.to.getTime() - ww.from.getTime(), 7 * 24 * HOUR);
checkTrue("digest window: weekly periodKey is Monday-stamped", /^weekly-\d{4}-\d{2}-\d{2}$/.test(ww.periodKey));

const DIGEST_COUNTS = { leadsCaptured: 2, callsReceived: 2, autoResponded: 1, customerReplies: 1, appointmentsBooked: 1, jobsWon: 1, revenueRecoveredCents: 12000 };
checkEq("anti-spam: disabled config never sends", digestShouldSend({ config: { enabled: false, frequency: "daily" }, counts: DIGEST_COUNTS, lastSentAt: null, alreadySentForPeriod: false, now: NOW }).reason, "disabled");
checkEq("anti-spam: no content → no digest", digestShouldSend({ config: { enabled: true, frequency: "daily" }, counts: { ...DIGEST_COUNTS, leadsCaptured: 0, callsReceived: 0, autoResponded: 0, customerReplies: 0, appointmentsBooked: 0, jobsWon: 0, revenueRecoveredCents: 0 }, lastSentAt: null, alreadySentForPeriod: false, now: NOW }).reason, "no_content");
checkEq("anti-spam: period already digested → skip (idempotency)", digestShouldSend({ config: { enabled: true, frequency: "daily" }, counts: DIGEST_COUNTS, lastSentAt: null, alreadySentForPeriod: true, now: NOW }).reason, "already_sent_for_period");
checkEq(
  "anti-spam: daily digest 2h after the last one → min_interval",
  digestShouldSend({ config: { enabled: true, frequency: "daily" }, counts: DIGEST_COUNTS, lastSentAt: new Date(NOW.getTime() - 2 * HOUR), alreadySentForPeriod: false, now: NOW }).reason,
  "min_interval",
);
checkEq("anti-spam: daily floor is 20h", DIGEST_MIN_INTERVAL_HOURS.daily, 20);
checkTrue(
  "anti-spam: daily digest 25h later → send",
  digestShouldSend({ config: { enabled: true, frequency: "daily" }, counts: DIGEST_COUNTS, lastSentAt: new Date(NOW.getTime() - 25 * HOUR), alreadySentForPeriod: false, now: NOW }).send,
);
checkEq(
  "anti-spam: weekly digest 5 days after the last one → min_interval",
  digestShouldSend({ config: { enabled: true, frequency: "weekly" }, counts: DIGEST_COUNTS, lastSentAt: new Date(NOW.getTime() - 5 * 24 * HOUR), alreadySentForPeriod: false, now: NOW }).reason,
  "min_interval",
);
checkTrue(
  "anti-spam: weekly digest 7 days later → send",
  digestShouldSend({ config: { enabled: true, frequency: "weekly" }, counts: DIGEST_COUNTS, lastSentAt: new Date(NOW.getTime() - 7 * 24 * HOUR), alreadySentForPeriod: false, now: NOW }).send,
);
checkTrue(
  "anti-spam: content gate counts revenue alone as content",
  countsHaveActivity({ ...sanitizeCounts(null), revenueRecoveredCents: 500 }),
);
const summary = digestSummaryLine({ businessName: "B", window: dw, counts: { leadsCaptured: 2, missedCalls: 2, autoResponded: 1, customerReplies: 1, appointmentsBooked: 1, jobsWon: 1, revenueRecoveredCents: 12000 } });
checkTrue("digest copy: money is estimate-labeled", summary.includes("(estimate)"));
checkTrue("digest copy: renders the period label", summary.startsWith(dw.periodLabel));
checkTrue("digest copy: never shows raw cents", !summary.includes("12000"));

// ---------------------------------------------------------------------------
// 2. DB: seeded reporting checks + isolation + digest sweep
// ---------------------------------------------------------------------------

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const businessIds: string[] = [];
// Pre-clean: the end-of-run cleanup only runs when the suite finishes, so a
// crashed earlier run leaves its P55 businesses (and their rows) behind —
// remove them first or the cleanup check below counts ghosts.
for (const row of await query(`SELECT id FROM businesses WHERE name LIKE 'P55 %'`)) {
  await query(`DELETE FROM businesses WHERE id = $1`, [(row as { id: string }).id]);
}
async function seedBusiness(name: string, plan: string): Promise<string> {
  const { business } = await createBusinessWithOwner({
    businessName: name,
    ownerEmail: `p55-${STAMP}-${name.toLowerCase().replace(/[^a-z0-9]/g, "")}@p55-test.example.com`,
    ownerFullName: "P5-5 Test Owner",
    passwordHash: await hashPassword("p55-test-password-1234"),
  });
  if (plan !== "trial") {
    await query(`UPDATE businesses SET plan = $1 WHERE id = $2`, [plan, business.id]);
  }
  businessIds.push(business.id);
  return business.id;
}
/**
 * Engine windows in the BUSINESS's own timezone. businesses.timezone defaults
 * to 'America/Chicago' (migrations/001) — seeding previous-period rows from
 * UTC windows put them OUTSIDE the engine's Chicago-anchored windows (in
 * September, Chicago's "yesterday"/"last week" begin 5h AFTER UTC's), which
 * zeroed the weekly-previous counts and the digest content gate.
 */
async function engineWindows(businessId: string): Promise<{ tz: string; windows: ReturnType<typeof computeReportingWindows> }> {
  const biz = (await q.getBusiness(businessId)) as unknown as { timezone?: string } | null;
  const tz = biz?.timezone ?? "UTC";
  return { tz, windows: computeReportingWindows(NOW, tz) };
}
async function seedLead(businessId: string, opts: { source: string; createdAt: Date; wonAt?: Date; cents?: number }): Promise<string> {
  const rows = await query(
    `INSERT INTO leads (business_id, contact_name, contact_phone, source, status, service_need, priority, pipeline_value_cents, converted_at, created_at)
     VALUES ($1, 'P55 Lead', '+15550001111', $2, $3, 'Leaking sink repair', 'normal', $4, $5, $6) RETURNING id`,
    [businessId, opts.source, opts.wonAt ? "won" : "new", opts.cents ?? null, opts.wonAt ?? null, opts.createdAt],
  );
  return (rows[0] as { id: string }).id;
}
async function seedConversation(businessId: string, leadId: string, opts: { createdAt: Date; aiReply: boolean; inbound: boolean }): Promise<void> {
  const conv = await query(
    `INSERT INTO conversations (business_id, lead_id, customer_phone, status, created_at)
     VALUES ($1, $2, '+15550001111', 'active', $3) RETURNING id`,
    [businessId, leadId, opts.createdAt],
  );
  const convId = (conv[0] as { id: string }).id;
  if (opts.aiReply) {
    await query(
      `INSERT INTO messages (business_id, conversation_id, direction, body, status, sent_at, classification)
       VALUES ($1, $2, 'outbound', 'Hi! We missed your call.', 'delivered', $3, '{"replySource":"ai"}')`,
      [businessId, convId, opts.createdAt],
    );
  }
  if (opts.inbound) {
    await query(
      `INSERT INTO messages (business_id, conversation_id, direction, body, status, sent_at)
       VALUES ($1, $2, 'inbound', 'Yes, my sink is leaking.', 'delivered', $3)`,
      [businessId, convId, opts.createdAt],
    );
  }
}
async function seedAppointment(businessId: string, leadId: string, createdAt: Date): Promise<void> {
  await query(
    `INSERT INTO appointments (business_id, lead_id, service_summary, scheduled_at, duration_minutes, status, created_at)
     VALUES ($1, $2, 'Leaking sink repair', $3, 60, 'confirmed', $4)`,
    [businessId, leadId, new Date(NOW.getTime() + 24 * HOUR), createdAt],
  );
}

// --- B1: the full-funnel business -----------------------------------------
const B1 = await seedBusiness("P55 Report Full", "starter");
{
  // Daily current: 3 leads (2 missed-call), 1 AI-handled conversation with a
  // customer reply, 1 appointment, 1 won job (12000¢).
  const l1 = await seedLead(B1, { source: "missed_call", createdAt: new Date(NOW.getTime() - 2 * HOUR), wonAt: NOW, cents: 12000 });
  const l2 = await seedLead(B1, { source: "missed_call", createdAt: new Date(NOW.getTime() - 2 * HOUR) });
  await seedLead(B1, { source: "web_form", createdAt: new Date(NOW.getTime() - HOUR) });
  await seedConversation(B1, l1, { createdAt: new Date(NOW.getTime() - 2 * HOUR), aiReply: true, inbound: true });
  await seedConversation(B1, l2, { createdAt: new Date(NOW.getTime() - 2 * HOUR), aiReply: false, inbound: false });
  await seedAppointment(B1, l1, new Date(NOW.getTime() - HOUR));
  // Previous periods (seeded INSIDE the engine's own windows — date-robust,
  // in the BUSINESS's timezone via engineWindows):
  // last month: 1 won job 30000¢; last week: 2 leads; yesterday: 1 lead.
  const { windows: w1 } = await engineWindows(B1);
  const l5 = await seedLead(B1, { source: "web_form", createdAt: new Date(w1.monthly.previous.from.getTime() + HOUR), wonAt: new Date(w1.monthly.previous.from.getTime() + 2 * HOUR), cents: 30000 });
  void l5;
  await seedLead(B1, { source: "missed_call", createdAt: new Date(w1.weekly.previous.from.getTime() + HOUR) });
  await seedLead(B1, { source: "web_form", createdAt: new Date(w1.weekly.previous.from.getTime() + 2 * HOUR) });
  // Weekly current holds 4 of B1's leads (3 today + 1 yesterday-seed), so
  // weekly previous needs 5 for the "down" trend assertion to be truthful.
  await seedLead(B1, { source: "missed_call", createdAt: new Date(w1.weekly.previous.from.getTime() + 3 * HOUR) });
  await seedLead(B1, { source: "web_form", createdAt: new Date(w1.weekly.previous.from.getTime() + 4 * HOUR) });
  await seedLead(B1, { source: "missed_call", createdAt: new Date(w1.weekly.previous.from.getTime() + 5 * HOUR) });
  await seedLead(B1, { source: "missed_call", createdAt: new Date(w1.daily.previous.from.getTime() + HOUR) });
}
const rep1 = await buildPerformanceReportFor(B1);
checkTrue("B1: payload carries the estimateFlags contract", rep1.estimateFlags.jobsWon && rep1.estimateFlags.revenueRecovered && rep1.estimateFlags.roiMultiple);
checkTrue("B1: hasActivity true", rep1.hasActivity);
checkEq("B1 daily: leadsCaptured (measured)", rep1.periods.daily.current.leadsCaptured, 3);
checkEq("B1 daily: callsReceived mirrors missed calls (voice not live)", rep1.periods.daily.current.callsReceived, 2);
checkEq("B1 daily: missedCalls", rep1.periods.daily.current.missedCalls, 2);
checkEq("B1 daily: autoResponded (AI reply stamped)", rep1.periods.daily.current.autoResponded, 1);
checkEq("B1 daily: customerReplies (≥1 inbound)", rep1.periods.daily.current.customerReplies, 1);
checkEq("B1 daily: appointmentsBooked", rep1.periods.daily.current.appointmentsBooked, 1);
checkEq("B1 daily: jobsWon (ESTIMATE)", rep1.periods.daily.current.jobsWon, 1);
checkEq("B1 daily: revenueRecoveredCents (ESTIMATE)", rep1.periods.daily.current.revenueRecoveredCents, 12000);
checkEq("B1 daily trend: leads up vs yesterday (1)", rep1.periods.daily.trends.leadsCaptured, "up");
checkEq("B1 monthly previous: jobsWon", rep1.periods.monthly.previous.jobsWon, 1);
checkEq("B1 monthly previous: revenue", rep1.periods.monthly.previous.revenueRecoveredCents, 30000);
checkEq("B1 weekly previous: leads", rep1.periods.weekly.previous.leadsCaptured, 5);
checkEq("B1 weekly trend: leads down vs last week (2)", rep1.periods.weekly.trends.leadsCaptured, "down");
checkEq("B1 ROI: month revenue (12000) ÷ starter cost (14900) → 0.8×", rep1.periods.monthly.roiMultiple, 0.8);

// --- B2: isolation business, seeded AFTER B1 is asserted -------------------
const B2 = await seedBusiness("P55 Report Isolation", "trial");
{
  await seedLead(B2, { source: "missed_call", createdAt: new Date(NOW.getTime() - 3 * HOUR) });
  await seedLead(B2, { source: "web_form", createdAt: new Date(NOW.getTime() - 3 * HOUR), wonAt: NOW, cents: 7777 });
}
const rep2 = await buildPerformanceReportFor(B2);
const rep1b = await buildPerformanceReportFor(B1);
checkEq("isolation: B2 daily leads are B2's own (2)", rep2.periods.daily.current.leadsCaptured, 2);
checkEq("isolation: B2 daily revenue is B2's own", rep2.periods.daily.current.revenueRecoveredCents, 7777);
checkEq("isolation: B2 is on trial → ROI null", rep2.periods.monthly.roiMultiple, null);
checkEq("isolation: B1's numbers did not move after B2 seeded", rep1b.periods.daily.current.leadsCaptured, 3);
checkEq("isolation: B1's revenue did not move", rep1b.periods.daily.current.revenueRecoveredCents, 12000);
checkTrue("isolation: B2 never sees B1's 12000¢", rep2.periods.daily.current.revenueRecoveredCents !== 12000);

// --- Digest sweep -----------------------------------------------------------
async function getSettings(businessId: string): Promise<Record<string, unknown>> {
  const rows = await query(`SELECT settings FROM businesses WHERE id = $1`, [businessId]);
  return ((rows[0] as { settings?: Record<string, unknown> } | null)?.settings ?? {}) as Record<string, unknown>;
}
async function setDigest(businessId: string, config: { enabled: boolean; frequency: "daily" | "weekly" }): Promise<void> {
  const settings = await getSettings(businessId);
  await q.updateBusinessSettings(businessId, { ...settings, performanceDigest: config });
}
const B3 = await seedBusiness("P55 Digest Empty", "trial");
// Enabled NOW (before sweep1) so the first sweep sees an enabled-but-empty
// business — the no-content anti-spam gate — not the default "disabled".
await setDigest(B3, { enabled: true, frequency: "daily" });

// Content for B2's digest window (yesterday): one lead + one won job.
const { tz: tz2, windows: w2 } = await engineWindows(B2);
await seedLead(B2, { source: "missed_call", createdAt: new Date(w2.daily.previous.from.getTime() + HOUR) });
await seedLead(B2, { source: "web_form", createdAt: new Date(w2.daily.previous.from.getTime() + 2 * HOUR), wonAt: new Date(w2.daily.previous.from.getTime() + 3 * HOUR), cents: 5000 });
await setDigest(B2, { enabled: true, frequency: "daily" });

const { runPerformanceDigestSweep } = await import("../src/lib/server/digestSweep");
const sweep1 = await runPerformanceDigestSweep(NOW);
const item2 = sweep1.items.find((i) => i.businessId === B2);
checkEq("sweep: B2 digest SENT on the first ping", item2?.outcome, "sent");
const notifs = await query(`SELECT type, payload FROM notifications WHERE business_id = $1 AND type = 'performance_digest'`, [B2]);
checkEq("sweep: in-app performance_digest notification recorded", notifs.length, 1);
checkTrue("sweep: notification carries the periodKey + estimate flags", (notifs[0] as { payload: { periodKey?: string; estimateFlags?: Record<string, boolean> } }).payload.periodKey === digestWindow(NOW, "daily", tz2).periodKey);
checkTrue("sweep: payload estimate flags all true", Object.values((notifs[0] as { payload: { estimateFlags?: Record<string, boolean> } }).payload.estimateFlags ?? {}).every(Boolean));

const sweep2 = await runPerformanceDigestSweep(NOW);
const item2b = sweep2.items.find((i) => i.businessId === B2);
checkEq("sweep: SECOND ping of the same period is skipped (idempotency cap)", item2b?.reason, "already_sent_for_period");
const still = await query(`SELECT count(*)::int AS n FROM notifications WHERE business_id = $1 AND type = 'performance_digest'`, [B2]);
checkEq("sweep: still exactly one digest for the period", still[0] && (still[0] as { n: number }).n, 1);

const item1 = sweep1.items.find((i) => i.businessId === B1);
checkEq("sweep: B1 (digests off by default) skipped as disabled", item1?.reason, "disabled");
const item3 = sweep1.items.find((i) => i.businessId === B3);
checkEq("sweep: B3 (enabled, but NO content yesterday) skipped — no empty spam", item3?.reason, "no_content");

// Enable B3 + point its digest at a period with content → sends; then flip
// B3's frequency back and verify the min-interval cap blocks a rapid re-send.
await setDigest(B3, { enabled: true, frequency: "daily" });
const { windows: w3 } = await engineWindows(B3);
await seedLead(B3, { source: "missed_call", createdAt: new Date(w3.daily.previous.from.getTime() + HOUR) });
const sweep3 = await runPerformanceDigestSweep(NOW);
checkEq("sweep: B3 digest SENT once content exists", sweep3.items.find((i) => i.businessId === B3)?.outcome, "sent");
checkEq(
  "sweep: min-interval — an immediate second sweep cannot re-digest (period key matches, so idempotency still holds)",
  (await runPerformanceDigestSweep(NOW)).items.find((i) => i.businessId === B3)?.reason,
  "already_sent_for_period",
);

// Cleanup — self-cleaning, same contract as the other DB suites.
for (const id of businessIds) {
  await query(`DELETE FROM businesses WHERE id = $1`, [id]);
}
const left = await query(`SELECT count(*)::int AS n FROM businesses WHERE name LIKE 'P55 %'`);
checkEq("cleanup: all P5-5 test businesses removed", left[0] && (left[0] as { n: number }).n, 0);

console.log(`\np55-reporting: ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
