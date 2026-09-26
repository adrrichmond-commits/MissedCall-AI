#!/usr/bin/env bun
/**
 * AI tuning pass 2 — the 5 plumbing-emergency edge phrases reported-but-unfixed
 * in P5-3 (tracked in the Phase 5 plan as "AI tuning pass 2"), plus the
 * over-trigger guards that keep the pass honest.
 *
 * Run: bun scripts/test-ai-tuning-pass2.ts — no DB, no env, no network, no keys
 * (same pure-function pattern as scripts/test-classify.ts; the engine under
 * test is classifyInboundText in src/lib/server/classify.ts).
 *
 * The 5 edge cases, all previously under-classified by the rule tables:
 *   1. Sewer backup verb-order inversion — "a backup in the sewer" landed in
 *      "other" (the P5-3-era rule only matched noun-before-verb order).
 *   2. Sump pump + rising water — no emergency evidence pair existed.
 *   3. "wont stop filling" — the unstoppable-fill pre-overflow state had no
 *      rule at all (the running-toilet urgent rule only names "running").
 *   4. Disposal smoking — appliance fire/electrical language was unmatched.
 *   5. Ceiling leak severity — active overhead water was urgent-only; only
 *      contained stains belonged there.
 *
 * GUARDS (the point of pass 2's negative battery): a clogged drain without
 * flooding, a slow faucet drip, a contained ceiling stain, a sump-pump quote,
 * a smoke-detector mention, or "filling out the form" must NOT become an
 * emergency. Pre-existing urgent pins that sit right next to the widened
 * rules are re-checked here so a future widening cannot silently flip them.
 */
import { classifyInboundText } from "../src/lib/server/classify";
import type { RuleClassification } from "../src/lib/server/classify";

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

function classify(body: string): RuleClassification {
  return classifyInboundText(body);
}

// ===========================================================================
// 1. Sewer backup verb-order inversion (emergency + safetyConcern)
// ===========================================================================
{
  const r = classify("there is a backup in the sewer");
  check("sewer inversion: 'a backup in the sewer' → emergency", r.category, "emergency");
  checkTrue("sewer inversion: 'a backup in the sewer' flags safetyConcern", r.safetyConcern === true);
  checkTrue(
    "sewer inversion: matched the sewage_backup rule",
    r.matchedRules.includes("sewage_backup"),
    String(r.matchedRules),
  );
  check(
    "sewer inversion: apostrophe form 'there's a backup in the sewer' → emergency",
    classify("there's a backup in the sewer").category,
    "emergency",
  );
  check(
    "sewer inversion: 'backed up from the septic tank' → emergency",
    classify("water backed up from the septic tank").category,
    "emergency",
  );
  check(
    "sewer inversion: 'backup coming up in the sewer line' → emergency",
    classify("backup coming up in the sewer line").category,
    "emergency",
  );
  checkTrue(
    "sewer inversion: emergency confidence within [0.85, 0.95]",
    (() => {
      const c = classify("there is a backup in the sewer").confidence;
      return c >= 0.85 && c <= 0.95;
    })(),
  );
}

// ===========================================================================
// 2. Sump pump + rising water (emergency + safetyConcern)
// ===========================================================================
{
  const r = classify("the sump pump cant keep up and water is rising in the basement");
  check("sump: pump failing + rising water → emergency", r.category, "emergency");
  checkTrue("sump: pump failing + rising water flags safetyConcern", r.safetyConcern === true);
  checkTrue(
    "sump: matched the sump_pump_failing rule",
    r.matchedRules.includes("sump_pump_failing"),
    String(r.matchedRules),
  );
  check("rising water: 'rising water in my basement' → emergency", classify("rising water in my basement").category, "emergency");
  check(
    "rising water: 'water keeps rising in the crawl space' → emergency",
    classify("water keeps rising in the crawl space").category,
    "emergency",
  );
  check(
    "sump: flooded basement + pump overwhelmed → emergency",
    classify("my basement is flooded and the sump pump is overwhelmed").category,
    "emergency",
  );
}

// ===========================================================================
// 3. "wont stop filling" — appliance/toilet overflow phrasing
// ===========================================================================
{
  const r = classify("my toilet wont stop filling");
  check("filling: toilet wont stop filling → emergency", r.category, "emergency");
  checkTrue("filling: toilet wont stop filling flags safetyConcern", r.safetyConcern === true);
  checkTrue(
    "filling: matched the wont_stop_filling rule",
    r.matchedRules.includes("wont_stop_filling"),
    String(r.matchedRules),
  );
  check(
    "filling: 'the tank keeps filling up' → emergency",
    classify("the tank keeps filling up and is about to spill").category,
    "emergency",
  );
  check("filling: 'dishwasher wont stop filling' → emergency", classify("dishwasher wont stop filling").category, "emergency");
  check("filling: 'tub is overfilling' → emergency", classify("the tub is overfilling").category, "emergency");
}

// ===========================================================================
// 4. Disposal smoking → safetyConcern
// ===========================================================================
{
  const r = classify("my garbage disposal is smoking");
  check("smoking: garbage disposal smoking → emergency", r.category, "emergency");
  checkTrue("smoking: disposal smoking flags safetyConcern", r.safetyConcern === true);
  checkTrue(
    "smoking: matched the appliance_smoking rule",
    r.matchedRules.includes("appliance_smoking"),
    String(r.matchedRules),
  );
  check("smoking: 'the water heater is sparking' → emergency", classify("the water heater is sparking").category, "emergency");
  check("smoking: 'washing machine smells like its burning' → emergency", classify("washing machine smells like its burning").category, "emergency");
}

// ===========================================================================
// 5. Ceiling leak severity — active overhead water is emergency
// ===========================================================================
{
  const r = classify("water is dripping from my ceiling");
  check("ceiling: water dripping from ceiling → emergency", r.category, "emergency");
  checkTrue("ceiling: dripping ceiling flags safetyConcern", r.safetyConcern === true);
  checkTrue(
    "ceiling: matched the ceiling_water_active rule",
    r.matchedRules.includes("ceiling_water_active"),
    String(r.matchedRules),
  );
  check("ceiling: 'the ceiling is leaking' → emergency (was urgent-only before pass 2)", classify("the ceiling is leaking").category, "emergency");
  check("ceiling: 'ceiling about to cave in' → emergency", classify("the ceiling looks like its about to cave in").category, "emergency");
  check("ceiling: 'water coming through the roof' → emergency", classify("water is coming through the roof").category, "emergency");
}

// ===========================================================================
// 6. OVER-TRIGGER GUARDS — widened rules must not eat urgent/routine cases
// ===========================================================================
// Clogged-drain-without-flooding and slow-drip stay out of the emergency
// bucket (the task's explicit guard), and the pre-existing pins that sit
// right next to each widened rule keep their old tiers.
{
  // Sewer-inversion guards: blockage/clog language and main-line stay urgent.
  check("guard: sewer line blockage stays urgent", classify("there is a sewer line blockage").category, "urgent");
  check("guard: main drain backed up stays urgent", classify("main drain backed up this morning").category, "urgent");
  check("guard: 'backup in the main line' stays urgent (main line excluded from the emergency noun set)", classify("there is a backup in the main line").category, "urgent");
  check("guard: kitchen sink backed up stays urgent", classify("kitchen sink backed up").category, "urgent");

  // Clog / drip guards (the explicit no-over-trigger cases).
  check("guard: clogged sink (no flooding) stays urgent", classify("kitchen sink is clogged").category, "urgent");
  check("guard: clogged drain stays urgent", classify("clogged drain in the bathroom").category, "urgent");
  check("guard: slow drain stays routine", classify("slow drain in the bathroom sink").category, "routine");
  check("guard: slow-dripping faucet stays routine", classify("my kitchen faucet drips constantly").category, "routine");
  check("guard: water under the sink dripping slowly stays routine", classify("there is water under my sink, just drips slowly").category, "routine");
  checkTrue("guard: faucet drip does not flag safetyConcern", classify("my kitchen faucet drips constantly").safetyConcern === null);

  // Ceiling guards: contained/historical evidence stays urgent.
  check("guard: brown ceiling spot stays urgent", classify("brown spot on my ceiling").category, "urgent");
  check("guard: water stain on the ceiling stays urgent", classify("water stain on the ceiling").category, "urgent");

  // Sump guards: the sump noun without water evidence is not an emergency.
  check("guard: sump pump install quote stays routine", classify("looking for a quote on a sump pump install").category, "routine");
  check("guard: sump pump maintenance stays routine", classify("calling about annual sump pump maintenance").category, "routine");

  // Filling guards: form-filling / figurative filling never matches.
  checkTrue("guard: 'filling out the form' is not an emergency", classify("im filling out the form on your website").category !== "emergency");
  checkTrue("guard: 'filling me in' is not an emergency", classify("thanks for filling me in").category !== "emergency");
  check("guard: running toilet (no filling) stays urgent", classify("the toilet keeps running").category, "urgent");

  // Smoking guards: hazard word without an appliance noun must not fire.
  checkTrue("guard: smoke detector report is not an emergency", classify("the smoke detector went off in the hallway").category !== "emergency");
  checkTrue("guard: 'burning question' is not an emergency", classify("i have a burning question about my quote").category !== "emergency");

  // Rising-water guards: bill/price language does not match the short-verb filler.
  checkTrue("guard: 'water bill is rising' is not an emergency", classify("my water bill is rising").category !== "emergency");
}

console.log(
  failures === 0
    ? `AI TUNING PASS 2 — ${count} checks, 0 failures`
    : `AI TUNING PASS 2 FAIL — ${failures} of ${count} checks failed`,
);
process.exit(failures === 0 ? 0 : 1);
