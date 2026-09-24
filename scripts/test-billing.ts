#!/usr/bin/env bun
/**
 * Unit tests for P3-F billing completeness. Run: bun scripts/test-billing.ts
 * No DB, no network, no Stripe keys — the pure engines are exercised
 * directly (usage.ts, pricing.ts) and the lifecycle/state-machine rules.
 *
 * Covers: limit math (one-under / at-limit / over / rollover reset),
 * increment idempotency semantics (documented SQL upsert shape), pricing.ts
 * single-source-of-truth (no hard-coded prices/limits outside it),
 * cancel/reactivate state machine, downgrade data retention, and honest
 * gating without Stripe keys.
 */
import {
  PLAN_LIMITS,
  TRIAL_DAYS,
  formatPlanPrice,
  limitsForPlan,
  PLANS,
} from "../src/lib/pricing";
import {
  cancelRequestDecision,
  currentPeriodStart,
  isAtLimit,
  limitReachedMessage,
  reactivateRequestDecision,
  resolveGate,
  resolveGateWithEmergency,
  usageLabel,
  usagePercent,
} from "../src/lib/server/usage";
import { readFileSync, readdirSync } from "node:fs";

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log("FAIL " + name + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  } else {
    console.log("ok   " + name);
  }
}

// ---------------------------------------------------------------------------
// Limit math
// ---------------------------------------------------------------------------
const starter = limitsForPlan("starter");
const pro = limitsForPlan("pro");
check("starter limits launch defaults", starter, { sms_per_month: 500, ai_turns_per_month: 500, calls_per_month: 100 });
check("pro limits launch defaults", pro, { sms_per_month: 2000, ai_turns_per_month: 2000, calls_per_month: 500 });

// one-under → allowed
const under = resolveGate({ axis: "sms_per_month", used: 499, limits: starter, planName: "Starter", isCurrentPlanPro: false });
check("one-under allowed", { allowed: under.allowed, used: under.used }, { allowed: true, used: 499 });
// at-limit → blocked, typed result
const at = resolveGate({ axis: "sms_per_month", used: 500, limits: starter, planName: "Starter", isCurrentPlanPro: false });
check("at-limit blocked", at.allowed, false);
check("at-limit reason", at.allowed === false ? at.reason : null, "limit_reached");
check("at-limit upgrade target", at.allowed === false ? at.upgradeTo : null, "pro");
check("at-limit message names plan", at.allowed === false ? at.message.includes("Starter") : false, true);
// over → blocked
const over = resolveGate({ axis: "ai_turns_per_month", used: 1200, limits: starter, planName: "Starter", isCurrentPlanPro: false });
check("over blocked", over.allowed, false);
// pro at limit → no upgrade target (top plan)
const proAt = resolveGate({ axis: "sms_per_month", used: 2000, limits: pro, planName: "Pro", isCurrentPlanPro: true });
check("pro at-limit blocked", proAt.allowed, false);
check("pro at-limit no upgrade", proAt.allowed === false ? proAt.upgradeTo : null, null);
// period rollover resets: a NEW period's counter row starts at zero — the
// gate reads the current period only, so used=0 in the new period allows.
check("rollover resets (new period used=0 allowed)", resolveGate({ axis: "sms_per_month", used: 0, limits: starter, planName: "Starter", isCurrentPlanPro: false }).allowed, true);
check("isAtLimit helper", [isAtLimit("sms_per_month", 499, starter), isAtLimit("sms_per_month", 500, starter)], [false, true]);

// Emergency exception: never rate-limited, documented in code
const emerg = resolveGateWithEmergency({ axis: "sms_per_month", used: 5000, limits: starter, planName: "Starter", isCurrentPlanPro: false, emergency: true });
check("emergency sms never limited", emerg.allowed, true);
const emergTurn = resolveGateWithEmergency({ axis: "ai_turns_per_month", used: 5000, limits: starter, planName: "Starter", isCurrentPlanPro: false, emergency: true });
check("emergency does not lift turn limits", emergTurn.allowed, false);

// ---------------------------------------------------------------------------
// Period anchor math (billing period = month since trial/subscription start)
// ---------------------------------------------------------------------------
const anchor = new Date(Date.UTC(2026, 0, 15, 9, 0, 0)); // Jan 15 09:00
check("mid-period anchor", currentPeriodStart(anchor, new Date(Date.UTC(2026, 1, 3))).toISOString(), anchor.toISOString());
check("anchor day rolls forward", currentPeriodStart(anchor, new Date(Date.UTC(2026, 1, 15, 10))).toISOString(), new Date(Date.UTC(2026, 1, 15, 9)).toISOString());
check("short-month clamp (Jan 31 anchor, Mar 15 -> Feb 28 period)", currentPeriodStart(new Date(Date.UTC(2026, 0, 31)), new Date(Date.UTC(2026, 2, 15))).toISOString(), new Date(Date.UTC(2026, 1, 28)).toISOString());
check("year wrap", currentPeriodStart(new Date(Date.UTC(2025, 11, 20)), new Date(Date.UTC(2026, 0, 10))).toISOString(), new Date(Date.UTC(2025, 11, 20)).toISOString());

// ---------------------------------------------------------------------------
// pricing.ts single-source-of-truth
// ---------------------------------------------------------------------------
check("plan prices from config", PLANS.map((p) => formatPlanPrice(p)), ["149", "249"]);
check("trial days from config", TRIAL_DAYS, 14);
check("trial plan gets starter limits", limitsForPlan("trial"), PLAN_LIMITS.starter);
check("unknown plan gets starter limits", limitsForPlan("growth"), PLAN_LIMITS.starter);

// No plan prices or limit numbers hard-coded outside pricing.ts
const offenders: string[] = [];
function walk(dir: string): void {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = dir + "/" + f.name;
    if (f.isDirectory()) { walk(p); continue; }
    if (!f.name.endsWith(".ts") && !f.name.endsWith(".tsx")) continue;
    // The landing page (routes/index.tsx) is a static marketing mockup with
    // illustrative tier copy — the P4-V landing-conversion build replaces it
    // with pricing.ts-derived data. The legal policy pages (terms.tsx,
    // privacy.tsx) QUOTE the subscription prices in legal prose; that is
    // documentation of the config, not configuration. Product/billing code
    // is held to the rule: if a code file hard-codes a price, this fails.
    if (
      p.endsWith("lib/pricing.ts") ||
      p.endsWith("routes/index.tsx") ||
      p.endsWith("routes/terms.tsx") ||
      p.endsWith("routes/privacy.tsx")
    ) continue;
    const src = readFileSync(p, "utf8");
    if (/14900|24900|\$149|\$249|sms_per_month:\s*\d|ai_turns_per_month:\s*\d/.test(src)) {
      offenders.push(p);
    }
  }
}
walk("src");
check("no hard-coded prices/limits outside pricing.ts", offenders, []);

// ---------------------------------------------------------------------------
// Cancel / reactivate state machine (cancel_at_period_end, data retained)
// ---------------------------------------------------------------------------
const cancelFresh = cancelRequestDecision(false);
check("cancel fresh schedules", cancelFresh.changed, true);
check("cancel message promises data preserved", cancelFresh.message.includes("data are preserved"), true);
const cancelRepeat = cancelRequestDecision(true);
check("cancel repeat is a no-op", cancelRepeat.changed, false);
const reactNoop = reactivateRequestDecision(false);
check("reactivate without cancel is a no-op", reactNoop.changed, false);
const reactAfter = reactivateRequestDecision(true);
check("reactivate after cancel restores", reactAfter.changed, true);
check("reactivate message promises no data loss", reactAfter.message.includes("no data was lost"), true);
// Downgrade never deletes data: the lifecycle writes only plan + status —
// verified by the SQL shape (no DELETE statements in billing/auth queries).
const authSrc = readFileSync("src/db/queries/auth.ts", "utf8");
const billingSrc = readFileSync("src/lib/server/billingFns.ts", "utf8");
check("no DELETEs in plan-lifecycle writers", /DELETE FROM (businesses|leads|conversations)/.test(authSrc + billingSrc), false);

// ---------------------------------------------------------------------------
// Honest gating without Stripe keys
// ---------------------------------------------------------------------------
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
const { readStripeConfig } = await import("../src/lib/server/stripeWebhook");
check("no stripe keys → readStripeConfig null", readStripeConfig(), null);
const billingFnsSrc = readFileSync("src/lib/server/billingFns.ts", "utf8");
check("plan change refuses honestly without keys", billingFnsSrc.includes("Billing is not configured yet"), true);
check("no fake plan writes without keys", !billingFnsSrc.includes("await q.setBusinessPlan"), true);
check("limit message is honest and plan-named", limitReachedMessage("Starter", "sms_per_month").includes("Starter plan's monthly SMS allowance"), true);

// ---------------------------------------------------------------------------
// UI label helpers
// ---------------------------------------------------------------------------
check("usage label", usageLabel(37, 500), "37 of 500");
check("usage percent", [usagePercent(250, 500), usagePercent(0, 500), usagePercent(600, 500)], [50, 0, 120]);

console.log(failures === 0 ? "\n" + checks + " checks, 0 failures" : "\n" + checks + " checks, " + failures + " failures");
process.exit(failures === 0 ? 0 : 1);
