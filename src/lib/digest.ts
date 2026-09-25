/**
 * Performance digest config + gating (P5-5) — PURE, no I/O (same contract as
 * smsWorkflows.ts): the config lives per-business in businesses.settings
 * jsonb under the nested `performanceDigest` key; the DB-facing caller is
 * src/lib/server/digestSweep.ts (the cron sweep) and the settings save fn.
 *
 * ANTI-SPAM CONTRACT (all caps enforced by digestShouldSend, pinned by
 * scripts/test-p55-reporting.ts):
 *   1. Digests are OPT-IN — the default config is disabled; nothing sends
 *      until the owner turns digests on in Settings.
 *   2. Content gate — a digest is only composed when the period carries real
 *      activity (leads, calls, conversations, appointments, or recovered
 *      revenue). No "nothing happened this week" messages, ever.
 *   3. Minimum interval — at most one digest per frequency window (daily:
 *      20h floor, weekly: 6-day floor), measured from the last digest
 *      notification actually created for the business.
 *   4. Period idempotency — a period key (e.g. "daily-2026-09-25") is sent at
 *      most once, however often the cron is pinged.
 *   5. Opt-out gates — delivery beyond the in-app notification flows ONLY
 *      through the existing channel gates (email/SMS toggles the business
 *      controls in Settings) and the ONE workflow engine (opt-outs, quiet
 *      hours, caps apply untouched).
 */
import { localDateParts, localMidnightUtc } from "./server/revenue";

/** How often the digest goes out. */
export type DigestFrequency = "daily" | "weekly";

export interface PerformanceDigestConfig {
  enabled: boolean;
  frequency: DigestFrequency;
}

export const DIGEST_FREQUENCIES: DigestFrequency[] = ["daily", "weekly"];

/** Opt-in default: OFF. A business that never asked for digests gets none. */
export const DEFAULT_PERFORMANCE_DIGEST_CONFIG: PerformanceDigestConfig = {
  enabled: false,
  frequency: "weekly",
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Tolerant merge over the defaults — garbage input can never enable a digest. */
export function sanitizePerformanceDigestConfig(raw: unknown): PerformanceDigestConfig {
  const root = asRecord(raw);
  if (!root) return { ...DEFAULT_PERFORMANCE_DIGEST_CONFIG };
  const enabled = root.enabled === true; // only an explicit true enables
  const frequency = root.frequency === "daily" ? "daily" : root.frequency === "weekly" ? "weekly" : DEFAULT_PERFORMANCE_DIGEST_CONFIG.frequency;
  return { enabled, frequency };
}

/** Minimum hours between digests (anti-spam floor below the period length). */
export const DIGEST_MIN_INTERVAL_HOURS: Record<DigestFrequency, number> = {
  daily: 20,
  weekly: 24 * 6,
};

// ---------------------------------------------------------------------------
// Digest period windows — "yesterday" / "last week" in the business's timezone
// ---------------------------------------------------------------------------

export interface DigestWindow {
  /** Period start (inclusive), UTC instant. */
  from: Date;
  /** Period end (exclusive), UTC instant. */
  to: Date;
  /** Idempotency key, e.g. "daily-2026-09-25" / "weekly-2026-W39". */
  periodKey: string;
  /** Human label, e.g. "Yesterday (Sep 24)" / "Last week (Sep 15–21)". */
  periodLabel: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The COMPLETED period the digest reports on: daily → the previous local day;
 * weekly → the previous local Monday-based week. Reuses revenue.ts's
 * local-calendar helpers (one definition of local midnights; revenue.ts is a
 * pure module — no server-only guard, safe to import from shared code). Total
 * over garbage input: unusable zone → UTC; non-finite now → real clock.
 */
export function digestWindow(now: Date, frequency: DigestFrequency, timezone: string | null | undefined): DigestWindow {
  const at = now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date();
  const tz = localDateParts(at, timezone ?? "") !== null ? (timezone as string) : "UTC";
  const parts = localDateParts(at, tz)!;
  const today = localMidnightUtc(parts.y, parts.m, parts.d, tz, at);

  if (frequency === "daily") {
    const from = new Date(today.getTime() - 24 * 60 * 60_000);
    const ymd = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(from);
    // localDateParts on the window start gives the calendar date for the key.
    const p = localDateParts(from, tz)!;
    return {
      from,
      to: today,
      periodKey: `daily-${p.y}-${pad(p.m)}-${pad(p.d)}`,
      periodLabel: `Yesterday (${ymd})`,
    };
  }

  // Weekly: back to this week's Monday, then one more week back.
  const backToMonday = (parts.dow + 6) % 7;
  const mondayStep = (y: number, m: number, d: number, days: number) => {
    const t = new Date(Date.UTC(y, m - 1, d + days));
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
  };
  const thisMonday = mondayStep(parts.y, parts.m, parts.d, -backToMonday);
  const lastMonday = mondayStep(thisMonday.y, thisMonday.m, thisMonday.d, -7);
  const from = localMidnightUtc(lastMonday.y, lastMonday.m, lastMonday.d, tz, at);
  const to = localMidnightUtc(thisMonday.y, thisMonday.m, thisMonday.d, tz, at);
  const fmt = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(d);
  const endInclusive = new Date(to.getTime() - 24 * 60 * 60_000);
  // ISO-ish week id from the Monday's date.
  return {
    from,
    to,
    periodKey: `weekly-${lastMonday.y}-${pad(lastMonday.m)}-${pad(lastMonday.d)}`,
    periodLabel: `Last week (${fmt(from)}–${fmt(endInclusive)})`,
  };
}

// ---------------------------------------------------------------------------
// The send gate — every anti-spam cap in one pure decision
// ---------------------------------------------------------------------------

export interface DigestGateInput {
  config: PerformanceDigestConfig;
  /** Counts for the digest window (sanitized upstream or here). */
  counts: { leadsCaptured: number; callsReceived: number; autoResponded: number; customerReplies: number; appointmentsBooked: number; jobsWon: number; revenueRecoveredCents: number };
  /** created_at of the business's most recent performance_digest notification (null = none). */
  lastSentAt: Date | null;
  /** True when a digest for THIS periodKey already exists. */
  alreadySentForPeriod: boolean;
  now: Date;
}

export type DigestSkipReason =
  | "disabled"
  | "no_content"
  | "min_interval"
  | "already_sent_for_period";

export interface DigestGateDecision {
  send: boolean;
  reason: DigestSkipReason | null;
}

/**
 * Evaluate every anti-spam cap. Order matters and is pinned by tests: config
 * gate → period idempotency → content gate → minimum interval.
 */
export function digestShouldSend(input: DigestGateInput): DigestGateDecision {
  const config = sanitizePerformanceDigestConfig(input?.config);
  if (!config.enabled) return { send: false, reason: "disabled" };
  if (input.alreadySentForPeriod === true) return { send: false, reason: "already_sent_for_period" };
  const c = input?.counts;
  const hasContent =
    safePositive(c?.leadsCaptured) ||
    safePositive(c?.callsReceived) ||
    safePositive(c?.autoResponded) ||
    safePositive(c?.customerReplies) ||
    safePositive(c?.appointmentsBooked) ||
    safePositive(c?.jobsWon) ||
    safePositive(c?.revenueRecoveredCents);
  if (!hasContent) return { send: false, reason: "no_content" };
  const last = input.lastSentAt instanceof Date && Number.isFinite(input.lastSentAt.getTime()) ? input.lastSentAt : null;
  if (last) {
    const minMs = DIGEST_MIN_INTERVAL_HOURS[config.frequency] * 60 * 60_000;
    const now = input.now instanceof Date && Number.isFinite(input.now.getTime()) ? input.now : new Date();
    if (now.getTime() - last.getTime() < minMs) return { send: false, reason: "min_interval" };
  }
  return { send: true, reason: null };
}

function safePositive(v: unknown): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

// ---------------------------------------------------------------------------
// Copy renderers — the digest text for the in-app payload, email, and SMS
// ---------------------------------------------------------------------------

export interface DigestCopyInput {
  businessName: string;
  window: DigestWindow;
  counts: {
    leadsCaptured: number;
    missedCalls: number;
    autoResponded: number;
    customerReplies: number;
    appointmentsBooked: number;
    jobsWon: number;
    revenueRecoveredCents: number;
  };
}

/** "1,240" style money from cents — digest copy never shows raw cents. */
export function formatDigestMoney(cents: number): string {
  const n = Math.round(Number(cents));
  if (!Number.isFinite(n) || n <= 0) return "$0";
  return "$" + n.toLocaleString("en-US");
}

/** The one-line SMS/summary sentence. Money is ALWAYS "(estimate)"-labeled. */
export function digestSummaryLine(input: DigestCopyInput): string {
  const c = input.counts;
  const bits: string[] = [];
  bits.push(`${c.leadsCaptured} ${c.leadsCaptured === 1 ? "lead" : "leads"} captured`);
  bits.push(`${c.appointmentsBooked} ${c.appointmentsBooked === 1 ? "job" : "jobs"} booked`);
  if (c.jobsWon > 0) {
    bits.push(
      `${c.jobsWon} ${c.jobsWon === 1 ? "job" : "jobs"} won ≈ ${formatDigestMoney(c.revenueRecoveredCents)} recovered (estimate)`,
    );
  }
  return `${input.window.periodLabel}: ${bits.join(", ")}.`;
}
