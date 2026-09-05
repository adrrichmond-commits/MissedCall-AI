#!/usr/bin/env bun
/**
 * Unit-style tests for the plumbing knowledge base + safety guardrails (P3-A).
 * Run: bun scripts/test-kb.ts — no DB, no env, no network, no keys.
 *
 * Covers: manifest/version stamps, service-catalog integrity (unique slugs,
 * value ranges, question counts), alias resolution (realistic phrasings and
 * typos), emergency resolution (all classes, realistic phrasings, typos,
 * severity ordering), guardrail screening (allow-list pass, deny-list block,
 * ambiguous→escalate, advice-intent detection), the LLM policy prompt, FAQ
 * pattern coverage, and the version stamp on every result.
 */
import {
  KB_VERSION,
  SERVICES,
  EMERGENCIES,
  FAQ_ENTRIES,
  ALLOW_RULES,
  DENY_RULES,
  resolveServiceByAlias,
  resolveServiceBySlug,
  listServices,
  resolveEmergency,
  screenAdviceText,
  screenAdviceRequest,
  buildSystemPrompt,
  getKbManifest,
} from "../src/lib/server/kb/index";

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

// --- Manifest + version stamps ------------------------------------------------
{
  const m = getKbManifest();
  check("manifest kbVersion", m.kbVersion, "kb-v1");
  checkTrue("manifest: services 12-18", m.services >= 12 && m.services <= 18, String(m.services));
  checkTrue("manifest: emergencies >= 6", m.emergencies >= 6, String(m.emergencies));
  checkTrue("manifest: allowRules >= 5", m.allowRules >= 5, String(m.allowRules));
  checkTrue("manifest: denyRules >= 5", m.denyRules >= 5, String(m.denyRules));
  checkTrue("manifest: faqEntries >= 4", m.faqEntries >= 4, String(m.faqEntries));
  checkTrue("manifest deterministic", JSON.stringify(getKbManifest()) === JSON.stringify(m));
}

// --- Service catalog integrity -------------------------------------------------
{
  const slugs = SERVICES.map((s) => s.slug);
  checkTrue(
    "catalog: slugs unique",
    new Set(slugs).size === slugs.length,
    slugs.join(","),
  );
  checkTrue(
    "catalog: slugs kebab-case",
    slugs.every((s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)),
    slugs.join(","),
  );
  checkTrue(
    "catalog: every entry has 2-4 qualifying questions",
    SERVICES.every((s) => s.qualifyingQuestions.length >= 2 && s.qualifyingQuestions.length <= 4),
  );
  checkTrue(
    "catalog: every entry has >= 1 safety note",
    SERVICES.every((s) => s.safetyNotes.length >= 1),
  );
  checkTrue(
    "catalog: value ranges sane (0 < low <= high, USD)",
    SERVICES.every((s) => s.typicalValue.currency === "USD" && s.typicalValue.low > 0 && s.typicalValue.low <= s.typicalValue.high),
  );
  checkTrue(
    "catalog: defaultUrgency in vocabulary",
    SERVICES.every((s) => ["emergency", "same_day", "within_week", "flexible"].includes(s.defaultUrgency)),
  );
  checkTrue(
    "catalog: every entry has >= 2 aliases",
    SERVICES.every((s) => s.aliases.length >= 2),
  );
  checkTrue("catalog: listServices matches SERVICES", listServices() === SERVICES);

  // Cover the required service families from the brief.
  const required = ["drain", "water-heater", "leak", "sewer", "toilet", "fixture", "gas", "sump", "disposal", "repip"];
  const missing = required.filter((frag) => !slugs.some((slug) => slug.includes(frag)));
  checkTrue("catalog: required service families covered", missing.length === 0, missing.join(","));
}

// --- Alias resolution: realistic phrasings -------------------------------------
{
  const cases: Array<[string, string]> = [
    ["my kitchen sink is clogged again", "drain-cleaning"],
    ["shower drain backed up", "drain-cleaning"],
    ["drain is stopped up", "drain-cleaning"],
    ["sewer line backed up into the basement", "sewer-main"],
    ["main line is blocked", "sewer-main"],
    ["gurgling sound from every drain", "sewer-main"],
    ["need hydro jetting for grease", "hydro-jetting"],
    ["water bill spiked and I hear hissing", "leak-detection"],
    ["there is a wet spot on my ceiling that keeps growing", "leak-detection"],
    ["pinhole leak in copper pipe", "pipe-repair"],
    ["pipe burst under the sink", "pipe-repair"],
    ["thinking about whole house repipe", "repiping"],
    ["we have galvanized pipes, should we replace", "repiping"],
    ["no hot water at all", "water-heater-repair"],
    ["water heater pilot went out", "water-heater-repair"],
    ["my toilet keeps running", "toilet-repair"],
    ["toilet is rocking at the base", "toilet-repair"],
    ["kitchen faucet is dripping", "fixture-repair"],
    ["need a new shower head installed", "fixture-repair"],
    ["garbage disposal hums but wont spin", "garbage-disposal"],
    ["sump pump not running and it is raining", "sump-pump"],
    ["need a gas line run for a new stove", "gas-line-work"],
    ["hook up a gas dryer", "gas-line-work"],
    ["water tastes like sulfur, hard water stains", "water-quality"],
    ["need a water softener installed", "water-quality"],
    ["water pressure way too high", "shut-off-valve-service"],
    ["main valve wont close", "shut-off-valve-service"],
    ["warm spot on the floor, water bill doubled", "slab-leak"],
    ["water pooling in the yard near the meter", "outdoor-yard-line"],
    ["hot water takes forever to arrive", "recirculation-pump"],
  ];
  const bad = cases.filter(([text, slug]) => {
    const m = resolveServiceByAlias(text);
    return !m || m.entry.slug !== slug;
  });
  checkTrue(
    "alias resolution: " + cases.length + " realistic phrasings",
    bad.length === 0,
    bad.map(([t, s]) => '"' + t + '"→' + (resolveServiceByAlias(t)?.entry.slug ?? "null") + " (wanted " + s + ")").join(" | "),
  );
}

// --- Alias resolution: typos + version stamps ----------------------------------
{
  const typoCases: Array<[string, string]> = [
    ["cloged kitchen drain", "drain-cleaning"],
    ["toilit wont stop running", "toilet-repair"],
    ["faucet is driping", "fixture-repair"],
    ["water heatter is leaking", "water-heater-repair"],
    ["disposul is jammed", "garbage-disposal"],
    ["sump pupm died", "sump-pump"],
    ["garbage disposal wont run", "garbage-disposal"],
    ["spigot leaks at the hose bib", "fixture-repair"],
    ["sewer backed up", "sewer-main"],
  ];
  const bad = typoCases.filter(([text, slug]) => {
    const m = resolveServiceByAlias(text);
    return !m || m.entry.slug !== slug;
  });
  checkTrue(
    "alias resolution: typo tolerance",
    bad.length === 0,
    bad.map(([t]) => '"' + t + '"→' + (resolveServiceByAlias(t)?.entry.slug ?? "null")).join(" | "),
  );

  const m = resolveServiceByAlias("clogged drain");
  checkTrue("alias match stamps kbVersion", m !== null && m.kbVersion === KB_VERSION);
  checkTrue("alias match reports matchedAliases >= 1", m !== null && m.matchedAliases >= 1);
  check("resolveServiceByAlias empty string", resolveServiceByAlias(""), null);
  check("resolveServiceByAlias gibberish", resolveServiceByAlias("hello there friends"), null);
}

// --- Slug lookup ----------------------------------------------------------------
{
  const first = SERVICES[0];
  checkTrue("resolveServiceBySlug: known slug", resolveServiceBySlug(first.slug) === first);
  check("resolveServiceBySlug: unknown slug", resolveServiceBySlug("no-such-service"), null);
}

// --- Emergency resolution --------------------------------------------------------
{
  const cases: Array<[string, string]> = [
    ["I smell gas in my kitchen", "gas_odor"],
    ["smells like gas outside by the meter", "gas_odor"],
    ["my basement is flooding", "active_flooding"],
    ["water is everywhere and wont stop pouring", "active_flooding"],
    ["sewer is backed up into the tub", "sewage_backup"],
    ["sewage coming up in the shower", "sewage_backup"],
    ["pipe burst in the wall", "burst_pipe"],
    ["water heater is leaking heavily", "water_heater_leaking"],
    ["we have no water at the whole house", "whole_house_no_water"],
  ];
  const bad = cases.filter(([text, key]) => {
    const r = resolveEmergency(text);
    return !r || r.entry.key !== key;
  });
  checkTrue(
    "emergency resolution: " + cases.length + " realistic phrasings",
    bad.length === 0,
    bad.map(([t, k]) => '"' + t + '"→' + (resolveEmergency(t)?.entry.key ?? "null") + " (wanted " + k + ")").join(" | "),
  );

  const typos: Array<[string, string]> = [
    ["basement is floodig", "active_flooding"],
    ["sewer is backed up", "sewage_backup"],
    ["smel gas in the house", "gas_odor"],
    ["water heatter leaking", "water_heater_leaking"],
  ];
  const badTypo = typos.filter(([text, key]) => {
    const r = resolveEmergency(text);
    return !r || r.entry.key !== key;
  });
  checkTrue(
    "emergency resolution: typo tolerance",
    badTypo.length === 0,
    badTypo.map(([t]) => '"' + t + '"→' + (resolveEmergency(t)?.entry.key ?? "null")).join(" | "),
  );

  // Non-emergencies must not trigger the taxonomy (false-positive control).
  const nonEmergencies = [
    "my kitchen faucet is dripping",
    "how much to install a new toilet",
    "slow drain in the bathroom sink",
    "looking to replace my water heater next month",
    "hi I have a question about your service area",
  ];
  const fp = nonEmergencies.filter((t) => resolveEmergency(t) !== null);
  checkTrue(
    "emergency resolution: no false positives on routine texts",
    fp.length === 0,
    fp.join(" | "),
  );

  // Severity ordering: a gas+flooding text resolves to the critical gas entry.
  const mix = resolveEmergency("gas smell and the basement is flooding");
  checkTrue("emergency resolution: critical wins on multi-hazard text", mix !== null && mix.entry.key === "gas_odor");

  // Every emergency class is reachable and well-formed.
  checkTrue(
    "emergency taxonomy: every class has >= 3 script steps",
    EMERGENCIES.every((e) => e.customerScript.length >= 3),
  );
  checkTrue(
    "emergency taxonomy: script steps are complete sentences",
    EMERGENCIES.every((e) => e.customerScript.every((s) => /[.!?]$/.test(s.trim()))),
  );
  checkTrue(
    "emergency taxonomy: critical classes escalate after hours",
    EMERGENCIES.filter((e) => e.severity === "critical").every((e) => e.afterHoursEscalation),
  );
  checkTrue(
    "emergency taxonomy: every class has >= 1 safety note",
    EMERGENCIES.every((e) => e.safetyNotes.length >= 1),
  );

  const em = resolveEmergency("gas smell");
  checkTrue("emergency match stamps kbVersion", em !== null && em.kbVersion === KB_VERSION);
  check("emergency: null on no match", resolveEmergency("my fence is broken"), null);
}

// --- Guardrails: allow-list -------------------------------------------------------
{
  const allowed: Array<[string, string]> = [
    ["shut off the main water valve", "water_shutoff_location"],
    ["turn off the water at the street side shut off valve", "water_shutoff_location"],
    ["put down towels and use a bucket to contain the water", "contain_water"],
    ["move your rugs and valuables out of the area", "contain_water"],
    ["keep pets away from the work area", "clear_and_access"],
    ["clear a path to the water heater", "clear_and_access"],
    ["stay away from electrical panels that got wet", "electrical_cautions"],
    ["do not touch the outlets near the water", "electrical_cautions"],
    ["close the valve behind the toilet", "fixture_shutoff"],
    ["call the gas utility from outside", "utility_and_emergency_calls"],
    ["call 811 before any digging", "utility_and_emergency_calls"],
    ["replace the flapper in the tank", "fixture_level_maintenance"],
    ["rinse the aerator on the faucet", "fixture_level_maintenance"],
  ];
  const bad = allowed.filter(([text]) => {
    const r = screenAdviceText(text);
    return r.decision !== "allow";
  });
  checkTrue(
    "guardrails allow: " + allowed.length + " safe-advice cases",
    bad.length === 0,
    bad.map(([t]) => '"' + t + '"→' + screenAdviceText(t).decision + " (" + screenAdviceText(t).reason + ")").join(" | "),
  );

  const r = screenAdviceText("shut off the main water valve");
  checkTrue("allow result stamps kbVersion", r.kbVersion === KB_VERSION);
  checkTrue("allow result lists matched rule", r.matchedAllow.length === 1 && r.matchedAllow[0] === "water_shutoff_location");
  checkTrue("allow result does not escalate", r.escalateToHuman === false);
}

// --- Guardrails: deny-list --------------------------------------------------------
{
  const denied: Array<[string, string]> = [
    ["shut off the gas at the meter and relight the pilot", "gas_diy"],
    ["how do I tighten the gas line connection", "gas_diy"],
    ["reset the breaker and check the wiring", "electrical_diy"],
    ["flip the breaker to cut power to the heater", "electrical_diy"],
    ["crawl under the house into the crawlspace with a flashlight", "confined_space"],
    ["go into the sewer to clear the blockage", "confined_space"],
    ["pour drano down the main drain", "chemical_misuse"],
    ["use a drain cleaner with sulfuric acid", "chemical_misuse"],
    ["cut into the drywall to get at the pipe", "structure_and_digging"],
    ["dig a trench to expose the yard line", "structure_and_digging"],
    ["open the T&P relief valve on the heater", "pressure_vessel_and_heater_interior"],
    ["drain the water heater tank yourself", "pressure_vessel_and_heater_interior"],
    ["remove the heating element access panel", "pressure_vessel_and_heater_interior"],
  ];
  const bad = denied.filter(([text]) => {
    const r = screenAdviceText(text);
    return r.decision !== "block";
  });
  checkTrue(
    "guardrails deny: " + denied.length + " unsafe-advice cases",
    bad.length === 0,
    bad.map(([t]) => '"' + t + '"→' + screenAdviceText(t).decision + " (" + screenAdviceText(t).reason + ")").join(" | "),
  );

  // Deny beats allow when both lists hit.
  const mixed = screenAdviceText("shut off the main water valve and then flip the breaker");
  check("deny overrides allow", mixed.decision, "block");
  checkTrue("deny+allow mix lists both sides", mixed.matchedDeny.length > 0 && mixed.matchedAllow.length > 0);
}

// --- Guardrails: ambiguity fails toward safety -------------------------------------
{
  const ambiguous = [
    "try heating the pipe with a torch to thaw it",
    "use a coat hanger to fish out the clog",
    "wrap the pipe in tape and hope for the best",
    "add more water pressure to push the clog through",
  ];
  const bad = ambiguous.filter((t) => {
    const r = screenAdviceText(t);
    return r.decision !== "escalate" || r.escalateToHuman !== true;
  });
  checkTrue(
    "guardrails ambiguous: unknown advice escalates to human",
    bad.length === 0,
    bad.map((t) => '"' + t + '"→' + screenAdviceText(t).decision).join(" | "),
  );

  // The documented fail-toward-safety invariants.
  const sweep = [...ambiguous, "shut off the valve", "pour drano", "hello", ""];
  checkTrue(
    "guardrails: escalateToHuman true for every non-allow decision",
    sweep.every((t) => screenAdviceText(t).escalateToHuman === (screenAdviceText(t).decision !== "allow")),
  );
}

// --- Guardrails: advice-request detection -------------------------------------------
{
  check("screenAdviceRequest: booking text is not_advice", screenAdviceRequest("can you send someone out tomorrow").decision, "not_advice");
  check("screenAdviceRequest: pricing text is not_advice", screenAdviceRequest("how much for a new water heater").decision, "not_advice");
  check("screenAdviceRequest: bare question mark asks for help", screenAdviceRequest("what should I do about the leak?").decision, "escalate");
  checkTrue(
    "screenAdviceRequest: deny still blocks inside an advice request",
    screenAdviceRequest("should I pour drano down the kitchen drain?").decision === "block",
  );
}

// --- LLM policy prompt ----------------------------------------------------------------
{
  const prompt = buildSystemPrompt();
  checkTrue("prompt: mentions emergency-first rule", prompt.includes("emergency") && prompt.includes("FIRST"));
  checkTrue("prompt: lists every allow rule key", ALLOW_RULES.every((r) => prompt.includes(r.key)));
  checkTrue("prompt: lists every deny rule key", DENY_RULES.every((r) => prompt.includes(r.key)));
  checkTrue("prompt: deterministic", buildSystemPrompt() === prompt);
  checkTrue("prompt: long enough to be a real policy", prompt.length > 800, String(prompt.length));
}

// --- FAQ defaults ----------------------------------------------------------------------
{
  checkTrue("faq: at least 4 default entries", FAQ_ENTRIES.length >= 4);
  const ids = FAQ_ENTRIES.map((f) => f.id);
  checkTrue("faq: ids unique", new Set(ids).size === ids.length);
  checkTrue(
    "faq: pricing defers to quote-after-diagnosis",
    FAQ_ENTRIES.find((f) => f.id === "pricing")?.defaultAnswer.includes("after diagnosis") === true,
  );
  checkTrue(
    "faq: service-area entry asks for the address",
    FAQ_ENTRIES.find((f) => f.id === "service-area")?.defaultAnswer.includes("address") === true,
  );
  const hits = FAQ_ENTRIES.map((f) => f.patterns.some((re) => re.test("how much does this cost")) && f.id === "pricing");
  checkTrue("faq: pricing pattern catches 'how much does this cost'", hits.some(Boolean));

  const coverage: Array<[string, string]> = [
    ["what is the price for a drain cleaning", "pricing"],
    ["are you available tomorrow morning", "scheduling"],
    ["do you serve my area", "service-area"],
    ["do you guarantee your work", "warranty"],
  ];
  const badCov = coverage.filter(([text, id]) => {
    const entry = FAQ_ENTRIES.find((f) => f.id === id);
    return !entry || !entry.patterns.some((re) => re.test(text));
  });
  checkTrue("faq: each entry catches a realistic question", badCov.length === 0, badCov.map(([t]) => t).join(" | "));
}

// --- Pure-module sweep: no I/O, no env dependency ---------------------------------------
{
  // Version stamp consistency across every exported data table.
  checkTrue("version: KB_VERSION is kb-v1", KB_VERSION === "kb-v1");
  checkTrue(
    "version: stamped consistently",
    resolveServiceByAlias("clogged drain")?.kbVersion === resolveEmergency("flooding")?.kbVersion,
  );

  // Regexes are non-global (stateless .test) across all KB tables.
  const allRe = [
    ...SERVICES.flatMap((s) => [...s.aliases]),
    ...EMERGENCIES.flatMap((e) => [...e.patterns]),
    ...FAQ_ENTRIES.flatMap((f) => [...f.patterns]),
    ...ALLOW_RULES.flatMap((r) => [...r.patterns]),
    ...DENY_RULES.flatMap((r) => [...r.patterns]),
  ];
  const sample = "shut off the main valve because the drain is clogged";
  const firstPass = allRe.map((re) => re.test(sample));
  const secondPass = allRe.map((re) => re.test(sample));
  checkTrue("regexes: stateless across repeated .test calls", JSON.stringify(firstPass) === JSON.stringify(secondPass));
}

console.log(
  failures === 0
    ? "\nALL " + count + " TESTS PASSED"
    : "\n" + failures + " of " + count + " TEST(S) FAILED",
);
process.exit(failures === 0 ? 0 : 1);
