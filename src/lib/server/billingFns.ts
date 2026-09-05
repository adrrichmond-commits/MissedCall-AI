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
import { BILLING_PHASE_NOTE, PLANS, TRIAL_DAYS, getPlan, limitsForPlan, type PlanConfig } from "~/lib/pricing";
import { readStripeConfig } from "~/lib/server/stripeWebhook";
import { currentPeriodStart } from "~/lib/server/usage";
import { usagePercent, usageLabel } from "~/lib/server/usage";

export type BillingResult<T> = { ok: true; data: T } | { ok: false; status: 400 | 401 | 403 | 404; error: string };

/** Wire-safe plan snapshot (PLANS as a plain array for the client). */
export type PlanView = Pick<PlanConfig, "id" | "name" | "priceCents" | "tagline" | "features" | "checkoutUrl">;

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
          plans: PLANS.map(({ id, name, priceCents, tagline, features, checkoutUrl }) => ({
            id,
            name,
            priceCents,
            tagline,
            features,
            checkoutUrl,
          })),
          trialDays: TRIAL_DAYS,
          phaseNote: BILLING_PHASE_NOTE,
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);

// NOTE: there is intentionally no in-app plan-change writer. There is no
// Stripe API key in this app (platform-managed account), so plan activation
// happens after payment on Stripe's hosted checkout — not from a button here.
// ---------------------------------------------------------------------------
// Write: cancel — sets subscription_status='canceled' and KEEPS plan data
// (data preservation is a product requirement). Owner-only. In Phase 2 this
// will cancel the Stripe subscription too.
// ---------------------------------------------------------------------------
export const cancelSubscriptionFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<BillingResult<CancelResult>> => {
    try {
      const ctx = await requireRole("owner");
      const businessId = ctx.business.id;
      const business = await q.getBusiness(businessId);
      if (!business) return { ok: false, status: 404, error: "Business not found." };
      const settings = (business.settings ?? {}) as Record<string, unknown>;
      if (settings.billingCancelAtPeriodEnd === true) {
        return { ok: true, data: { message: "Cancellation is already scheduled.", serviceEndsAt: null, daysRemaining: null, alreadyScheduled: true } };
      }
      // cancel_at_period_end: service continues until the current billing
      // period ends; the data is NEVER touched (product requirement). The
      // period end is the subscription truth (Stripe's current_period_end
      // when the webhook set it) or the next billing-period anchor.
      const anchor = business.currentPeriodEnd ?? currentPeriodStart(business.trialEndsAt ?? business.createdAt, new Date());
      const serviceEndsAt = business.currentPeriodEnd
        ? business.currentPeriodEnd
        : new Date(anchor.getTime() + 30 * 24 * 60 * 60 * 1000);
      await q.setCancelAtPeriodEnd(businessId, serviceEndsAt);
      await q.createBillingEvent({
        businessId,
        type: "subscription_canceled",
        source: "local",
        description: "Cancellation scheduled — service continues until " + serviceEndsAt.toISOString().slice(0, 10),
        payload: { serviceEndsAt: serviceEndsAt.toISOString(), stripeSynced: readStripeConfig() != null },
      });
      const days = Math.max(0, Math.ceil((serviceEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
      return {
        ok: true,
        data: {
          message:
            "Cancellation scheduled. Your service stays active until " +
            serviceEndsAt.toISOString().slice(0, 10) +
            " (" + days + " days). Your plan selection and all data are preserved — reactivate anytime before then.",
          serviceEndsAt: serviceEndsAt.toISOString(),
          daysRemaining: days,
          alreadyScheduled: false,
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);

// ---------------------------------------------------------------------------
// P3-F: plan lifecycle — upgrade / downgrade / reactivate + usage + history
// ---------------------------------------------------------------------------
export interface CancelResult {
  message: string;
  /** ISO string when cancellation is scheduled. */
  serviceEndsAt: string | null;
  daysRemaining: number | null;
  alreadyScheduled: boolean;
}

export interface UsageVsLimits {
  axis: string;
  /** Human axis name for the UI. */
  label: string;
  used: number;
  limit: number;
  percent: number;
  usageText: string;
  atLimit: boolean;
}

export interface BillingHistoryEntry {
  id: string;
  type: string;
  source: string;
  description: string | null;
  occurredAt: string;
}

export interface BillingOverviewP3F {
  /** True when Stripe keys are present — plan changes go through checkout. */
  billingConfigured: boolean;
  /** Current plan usage vs plan limits (current billing period). */
  usage: UsageVsLimits[];
  /** Cancellation scheduled via cancel_at_period_end, when set. */
  cancelAtPeriodEnd: boolean;
  serviceEndsAt: string | null;
  daysUntilServiceEnd: number | null;
  /** Newest-first billing history (webhook + local lifecycle events). */
  history: BillingHistoryEntry[];
}

/**
 * Owner-only plan change (upgrade or downgrade). HONEST GATING: without
 * Stripe keys there is no payment rail, so the change is NOT applied and no
 * fake success is returned — the UI shows the "billing not configured"
 * state and the Stripe checkout link instead. With keys present, the caller
 * opens Stripe checkout; the plan flips when the webhook confirms payment
 * (the same rule the P2 activation path already enforces).
 */
export const requestPlanChangeFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const v = input as { planId?: unknown };
    return { planId: typeof v?.planId === "string" ? v.planId : "" };
  })
  .handler(async ({ data }): Promise<BillingResult<{ message: string; checkoutUrl: string | null }>> => {
    try {
      const ctx = await requireRole("owner");
      const businessId = ctx.business.id;
      const target = getPlan(data.planId);
      if (!target) return { ok: false, status: 400, error: "Unknown plan." };
      const business = await q.getBusiness(businessId);
      if (!business) return { ok: false, status: 404, error: "Business not found." };
      if (business.plan === target.id) {
        return { ok: true, data: { message: `You are already on ${target.name}.`, checkoutUrl: null } };
      }
      const stripe = readStripeConfig();
      if (!stripe) {
        // HONEST STATE: no Stripe keys in this deployment — there is no way
        // to take payment, so the change is refused with the checkout link,
        // never silently applied.
        return {
          ok: false,
          status: 400,
          error:
            "Billing is not configured yet, so plan changes can't be applied here. Use the secure Stripe checkout link on the plan card to switch plans — your selection activates after payment.",
        };
      }
      // With keys present the UI redirects to Stripe hosted checkout; the
      // webhook (customer.subscription.*) is the only writer that flips the
      // plan — same single-writer rule as Phase 2 activation.
      return {
        ok: true,
        data: {
          message: `Opening secure checkout for ${target.name} — your plan updates automatically after payment.`,
          checkoutUrl: target.checkoutUrl,
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  });

/**
 * Reactivation: clears a scheduled cancel_at_period_end and restores normal
 * service. Never deletes anything (nothing was deleted); logs the event.
 */
export const reactivateSubscriptionFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<BillingResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner");
      const businessId = ctx.business.id;
      const business = await q.getBusiness(businessId);
      if (!business) return { ok: false, status: 404, error: "Business not found." };
      const settings = (business.settings ?? {}) as Record<string, unknown>;
      if (settings.billingCancelAtPeriodEnd !== true) {
        return { ok: true, data: { message: "Your subscription is active — nothing to reactivate." } };
      }
      await q.clearCancelAtPeriodEnd(businessId);
      await q.createBillingEvent({
        businessId,
        type: "reactivated",
        source: "local",
        description: "Subscription reactivated — scheduled cancellation removed.",
        payload: {},
      });
      return {
        ok: true,
        data: { message: "Welcome back! Your subscription continues as before — no data was lost." },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);

/** Build the usage-vs-limits rows for the billing page (current period). */
function usageRowsFor(args: {
  plan: string;
  planName: string;
  usage: { sms: number; aiTurns: number; calls: number };
}): UsageVsLimits[] {
  const limits = limitsForPlan(args.plan);
  const rows: { axis: string; label: string; used: number; limit: number }[] = [
    { axis: "sms", label: "SMS messages", used: args.usage.sms, limit: limits.sms_per_month },
    { axis: "ai_turns", label: "AI conversation turns", used: args.usage.aiTurns, limit: limits.ai_turns_per_month },
    { axis: "calls", label: "Calls handled", used: args.usage.calls, limit: limits.calls_per_month },
  ];
  return rows.map((r) => ({
    ...r,
    percent: usagePercent(r.used, r.limit),
    usageText: usageLabel(r.used, r.limit),
    atLimit: r.used >= r.limit,
  }));
}

/**
 * Billing page data: usage vs limits for the CURRENT billing period, the
 * cancel_at_period_end state, and the billing history ledger. Read-only,
 * any role; the upgrade CTA targets the existing plan cards.
 */
export const getBillingDetailsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<BillingResult<BillingOverviewP3F>> => {
    try {
      const ctx = await requireRole("owner", "manager", "employee");
      const businessId = ctx.business.id;
      const business = await q.getBusiness(businessId);
      if (!business) return { ok: false, status: 404, error: "Business not found." };
      const { loadPlanUsageContext } = await import("~/lib/server/usageGate");
      const ctxUsage = await loadPlanUsageContext(businessId, business.trialEndsAt ?? business.createdAt);
      const settings = (business.settings ?? {}) as Record<string, unknown>;
      const cancelScheduled = settings.billingCancelAtPeriodEnd === true;
      const serviceEndsAt = typeof settings.billingServiceEndsAt === "string" ? settings.billingServiceEndsAt : null;
      const events = await q.listBillingEvents(businessId, 50);
      return {
        ok: true,
        data: {
          billingConfigured: readStripeConfig() != null,
          usage: usageRowsFor({
            plan: ctxUsage.plan,
            planName: ctxUsage.planName,
            usage: ctxUsage.used,
          }),
          cancelAtPeriodEnd: cancelScheduled,
          serviceEndsAt,
          daysUntilServiceEnd: serviceEndsAt
            ? Math.max(0, Math.ceil((new Date(serviceEndsAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
            : null,
          history: events.map((e) => ({
            id: e.id,
            type: e.type,
            source: e.source,
            description: e.description,
            occurredAt: e.occurredAt.toISOString(),
          })),
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);
