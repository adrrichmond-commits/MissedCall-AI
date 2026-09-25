/**
 * ROI panel engine (P5-2) — "is MissedCall AI paying for itself?", per business.
 *
 * PURE MODULE, NO I/O (same contract as revenue.ts / crmValue.ts): the
 * DB-facing caller is src/lib/server/roiPanel.ts (plain server module, not an
 * RPC — the P5-1 SSR pattern). Unit-tested DBless in scripts/test-p52-roi.ts.
 *
 * MEASURED vs ESTIMATED — the honest-labeling contract this module enforces:
 *
 *   MEASURED (real rows in the business's own account):
 *     callsReceived, missedCalls, autoResponded, customerReplies,
 *     leadsRecovered, appointmentsBooked
 *
 *   ESTIMATED (derived, never measured-from-real-invoices unless the shop
 *   entered one): jobsWon, revenueRecovered, roiMultiple. The engine stamps
 *   `estimateFlags` all-true for these — the UI renders a visible "Estimate"
 *   chip from these flags and the test suite pins them, so a future refactor
 *   cannot silently present an estimate as a measurement.
 *
 * MONEY: revenue recovered is the summed pipeline_value_cents of WON leads
 * (same source as revenue.ts — actual invoice when the shop entered one,
 * otherwise the quote, otherwise the KB typical range-high). That is an
 * ESTIMATE of recovered revenue until verified by real jobs, which is exactly
 * how the business plan scopes the KPI.
 *
 * ROI DEFINITION: estimated revenue recovered THIS MONTH (true calendar
 * month, nested — a win Monday still counts on the 20th) ÷ monthly
 * subscription cost. The subscription cost is NEVER hard-coded here — it is
 * resolved from src/lib/pricing.ts via the business's plan id (trial and
 * unknown plans cost $0 while they cost the owner nothing). Null ROI when the
 * cost is $0 (free trial — a division by zero is not a number a plumber
 * should see); 0.0× is a legitimate result when the month has no recovered
 * revenue yet.
 *
 * ZERO-DATA CONTRACT (same as revenue.ts): every count is a non-negative
 * integer, every money value a non-negative integer cents amount — never NaN,
 * never negative, never a thrown error for empty data. The ROI ratio is null
 * when its denominator is zero.
 */

import { getPlan } from "../pricing";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Counts measured from the business's own live rows (never estimated). */
export interface RoiMeasured {
  /** Captured calls — missed calls until voice receptionist lands (see revenue.ts). */
  callsReceived: number;
  /** Missed calls captured as leads. */
  missedCalls: number;
  /** Of those, conversations the AI text-back actually handled (≥1 AI reply). */
  autoResponded: number;
  /** Conversations where the customer sent at least one inbound message. */
  customerReplies: number;
  /** Missed-call leads with ≥1 SMS conversation (the "recovered" definition). */
  leadsRecovered: number;
  /** DISTINCT leads with ≥1 appointment row. */
  appointmentsBooked: number;
}

/** Derived figures — every one renders with a visible "Estimate" chip. */
export interface RoiEstimated {
  /** Leads marked won, all time. */
  jobsWon: number;
  /** Summed pipeline value of won leads, all time (USD cents). */
  revenueRecoveredCents: number;
  /** Same, current calendar month only (USD cents). */
  revenueRecoveredMonthCents: number;
  /** Estimated revenue recovered this month ÷ monthly subscription cost. */
  roiMultiple: number | null;
}

/** Subscription state, resolved from src/lib/pricing.ts — never a literal. */
export interface RoiBilling {
  /** The business's plan id as stored ('trial' until a plan is chosen). */
  planId: string;
  /** Human plan name from pricing.ts; "Free trial" for the trial plan. */
  planName: string;
  /** Monthly cost in USD cents from pricing.ts; 0 on trial/unknown plans. */
  monthlyCostCents: number;
  /** True while the business sits on the free trial (expired or not). */
  onTrial: boolean;
  /** Whole days left on the trial (0 when none/expired) — trialValue math. */
  trialDaysRemaining: number | null;
  /** The business has a recorded trial (trial-to-paid conversion is visible). */
  trialToPaidApplicable: boolean;
  /** Had a trial and now sits on a paid plan — the conversion happened. */
  trialToPaidConverted: boolean;
}

/** The full panel payload — all fields plain/serializable for the RPC wire. */
export interface RoiPanelData {
  measured: RoiMeasured;
  estimated: RoiEstimated;
  billing: RoiBilling;
  /**
   * The estimate-labeling contract: every flagged figure MUST render a
   * visible "Estimate" chip in the UI. Pinned all-true by the test suite.
   */
  estimateFlags: { jobsWon: boolean; revenueRecovered: boolean; roiMultiple: boolean };
  /** True when the business has any measured activity at all. */
  hasActivity: boolean;
}

/** Raw inputs the query layer gathers (untrusted — everything is sanitized). */
export interface RoiPanelInput {
  measured: RoiMeasured;
  /** Won leads, all time. */
  jobsWon: number;
  /** Summed pipeline value of won leads, all time (USD cents). */
  revenueRecoveredCents: number;
  /** Same, current calendar month only (USD cents). */
  revenueRecoveredMonthCents: number;
  /** The business's plan id ('trial' | 'starter' | 'pro' | legacy). */
  planId: string;
  /** Whole trial days remaining (null when the caller has no trial record). */
  trialDaysRemaining: number | null;
  /** The business has a trial_end date recorded. */
  hasTrialRecord: boolean;
}

// ---------------------------------------------------------------------------
// Sanitizers — identical rules to revenue.ts; the engine never trusts input
// ---------------------------------------------------------------------------

function safeCount(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeCents(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * Compute the ROI panel metric set. Total over garbage input: counts and
 * money pass sanitizers, the ROI ratio guards its denominator, and the
 * billing block resolves exclusively through src/lib/pricing.ts — no price
 * literal exists in this module or its callers.
 */
export function computeRoiPanel(input: RoiPanelInput): RoiPanelData {
  const measured: RoiMeasured = {
    callsReceived: safeCount(input.measured?.callsReceived),
    missedCalls: safeCount(input.measured?.missedCalls),
    autoResponded: safeCount(input.measured?.autoResponded),
    customerReplies: safeCount(input.measured?.customerReplies),
    leadsRecovered: safeCount(input.measured?.leadsRecovered),
    appointmentsBooked: safeCount(input.measured?.appointmentsBooked),
  };
  const jobsWon = safeCount(input.jobsWon);
  const revenueRecoveredCents = safeCents(input.revenueRecoveredCents);
  const revenueRecoveredMonthCents = Math.min(
    safeCents(input.revenueRecoveredMonthCents),
    revenueRecoveredCents,
  );

  // Subscription cost from the ONE pricing config (team rule: never hard-code
  // prices). Trial and unknown plan ids cost $0 — the owner pays nothing yet.
  const planId = typeof input.planId === "string" ? input.planId : "";
  const plan = getPlan(planId);
  const monthlyCostCents = plan?.priceCents ?? 0;
  const planName = plan?.name ?? (planId === "trial" || planId === "" ? "Free trial" : planId);
  const onTrial = planId === "trial";

  // ROI = estimated revenue recovered this month ÷ monthly subscription cost.
  // $0 cost (trial) → null: "free trial" is the honest label, not ∞ or 0×.
  const roiMultiple =
    monthlyCostCents > 0
      ? Math.round((revenueRecoveredMonthCents / monthlyCostCents) * 10) / 10
      : null;

  const trialToPaidApplicable = input.hasTrialRecord === true;
  const trialToPaidConverted = trialToPaidApplicable && plan != null;

  return {
    measured,
    estimated: { jobsWon, revenueRecoveredCents, revenueRecoveredMonthCents, roiMultiple },
    billing: {
      planId,
      planName,
      monthlyCostCents,
      onTrial,
      trialDaysRemaining: input.trialDaysRemaining == null ? null : safeCount(input.trialDaysRemaining),
      trialToPaidApplicable,
      trialToPaidConverted,
    },
    // The labeling contract: ALL three derived figures are estimates until
    // verified by real jobs. Pinned by scripts/test-p52-roi.ts.
    estimateFlags: { jobsWon: true, revenueRecovered: true, roiMultiple: true },
    hasActivity: Object.values(measured).some((n) => n > 0) || jobsWon > 0,
  };
}
