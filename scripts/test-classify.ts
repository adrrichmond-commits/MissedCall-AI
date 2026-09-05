#!/usr/bin/env bun
/**
 * Unit-style tests for the rule-based SMS classifier (Phase 2 build #7).
 * Run: bun scripts/test-classify.ts — no DB, no env, no network, no keys.
 *
 * Covers: every rule category with multiple realistic phrasings (incl.
 * customer typos and casual text), STOP/START/HELP exclusion, time-hint
 * extraction, intent extraction, confidence bounds, classifier field
 * presence, and the "other" fallback. The module under test is a pure
 * function — no I/O anywhere.
 */
import { classifyInboundText, RULES_CLASSIFIER_VERSION } from "../src/lib/server/classify";
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

// --- Result shape: classifier field + version stamp on every result ----------
{
  const samples = [
    "pipe burst in my kitchen",
    "no hot water",
    "how much for a water heater install?",
    "hi",
    "asdf jkl",
    "STOP",
    null,
    "",
  ];
  const allShaped = samples.every((s) => {
    const r = classifyInboundText(s);
    return (
      r.classifier === "rules" &&
      r.model === RULES_CLASSIFIER_VERSION &&
      typeof r.confidence === "number" &&
      r.confidence >= 0 &&
      r.confidence <= 1 &&
      Number.isFinite(r.confidence) &&
      Array.isArray(r.matchedRules) &&
      typeof r.category === "string"
    );
  });
  checkTrue("every result carries classifier='rules', model stamp, finite confidence in [0,1], matchedRules array", allShaped);
}
check("model stamp value", RULES_CLASSIFIER_VERSION, "rules-v1");
checkTrue(
  "notes always prefixed with the rules version (auditable in jsonb)",
  ["pipe burst", "hi", ""].every((s) => classify(s).notes!.startsWith("rules-v1")),
);

// --- EMERGENCY: burst pipe -----------------------------------------------------
{
  const r = classify("my pipe burst in the kitchen this morning");
  check("burst pipe → category emergency", r.category, "emergency");
  check("burst pipe → urgency emergency", r.urgency, "emergency");
  check("burst pipe → priority emergency", r.priority, "emergency");
  checkTrue("burst pipe → safetyConcern true (uncontrolled water)", r.safetyConcern === true);
  checkTrue("burst pipe → serviceNeed mentions the pipe", (r.serviceNeed ?? "").includes("burst pipe"));
  check("burst pipe → matched rule key", r.matchedRules, ["burst_pipe"]);
  checkTrue("burst pipe → confidence >= 0.85", r.confidence >= 0.85, String(r.confidence));
}
check("busted pipe (casual) → emergency", classify("busted pipe under the house").category, "emergency");
check("pipe blew (casual) → emergency", classify("a pipe just blew in the laundry room").category, "emergency");

// --- EMERGENCY: flooding / water everywhere ------------------------------------
check("flooding → emergency", classify("my basement is flooding").category, "emergency");
check("flooded (past form) → emergency", classify("the whole first floor flooded").category, "emergency");
check("flooding typo 'floodig' → emergency", classify("floodig in my kitchen").category, "emergency");
checkTrue(
  "flooding marks safetyConcern",
  classify("basement is flooding").safetyConcern === true,
);
check("water everywhere → emergency", classify("there is water everywhere in my bathroom").category, "emergency");
check("water all over the floor → emergency", classify("water all over the floor help").category, "emergency");

// --- EMERGENCY: sewage / gas ----------------------------------------------------
check("sewage backing up → emergency", classify("sewage is backing up into my bathtub").category, "emergency");
check("sewer backed up → emergency", classify("the sewer backed up outside").category, "emergency");
check("gas smell → emergency", classify("i smell gas in the kitchen").category, "emergency");
checkTrue("gas smell → safetyConcern true", classify("i smell gas in the kitchen").safetyConcern === true);
check("gas odor → emergency", classify("there is a gas odor near the stove").category, "emergency");
check("gas leak → emergency", classify("possible gas leak at my shop").category, "emergency");

// --- EMERGENCY: no water / overflowing toilet -----------------------------------
check("no water → emergency", classify("we have no water at all since last night").category, "emergency");
check("water stopped coming → emergency", classify("water stopped coming out of any faucet").category, "emergency");
check("overflowing toilet → emergency", classify("my toilet is overflowing onto the floor").category, "emergency");
check("toilet overflowed (casual) → emergency", classify("toilet overflowed!!").category, "emergency");

// --- EMERGENCY: heavy water heater leak / uncontrolled flow / shutoff -----------
check("water heater leaking heavily → emergency", classify("water heater is leaking heavily").category, "emergency");
check("water heater pouring out → emergency", classify("the water heater is pouring out water").category, "emergency");
checkTrue(
  "water heater heavy leak → safetyConcern true",
  classify("water heater is leaking heavily").safetyConcern === true,
);
check("water gushing out → emergency", classify("water is gushing out of the wall").category, "emergency");
check("wont stop leaking → emergency", classify("it wont stop leaking under the sink").category, "emergency");
check("cant shut off water → emergency", classify("i cant shut off the water main").category, "emergency");
check("cant find main valve → emergency", classify("cant find the main valve and water is going everywhere").category, "emergency");
check("self-declared emergency → emergency", classify("this is an emergency please call me").category, "emergency");

// --- URGENT: no hot water --------------------------------------------------------
{
  const r = classify("no hot water since yesterday");
  check("no hot water → category urgent", r.category, "urgent");
  check("no hot water → urgency same_day", r.urgency, "same_day");
  check("no hot water → priority high", r.priority, "high");
  checkTrue("no hot water → NOT safetyConcern (null, not false-positive)", r.safetyConcern === null);
  checkTrue("no hot water → confidence >= 0.75", r.confidence >= 0.75, String(r.confidence));
  checkTrue("no hot water → confidence <= 0.88 cap", r.confidence <= 0.88, String(r.confidence));
}
check("hot water not working → urgent", classify("the hot water is not working again").category, "urgent");
check("cold water only (casual) → urgent", classify("only getting cold water in the shower").category, "urgent");
check("water heater stopped heating → urgent", classify("water heater stopped heating last night").category, "urgent");
check("no hot watter (typo) → urgent", classify("no hot watter at my house").category, "urgent");

// --- URGENT: main line / backups / clogs -----------------------------------------
check("main line clogged → urgent", classify("our main line is clogged").category, "urgent");
check("main drain backed up → urgent", classify("main drain backed up this morning").category, "urgent");
check("sewer line blockage → urgent (not emergency)", classify("there is a sewer line blockage").category, "urgent");
check("kitchen sink backed up → urgent", classify("kitchen sink backed up").category, "urgent");
check("toilet backing up → urgent", classify("the toilet is backing up when flushed").category, "urgent");
check("clogged drain → urgent", classify("clogged drain in the bathroom").category, "urgent");
check("sink plugged (casual) → urgent", classify("the bathroom sink is totally plugged").category, "urgent");
check("drain blocked → urgent", classify("shower drain is blocked").category, "urgent");

// --- URGENT: leaks / running toilet / pressure ------------------------------------
check("leak under sink → urgent", classify("there is a leak under my sink").category, "urgent");
check("leaking (typo 'leakin') → urgent", classify("my faucet is leakin really bad").category, "urgent");
check("water heater leaking (no intensifier) → urgent, NOT emergency", classify("the water heater is leaking").category, "urgent");
check("brown ceiling spot → urgent", classify("brown spot on my ceiling").category, "urgent");
check("running toilet → urgent", classify("the toilet keeps running").category, "urgent");
check("toilet runs constantly → urgent", classify("toilet runs constantly after flushing").category, "urgent");
check("toilet wont flush → urgent", classify("the toilet wont flush").category, "urgent");
check("no water pressure → urgent", classify("we have no water pressure upstairs").category, "urgent");
check("water pressure gone → urgent", classify("water pressure is gone in the whole house").category, "urgent");
check("lost pressure → urgent", classify("we lost water pressure this morning").category, "urgent");

// --- ROUTINE: quotes / maintenance / slow drain / drips ---------------------------
{
  const r = classify("how much for a water heater install?");
  check("quote → category routine", r.category, "routine");
  check("quote → priority normal", r.priority, "normal");
  check("quote → urgency within_week (no flexible language)", r.urgency, "within_week");
  check("quote → intent quote", r.intent, "quote");
  checkTrue("quote → confidence >= 0.7", r.confidence >= 0.7, String(r.confidence));
  checkTrue("quote → confidence <= 0.85 cap", r.confidence <= 0.85, String(r.confidence));
}
check("estimate request → routine", classify("can i get an estimate for a repipe").category, "routine");
check("price question (casual) → routine", classify("just wondering about price on a new faucet").category, "routine");
checkTrue(
  "ballpark → routine + intent quote",
  (() => {
    const r = classify("whats your ballpark on drain work");
    return r.category === "routine" && r.intent === "quote";
  })(),
);
check("annual maintenance → routine", classify("calling about the annual maintenance on our tankless").category, "routine");
check("inspection/checkup → routine", classify("want to schedule a checkup for the water heater").category, "routine");
check("slow drain → routine", classify("slow drain in the bathroom sink").category, "routine");
check("drain is slow (casual) → routine", classify("the kitchen drain is really slow lately").category, "routine");
check("faucet drip → routine", classify("my kitchen faucet drips constantly").category, "routine");
checkTrue(
  "faucet drip → no false emergency/urgent (safetyConcern null)",
  classify("my kitchen faucet drips constantly").safetyConcern === null,
);
checkTrue(
  "routine repair → NOT safetyConcern (null)",
  classify("slow drain in the bathroom sink").safetyConcern === null,
);
check("flexible language downgrades routine urgency", classify("not urgent but id like an estimate on a repipe sometime").urgency, "flexible");
check("no-rush quote stays routine", classify("no rush, just want a price on a new faucet").category, "routine");

// --- UNSURE / OTHER: greetings, thanks, gibberish ----------------------------------
{
  const r = classify("hi");
  check("bare greeting → category other", r.category, "other");
  check("bare greeting → honest nulls (serviceNeed)", r.serviceNeed, null);
  check("bare greeting → null urgency", r.urgency, null);
  check("bare greeting → null priority", r.priority, null);
  checkTrue("bare greeting → chit-chat confidence 0.45", r.confidence === 0.45, String(r.confidence));
  check("bare greeting → no matched rules", r.matchedRules, []);
}
check("hey there → other", classify("hey there").category, "other");
check("thanks → other (chit-chat tier)", classify("thanks!").category, "other");
checkTrue("gibberish → other with low confidence 0.2", classify("asdf jkl qwerty").confidence === 0.2);
checkTrue("gibberish notes say no domain signals", classify("asdf jkl").notes!.includes("no domain signals"));
check("ok → other", classify("ok").category, "other");
check("'when are you open?' → other but intent question", classify("when are you open?").intent, "question");

// --- STOP/START/HELP are handled upstream — never re-handled, never classified ------
check("bare STOP → category other (command layer is upstream)", classify("STOP").category, "other");
check("bare STOP → no service need invented", classify("STOP").serviceNeed, null);
check("bare STOP → no matched rules", classify("STOP").matchedRules, []);
check("START → other, no invented parse", classify("START").category, "other");
check("HELP → other, no invented parse", classify("HELP").category, "other");
check("UNSUBSCRIBE → other", classify("UNSUBSCRIBE").category, "other");
// Layering doc: a sentence *containing* HELP is not a command upstream — if it
// ever reached the classifier it must still classify the real content.
check("domain content after 'help' still classifies (layering)", classify("help my sink is leaking").category, "urgent");

// --- Time-hint extraction -----------------------------------------------------------
check("time hint: asap", classify("my sink is backed up, need someone asap").preferredTimeHint, "asap");
check("time hint: today", classify("can someone come out today for a clogged drain").preferredTimeHint, "today");
check("time hint: tonight", classify("this is an emergency, water everywhere tonight").preferredTimeHint, "tonight");
check("time hint: tomorrow morning (beats tomorrow)", classify("available tomorrow morning for the quote").preferredTimeHint, "tomorrow morning");
check("time hint: later today (beats today)", classify("could you come later today").preferredTimeHint, "later today");
check("time hint: next week", classify("whenever next week works for the estimate").preferredTimeHint, "next week");
check("time hint: saturday", classify("can you do saturday for the install").preferredTimeHint, "saturday");
check("time hint: as soon as possible (full phrase)", classify("need a plumber as soon as possible").preferredTimeHint, "as soon as possible");
check("time hint: none → null", classify("how much do you charge for a faucet swap").preferredTimeHint, null);
checkTrue(
  "time hints survive on emergency results too",
  classify("pipe burst, need help asap").preferredTimeHint === "asap",
);

// --- Intent extraction ---------------------------------------------------------------
check("intent: book", classify("can you book someone to come out this week").intent, "book");
check("intent: appointment wording", classify("i need an appointment for a water heater swap").intent, "book");
check("intent: quote", classify("how much do you charge to install a faucet").intent, "quote");
check("intent: question", classify("do you service tankless water heaters?").intent, "question");
check("intent: none on a plain repair report", classify("my sink is leaking").intent, null);

// --- Email extraction ------------------------------------------------------------------
check("email extracted", classify("email me at john.doe@example.com for the quote").contactEmail, "john.doe@example.com");
checkTrue("no email → null", classify("my sink is leaking").contactEmail === null);

// --- Honest nulls: what rules can NOT extract ------------------------------------------
checkTrue("contactName always null (rules cannot extract names)", classify("this is Dave, my pipe burst").contactName === null);
checkTrue("serviceAddress always null (addresses need the LLM path)", classify("pipe burst at 42 Oak Street").serviceAddress === null);

// --- Confidence: ordering + multi-rule bump ---------------------------------------------
checkTrue(
  "emergency confidence > urgent confidence (ordering signal)",
  classify("pipe burst").confidence > classify("clogged drain").confidence,
);
checkTrue(
  "urgent confidence > routine confidence (ordering signal)",
  classify("clogged drain").confidence > classify("slow drain").confidence,
);
checkTrue(
  "routine confidence > chit-chat 'other' confidence",
  classify("slow drain").confidence > classify("hi").confidence,
);
checkTrue(
  "multiple matching rules raise confidence within a category",
  classify("pipe burst and water everywhere and the toilet is overflowing").confidence > classify("pipe burst").confidence,
  String(classify("pipe burst and water everywhere and the toilet is overflowing").confidence),
);
checkTrue(
  "confidence hard cap 0.95 even with many rules",
  classify("pipe burst and water everywhere and the toilet is overflowing").confidence <= 0.95,
);

// --- Edge cases: total function, never throws, never invents -----------------------------
check("null body → other", classifyInboundText(null).category, "other");
check("undefined body → other", classifyInboundText(undefined).category, "other");
check("empty body → other", classifyInboundText("").category, "other");
check("whitespace body → other", classifyInboundText("   ").category, "other");
check("emoji-only body → other (normalizes to empty)", classifyInboundText("🎉🚿").category, "other");
checkTrue("empty body → lowest confidence 0.1", classifyInboundText("").confidence === 0.1);
check("punctuation-only → other", classifyInboundText("!!!").category, "other");
checkTrue(
  "UPPERCASE text classifies (normalization)",
  classify("PIPE BURST IN THE KITCHEN").category === "emergency",
);
checkTrue(
  "apostrophes normalize (can't → cant) still hits shutoff rule",
  classify("I can't shut off the water").category === "emergency",
);
checkTrue(
  "mixed-case typo text classifies",
  classify("No HoT wAtEr at all").category === "urgent",
);

// --- Sweep: every classification in the file stays in bounds ------------------------------
{
  const corpus = [
    "pipe burst", "flooding", "gas smell", "no water", "overflowing toilet",
    "no hot water", "clogged drain", "leak under sink", "running toilet", "no water pressure",
    "quote please", "annual maintenance", "slow drain", "faucet drip",
    "hi", "thanks", "asdf", "STOP", "START", "HELP", "", null,
  ];
  const inBounds = corpus.every((b) => {
    const r = classifyInboundText(b);
    return r.confidence >= 0 && r.confidence <= 1 && r.classifier === "rules";
  });
  checkTrue("sweep: confidence within [0,1] and classifier stamped for the whole corpus", inBounds);
}

console.log(
  failures === 0
    ? "\nALL " + count + " TESTS PASSED"
    : "\n" + failures + " of " + count + " TEST(S) FAILED",
);
process.exit(failures === 0 ? 0 : 1);
