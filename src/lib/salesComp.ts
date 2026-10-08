/**
 * salesComp.ts — the PURE commission engine behind the admin Sales tab.
 *
 * No DB, no env, no clock: every function takes its inputs as plain values
 * (the query layer resolves the real data) so the money math is 100%
 * unit-testable and the tab can never invent a number the inputs don't
 * support. All amounts are integer cents.
 *
 * DEAL MODEL (per rep, stored on the sales_reps row as data):
 *   bounty  — one-time, per plan, earned ONLY on the account's FIRST
 *             SUCCESSFUL PAYMENT. A trial signup is never a payout event.
 *   monthly — per plan, per ACTIVE month, following the plan the account is
 *             ACTUALLY on (read live — a downgrade switches the rate), and
 *             stopping when the account is canceled.
 *   step-down (optional variant) — from the month AFTER the account's Nth
 *             paid month, the monthly rate drops to the step-down rate.
 *
 * ---------------------------------------------------------------------------
 * DERIVATIONS (the honest core — what each number is allowed to come from)
 * ---------------------------------------------------------------------------
 *
 * FIRST SUCCESSFUL PAYMENT (bounty trigger)
 *   1. billing history: an activation event exists — a billing_events row of
 *      type 'checkout_completed' with payload->>'status' = 'active' (the
 *      Stripe webhook writes exactly this when a subscription becomes active;
 *      Stripe only sets a subscription 'active' once its invoice is paid — a
 *      trial subscription arrives as 'trialing', which is NOT a payment).
 *      The earliest such row is also FIRST-PAID-AT.
 *   2. fallback: no activation event but subscription_status is 'active' or
 *      'past_due' — the account IS in a paid state right now (Stripe's
 *      'active' requires the current invoice paid; 'past_due'/'unpaid' only
 *      arise after a prior successful payment), so a payment must have
 *      happened. The bounty earns, but firstPaidAt stays unknown and the
 *      paid-month count honestly reports 0 with a note (below).
 *   'trialing', 'canceled' with no activation event, and NULL never earn.
 *
 * PAID-MONTH COUNTING (monthly accrual + the step-down boundary)
 *   The ledger records status transitions, not invoices: renewal months do
 *   not each leave a distinct, reliable row, so exact per-invoice counting is
 *   NOT supportable from billing history. The chosen derivation is
 *   day-aligned calendar arithmetic anchored on firstPaidAt — the simplest
 *   source the data actually supports, documented here on purpose:
 *
 *     paidMonths(asOf) = fullMonthsElapsed(firstPaidAt, paidThroughAt) + 1
 *
 *   where fullMonthsElapsed counts COMPLETED month boundaries day-aligned
 *   (Jan 10 → Feb 5 = 0 elapsed: the February renewal has not happened yet;
 *   Jan 10 → Feb 15 = 1) and paidThroughAt is:
 *     - now (the caller's asOf) while the account is paying — status
 *       'active' or 'past_due'. past_due still accrues: in Stripe's model a
 *       past-due subscription is an ACTIVE subscription in a retry window,
 *       not a cancellation; accrual stops at 'canceled'.
 *     - the cancellation moment (latest 'subscription_canceled' billing
 *       event, resolved by the query layer) once canceled. The calendar
 *       month containing a mid-month cancellation keeps its month only when
 *       a renewal already fell inside it (the day-aligned rule above).
 *   If firstPaidAt is unknown (fallback-earned bounty with no activation
 *   event) paidMonths is 0 and the monthly comp is NOT counted — the ledger
 *   self-heals at the next activation/renewal event, which stamps a new
 *   'checkout_completed' row and restarts counting from a real date. That
 *   undercounts rather than invents; the account view carries the note.
 *
 *   STEP-DOWN: month N's index is 1-based over the counted months
 *   (firstPaidAt's month = 1). stepDownAfterMonths = 12 keeps the full rate
 *   for months 1..12 and applies the stepped rate from month 13 — i.e. the
 *   12th paid month is FULL, the 13th is STEPPED. Without a step-down
 *   (null), every month is the full rate.
 *
 * LIFETIME MONTHLY COMP
 *   Each counted paid month is valued at the account's CURRENT plan rate
 *   (with the step-down applied per month index). The ledger cannot
 *   reconstruct a per-month historical plan trail, so lifetime uses the live
 *   plan — the same basis the deal pays on — and a downgrade revalues
 *   counted months at the moment businesses.plan reflects it. Documented
 *   simplification, never a fabricated rate.
 *
 * PLAN
 *   businesses.plan when it is 'starter' | 'pro'. Cancellation resets
 *   businesses.plan to 'trial' (the webhook does this), so the query layer
 *   also passes the plan stamped on the account's LATEST billing-history
 *   event that carries a plan; the engine uses it when the live plan is
 *   'trial' and never invents one when both are empty.
 *
 * OWED NOW
 *   accrued (lifetime bounty + lifetime monthly) − recorded payouts. The
 *   payout ledger is append-only and never edits accrual; owed may go
 *   negative if the owner paid ahead — that renders as a negative number,
 *   not a dash.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SalesCompPlan = "starter" | "pro" | "trial";
export type SalesCompSubStatus = "active" | "trialing" | "past_due" | "canceled";

/** The comp schedule exactly as stored on the sales_reps row (cents). */
export interface SalesCompSchedule {
  bountyStarterCents: number;
  bountyProCents: number;
  monthlyStarterCents: number;
  monthlyProCents: number;
  /** null = no step-down. */
  stepDownAfterMonths: number | null;
  stepDownMonthlyStarterCents: number | null;
  stepDownMonthlyProCents: number | null;
}

/** One attributed account, as resolved by the query layer (ISO strings). */
export interface SalesCompAccountInput {
  businessId: string;
  businessName: string;
  plan: SalesCompPlan | null;
  subscriptionStatus: SalesCompSubStatus | null;
  /** Earliest activation billing event (checkout_completed + status active), or null. */
  firstPaidAt: string | null;
  /** Latest subscription_canceled billing event when the account is canceled, or null. */
  canceledAt: string | null;
  /** Plan stamped on the account's latest billing event carrying one, or null. */
  ledgerPlan: SalesCompPlan | null;
  /** When the attribution was set (ISO) — display only. */
  attributedAt: string | null;
}

export interface SalesCompAccountView {
  businessId: string;
  businessName: string;
  plan: SalesCompPlan | null;
  subscriptionStatus: SalesCompSubStatus | null;
  /** Currently paying: 'active' or 'past_due' (Stripe: past-due is still an active sub). */
  paying: boolean;
  firstPaymentMade: boolean;
  firstPaidAt: string | null;
  /** Bounty for this account's plan — 0 until the first payment (or with no schedule). */
  bountyCents: number;
  /** Attributed, schedule set, plan known — but no first payment yet. */
  bountyPending: boolean;
  paidMonths: number;
  /** Effective rate for the CURRENT month (0 when not accruing). */
  monthlyRateCents: number;
  lifetimeMonthlyCents: number;
  lifetimeCents: number;
  accruesNow: boolean;
  /** Honest note when a number is a zero for a reason the owner should see. */
  note: string | null;
}

export interface SalesRepSummary {
  accountsBrought: number;
  activeAccounts: number;
  accruedThisMonthCents: number;
  lifetimeAccruedCents: number;
  paidToDateCents: number;
  owedNowCents: number;
  hasSchedule: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Full month boundaries elapsed between two instants, day-aligned. */
export function fullMonthsElapsed(fromIso: string, toIso: string): number {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** 1-based paid-month index of `asOfIso` relative to the first payment. */
function paidMonthIndex(firstPaidAtIso: string, asOfIso: string): number {
  return fullMonthsElapsed(firstPaidAtIso, asOfIso) + 1;
}

function isScheduleEmpty(s: SalesCompSchedule): boolean {
  return (
    s.bountyStarterCents === 0 &&
    s.bountyProCents === 0 &&
    s.monthlyStarterCents === 0 &&
    s.monthlyProCents === 0
  );
}

/** The deal's "active/paying" predicate — past-due is still an active sub. */
export function isPaying(status: SalesCompSubStatus | null): boolean {
  return status === "active" || status === "past_due";
}

// ---------------------------------------------------------------------------
// First successful payment (the bounty trigger)
// ---------------------------------------------------------------------------

/**
 * Bounty trigger: activation event, else the paid-state fallback. `trialing`
 * is explicitly NOT a payment; canceled accounts earned already if history
 * says so (history survives cancellation).
 */
export function firstPaymentMade(
  input: Pick<SalesCompAccountInput, "firstPaidAt" | "subscriptionStatus">,
): boolean {
  if (input.firstPaidAt) return true;
  return isPaying(input.subscriptionStatus);
}

// ---------------------------------------------------------------------------
// Paid months (monthly accrual + step-down boundary)
// ---------------------------------------------------------------------------

/**
 * Counted paid months as of `asOfIso`. 0 when the first payment date is
 * unknown (the activation event is missing) — the honest undercount — and
 * 0 while the account has never paid or is canceled with no cancellation
 * date in history.
 */
export function paidMonthsCount(
  input: Pick<SalesCompAccountInput, "firstPaidAt" | "subscriptionStatus" | "canceledAt">,
  asOfIso: string,
): number {
  if (!input.firstPaidAt) return 0;
  if (!isPaying(input.subscriptionStatus)) {
    // Canceled: accrual stops; count months through the cancellation moment
    // only when the ledger recorded one.
    if (input.subscriptionStatus === "canceled") {
      if (!input.canceledAt) return 0;
      if (new Date(input.canceledAt).getTime() < new Date(input.firstPaidAt).getTime()) return 0;
      return paidMonthIndex(input.firstPaidAt, input.canceledAt);
    }
    return 0; // trialing or unknown status: never a paid month
  }
  return paidMonthIndex(input.firstPaidAt, asOfIso);
}

/** Monthly rate for paid month `monthIndex` (1-based) under the schedule. */
export function effectiveMonthlyRateCents(
  schedule: SalesCompSchedule,
  plan: SalesCompPlan | null,
  monthIndex: number,
): number {
  if (plan !== "starter" && plan !== "pro") return 0;
  const full = plan === "starter" ? schedule.monthlyStarterCents : schedule.monthlyProCents;
  const stepped =
    plan === "starter" ? schedule.stepDownMonthlyStarterCents : schedule.stepDownMonthlyProCents;
  if (schedule.stepDownAfterMonths != null && stepped != null && monthIndex > schedule.stepDownAfterMonths) {
    return stepped;
  }
  return full;
}

/** Lifetime monthly comp: Σ effective rate over the counted paid months. */
export function lifetimeMonthlyCents(
  schedule: SalesCompSchedule,
  plan: SalesCompPlan | null,
  paidMonths: number,
): number {
  let total = 0;
  for (let month = 1; month <= paidMonths; month++) {
    total += effectiveMonthlyRateCents(schedule, plan, month);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Per-account accrual
// ---------------------------------------------------------------------------

/** Bounty for the account's plan under the schedule (plan falls back to ledger). */
function bountyForPlan(schedule: SalesCompSchedule, plan: SalesCompPlan | null): number | null {
  if (plan === "starter") return schedule.bountyStarterCents;
  if (plan === "pro") return schedule.bountyProCents;
  return null; // plan unknown — never invent a bounty
}

export function accrueAccount(
  schedule: SalesCompSchedule | null,
  input: SalesCompAccountInput,
  asOfIso: string,
): SalesCompAccountView {
  const plan = input.plan === "starter" || input.plan === "pro" ? input.plan : input.ledgerPlan;
  const made = firstPaymentMade(input);
  const noSchedule = schedule === null || isScheduleEmpty(schedule);
  const effSchedule = schedule ?? {
    bountyStarterCents: 0,
    bountyProCents: 0,
    monthlyStarterCents: 0,
    monthlyProCents: 0,
    stepDownAfterMonths: null,
    stepDownMonthlyStarterCents: null,
    stepDownMonthlyProCents: null,
  };
  const months = noSchedule ? 0 : paidMonthsCount(input, asOfIso);
  const paying = isPaying(input.subscriptionStatus);
  const bounty = made && !noSchedule ? bountyForPlan(effSchedule, plan) : null;
  const lifetimeMonthly = noSchedule ? 0 : lifetimeMonthlyCents(effSchedule, plan, months);
  const bountyEarned = bounty ?? 0;
  // The current month accrues the effective rate for the CURRENT paid-month
  // index — only while paying, scheduled, and the month count is derivable.
  const currentMonthIndex = paying && input.firstPaidAt ? paidMonthIndex(input.firstPaidAt, asOfIso) : 0;
  const accruesNow = paying && !noSchedule && currentMonthIndex > 0 && plan !== null && plan !== "trial";
  const monthlyRate =
    accruesNow && currentMonthIndex > 0 ? effectiveMonthlyRateCents(effSchedule, plan, currentMonthIndex) : 0;

  // Honest notes — every zero on this tab has a stated reason.
  const notes: string[] = [];
  if (noSchedule) notes.push("No comp schedule set on this rep — accrual is $0 until rates are set.");
  if (!made) notes.push("Pending first payment — the bounty earns only on the first successful payment, never on signup or trial.");
  if (made && bounty === null && !noSchedule) notes.push("Payment recorded but the plan is not identifiable (not starter/pro in the live or ledger plan) — bounty not counted.");
  if (made && !noSchedule && months === 0 && input.firstPaidAt == null && isPaying(input.subscriptionStatus)) {
    notes.push("A payment exists (account is in a paid state) but its date is not in billing history — paid months not counted until the next activation event.");
  }
  if (input.subscriptionStatus === "canceled") notes.push("Canceled — monthly accrual stopped.");

  return {
    businessId: input.businessId,
    businessName: input.businessName,
    plan: input.plan,
    subscriptionStatus: input.subscriptionStatus,
    paying,
    firstPaymentMade: made,
    firstPaidAt: input.firstPaidAt,
    bountyCents: bountyEarned,
    bountyPending: !made && !noSchedule && plan !== null,
    paidMonths: months,
    monthlyRateCents: monthlyRate,
    lifetimeMonthlyCents: lifetimeMonthly,
    lifetimeCents: bountyEarned + lifetimeMonthly,
    accruesNow,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}

// ---------------------------------------------------------------------------
// Per-rep summary + tab totals
// ---------------------------------------------------------------------------

export function summarizeRep(
  schedule: SalesCompSchedule | null,
  accounts: SalesCompAccountInput[],
  payouts: SalesRepPayoutLedgerRow[],
  asOfIso: string,
): SalesRepSummary {
  const views = accounts.map((a) => accrueAccount(schedule, a, asOfIso));
  const lifetimeAccruedCents = views.reduce((sum, v) => sum + v.lifetimeCents, 0);
  const accruedThisMonthCents = views.reduce((sum, v) => sum + v.monthlyRateCents, 0);
  const paidToDateCents = payouts.reduce((sum, p) => sum + p.amountCents, 0);
  return {
    accountsBrought: accounts.length,
    activeAccounts: views.filter((v) => v.paying).length,
    accruedThisMonthCents,
    lifetimeAccruedCents,
    paidToDateCents,
    owedNowCents: lifetimeAccruedCents - paidToDateCents,
    hasSchedule: schedule !== null && !isScheduleEmpty(schedule),
  };
}

/** A recorded payout (amount + free-text period note + when). */
export interface SalesRepPayoutLedgerRow {
  amountCents: number;
  note: string | null;
  paidAt: string;
}

export interface SalesTotalsBand {
  /** Monthly collected from attributed accounts: plan list price × paying accounts. */
  monthlyCollectedCents: number;
  /** Monthly rep cost: the deal's current-month accrual over attributed accounts. */
  monthlyRepCostCents: number;
  /** collected − rep cost. */
  monthlyNetCents: number;
  payingAccounts: number;
}

/** Human-readable one-line description of a rep's schedule (for the tab). */
export function describeSchedule(s: SalesCompSchedule): string {
  const usd = (cents: number): string =>
    "$" + (cents / 100).toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (isScheduleEmpty(s)) return "No comp schedule set";
  const bounty = `Bounty ${usd(s.bountyStarterCents)} Starter / ${usd(s.bountyProCents)} Pro`;
  const monthly = `Monthly ${usd(s.monthlyStarterCents)} Starter / ${usd(s.monthlyProCents)} Pro`;
  const step =
    s.stepDownAfterMonths != null && s.stepDownMonthlyStarterCents != null && s.stepDownMonthlyProCents != null
      ? ` · drops to ${usd(s.stepDownMonthlyStarterCents)} / ${usd(s.stepDownMonthlyProCents)} after ${s.stepDownAfterMonths} paid months`
      : "";
  return `${bounty} · ${monthly}${step}`;
}

/**
 * The totals band — collected vs rep cost vs net, real numbers only.
 * Collected uses the locked plan list prices (src/lib/pricing.ts, passed in
 * as `planPriceCents` by the caller so this module stays pricing-agnostic)
 * over the SAME paying predicate the rep cost uses, so the two lines always
 * describe the same account set. No forecasting, no projections.
 */
export function computeTotalsBand(
  views: SalesCompAccountView[],
  planPriceCents: { starter: number; pro: number },
): SalesTotalsBand {
  let monthlyCollectedCents = 0;
  let monthlyRepCostCents = 0;
  let payingAccounts = 0;
  for (const v of views) {
    if (!v.paying) continue;
    payingAccounts += 1;
    monthlyRepCostCents += v.monthlyRateCents;
    if (v.plan === "starter") monthlyCollectedCents += planPriceCents.starter;
    else if (v.plan === "pro") monthlyCollectedCents += planPriceCents.pro;
  }
  return {
    monthlyCollectedCents,
    monthlyRepCostCents,
    monthlyNetCents: monthlyCollectedCents - monthlyRepCostCents,
    payingAccounts,
  };
}
