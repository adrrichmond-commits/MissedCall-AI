/**
 * Billing server functions (Phase 1 — schema + configuration + UI with honest
 * placeholders; no Stripe SDK, no checkout, no webhooks until Phase 2).
 *
 * EVERY handler resolves businessId from the authenticated session
 * (requireAuth / requireRole) — never from client input. Writes are
 * owner-gated following the settingsFns pattern; failures return typed
 * results instead of throwing.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireRole } from "~/lib/server/auth.server";
import { authErrorToResult } from "~/lib/server/sessionFns";
import * as q from "~/db/queries";
import type { BusinessPlan } from "~/db/schema";
import { BILLING_PHASE_NOTE, PLANS, TRIAL_DAYS, getPlan, type PlanConfig } from "~/lib/pricing";

export type BillingResult<T> = { ok: true; data: T } | { ok: false; status: 400 | 401 | 403 | 404; error: string };

/** Wire-safe plan snapshot (PLANS as a plain array for the client). */
export type PlanView = Pick<PlanConfig, "id" | "name" | "priceCents" | "tagline" | "features">;

export interface BillingOverview {
  /** Currently selected plan id ("trial" until a tier is chosen). */
  plan: string;
  planName: string | null;
  /** ISO string or null — Date objects never cross the wire. */
  trialEndsAt: string | null;
  subscriptionStatus: string | null;
  canEdit: boolean;
  /** Trial chip helpers — precomputed so the page stays dumb. */
  trialDaysRemaining: number | null;
  trialExpired: boolean;
  /** Static config from src/lib/pricing.ts. */
  plans: PlanView[];
  trialDays: number;
  phaseNote: string;
}

/**
 * Days left on trial, ceil, floored at 0. Null when trial_ends_at is unset.
 * Precomputing here keeps date math out of the client.
 */
function trialDaysRemaining(trialEndsAt: Date | null): { remaining: number | null; expired: boolean } {
  if (!trialEndsAt) return { remaining: null, expired: false };
  const ms = trialEndsAt.getTime() - Date.now();
  if (ms <= 0) return { remaining: 0, expired: true };
  return { remaining: Math.ceil(ms / (24 * 60 * 60 * 1000)), expired: false };
}

function planNameFor(plan: string): string | null {
  if (plan === "trial") return null;
  return getPlan(plan)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Read: billing overview (any role may read; writes are owner-only)
// ---------------------------------------------------------------------------
export const getBillingOverviewFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<BillingResult<BillingOverview>> => {
    try {
      const ctx = await requireRole("owner", "manager", "employee");
      const businessId = ctx.business.id;
      const business = await q.getBusiness(businessId);
      if (!business) return { ok: false, status: 404, error: "Business not found." };
      const trialEndsAt = business.trialEndsAt ?? null;
      const trial = trialDaysRemaining(trialEndsAt);
      return {
        ok: true,
        data: {
          plan: business.plan,
          planName: planNameFor(business.plan),
          trialEndsAt: trialEndsAt ? trialEndsAt.toISOString() : null,
          subscriptionStatus: business.subscriptionStatus ?? null,
          canEdit: ctx.role === "owner",
          trialDaysRemaining: trial.remaining,
          trialExpired: trial.expired,
          plans: PLANS.map(({ id, name, priceCents, tagline, features }) => ({ id, name, priceCents, tagline, features })),
          trialDays: TRIAL_DAYS,
          phaseNote: BILLING_PHASE_NOTE,
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Write: plan change — Phase 1 placeholder. Records the plan on the account;
// replaced by real Stripe checkout in Phase 2. Owner-only.
// ---------------------------------------------------------------------------
export const changePlanFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { planId?: unknown })
  .handler(async ({ data }): Promise<BillingResult<{ message: string; plan: string }>> => {
    try {
      const ctx = await requireRole("owner");
      const businessId = ctx.business.id;
      const planId = typeof data?.planId === "string" ? data.planId.trim() : "";
      const plan = getPlan(planId);
      if (!plan) {
        return { ok: false, status: 400, error: "Unknown plan. Choose Starter or Pro." };
      }
      const business = await q.getBusiness(businessId);
      if (!business) return { ok: false, status: 404, error: "Business not found." };
      if (business.plan === plan.id) {
        return { ok: true, data: { message: `You are already on ${plan.name}.`, plan: business.plan } };
      }
      // Phase 2 will replace this with a Stripe Checkout session; for now the
      // plan choice is simply recorded on the account.
      const updated = await q.updateBusinessPlan(businessId, plan.id as BusinessPlan);
      if (!updated) return { ok: false, status: 404, error: "Business not found." };
      // Re-activating on a plan clears a past cancellation (fresh start).
      if (updated.subscriptionStatus === "canceled") {
        await q.clearSubscriptionStatus(businessId);
      }
      return { ok: true, data: { message: `Plan recorded: ${plan.name}. ${BILLING_PHASE_NOTE}`, plan: updated.plan } };
    } catch (e) {
      return authErrorToResult(e);
    }
  });

// ---------------------------------------------------------------------------
// Write: cancel — sets subscription_status='canceled' and KEEPS plan data
// (data preservation is a product requirement). Owner-only. In Phase 2 this
// will cancel the Stripe subscription too.
// ---------------------------------------------------------------------------
export const cancelSubscriptionFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<BillingResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner");
      const businessId = ctx.business.id;
      const business = await q.getBusiness(businessId);
      if (!business) return { ok: false, status: 404, error: "Business not found." };
      if (business.subscriptionStatus === "canceled") {
        return { ok: true, data: { message: "Your subscription is already canceled." } };
      }
      await q.setSubscriptionStatus(businessId, "canceled");
      return {
        ok: true,
        data: {
          message:
            "Subscription canceled. Your plan selection is kept and your data is preserved — you can pick a plan again anytime.",
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);
