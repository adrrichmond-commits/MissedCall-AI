/**
 * Safe-advice guardrails for the plumbing knowledge base (P3-A).
 *
 * PURE FUNCTIONS, no I/O. Consumers:
 *  - P3-B (LLM bridge): builds system prompts from buildSystemPrompt() and
 *    post-filters LLM output with screenAdviceText();
 *  - rules text-back (today): can consult resolveEmergency() before replying;
 *  - P3-E (receptionist): same prompt + screening contract for voice.
 *
 * FAIL TOWARD SAFETY: anything that is not explicitly allow-listed and not
 * clearly not-advice lands in "escalate" — routed to a human (the business
 * owner) rather than answered by the AI. Deny-list hits always block, even
 * when an allow rule also matches.
 */

import { KB_VERSION } from "./version";
import type { EmergencyKbEntry, GuardrailResult } from "./types";
import { EMERGENCIES } from "./emergencies";

// ---------------------------------------------------------------------------
// Normalization (same shape as classify.ts so rules/LLM/KB agree on text)
// ---------------------------------------------------------------------------

/** Lowercase, strip apostrophes ("won't"→"wont"), collapse non-alphanumerics. */
export function normalizeKbText(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[’‘`']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Allow-list: advice the AI MAY give on its own
// ---------------------------------------------------------------------------

export interface KbRule {
  readonly key: string;
  readonly rationale: string;
  readonly patterns: readonly RegExp[];
}

export const ALLOW_RULES: readonly KbRule[] = [
  {
    key: "water_shutoff_location",
    // HOW to find/close the customer's own main or fixture shut-off valve.
    rationale: "Closing water valves stops damage and is safe, universal homeowner guidance.",
    patterns: [
      /\b(shut ?off|shutoff|stop|main|water) (valve|shutoff)\b/,
      /\b(main )?(water )?(shut|turn|turning|shutting) (it|the (water|main|valve))? ?off\b/,
      /\b(where|find|locate) (is |the )?(main|shut ?off|water) (valve|shutoff)/,
      /\b(shut|turn) (off )?the (main|water)\b/,
    ],
  },
  {
    key: "contain_water",
    rationale: "Containing/cleaning surface water prevents damage; no hazard introduced.",
    patterns: [
      /\b(towels?|mop|mopping|bucket|buckets?|wet ?vac|shop ?vac|tarp)\b/,
      /\b(contain|soak up|clean up|dry (out|the)) (the )?(water|leak|mess|area|floor)\b/,
      /\b(move|protect|lift|elevate) (your |the |our |my |their )?(valuables|rugs?|furniture|boxes|belongings|items|carpets?|couch|sofa)\b/,
    ],
  },
  {
    key: "clear_and_access",
    rationale: "Preparing safe access for the technician; no hazard introduced.",
    patterns: [
      /\b(clear|move) (the )?(area|path|way|access)\b/,
      /\b(keep )?(pets|kids|children) (away|clear|out)\b/,
      /\bclear (a )?path\b/,
    ],
  },
  {
    key: "electrical_cautions",
    // ONLY the safe direction: avoid/hands-off, never how-to on electrics.
    rationale: "Telling people to stay away from water+electricity is protective, not instructive.",
    patterns: [
      /\b(keep|stay) (away|clear|out)\b.{0,20}\b(electrical|electric|panel|breaker|outlets?|appliances?|wiring|power)\b/,
      /\b(do ?not|dont|never|avoid) (touch|use|go near|approach|enter)\b.{0,20}\b(electrical|electric|panel|breaker|outlets?|appliances?|wiring|power|meter)\b/,
    ],
  },
  {
    key: "fixture_shutoff",
    rationale: "Fixture-level valves (toilet, sink, heater cold-inlet) are homeowner-safe.",
    patterns: [
      /\b(toilet|sink|faucet|heater|heater cold) (shut ?off|shutoff|stop) valve\b/,
      /\bvalve (behind|under|next to|on top of) the (toilet|sink|faucet|heater)\b/,
      /\b(cold )?water (valve|inlet) (on top of )?(the )?(heater|tank)\b/,
    ],
  },
  {
    key: "utility_and_emergency_calls",
    rationale: "Directing people to 911/gas utility/811 is always safe and often critical.",
    patterns: [
      /\b(call|dial) (911|the gas (company|utility)|your gas (company|utility)|811)\b/,
      /\b(gas company|gas utility|utility company)\b/,
      /\b811\b/,
    ],
  },
  {
    key: "fixture_level_maintenance",
    rationale: "Trivial, non-hazardous upkeep on accessible fixtures.",
    patterns: [
      /\b(replace|swap|change) (the )?(flapper|toilet (seat|handle)|shower ?head|faucet aerator|aerator)\b/,
      /\b(clear|wipe|rinse|clean) (the )?(aerator|shower ?head|drain (cover|strainer)|strainer|p ?trap)\b/,
      /\b(run|flush) (the )?(disposal) (with|and) (cold )?water\b/,
    ],
  },
];

// ---------------------------------------------------------------------------
// Deny-list: advice the AI must NEVER give (blocks outright)
// ---------------------------------------------------------------------------

interface DenyRule extends KbRule {}

export const DENY_RULES: readonly DenyRule[] = [
  {
    key: "gas_diy",
    rationale: "Any hands-on gas guidance is licensed-only; leaks can be lethal.",
    patterns: [
      /\bgas (valve|line|pipe|meter|regulator|connection|coupling|shut ?off|shutoff|flex line|tap)\b/,
      /\b(valve|line|pipe|meter|regulator|connection|coupling)\b.{0,20}\bgas\b|\bgas\b.{0,25}\b(valve|line|pipe|meter|regulator|connection|coupling)\b/,
      /\bshut (off|down) the gas\b/,
      /\b(gas|pilot) (valve|knob|control|burner|thermocouple|thermostat)\b/,
      /\brelight/,
      /\b(light|ignite|restart) (the )?(pilot|burner|furnace|water heater|heater)\b/,
      /\bpropane (tank|valve|line|regulator)\b/,
    ],
  },
  {
    key: "electrical_diy",
    rationale: "Any hands-on electrical guidance is out of scope; water raises the stakes.",
    patterns: [
      /\b(circuit breaker|breaker (box|panel)|fuse box|electrical panel)\b/,
      /\b(wire|wiring|rewire|receptacle|outlet|junction box|ground(ing)?)\b/,
      /\b(turn|shut|switch) (off|down) (the )?(breaker|power|electricity)\b/,
      /\bflip (the )?breaker\b/,
    ],
  },
  {
    key: "confined_space",
    rationale: "Crawlspaces/sewers are toxic, Oxygen-limited, or structurally risky.",
    patterns: [
      /\b(crawl ?space|crawlthrough|crawlspace|confined space)\b/,
      /\b(go|climb|crawl|get) (down |into |in )?(the )?(crawl ?space|sewer|septic tank|sump pit|well)\b/,
      /\b(descend|enter) (the )?(pit|tank|vault|manhole)\b/,
    ],
  },
  {
    key: "chemical_misuse",
    rationale: "Caustic chemicals in standing fixtures or mainlines splash back and destroy pipes.",
    patterns: [
      /\b(drain (cleaner|cleaning product|opener)|drano|liquid ?plumber|liquid plumr|caustic (soda|product)|lye|sulfuric acid|muriatic acid|acid)\b/,
      /\bchemicals? (down|into|in) (the )?(drain|toilet|pipe|main)/,
      /\bmix(ing)? (chemicals|cleaners|products)\b/,
      /\bchemical/,
    ],
  },
  {
    key: "structure_and_digging",
    rationale: "Opening walls/floors and digging without locates cause injury and damage.",
    patterns: [
      /\b(cut|open|break|demo(te)?|tear) (open |into |out )?(the )?(wall|walls|ceiling|floor|slab|drywall|tile)\b/,
      /\b(dig|excavat|trench)\b/,
    ],
  },
  {
    key: "structural_or_specialist_referral",
    rationale: "Structural/septic-tank interior issues are out of plumbing-AI scope.",
    patterns: [
      /\b(structural|foundation (crack|repair|engineer)|load (bearing|wall))\b/,
      /\b(pump out|enter) (the )?septic tank\b/,
    ],
  },
  {
    key: "pressure_vessel_and_heater_interior",
    rationale: "Scald/explosion risk: never guide heater interiors, T&P valves, or pressurized systems.",
    patterns: [
      /\b(temperature|t ?and ?p|t ?p) (and )?(pressure )?(relief )?valve\b/,
      /\b(temperature ?pressure|tp) relief valve\b/,
      /\b(drain|flush|open) (the )?(water heater|heater tank|boiler)\b/,
      /\b(boiler|pressure tank|expansion tank)\b/,
      /\b(open|remove) (the )?(heater|tank) (panel|access|element|cover)\b/,
      /\b(heating |heater )?element (access )?(panel|cover|flange)\b/,
      /\bremove (the )?(element|heating element|access panel|upper thermostat|lower thermostat)\b/,
      /\banode (rod)?\b/,
    ],
  },
];

// ---------------------------------------------------------------------------
// Advice-request detection (for screenAdviceRequest)
// ---------------------------------------------------------------------------

const ADVICE_REQUEST_RE =
  /\b(how (do|can|should|would) (i|we|you)|what (should|do) (i|we)|can i|should i|is it (safe|ok|okay) to|do i (need|have) to|any (tips|advice|suggestions)|tell me how|walk me through|instructions?|guide me|help me)\b|\?/;

// ---------------------------------------------------------------------------
// Screening functions
// ---------------------------------------------------------------------------

function evalRules(rules: readonly KbRule[], text: string): string[] {
  const hits: string[] = [];
  for (const rule of rules) {
    if (rule.patterns.some((re) => re.test(text))) hits.push(rule.key);
  }
  return hits;
}

/**
 * Screen a piece of TEXT (an inbound question or proposed AI answer) against
 * the safe-advice guardrails. Decision order — deny > allow > escalate:
 *
 *   1. any deny rule hit            → "block"    (even if allow also hit)
 *   2. any allow rule hit, no deny  → "allow"
 *   3. no rule hit at all           → "escalate" (fail toward safety)
 *
 * `escalateToHuman` is true for every non-allow decision. Use
 * screenAdviceRequest() when you first need to know whether the text is
 * asking for advice at all.
 */
export function screenAdviceText(text: string): GuardrailResult {
  const t = normalizeKbText(text);
  const denyHits = evalRules(DENY_RULES, t);
  const allowHits = evalRules(ALLOW_RULES, t);
  if (denyHits.length > 0) {
    return {
      decision: "block",
      kbVersion: KB_VERSION,
      matchedAllow: allowHits,
      matchedDeny: denyHits,
      reason: "deny-list hit: " + denyHits.join(", "),
      escalateToHuman: true,
    };
  }
  if (allowHits.length > 0) {
    return {
      decision: "allow",
      kbVersion: KB_VERSION,
      matchedAllow: allowHits,
      matchedDeny: [],
      reason: "allow-list hit: " + allowHits.join(", "),
      escalateToHuman: false,
    };
  }
  return {
    decision: "escalate",
    kbVersion: KB_VERSION,
    matchedAllow: [],
    matchedDeny: [],
    reason: "no rule matched — ambiguous advice; routed to human (fail toward safety)",
    escalateToHuman: true,
  };
}

/**
 * Screen an inbound CUSTOMER text that looks like an advice request. Returns
 * decision "not_advice" (escalateToHuman false) when the text shows no advice
 * intent — callers continue normal classification/booking flow. Otherwise the
 * result is screenAdviceText()'s decision.
 */
export function screenAdviceRequest(text: string): GuardrailResult {
  const t = normalizeKbText(text);
  if (t.length === 0 || !ADVICE_REQUEST_RE.test(t)) {
    return {
      decision: "not_advice",
      kbVersion: KB_VERSION,
      matchedAllow: [],
      matchedDeny: [],
      reason: "no advice intent detected — continue normal flow",
      escalateToHuman: false,
    };
  }
  return screenAdviceText(text);
}

// ---------------------------------------------------------------------------
// LLM policy text (P3-B system-prompt building block)
// ---------------------------------------------------------------------------

function listRules(rules: readonly { key: string; rationale: string }[]): string {
  return rules.map((r) => "  - " + r.key + ": " + r.rationale).join("\n");
}

/**
 * Deterministic system-prompt fragment encoding the guardrail policy. P3-B
 * prepends this to the LLM conversation; P3-E reuses it for voice. The prompt
 * instructs the model to answer ONLY within the allow-list and to defer
 * everything else to a human — and post-filtering via screenAdviceText()
 * enforces the same contract mechanically.
 */
export function buildSystemPrompt(): string {
  return [
    "SAFETY POLICY (plumbing assistant) — follow exactly:",
    "1. If the customer may be describing an emergency (gas odor, flooding, sewage backup, burst pipe, no water, leaking water heater), deliver the emergency safety script FIRST. Never price, book, or qualify before that.",
    "2. You may give ONLY the following categories of advice, and nothing hands-on beyond them:",
    listRules(ALLOW_RULES),
    "3. NEVER give advice in these categories — say a licensed technician must handle it and offer to book:",
    listRules(DENY_RULES),
    "4. If a request is ambiguous or not covered by the allow-list, do not guess: route to a human.",
    "5. Never quote firm prices sight-unseen; explain pricing comes after diagnosis.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Emergency resolution (safety-first routing)
// ---------------------------------------------------------------------------

/**
 * Resolve the highest-severity emergency matching the text, or null.
 * Order guarantees: critical beats severe beats elevated regardless of rule
 * order. Pattern matching is over normalized text.
 */
export function resolveEmergency(text: string): {
  entry: EmergencyKbEntry;
  kbVersion: string;
  matchedPatterns: number;
} | null {
  const t = normalizeKbText(text);
  let best: EmergencyKbEntry | null = null;
  let bestMatches = 0;
  for (const entry of EMERGENCIES) {
    const hits = entry.patterns.filter((re) => re.test(t)).length;
    if (hits > 0 && (best === null || entry.patterns.length === 0 || severityRank(entry.severity) > severityRank(best.severity))) {
      best = entry;
      bestMatches = hits;
    }
  }
  return best ? { entry: best, kbVersion: KB_VERSION, matchedPatterns: bestMatches } : null;
}

function severityRank(severity: EmergencyKbEntry["severity"]): number {
  return severity === "critical" ? 3 : severity === "severe" ? 2 : 1;
}
