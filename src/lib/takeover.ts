/**
 * P5-4: Human-takeover trigger detection — PURE module, no I/O.
 *
 * When the AI hits something it shouldn't handle alone, the conversation is
 * flagged for a human and the owner is notified (the I/O lives in
 * src/lib/server/takeover.ts; this module only DECIDES). Triggers:
 *
 *   emergency        — an emergency-severity classification. Detection lives
 *                      in the EXISTING emergency path (classifyPipeline KB
 *                      resolver + textBack.escalateEmergency); that path calls
 *                      flagConversationNeedsHuman with this reason. It is
 *                      listed here so every trigger has one label vocabulary —
 *                      never re-detected in parallel.
 *   angry_customer   — frustrated/upset language in the customer's own words.
 *   unclear_request  — the classifier extracted nothing actionable from a
 *                      substantive message (category "other", no service need,
 *                      below the rules engine's chit-chat confidence).
 *   ai_uncertainty   — the AI ran on reduced confidence: the LLM tier failed
 *                      this turn and the rules backstop had to take over, or
 *                      the LLM parse itself came back empty.
 *   pricing_policy   — the guardrail stripped/replaced the AI's draft reply
 *                      (replySource "human_routing"): a pricing, booking or
 *                      policy question the AI is not allowed to answer.
 *
 * Deliberate NON-triggers (a shop must not be paged for noise):
 *   - chit-chat ("thanks so much!") — the rules engine marks it 0.45
 *     confidence, at/above AI_UNCERTAIN_CONFIDENCE, so it never flags;
 *   - short pleasantries under UNCLEAR_MIN_BODY_CHARS;
 *   - routine/urgent classifications with an extracted service need.
 */

/** The machine keys stored on conversations.handoff_reason. */
export type TakeoverReasonKey =
  | "emergency"
  | "angry_customer"
  | "unclear_request"
  | "ai_uncertainty"
  | "pricing_policy";

/** Human labels shown in notifications and the inbox banner. */
export const TAKEOVER_REASON_LABELS: Record<TakeoverReasonKey, string> = {
  emergency: "Emergency situation",
  angry_customer: "Upset or frustrated customer",
  unclear_request: "Unclear request the AI couldn't confidently classify",
  ai_uncertainty: "Low-confidence AI turn",
  pricing_policy: "Pricing or policy question outside the AI's rules",
};

/** Most→least urgent; the single reason surfaced in alerts and SMS. */
export const TAKEOVER_REASON_PRIORITY: readonly TakeoverReasonKey[] = [
  "emergency",
  "angry_customer",
  "pricing_policy",
  "unclear_request",
  "ai_uncertainty",
];

/**
 * Below this the rules engine says "extracted nothing" (its no-match bucket
 * is 0.2; chit-chat is 0.45). A substantive message under the threshold is an
 * unclear request; chit-chat never flags.
 */
export const AI_UNCERTAIN_CONFIDENCE = 0.45;

/** Pleasantries ("ok", "yes", "thanks!") must never page the shop. */
export const UNCLEAR_MIN_BODY_CHARS = 12;

/** Everything the detector may look at (all optional except body). */
export interface TakeoverSignals {
  body: string;
  urgency?: string | null;
  priority?: string | null;
  category?: string | null;
  serviceNeed?: string | null;
  /** Rules/LLM self-reported match strength in [0,1]; null when absent. */
  confidence?: number | null;
  /** Pipeline reply stamp; "human_routing" = the guardrail routed to a human. */
  replySource?: string | null;
  /** Why the classification tier ran: "primary" | "default" | "backstop". */
  tierReason?: string | null;
}

/**
 * Frustration/upset vocabulary. Deliberately conservative — every match pages
 * the shop — and matched on the customer's own words only.
 */
const ANGRY_PATTERN =
  /\b(furious|angry|pissed|unacceptable|ridiculous|terrible|awful|horrible|worst|disgusted|frustrated|speak to (a |the )?(real |actual )?(human|person|manager|owner)|talk to (a |the )?(real |actual )?(human|person|manager|owner)|lawyer|suing|attorney|better business bureau|scam)\b/;

/** The highest-priority reason (or null) — what alerts and SMS lead with. */
export function topTakeoverReason(reasons: TakeoverReasonKey[]): TakeoverReasonKey | null {
  for (const key of TAKEOVER_REASON_PRIORITY) {
    if (reasons.includes(key)) return key;
  }
  return null;
}

/** Order a reason set by TAKEOVER_REASON_PRIORITY, deduplicated. */
function ordered(reasons: TakeoverReasonKey[]): TakeoverReasonKey[] {
  return TAKEOVER_REASON_PRIORITY.filter((k) => reasons.includes(k));
}

/**
 * Detect the human-takeover triggers for one AI turn. Returns reasons in
 * priority order (possibly empty). NEVER throws; tolerant of malformed input.
 */
export function detectTakeoverReasons(signals: TakeoverSignals): TakeoverReasonKey[] {
  const body = typeof signals?.body === "string" ? signals.body : "";

  // Emergency outranks everything and is handled (flagged) by the existing
  // emergency escalation path — it is the ONLY reason here, nothing else runs.
  if (signals.urgency === "emergency" || signals.priority === "emergency") {
    return ["emergency"];
  }

  const reasons: TakeoverReasonKey[] = [];
  const trimmed = body.trim();
  const substantive = trimmed.length >= UNCLEAR_MIN_BODY_CHARS;

  if (substantive && ANGRY_PATTERN.test(body.toLowerCase())) {
    reasons.push("angry_customer");
  }

  // The guardrail stripped or replaced the AI's draft: a pricing/policy
  // boundary was hit and a human was promised. Whatever the tier.
  if (signals.replySource === "human_routing") {
    reasons.push("pricing_policy");
  }

  // "Extracted nothing" bucket: the classifier produced no usable read of a
  // substantive message. Chit-chat (0.45) and short pleasantries never flag.
  const lowConfidence = typeof signals.confidence === "number" && signals.confidence < AI_UNCERTAIN_CONFIDENCE;
  const extractedNothing =
    signals.category === "other" && (signals.serviceNeed == null || signals.serviceNeed === "");
  if (substantive && lowConfidence && extractedNothing) {
    reasons.push("unclear_request");
  }

  // AI uncertainty: the configured LLM failed this turn (rules backstop ran),
  // or the LLM parse itself extracted nothing at all and produced no reply.
  const llmCameBackEmpty =
    signals.tierReason === "primary" &&
    extractedNothing &&
    (signals.replySource == null || signals.replySource === "human_routing");
  if (substantive && (signals.tierReason === "backstop" || llmCameBackEmpty)) {
    reasons.push("ai_uncertainty");
  }

  return ordered(reasons);
}
