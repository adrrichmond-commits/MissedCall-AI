#!/usr/bin/env bun
/**
 * Unit-style tests for the P3-D Revenue Recovered engine
 * (src/lib/server/revenue.ts) + query-layer contracts.
 * Run: bun scripts/test-revenue.ts — no DB, no network, no keys.
 *
 * Covers: period-boundary math (Monday weeks, month starts, business
 * timezones incl. DST-ambiguous dates and UTC fallback), bucket precedence,
 * the full computeRevenueMetrics guard set (zero data, NaN/division, clamps),
 * funnel stage ordering/sanitizing, and structural business-isolation checks
 * on the new query functions (same approach test-crm.ts ships).
 */
import {
  computePeriodBounds,
  bucketForPeriod,
  computeRevenueMetrics,
  funnelStages,
  FUNNEL_STAGES,
} from "../src/lib/server/revenue";
import { readFileSync } from "node:fs";

let checks = 0;
let failures = 0;
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
// 1. Period bounds — Monday weeks, month starts, timezone correctness
// ---------------------------------------------------------------------------

// A known Wednesday: 2024-01-17 (12:00 UTC). Its Monday is 2024-01-15.
{
  const wed = new Date("2024-01-17T12:00:00Z");
  const utc = computePeriodBounds(wed, "UTC");
  check("UTC week starts Monday 2024-01-15T00:00Z", utc.weekStart.toISOString(), "2024-01-15T00:00:00.000Z");
  check("UTC month starts 2024-01-01T00:00Z", utc.monthStart.toISOString(), "2024-01-01T00:00:00.000Z");

  // New York is UTC-5 in January: Wed 12:00Z = Wed 07:00 local. Same week.
  const ny = computePeriodBounds(wed, "America/New_York");
  check("NY week starts Monday 2024-01-15T05:00Z (local midnight)", ny.weekStart.toISOString(), "2024-01-15T05:00:00.000Z");
  check("NY month starts 2024-01-01T05:00Z", ny.monthStart.toISOString(), "2024-01-01T05:00:00.000Z");

  // Sunday is still "this week" (Monday-based): Sun 2024-01-21 local.
  const sun = computePeriodBounds(new Date("2024-01-21T12:00:00Z"), "UTC");
  check("Sunday buckets into the Monday-opened week", sun.weekStart.toISOString(), "2024-01-15T00:00:00.000Z");
  // Saturday 2024-01-20 also inside; next Monday 2024-01-22 rolls over.
  const mon = computePeriodBounds(new Date("2024-01-22T12:00:00Z"), "UTC");
  check("Next Monday rolls the week", mon.weekStart.toISOString(), "2024-01-22T00:00:00.000Z");

  // A Sunday that is the LAST day of a month: 2024-06-30 (Sunday). Its week
  // opened Monday 2024-06-24, and the month bucket must stay June 1.
  const jun30 = computePeriodBounds(new Date("2024-06-30T12:00:00Z"), "UTC");
  check("monthStart stays the 1st on a Sunday", jun30.monthStart.toISOString(), "2024-06-01T00:00:00.000Z");
  check("weekStart is the Monday that opened the week (Jun 24)", jun30.weekStart.toISOString(), "2024-06-24T00:00:00.000Z");

  // Month boundary: 2024-03-31 (Sunday) → week opened 2024-03-25, month March.
  const mar31 = computePeriodBounds(new Date("2024-03-31T12:00:00Z"), "UTC");
  check("monthStart March 1 for March 31", mar31.monthStart.toISOString(), "2024-03-01T00:00:00.000Z");
  // A Tuesday: week/month sanity mid-month.
  const tue = computePeriodBounds(new Date("2024-11-05T12:00:00Z"), "UTC"); // Tue
  check("Tue Nov 5 → week of Mon Nov 4", tue.weekStart.toISOString(), "2024-11-04T00:00:00.000Z");
}

// DST transitions — the two mornings a year that break naive math.
{
  // US spring-forward: 2024-03-10, 02:00 local does not exist in America/New_York.
  const spring = computePeriodBounds(new Date("2024-03-13T12:00:00Z"), "America/New_York");
  check("post-DST week start is EDT (-04:00)", spring.weekStart.toISOString(), "2024-03-11T04:00:00.000Z");
  // Fall-back: 2024-11-03, 01:00 local occurs twice in America/New_York.
  const fall = computePeriodBounds(new Date("2024-11-06T12:00:00Z"), "America/New_York");
  check("post-fall week start is EST (-05:00)", fall.weekStart.toISOString(), "2024-11-04T05:00:00.000Z");
  // Ambiguous midnight itself: Sunday 2024-11-03 05:30Z = 01:30 EDT local —
  // inside the week that opened Monday 2024-10-28 (still EDT, −04:00).
  const amb = computePeriodBounds(new Date("2024-11-03T05:30:00Z"), "America/New_York");
  check("ambiguous-date bounds resolve to that week's Monday (EDT)", amb.weekStart.toISOString(), "2024-10-28T04:00:00.000Z");
  // Lord Howe has a 30-minute DST shift — offset sampling must still work.
  const lh = computePeriodBounds(new Date("2024-11-06T12:00:00Z"), "Australia/Lord_Howe");
  checkTrue(
    "30-min DST zone yields a finite instant",
    !Number.isNaN(lh.weekStart.getTime()) && !Number.isNaN(lh.monthStart.getTime()),
    JSON.stringify(lh),
  );
}

// Broken inputs must never throw — UTC fallback keeps the engine total.
{
  const wed = new Date("2024-01-17T12:00:00Z");
  const badTz = computePeriodBounds(wed, "Mars/Olympus_Mons");
  check("unknown timezone falls back to UTC", badTz.weekStart.toISOString(), "2024-01-15T00:00:00.000Z");
  const nullTz = computePeriodBounds(wed, null);
  check("null timezone falls back to UTC", nullTz.weekStart.toISOString(), "2024-01-15T00:00:00.000Z");
  check("empty timezone falls back to UTC", computePeriodBounds(wed, "").weekStart.toISOString(), "2024-01-15T00:00:00.000Z");
  const badNow = computePeriodBounds(new Date("not-a-date"), "UTC");
  checkTrue("non-finite now still yields finite bounds", !Number.isNaN(badNow.weekStart.getTime()));
}

// ---------------------------------------------------------------------------
// 2. Bucketing — week > month > all precedence
// ---------------------------------------------------------------------------

{
  const bounds = computePeriodBounds(new Date("2024-01-17T12:00:00Z"), "UTC");
  check("inside week → week", bucketForPeriod(new Date("2024-01-16T08:00:00Z"), bounds), "week");
  check("month-but-not-week → month", bucketForPeriod(new Date("2024-01-03T08:00:00Z"), bounds), "month");
  check("before month → all", bucketForPeriod(new Date("2023-12-20T08:00:00Z"), bounds), "all");
  check("exactly at week start → week", bucketForPeriod(bounds.weekStart, bounds), "week");
  check("exactly at month start → month (not week)", bucketForPeriod(bounds.monthStart, bounds), "month");
  check("invalid date → null", bucketForPeriod(new Date("nope"), bounds), null);
  check("null date → null", bucketForPeriod(null, bounds), null);
}

// ---------------------------------------------------------------------------
// 3. computeRevenueMetrics — won/lost/open mixes, zero data, division guards
// ---------------------------------------------------------------------------

{
  const zero = computeRevenueMetrics({
    week: { wonLeads: 0, recoveredCents: 0 },
    month: { wonLeads: 0, recoveredCents: 0 },
    allTime: { wonLeads: 0, recoveredCents: 0 },
    leadsWithValue: 0,
    totalLeads: 0,
    missedCalls: 0,
    recoveredMissedCalls: 0,
    appointmentsFromRecovered: 0,
  });
  check("zero business: week is zeroed", zero.week, { wonLeads: 0, recoveredCents: 0 });
  check("zero business: all ratios null (— in UI)", [zero.revenuePerLeadCents, zero.conversionRate, zero.recoveryRate, zero.appointmentsPerRecoveredLead], [null, null, null, null]);
}

{
  // A realistic mixed month: won leads carry money; lost carries none; open
  // counts toward value-per-lead but never toward recovered revenue.
  const m = computeRevenueMetrics({
    week: { wonLeads: 1, recoveredCents: 35_000 },
    month: { wonLeads: 3, recoveredCents: 135_000 },
    allTime: { wonLeads: 9, recoveredCents: 450_000 },
    leadsWithValue: 20, // 9 won + 11 open carrying values (lost are NULL)
    totalLeads: 40, // 9 won + 7 lost + 24 still open — ALL captured leads
    missedCalls: 30,
    recoveredMissedCalls: 21,
    appointmentsFromRecovered: 27,
  });
  check("revenue per lead = 450000/20", m.revenuePerLeadCents, 22_500);
  check("conversion = 9/40 (all captured leads)", m.conversionRate, 0.225);
  check("recovery = 21/30", m.recoveryRate, 0.7);
  check("appts per recovered lead = 27/21", m.appointmentsPerRecoveredLead, 27 / 21);
  check("week/month/all pass through", [m.week.recoveredCents, m.month.recoveredCents, m.allTime.recoveredCents], [35_000, 135_000, 450_000]);
}

{
  // Denominator guards: recovered > missed (shouldn't happen, must clamp),
  // rates capped at 1, won > total leads, garbage numbers all rejected.
  const g = computeRevenueMetrics({
    week: { wonLeads: 5, recoveredCents: 1000 },
    month: { wonLeads: 5, recoveredCents: 1000 },
    allTime: { wonLeads: 5, recoveredCents: 1000 },
    leadsWithValue: 0, // division-by-zero guard → null
    totalLeads: 3, // won(5) > total(3) → rate capped, never > 1
    missedCalls: 0, // division-by-zero guard → null
    recoveredMissedCalls: 4,
    appointmentsFromRecovered: 2,
  });
  check("leadsWithValue=0 → revenuePerLead null", g.revenuePerLeadCents, null);
  check("totalLeads=0-ish → conversion capped at 1", g.conversionRate, 1);
  check("missedCalls=0 → recovery null", g.recoveryRate, null);
  check("recovered clamps to missed=0 → appts/lead null (no denominator)", g.appointmentsPerRecoveredLead, null);
}

{
  // NaN / Infinity / negative / string-number inputs sanitize to zero or null.
  const n = computeRevenueMetrics({
    week: { wonLeads: NaN, recoveredCents: -500 },
    month: { wonLeads: Infinity, recoveredCents: "2500" as unknown as number },
    allTime: { wonLeads: 2, recoveredCents: Number.NaN },
    leadsWithValue: -3,
    totalLeads: undefined as unknown as number,
    missedCalls: "12" as unknown as number,
    recoveredMissedCalls: 6,
    appointmentsFromRecovered: null as unknown as number,
  });
  check("NaN wonLeads sanitized to 0", n.week.wonLeads, 0);
  check("negative cents sanitized to 0", n.week.recoveredCents, 0);
  check("Infinity sanitized to 0", n.month.wonLeads, 0);
  check("numeric string accepted ('2500')", n.month.recoveredCents, 2500);
  check("NaN all-time cents → 0", n.allTime.recoveredCents, 0);
  check("negative leadsWithValue → ratio null", n.revenuePerLeadCents, null);
  check("undefined totalLeads → conversion null", n.conversionRate, null);
  check("string missedCalls accepted, 6/12", n.recoveryRate, 0.5);
  check("null appointments → appts/lead 0.0", n.appointmentsPerRecoveredLead, 0);
}

// ---------------------------------------------------------------------------
// 4. Funnel stages — order, labels, sanitizing
// ---------------------------------------------------------------------------

{
  check("stage list is the documented order", FUNNEL_STAGES.map((s) => s.key), [
    "callsReceived", "callsHandledByAi", "missedCalls", "missedCallsRecovered", "leads", "qualified", "appointments", "won",
  ]);
  const fs = funnelStages({
    callsReceived: 30, callsHandledByAi: 25, missedCalls: 30, missedCallsRecovered: 21,
    leads: 40, qualified: 12, appointments: 9, won: 9,
  });
  check("stages keep counts", fs.map((s) => s.count), [30, 25, 30, 21, 40, 12, 9, 9]);
  check("stages keep labels", fs[0].label, "Calls received");
  const dirty = funnelStages({
    callsReceived: NaN, callsHandledByAi: -1, missedCalls: 2.9, missedCallsRecovered: 0,
    leads: "7" as unknown as number, qualified: Infinity, appointments: null as unknown as number, won: undefined as unknown as number,
  });
  check("funnel sanitizes garbage to finite non-negative", dirty.map((s) => s.count), [0, 0, 2, 0, 7, 0, 0, 0]);
}

// ---------------------------------------------------------------------------
// 5. Query-layer contracts — business isolation is structural, no migration
// ---------------------------------------------------------------------------

{
  const src = readFileSync("src/db/queries/revenue.ts", "utf8");
  for (const fn of ["revenueMetrics", "missedCallRecoveryCounts", "appointmentsFromRecoveredLeads", "revenueFunnelCounts", "revenueDashboardPayload"]) {
    const idx = src.indexOf("export async function " + fn);
    checkTrue(`query exists: ${fn}`, idx >= 0);
    if (idx < 0) continue;
    const body = src.slice(idx, src.indexOf("\n}", idx));
    checkTrue(`${fn} takes businessId`, body.includes("businessId"));
  }
  // STRONGER than a per-function scan: isolation is enforced at the SQL level,
  // so assert it there — EVERY SQL statement in the module must filter or
  // sub-filter on business_id (the WHERE clause is the boundary). Splitting on
  // template-literal boundaries via the backticks is approximate but suffices
  // to catch any unscoped statement added later.
  const sqlStatements = src
    .split("`")
    .filter((_, i) => i % 2 === 1) // odd segments are template-literal interiors
    .filter((seg) => seg.includes("SELECT") || seg.includes("select"));
  checkTrue("module contains SQL statements to verify", sqlStatements.length >= 5, `found ${sqlStatements.length}`);
  for (const [i, stmt] of sqlStatements.entries()) {
    checkTrue(
      `SQL statement #${i + 1} is business-scoped`,
      stmt.includes("business_id"),
      stmt.slice(0, 60),
    );
  }
  checkTrue("queries call assertServer", src.includes("assertServer()"));
  checkTrue(
    "no new migration added for P3-D",
    !readFileSync("migrations/011_crm_completion.sql", "utf8").includes("revenue"),
    "011 is the latest migration; P3-D must not require one",
  );
  // Every business-scoped aggregate must scope conversations/appointments
  // subqueries too (not just the outer leads WHERE).
  checkTrue(
    "funnel conversation subquery is business-scoped",
    src.includes("c.business_id = ${businessId}"),
  );
  checkTrue(
    "funnel lead subquery is business-scoped",
    src.includes("l.business_id = ${businessId}"),
  );
}

// The server fn resolves businessId from requireAuth, never client input.
{
  const fns = readFileSync("src/lib/server/appFns.ts", "utf8");
  checkTrue(
    "dashboard fn passes session-resolved businessId + business timezone",
    fns.includes("q.revenueMetrics(businessId, ctx.business.timezone)"),
  );
  checkTrue(
    "funnel fn passes session-resolved businessId",
    fns.includes("q.revenueFunnelCounts(businessId)"),
  );
}

console.log(`\n${checks} checks, ${failures} failures`);
if (failures > 0) process.exit(1);
