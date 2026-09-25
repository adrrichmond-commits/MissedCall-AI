#!/usr/bin/env bun
/**
 * P4-V tests. Run: bun scripts/test-p4v.ts — no DB, no network, no keys.
 *
 * Covers:
 *   - trial value indicator math (src/lib/trialValue.ts): days-remaining
 *     boundaries (null, expired, same-day, multi-day), headline singular/
 *     plural, the HONEST zero state (exact message, no fabricated count),
 *     non-trial hiding, negative/fractional count clamping
 *   - pricing renders from config ONLY: PLANS locked values (Starter 14900,
 *     Pro 24900), formatPlanPrice output, TRIAL_DAYS; landing page + nav
 *     source render from the config module and contain no hard-coded prices
 *   - demo labeling: migration 018 (businesses.is_demo), schema type, seed
 *     marks the demo business, session exposes isDemoBusiness, app shell
 *     renders the DEMO banner, dashboard carries the DEMO DATA tag
 *   - dashboard priority order: new leads -> emergencies -> recovered ->
 *     appointment requests -> revenue -> follow-ups -> recent activity
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TRIAL_ZERO_STATE_MESSAGE,
  trialDaysRemaining,
  trialValueView,
} from "../src/lib/trialValue.ts";
import { PLANS, TRIAL_DAYS, formatPlanPrice, getPlan } from "../src/lib/pricing";

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
function eq(name: string, actual: unknown, expected: unknown): void {
  checkTrue(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    "got " + JSON.stringify(actual) + " want " + JSON.stringify(expected),
  );
}
const repo = (p: string): string => readFileSync(join(import.meta.dir, "..", p), "utf8");
const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Trial value indicator math
// ---------------------------------------------------------------------------
eq("trialDays: null trialEndsAt -> 0", trialDaysRemaining(null, 1000), 0);
eq("trialDays: already ended -> 0", trialDaysRemaining(500, 1000), 0);
eq("trialDays: ends now -> 0", trialDaysRemaining(1000, 1000), 0);
eq("trialDays: 1ms left counts as day 1", trialDaysRemaining(1001, 1000), 1);
eq("trialDays: 3.5 days -> 4 (ceil)", trialDaysRemaining(1000 + 3.5 * DAY, 1000), 4);
eq("trialDays: exactly 14 days -> 14", trialDaysRemaining(1000 + 14 * DAY, 1000), 14);

const hidden = trialValueView({ isTrial: false, recoveredCount: 5, daysRemaining: 3 });
eq("view: paid plan hidden", hidden.show, false);
eq("view: paid plan no headline", hidden.headline, "");

const zero = trialValueView({ isTrial: true, recoveredCount: 0, daysRemaining: 12 });
eq("view: zero state shown", zero.show, true);
eq("view: zero state flagged", zero.zeroState, true);
eq("view: zero count stays 0", zero.recoveredCount, 0);
checkTrue("view: zero headline says nobody yet", zero.headline.includes("hasn't recovered anyone yet"), zero.headline);
eq("view: zero subline is the connect-your-number message", zero.subline, TRIAL_ZERO_STATE_MESSAGE);
checkTrue("view: zero message points at connecting the number", TRIAL_ZERO_STATE_MESSAGE.includes("connect your number"), TRIAL_ZERO_STATE_MESSAGE);

const one = trialValueView({ isTrial: true, recoveredCount: 1, daysRemaining: 10 });
eq("view: one customer singular", one.headline, "Your AI has recovered 1 potential customer");
eq("view: one is not zero state", one.zeroState, false);
checkTrue("view: one mentions days left", one.subline.includes("10 days left"), one.subline);

const three = trialValueView({ isTrial: true, recoveredCount: 3, daysRemaining: 1 });
eq("view: three customers plural", three.headline, "Your AI has recovered 3 potential customers");
checkTrue("view: one day left singular", three.subline.includes("1 day left"), three.subline);

const clamped = trialValueView({ isTrial: true, recoveredCount: -2, daysRemaining: 5 });
eq("view: negative count clamps to zero state", clamped.zeroState, true);
eq("view: clamped count is 0", clamped.recoveredCount, 0);
const frac = trialValueView({ isTrial: true, recoveredCount: 2.9, daysRemaining: 5 });
eq("view: fractional count floors to 2", frac.recoveredCount, 2);
const noDays = trialValueView({ isTrial: true, recoveredCount: 4, daysRemaining: 0 });
checkTrue("view: 0 days left still honest headline", noDays.headline.includes("4 potential customers"), noDays.headline);
checkTrue("view: 0 days left omits days sentence", !noDays.subline.includes("day"), noDays.subline);

// ---------------------------------------------------------------------------
// Pricing renders from config ONLY (owner-locked: Starter $149, Pro $249)
// ---------------------------------------------------------------------------
eq("pricing: exactly two plans", PLANS.length, 2);
eq("pricing: starter id first", PLANS[0].id, "starter");
eq("pricing: pro id second", PLANS[1].id, "pro");
eq("pricing: starter locked at 14900", PLANS[0].priceCents, 14900);
eq("pricing: pro locked at 24900", PLANS[1].priceCents, 24900);
eq("pricing: formatPlanPrice starter", formatPlanPrice(PLANS[0]), "149");
eq("pricing: formatPlanPrice pro", formatPlanPrice(PLANS[1]), "249");
eq("pricing: trial is 14 days (owner-locked)", TRIAL_DAYS, 14);
eq("pricing: getPlan('starter') resolves", getPlan("starter")?.name, "Starter");
for (const plan of PLANS) {
  checkTrue(`pricing: ${plan.id} has features to render`, plan.features.length >= 3, String(plan.features.length));
  checkTrue(`pricing: ${plan.id} tagline present`, plan.tagline.length > 10);
}

const landing = repo("src/routes/index.tsx");
checkTrue("landing: imports PLANS from the pricing config", landing.includes('from "~/lib/pricing"') && landing.includes("PLANS"));
checkTrue("landing: renders prices via formatPlanPrice", landing.includes("formatPlanPrice(plan)"));
checkTrue("landing: renders the 14-day trial from config", landing.includes("TRIAL_DAYS"));
checkTrue("landing: no hard-coded $79 tier", !landing.includes("$79"), "found $79 literal");
checkTrue("landing: no hard-coded $299 tier", !landing.includes("$299"), "found $299 literal");
checkTrue("landing: no hard-coded \$149 price literal (config renders it)", !landing.includes("price: \"$149\""), "found $149 tier literal");
checkTrue("landing: no legacy tiers array", !landing.includes("const tiers"), "tiers array still present");
checkTrue("landing: hero primary CTA -> /signup", landing.includes('href="/signup"'));
const signupCount = (landing.match(/href="\/signup"/g) ?? []).length;
checkTrue("landing: signup CTA on hero + plan cards + footer (>=3)", signupCount >= 3, String(signupCount));
checkTrue("landing: secondary CTA -> how-it-works section", landing.includes('href="#how-it-works"'));
checkTrue("landing: how-it-works anchor exists", landing.includes('id="how-it-works"'));
checkTrue("landing: exactly 3 steps", (landing.match(/solutionSteps/g) ?? []).length >= 1 && /n: "3",/.test(landing) && !/n: "4",/.test(landing));
for (const q of [
  "What happens when a call is missed?",
  "How does the AI text back?",
  "Is it really AI?",
  "What about emergencies?",
  "How do I cancel?",
]) {
  checkTrue(`landing: FAQ covers "${q}"`, landing.includes(q));
}
checkTrue("landing: no placeholder-testimonial section", !landing.includes("Customer testimonial will appear here"), "placeholder still present");

const nav = repo("src/components/marketing/Nav.tsx");
checkTrue("nav: primary CTA goes to /signup", nav.includes('href="/signup"'));
checkTrue("nav: CTA copy is Start Your Free Trial", nav.includes("Start Your Free Trial"));
checkTrue("nav: secondary CTA to how-it-works", nav.includes('href="#how-it-works"'));

// ---------------------------------------------------------------------------
// Demo labeling (migration 018 -> schema -> seed -> session -> UI)
// ---------------------------------------------------------------------------
const migration = repo("migrations/018_business_is_demo.sql");
checkTrue("demo: migration adds businesses.is_demo", migration.includes("is_demo"));
checkTrue("demo: is_demo NOT NULL DEFAULT false", migration.includes("NOT NULL DEFAULT false"), "real businesses must default unlabeled");
checkTrue("demo: schema Business type carries isDemo", repo("src/db/schema.ts").includes("isDemo: boolean"));
const seed = repo("scripts/seed.ts");
checkTrue("demo: seed inserts is_demo true", seed.includes("is_demo") && seed.includes(", true)"));
const sessionReads = repo("src/lib/server/sessionReads.ts");
checkTrue("demo: session exposes isDemoBusiness", sessionReads.includes("isDemoBusiness") && sessionReads.includes("ctx.business.isDemo"));
const banner = repo("src/components/app/DemoBanner.tsx");
checkTrue("demo: banner renders a DEMO badge", banner.includes("Demo") && banner.includes("uppercase"));
checkTrue("demo: banner says the data is sample data", banner.includes("sample data"));
checkTrue("demo: banner offers the real signup path", banner.includes('href="/signup"'));
const appShell = repo("src/routes/_app.tsx");
checkTrue("demo: app shell renders banner only inside the demo business", appShell.includes("user.isDemoBusiness ? <DemoBanner /> : null"));

// ---------------------------------------------------------------------------
// Dashboard priority order + value indicator + demo tag wiring
// ---------------------------------------------------------------------------
const dash = repo("src/routes/_app/dashboard.tsx");
const orderOf = (needle: string): number => {
  const idx = dash.indexOf(needle);
  checkTrue(`dashboard: contains "${needle}"`, idx !== -1);
  return idx;
};
const pNew = orderOf('"New leads (7 days)"');
const pEmerg = orderOf('"Emergency leads"');
const pRec = orderOf('"Recovered (missed-call saves)"');
const pAppt = orderOf('"Appointment requests"');
const pRev = orderOf("<RevenueCard");
const pFollow = orderOf('id="follow-ups"');
const pRecent = orderOf('id="recent-leads"');
checkTrue(
  "dashboard: owner priority order new -> emergency -> recovered -> appointments -> revenue -> follow-ups -> recent",
  pNew < pEmerg && pEmerg < pRec && pRec < pAppt && pAppt < pRev && pRev < pFollow && pFollow < pRecent,
  `order ${pNew},${pEmerg},${pRec},${pAppt},${pRev},${pFollow},${pRecent}`,
);
checkTrue("dashboard: value indicator renders from trialValueView", dash.includes("trialValueView"));
checkTrue("dashboard: zero state renders the honest message via the view", dash.includes("TrialValueBanner") && dash.includes("view.zeroState"));
checkTrue("dashboard: indicator carries a test id", dash.includes('data-testid="trial-value-banner"'));
checkTrue("dashboard: emergency card goes red when open", dash.includes('emergencyLeads > 0 ? "red" : "amber"'));
checkTrue("dashboard: demo tag wired to isDemo", dash.includes("data-testid=\"demo-tag\"") && dash.includes("data.isDemo"));
checkTrue("dashboard: recovered count is real data, not a constant", dash.includes("data.recoveredLeads"));

const appFns = repo("src/lib/server/appFns.ts");
checkTrue("dashboard: server computes recoveredLeads from the recovery funnel", appFns.includes("q.missedCallRecoveryStats") && appFns.includes("recoveredLeads: recoveryStats.recovered"));
checkTrue("dashboard: server returns trial state + isDemo", appFns.includes("trial:") && appFns.includes("isDemo: ctx.business.isDemo"));
checkTrue("dashboard: trial expiry math mirrors sessionFns", appFns.includes('ctx.business.plan === "trial"') && appFns.includes("trialDaysRemaining"));

// ---------------------------------------------------------------------------

console.log(`\np4v: ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
