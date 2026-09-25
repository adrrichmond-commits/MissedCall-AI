/**
 * Performance reporting engine (P5-5) — "how are we doing over time?".
 *
 * PURE MODULE, NO I/O (same contract as revenue.ts / roi.ts): the DB-facing
 * caller is src/db/queries/reporting.ts (window counts) and
 * src/lib/server/reportingReads.ts (the page/digest assembly). Unit- and
 * DB-tested in scripts/test-p55-reporting.ts.
 *
 * MEASURED vs ESTIMATED — the P5-2 estimateFlags contract is REUSED verbatim
 * (same three flags, same meaning, pinned all-true):
 *
 *   MEASURED (real rows in the business's own account, per window):
 *     callsReceived, missedCalls, autoResponded, customerReplies,
 *     leadsCaptured, appointmentsBooked
 *
 *   ESTIMATED (derived — never real invoices unless the shop entered one):
 *     jobsWon, revenueRecoveredCents, roiMultiple. The engine stamps
 *     estimateFlags all-true for these; the UI renders a visible "Estimate"
 *     chip from the flags exactly like the P5-2 ROI panel.
 *
 * PERIODS: daily (today vs yesterday), weekly (this week vs last week,
 * Monday-based), monthly (this month vs last month) — all in the business's
 * own timezone. Window math reuses revenue.ts's exported local-calendar
 * helpers so there is ONE definition of local midnights (DST-corrected).
 *
 * ZERO-DATA CONTRACT (same as revenue.ts / roi.ts): every count is a
 * non-negative integer, every money value a non-negative integer cents
 * amount, never NaN, never negative, never a thrown error for empty data.
 * The ROI ratio is null when the subscription cost is $0 (trial).
 */
import { getPlan } from "../pricing";
// Shared local-calendar helpers + period bounds from revenue.ts (ONE
// definition of local midnights; also re-exported below for consumers).
import { computePeriodBounds, localDateParts, localMidnightUtc } from "./revenue";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Counts measured from the business's own rows inside one window. */
export interface ReportingCounts {
  /** Captured calls — missed calls until the voice receptionist lands (see revenue.ts). */
  callsReceived: number;
  /** Missed-call leads captured. */
  missedCalls: number;
  /** Missed-call conversations the AI text-back handled (≥1 AI outbound reply). */
  autoResponded: number;
  /** Conversations where the customer sent at least one inbound message. */
  customerReplies: number;
  /** ALL leads captured (every source). */
  leadsCaptured: number;
  /** Appointment rows created (booked) in the window. */
  appointmentsBooked: number;
  /** Leads marked won with a conversion instant inside the window (ESTIMATE). */
  jobsWon: number;
  /** Summed pipeline value of those won leads, USD cents (ESTIMATE). */
  revenueRecoveredCents: number;
}

export type PeriodKey = "daily" | "weekly" | "monthly";

/** One metric's direction vs the previous period. */
export type TrendDirection = "up" | "down" | "flat";

export interface PeriodReport {
  key: PeriodKey;
  /** Human label for the CURRENT window ("Today", "This week", "This month"). */
  label: string;
  current: ReportingCounts;
  previous: ReportingCounts;
  /** Direction of every metric, current vs previous (flat when equal). */
  trends: Record<keyof ReportingCounts, TrendDirection>;
  /** Estimated recovered revenue ÷ monthly subscription cost; null on trial. */
  roiMultiple: number | null;
}

export interface ReportingWindow {
  key: string;
  from: Date;
  to: Date;
}

/** The full payload the analytics page and digest share. */
export interface PerformanceReport {
  periods: Record<PeriodKey, PeriodReport>;
  /**
   * The P5-2 estimate-labeling contract, reused verbatim: every flagged
   * figure MUST render a visible "Estimate" chip in the UI. Pinned all-true
   * by scripts/test-p55-reporting.ts.
   */
  estimateFlags: { jobsWon: boolean; revenueRecovered: boolean; roiMultiple: boolean };
  /** True when the business has any measured activity in any window. */
  hasActivity: boolean;
}

// ---------------------------------------------------------------------------
// Sanitizers — identical rules to revenue.ts / roi.ts
// ---------------------------------------------------------------------------

export function safeCount(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeCents(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function sanitizeCounts(raw: Partial<ReportingCounts> | null | undefined): ReportingCounts {
  return {
    callsReceived: safeCount(raw?.callsReceived),
    missedCalls: safeCount(raw?.missedCalls),
    autoResponded: safeCount(raw?.autoResponded),
    customerReplies: safeCount(raw?.customerReplies),
    leadsCaptured: safeCount(raw?.leadsCaptured),
    appointmentsBooked: safeCount(raw?.appointmentsBooked),
    jobsWon: safeCount(raw?.jobsWon),
    revenueRecoveredCents: safeCents(raw?.revenueRecoveredCents),
  };
}

const COUNT_KEYS: (keyof ReportingCounts)[] = [
  "callsReceived",
  "missedCalls",
  "autoResponded",
  "customerReplies",
  "leadsCaptured",
  "appointmentsBooked",
  "jobsWon",
  "revenueRecoveredCents",
];

function trend(current: number, previous: number): TrendDirection {
  if (current > previous) return "up";
  if (current < previous) return "down";
  return "flat";
}

// ---------------------------------------------------------------------------
// Window math — reuses revenue.ts's local-calendar helpers (one definition)
// ---------------------------------------------------------------------------

/**
 * The six windows the analytics page reports: current + previous for day,
 * week, month, all in the business's timezone. `now` falls back to the real
 * clock when non-finite; an unusable timezone falls back to UTC (both
 * inherited from revenue.ts's engine behavior — total, never throws).
 */
export function computeReportingWindows(now: Date, timezone: string | null | undefined) {
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const bounds = computePeriodBounds(at, timezone);
  // An unusable zone falls back to UTC — the same fallback computePeriodBounds
  // applies internally, so all six windows stay mutually consistent.
  const tz = localDateParts(at, timezone ?? "") !== null ? (timezone as string) : "UTC";
  const parts = localDateParts(at, tz)!;

  // Daily: local today and yesterday.
  const day0 = localMidnightUtc(parts.y, parts.m, parts.d, tz, at); // today 00:00 local
  const day1 = new Date(day0.getTime() + 24 * 60 * 60_000); // tomorrow 00:00 local
  const daily = {
    current: { key: "day_current", from: day0, to: day1 },
    previous: { key: "day_previous", from: new Date(day0.getTime() - 24 * 60 * 60_000), to: day0 },
  };

  // Weekly: Monday-based, anchored on revenue.ts's weekStart (same definition).
  const weekStart = bounds.weekStart;
  const weekly = {
    current: { key: "week_current", from: weekStart, to: new Date(weekStart.getTime() + 7 * 24 * 60 * 60_000) },
    previous: {
      key: "week_previous",
      from: new Date(weekStart.getTime() - 7 * 24 * 60 * 60_000),
      to: weekStart,
    },
  };

  // Monthly: 1st of this month (revenue.ts monthStart) → tomorrow's local
  // midnight; previous month steps the local calendar back one month (Jan 1 →
  // Dec 1 of the prior year included). Sampled at local noon so a zone-offset
  // boundary can't shift the calendar date.
  const monthStart = bounds.monthStart;
  const prev = parts.m === 1 ? { y: parts.y - 1, m: 12 } : { y: parts.y, m: parts.m - 1 };
  const prevMonthStart = localMidnightUtc(prev.y, prev.m, 1, tz, at);
  const monthly = {
    current: { key: "month_current", from: monthStart, to: day1 },
    previous: { key: "month_previous", from: prevMonthStart, to: monthStart },
  };

  return { daily, weekly, monthly };
}

/** The flat window list the query layer consumes. */
export function flattenWindows(windows: ReturnType<typeof computeReportingWindows>): ReportingWindow[] {
  return [
    windows.daily.current,
    windows.daily.previous,
    windows.weekly.current,
    windows.weekly.previous,
    windows.monthly.current,
    windows.monthly.previous,
  ];
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface PerformanceReportInput {
  /** Counts keyed like flattenWindows() keys: day_current, day_previous, … */
  counts: Record<string, ReportingCounts>;
  /** The business's plan id — subscription cost resolves from pricing.ts. */
  planId: string;
}

/** Monthly subscription cost in cents from the ONE pricing config; $0 on trial. */
export function monthlyCostCentsFor(planId: string): number {
  return getPlan(typeof planId === "string" ? planId : "")?.priceCents ?? 0;
}

/**
 * Compute the performance report. Total over garbage input: counts are
 * sanitized, trends are pure comparisons, the ROI ratio guards its
 * denominator, and estimateFlags are pinned all-true (the labeling contract).
 */
export function computePerformanceReport(input: PerformanceReportInput): PerformanceReport {
  const raw = input?.counts ?? {};
  const costCents = monthlyCostCentsFor(input?.planId ?? "");
  const roi = (recoveredCents: number): number | null =>
    costCents > 0 ? Math.round((recoveredCents / costCents) * 10) / 10 : null;

  const build = (
    key: PeriodKey,
    label: string,
    currentKey: string,
    previousKey: string,
  ): PeriodReport => {
    const current = sanitizeCounts(raw[currentKey]);
    const previous = sanitizeCounts(raw[previousKey]);
    const trends = {} as Record<keyof ReportingCounts, TrendDirection>;
    for (const k of COUNT_KEYS) trends[k] = trend(current[k], previous[k]);
    return { key, label, current, previous, trends, roiMultiple: roi(current.revenueRecoveredCents) };
  };

  const periods: Record<PeriodKey, PeriodReport> = {
    daily: build("daily", "Today", "day_current", "day_previous"),
    weekly: build("weekly", "This week", "week_current", "week_previous"),
    monthly: build("monthly", "This month", "month_current", "month_previous"),
  };
  const hasActivity = Object.values(periods).some((p) =>
    COUNT_KEYS.some((k) => (k === "jobsWon" || k === "revenueRecoveredCents" ? false : p.current[k] > 0)),
  );
  return {
    periods,
    // The labeling contract (P5-2): ALL derived money figures are estimates
    // until verified by real jobs. Pinned by scripts/test-p55-reporting.ts.
    estimateFlags: { jobsWon: true, revenueRecovered: true, roiMultiple: true },
    hasActivity: hasActivity || Object.values(periods).some((p) => p.current.jobsWon > 0),
  };
}

/** True when a window's counts carry any content worth reporting (digest gate). */
export function countsHaveActivity(c: ReportingCounts): boolean {
  const s = sanitizeCounts(c);
  return (
    s.leadsCaptured > 0 ||
    s.callsReceived > 0 ||
    s.autoResponded > 0 ||
    s.customerReplies > 0 ||
    s.appointmentsBooked > 0 ||
    s.jobsWon > 0 ||
    s.revenueRecoveredCents > 0
  );
}

// ---------------------------------------------------------------------------
// Shared local-calendar helpers (imported from revenue.ts — single definition)
// ---------------------------------------------------------------------------

export { computePeriodBounds, localDateParts, localMidnightUtc };
