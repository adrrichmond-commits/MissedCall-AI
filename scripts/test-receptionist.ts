#!/usr/bin/env bun
/**
 * Unit tests for the P4-O receptionist studio pure module.
 * Run: bun scripts/test-receptionist.ts — no DB, no network, no keys.
 *
 * Covers: sanitize (tolerant read), validate (strict save rules + limits),
 * FAQ id generation / reorder / matching, greeting fallbacks (default parity
 * with twiml.DEFAULT_GREETING), the neverPromise confirm override, policy
 * notes for staff, and coerceFlowState (the simulation round-trip guard).
 */
import { DEFAULT_GREETING } from "../src/lib/voice/twiml";
import { PROMPTS } from "../src/lib/voice/callFlow";
import {
  RECEPTIONIST_LIMITS,
  FALLBACK_RECEPTIONIST_NAME,
  NEUTRAL_CONFIRM_PROMPT,
  confirmPromptOverride,
  coerceFlowState,
  matchFaq,
  policyNotesForLead,
  receptionistConfigFromSettings,
  sanitizeReceptionistConfig,
  validateReceptionistInput,
  type ReceptionistConfig,
} from "../src/lib/voice/receptionistConfig";

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
function checkDeep(name: string, actual: unknown, expected: unknown): void {
  const norm = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, val]) => [k, norm(val)]))
      : v;
  check(name, norm(actual), norm(expected));
}
function checkTrue(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  } else {
    console.log("ok   " + name);
  }
}

// ---------------------------------------------------------------------------
// 1. Sanitize (tolerant read) — garbage in, defaults out
// ---------------------------------------------------------------------------
{
  checkDeep("sanitize undefined → defaults", sanitizeReceptionistConfig(undefined), {
    name: "", greeting: "", emergencyHandling: "", neverPromise: "", escalationNotes: "",
    transferNumber: "", faqs: [], instructions: "",
  });
  check("sanitize garbage types", sanitizeReceptionistConfig({ name: 42, greeting: {}, faqs: "nope" }).name, "");
  checkTrue("sanitize clamps overlong name", sanitizeReceptionistConfig({ name: "x".repeat(500) }).name.length <= RECEPTIONIST_LIMITS.name);
  checkTrue("sanitize clamps overlong greeting", sanitizeReceptionistConfig({ greeting: "y".repeat(1000) }).greeting.length <= RECEPTIONIST_LIMITS.greeting);
  const trimmed = sanitizeReceptionistConfig({ name: "  Sally  " });
  check("sanitize trims", trimmed.name, "Sally");
  // FAQ entries: malformed/partial dropped, ids generated when absent.
  const s = sanitizeReceptionistConfig({
    faqs: [
      { question: "Q1?", answer: "A1." },
      { question: "only a question" },
      null,
      "garbage",
      { question: "Q2?", answer: "A2.", id: "custom-id" },
    ],
  });
  check("sanitize drops partial faqs", s.faqs.length, 2);
  check("sanitize keeps custom id", s.faqs[1].id, "custom-id");
  checkTrue("sanitize generates ids", s.faqs[0].id.startsWith("faq_"));
  checkTrue("sanitize caps faq count", sanitizeReceptionistConfig({ faqs: Array.from({ length: 30 }, () => ({ question: "q", answer: "a" })) }).faqs.length === RECEPTIONIST_LIMITS.maxFaqs);
  // From the settings blob: nested under `receptionist`.
  check("fromSettings nested key", receptionistConfigFromSettings({ receptionist: { name: "Ann" } }).name, "Ann");
  check("fromSettings absent", receptionistConfigFromSettings(undefined).name, "");
  check("fromSettings garbage blob", receptionistConfigFromSettings("junk").name, "");
}

// ---------------------------------------------------------------------------
// 2. Validate (strict save path)
// ---------------------------------------------------------------------------
{
  // Everything optional: an empty save is valid (all defaults).
  const empty = validateReceptionistInput({});
  check("validate empty ok", empty.ok, true);
  // Limit violations are reported per field.
  const over = validateReceptionistInput({ name: "x".repeat(RECEPTIONIST_LIMITS.name + 1), instructions: "y".repeat(RECEPTIONIST_LIMITS.instructions + 1) });
  checkTrue("validate overlong name fails", !over.ok && over.issues.some((i) => i.field === "name"));
  checkTrue("validate overlong instructions fails", !over.ok && over.issues.some((i) => i.field === "instructions"));
  // Transfer number must be dialable when present.
  checkTrue("validate bad transfer fails", !validateReceptionistInput({ transferNumber: "512" }).ok);
  const goodTransfer = validateReceptionistInput({ transferNumber: "(512) 555-0134" });
  checkTrue("validate transfer normalizes", goodTransfer.ok && goodTransfer.value.transferNumber === "+15125550134");
  // FAQs: required question+answer, count cap.
  checkTrue("validate missing faq answer fails", !validateReceptionistInput({ faqs: [{ question: "Q?" }] }).ok);
  checkTrue(
    "validate too many faqs fails",
    !validateReceptionistInput({ faqs: Array.from({ length: RECEPTIONIST_LIMITS.maxFaqs + 1 }, () => ({ question: "Q?", answer: "A." })) }).ok,
  );
  const okFaq = validateReceptionistInput({ faqs: [{ question: "  Do you install water heaters? ", answer: " Yes. " }] });
  checkTrue("validate trims faqs", okFaq.ok && okFaq.value.faqs[0].question === "Do you install water heaters?");
  // Malformed containers rejected, not thrown.
  checkTrue("validate non-array faqs fails", !validateReceptionistInput({ faqs: "junk" }).ok);
  checkTrue("validate non-string field fails", !validateReceptionistInput({ name: 42 }).ok);
  // Every field survives a full round trip.
  const full: ReceptionistConfig = {
    name: "Sally", greeting: "Hi there.", emergencyHandling: "Address first.", neverPromise: "No prices.",
    escalationNotes: "Commercial → Mike.", transferNumber: "+15125550199", instructions: "Note referrals.",
    faqs: [{ id: "f1", question: "Hours?", answer: "8 to 6." }],
  };
  const fullRes = validateReceptionistInput(full);
  checkDeep("validate full round trip", fullRes.ok ? fullRes.value : fullRes, full);
}

// ---------------------------------------------------------------------------
// 3. Greeting resolution — the three surfaces can never drift
// ---------------------------------------------------------------------------
{
  const EMPTY: ReceptionistConfig = sanitizeReceptionistConfig(undefined);
  check("greeting default parity (business)", resolveParityHelper(EMPTY, "Rapid Rooter"), DEFAULT_GREETING("Rapid Rooter"));
  check("greeting default parity (null)", resolveParityHelper(EMPTY, null), DEFAULT_GREETING(null));
  check("greeting fallback name", resolveParityHelper(EMPTY, "Rapid Rooter").includes(FALLBACK_RECEPTIONIST_NAME), true);
  const persona = sanitizeReceptionistConfig({ name: "Sally" });
  check("greeting uses persona", resolveParityHelper(persona, "Rapid Rooter"), DEFAULT_GREETING("Rapid Rooter").replace(FALLBACK_RECEPTIONIST_NAME, "Sally"));
  const custom = sanitizeReceptionistConfig({ greeting: "  You reached Dave.  " });
  check("greeting custom verbatim + trimmed", resolveParityHelper(custom, null), "You reached Dave.");
  // Empty businessName handled honestly (no "null" leaking into speech).
  checkTrue("greeting no null leak", !resolveParityHelper(EMPTY, null).includes("null"));
}
function resolveParityHelper(config: ReceptionistConfig, businessName: string | null): string {
  // Local import indirection so the assertion reads clearly above.
  return greetFor(config, businessName);
}
import { resolveReceptionistGreeting as greetFor } from "../src/lib/voice/receptionistConfig";

// ---------------------------------------------------------------------------
// 4. neverPromise → confirm prompt override
// ---------------------------------------------------------------------------
{
  check("no policy → no override", confirmPromptOverride(sanitizeReceptionistConfig({})), null);
  check("policy → neutral prompt", confirmPromptOverride(sanitizeReceptionistConfig({ neverPromise: "No prices." })), NEUTRAL_CONFIRM_PROMPT);
  checkTrue("neutral prompt itself promises nothing", !NEUTRAL_CONFIRM_PROMPT.includes("will reach out shortly"));
  checkTrue("default prompt DOES promise (the thing the policy drops)", PROMPTS.confirm.includes("will reach out shortly"));
}

// ---------------------------------------------------------------------------
// 5. FAQ matching
// ---------------------------------------------------------------------------
{
  const faqs = [
    { question: "Do you install water heaters?", answer: "A-HEATER" },
    { question: "What are your business hours?", answer: "A-HOURS" },
  ];
  check("faq exact topic match", matchFaq(faqs, "do you guys install water heaters")?.answer, "A-HEATER");
  check("faq content-word match", matchFaq(faqs, "what are your business hours")?.answer, "A-HOURS");
  // One content word is below the >=2 threshold — an unrelated question never matches.
  check("faq too-weak utterance", matchFaq(faqs, "what are your hours")?.answer ?? null, null);
  check("faq unrelated question never matches", matchFaq(faqs, "my toilet is overflowing"), null);
  check("faq empty utterance", matchFaq(faqs, "   "), null);
  check("faq gibberish", matchFaq(faqs, "xyzzy plugh"), null);
  // Single content word is not enough (needs >= 2 matched content words).
  check("faq one-word question too weak", matchFaq([{ question: "Pricing?", answer: "A" }], "tell me about pricing"), null);
  // Reordering the list never changes which answer matches best.
  check("faq order independence (reversed)", matchFaq([faqs[1], faqs[0]], "do you install water heaters")?.answer, "A-HEATER");
  check("faq order independence (unrelated)", matchFaq(faqs, "when are you open")?.answer ?? null, null);
}

// ---------------------------------------------------------------------------
// 6. Policy notes for staff
// ---------------------------------------------------------------------------
{
  const EMPTY = sanitizeReceptionistConfig(undefined);
  check("empty config → no notes", policyNotesForLead(EMPTY, { emergency: true }), []);
  const cfg = sanitizeReceptionistConfig({
    neverPromise: "No prices.",
    escalationNotes: "Commercial → Mike.",
    emergencyHandling: "Address first.",
  });
  const normal = policyNotesForLead(cfg, { emergency: false });
  checkTrue("neverPromise on normal lead", normal.some((n) => n.includes("No prices.")));
  checkTrue("escalation on normal lead", normal.some((n) => n.includes("Commercial → Mike.")));
  checkTrue("emergencyHandling NOT on normal lead", !normal.some((n) => n.includes("Address first.")));
  const emergency = policyNotesForLead(cfg, { emergency: true });
  checkTrue("emergencyHandling on emergency lead", emergency.some((n) => n.includes("Address first.")));
  check("note count on emergency", emergency.length, 3);
}

// ---------------------------------------------------------------------------
// 7. coerceFlowState — the simulation round-trip guard
// ---------------------------------------------------------------------------
{
  const fresh = coerceFlowState(undefined);
  check("coerce undefined → fresh initial", fresh.stage, "need");
  checkTrue("coerce fresh has empty captures", fresh.serviceNeed === null && fresh.callbackNumber === null && !frozeEmergency(fresh));
  // Crafted garbage cannot push the simulation into an impossible stage.
  const crafted = coerceFlowState({ stage: "hacked", exchanges: -5, silences: 1e9, serviceNeed: 42, emergency: { key: "gas_odor" }, leadCaptured: true, callbackNumber: "x".repeat(999) });
  check("coerce bad stage → need", crafted.stage, "need");
  check("coerce negative exchanges → 0", crafted.exchanges, 0);
  checkTrue("coerce absurd silences clamped", crafted.silences <= 50);
  checkTrue("coerce never trusts client emergency", crafted.emergency === null);
  checkTrue("coerce never trusts client leadCaptured", crafted.leadCaptured === false);
  check("coerce overlong callback dropped", crafted.callbackNumber, null);
  // Legitimate round trips survive.
  const legit = coerceFlowState({ stage: "confirm", exchanges: 2, silences: 0, serviceNeed: "leak", urgency: "same_day", callbackNumber: "+15125550134", askedForHuman: false, emergencyScriptSpoken: false });
  check("coerce legit stage kept", legit.stage, "confirm");
  check("coerce legit need kept", legit.serviceNeed, "leak");
  check("coerce legit urgency kept", legit.urgency, "same_day");
  check("coerce legit number kept", legit.callbackNumber, "+15125550134");
  check("coerce legit classification re-derived", legit.classification, null);
}
function frozeEmergency(s: { emergency: unknown }): boolean {
  return s.emergency != null;
}

// ---------------------------------------------------------------------------
console.log("");
console.log(checks + " checks, " + failures + " failures");
process.exit(failures === 0 ? 0 : 1);
