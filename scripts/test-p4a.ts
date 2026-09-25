#!/usr/bin/env bun
/**
 * P4-A tests. Run: bun scripts/test-p4a.ts — no DB, no network, no keys.
 *
 * Covers:
 *   - funnel stage math (src/lib/analytics/funnel.ts): ordered stages,
 *     step conversion (incl. honest null over a zero previous stage),
 *     missing-stage zeroing, overallConversion (null over zero signups)
 *   - feedback aggregation (src/lib/analytics/feedback.ts): up/down counts,
 *     positivePct null when empty (never 0%/100% over nothing), rounding,
 *     recentFeedback ordering/limit
 *   - AI-quality flagging rules (src/lib/analytics/quality.ts): every rule
 *     fires and (importantly) does NOT fire when it shouldn't — no AI
 *     activity ⇒ no flags, escalation completed ⇒ no emergency flag,
 *     thresholds boundary-exact
 *   - prompt versioning/overlay (src/lib/analytics/prompts.ts): next
 *     version numbering, active-version pick, appendPromptOverlay framing
 *     (guardrails stay first, empty overlay = byte-identical base),
 *     body/note validation, surface guard
 *   - wiring (source greps): migration 019 tables/columns, ci.yml runs the
 *     p4a suite, funnel/feedback/flag hooks exist in the right callers
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  FUNNEL_STAGES,
  funnelSteps,
  overallConversion,
  type StageCounts,
} from "../src/lib/analytics/funnel.ts";
import { feedbackAggregate, recentFeedback } from "../src/lib/analytics/feedback.ts";
import {
  computeReviewFlags,
  emptyAiOutcome,
  hasAiActivity,
  sanitizeAiOutcome,
  HIGH_LATENCY_MS,
  REPEATED_FAILURE_MIN,
} from "../src/lib/analytics/quality.ts";
import {
  appendPromptOverlay,
  nextPromptVersion,
  pickActiveVersion,
  validatePromptBody,
  validatePromptNote,
  isPromptSurface,
  PROMPT_SURFACES,
} from "../src/lib/analytics/prompts.ts";

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

// ---------------------------------------------------------------------------
// Funnel stage math
// ---------------------------------------------------------------------------
eq("funnel: 7 stages in order", [...FUNNEL_STAGES], [
  "signup",
  "trial_start",
  "onboarding_completed",
  "phone_connected",
  "first_lead",
  "first_recovered_call",
  "paid",
]);
const empty: StageCounts = {};
eq("funnel: all-zero counts", funnelSteps(empty).map((s) => s.count), [0, 0, 0, 0, 0, 0, 0]);
eq("funnel: first-step conversion is null (nothing before signup)", funnelSteps({ signup: 5 })[0].conversionFromPrev, null);
eq("funnel: null conversion over zero previous stage (honest)", funnelSteps({ signup: 5, paid: 2 })[2].conversionFromPrev, null);
const steps = funnelSteps({ signup: 100, trial_start: 80, onboarding_completed: 40, phone_connected: 20, first_lead: 10, first_recovered_call: 8, paid: 4 });
eq("funnel: step conversion 80/100", steps[1].conversionFromPrev, 80);
eq("funnel: step conversion 4/8 = 50", steps[6].conversionFromPrev, 50);
eq("funnel: unknown stage counts as 0", funnelSteps({ signup: 3, paid: 99 } as StageCounts).filter((s) => s.stage !== "paid").map((s) => s.count), [3, 0, 0, 0, 0, 0]);
eq("funnel: overall conversion 4%", overallConversion({ signup: 100, paid: 4 }), 4);
eq("funnel: overall conversion null over zero signups", overallConversion({ paid: 4 }), null);
eq("funnel: overall conversion null when empty", overallConversion(empty), null);
checkTrue("funnel: fractional rounds", overallConversion({ signup: 3, paid: 1 }) === 33, "got " + overallConversion({ signup: 3, paid: 1 }));

// ---------------------------------------------------------------------------
// Feedback aggregation
// ---------------------------------------------------------------------------
eq("feedback: empty → total 0, pct null (honest, not 0%)", feedbackAggregate([]), { total: 0, up: 0, down: 0, positivePct: null });
eq("feedback: all up → 100%", feedbackAggregate([{ rating: "up" }, { rating: "up" }]), { total: 2, up: 2, down: 0, positivePct: 100 });
eq("feedback: all down → 0%", feedbackAggregate([{ rating: "down" }]), { total: 1, up: 0, down: 1, positivePct: 0 });
eq("feedback: 2/3 up → 67", feedbackAggregate([{ rating: "up" }, { rating: "up" }, { rating: "down" }]).positivePct, 67);
eq("feedback: unknown ratings ignored", feedbackAggregate([{ rating: null }, { rating: "weird" } as unknown as { rating: string | null }]), { total: 0, up: 0, down: 0, positivePct: null });
const entries = [
  { at: "2026-01-01T00:00:00Z", v: 1 },
  { at: "2026-03-01T00:00:00Z", v: 3 },
  { at: null, v: 0 },
  { at: "2026-02-01T00:00:00Z", v: 2 },
];
eq("feedback: recent orders newest-first (nulls last)", recentFeedback(entries, 3).map((e) => e.v), [3, 2, 1]);
eq("feedback: recent limit 0 → empty", recentFeedback(entries, 0).length, 0);

// ---------------------------------------------------------------------------
// AI-quality flagging rules
// ---------------------------------------------------------------------------
const noAi = emptyAiOutcome();
eq("quality: empty signal flags nothing", computeReviewFlags({ outcome: noAi, feedbackRating: null }), []);
checkTrue("quality: no AI activity without turns", !hasAiActivity(noAi));
eq("quality: no AI activity + no feedback → no flags", computeReviewFlags({ outcome: sanitizeAiOutcome(null), feedbackRating: null }), []);
eq("quality: negative feedback fires even with no AI turns", computeReviewFlags({ outcome: noAi, feedbackRating: "down" }), ["negative_feedback"]);
eq("quality: thumbs up never flags", computeReviewFlags({ outcome: noAi, feedbackRating: "up" }), []);

const emergency = { ...emptyAiOutcome(), classifiedTurns: 1, emergencyDetected: true };
eq("quality: emergency without escalation fires", computeReviewFlags({ outcome: emergency, feedbackRating: null }), ["emergency_without_escalation"]);
eq("quality: escalated emergency does NOT fire", computeReviewFlags({ outcome: { ...emergency, emergencyEscalated: true }, feedbackRating: null }), []);
eq("quality: multiple rules order stable", computeReviewFlags({ outcome: { ...emergency, failedTurns: 3 }, feedbackRating: "down" }), ["negative_feedback", "emergency_without_escalation", "ai_failed_repeatedly"]);
eq("quality: 2 failures below threshold", computeReviewFlags({ outcome: { ...emptyAiOutcome(), failedTurns: REPEATED_FAILURE_MIN - 1 }, feedbackRating: null }), []);
eq("quality: no_contact_captured needs ≥2 turns and no capture", computeReviewFlags({ outcome: { ...emptyAiOutcome(), classifiedTurns: 2 }, feedbackRating: null }), ["no_contact_captured"]);
eq("quality: contact captured → no flag", computeReviewFlags({ outcome: { ...emptyAiOutcome(), classifiedTurns: 5, capturedContact: true }, feedbackRating: null }), []);
eq("quality: single turn without contact → no flag (one chance is not a failure)", computeReviewFlags({ outcome: { ...emptyAiOutcome(), classifiedTurns: 1 }, feedbackRating: null }), []);
eq("quality: latency at threshold fires", computeReviewFlags({ outcome: { ...emptyAiOutcome(), classifiedTurns: 1, lastLatencyMs: HIGH_LATENCY_MS }, feedbackRating: null }), ["high_latency"]);
eq("quality: latency just below does not", computeReviewFlags({ outcome: { ...emptyAiOutcome(), classifiedTurns: 1, lastLatencyMs: HIGH_LATENCY_MS - 1 }, feedbackRating: null }), []);
eq("quality: sanitize garbage → zeros", sanitizeAiOutcome("junk"), noAi);
eq("quality: sanitize negative counts clamped", sanitizeAiOutcome({ classifiedTurns: -5, failedTurns: "x", lastLatencyMs: -1 }), noAi);
eq("quality: sanitize keeps valid fields", sanitizeAiOutcome({ capturedContact: true, classifiedTurns: 4, lastLatencyMs: 1200 }).classifiedTurns, 4);

// ---------------------------------------------------------------------------
// Prompt versioning + overlay
// ---------------------------------------------------------------------------
eq("prompts: first version is 1", nextPromptVersion([]), 1);
eq("prompts: next = max+1", nextPromptVersion([{ version: 1 }, { version: 4 }]), 5);
eq("prompts: non-integer versions floored", nextPromptVersion([{ version: 2.9 }]), 3);
eq("prompts: pick active", pickActiveVersion([{ isActive: false, v: 1 }, { isActive: true, v: 2 }])?.v, 2);
eq("prompts: pick active when none → null", pickActiveVersion([{ isActive: false, v: 1 }]), null);
eq("prompts: exactly two surfaces", PROMPT_SURFACES.length, 2);
checkTrue("prompts: surface guard accepts known", isPromptSurface("lead_capture") && isPromptSurface("receptionist"));
checkTrue("prompts: surface guard rejects unknown", !isPromptSurface("nope") && !isPromptSurface(null));

const base = "SAFETY POLICY: never promise. Output STRICT JSON.";
eq("prompts: empty overlay → base byte-identical", appendPromptOverlay(base, null, "lead_capture"), base);
eq("prompts: whitespace overlay → base byte-identical", appendPromptOverlay(base, "   \n ", "receptionist"), base);
const withOverlay = appendPromptOverlay(base, "Always greet with the company name.", "lead_capture");
checkTrue("prompts: overlay appended AFTER the guardrail base", withOverlay.startsWith(base), withOverlay.slice(0, 60));
checkTrue("prompts: overlay text present", withOverlay.includes("Always greet with the company name."));
checkTrue("prompts: framing states safety precedence", withOverlay.includes("safety policy wins"));
checkTrue("prompts: overlay framing names the surface", withOverlay.includes("missed-call SMS assistant"));
eq("prompts: overlay deterministic", appendPromptOverlay(base, "X", "lead_capture"), appendPromptOverlay(base, "X", "lead_capture"));
eq("prompts: body validator trims + bounds", validatePromptBody("  hi  "), "hi");
eq("prompts: body validator rejects empty", validatePromptBody("   "), null);
eq("prompts: body validator rejects non-string", validatePromptBody(42), null);
eq("prompts: body validator rejects >8000", validatePromptBody("x".repeat(8001)), null);
eq("prompts: note validator null-safe", validatePromptNote(null), null);
eq("prompts: note validator trims empty → null", validatePromptNote("  "), null);
eq("prompts: note validator truncates", validatePromptNote("n".repeat(400))?.length, 300);

// ---------------------------------------------------------------------------
// Wiring (source greps — DB behavior is covered by the DB battery)
// ---------------------------------------------------------------------------
const migration = repo("migrations/019_p4a_analytics.sql");
for (const table of ["funnel_events", "ai_review_flags", "prompt_versions"]) {
  checkTrue("migration 019 creates " + table, migration.includes("CREATE TABLE IF NOT EXISTS " + table));
}
for (const stage of [...FUNNEL_STAGES]) {
  checkTrue("migration 019 stage '" + stage + "' in CHECK", migration.includes("'" + stage + "'"));
}
checkTrue("migration 019: unique business+stage (first occurrence)", migration.includes("funnel_events_business_stage_key"));
checkTrue("migration 019: conversations feedback columns", migration.includes("feedback_rating") && migration.includes("feedback_note") && migration.includes("feedback_at"));
checkTrue("migration 019: conversations ai_outcome jsonb", migration.includes("ADD COLUMN IF NOT EXISTS ai_outcome jsonb"));
checkTrue("migration 019: one active prompt per surface", migration.includes("prompt_versions_active_key"));

const ci = repo(".github/workflows/ci.yml");
checkTrue("ci.yml runs the p4a suite", /\bp4a\b/.test(ci), "suites= list must include p4a");

const authFns = repo("src/lib/server/authFns.ts");
checkTrue("hook: signup records signup+trial_start", authFns.includes("trackFunnelAll(business.id, [\"signup\", \"trial_start\"])"));
const textBack = repo("src/lib/server/textBack.ts");
checkTrue("hook: inbound SMS records first_recovered_call", textBack.includes("trackFunnel(args.businessId, \"first_recovered_call\")"));
checkTrue("hook: lead capture records first_lead", textBack.includes("trackFunnel(businessId, \"first_lead\")"));
checkTrue("hook: classification turn recorded (quality signals)", textBack.includes("recordClassificationTurn"));
checkTrue("hook: emergency escalation stamped", textBack.includes("markEmergencyEscalated"));
checkTrue("hook: lead-capture prompt reads runtime overlay", textBack.includes("applyPromptOverlay(system, \"lead_capture\")"));
const webhook = repo("src/lib/server/stripeWebhook.ts");
checkTrue("hook: active subscription records paid", webhook.includes('trackFunnel(businessId, "paid")'));
const voice = repo("src/lib/server/voiceReceptionist.ts");
checkTrue("hook: receptionist summary prompt reads runtime overlay", voice.includes('"receptionist"'));
const settingsFns = repo("src/lib/server/settingsFns.ts");
checkTrue("hook: onboarding completion recorded", settingsFns.includes('trackFunnel(businessId, "onboarding_completed")'));
checkTrue("hook: phone connection recorded", settingsFns.includes('trackFunnel(businessId, "phone_connected")'));

for (const route of [
  "src/routes/admin/funnel.tsx",
  "src/routes/admin/prompts.tsx",
  "src/routes/_app/quality.tsx",
]) {
  checkTrue("route exists: " + route, existsSync(join(import.meta.dir, "..", route)));
}
const appShell = repo("src/components/app/AppShell.tsx");
checkTrue("nav: owner quality page linked", appShell.includes('"/quality"'));
const inbox = repo("src/routes/_app/inbox.tsx");
checkTrue("inbox: feedback affordance wired", inbox.includes("How did MissedCall AI handle this?"));

checkTrue("prompt default fallback: overlay failure returns code prompt", repo("src/lib/server/promptOverrides.ts").includes("body = null"));

console.log("");
console.log("p4a: " + checks + " checks, " + failures + " failures");
if (failures > 0) process.exit(1);
