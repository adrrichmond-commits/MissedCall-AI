/**
 * Usage-limit enforcement gate (P3-F) — the DB-facing half of usage.ts.
 *
 * Every metered send/AI call site goes through here BEFORE acting, and
 * increments through here AFTER success. The gate is deliberately separate
 * from the pure math (src/lib/server/usage.ts, unit-tested DBless) so the
 * decision rule has exactly one tested definition.
 *
 * EMERGENCY EXCEPTION (safety first, documented in pricing.ts): when
 * `emergency` is true the SMS gate ALWAYS allows — an emergency text is
 * never silenced by a billing counter — but the send is still metered so
 * usage stays truthful. Every other axis blocks honestly with a typed
 * limit-reached result the UI/API renders as an upgrade prompt.
 *
 * GATING READ COST: resolvePlanContext does one indexed businesses lookup
 * and getUsageForPeriod one indexed counter-row lookup — no scans, no
 * aggregates. For webhook hot paths the row may not exist yet (zero usage):
 * that returns null and the gate reads zeros without creating a row. Rows
 * are created only by increments (real usage), keeping cold traffic
 * write-free.
 */
import { assertServer } from "../../db/queries/shared";
import { sql } from "../../db";
import { getUsageForPeriod, incrementUsage, type UsageAxisColumn } from "../../db/queries/usage";
import { getPlan, limitsForPlan, type PlanLimits } from "../pricing";
import {
  currentPeriodStart,
  resolveGateWithEmergency,
  type GateDecision,
  type GateAxis,
} from "./usage";

/** The three metered axes mapped to their counter columns. */
export const GATE_AXIS_COLUMNS: Record<GateAxis, UsageAxisColumn> = {
  sms_per_month: "sms_sent",
  ai_turns_per_month: "ai_turns",
  calls_per_month: "calls_handled",
};

export interface PlanUsageContext {
  plan: string;
  planName: string;
  limits: PlanLimits;
  periodStart: Date;
  used: { sms: number; aiTurns: number; calls: number };
}

/**
 * Load the business's plan + current-period usage in two indexed reads.
 * `subscriptionAnchor` is the billing anchor (trial start, else account
 * creation) — passed in by callers that already hold the business row;
 * `anchorForBusiness` resolves it from the DB otherwise.
 */
export function anchorForBusiness(business: {
  trialEndsAt: Date | null;
  createdAt: Date;
}): Date {
  return business.trialEndsAt ?? business.createdAt;
}

export async function loadPlanUsageContext(
  businessId: string,
  subscriptionAnchor: Date,
): Promise<PlanUsageContext> {
  assertServer();
  // The anchor is a subscription-truth date; "now" from the same clock that
  // will stamp increments, so gate and increment always agree on the period.
  const periodStart = currentPeriodStart(subscriptionAnchor, new Date());
  const db = sql();
  const [businessRows, counter] = await Promise.all([
    // Plan name/limits come from the businesses row — one indexed PK lookup.
    db`SELECT plan FROM businesses WHERE id = ${businessId} LIMIT 1`,
    getUsageForPeriod(businessId, periodStart),
  ]);
  const plan = (businessRows[0] as { plan?: string } | undefined)?.plan ?? "trial";
  const planName = getPlan(plan)?.name ?? "trial";
  return {
    plan,
    planName,
    limits: limitsForPlan(plan),
    periodStart,
    used: {
      sms: counter?.smsSent ?? 0,
      aiTurns: counter?.aiTurns ?? 0,
      calls: counter?.callsHandled ?? 0,
    },
  };
}

/**
 * Decide one metered action. `emergency` bypasses the SMS limit (never the
 * turn or call limits — those are compute meters, not safety messages).
 */
export function gateAction(args: {
  ctx: PlanUsageContext;
  axis: GateAxis;
  emergency?: boolean;
}): GateDecision {
  const used =
    args.axis === "sms_per_month"
      ? args.ctx.used.sms
      : args.axis === "ai_turns_per_month"
        ? args.ctx.used.aiTurns
        : args.ctx.used.calls;
  // Delegates to the pure engine (usage.ts) — the emergency-never-limited
  // rule has exactly one tested definition there.
  return resolveGateWithEmergency({
    axis: args.axis,
    used,
    limits: args.ctx.limits,
    planName: args.ctx.planName,
    isCurrentPlanPro: args.ctx.plan === "pro",
    emergency: args.emergency === true,
  });
}

/** Meter one successful action (call only after the send/turn actually happened). */
export async function meterAction(args: {
  businessId: string;
  ctx: PlanUsageContext;
  axis: GateAxis;
}): Promise<void> {
  await incrementUsage({
    businessId: args.businessId,
    periodStart: args.ctx.periodStart,
    axis: GATE_AXIS_COLUMNS[args.axis],
    delta: 1,
  });
}
