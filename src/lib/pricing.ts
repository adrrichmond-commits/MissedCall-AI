/**
 * Locked pricing configuration (owner decision, Phase 1).
 *
 * SINGLE source of truth for plan data — every UI surface and server
 * validation reads from here. Never hard-code prices in components.
 * Stripe checkout arrives in Phase 2; until then plan changes are recorded
 * on the account (see src/lib/server/billingFns.ts).
 */

export interface PlanConfig {
  /** Stable plan id — stored in businesses.plan when selected. */
  id: "starter" | "pro";
  name: string;
  /** Monthly price in cents (Stripe-compatible). */
  priceCents: number;
  tagline: string;
  features: string[];
}

export const PLANS: readonly PlanConfig[] = [
  {
    id: "starter",
    name: "Starter",
    priceCents: 14900,
    tagline: "Everything a small shop needs to stop losing missed calls.",
    features: [
      "AI receptionist",
      "Missed-call text-back",
      "Lead capture",
      "Call summaries",
      "Dashboard",
      "SMS notifications",
    ],
  },
  {
    id: "pro",
    name: "Pro",
    priceCents: 24900,
    tagline: "For growing teams that want bookings on autopilot.",
    features: [
      "Everything in Starter",
      "Higher call volume",
      "Appointment requests",
      "Advanced follow-ups",
      "Advanced analytics",
    ],
  },
] as const;

/** Free-trial length in days (owner-locked). */
export const TRIAL_DAYS = 14;

/** Phase 1 placeholder notice shown wherever money would change hands. */
export const BILLING_PHASE_NOTE =
  "Billing checkout goes live in Phase 2 — for now plan changes are recorded in your account.";

/** "149" from 14900 — prices render from cents, never from literals. */
export function formatPlanPrice(plan: PlanConfig): string {
  return String(Math.floor(plan.priceCents / 100));
}

export function getPlan(planId: string): PlanConfig | undefined {
  return PLANS.find((p) => p.id === planId);
}
