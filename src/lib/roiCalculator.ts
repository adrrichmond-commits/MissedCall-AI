/**
 * P5-7 public ROI calculator engine — PURE MODULE, NO I/O (same contract as
 * the P5-2 ROI engine in src/lib/server/roi.ts, which this module MIRRORS).
 *
 * WHAT IS SHARED WITH THE P5-2 ROI PANEL (documented per the P5-7 brief):
 *   - PLAN PRICES: resolved exclusively from src/lib/pricing.ts via getPlan()
 *     — the exact import the roi.ts engine uses. No price literal exists here.
 *   - THE ROI DEFINITION: estimated monthly revenue recovered ÷ monthly plan
 *     cost, rounded to 1 decimal — the same definition as roi.ts's
 *     roiMultiple. A $0-cost plan (trial) yields null, never ∞.
 *   - THE ESTIMATE CONTRACT: every derived figure this engine produces is an
 *     ESTIMATE and the UI must render a visible "Estimate" chip on it, exactly
 *     like the panel's estimateFlags contract pinned by scripts/test-p52-roi.ts.
 *
 * WHAT IS NEW HERE (and why): the P5-2 panel derives revenue from MEASURED
 * rows (won leads' pipeline values) — it has no rate constants to reuse. A
 * public visitor has no rows, so the calculator needs fixed planning rates.
 * They live ONCE here (not copied anywhere) so the calculator, and any future
 * surface that needs a pre-data estimate, read the same numbers. They are
 * deliberately conservative and are labeled as assumptions in the UI — they
 * are NOT measured averages, and nothing on the marketing page may present
 * them as results real customers achieved.
 */

import { getPlan, type PlanConfig } from "./pricing";

/**
 * The conservative planning assumptions, each with its honest rationale:
 *
 *   - WEEKS_PER_MONTH = 52/12: calendar conversion, not a rounded 4.
 *   - REPLY_RATE = 0.30 — of the missed callers, roughly three in ten engage
 *     with the text-back. Many callers have already dialed the next plumber
 *     by the time the text arrives; the text-back engages some of them.
 *   - REPLY_TO_LEAD_RATE = 0.70 — of the replies, most carry a real service
 *     need (name/problem/address); the rest are wrong numbers or spam.
 *   - LEAD_TO_JOB_RATE = 0.30 — of recovered leads, the shop wins roughly
 *     three in ten once it calls back (price shoppers, already-fixed, out of
 *     area account for the rest). Kept deliberately low: a missed-call lead
 *     is warmer than a cold list but not a guaranteed job.
 */
export const ROI_CALCULATOR_ASSUMPTIONS = {
  weeksPerMonth: 52 / 12,
  replyRate: 0.3,
  replyToLeadRate: 0.7,
  leadToJobRate: 0.3,
} as const;

/**
 * Illustrative input defaults, shown honestly as placeholders in the UI —
 * NEVER presented as market data. averageJobValue sits inside the knowledge
 * base's "typical small residential job" band for common plumbing work
 * (drain clearing, leaks, fixtures — see src/lib/server/kb/services.ts
 * typicalValue ranges, e.g. $100–$600) — it is an illustrative midpoint of
 * common small jobs, not an average of real jobs.
 */
export const ROI_CALCULATOR_DEFAULTS = {
  missedCallsPerWeek: 6,
  averageJobValueCents: 35_000,
} as const;

/** Hard input bounds — the UI clamps to these, the engine sanitizes anyway. */
export const ROI_CALCULATOR_INPUT_BOUNDS = {
  maxMissedCallsPerWeek: 500,
  maxJobValueCents: 100_000_000, // $1,000,000
} as const;

// ---------------------------------------------------------------------------
// Shapes (all plain/serializable)
// ---------------------------------------------------------------------------

export interface RoiCalculatorInput {
  /** Missed calls per week — the visitor's own input. */
  missedCallsPerWeek: number;
  /** Average job value in CENTS — the visitor's own input. */
  averageJobValueCents: number;
}

export interface RoiCalculatorResult {
  /** Monthly missed calls = weekly × weeks/month (1-decimal display value). */
  monthlyMissedCalls: number;
  /** Estimated leads recovered per month (1-decimal display value). */
  estimatedLeadsPerMonth: number;
  /** Estimated jobs won per month (1-decimal display value). */
  estimatedJobsPerMonth: number;
  /** Estimated revenue recovered per month (whole cents). */
  estimatedRevenueCents: number;
  /** Per-plan view: revenue minus cost and the panel-style ROI multiple. */
  plans: {
    planId: PlanConfig["id"];
    priceCents: number;
    /** estimatedRevenueCents − priceCents (the "what's left over" figure). */
    netCents: number;
    /** The P5-2 ROI definition: recovered ÷ cost, 1 decimal; null only if cost is 0. */
    roiMultiple: number | null;
  }[];
  /**
   * The estimate-labeling contract (mirrors roi.ts estimateFlags): every
   * derived figure above is an estimate and the UI MUST chip it.
   */
  estimateFlags: { revenue: boolean; jobs: boolean; leads: boolean };
}

// ---------------------------------------------------------------------------
// Sanitizers — identical rules to the P5-2 engine; never trust input
// ---------------------------------------------------------------------------

function safeCount(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeCents(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp(n: number, max: number): number {
  return Math.min(n, max);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Compute the calculator result. Total over garbage input: everything
 * sanitizes to 0 and the plan block still renders from pricing.ts — never
 * NaN, never negative, never a thrown error.
 */
export function computeRoiCalculator(input: RoiCalculatorInput): RoiCalculatorResult {
  const missedPerWeek = clamp(safeCount(input?.missedCallsPerWeek), ROI_CALCULATOR_INPUT_BOUNDS.maxMissedCallsPerWeek);
  const jobValueCents = clamp(safeCents(input?.averageJobValueCents), ROI_CALCULATOR_INPUT_BOUNDS.maxJobValueCents);

  const a = ROI_CALCULATOR_ASSUMPTIONS;
  const monthlyMissedCalls = missedPerWeek * a.weeksPerMonth;
  const estimatedLeadsPerMonth = monthlyMissedCalls * a.replyRate * a.replyToLeadRate;
  const estimatedJobsPerMonth = estimatedLeadsPerMonth * a.leadToJobRate;
  // Round DOWN to whole dollars of revenue: the conservative direction.
  const estimatedRevenueCents = Math.floor((estimatedJobsPerMonth * jobValueCents) / 100) * 100;

  // Prices straight from the ONE pricing config (team rule), and the ROI
  // multiple uses the P5-2 engine's exact definition (1-decimal, null at $0).
  const plans = (["starter", "pro"] as const).map((planId) => {
    const plan = getPlan(planId);
    const priceCents = plan?.priceCents ?? 0;
    return {
      planId,
      priceCents,
      netCents: estimatedRevenueCents - priceCents,
      roiMultiple:
        priceCents > 0
          ? Math.round((estimatedRevenueCents / priceCents) * 10) / 10
          : null,
    };
  });

  return {
    monthlyMissedCalls: Math.round(monthlyMissedCalls * 10) / 10,
    estimatedLeadsPerMonth: Math.round(estimatedLeadsPerMonth * 10) / 10,
    estimatedJobsPerMonth: Math.round(estimatedJobsPerMonth * 10) / 10,
    estimatedRevenueCents,
    plans,
    estimateFlags: { revenue: true, jobs: true, leads: true },
  };
}

/** Format cents as "$1,234" (negatives as "-$123") for estimate display. */
export function formatCentsAsDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(Math.round(cents / 100)).toLocaleString("en-US");
  return `${sign}$${dollars}`;
}
