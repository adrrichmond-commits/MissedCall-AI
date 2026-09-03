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
  /**
   * Stripe hosted checkout link (Phase 2). Payment Card is a platform-managed
   * Stripe account — there is no API key in this app, so checkout happens on
   * Stripe's hosted page and the prices below must match the Stripe prices.
   * Only edit prices here AND in Stripe together.
   */
  checkoutUrl: string;
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
    checkoutUrl: "https://buy.stripe.com/14AdR92cmetM265fxt7Re07",
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
    checkoutUrl: "https://buy.stripe.com/3cI3cv8AKdpI7qp8517Re08",
  },
] as const;

/** Free-trial length in days (owner-locked). */
export const TRIAL_DAYS = 14;

/** Honest checkout note shown wherever money changes hands. */
export const BILLING_PHASE_NOTE =
  "Checkout is handled securely on Stripe. Your plan is activated after payment confirmation.";

/** "149" from 14900 — prices render from cents, never from literals. */
export function formatPlanPrice(plan: PlanConfig): string {
  return String(Math.floor(plan.priceCents / 100));
}

export function getPlan(planId: string): PlanConfig | undefined {
  return PLANS.find((p) => p.id === planId);
}
