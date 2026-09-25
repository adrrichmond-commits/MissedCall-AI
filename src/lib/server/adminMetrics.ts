/**
 * P5-6 admin business metrics — PURE math (no DB, no network).
 *
 * The SQL layer (src/db/queries/adminMetrics.ts) hands over raw counts/lists;
 * this module assembles them into the /admin/metrics view. Kept pure so the
 * test suite (scripts/test-p56-admin.ts) can pin the math — especially the
 * honesty rules:
 *   - MRR is computed from src/lib/pricing.ts plan prices × paying accounts
 *     (subscription_status='active') — never hard-coded prices.
 *   - The trial→paid conversion rate is null when no trials have started
 *     (a 0-denominator rate is NEVER rendered as 0% — that would be
 *     misleading; null renders as "—" with an explanatory note).
 *   - Demo businesses (seed data) are excluded from the trial/conversion
 *     metrics and every attention list, matching the P4-A funnel view's
 *     real-vs-demo convention.
 *
 * This module is client-safe by construction (its only import is the client
 * safe pricing config); route files import TYPES from it, and the SSR-safe
 * read path in adminReads.ts imports it for compute.
 */
import { PLANS, TRIAL_DAYS, getPlan } from "~/lib/pricing";

// ---------------------------------------------------------------------------
// Filters (plan + date window) — sanitized from route search params
// ---------------------------------------------------------------------------

export const ADMIN_METRIC_PLAN_FILTERS = ["all", "starter", "pro", "trial"] as const;
export type AdminMetricPlanFilter = (typeof ADMIN_METRIC_PLAN_FILTERS)[number];

export const ADMIN_METRIC_WINDOWS = ["all", "7d", "30d", "90d"] as const;
export type AdminMetricWindow = (typeof ADMIN_METRIC_WINDOWS)[number];

export interface AdminMetricsFilters {
  plan: AdminMetricPlanFilter;
  window: AdminMetricWindow;
}

export const DEFAULT_ADMIN_METRICS_FILTERS: AdminMetricsFilters = {
  plan: "all",
  window: "all",
};

/** Whitelist-sanitize raw input (route search / RPC data). Unknown → default. */
export function sanitizeAdminMetricsFilters(input: {
  plan?: unknown;
  window?: unknown;
}): AdminMetricsFilters {
  const plan = ADMIN_METRIC_PLAN_FILTERS.includes(input?.plan as AdminMetricPlanFilter)
    ? (input.plan as AdminMetricPlanFilter)
    : "all";
  const window = ADMIN_METRIC_WINDOWS.includes(input?.window as AdminMetricWindow)
    ? (input.window as AdminMetricWindow)
    : "all";
  return { plan, window };
}

/** Days in a window filter; null = all time. */
export function adminMetricWindowDays(w: AdminMetricWindow): number | null {
  if (w === "7d") return 7;
  if (w === "30d") return 30;
  if (w === "90d") return 90;
  return null;
}

/** Window start (inclusive) or null for all time. */
export function adminMetricWindowStart(w: AdminMetricWindow, now: Date): Date | null {
  const days = adminMetricWindowDays(w);
  return days === null ? null : new Date(now.getTime() - days * 24 * 60 * 60_000);
}

/** A trial counts as "ending soon" within this many days. */
export const TRIAL_ENDING_SOON_DAYS = 3;
/** A business counts as "zero activity" only after this many days since signup. */
export const ZERO_ACTIVITY_MIN_AGE_DAYS = 7;

// ---------------------------------------------------------------------------
// Raw input (from the SQL layer — dates already ISO strings) + view types
// ---------------------------------------------------------------------------

export interface AdminPlanStatusCount {
  plan: string;
  subscriptionStatus: string | null;
  n: number;
}

export interface AdminAttentionItem {
  businessId: string;
  name: string;
  /** ISO string; semantics per list (trial end / signup date). */
  at: string;
  /** Trials only: whole days left, floored at 0. */
  daysLeft?: number;
}

export interface AdminMetricsRaw {
  /** Per (plan, subscription_status) account counts, already plan-filtered. */
  planStatusCounts: AdminPlanStatusCount[];
  /** Total businesses matching the plan filter. */
  totalAccounts: number;
  /** New signups inside the window (null when window = all). */
  signupsInWindow: number | null;
  /** Voice `calls` rows in the window (and plan filter), + distinct businesses. */
  callsInWindow: number;
  callsBusinesses: number;
  /** P4-A funnel events (demo businesses excluded): trial_start / paid. */
  trialStarts: number;
  paidAccounts: number;
  /** plan='trial' businesses whose trial window has not lapsed (demo excluded). */
  activeTrials: number;
  trialEndingSoon: AdminAttentionItem[];
  trialsExpiredNotConverted: AdminAttentionItem[];
  zeroActivity: AdminAttentionItem[];
  /** Demo businesses on the platform (disclosed, never counted above). */
  demoCount: number;
}

export interface AdminMetricsView {
  generatedAt: string;
  filters: AdminMetricsFilters;
  /** MRR: Σ plan price × paying accounts. Prices come from pricing.ts. */
  mrr: {
    cents: number;
    payingAccounts: number;
    /** Accounts subscribed but not yet billing (Stripe 'trialing'). */
    trialingAccounts: number;
    /** Honest labeling: Stripe is the source of truth; this is the local estimate. */
    note: string;
  };
  accounts: {
    total: number;
    paying: number;
    trialing: number;
    pastDue: number;
    canceled: number;
    noSubscription: number;
    trial: number;
  };
  trials: {
    /** plan='trial' and the window has not lapsed (demo excluded). */
    active: number;
    endingSoon: AdminAttentionItem[];
    expiredNotConverted: AdminAttentionItem[];
  };
  conversion: {
    trialStarts: number;
    paid: number;
    /** percent 0–100; null when no trials started (never a fake 0%). */
    ratePct: number | null;
  };
  planDistribution: { trial: number; starter: number; pro: number; unknown: number };
  /** New signups inside the window; null when window = all (never a fake 0). */
  signupsInWindow: number | null;
  callsProcessed: { total: number; businesses: number; window: AdminMetricWindow };
  attention: {
    trialEndingSoon: AdminAttentionItem[];
    trialsExpiredNotConverted: AdminAttentionItem[];
    zeroActivity: AdminAttentionItem[];
  };
  demoCount: number;
  zeroActivityMinAgeDays: number;
  trialEndingSoonDays: number;
  trialLengthDays: number;
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

/** Per-plan monthly price from the ONE pricing config (never literals). */
export function planPriceCents(planId: string): number | null {
  return getPlan(planId)?.priceCents ?? null;
}

const DAY_MS = 24 * 60 * 60_000;

/** Whole days from `atIso` until `now` (trials: ceil so "today" = 0..1 honest), floored at 0. */
export function daysLeftUntil(atIso: string, now: Date): number {
  const diff = new Date(atIso).getTime() - now.getTime();
  if (!Number.isFinite(diff)) return 0;
  return Math.max(0, Math.ceil(diff / DAY_MS));
}

export function computeAdminMetrics(
  raw: AdminMetricsRaw,
  filters: AdminMetricsFilters,
  now: Date,
): AdminMetricsView {
  // --- accounts breakdown from the (plan, status) count grid ---------------
  let paying = 0;
  let trialing = 0;
  let pastDue = 0;
  let canceled = 0;
  let noSubscription = 0;
  let trial = 0;
  const dist = { trial: 0, starter: 0, pro: 0, unknown: 0 };
  let mrrCents = 0;

  for (const row of raw.planStatusCounts) {
    // Plan filter: belt-and-braces (the SQL layer filters too). The pure
    // compute must be self-consistent even when handed unfiltered rows.
    if (filters.plan !== "all" && row.plan !== filters.plan) continue;
    const n = Math.max(0, Math.floor(row.n));
    if (row.plan === "starter" || row.plan === "pro") {
      // Prices ALWAYS resolve through pricing.ts; a missing price can only
      // mean the plan id vanished from PLANS — count the account but add
      // nothing to MRR (never invent a price).
      const price = planPriceCents(row.plan);
      if (row.subscriptionStatus === "active") {
        paying += n;
        mrrCents += (price ?? 0) * n;
      } else if (row.subscriptionStatus === "trialing") {
        trialing += n;
      } else if (row.subscriptionStatus === "past_due") {
        pastDue += n;
      } else if (row.subscriptionStatus === "canceled") {
        canceled += n;
      } else {
        noSubscription += n;
      }
    } else if (row.plan === "trial") {
      trial += n;
      // Null status on a trial row is the normal pre-checkout state — both
      // buckets exist so nothing is double counted below.
      if (row.subscriptionStatus === null || row.subscriptionStatus === undefined) {
        noSubscription += n;
      }
    } else {
      dist.unknown += n;
    }
    if (row.plan === "trial") dist.trial += n;
    else if (row.plan === "starter") dist.starter += n;
    else if (row.plan === "pro") dist.pro += n;
    else dist.unknown += n;
  }

  // --- trial→paid conversion (P4-A funnel events, demo excluded) -----------
  const trialStarts = Math.max(0, Math.floor(raw.trialStarts));
  const paidAccounts = Math.max(0, Math.floor(raw.paidAccounts));
  const ratePct = trialStarts > 0 ? Math.round((paidAccounts / trialStarts) * 100) : null;

  // --- attention lists already ISO; decorate ending-soon with daysLeft -----
  const trialEndingSoon = raw.trialEndingSoon.map((i) => ({
    ...i,
    daysLeft: daysLeftUntil(i.at, now),
  }));

  return {
    generatedAt: now.toISOString(),
    filters,
    mrr: {
      cents: mrrCents,
      payingAccounts: paying,
      trialingAccounts: trialing,
      note:
        "Computed from plan prices × accounts with an active subscription. " +
        "Stripe remains the source of truth for billed amounts.",
    },
    accounts: {
      total: Math.max(0, Math.floor(raw.totalAccounts)),
      paying,
      trialing,
      pastDue,
      canceled,
      noSubscription,
      trial,
    },
    trials: {
      active: Math.max(0, Math.floor(raw.activeTrials)),
      endingSoon: trialEndingSoon,
      expiredNotConverted: raw.trialsExpiredNotConverted,
    },
    conversion: { trialStarts, paid: paidAccounts, ratePct },
    planDistribution: dist,
    signupsInWindow: raw.signupsInWindow === null ? null : Math.max(0, Math.floor(raw.signupsInWindow)),
    callsProcessed: {
      total: Math.max(0, Math.floor(raw.callsInWindow)),
      businesses: Math.max(0, Math.floor(raw.callsBusinesses)),
      window: filters.window,
    },
    attention: {
      trialEndingSoon,
      trialsExpiredNotConverted: raw.trialsExpiredNotConverted,
      zeroActivity: raw.zeroActivity,
    },
    demoCount: Math.max(0, Math.floor(raw.demoCount)),
    zeroActivityMinAgeDays: ZERO_ACTIVITY_MIN_AGE_DAYS,
    trialEndingSoonDays: TRIAL_ENDING_SOON_DAYS,
    trialLengthDays: TRIAL_DAYS,
  } satisfies AdminMetricsView;
}

/** All configured plan ids (for disclosure when distribution shows 'unknown'). */
export function knownPlanIds(): string[] {
  return PLANS.map((p) => p.id);
}
