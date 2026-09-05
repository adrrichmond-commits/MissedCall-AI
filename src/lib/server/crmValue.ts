/**
 * CRM value + follow-up planning helpers (P3-C).
 *
 * PURE MODULE, NO I/O (same contract as leadLifecycle.ts): the DB-facing
 * callers are src/db/queries/leads.ts, src/db/queries/followUpTasks.ts,
 * src/lib/server/notify.ts, and src/lib/server/textBack.ts. Unit-tested
 * DBless (scripts/test-crm.ts).
 *
 * ESTIMATED JOB VALUE: the plumbing KB carries a typical USD range per
 * service (typicalValue.{low,high}). When a lead's classification resolves a
 * KB service, that range is stamped on the lead
 * (estimated_job_value_low_cents / _high_cents). The shop's own quote —
 * estimated_value_cents — always outranks the KB guess; the KB range is the
 * seed, never an invented quote.
 *
 * PIPELINE VALUE: one number per lead that "what is this lead worth" questions
 * can sum without re-deriving precedence at every call site (P3-D Revenue
 * Recovered sums it):
 *
 *   won    → actual_won_value_cents ?? estimated_value_cents ?? est-high
 *   lost   → NULL (nothing was recovered)
 *   open   → greatest(estimated_value_cents, est-high)   (either may be null)
 *            — a real quote outranks the KB guess, never sits below it
 */
import { resolveServiceByAlias } from "./kb";

// ---------------------------------------------------------------------------
// Estimated job value
// ---------------------------------------------------------------------------

export interface JobValueEstimate {
  lowCents: number;
  highCents: number;
  /** Canonical KB slug the estimate came from (audit trail). */
  slug: string;
}

/**
 * Resolve the KB value range for a free-text service need. Null when the text
 * matches no KB service — never guessed. Uses the same resolveServiceByAlias
 * scoring the classifier uses, so a lead classified as "drain cleaning"
 * carries drain-cleaning's $100–$350 range.
 */
export function estimateJobValueCents(serviceNeed: string): JobValueEstimate | null {
  if (typeof serviceNeed !== "string") return null;
  const match = resolveServiceByAlias(serviceNeed);
  if (!match) return null;
  const { low, high } = match.entry.typicalValue;
  return {
    lowCents: Math.round(low * 100),
    highCents: Math.round(high * 100),
    slug: match.entry.slug,
  };
}

export type LeadPipelineStatus = "won" | "lost" | "open";

export interface PipelineValueInput {
  status: LeadPipelineStatus;
  actualWonValueCents: number | null;
  estimatedValueCents: number | null;
  estimatedJobValueLowCents: number | null;
  estimatedJobValueHighCents: number | null;
}

/**
 * Compute pipeline_value_cents from the money columns present on a lead.
 * Negative inputs are treated as absent (the DB CHECKs already forbid them;
 * this keeps the pure function total for callers that bypass the DB).
 */
export function computePipelineValueCents(v: PipelineValueInput): number | null {
  const nz = (n: number | null): number | null => (n != null && n >= 0 ? n : null);
  if (v.status === "lost") return null;
  const actual = nz(v.actualWonValueCents);
  const quote = nz(v.estimatedValueCents);
  const estHigh = nz(v.estimatedJobValueHighCents);
  if (v.status === "won") {
    return actual ?? quote ?? estHigh;
  }
  // Open: the best evidence of value — a real quote when present (never
  // below the KB range-high), otherwise the KB range-high, otherwise null.
  if (quote != null && estHigh != null) return Math.max(quote, estHigh);
  return quote ?? estHigh;
}

// ---------------------------------------------------------------------------
// Follow-up due dates
// ---------------------------------------------------------------------------

/** Default lead-follow-up window (business days). */
export const FOLLOW_UP_LEAD_DAYS = 1;

/** Local calendar read of an instant in a zone (or null when unusable). */
function datePartsInTz(
  date: Date,
  timezone: string,
): { dayOfWeek: number; y: number; m: number; d: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
    const dayOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
    const y = parseInt(get("year"), 10);
    const m = parseInt(get("month"), 10);
    const d = parseInt(get("day"), 10);
    if (dayOfWeek < 0 || Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
    return { dayOfWeek, y, m, d };
  } catch {
    return null; // invalid/unsupported timezone (RangeError)
  }
}

/**
 * The UTC instant for "local `h`:`mm` on the calendar date that is `days`
 * business days after `from` in `timezone`". Null when the timezone is
 * unusable — the caller falls back to UTC (documented).
 *
 * Weekends never count: Friday +1 business day → Monday. DST-safe by
 * construction: the target local wall-clock string is parsed with the zone
 * suffix, so 09:00 stays 09:00 local even across offset changes.
 */
export function addBusinessDaysAt(
  from: Date,
  days: number,
  timezone: string | null,
  hour = 9,
  minute = 0,
): Date | null {
  if (!timezone) return null;
  const start = datePartsInTz(from, timezone);
  if (!start) return null;
  // Walk forward `days` business days AND calendar days in parallel.
  let dow = start.dayOfWeek;
  let remaining = days;
  let calendarDays = 0;
  while (remaining > 0) {
    dow = (dow + 1) % 7;
    calendarDays++;
    if (dow !== 0 && dow !== 6) remaining--;
  }
  const baseUtcMidnight = Date.UTC(start.y, start.m - 1, start.d);
  const due = new Date(baseUtcMidnight + calendarDays * 86_400_000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const localIso =
    `${due.getUTCFullYear()}-${pad(due.getUTCMonth() + 1)}-${pad(due.getUTCDate())}` +
    `T${pad(hour)}:${pad(minute)}:00`;
  // Parse the local wall clock in the business zone via the UTC-offset suffix
  // (e.g. "2026-09-08T09:00:00-05:00"), corrected once for DST-boundary days.
  const offsetAt = (d: Date): string => {
    try {
      const name =
        new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
          .formatToParts(d)
          .find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
      const off = name.replace("GMT", "");
      return off === "" || off === "Z" ? "+00:00" : off;
    } catch {
      return "+00:00";
    }
  };
  let instant = new Date(localIso + offsetAt(from));
  if (Number.isNaN(instant.getTime())) return null;
  const expected = `${localIso}${offsetAt(instant)}`;
  const corrected = new Date(expected);
  if (!Number.isNaN(corrected.getTime())) instant = corrected;
  return instant;
}

/**
 * Due date for an auto-created lead follow-up: next business day at 9:00 AM
 * in the business's timezone. Null when the timezone is unusable.
 */
export function nextBusinessDayAt9(from: Date, timezone: string | null): Date | null {
  return addBusinessDaysAt(from, FOLLOW_UP_LEAD_DAYS, timezone, 9, 0);
}
