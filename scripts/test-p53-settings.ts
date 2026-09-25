/**
 * P5-3 — Settings consolidation + AI tone (P5-3) verification suite.
 *
 * Runs against DATABASE_URL (Neon or the local shim), same pattern as
 * test-e2e-journey.ts: real DB rows through the real query layer + the real
 * server-side read/write helpers, one test business, CASCADE cleanup, exit 0
 * only when every check passes. Adds ZERO rows outside the test business.
 *
 * Covered:
 *   1. AI TONE — pure helpers (sanitizeAiTone tolerance, tonePromptDirective
 *      per tone, professional = no directive), the flat-settings read
 *      (readAiTone — the shape saveAiToneFn persists), and the END-TO-END
 *      settings → next-AI-turn-prompt handoff:
 *        settings blob written in the DB → read back → readAiTone →
 *        buildClassifierSystemPrompt → the tone directive present;
 *        plus a stub-LLM pipeline run proving the recorded system prompt
 *        carries the tone (and changes when the tone changes).
 *   2. SETTINGS CONSOLIDATION surface data — the tone reads through the same
 *      settings blob every settings surface writes; two businesses with
 *      different tones never see each other's value (isolation on the blob).
 *   3. PLUMBING TUNING — the two P5-3 rule fixes (fixture overflow, tank
 *      burst) classify emergency, while routine phrasings stay routine.
 *
 * Run: bun scripts/test-p53-settings.ts
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import { createBusinessWithOwner, getBusiness } from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import { updateBusinessSettings } from "../src/db/queries/auth";
import { sanitizeAiTone, readAiToneValue, tonePromptDirective, AI_TONES } from "../src/lib/aiTone";
import { buildClassifierSystemPrompt, runClassificationPipeline, type PipelineLlm } from "../src/lib/server/classifyPipeline";
import { readAiTone } from "../src/lib/server/textBack";
import { classifyInboundText } from "../src/lib/server/classify";

if (process.env.USE_LOCAL_POSTGRES === "1") await installLocalPostgresShim();

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
function checkEq(name: string, actual: unknown, expected: unknown): void {
  checkTrue(name, actual === expected, "got " + JSON.stringify(actual) + " want " + JSON.stringify(expected));
}

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
let businessId: string | null = null;
let businessId2: string | null = null;

try {
  // =========================================================================
  // 1. PURE TONE HELPERS
  // =========================================================================
  checkEq("tone: exactly the four documented options", AI_TONES.length, 4);
  checkEq(
    "tone: sanitize garbage → professional default",
    sanitizeAiTone("NOT-A-TONE"),
    "professional",
  );
  checkEq("tone: sanitize non-string → default", sanitizeAiTone(42), "professional");
  checkEq("tone: sanitize trims + lowercases", sanitizeAiTone("  CASUAL "), "casual");
  checkTrue(
    "tone: sanitize accepts every option verbatim",
    AI_TONES.every((t) => sanitizeAiTone(t) === t),
  );
  checkEq("tone: readAiToneValue undefined → null (unset)", readAiToneValue(undefined), null);
  checkEq("tone: readAiToneValue invalid → null", readAiToneValue("shouting"), null);
  checkTrue(
    "tone: professional adds NO prompt directive (base prompt IS professional)",
    tonePromptDirective("professional") === null,
  );
  const nonDefault = AI_TONES.filter((t) => t !== "professional");
  checkTrue(
    "tone: every non-default tone has a distinct directive",
    new Set(nonDefault.map((t) => tonePromptDirective(t))).size === nonDefault.length &&
      nonDefault.every((t) => (tonePromptDirective(t) ?? "").length > 0),
  );
  checkTrue(
    "tone: directives subordinate themselves to the safety policy",
    nonDefault.every((t) => /SAFETY POLICY/.test(tonePromptDirective(t) ?? "")),
  );

  // =========================================================================
  // 2. FLAT-SETTINGS READ (the shape the settings surface persists)
  // =========================================================================
  checkEq("read: flat settings.aiTone → tone", readAiTone({ aiTone: "direct" }), "direct");
  checkEq("read: nested-forward-compat blob without flat key → null", readAiTone({ emergencyInstructions: "x" }), null);
  checkEq("read: null settings → null", readAiTone(null), null);
  checkEq("read: string settings → null (never throws)", readAiTone("garbage" as unknown), null);
  checkEq("read: invalid tone string → null (default applies downstream)", readAiTone({ aiTone: "loud" }), null);

  // =========================================================================
  // 3. END-TO-END: DB settings blob → next AI turn's system prompt
  // =========================================================================
  const passwordHash = await hashPassword("p53-password-1234");
  const { business } = await createBusinessWithOwner({
    businessName: "P5-3 Settings Test Plumbing " + STAMP,
    ownerEmail: `p53+${STAMP}@p53-test.example.com`,
    ownerFullName: "P5-3 Tester",
    passwordHash,
  });
  businessId = business.id;
  checkTrue("e2e: test business created", !!businessId);

  // A second business for the isolation check on the settings blob.
  const second = await createBusinessWithOwner({
    businessName: "P5-3 Other Plumbing " + STAMP,
    ownerEmail: `p53b+${STAMP}@p53-test.example.com`,
    ownerFullName: "P5-3 Tester B",
    passwordHash,
  });
  businessId2 = second.business.id;
  checkTrue("e2e: second test business created", !!businessId2);

  // Simulate the settings surface save (saveAiToneFn writes exactly this flat
  // shape through updateBusinessSettings): business 1 = casual, business 2 =
  // stays unset → professional.
  const biz1 = await getBusiness(businessId);
  const currentSettings = (biz1 as unknown as { settings?: Record<string, unknown> } | null)?.settings ?? {};
  await updateBusinessSettings(businessId, {
    ...currentSettings,
    aiTone: "casual",
    aiToneSavedAt: new Date().toISOString(),
  });

  const reread = await getBusiness(businessId);
  const tone = readAiTone((reread as unknown as { settings?: unknown } | null)?.settings);
  checkEq("e2e: saved tone reads back from the DB blob", tone, "casual");

  const promptWithTone = buildClassifierSystemPrompt(null, tone);
  checkTrue(
    "e2e: next-turn system prompt carries the casual directive",
    /TONE \(owner setting: Casual\)/.test(promptWithTone),
  );
  checkTrue(
    "e2e: the directive sits AFTER the guardrail policy (style can never displace safety)",
    promptWithTone.indexOf("SAFETY POLICY") > -1 &&
      promptWithTone.indexOf("TONE (owner setting") > promptWithTone.indexOf("SAFETY POLICY"),
  );

  const otherReread = await getBusiness(businessId2!);
  const otherTone = readAiTone((otherReread as unknown as { settings?: unknown } | null)?.settings);
  checkEq("isolation: second business tone unset", otherTone, null);
  const otherPrompt = buildClassifierSystemPrompt(null, otherTone);
  checkTrue(
    "isolation: second business prompt has NO tone directive",
    !/TONE \(owner setting/.test(otherPrompt),
  );

  // Tone change → different next-turn prompt, immediately.
  const directPrompt = buildClassifierSystemPrompt(null, "direct");
  checkTrue(
    "e2e: switching tone changes the directive text",
    /TONE \(owner setting: Direct\)/.test(directPrompt) &&
      !/TONE \(owner setting: Casual\)/.test(directPrompt),
  );

  // =========================================================================
  // 4. STUB-LLM PIPELINE: the tone lands on the system prompt the LLM sees
  // =========================================================================
  let recorded: string | null = null;
  const recordingLlm: PipelineLlm = {
    model: "stub-p53",
    complete: async (system) => {
      recorded = system;
      return JSON.stringify({
        serviceNeed: "Kitchen sink backing up",
        urgency: "same_day",
        priority: "high",
        contactName: null,
        contactEmail: null,
        serviceAddress: null,
        safetyConcern: null,
        notes: null,
        reply: null,
      });
    },
  };
  const pipelineRes = await runClassificationPipeline({
    body: "my kitchen sink is backing up, can someone come today?",
    now: new Date(),
    timezone: "America/Chicago",
    hours: null,
    llm: recordingLlm,
    aiTone: "friendly",
  });
  checkTrue("pipeline: llm tier ran (stub responded)", pipelineRes.classification.classifier === "llm");
  checkTrue(
    "pipeline: recorded system prompt carries the friendly directive",
    /TONE \(owner setting: Friendly\)/.test(recorded ?? ""),
  );
  const pipelineNoTone = await runClassificationPipeline({
    body: "my kitchen sink is backing up, can someone come today?",
    now: new Date(),
    timezone: "America/Chicago",
    hours: null,
    llm: recordingLlm,
  });
  checkTrue("pipeline: unset tone → llm tier still runs", pipelineNoTone.classification.classifier === "llm");
  checkTrue(
    "pipeline: unset tone → NO directive in the recorded prompt",
    !/TONE \(owner setting/.test(recorded ?? ""),
  );
  checkTrue(
    "pipeline: classification output unchanged by tone (same JSON contract)",
    pipelineRes.classification.serviceNeed === "Kitchen sink backing up" &&
      pipelineRes.classification.urgency === "same_day",
  );

  // =========================================================================
  // 5. PLUMBING TUNING (P5-3 rule fixes + routine controls)
  // =========================================================================
  const sink = classifyInboundText("my sink overflowed");
  checkEq("tuning: sink overflow → emergency", sink.category, "emergency");
  const drain = classifyInboundText("the drain overflowed");
  checkEq("tuning: drain overflow → emergency", drain.category, "emergency");
  const dishwasher = classifyInboundText("dishwasher overflowed onto the kitchen floor");
  checkEq("tuning: dishwasher overflow → emergency", dishwasher.category, "emergency");
  const toilet = classifyInboundText("toilet overflowed!!");
  checkEq("tuning: toilet overflow (pre-existing) → emergency", toilet.category, "emergency");
  const tankBurst = classifyInboundText("hot water tank burst");
  checkEq("tuning: hot water tank burst → emergency", tankBurst.category, "emergency");
  checkTrue(
    "tuning: hot water tank burst flags safetyConcern",
    tankBurst.safetyConcern === true,
  );
  // Routine controls — the widened rules must NOT over-trigger.
  const clog = classifyInboundText("kitchen sink is clogged");
  checkEq("tuning: control — clogged sink stays urgent, not emergency", clog.category, "urgent");
  const install = classifyInboundText("install new toilet");
  checkTrue(
    "tuning: control — toilet install stays non-emergency",
    install.category !== "emergency",
  );
  const maint = classifyInboundText("calling about the annual maintenance on our tankless");
  checkEq("tuning: control — tankless maintenance stays routine", maint.category, "routine");
  const pressure = classifyInboundText("low water pressure in the shower");
  checkTrue(
    "tuning: control — low pressure stays non-emergency",
    pressure.category !== "emergency",
  );
} catch (err) {
  checks++;
  failures++;
  console.log("FAIL suite threw — " + String(err));
} finally {
  // Cleanup: CASCADE wipes everything the two test businesses own.
  if (businessId) {
    await query("DELETE FROM businesses WHERE id = $1", [businessId]);
  }
  if (businessId2) {
    await query("DELETE FROM businesses WHERE id = $1", [businessId2]);
  }
}

console.log(failures === 0 ? `P5-3 SETTINGS PASS — ${checks} checks, 0 failures` : `P5-3 SETTINGS FAIL — ${failures} of ${checks} checks failed`);
process.exit(failures === 0 ? 0 : 1);
