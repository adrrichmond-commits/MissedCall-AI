/**
 * test-sales-comp.ts — the admin Sales tab suite (pure engine + wiring + DB).
 *
 *   1. Pure — the comp engine (src/lib/salesComp.ts): bounty on first
 *      successful payment (never signup/trial), plan-follows-live accrual,
 *      cancel stops accrual, step-down boundary (month 12 full, month 13
 *      stepped), owed = accrued − payouts, no-schedule → honest zero, and
 *      the totals band. 100% of the money math is here.
 *   2. Static wiring — ci.yml suites list (MANUAL list — this exact gotcha),
 *      migration 024, the /admin route + gate order, nav links, and the
 *      tab's read going through the gated module + pure engine.
 *   3. DB-backed — seeds reps + attributed accounts with REAL billing-event
 *      rows (the same derivation data the page reads), runs the page's own
 *      query layer + engine, asserts computed owed/lifetime/totals, and
 *      proves the gated read refuses without an admin session. Everything
 *      CASCADE-deletes on exit.
 *
 * Run: bun scripts/test-sales-comp.ts   (exit 0 = every check passed)
 */
import { readFileSync } from "node:fs";
import { query } from "./db";
import { installLocalPostgresShim } from "./local-pg-shim";
if (process.env.USE_LOCAL_POSTGRES === "1") await installLocalPostgresShim();
import { hashPassword } from "../src/lib/server/password";
import { createBusinessWithOwner } from "../src/db/queries/auth";
import {
  accrueAccount,
  computeTotalsBand,
  describeSchedule,
  effectiveMonthlyRateCents,
  firstPaymentMade,
  fullMonthsElapsed,
  paidMonthsCount,
  summarizeRep,
  type SalesCompAccountInput,
  type SalesCompSchedule,
  type SalesRepPayoutLedgerRow,
} from "../src/lib/salesComp";
import {
  attributeBusiness,
  createSalesRep,
  createSalesRepPayout,
  listAttributedAccounts,
  listRepPayouts,
  listSalesReps,
  listUnattributedBusinesses,
  unattributeBusiness,
} from "../src/db/queries/salesReps";

let checks = 0;
let failures = 0;
function checkTrue(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  } else {
    console.log("ok   " + name);
  }
}
function checkEq(name: string, got: unknown, want: unknown): void {
  checkTrue(name, got === want, "got " + String(got) + ", want " + String(want));
}

// ---------------------------------------------------------------------------
// 1. Pure — the comp engine
// ---------------------------------------------------------------------------

/** The friends' real terms, as they'd be stored on a rep row (cents). */
const FRIENDS_SCHEDULE: SalesCompSchedule = {
  bountyStarterCents: 10000,
  bountyProCents: 15000,
  monthlyStarterCents: 5000,
  monthlyProCents: 7500,
  stepDownAfterMonths: null,
  stepDownMonthlyStarterCents: null,
  stepDownMonthlyProCents: null,
};
const FRIENDS_STEPDOWN: SalesCompSchedule = {
  ...FRIENDS_SCHEDULE,
  stepDownAfterMonths: 12,
  stepDownMonthlyStarterCents: 2500,
  stepDownMonthlyProCents: 3750,
};
const NO_SCHEDULE: SalesCompSchedule = {
  bountyStarterCents: 0,
  bountyProCents: 0,
  monthlyStarterCents: 0,
  monthlyProCents: 0,
  stepDownAfterMonths: null,
  stepDownMonthlyStarterCents: null,
  stepDownMonthlyProCents: null,
};

function acct(overrides: Partial<SalesCompAccountInput>): SalesCompAccountInput {
  return {
    businessId: "b1",
    businessName: "Biz",
    plan: "starter",
    subscriptionStatus: "active",
    firstPaidAt: null,
    canceledAt: null,
    ledgerPlan: null,
    attributedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
const PAYOUT = (cents: number): SalesRepPayoutLedgerRow => ({ amountCents: cents, note: null, paidAt: "2026-10-01T00:00:00.000Z" });

// --- Bounty triggers on PAYMENT, never signup/trial ---
checkEq("bounty: trialing never earns (firstPaymentMade false)", firstPaymentMade(acct({ subscriptionStatus: "trialing", firstPaidAt: null })), false);
checkEq("bounty: no subscription status never earns", firstPaymentMade(acct({ subscriptionStatus: null, firstPaidAt: null })), false);
checkTrue(
  "bounty: activation event earns even while now trialing (history survives)",
  firstPaymentMade(acct({ subscriptionStatus: "trialing", firstPaidAt: "2026-08-01T00:00:00.000Z" })),
);
checkEq("bounty: paid-state fallback — active earns without an event", firstPaymentMade(acct({ subscriptionStatus: "active", firstPaidAt: null })), true);
checkEq("bounty: paid-state fallback — past_due earns (a payment must have happened)", firstPaymentMade(acct({ subscriptionStatus: "past_due", firstPaidAt: null })), true);
checkTrue("bounty: canceled with an activation event in history earns", firstPaymentMade(acct({ subscriptionStatus: "canceled", firstPaidAt: "2026-05-01T00:00:00.000Z" })));

const trialing = accrueAccount(FRIENDS_SCHEDULE, acct({ subscriptionStatus: "trialing", firstPaidAt: null }), "2026-10-15T00:00:00.000Z");
checkEq("accrual: trialing account — bounty $0", trialing.bountyCents, 0);
checkEq("accrual: trialing account — pending first payment", trialing.bountyPending, true);
checkEq("accrual: trialing account — monthly rate $0", trialing.monthlyRateCents, 0);
checkEq("accrual: trialing account — accruesNow false", trialing.accruesNow, false);
checkEq("accrual: trialing account — lifetime $0", trialing.lifetimeCents, 0);
checkTrue("accrual: trialing carries the honest pending note", (trialing.note ?? "").includes("Pending first payment"));

const activeStarter = accrueAccount(FRIENDS_SCHEDULE, acct({ plan: "starter", subscriptionStatus: "active", firstPaidAt: "2026-09-01T00:00:00.000Z" }), "2026-10-15T00:00:00.000Z");
checkEq("accrual: active starter earns the starter bounty", activeStarter.bountyCents, 10000);
checkEq("accrual: active starter — 2 paid months", activeStarter.paidMonths, 2);
checkEq("accrual: active starter — lifetime = bounty + 2×$50", activeStarter.lifetimeCents, 10000 + 2 * 5000);
checkEq("accrual: active starter — this month $50", activeStarter.monthlyRateCents, 5000);
checkEq("accrual: active starter — accruesNow", activeStarter.accruesNow, true);
checkEq("accrual: active starter — no note (no honest-zero reason)", activeStarter.note, null);

// --- Plan follows LIVE plan (downgrade switches the rate) ---
const downgraded = accrueAccount(FRIENDS_SCHEDULE, acct({ plan: "starter", subscriptionStatus: "active", firstPaidAt: "2026-09-01T00:00:00.000Z" }), "2026-10-15T00:00:00.000Z");
checkEq("downgrade: plan starter → $50/mo even though attributed under Pro before", downgraded.monthlyRateCents, 5000);
const stillPro = accrueAccount(FRIENDS_SCHEDULE, acct({ plan: "pro", subscriptionStatus: "active", firstPaidAt: "2026-09-01T00:00:00.000Z" }), "2026-10-15T00:00:00.000Z");
checkEq("downgrade: plan pro → $75/mo", stillPro.monthlyRateCents, 7500);
checkEq("downgrade: pro bounty is $150", stillPro.bountyCents, 15000);
// Canceled accounts get businesses.plan reset to 'trial' by the webhook —
// the ledger plan fallback keeps the plan (and bounty) honest.
const canceledLedgerPlan = accrueAccount(
  FRIENDS_SCHEDULE,
  acct({ plan: "trial", ledgerPlan: "pro", subscriptionStatus: "canceled", firstPaidAt: "2026-01-01T00:00:00.000Z", canceledAt: "2026-03-15T00:00:00.000Z" }),
  "2026-10-15T00:00:00.000Z",
);
checkEq("canceled: ledger plan fallback keeps the Pro bounty", canceledLedgerPlan.bountyCents, 15000);
checkEq("canceled: ledger plan fallback values paid months at the Pro rate", canceledLedgerPlan.lifetimeMonthlyCents, 3 * 7500);
checkEq("canceled: plan renders as the live 'trial'", canceledLedgerPlan.plan, "trial");

// --- Cancel stops accrual ---
checkEq("cancel: accruesNow false", canceledLedgerPlan.accruesNow, false);
checkEq("cancel: monthly rate $0", canceledLedgerPlan.monthlyRateCents, 0);
checkEq("cancel: paid months counted to the cancellation, not to today", canceledLedgerPlan.paidMonths, 3);
checkTrue("cancel: carries the stopped note", (canceledLedgerPlan.note ?? "").includes("Canceled"));

// --- Paid-month counting (day-aligned, deterministic) ---
checkEq("months: same day = month 1", paidMonthsCount(acct({ firstPaidAt: "2026-01-10T00:00:00.000Z", subscriptionStatus: "active" }), "2026-01-10T12:00:00.000Z"), 1);
checkEq("months: one month later = month 2", paidMonthsCount(acct({ firstPaidAt: "2026-01-10T00:00:00.000Z", subscriptionStatus: "active" }), "2026-02-10T00:00:00.000Z"), 2);
checkEq("months: day-aligned — Feb 5 after a Jan 10 start is still month 1", paidMonthsCount(acct({ firstPaidAt: "2026-01-10T00:00:00.000Z", subscriptionStatus: "active" }), "2026-02-05T00:00:00.000Z"), 1);
checkEq("months: unknown first payment → 0 (never invent)", paidMonthsCount(acct({ firstPaidAt: null, subscriptionStatus: "active" }), "2026-10-15T00:00:00.000Z"), 0);
checkEq("months: unknown first payment — active account carries the honest note", accrueAccount(FRIENDS_SCHEDULE, acct({ firstPaidAt: null, subscriptionStatus: "active" }), "2026-10-15T00:00:00.000Z").note?.includes("not counted until the next activation event"), true);
checkEq("months: canceled with no cancellation event → 0 (honest undercount)", paidMonthsCount(acct({ firstPaidAt: "2026-01-01T00:00:00.000Z", subscriptionStatus: "canceled", canceledAt: null }), "2026-10-15T00:00:00.000Z"), 0);
checkEq("months: elapsed helper day-aligned", fullMonthsElapsed("2026-01-31T00:00:00.000Z", "2026-02-05T00:00:00.000Z"), 0);
checkEq("months: elapsed helper does not count an unfinalized month (Jan 31 → Feb 28)", fullMonthsElapsed("2026-01-31T00:00:00.000Z", "2026-02-28T00:00:00.000Z"), 0);
checkEq("months: elapsed helper counts full boundaries", fullMonthsElapsed("2025-01-31T00:00:00.000Z", "2026-01-31T00:00:00.000Z"), 12);

// --- Step-down boundary: month 12 FULL, month 13 STEPPED ---
checkEq("step-down: month 12 rate is FULL", effectiveMonthlyRateCents(FRIENDS_STEPDOWN, "pro", 12), 7500);
checkEq("step-down: month 13 rate is STEPPED", effectiveMonthlyRateCents(FRIENDS_STEPDOWN, "pro", 13), 3750);
checkEq("step-down: month 1..12 all full", [1, 6, 11, 12].every((m) => effectiveMonthlyRateCents(FRIENDS_STEPDOWN, "pro", m) === 7500), true);
checkEq("step-down: month 13+ all stepped", [13, 14, 24].every((m) => effectiveMonthlyRateCents(FRIENDS_STEPDOWN, "pro", m) === 3750), true);
// Same boundary through the account view: activation 2025-01-01 → month 12 is
// 2025-12 (asOf 2025-12-15), month 13 is 2026-01 (asOf 2026-01-05).
const m12 = accrueAccount(FRIENDS_STEPDOWN, acct({ plan: "pro", subscriptionStatus: "active", firstPaidAt: "2025-01-01T00:00:00.000Z" }), "2025-12-15T00:00:00.000Z");
checkEq("step-down boundary: month 12 — current month accrues the FULL rate", m12.monthlyRateCents, 7500);
checkEq("step-down boundary: month 12 — lifetime 12×full", m12.lifetimeMonthlyCents, 12 * 7500);
const m13 = accrueAccount(FRIENDS_STEPDOWN, acct({ plan: "pro", subscriptionStatus: "active", firstPaidAt: "2025-01-01T00:00:00.000Z" }), "2026-01-05T00:00:00.000Z");
checkEq("step-down boundary: month 13 — current month accrues the STEPPED rate", m13.monthlyRateCents, 3750);
checkEq("step-down boundary: month 13 — lifetime 12×full + 1×stepped", m13.lifetimeMonthlyCents, 12 * 7500 + 1 * 3750);
checkEq("step-down: null config = no step-down (month 13 still full)", effectiveMonthlyRateCents(FRIENDS_SCHEDULE, "pro", 13), 7500);

// --- OWED = accrued − payouts (payouts never edit accrual) ---
const owed = summarizeRep(FRIENDS_SCHEDULE, [acct({ firstPaidAt: "2026-09-01T00:00:00.000Z" })], [PAYOUT(5000)], "2026-10-15T00:00:00.000Z");
checkEq("owed: lifetime accrued $200 (bounty + 2 months)", owed.lifetimeAccruedCents, 10000 + 2 * 5000);
checkEq("owed: paid to date $50", owed.paidToDateCents, 5000);
checkEq("owed: owed now = accrued − paid = $150", owed.owedNowCents, 20000 - 5000);
const overpaid = summarizeRep(FRIENDS_SCHEDULE, [acct({ firstPaidAt: "2026-09-01T00:00:00.000Z" })], [PAYOUT(30000)], "2026-10-15T00:00:00.000Z");
checkEq("owed: overpaid renders honestly negative (not a dash)", overpaid.owedNowCents, 20000 - 30000);
checkEq("summary: accounts brought counts every attribution", summarizeRep(FRIENDS_SCHEDULE, [acct({ businessId: "1" }), acct({ businessId: "2" })], [], "2026-10-15T00:00:00.000Z").accountsBrought, 2);
checkEq("summary: active accounts count only paying ones", summarizeRep(FRIENDS_SCHEDULE, [acct({ businessId: "1" }), acct({ businessId: "2", subscriptionStatus: "trialing" })], [], "2026-10-15T00:00:00.000Z").activeAccounts, 1);
checkEq("summary: accrued this month sums current-month rates", summarizeRep(FRIENDS_SCHEDULE, [acct({ businessId: "1", firstPaidAt: "2026-09-01T00:00:00.000Z" }), acct({ businessId: "2", plan: "pro", firstPaidAt: "2026-09-01T00:00:00.000Z" })], [], "2026-10-15T00:00:00.000Z").accruedThisMonthCents, 5000 + 7500);

// --- No schedule → honest zero ---
const noSched = accrueAccount(null, acct({ firstPaidAt: "2026-09-01T00:00:00.000Z" }), "2026-10-15T00:00:00.000Z");
checkEq("no-schedule: $0 bounty", noSched.bountyCents, 0);
checkEq("no-schedule: $0 monthly", noSched.monthlyRateCents, 0);
checkEq("no-schedule: $0 lifetime", noSched.lifetimeCents, 0);
checkEq("no-schedule: accruesNow false", noSched.accruesNow, false);
checkTrue("no-schedule: carries the honest note", (noSched.note ?? "").includes("No comp schedule set"));
const zeroSched = accrueAccount(NO_SCHEDULE, acct({ firstPaidAt: "2026-09-01T00:00:00.000Z" }), "2026-10-15T00:00:00.000Z");
checkEq("no-schedule: all-zero row behaves like no schedule", zeroSched.lifetimeCents, 0);
checkEq("summary: all-zero schedule → hasSchedule false", summarizeRep(NO_SCHEDULE, [acct({})], [], "2026-10-15T00:00:00.000Z").hasSchedule, false);
checkEq("summary: real schedule → hasSchedule true", summarizeRep(FRIENDS_SCHEDULE, [], [], "2026-10-15T00:00:00.000Z").hasSchedule, true);

// --- Totals band: collected vs rep cost vs net (same paying set both sides) ---
const band = computeTotalsBand(
  [
    accrueAccount(FRIENDS_SCHEDULE, acct({ businessId: "A", plan: "starter", subscriptionStatus: "active", firstPaidAt: "2026-09-01T00:00:00.000Z" }), "2026-10-15T00:00:00.000Z"),
    accrueAccount(FRIENDS_SCHEDULE, acct({ businessId: "B", plan: "pro", subscriptionStatus: "active", firstPaidAt: "2026-09-01T00:00:00.000Z" }), "2026-10-15T00:00:00.000Z"),
    accrueAccount(FRIENDS_SCHEDULE, acct({ businessId: "C", subscriptionStatus: "trialing", firstPaidAt: null }), "2026-10-15T00:00:00.000Z"),
    accrueAccount(FRIENDS_SCHEDULE, acct({ businessId: "D", subscriptionStatus: "canceled", firstPaidAt: "2026-01-01T00:00:00.000Z", canceledAt: "2026-02-01T00:00:00.000Z" }), "2026-10-15T00:00:00.000Z"),
  ],
  { starter: 14900, pro: 24900 },
);
checkEq("band: collected = list price × paying accounts only", band.monthlyCollectedCents, 14900 + 24900);
checkEq("band: rep cost = current accrual over the same paying set", band.monthlyRepCostCents, 5000 + 7500);
checkEq("band: net = collected − rep cost", band.monthlyNetCents, 14900 + 24900 - 5000 - 7500);
checkEq("band: paying accounts counted", band.payingAccounts, 2);
const emptyBand = computeTotalsBand([], { starter: 14900, pro: 24900 });
checkEq("band: empty tab renders honest zeros (not dashes)", `${emptyBand.monthlyCollectedCents}/${emptyBand.monthlyRepCostCents}/${emptyBand.monthlyNetCents}`, "0/0/0");

// --- Schedule description ---
checkEq("describe: no schedule says so", describeSchedule(NO_SCHEDULE), "No comp schedule set");
checkTrue("describe: real terms render", describeSchedule(FRIENDS_SCHEDULE).includes("$100 Starter / $150 Pro") && describeSchedule(FRIENDS_SCHEDULE).includes("$50 Starter / $75 Pro"));
checkTrue("describe: step-down renders", describeSchedule(FRIENDS_STEPDOWN).includes("after 12 paid months"));

// ---------------------------------------------------------------------------
// 2. Static wiring
// ---------------------------------------------------------------------------
const ciSrc = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
checkTrue("ci.yml: the MANUAL suites list includes sales-comp", /suites="[^"]*\bsales-comp\b/.test(ciSrc));
checkTrue("ci.yml: sales-comp runs as scripts/test-sales-comp.ts", ciSrc.includes("bun \"scripts/test-$t.ts\""));

const migSrc = readFileSync(new URL("../migrations/024_sales_reps.sql", import.meta.url), "utf8");
checkTrue("migration: creates sales_reps", migSrc.includes("CREATE TABLE IF NOT EXISTS sales_reps"));
checkTrue("migration: creates the payouts ledger", migSrc.includes("CREATE TABLE IF NOT EXISTS sales_rep_payouts"));
checkTrue("migration: attribution lives on businesses (nullable column)", migSrc.includes("ADD COLUMN IF NOT EXISTS sales_rep_id"));
checkTrue("migration: payouts are append-only ledger data (amount + note + paid_at)", migSrc.includes("amount_cents") && migSrc.includes("note") && migSrc.includes("paid_at"));
checkTrue("migration: widens admin_audit for the six sales actions", migSrc.includes("'sales_payout_recorded'") && migSrc.includes("'sales_attribution_set'"));

const routeSrc = readFileSync(new URL("../src/routes/admin/sales.tsx", import.meta.url), "utf8");
checkTrue("route: lives under /admin (layout gate applies)", routeSrc.includes('createFileRoute("/admin/sales")'));
checkTrue("route: loader uses the SSR plain-read branch (PR #27 pattern)", routeSrc.includes("import.meta.env.SSR") && routeSrc.includes('~/lib/server/salesAdmin"'));
checkTrue("route: has NO session/cookie code of its own (layout owns auth)", !routeSrc.includes("auth.server") && !routeSrc.includes("getCookie"));
checkTrue("route: renders the honest empty states", routeSrc.includes("No reps added yet") && routeSrc.includes("No attributed accounts"));

const salesAdminSrc = readFileSync(new URL("../src/lib/server/salesAdmin.ts", import.meta.url), "utf8");
const pageSeg = salesAdminSrc.slice(salesAdminSrc.indexOf("export async function salesTabPage"));
checkTrue("gate: salesTabPage calls requirePlatformAdmin first", /await requirePlatformAdmin\(\)/.test(pageSeg.slice(0, 400)));
checkTrue("gate: gated BEFORE any query", pageSeg.indexOf("requirePlatformAdmin()") < pageSeg.indexOf("listSalesReps()"));
checkTrue("gate: every write action gates too", (salesAdminSrc.match(/await requirePlatformAdmin\(\)/g) ?? []).length >= 7);
checkTrue("engine: the tab computes ONLY through the pure module", salesAdminSrc.includes('from "~/lib/salesComp"'));
checkTrue("engine: payouts ledger is append-only (no accrual edit path)", !salesAdminSrc.includes("UPDATE sales_rep_payouts") && !salesAdminSrc.includes("DELETE FROM sales_rep_payouts"));

const engineSrc = readFileSync(new URL("../src/lib/salesComp.ts", import.meta.url), "utf8");
checkTrue("engine: PURE — no db, no env, no clock", !engineSrc.includes('from "~/db') && !engineSrc.includes("process.env") && !engineSrc.includes("new Date()"));

for (const nav of ["accounts", "accounts_.$businessId", "health", "metrics", "audit", "funnel", "prompts"]) {
  const src = readFileSync(new URL(`../src/routes/admin/${nav}.tsx`, import.meta.url), "utf8");
  checkTrue(`nav: ${nav} links the Sales tab`, src.includes('/admin/sales'));
}

// ---------------------------------------------------------------------------
// 3. DB-backed — seed REAL rows, run the page's query layer + engine, clean up
// ---------------------------------------------------------------------------
const PREFIX = "salescomp-" + Date.now() + "-";
const passwordHash = await hashPassword("salescomp-test-password");
let dbChecks = 0;
function dbOk(name: string, cond: boolean, detail = ""): void {
  checks++; dbChecks++;
  if (!cond) { failures++; console.log("FAIL " + name + (detail ? " — " + detail : "")); }
  else console.log("ok   " + name);
}

let bizA: string | null = null; // starter, active, first payment ~3 months ago
let bizB: string | null = null; // pro, trialing (no payment yet)
let bizC: string | null = null; // starter, canceled after 13 paid months (step-down case)
let bizD: string | null = null; // attributed to the no-schedule rep
let repMain: string | null = null; // friends' terms, no step-down
let repStep: string | null = null; // friends' terms + negotiated step-down
let repNone: string | null = null; // no schedule set
let payoutId: string | null = null;

/** 1st of the month N months before the current month (UTC). */
function firstOfMonthMonthsAgo(n: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
}

try {
  for (const spec of ["a", "b", "c", "d"] as const) {
    const created = await createBusinessWithOwner({
      businessName: PREFIX + spec,
      ownerEmail: PREFIX + spec + "@missedcall.test",
      ownerFullName: "Sales Comp Test Owner " + spec.toUpperCase(),
      passwordHash,
    });
    if (spec === "a") bizA = created.business.id;
    if (spec === "b") bizB = created.business.id;
    if (spec === "c") bizC = created.business.id;
    if (spec === "d") bizD = created.business.id;
  }

  // Real terms on the rows (as data — the engine never hard-codes them).
  repMain = (await createSalesRep({
    name: PREFIX + "rep-main", contact: "rep-main@test.example", active: true,
    bountyStarterCents: 10000, bountyProCents: 15000, monthlyStarterCents: 5000, monthlyProCents: 7500,
    stepDownAfterMonths: null, stepDownMonthlyStarterCents: null, stepDownMonthlyProCents: null,
  })).id;
  repStep = (await createSalesRep({
    name: PREFIX + "rep-step", contact: "rep-step@test.example", active: true,
    bountyStarterCents: 10000, bountyProCents: 15000, monthlyStarterCents: 5000, monthlyProCents: 7500,
    stepDownAfterMonths: 12, stepDownMonthlyStarterCents: 2500, stepDownMonthlyProCents: 3750,
  })).id;
  repNone = (await createSalesRep({
    name: PREFIX + "rep-none", contact: null, active: true,
    bountyStarterCents: 0, bountyProCents: 0, monthlyStarterCents: 0, monthlyProCents: 0,
    stepDownAfterMonths: null, stepDownMonthlyStarterCents: null, stepDownMonthlyProCents: null,
  })).id;

  // biz A: Starter, active, activation (checkout_completed + status active) 3 months ago.
  await query(`UPDATE businesses SET plan = 'starter', subscription_status = 'active' WHERE id = $1`, [bizA]);
  await query(
    `INSERT INTO billing_events (business_id, event_type, source, description, payload, occurred_at)
     VALUES ($1, 'checkout_completed', 'stripe', 'test activation', $2::jsonb, $3::timestamptz)`,
    [bizA, JSON.stringify({ status: "active", plan: "starter" }), firstOfMonthMonthsAgo(3).toISOString()],
  );
  // biz B: Pro, trialing — NO activation event (trial signup ≠ payment).
  await query(`UPDATE businesses SET plan = 'pro', subscription_status = 'trialing' WHERE id = $1`, [bizB]);
  // biz C: canceled after 13 paid months (activation on the 1st, 14 months
  // ago; canceled on the 1st, 2 months ago → 13 counted paid months).
  await query(`UPDATE businesses SET plan = 'trial', subscription_status = 'canceled' WHERE id = $1`, [bizC]);
  await query(
    `INSERT INTO billing_events (business_id, event_type, source, description, payload, occurred_at)
     VALUES ($1, 'checkout_completed', 'stripe', 'test activation', $2::jsonb, $3::timestamptz),
            ($1, 'subscription_canceled', 'stripe', 'test cancel', '{}'::jsonb, $4::timestamptz)`,
    [
      bizC,
      JSON.stringify({ status: "active", plan: "pro" }),
      firstOfMonthMonthsAgo(14).toISOString(),
      firstOfMonthMonthsAgo(2).toISOString(),
    ],
  );

  // Attribute through the query layer the page uses.
  dbOk("attribute: A → rep-main", await attributeBusiness(bizA!, repMain!));
  dbOk("attribute: B → rep-main (trial account attributes fine)", await attributeBusiness(bizB!, repMain!));
  dbOk("attribute: C → rep-step", await attributeBusiness(bizC!, repStep!));
  dbOk("attribute: D → rep-none", await attributeBusiness(bizD!, repNone!));
  dbOk("attribute: recorded on the business row", await query(`SELECT sales_rep_id FROM businesses WHERE id = $1 AND sales_rep_id = $2`, [bizA, repMain]).then((r) => r.length === 1));

  // One recorded payout for repMain ($100) — append-only ledger.
  payoutId = (await createSalesRepPayout({ repId: repMain!, amountCents: 10000, note: "test payout" })).id;
  dbOk("payout: ledger row recorded", payoutId !== null);
  dbOk("payout: ledger lists it with the rep name", (await listRepPayouts()).some((p) => p.id === payoutId && p.repId === repMain && p.amountCents === 10000 && p.note === "test payout"));

  // Run the page's own read + engine (asOf = now, like the tab).
  const asOf = new Date().toISOString();
  const rows = await listAttributedAccounts();
  const rowFor = (bizId: string | null) => rows.find((r) => r.business.id === bizId)!;
  dbOk("read: all four attributions resolve", rows.filter((r) => [bizA, bizB, bizC, bizD].includes(r.business.id)).length === 4);
  const a = rowFor(bizA);
  dbOk("read: A firstPaidAt derived from the activation event", a.firstPaidAt !== null);
  const c = rowFor(bizC);
  dbOk("read: C canceledAt derived from the cancel event", c.canceledAt !== null);
  dbOk("read: C ledger plan fallback = pro (businesses.plan is trial)", c.ledgerPlan === "pro");
  const b = rowFor(bizB);
  dbOk("read: B has no activation event", b.firstPaidAt === null);

  const viewA = accrueAccount(
    { bountyStarterCents: 10000, bountyProCents: 15000, monthlyStarterCents: 5000, monthlyProCents: 7500, stepDownAfterMonths: null, stepDownMonthlyStarterCents: null, stepDownMonthlyProCents: null },
    {
      businessId: a.business.id, businessName: a.business.name, plan: (a.business.plan ?? null) as "starter" | "pro" | "trial",
      subscriptionStatus: (a.business.subscriptionStatus ?? null) as "active" | "trialing" | "past_due" | "canceled",
      firstPaidAt: a.firstPaidAt?.toISOString() ?? null, canceledAt: a.canceledAt?.toISOString() ?? null,
      ledgerPlan: (a.ledgerPlan ?? null) as "starter" | "pro" | "trial", attributedAt: a.attributedAt?.toISOString() ?? null,
    },
    asOf,
  );
  // A: activation on the 1st, 3 months ago; the count is day-aligned so the
  // activation month + 3 later months = 4 paid months, month 4 = current.
  dbOk("engine(DB): A bounty earned $100 on the REAL activation event", viewA.bountyCents === 10000);
  dbOk("engine(DB): A paid months = 4 (activation month + 3 later months, day-aligned)", viewA.paidMonths === 4, `got ${viewA.paidMonths}`);
  dbOk("engine(DB): A lifetime = $100 bounty + 4×$50", viewA.lifetimeCents === 10000 + 4 * 5000, `got ${viewA.lifetimeCents}`);
  dbOk("engine(DB): A accrues $50 this month", viewA.monthlyRateCents === 5000 && viewA.accruesNow);
  dbOk("engine(DB): A renders no note (no honest-zero reason)", viewA.note === null);

  const viewB = accrueAccount(
    { bountyStarterCents: 10000, bountyProCents: 15000, monthlyStarterCents: 5000, monthlyProCents: 7500, stepDownAfterMonths: null, stepDownMonthlyStarterCents: null, stepDownMonthlyProCents: null },
    {
      businessId: b.business.id, businessName: b.business.name, plan: (b.business.plan ?? null) as "starter" | "pro" | "trial",
      subscriptionStatus: (b.business.subscriptionStatus ?? null) as "active" | "trialing" | "past_due" | "canceled",
      firstPaidAt: null, canceledAt: null, ledgerPlan: null, attributedAt: b.attributedAt?.toISOString() ?? null,
    },
    asOf,
  );
  dbOk("engine(DB): B (trialing Pro) — bounty pending, $0 everything", viewB.bountyPending && viewB.lifetimeCents === 0 && !viewB.accruesNow);
  dbOk("engine(DB): B carries the honest pending note", (viewB.note ?? "").includes("Pending first payment"));

  const viewC = accrueAccount(
    { bountyStarterCents: 10000, bountyProCents: 15000, monthlyStarterCents: 5000, monthlyProCents: 7500, stepDownAfterMonths: 12, stepDownMonthlyStarterCents: 2500, stepDownMonthlyProCents: 3750 },
    {
      businessId: c.business.id, businessName: c.business.name, plan: (c.business.plan ?? null) as "starter" | "pro" | "trial",
      subscriptionStatus: (c.business.subscriptionStatus ?? null) as "active" | "trialing" | "past_due" | "canceled",
      firstPaidAt: c.firstPaidAt?.toISOString() ?? null, canceledAt: c.canceledAt?.toISOString() ?? null,
      ledgerPlan: (c.ledgerPlan ?? null) as "starter" | "pro" | "trial", attributedAt: c.attributedAt?.toISOString() ?? null,
    },
    asOf,
  );
  // C: activation 14 months ago, canceled at the 1st of last month → 13 paid
  // months; month 13 is past the 12-month step-down → stepped rate.
  dbOk("engine(DB): C paid months = 13 (activation → cancellation)", viewC.paidMonths === 13, `got ${viewC.paidMonths}`);
  dbOk("engine(DB): C lifetime = $150 bounty + 12×$75 FULL + 1×$37.50 STEPPED (the boundary, on real rows)",
    viewC.lifetimeCents === 15000 + 12 * 7500 + 3750, `got ${viewC.lifetimeCents}`);
  dbOk("engine(DB): C accrues $0 (canceled stops accrual)", viewC.monthlyRateCents === 0 && !viewC.accruesNow);

  // Rep summaries against the real rows (the numbers the tab renders).
  const payouts = await listRepPayouts();
  const mainAccounts = [a, b].map((r) => ({
    businessId: r.business.id, businessName: r.business.name,
    plan: (r.business.plan ?? null) as "starter" | "pro" | "trial",
    subscriptionStatus: (r.business.subscriptionStatus ?? null) as "active" | "trialing" | "past_due" | "canceled",
    firstPaidAt: r.firstPaidAt?.toISOString() ?? null, canceledAt: r.canceledAt?.toISOString() ?? null,
    ledgerPlan: (r.ledgerPlan ?? null) as "starter" | "pro" | "trial", attributedAt: r.attributedAt?.toISOString() ?? null,
  }));
  const mainSummary = summarizeRep(
    { bountyStarterCents: 10000, bountyProCents: 15000, monthlyStarterCents: 5000, monthlyProCents: 7500, stepDownAfterMonths: null, stepDownMonthlyStarterCents: null, stepDownMonthlyProCents: null },
    mainAccounts,
    payouts.filter((p) => p.repId === repMain).map((p) => ({ amountCents: p.amountCents, note: p.note, paidAt: p.paidAt.toISOString() })),
    asOf,
  );
  dbOk("summary(DB): rep-main accounts brought = 2", mainSummary.accountsBrought === 2);
  dbOk("summary(DB): rep-main currently active = 1 (A only)", mainSummary.activeAccounts === 1);
  dbOk("summary(DB): rep-main accrued this month = $50", mainSummary.accruedThisMonthCents === 5000, `got ${mainSummary.accruedThisMonthCents}`);
  dbOk("summary(DB): rep-main lifetime accrued = A + B (B contributes 0)", mainSummary.lifetimeAccruedCents === viewA.lifetimeCents + 0);
  dbOk("summary(DB): rep-main paid to date = $100 ledger total", mainSummary.paidToDateCents === 10000);
  dbOk("summary(DB): rep-main owed now = accrued − $100", mainSummary.owedNowCents === mainSummary.lifetimeAccruedCents - 10000);
  dbOk("summary(DB): rep-none (no schedule) → $0 + hasSchedule false", summarizeRep(
    { bountyStarterCents: 0, bountyProCents: 0, monthlyStarterCents: 0, monthlyProCents: 0, stepDownAfterMonths: null, stepDownMonthlyStarterCents: null, stepDownMonthlyProCents: null },
    [mainAccounts[0]], [], asOf,
  ).owedNowCents === 0);

  // Totals band over the four real attributions.
  const views = [viewA, viewB, viewC, accrueAccount(
    { bountyStarterCents: 0, bountyProCents: 0, monthlyStarterCents: 0, monthlyProCents: 0, stepDownAfterMonths: null, stepDownMonthlyStarterCents: null, stepDownMonthlyProCents: null },
    { businessId: bizD!, businessName: "D", plan: "trial", subscriptionStatus: null, firstPaidAt: null, canceledAt: null, ledgerPlan: null, attributedAt: asOf },
    asOf,
  )];
  const band = computeTotalsBand(views, { starter: 14900, pro: 24900 });
  dbOk("band(DB): monthly collected = $149 (A only paying Starter)", band.monthlyCollectedCents === 14900, `got ${band.monthlyCollectedCents}`);
  dbOk("band(DB): monthly rep cost = $50 (A's current accrual)", band.monthlyRepCostCents === 5000, `got ${band.monthlyRepCostCents}`);
  dbOk("band(DB): monthly net = $99", band.monthlyNetCents === 9900, `got ${band.monthlyNetCents}`);
  dbOk("band(DB): paying accounts = 1", band.payingAccounts === 1);

  // Unattributed businesses list excludes the attributed four.
  const unattr = await listUnattributedBusinesses();
  dbOk("read: attributed businesses drop out of the unattributed list", !unattr.some((u) => [bizA, bizB, bizC, bizD].includes(u.id)));

  // Unattribution works.
  dbOk("unattribute: clears the attribution", await unattributeBusiness(bizD!));
  dbOk("unattribute: D left the attributed read", !(await listAttributedAccounts()).some((r) => r.business.id === bizD));

  // Access control: the gated page read REFUSES without an admin session.
  const { salesTabPage } = await import("../src/lib/server/salesAdmin");
  const refused = await salesTabPage();
  dbOk("gate: salesTabPage refuses without an admin session (no data leak)", !refused.ok, refused.ok ? "RETURNED DATA" : `status ${refused.status}`);

  // Rep listing round-trips the schedule as data.
  const reps = await listSalesReps();
  const step = reps.find((r) => r.id === repStep);
  dbOk("reps: schedule read back as data (step-down intact)", step?.stepDownAfterMonths === 12 && step?.stepDownMonthlyProCents === 3750);
} finally {
  // CASCADE cleanup: businesses cascade billing_events; reps cascade payouts
  // (businesses.sales_rep_id is ON DELETE SET NULL, so order is free).
  for (const id of [bizA, bizB, bizC, bizD]) {
    if (id) await query("DELETE FROM businesses WHERE id = $1", [id]);
  }
  for (const id of [repMain, repStep, repNone]) {
    if (id) await query("DELETE FROM sales_reps WHERE id = $1", [id]);
  }
}

console.log("");
console.log(`sales-comp: ${checks - failures}/${checks} checks passed (pure: ${checks - dbChecks}, db: ${dbChecks})`);
if (failures > 0) process.exit(1);
