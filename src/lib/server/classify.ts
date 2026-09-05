/**
 * Rule-based SMS lead classifier (Phase 2 build #7).
 *
 * WHY: the product must work fully WITHOUT LLM_API_KEY. This module is the
 * honest, conservative default for classifying inbound text bodies in the
 * plumbing/home-services domain:
 *
 *   - DEFAULT when the LLM is not configured;
 *   - BACKSTOP when the LLM is configured but errors or returns nothing.
 *
 * When the LLM IS configured and healthy, the LLM stays primary and this
 * engine never runs (see handleInboundSms in src/lib/server/textBack.ts).
 *
 * Output mirrors the LLM classification shape (MessageClassification — the
 * messages.classification jsonb) so the DB stores one shape regardless of
 * which engine ran. Every result carries:
 *
 *   classifier: "rules"   — so rule output is always distinguishable from
 *                           LLM output (and from pre-build-#7 rows, which
 *                           have no classifier field at all);
 *   confidence: 0..1      — self-reported strength of the rule match. This
 *                           is NOT a probability; it is an honest ordering
 *                           signal (emergency > urgent > routine > other).
 *
 * STOP/START/HELP are handled upstream (parseSmsCommand in
 * src/lib/smsCommands.ts) and NEVER reach this module in production —
 * this engine deliberately does not re-handle them (a bare "STOP" simply
 * matches no domain rule and lands in "other").
 *
 * PURE FUNCTION, NO I/O: no imports at runtime, no env, no network, no DB —
 * unit-tested standalone by scripts/test-classify.ts without keys or a DB.
 * That is also why there is deliberately no server-only import guard here
 * (same pattern as src/lib/smsCommands.ts); it carries no secrets.
 *
 * HONESTY RULES: nothing is inferred that the text does not say. Fields the
 * rule engine cannot reliably extract (contactName, serviceAddress) stay
 * null. No match does not invent a category — it lands in "other" with low
 * confidence. Grep this file for "known limitation" for the accepted
 * false-positive risks.
 */

import type {
  MessageClassification,
  MessageClassificationCategory,
  MessageClassificationIntent,
} from "~/db/schema";

/** Version stamped into `model` for every rule-engine result. */
export const RULES_CLASSIFIER_VERSION = "rules-v1";

/**
 * A rule group = a named, labelled conjunction of regexes: EVERY regex in
 * `res` must match somewhere in the normalized text; each regex is itself an
 * OR of alternatives. All regexes are non-global (`.test` statelessness).
 */
interface RuleGroup {
  key: string;
  /** Human/ops-readable service-need label (only what the text supports). */
  label: string;
  /** Matching marks safetyConcern=true (gas / uncontrolled water hazards). */
  safety?: boolean;
  res: RegExp[];
}

// ---------------------------------------------------------------------------
// Domain rule tables (plumbing / home services)
// ---------------------------------------------------------------------------

const EMERGENCY_GROUPS: RuleGroup[] = [
  {
    key: "burst_pipe",
    label: "burst pipe",
    safety: true,
    res: [/\b(burst|busted|ruptured|exploded|blew)/, /\b(pipe|pipes|piping|water (line|main))/],
  },
  {
    key: "flooding",
    label: "active flooding",
    safety: true,
    // Prefix match on purpose: catches "flood", "flooded", "flooding",
    // "floooding", "floodig" (typo). Known limitation: historical mentions
    // ("after the flood last year") also match — rules stay conservative.
    res: [/\bflood/],
  },
  {
    key: "water_everywhere",
    label: "water everywhere / spreading",
    safety: true,
    res: [/\bwater everywhere\b|\bwater all over\b|\ball over the (floor|house|kitchen|bathroom|basement|walls?|ceiling|cabinets?|yard|garage)\b/],
  },
  {
    key: "sewage_backup",
    label: "sewer/sewage backup",
    safety: true,
    res: [/\bsewage\b|\b(sewer|septic)( [a-z]+){0,3} (backed? ?up|backing ?up|backup|overflow(ing)?)\b/],
  },
  {
    key: "gas_smell",
    label: "possible gas leak",
    safety: true,
    res: [/\bgas\b/, /\b(smell|smells|smelling|smelled|smelt|odor|odour|leak|leaking|leek|fumes?)\b/],
  },
  {
    key: "no_water",
    label: "no water service",
    // "(?! pressure)" keeps "no water pressure" from double-hitting the
    // emergency bucket — that phrasing belongs to the urgent pressure rule.
    res: [/\bno water\b(?! pressure)|\bdont (have|got) (any )?water\b|\bout of water\b|\bwater (has |just )?stopped (coming|running|working)\b/],
  },
  {
    key: "overflowing_toilet",
    label: "overflowing toilet",
    safety: true,
    res: [/\btoilet\b/, /\boverflow(ing|ed|s)?\b/],
  },
  {
    key: "water_heater_heavy_leak",
    label: "water heater leaking heavily",
    safety: true,
    // "water heater leaking heavily" = heater + leak-word + intensifier.
    // Without an intensifier it falls through to the urgent water-heater group.
    res: [
      /\bwater heater\b/,
      /\b(leak|gush|pour|spray|spew|burst)/,
      /\b(heavily|heavy|non ?stop|wont stop|cant stop|cant get it to stop|everywhere|a lot of|lots of|soaking|soaked|drench|buckets?|gushing|pouring|spraying|spewing|rapidly|fast)\b/,
    ],
  },
  {
    key: "uncontrolled_water",
    label: "uncontrolled water flow",
    safety: true,
    res: [
      /\b(gushing|spewing|spraying|shooting|pouring)( out| water)?\b|\bwater (is |its |was )?(gushing|spewing|spraying|shooting|pouring)\b|\bwont stop (leaking|leakin|pouring|gushing|spraying)\b/,
    ],
  },
  {
    key: "cant_shut_off",
    label: "water cannot be shut off",
    safety: true,
    res: [
      /\b(cant|cannot|can ?not|wont|unable to) (shut|turn|get|find|reach|locate)\b/,
      /\b(shut ?off|turn (it|the water)? ?off|stop the water|water off|main valve|shut ?off valve)\b/,
    ],
  },
  {
    key: "declared_emergency",
    // Self-declaration: the customer's own words are the evidence we have,
    // and failing toward urgency is the conservative direction for safety.
    // No safetyConcern here — a declaration alone evidences no hazard type.
    label: "customer-declared emergency",
    res: [/\bemergenc(y|ies)\b/],
  },
];

const URGENT_GROUPS: RuleGroup[] = [
  {
    key: "no_hot_water",
    label: "no hot water",
    res: [
      /\bno hot (water|watter|wator|wahter)\b|\bhot water (is |was |has |just )?(not|no longer|stopped|quit|gone|out|cold|dead|broken|down|off|lukewarm)\b|\b(dont|do ?not|havent|have ?not) (had |have |get |getting )?(any )?(hot )?water\b|\bwater heater (is |was )?(not|isnt|no longer|stopped|quit) (working|heating|making hot water)\b|\b(only|just) (getting )?cold water\b/,
    ],
  },
  {
    key: "main_line_clog",
    label: "main line blockage",
    res: [
      /\b(main ?line|mainline|main drain|sewer line|water main)\b/,
      /\b(clog|block|backed? ?up|backing ?up|backup|stoppage|plugged)/,
    ],
  },
  {
    key: "fixture_backup",
    label: "backed-up drain/fixture",
    res: [
      /\b(backed ?up|backing ?up|backedup)\b/,
      /\b(drain|drains|drainage|sink|toilet|tub|shower|bathtub|pipe|line|kitchen|bathroom|laundry|disposal)\b/,
    ],
  },
  {
    key: "fixture_clog",
    label: "clogged drain/fixture",
    res: [
      /\b(clog|block|stoppage|stopped ?up|stoped ?up|plugged|pluggd)/,
      /\b(drain|drains|drainage|sink|toilet|tub|shower|bathtub|pipe|line|kitchen|bathroom|laundry|disposal)\b/,
    ],
  },
  {
    key: "leak_contained",
    label: "leak (contained)",
    // Bare leak stem: "leak", "leaking", "leakin", "leakig", "leakey" all
    // start with "leak". A leak the customer texts about is treated as
    // high priority by default; routine drip language is matched first by
    // the routine faucet_drip group only when a faucet/tap word co-occurs,
    // but a plain "dripping" with no fixture still lands here on purpose.
    res: [/\bleak/],
  },
  {
    key: "water_heater_leak",
    label: "water heater leak",
    res: [/\bwater heater\b/, /\b(leak|gush|pour|spray|spew)/],
  },
  {
    key: "ceiling_leak",
    label: "ceiling leak",
    res: [/\bceiling\b/, /\b(leak|drip|stain|brown spot|caving|bubbl|water)/],
  },
  {
    key: "running_toilet",
    label: "running toilet",
    res: [/\btoilet\b/, /\b(running|runnin|runs|ran)\b/],
  },
  {
    key: "toilet_wont_flush",
    label: "toilet will not flush",
    res: [
      /\btoilet\b/,
      /\b(wont|wouldnt|doesnt|doenst|cant) (flush|go down|goes down|empty|drain)\b|\bnot flushing\b|\b(isnt|is not) flushing\b/,
    ],
  },
  {
    key: "water_running",
    label: "water running nonstop",
    res: [/\bwater\b/, /\bwont stop running\b|\b(nonstop|continuously|constantly|all night|for hours)\b/],
  },
  {
    key: "no_water_pressure",
    label: "no/low water pressure",
    res: [
      /\bno (water )?pressure\b|\bwater pressure (is |was |has |just )?(gone|dropped|out|lost|dead|nonexistent|really low|very low|super low|terrible|awful|almost nothing|weak)\b|\b(lost|losing) (all |the )?(water )?pressure\b/,
    ],
  },
];

const ROUTINE_GROUPS: RuleGroup[] = [
  {
    key: "quote_request",
    label: "quote or pricing request",
    res: [
      /\b(quote|quotes|estimate|estimates|estamate|bid|pricing|price|prices|cost|costs|how much|ball ?park|rates?|charge|charging|cash price)\b/,
    ],
  },
  {
    key: "maintenance",
    label: "scheduled maintenance/service",
    res: [
      /\b(maintenance|annual|yearly|semi ?annual|inspection|checkup|check ?up|tune ?up|tuneup|service plan|flush|cleaning|water ?heater service)\b/,
    ],
  },
  {
    key: "slow_drain",
    label: "slow drain",
    // "slow ... drain" ordering. NOTE: the two phrasings are ALTERNATIVES, so
    // they live in two separate RuleGroups — res entries are a conjunction.
    res: [/\bslow(ly|er|ish)? [a-z ]{0,12}?(drain|drains|draining|drainage)\b/],
  },
  {
    key: "slow_drain",
    label: "slow drain",
    // "drain ... slow" ordering with filler words between ("is really slow").
    res: [/\b(drain|drains|drainage|sink|tub|shower|bathtub|faucet|toilet)\b[a-z ]{0,25}?\b(slow|sluggish)\b/],
  },
  {
    key: "faucet_drip",
    label: "dripping faucet/fixture",
    res: [/\b(faucet|tap|spigot|spikit|shower ?head|shower|bathtub|tub|sink)\b/, /\bdrip(ping|s|y|in)?\b|\bdripy\b/],
  },
];

/** "Whenever / no rush" language — downgrades routine urgency to flexible. */
const FLEXIBLE_RE =
  /\b(no rush|no hurry|not urgent|whenever you (can|get a chance|get a sec|have time|have a sec|are free|are available)|when you ?re free|sometime|just curious|just wondering|thinking about|looking ahead|next month|in a few weeks)\b/;

/** Greeting-only openers (start of message). */
const GREETING_RE = /^(hi|hey+|hello|hiya|yo|howdy|good (morning|afternoon|evening))\b/;
/** Acknowledgements/thanks anywhere in the message. */
const THANKS_RE = /\b(thanks|thank you|thankyou|thx|tyvm|ty|appreciate it|appreciated)\b/;

const QUOTE_INTENT_RE =
  /\b(quote|quotes|estimate|estimates|estamate|bid|pricing|price|prices|cost|costs|how much|ball ?park|rates?|charge|charging)\b/;
const BOOK_INTENT_RE =
  /\b(book|booking|appointment|appointments|appt|appts|schedule|schedual|reschedule|set up|come out|come by|come over|send (someone|somebody|a tech|a plumber|your (tech|plumber))|when can (you|someone|somebody|u)|when (are|is) (you|yall) (available|free)|are (you|yall) available|availability|get (someone|somebody) (out|over|here))\b/;
const QUESTION_INTENT_RE =
  /\b(question|wonder(ing)?|curious|any idea|do you (offer|do|install|repair|fix|handle|service|have|provide)|do (you|yall) (service|cover)|does (your|the)|is there|what (are|is) (your|the)|how (long|soon|often))\b/;

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/;

/** Ordered longest-first; earliest match wins, longest wins a same-position tie. */
const TIME_HINTS = [
  "as soon as possible",
  "asap",
  "right now",
  "tomorrow morning",
  "tomorrow afternoon",
  "tomorrow evening",
  "tomorrow",
  "later today",
  "today",
  "tonight",
  "this morning",
  "this afternoon",
  "this evening",
  "in the morning",
  "in the afternoon",
  "in the evening",
  "this weekend",
  "weekend",
  "next week",
  "this week",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/**
 * Classification produced by the rule engine: the shared MessageClassification
 * jsonb shape with the rule-specific fields tightened (always present).
 */
export interface RuleClassification extends MessageClassification {
  classifier: "rules";
  category: MessageClassificationCategory;
  /** Self-reported rule-match strength in [0,1] — an ordering signal, not a probability. */
  confidence: number;
  intent: MessageClassificationIntent | null;
  preferredTimeHint: string | null;
  matchedRules: string[];
}

/** Lowercase, strip apostrophes ("won't"→"wont"), collapse non-alphanumerics. */
function normalizeBody(body: string): string {
  return body
    .toLowerCase()
    .replace(/[’‘`']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function matchedGroups(groups: RuleGroup[], text: string): RuleGroup[] {
  return groups.filter((g) => g.res.every((re) => re.test(text)));
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Confidence = base + step per extra matched group, capped per category. */
function groupConfidence(base: number, step: number, cap: number, count: number): number {
  return clamp01(Math.min(cap, base + step * Math.max(0, count - 1)));
}

function findTimeHint(padded: string): string | null {
  let best: { hint: string; idx: number } | null = null;
  for (const hint of TIME_HINTS) {
    const idx = padded.indexOf(" " + hint + " ");
    if (idx === -1) continue;
    // Earliest position wins; on a tie the longer (more specific) phrase wins,
    // so "tomorrow morning" beats "tomorrow" and "later today" beats "today".
    if (!best || idx < best.idx || (idx === best.idx && hint.length > best.hint.length)) {
      best = { hint, idx };
    }
  }
  return best ? best.hint : null;
}

function firstIndex(re: RegExp, text: string): number {
  const m = re.exec(text);
  return m ? m.index : Number.MAX_SAFE_INTEGER;
}

function findIntent(text: string, raw: string): MessageClassificationIntent | null {
  const quoteIdx = firstIndex(QUOTE_INTENT_RE, text);
  const bookIdx = firstIndex(BOOK_INTENT_RE, text);
  const questionIdx = firstIndex(QUESTION_INTENT_RE, text);
  const min = Math.min(quoteIdx, bookIdx, questionIdx);
  if (min !== Number.MAX_SAFE_INTEGER) {
    // Earliest mention decides; a tie resolves book > quote > question.
    if (bookIdx === min) return "book";
    if (quoteIdx === min) return "quote";
    return "question";
  }
  // A lone question mark is still honest evidence of a question.
  if (raw.includes("?")) return "question";
  return null;
}

/**
 * Classify one inbound SMS body with the domain rule tables. Total function:
 * null/undefined/empty input yields the honest "other"/low-confidence result,
 * never a throw and never an invented parse.
 */
export function classifyInboundText(body: string | null | undefined): RuleClassification {
  const raw = typeof body === "string" ? body : "";
  const text = normalizeBody(raw);
  const timeHint = findTimeHint(" " + text + " ");
  const intent = findIntent(text, raw);
  const contactEmail = EMAIL_RE.exec(raw.toLowerCase())?.[0] ?? null;

  // Shared fields: the rule engine extracts ONLY what rules matched.
  const base = {
    contactName: null, // Known limitation: rules cannot reliably extract names.
    contactEmail,
    serviceAddress: null, // Known limitation: addresses need the LLM path.
  };

  if (text.length === 0) {
    return {
      ...base,
      serviceNeed: null,
      urgency: null,
      priority: null,
      safetyConcern: null,
      notes: RULES_CLASSIFIER_VERSION + ": empty body - nothing to classify",
      model: RULES_CLASSIFIER_VERSION,
      classifier: "rules",
      category: "other",
      confidence: 0.1,
      intent,
      preferredTimeHint: timeHint,
      matchedRules: [],
    };
  }

  // 1. Emergency — checked first; safety trumps everything.
  const emergency = matchedGroups(EMERGENCY_GROUPS, text);
  if (emergency.length > 0) {
    return buildResult(emergency, {
      base,
      text,
      timeHint,
      intent,
      urgency: "emergency",
      priority: "emergency",
      confidence: groupConfidence(0.85, 0.05, 0.95, emergency.length),
    });
  }

  // 2. Urgent — same-day response family.
  const urgent = matchedGroups(URGENT_GROUPS, text);
  if (urgent.length > 0) {
    return buildResult(urgent, {
      base,
      text,
      timeHint,
      intent,
      urgency: "same_day",
      priority: "high",
      confidence: groupConfidence(0.75, 0.05, 0.88, urgent.length),
    });
  }

  // 3. Routine — quotes, maintenance, slow drains, drips.
  const routine = matchedGroups(ROUTINE_GROUPS, text);
  if (routine.length > 0) {
    const isRepair = routine.some((g) => g.key === "slow_drain" || g.key === "faucet_drip");
    return buildResult(routine, {
      base,
      text,
      timeHint,
      intent,
      urgency: isRepair || !FLEXIBLE_RE.test(text) ? "within_week" : "flexible",
      priority: "normal",
      confidence: groupConfidence(0.7, 0.07, 0.85, routine.length),
    });
  }

  // 4. Other — greetings/thanks/short replies/gibberish. Honest low
  //    confidence: we recognized at most chit-chat, extracted nothing.
  const isChitChat = GREETING_RE.test(text) || THANKS_RE.test(text);
  return {
    ...base,
    serviceNeed: null,
    urgency: null,
    priority: null,
    safetyConcern: null,
    notes: isChitChat
      ? RULES_CLASSIFIER_VERSION + ": greeting/acknowledgement only - no service need stated"
      : RULES_CLASSIFIER_VERSION + ": no domain signals matched - unclassified by rules",
    model: RULES_CLASSIFIER_VERSION,
    classifier: "rules",
    category: "other",
    confidence: isChitChat ? 0.45 : 0.2,
    intent,
    preferredTimeHint: timeHint,
    matchedRules: [],
  };
}

function buildResult(
  groups: RuleGroup[],
  args: {
    base: { contactName: null; contactEmail: string | null; serviceAddress: null };
    text: string;
    timeHint: string | null;
    intent: MessageClassificationIntent | null;
    urgency: "emergency" | "same_day" | "within_week" | "flexible";
    priority: "emergency" | "high" | "normal";
    confidence: number;
  },
): RuleClassification {
  const keys = groups.map((g) => g.key);
  return {
    ...args.base,
    // Only what the text supports: canonical labels of the matched rules.
    serviceNeed: groups.slice(0, 3).map((g) => g.label).join("; "),
    urgency: args.urgency,
    priority: args.priority,
    safetyConcern: groups.some((g) => g.safety) ? true : null,
    notes: RULES_CLASSIFIER_VERSION + " matched: " + keys.join(", "),
    model: RULES_CLASSIFIER_VERSION,
    classifier: "rules",
    category: args.priority === "emergency" ? "emergency" : args.priority === "high" ? "urgent" : "routine",
    confidence: args.confidence,
    intent: args.intent,
    preferredTimeHint: args.timeHint,
    matchedRules: keys,
  };
}
