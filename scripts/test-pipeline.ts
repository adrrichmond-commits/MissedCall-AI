#!/usr/bin/env bun
/**
 * Unit-style tests for the P3-B classification+advice pipeline
 * (src/lib/server/classifyPipeline.ts).
 * Run: bun scripts/test-pipeline.ts — no DB, no network, no keys.
 *
 * Covers: tier selection (LLM primary / rules default without a key / rules
 * backstop on LLM error or garbage), LLM reply post-screening (deny + escalate
 * stripped to the honest human-routing fallback, allow passes), emergency
 * wins regardless of tier (fail toward emergency), after-hours flag logic
 * (incl. fail-toward-escalation on unreadable settings), KB stamps on every
 * result, and the deterministic system prompt assembly.
 */
import {
  runClassificationPipeline,
  isAfterHours,
  localWallClock,
  buildClassifierSystemPrompt,
  buildServiceCatalogContext,
  matchFaqEntry,
  HUMAN_ROUTING_REPLY,
  GENERIC_EMERGENCY_REPLY,
  type PipelineInput,
  type PipelineLlm,
} from "../src/lib/server/classifyPipeline";
import { KB_VERSION, FAQ_ENTRIES, EMERGENCIES } from "../src/lib/server/kb";
import type { EmergencyKbEntry } from "../src/lib/server/kb";

let failures = 0;
let count = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  count++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log("FAIL " + name + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  } else {
    console.log("ok   " + name);
  }
}
function checkTrue(name: string, cond: boolean, detail = ""): void {
  count++;
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  } else {
    console.log("ok   " + name);
  }
}

// --- Fixtures ------------------------------------------------------------------

const WED_NOON = new Date("2024-01-17T12:00:00Z"); // a Wednesday, 12:00 UTC
const WED_NIGHT = new Date("2024-01-17T20:00:00Z"); // same Wednesday, 20:00 UTC
const OPEN_WED = [{ dayOfWeek: 3, isOpen: true, opensAt: "09:00:00", closesAt: "17:00:00" }];
const UTC = "UTC";

function baseInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    body: "hi there",
    now: WED_NOON,
    timezone: UTC,
    hours: OPEN_WED,
    llm: null,
    ...overrides,
  };
}

function llmStub(payload: { json?: string; reply?: string; throw?: boolean; raw?: string }): PipelineLlm {
  return {
    model: "test-model-1",
    async complete() {
      if (payload.throw) throw new Error("simulated LLM outage");
      if (payload.raw !== undefined) return payload.raw;
      const reply = payload.reply ?? null;
      const json = payload.json ?? JSON.stringify({ serviceNeed: "test need", urgency: null, priority: null, reply });
      return json;
    },
  };
}

async function run(body: string, overrides: Partial<PipelineInput> = {}) {
  return runClassificationPipeline(baseInput({ body, ...overrides }));
}

// --- 1. Tier selection ----------------------------------------------------------
{
  const r = await run("my kitchen sink is clogged, can you come out Tuesday?");
  check("no key: tier is rules", r.tier, "rules");
  check("no key: tierReason default", r.tierReason, "default");
  check("no key: classifier stamped rules", r.classification.classifier, "rules");
  checkTrue("no key: model is the rules version", (r.classification.model ?? "").startsWith("rules-"), r.classification.model ?? "");

  const r2 = await run("my kitchen sink is clogged", {
    llm: llmStub({ json: JSON.stringify({ serviceNeed: "clogged kitchen sink", urgency: "same_day", priority: "high", reply: null }) }),
  });
  check("key + healthy: tier is llm", r2.tier, "llm");
  check("key + healthy: tierReason primary", r2.tierReason, "primary");
  check("key + healthy: classifier stamped llm", r2.classification.classifier, "llm");
  check("key + healthy: LLM extraction kept", r2.classification.serviceNeed, "clogged kitchen sink");
  check("key + healthy: model stamped", r2.classification.model, "test-model-1");

  const r3 = await run("my kitchen sink is clogged", { llm: llmStub({ throw: true }) });
  check("LLM error: tier falls back to rules", r3.tier, "rules");
  check("LLM error: tierReason backstop", r3.tierReason, "backstop");
  checkTrue("LLM error: classification still produced", r3.classification.serviceNeed !== undefined);

  const r4 = await run("my kitchen sink is clogged", { llm: llmStub({ raw: "I am not JSON at all" }) });
  check("LLM garbage: tier falls back to rules", r4.tier, "rules");
  check("LLM garbage: tierReason backstop", r4.tierReason, "backstop");
}

// --- 2. LLM reply post-screening ---------------------------------------------------
{
  const denied = await run("how do I turn my gas back on after the outage?", {
    llm: llmStub({ reply: "You can shut off the gas valve yourself with a wrench — just turn it." }),
  });
  check("deny: reply replaced with human routing", denied.reply && denied.reply.text, HUMAN_ROUTING_REPLY);
  check("deny: replySource human_routing", denied.reply && denied.reply.source, "human_routing");
  checkTrue("deny: raw LLM text NOT in the reply", denied.reply ? !denied.reply.text.includes("wrench") : true);
  checkTrue("deny: screening captured the decision", denied.screen ? denied.screen.decision === "block" : false, JSON.stringify(denied.screen));
  checkTrue("deny: screening recorded deny rules", (denied.screen?.matchedDeny.length ?? 0) > 0);

  const allowed = await run("where is my water shutoff valve and can I close it myself?", {
    llm: llmStub({ reply: "Yes — shut off the main water valve where the line enters the house." }),
  });
  check("allow: screened LLM reply kept verbatim", allowed.reply && allowed.reply.text, "Yes — shut off the main water valve where the line enters the house.");
  check("allow: replySource llm_screened", allowed.reply && allowed.reply.source, "llm_screened");
  check("allow: screening decision allow", allowed.screen && allowed.screen.decision, "allow");

  const escalated = await run("my kitchen faucet is loose, what should I do about it?", {
    llm: llmStub({ reply: "You should probably check under the sink for loose fittings and tighten what you find." }),
  });
  check("escalate: ambiguous advice replaced with human routing", escalated.reply && escalated.reply.text, HUMAN_ROUTING_REPLY);
  check("escalate: replySource human_routing", escalated.reply && escalated.reply.source, "human_routing");
  check("escalate: screening decision escalate", escalated.screen && escalated.screen.decision, "escalate");

  const noAdvice = await run("my kitchen sink has been slow for a week", {
    llm: llmStub({ json: JSON.stringify({ serviceNeed: "slow sink", urgency: "same_day", priority: "high", reply: null }) }),
  });
  checkTrue(
    "non-question service statement: no reply produced",
    noAdvice.reply === null,
    JSON.stringify(noAdvice.reply),
  );
  check("non-question service statement: replySource null", noAdvice.classification.replySource, null);
}

// --- 3. Emergency wins regardless of tier --------------------------------------------
{
  // LLM under-calls the urgency; the KB says active flooding.
  const llmFlood = await run("my basement is filling with water fast", {
    llm: llmStub({ json: JSON.stringify({ serviceNeed: "wet basement", urgency: "same_day", priority: "high", reply: null }) }),
  });
  check("KB emergency beats LLM same_day: urgency emergency", llmFlood.classification.urgency, "emergency");
  check("KB emergency beats LLM same_day: priority emergency", llmFlood.classification.priority, "emergency");
  check("KB emergency beats LLM same_day: category emergency", llmFlood.classification.category, "emergency");
  check("KB emergency key stamped", llmFlood.classification.emergencyKey, "active_flooding");
  check("KB emergency severity stamped", llmFlood.classification.emergencySeverity, "critical");
  checkTrue("emergency reply is the KB safety script", llmFlood.reply ? llmFlood.reply.source === "kb_emergency_script" : false);
  checkTrue("emergency: LLM draft discarded (no pricing/booking text)", llmFlood.reply ? llmFlood.reply.text.startsWith("First, shut off the main water valve") : false);

  // Rules say "other"; the KB says sewage backup (gurgling is the tell).
  const rulesGurgle = await run("the drain in the bathroom is gurgling");
  check("KB emergency beats rules other: urgency emergency", rulesGurgle.classification.urgency, "emergency");
  check("KB emergency key from rules tier", rulesGurgle.classification.emergencyKey, "sewage_backup");
  check("KB emergency fills serviceNeed", rulesGurgle.classification.serviceNeed, "sewage backup");
  checkTrue("KB emergency lifts confidence to 0.85", rulesGurgle.classification.confidence === 0.85, String(rulesGurgle.classification.confidence));
  checkTrue("emergency script matches the KB entry verbatim", (() => {
    const entry = EMERGENCIES.find((e: EmergencyKbEntry) => e.key === "sewage_backup");
    return rulesGurgle.reply != null && entry != null && rulesGurgle.reply.text === entry.customerScript.join(" ");
  })());

  // LLM-only emergency with no KB entry still escalates (fail toward emergency).
  const llmOnly = await run("water is coming through my ceiling light fixture", {
    llm: llmStub({ json: JSON.stringify({ serviceNeed: "water from light", urgency: "emergency", priority: "emergency", reply: null }) }),
  });
  checkTrue(
    "LLM-only emergency (no KB class) still emergency",
    llmOnly.classification.urgency === "emergency" && llmOnly.classification.emergencyKey === null,
    JSON.stringify({ urgency: llmOnly.classification.urgency, key: llmOnly.classification.emergencyKey }),
  );
  check("LLM-only emergency: honest generic routing reply", llmOnly.reply && llmOnly.reply.source, "kb_emergency_generic");
  checkTrue("generic emergency reply is the honest copy", llmOnly.reply ? llmOnly.reply.text === GENERIC_EMERGENCY_REPLY : false);

  // Non-emergency stays untouched by the merge.
  const routine = await run("do you service tankless water heaters? just curious");
  checkTrue("routine question stays routine", routine.classification.urgency !== "emergency" && routine.classification.emergencyKey === null);
}

// --- 4. After-hours flag logic ---------------------------------------------------
{
  const inside = await run("pipe burst under my sink", { now: WED_NOON, timezone: UTC, hours: OPEN_WED });
  check("emergency inside hours: no after-hours escalation", inside.afterHoursEscalation, false);
  check("emergency inside hours: afterHours fact false", inside.afterHours, false);

  const outside = await run("pipe burst under my sink", { now: WED_NIGHT, timezone: UTC, hours: OPEN_WED });
  check("emergency outside hours: after-hours escalation", outside.afterHoursEscalation, true);
  check("emergency outside hours: afterHours fact true", outside.afterHours, true);

  const noHours = await run("pipe burst under my sink", { now: WED_NOON, timezone: UTC, hours: null });
  check("emergency with no hours configured: fail toward escalation", noHours.afterHoursEscalation, true);

  const noTz = await run("pipe burst under my sink", { now: WED_NOON, timezone: null, hours: OPEN_WED });
  check("emergency with no timezone: fail toward escalation", noTz.afterHoursEscalation, true);

  const closedDay = await run("pipe burst under my sink", {
    now: WED_NOON,
    timezone: UTC,
    hours: [{ dayOfWeek: 4, isOpen: true, opensAt: "09:00:00", closesAt: "17:00:00" }],
  });
  check("emergency on a closed day: after-hours escalation", closedDay.afterHoursEscalation, true);

  const routineNight = await run("how much for a water heater replacement?", { now: WED_NIGHT, timezone: UTC, hours: OPEN_WED });
  check("non-emergency: afterHoursEscalation stays false even at night", routineNight.afterHoursEscalation, false);

  // Pure unit coverage of the hours math.
  check("afterHours: open window contains noon", isAfterHours(WED_NOON, UTC, OPEN_WED), false);
  check("afterHours: 20:00 outside 09-17", isAfterHours(WED_NIGHT, UTC, OPEN_WED), true);
  check("afterHours: boundary 09:00 exactly counts as open", isAfterHours(new Date("2024-01-17T09:00:00Z"), UTC, OPEN_WED), false);
  check("afterHours: boundary 17:00 exactly counts as closed", isAfterHours(new Date("2024-01-17T17:00:00Z"), UTC, OPEN_WED), true);
  check("afterHours: empty rows escalate", isAfterHours(WED_NOON, UTC, []), true);
  const clock = localWallClock(WED_NIGHT, UTC);
  check("localWallClock: UTC Wednesday 20:00", clock, { dayOfWeek: 3, minutes: 1200 });
  check("localWallClock: NY offset applied", localWallClock(WED_NIGHT, "America/New_York"), { dayOfWeek: 3, minutes: 900 });
  check("localWallClock: invalid timezone fails safely", localWallClock(WED_NIGHT, "Mars/Olympus"), null);
}

// --- 5. Stamps on every result ---------------------------------------------------
{
  const samples: Array<[string, PipelineInput]> = [
    ["rules default", baseInput({ body: "kitchen faucet drips" })],
    ["rules backstop", baseInput({ body: "kitchen faucet drips", llm: llmStub({ throw: true }) })],
    ["llm primary", baseInput({ body: "kitchen faucet drips", llm: llmStub({ json: "{}" }) })],
    ["emergency", baseInput({ body: "gas smell in the kitchen" })],
  ];
  for (const [label, input] of samples) {
    const r = await runClassificationPipeline(input);
    check(label + ": kbVersion stamped", r.classification.kbVersion, KB_VERSION);
    checkTrue(label + ": tier matches classifier", r.classification.tier === r.classification.classifier);
    checkTrue(
      label + ": tierReason is one of the honest set",
      r.classification.tierReason === "primary" || r.classification.tierReason === "default" || r.classification.tierReason === "backstop",
      String(r.classification.tierReason),
    );
    checkTrue(label + ": replySource stamped", typeof r.classification.replySource === "string" || r.classification.replySource === null);
    checkTrue(label + ": emergencyKey stamped", typeof r.classification.emergencyKey === "string" || r.classification.emergencyKey === null);
  }
  const emergency = await run("I smell gas in the house");
  check("gas odor: emergency key", emergency.classification.emergencyKey, "gas_odor");
  check("gas odor: severity critical", emergency.classification.emergencySeverity, "critical");
  checkTrue("gas odor: safetyConcern true", emergency.classification.safetyConcern === true);
  checkTrue("gas odor: reply is the KB script, not advice", emergency.reply ? emergency.reply.source === "kb_emergency_script" : false);
  checkTrue("gas odor: afterHoursEscalation is a boolean", typeof emergency.classification.afterHoursEscalation === "boolean");
  checkTrue(
    "stamps are jsonb-safe (no undefined leakage)",
    JSON.stringify(emergency.classification).indexOf("undefined") === -1,
    JSON.stringify(emergency.classification).slice(0, 200),
  );
}

// --- 6. Reply production (KB FAQ / advice intent / none) ---------------------------
{
  const pricing = await run("how much does a water heater replacement cost?");
  check("pricing question: KB FAQ policy reply", pricing.reply && pricing.reply.source, "kb_faq_pricing");
  checkTrue(
    "pricing reply is the FAQ defaultAnswer verbatim (quote after diagnosis)",
    pricing.reply != null && pricing.reply.text === FAQ_ENTRIES.find((f) => f.id === "pricing")?.defaultAnswer,
  );
  checkTrue("pricing reply never contains a dollar figure", pricing.reply ? !/\$\s?\d/.test(pricing.reply.text) : true);

  const rulesAdvice = await run("should I try to rewire the thermostat on my water heater myself?");
  checkTrue("rules tier + advice intent: honest human routing", rulesAdvice.reply ? rulesAdvice.reply.source === "human_routing" : false, JSON.stringify(rulesAdvice.reply));

  const plain = await run("hi");
  check("greeting: no reply", plain.reply, null);
  check("greeting: category other", plain.classification.category, "other");

  const booking = await run("can someone come out tuesday for a slow drain");
  checkTrue(
    "booking request: answered with the KB scheduling policy (keyless-consistent)",
    booking.reply != null && booking.reply.source === "kb_faq_scheduling",
    JSON.stringify(booking.reply),
  );
}

// --- 7. Prompt assembly -----------------------------------------------------------
{
  const p = buildClassifierSystemPrompt();
  checkTrue("prompt embeds the KB guardrail policy", p.startsWith("SAFETY POLICY (plumbing assistant)"));
  checkTrue("prompt embeds the service catalog", p.includes("SERVICE CATALOG") && p.includes("drain-cleaning"));
  checkTrue("prompt carries the STRICT JSON contract", p.includes('"reply": string|null'));
  checkTrue("prompt forbids sight-unseen pricing", p.includes("after diagnosis"));
  checkTrue("prompt lists the deny categories", p.includes("gas_diy") && p.includes("electrical_diy"));
  checkTrue("prompt is deterministic", buildClassifierSystemPrompt() === p);
  const ctx = buildServiceCatalogContext();
  checkTrue("catalog context lists every service", ctx.split("\n").length === 18, String(ctx.split("\n").length));
  checkTrue("catalog context is deterministic", buildServiceCatalogContext() === ctx);

  checkTrue("matchFaqEntry: pricing", matchFaqEntry("what is the price for a repipe")?.id === "pricing");
  checkTrue("matchFaqEntry: none", matchFaqEntry("my pipe burst") === null);
}

// --- 8. Honest degradation sweep (the launch default) ------------------------------
{
  const corpus = [
    "pipe burst", "flooded basement", "gas smell", "no water at all", "sewer smell",
    "no hot water", "clogged drain", "how much for a repipe?", "hi", "thanks", "", "asdf",
  ];
  for (const body of corpus) {
    const r = await run(body, { hours: null });
    checkTrue(
      "keyless sweep [" + (body || "(empty)") + "]: classified + stamped + never raw-LLM",
      r.tier === "rules" &&
        r.tierReason === "default" &&
        r.classification.kbVersion === KB_VERSION &&
        (r.reply === null || r.reply.source !== "llm_screened"),
      JSON.stringify({ tier: r.tier, source: r.reply?.source }),
    );
  }
}

console.log(
  failures === 0
    ? "\nALL " + count + " TESTS PASSED"
    : "\n" + failures + " of " + count + " TEST(S) FAILED",
);
process.exit(failures === 0 ? 0 : 1);
