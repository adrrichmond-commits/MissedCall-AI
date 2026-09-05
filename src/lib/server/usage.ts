/**
 * Usage metering + plan-limit gating engine (P3-F).
 *
 * PURE MODULE, NO I/O (same contract as revenue.ts / crmValue.ts): the
 * DB-facing caller is src/db/queries/usage.ts; the enforcement sites are
 * src/lib/server/textBack.ts (SMS + AI turns) and the future voice path
 * (calls). Unit-tested DBless in scripts/test-billing.ts.
 *
 * PERIOD ANCHOR: the subscription billing period. In this build that is the
 * month since the business's trial/subscription start: a fixed monthly
 * anniversary anchored at trial_ends_at, or created_at when no trial is
 * recorded (replays are identical every month; a 31st rolls to the 1st of
 * the next month so anchors stay unique). When live Stripe periods arrive,
 * current_period_start can be passed straight in as the anchor — every
 * function below accepts the anchor as data and nothing here changes.
 *
 * ENFORCEMENT PHILOSOPHY:
 *   - Limits are checked BEFORE the metered action (gate) and the counter is
 *     incremented ONLY after the action actually happened (no charging for
 *     failures).
 *   - At-limit is NOT a silent drop: resolveGate returns a typed
 *     limit-reached result carrying an honest, plan-named message the UI/API
 *     renders as an upgrade prompt.
 *   - EMERGENCY TEXTS ARE NEVER RATE-LIMITED (safety first — see
 *     pricing.ts): gateSms with emergency=true always passes, and the
 *     emergency send still increments the counter so usage stays truthful.
 */
import { limitsForPlan, type PlanLimits } from "../pricing";

// ---------------------------------------------------------------------------
// Period anchor — month since trial/subscription start
// ---------------------------------------------------------------------------
/**
 * The billing-period anchor at or before `now`, given the subscription
 * anchor date (trial start or, absent that, account creation).
 *
 * Examples (anchor day = 15): Jan 15–Feb 14 is one period, so on Feb 3 the
 * period_start is Jan 15. On an anchor day the new period starts that day
 * (Jan 15 00:00 local-anchor, computed in UTC against the stored instant's
 * clock time so DST never shifts a business's billing day).
 */
export function currentPeriodStart(subscriptionAnchor: Date, now: Date): Date {
  const anchor = new Date(subscriptionAnchor.getTime());
  const day = anchor.getUTCDate();
  const hour = anchor.getUTCHours();
  const minute = anchor.getUTCMinutes();
  const second = anchor.getUTCSeconds();
  // Candidate at the same wall-clock position in `now`'s UTC month.
  const candidate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      Math.min(day, daysInUtcMonth(now.getUTCFullYear(), now.getUTCMonth())),
      hour,
      minute,
      second,
      0,
    ),
  );
  if (candidate.getTime() <= now.getTime()) return candidate;
  // Not yet reached this month's anniversary: step back one month (clamping
  // the day for short months, e.g. anchor Jan 31 → Feb period starts Feb 28).
  const prevMonth = now.getUTCMonth() === 0 ? 11 : now.getUTCMonth() - 1;
  const prevYear = now.getUTCMonth() === 0 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  return new Date(
    Date.UTC(
      prevYear,
      prevMonth,
      Math.min(day, daysInUtcMonth(prevYear, prevMonth)),
      hour,
      minute,
      second,
      0,
    ),
  );
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// ---------------------------------------------------------------------------
// Typed gate results — a limit hit is never a silent drop
// ---------------------------------------------------------------------------
export type UsageAxis = "sms" | "ai_turns" | "calls";

/** Which metered axis a gate decision came from (for honest messages). */
export type GateAxis = "sms_per_month" | "ai_turns_per_month" | "calls_per_month";

export type GateDecision =
  | { allowed: true; used: number; limit: number }
  | {
      allowed: false;
      reason: "limit_reached";
      axis: GateAxis;
      used: number;
      limit: number;
      /** Owner-facing, plan-named, honest. Rendered as the upgrade prompt. */
      message: string;
      /** CTA target for the UI upgrade prompt. */
      upgradeTo: "pro" | null;
    };

const AXIS_LABELS: Record<GateAxis, string> = {
  sms_per_month: "monthly SMS allowance",
  ai_turns_per_month: "monthly AI conversation allowance",
  calls_per_month: "monthly call allowance",
};

/** Human message naming the plan and the axis — never a bare number. */
export function limitReachedMessage(planName: string, axis: GateAxis): string {
  return `You've used your ${planName} plan's ${AXIS_LABELS[axis]}. Upgrade to keep going — your leads and data are safe.`;
}

/**
 * Gate one metered action. `used` is the CURRENT period's counter (the
 * zero-cost read: one indexed row lookup). At/over the limit → not allowed.
 * Under by one or more → allowed (the caller increments after success).
 */
export function resolveGate(args: {
  axis: GateAxis;
  used: number;
  limits: PlanLimits;
  planName: string;
  isCurrentPlanPro: boolean;
}): GateDecision {
  const limit = args.limits[args.axis];
  if (args.used < limit) return { allowed: true, used: args.used, limit };
  return {
    allowed: false,
    reason: "limit_reached",
    axis: args.axis,
    used: args.used,
    limit,
    message: limitReachedMessage(args.planName, args.axis),
    // Only an upgrade to Pro lifts a Starter limit; Pro is the top plan.
    upgradeTo: args.isCurrentPlanPro ? null : "pro",
  };
}

// ---------------------------------------------------------------------------
// Limit math helpers shared by enforcement + UI
// ---------------------------------------------------------------------------
/** True when the NEXT send of this axis would be blocked (used >= limit). */
export function isAtLimit(axis: GateAxis, used: number, limits: PlanLimits): boolean {
  return used >= limits[axis];
}

/** 0..100+ usage percentage, rounded, for the billing bar. Limit 0 → 100. */
export function usagePercent(used: number, limit: number): number {
  if (limit <= 0) return used > 0 ? 100 : 0;
  return Math.round((used / limit) * 100);
}

/** "X of Y" text for the billing page; limit -1 renders "Unlimited". */
export function usageLabel(used: number, limit: number): string {
  return limit < 0 ? `${used} of Unlimited` : `${used} of ${limit}`;
}

/** Limits for a plan id — re-exported so enforcers import from one module. */
export { limitsForPlan };
export type { PlanLimits };

// ---------------------------------------------------------------------------
// Emergency bypass + billing lifecycle decisions (pure, tested)
// ---------------------------------------------------------------------------
/**
 * Full gate decision including the EMERGENCY EXCEPTION: an emergency SMS is
 * NEVER rate-limited (safety first — pricing.ts). Every other axis blocks
 * honestly. usageGate.gateAction delegates here so the rule has exactly one
 * tested definition.
 */
export function resolveGateWithEmergency(args: {
  axis: GateAxis;
  used: number;
  limits: PlanLimits;
  planName: string;
  isCurrentPlanPro: boolean;
  emergency: boolean;
}): GateDecision {
  if (args.emergency && args.axis === "sms_per_month") {
    // SAFETY: emergency texts are never rate-limited. Still metered upstream
    // so usage stays truthful.
    return { allowed: true, used: args.used, limit: args.limits.sms_per_month };
  }
  return resolveGate(args);
}

/** Cancel request on the current lifecycle state (cancel_at_period_end). */
export function cancelRequestDecision(alreadyScheduled: boolean): {
  changed: boolean;
  message: string;
} {
  if (alreadyScheduled) {
    return { changed: false, message: "Cancellation is already scheduled." };
  }
  return {
    changed: true,
    message:
      "Cancellation scheduled. Your service stays active until the end of the current billing period. Your plan selection and all data are preserved — reactivate anytime before then.",
  };
}

/** Reactivate request on the current lifecycle state. */
export function reactivateRequestDecision(alreadyScheduled: boolean): {
  changed: boolean;
  message: string;
} {
  if (!alreadyScheduled) {
    return { changed: false, message: "Your subscription is active — nothing to reactivate." };
  }
  return {
    changed: true,
    message: "Welcome back! Your subscription continues as before — no data was lost.",
  };
}
