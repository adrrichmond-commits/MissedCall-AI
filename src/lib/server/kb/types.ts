/**
 * Shared types for the plumbing knowledge base (P3-A).
 *
 * PURE TYPES ONLY — no runtime code, no imports. The KB is deliberately
 * code-resident (no DB reads, no env, no network) so it works keyless and
 * DBless for the rules text-back (today), the LLM bridge (P3-B) and the AI
 * receptionist (P3-E). P3-C reconciles value ranges with per-business pricing.
 */

/** Urgency vocabulary — mirrors MessageClassification.urgency in src/db/schema.ts. */
export type KbUrgency = "emergency" | "same_day" | "within_week" | "flexible";

/** One service in the shared catalog. Aliases are regexes over normalized text. */
export interface ServiceKbEntry {
  /** Canonical slug — stable identifier consumers persist/branch on. */
  readonly slug: string;
  /** Display name (title case, customer-safe). */
  readonly name: string;
  /** One-line description of the service scope. */
  readonly description: string;
  /** Keyword patterns; ANY match qualifies the entry as a candidate. */
  readonly aliases: readonly RegExp[];
  /** Default urgency when nothing in the message argues otherwise. */
  readonly defaultUrgency: KbUrgency;
  /** Typical job value range in USD — seeds estimated job value (P3-C). */
  readonly typicalValue: {
    readonly currency: "USD";
    readonly low: number;
    readonly high: number;
  };
  /** 2–4 questions to qualify scope before quoting/booking. */
  readonly qualifyingQuestions: readonly string[];
  /** Safety notes the AI may relay or must respect for this service. */
  readonly safetyNotes: readonly string[];
}

/** Severity ordering for the emergency taxonomy. */
export type EmergencySeverity = "critical" | "severe" | "elevated";

/** One emergency class in the taxonomy. */
export interface EmergencyKbEntry {
  /** Stable key (snake_case), e.g. "gas_odor". */
  readonly key: string;
  /** Display name. */
  readonly name: string;
  /** critical > severe > elevated. resolveEmergency returns the highest hit. */
  readonly severity: EmergencySeverity;
  /** Keyword patterns over normalized text; ANY match = hit. Typo-tolerant. */
  readonly patterns: readonly RegExp[];
  /**
   * Ordered immediate customer-safety script (step 1 first). Static copy the
   * AI relays verbatim BEFORE anything else for this emergency class.
   */
  readonly customerScript: readonly string[];
  /** True when a hit must escalate after hours instead of queuing to morning. */
  readonly afterHoursEscalation: boolean;
  /** Extra hazards/notes for the business owner and the LLM policy. */
  readonly safetyNotes: readonly string[];
}

/**
 * Result of screening a piece of text against the safe-advice guardrails.
 *
 *   allow       — explicitly safe (allow-list hit, no deny hit)
 *   block       — deny-list hit (DIY gas/electrical/confined-space/chemicals…)
 *   escalate    — advice that is neither allow-listed nor denied: ambiguous,
 *                 so route to a human (fail toward safety)
 *   not_advice  — inbound text that is not asking for advice at all
 *                 (only produced by screenAdviceRequest)
 */
export type AdviceDecision = "allow" | "block" | "escalate" | "not_advice";

export interface GuardrailResult {
  readonly decision: AdviceDecision;
  readonly kbVersion: string;
  /** Keys of allow rules that matched. */
  readonly matchedAllow: readonly string[];
  /** Keys of deny rules that matched. */
  readonly matchedDeny: readonly string[];
  /** Human-readable explanation of the decision (ops/debug, not customer copy). */
  readonly reason: string;
  /** True when a human (business owner) should take over from the AI. */
  readonly escalateToHuman: boolean;
}

/** One default FAQ/receptionist policy entry. Per-business override is P3-E. */
export interface FaqEntry {
  /** Stable id, e.g. "pricing". */
  readonly id: string;
  /** Short topic label. */
  readonly topic: string;
  /** Inbound question patterns; ANY match selects this entry. */
  readonly patterns: readonly RegExp[];
  /** Honest default answer script (deflection policy). */
  readonly defaultAnswer: string;
  /** What the business owner is expected to override / P3-E wires. */
  readonly deferNote: string;
}

/** Generic stamped match wrapper returned by KB resolvers. */
export interface KbMatch<T> {
  readonly entry: T;
  readonly kbVersion: string;
  /** Number of distinct alias patterns that matched. */
  readonly matchedAliases: number;
}

/** Counts + version for health checks, logs and tests. */
export interface KbManifest {
  readonly kbVersion: string;
  readonly services: number;
  readonly emergencies: number;
  readonly allowRules: number;
  readonly denyRules: number;
  readonly faqEntries: number;
}
