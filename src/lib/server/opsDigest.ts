/**
 * WEEKLY OPS DIGEST — PURE assembly (no DB, no network).
 *
 * The SQL layer (src/db/queries/opsDigest.ts) hands over what the DB actually
 * holds; this module turns it into the digest content the owner receives by
 * email/in-app once a week. Kept pure so the test suite
 * (scripts/test-ops-digest.ts) can pin the HONESTY RULES:
 *
 *   - Only what the DB holds. No estimates, no padding, no invented rows.
 *     Zeros are rendered as honest empty states ("No new leads this week"),
 *     never dressed up as activity.
 *   - The trial→paid rate is null when no trials have started — rendered as
 *     "—" exactly like /admin/metrics (conversionRatePct, shared with P5-6;
 *     a 0-denominator rate is NEVER rendered as 0%).
 *   - When literally nothing happened, the digest says so in one line
 *     instead of pretending a quiet week is activity.
 *
 * Window math: a rolling 7-day UTC window ending at the send instant. The
 * cron fires Monday 06:17 UTC, so "this week" = the previous Monday 06:17 →
 * send time. UTC everywhere: the scheduler's clock, not a business timezone
 * (this digest is platform-level; per-business digests keep the P5-5
 * timezone-aware windows).
 */
import { conversionRatePct } from "~/lib/server/adminMetrics";
import type { OpsDigestRaw } from "~/db/queries/opsDigest";

const DAY_MS = 24 * 60 * 60_000;

/** The digest window: [now − 7d, now). */
export interface OpsWeekWindow {
  /** ISO instant the window opens (inclusive). */
  startIso: string;
  /** ISO instant the window closes (the send time). */
  endIso: string;
}

export function opsWeekWindow(now: Date): OpsWeekWindow {
  return {
    startIso: new Date(now.getTime() - 7 * DAY_MS).toISOString(),
    endIso: now.toISOString(),
  };
}

/**
 * The idempotency key: one digest per WEEK, anchored to the Monday (UTC) of
 * the send instant — NOT the rolling window's open date. The scheduled cron
 * fires Monday 06:17 UTC, and any manual workflow_dispatch re-ping later in
 * the same calendar week resolves to the SAME key, so a period is digested
 * at most once no matter how often the endpoint is pinged. (The window
 * itself stays rolling-7d: the scheduled ping makes the two coincide.)
 */
export function opsDigestPeriodKey(now: Date): string {
  const utcMonday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utcMonday.setUTCDate(utcMonday.getUTCDate() - ((utcMonday.getUTCDay() + 6) % 7));
  return "weekly-" + utcMonday.toISOString().slice(0, 10);
}

export interface OpsDigestView extends OpsWeekWindow {
  generatedAt: string;
  periodKey: string;
  trials: {
    active: number;
    startsThisWeek: number;
    startsToDate: number;
    paidToDate: number;
    /** null until a trial has started — renders "—", never a fake 0%. */
    ratePct: number | null;
  };
  leads: { total: number; bySource: Record<string, number> };
  appointments: { requested: number; confirmed: number };
  attention: {
    failedLineTests: { name: string; detail: string | null }[];
    takeoversWaiting: { name: string; detail: string | null }[];
    paymentFailures: { name: string; detail: string | null }[];
  };
  lines: OpsDigestRaw["lines"];
  /** True when there is literally nothing to report — drives the empty state. */
  everythingQuiet: boolean;
  subject: string;
  text: string;
}

const SOURCE_LABELS: Record<string, string> = {
  missed_call: "missed call",
  web_form: "web form",
  referral: "referral",
  repeat_customer: "repeat customer",
  other: "other",
};

function plural(n: number, one: string, many?: string): string {
  return n === 1 ? `${n} ${one}` : `${n} ${many ?? one + "s"}`;
}

/**
 * Build the full digest view + email text. Every section states its own
 * honest empty state; `everythingQuiet` swaps in the single quiet-week line.
 */
export function buildOpsDigest(raw: OpsDigestRaw, now: Date): OpsDigestView {
  const window = opsWeekWindow(now);
  const ratePct = conversionRatePct(raw.trials.startsToDate, raw.trials.paidToDate);

  const failedLineTests = raw.attention.failedLineTests.map((i) => ({ name: i.name, detail: i.detail }));
  const takeoversWaiting = raw.attention.takeoversWaiting.map((i) => ({ name: i.name, detail: i.detail }));
  const paymentFailures = raw.attention.paymentFailures.map((i) => ({ name: i.name, detail: i.detail }));

  const everythingQuiet =
    raw.trials.active === 0 &&
    raw.trials.startsThisWeek === 0 &&
    raw.leads.total === 0 &&
    raw.appointments.requested === 0 &&
    raw.appointments.confirmed === 0 &&
    failedLineTests.length === 0 &&
    takeoversWaiting.length === 0 &&
    paymentFailures.length === 0;

  // --- email text (plain text, mirrors buildEmailText's no-HTML style) -----
  const L: string[] = [];
  L.push("MissedCall AI — weekly ops digest");
  L.push(`Week: ${window.startIso} → ${window.endIso} (last 7 days, UTC)`);
  L.push("");

  // Trials
  L.push("TRIALS");
  if (raw.trials.active === 0 && raw.trials.startsThisWeek === 0 && raw.trials.startsToDate === 0) {
    L.push("- No trials started yet.");
  } else {
    L.push(`- Active trials now: ${raw.trials.active}`);
    L.push(`- Trials started this week: ${raw.trials.startsThisWeek}`);
  }
  L.push(
    `- Trial → paid conversions to date: ${raw.trials.paidToDate}` +
      (ratePct === null ? " (rate: — — no trials have started yet)" : ` (rate: ${ratePct}%)`),
  );
  L.push("");

  // Leads
  L.push("LEADS (this week)");
  if (raw.leads.total === 0) {
    L.push("- No new leads this week.");
  } else {
    L.push(`- New leads: ${raw.leads.total}`);
  }
  // The by-source rollup renders even at zero — a 0 is a real answer, and
  // the owner sees the same shape a busy week will fill in.
  const parts = Object.entries(SOURCE_LABELS).map(
    ([k, label]) => `${label}: ${raw.leads.bySource[k] ?? 0}`,
  );
  const extra = Object.entries(raw.leads.bySource).filter(([k]) => !(k in SOURCE_LABELS));
  L.push("- By source — " + parts.concat(extra.map(([k, v]) => `${k}: ${v}`)).join(", "));
  L.push(
    `- Appointments created this week — requested: ${raw.appointments.requested}, confirmed: ${raw.appointments.confirmed}` +
      (raw.appointments.requested + raw.appointments.confirmed === 0 ? " (none)" : ""),
  );
  L.push("");

  // Attention
  L.push("NEEDS ATTENTION");
  let attentionLines = 0;
  if (failedLineTests.length > 0) {
    L.push(`- Failed line tests: ${failedLineTests.map((i) => i.name).join(", ")}`);
    attentionLines++;
  }
  if (takeoversWaiting.length > 0) {
    L.push(
      `- Conversations waiting for human takeover: ${plural(takeoversWaiting.length, "thread")}` +
        (takeoversWaiting[0]?.detail ? ` (latest reason: ${takeoversWaiting[0].detail})` : ""),
    );
    attentionLines++;
  }
  if (paymentFailures.length > 0) {
    L.push(`- Payment failures (past-due accounts): ${paymentFailures.map((i) => i.name).join(", ")}`);
    attentionLines++;
  }
  if (attentionLines === 0) L.push("- Nothing needs attention.");
  L.push("");

  // Line status rollup
  L.push("PHONE LINES");
  L.push(`- Businesses with a phone line assigned: ${raw.lines.withPhone} of ${raw.lines.businesses}`);
  const lt = raw.lines.lineTest;
  const ltTotalRan = lt.pass + lt.partial + lt.fail;
  L.push(
    `- Latest line-test results: ${ltTotalRan === 0 ? "no line tests recorded yet" : `pass ${lt.pass}, partial ${lt.partial}, fail ${lt.fail}`}` +
      (lt.notConfigured > 0 ? `, not configured ${lt.notConfigured}` : "") +
      (lt.running > 0 ? `, running ${lt.running}` : "") +
      (lt.neverRun > 0 ? `, never run ${lt.neverRun}` : ""),
  );
  L.push("");

  if (everythingQuiet) {
    L.push("Nothing happened this week — no trials, leads, or alerts. When pilots start signing up, this email fills in.");
    L.push("");
  }
  L.push("Every number above comes straight from the database — nothing is estimated, padded, or invented. Zero is a real answer.");

  const subject =
    "Weekly ops digest — MissedCall AI" + (everythingQuiet ? " (quiet week)" : "");

  return {
    ...window,
    generatedAt: now.toISOString(),
    periodKey: opsDigestPeriodKey(now),
    trials: { active: raw.trials.active, startsThisWeek: raw.trials.startsThisWeek, startsToDate: raw.trials.startsToDate, paidToDate: raw.trials.paidToDate, ratePct },
    leads: raw.leads,
    appointments: raw.appointments,
    attention: { failedLineTests, takeoversWaiting, paymentFailures },
    lines: raw.lines,
    everythingQuiet,
    subject,
    text: L.join("\n"),
  };
}
