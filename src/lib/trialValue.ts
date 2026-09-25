/**
 * P4-V (owner requirement 10): the trial value indicator.
 *
 * During the 14-day trial a plumber must SEE the product paying for itself:
 * a prominent line counting the potential customers the AI has recovered —
 * leads captured from missed calls where the text-back actually engaged the
 * caller (the same "recovered" definition as the missed-call recovery funnel,
 * src/db/queries/leads.ts missedCallRecoveryStats). Real counts only: when
 * nobody has been recovered yet the view says so honestly and points at the
 * fix (connect the business phone number), never a fabricated number.
 *
 * Pure and DB-free so the battery can test the math directly.
 */

export interface TrialValueInput {
  /** businesses.plan === 'trial' and the trial has not expired. */
  isTrial: boolean;
  /** Recovered/qualified leads captured by the AI (funnel "recovered"). */
  recoveredCount: number;
  /** Whole days left in the trial (0 when expired/unknown). */
  daysRemaining: number;
}

export interface TrialValueView {
  /** False → render nothing (paid plans, or trial already over). */
  show: boolean;
  /** Count displayed in the headline; 0 in the zero state. */
  recoveredCount: number;
  /** e.g. "Your AI has recovered 3 potential customers". Empty when hidden. */
  headline: string;
  /** Supporting line: trial time left, or the honest zero-state guidance. */
  subline: string;
  /** True when recoveredCount === 0 → subline is the connect-your-number nudge. */
  zeroState: boolean;
}

export const TRIAL_ZERO_STATE_MESSAGE =
  "Your AI hasn't recovered anyone yet — connect your number so it can start.";

/** Whole days left until the trial ends; 0 when null/past. Mirrors sessionFns. */
export function trialDaysRemaining(trialEndsAtMs: number | null, nowMs: number): number {
  if (trialEndsAtMs == null) return 0;
  const diff = trialEndsAtMs - nowMs;
  if (diff <= 0) return 0;
  return Math.max(1, Math.ceil(diff / 86_400_000));
}

export function trialValueView(input: TrialValueInput): TrialValueView {
  if (!input.isTrial) {
    return {
      show: false,
      recoveredCount: 0,
      headline: "",
      subline: "",
      zeroState: false,
    };
  }
  const count = Math.max(0, Math.floor(input.recoveredCount));
  const zero = count === 0;
  const noun = count === 1 ? "customer" : "customers";
  return {
    show: true,
    recoveredCount: count,
    headline: zero
      ? "Your AI hasn't recovered anyone yet"
      : `Your AI has recovered ${count} potential ${noun}`,
    subline: zero
      ? TRIAL_ZERO_STATE_MESSAGE
      : input.daysRemaining > 0
        ? `That's ${count} job${count === 1 ? "" : "s"} you might have missed. ${input.daysRemaining} day${input.daysRemaining === 1 ? "" : "s"} left in your free trial.`
        : `That's ${count} job${count === 1 ? "" : "s"} you might have missed.`,
    zeroState: zero,
  };
}
