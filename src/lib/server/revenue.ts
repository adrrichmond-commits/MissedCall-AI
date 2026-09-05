/**
 * Revenue Recovered engine (P3-D) — the math behind the product's PRIMARY KPI.
 *
 * PURE MODULE, NO I/O (same contract as crmValue.ts / leadLifecycle.ts):
 * the DB-facing caller is src/db/queries/revenue.ts. Unit-tested DBless
 * (scripts/test-revenue.ts) — period boundaries, bucketing, and every
 * division guard run without a database.
 *
 * WHAT COUNTS AS "RECOVERED REVENUE": the sum of pipeline_value_cents over
 * WON leads (pipeline_value_cents is maintained by the P3-C query layer:
 * won → actual_won_value ?? quote ?? KB est-high; lost → NULL; open →
 * max(quote, est-high)). Only won leads contribute — open pipeline is
 * prospective, not recovered, and is never presented as revenue.
 *
 * METRIC DEFINITIONS (the exact denominators, also in the PR):
 *   - Revenue per lead     = all-time recovered cents ÷ leads carrying a
 *                            pipeline value (open leads included: they are the
 *                            pipeline that will convert). Null when no lead
 *                            carries a value.
 *   - Conversion rate      = won leads ÷ ALL leads captured (won + lost +
 *                            still-open). The honest end-to-end number: still-
 *                            open leads count against it until they close, so
 *                            it can only rise as the shop works its pipeline.
 *                            Null when the business has no leads at all.
 *   - Missed-call recovery = recovered missed-call leads (≥1 SMS conversation)
 *                            ÷ captured missed-call leads. Null when the
 *                            business has no captured missed calls.
 *   - Appointments per
 *     recovered lead      = appointment rows tied to recovered missed-call
 *                            leads ÷ recovered missed-call leads. Null when
 *                            there are no recovered leads.
 *
 * ZERO-DATA CONTRACT: every count is a non-negative integer and every money
 * value a non-negative integer cents amount — never NaN, never negative, never
 * a thrown error for empty data. Ratios are null (rendered "—") when their
 * denominator is zero.
 */

// ---------------------------------------------------------------------------
// Period bounds — "this week" / "this month" in the business's own timezone
// ---------------------------------------------------------------------------

export type RevenuePeriodKey = "week" | "month" | "all";

export interface RevenuePeriod {
  /** Won leads in the period. */
  wonLeads: number;
  /** Summed pipeline_value_cents of those won leads. */
  recoveredCents: number;
}

export interface PeriodBounds {
  /**
   * Monday 00:00 local time of the current calendar week, as a UTC instant.
   * Never null — an unusable timezone falls back to UTC (documented).
   */
  weekStart: Date;
  /** 1st of the current month, 00:00 local time, as a UTC instant. */
  monthStart: Date;
}

/** Local calendar read of an instant in a zone (null when the zone is unusable). */
function localDateParts(
  date: Date,
  timezone: string,
): { y: number; m: number; d: number; dow: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    const y = parseInt(get("year"), 10);
    const m = parseInt(get("month"), 10);
    const d = parseInt(get("day"), 10);
    if (dow < 0 || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
    return { y, m, d, dow };
  } catch {
    return null; // invalid/unsupported timezone (RangeError)
  }
}

/** UTC-offset string ("+02:00") for an instant in a zone; "+00:00" on failure. */
function offsetAt(date: Date, timezone: string): string {
  try {
    const name =
      new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
    const off = name.replace("GMT", "");
    return off === "" || off === "Z" ? "+00:00" : off;
  } catch {
    return "+00:00";
  }
}

/**
 * The UTC instant of local midnight on calendar date y-m-d in `timezone`.
 * The offset is sampled at `sample` first, then re-sampled AT the parsed
 * instant and applied once more — the same one-round DST correction
 * crmValue.addBusinessDaysAt ships. Ambiguous (fall-back) midnights resolve
 * to the later occurrence; the day-granularity sums tolerate the 1h skew on
 * the two mornings a year this can happen.
 */
function localMidnightUtc(y: number, m: number, d: number, timezone: string, sample: Date): Date {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const iso = `${y}-${pad(m)}-${pad(d)}T00:00:00`;
  let instant = new Date(iso + offsetAt(sample, timezone));
  if (Number.isNaN(instant.getTime())) instant = new Date(iso + "+00:00");
  const corrected = new Date(iso + offsetAt(instant, timezone));
  if (!Number.isNaN(corrected.getTime())) instant = corrected;
  return instant;
}

/** Shift a local calendar date by whole days (pure y/m/d math, no zone math). */
function addLocalDays(
  p: { y: number; m: number; d: number },
  days: number,
): { y: number; m: number; d: number } {
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/**
 * Start instants for the "this week" and "this month" revenue buckets in the
 * business's timezone. Weeks are Monday-based (the working week a plumber
 * recognizes); months start on the 1st. An invalid/unknown timezone falls
 * back to UTC rather than throwing, and a non-finite `now` falls back to the
 * current time — the engine stays total.
 */
export function computePeriodBounds(now: Date, timezone: string | null | undefined): PeriodBounds {
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const tz =
    typeof timezone === "string" && timezone.length > 0 && localDateParts(at, timezone) !== null
      ? timezone
      : "UTC";
  const parts = localDateParts(at, tz);
  if (!parts) return { weekStart: new Date(0), monthStart: new Date(0) }; // unreachable (tz validated)
  const backToMonday = (parts.dow + 6) % 7;
  const weekDate = addLocalDays(parts, -backToMonday);
  return {
    weekStart: localMidnightUtc(weekDate.y, weekDate.m, weekDate.d, tz, at),
    monthStart: localMidnightUtc(parts.y, parts.m, 1, tz, at),
  };
}

/**
 * Which bucket a won-lead instant belongs to. Precedence week > month > all:
 * an instant inside the current week is also inside the current month, so the
 * caller sums each bucket independently rather than nesting. Returns null for
 * a non-finite date (the caller's SQL guarantees real instants; this keeps the
 * pure function total).
 */
export function bucketForPeriod(
  convertedAt: Date | null,
  bounds: PeriodBounds,
): RevenuePeriodKey | null {
  if (!(convertedAt instanceof Date) || !Number.isFinite(convertedAt.getTime())) return null;
  if (bounds.weekStart <= convertedAt) return "week";
  if (bounds.monthStart <= convertedAt) return "month";
  return "all";
}

// ---------------------------------------------------------------------------
// Sanitizers — SQL numbers arrive as unknown; the engine never trusts them
// ---------------------------------------------------------------------------

function safeCount(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeCents(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeRate(numerator: unknown, denominator: unknown): number | null {
  const n = safeCount(numerator);
  const d = safeCount(denominator);
  if (d === 0) return null;
  return Math.min(1, Math.max(0, n / d));
}

// ---------------------------------------------------------------------------
// The metric engine
// ---------------------------------------------------------------------------

/** Raw inputs the query layer gathers (all values already real row counts). */
export interface RevenueEngineInput {
  week: RevenuePeriod;
  month: RevenuePeriod;
  allTime: RevenuePeriod;
  /** Leads with pipeline_value_cents NOT NULL (all time). */
  leadsWithValue: number;
  /** ALL leads captured (won + lost + still-open). Conversion denominator. */
  totalLeads: number;
  /** Captured missed-call leads (source = 'missed_call'). */
  missedCalls: number;
  /** Of those, leads with at least one SMS conversation. */
  recoveredMissedCalls: number;
  /** Appointment rows tied to recovered missed-call leads. */
  appointmentsFromRecovered: number;
}

export interface RevenueMetrics {
  week: RevenuePeriod;
  month: RevenuePeriod;
  allTime: RevenuePeriod;
  /** All-time recovered ÷ leads with a pipeline value; null when none. */
  revenuePerLeadCents: number | null;
  /** won ÷ ALL leads captured; null when the business has no leads. */
  conversionRate: number | null;
  /** recovered missed calls ÷ captured missed calls; null when none. */
  recoveryRate: number | null;
  /** appointment rows ÷ recovered missed-call leads; null when none. */
  appointmentsPerRecoveredLead: number | null;
}

/**
 * Compute the Revenue Recovered metric set. Total over garbage input: every
 * number passes a sanitizer, every ratio guards its denominator, so the UI
 * can render results directly without NaN/undefined checks.
 */
export function computeRevenueMetrics(input: RevenueEngineInput): RevenueMetrics {
  const week = {
    wonLeads: safeCount(input.week?.wonLeads),
    recoveredCents: safeCents(input.week?.recoveredCents),
  };
  const month = {
    wonLeads: safeCount(input.month?.wonLeads),
    recoveredCents: safeCents(input.month?.recoveredCents),
  };
  const allTime = {
    wonLeads: safeCount(input.allTime?.wonLeads),
    recoveredCents: safeCents(input.allTime?.recoveredCents),
  };
  const leadsWithValue = safeCount(input.leadsWithValue);
  const totalLeads = safeCount(input.totalLeads);
  const missedCalls = safeCount(input.missedCalls);
  const recoveredMissedCalls = Math.min(safeCount(input.recoveredMissedCalls), missedCalls);
  const appointmentsFromRecovered = safeCount(input.appointmentsFromRecovered);

  return {
    week,
    month,
    allTime,
    revenuePerLeadCents:
      leadsWithValue === 0 ? null : Math.round(allTime.recoveredCents / leadsWithValue),
    conversionRate: safeRate(allTime.wonLeads, totalLeads),
    recoveryRate: safeRate(recoveredMissedCalls, missedCalls),
    appointmentsPerRecoveredLead:
      recoveredMissedCalls === 0
        ? null
        : appointmentsFromRecovered / recoveredMissedCalls,
  };
}

// ---------------------------------------------------------------------------
// Funnel — shared shape for the revenue card and P4-A's funnel tracking
// ---------------------------------------------------------------------------

/**
 * The captured-calls funnel. Definitions, honestly scoped to what the schema
 * records today (no calls table exists until P3-E's voice receptionist):
 *
 *   callsReceived         captured missed-call leads — every call the system
 *                         currently sees is one the shop missed. When P3-E
 *                         lands, AI-answered voice calls join this stage and
 *                         the missedCalls stage splits apart (no rewire).
 *   callsHandledByAi      of those, leads whose conversation has ≥1 outbound
 *                         AI message (replySource stamped) — the text-back
 *                         actually handled it.
 *   missedCalls           captured missed-call leads. Numerically identical to
 *                         callsReceived until voice exists (documented, not a
 *                         bug — the stage exists so the funnel shape survives
 *                         P3-E).
 *   missedCallsRecovered  of those, leads with ≥1 SMS conversation — the same
 *                         "recovered" definition missedCallRecoveryStats has
 *                         shipped since Phase 2, so the analytics page and
 *                         this funnel always agree.
 *   leads                 ALL leads captured (every source).
 *   qualified             leads the shop marked qualified or pushed further
 *                         (qualified | appointment_scheduled | won).
 *   appointments          DISTINCT leads with ≥1 appointment row.
 *   won                   leads marked won.
 */
export interface FunnelCounts {
  callsReceived: number;
  callsHandledByAi: number;
  missedCalls: number;
  missedCallsRecovered: number;
  leads: number;
  qualified: number;
  appointments: number;
  won: number;
}

export const FUNNEL_STAGES: { key: keyof FunnelCounts; label: string }[] = [
  { key: "callsReceived", label: "Calls received" },
  { key: "callsHandledByAi", label: "Handled by AI" },
  { key: "missedCalls", label: "Missed calls captured" },
  { key: "missedCallsRecovered", label: "Recovered by text-back" },
  { key: "leads", label: "Leads (all sources)" },
  { key: "qualified", label: "Qualified" },
  { key: "appointments", label: "Appointments booked" },
  { key: "won", label: "Jobs won" },
];

/** The funnel as an ordered stage list for UI/funnel-chart consumers. */
export function funnelStages(counts: FunnelCounts): { key: string; label: string; count: number }[] {
  const safe: FunnelCounts = {
    callsReceived: safeCount(counts?.callsReceived),
    callsHandledByAi: safeCount(counts?.callsHandledByAi),
    missedCalls: safeCount(counts?.missedCalls),
    missedCallsRecovered: safeCount(counts?.missedCallsRecovered),
    leads: safeCount(counts?.leads),
    qualified: safeCount(counts?.qualified),
    appointments: safeCount(counts?.appointments),
    won: safeCount(counts?.won),
  };
  return FUNNEL_STAGES.map((s) => ({ key: s.key, label: s.label, count: safe[s.key] }));
}
