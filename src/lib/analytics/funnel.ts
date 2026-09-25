/**
 * P4-A funnel math (pure, unit-tested) — the visitor→paid pipeline stages and
 * the conversion between consecutive stages.
 *
 * HONESTY CONTRACT: every count comes from real funnel_events rows (migration
 * 019). A stage with zero businesses shows zero; a conversion step whose
 * previous stage has zero businesses is null ("—"), never a fabricated
 * percentage. This module ships the infrastructure — real traffic arrives
 * with launch, and nothing here invents numbers.
 */
export const FUNNEL_STAGES = [
  "signup",
  "trial_start",
  "onboarding_completed",
  "phone_connected",
  "first_lead",
  "first_recovered_call",
  "paid",
] as const;

export type FunnelStageName = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_STAGE_LABELS: Record<FunnelStageName, string> = {
  signup: "Signed up",
  trial_start: "Trial started",
  onboarding_completed: "Onboarding completed",
  phone_connected: "Phone connected",
  first_lead: "First lead captured",
  first_recovered_call: "First recovered call",
  paid: "Paid",
};

export type StageCounts = Partial<Record<FunnelStageName, number>>;

export interface FunnelStep {
  stage: FunnelStageName;
  label: string;
  /** Businesses that reached this stage. */
  count: number;
  /**
   * Share of the previous stage's businesses that also reached this stage,
   * in percent (0–100, rounded). null when the previous stage count is 0 —
   * a percentage over zero businesses is not a number, it is a lie.
   */
  conversionFromPrev: number | null;
}

/**
 * Build the ordered funnel view from raw per-stage counts. Unknown/missing
 * stages count as 0 (a stage nobody reached is a stage with no rows).
 */
export function funnelSteps(counts: StageCounts): FunnelStep[] {
  let prev = 0;
  return FUNNEL_STAGES.map((stage, i) => {
    const count = Math.max(0, Math.floor(counts[stage] ?? 0));
    const conversionFromPrev = i === 0 ? null : prev > 0 ? Math.round((count / prev) * 100) : null;
    prev = count;
    return { stage, label: FUNNEL_STAGE_LABELS[stage], count, conversionFromPrev };
  });
}

/**
 * End-to-end conversion: paid ÷ signup, percent. null when no signups —
 * "0%" over zero signups would read as "everyone churned", which nobody
 * measured.
 */
export function overallConversion(counts: StageCounts): number | null {
  const signup = Math.max(0, Math.floor(counts.signup ?? 0));
  const paid = Math.max(0, Math.floor(counts.paid ?? 0));
  if (signup === 0) return null;
  return Math.round((paid / signup) * 100);
}
