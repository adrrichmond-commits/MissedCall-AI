/**
 * P4-A AI-quality rules (pure, unit-tested).
 *
 * Reads the AI outcome signals stored on conversations (migration 019
 * ai_outcome jsonb, maintained by the SMS pipeline) plus the owner feedback,
 * and decides which review-queue flags a conversation has earned. Every rule
 * is deliberately conservative: a flag means "a human should look at this",
 * not "the AI misbehaved" — and nothing fires when the AI never ran.
 */
import type { AiOutcome, ReviewReason } from "~/db/schema";

/** LLM latency at/above this many ms is flagged for review (the LLM call's own timeout is 15s). */
export const HIGH_LATENCY_MS = 15_000;
/** Failed LLM turns (rules-backstop) at/above this count are flagged. */
export const REPEATED_FAILURE_MIN = 3;
/** Classified turns after which contact info still missing is flagged. */
export const CONTACT_CHANCE_MIN_TURNS = 2;

/** The empty signal: the AI has not run on this conversation. */
export function emptyAiOutcome(): AiOutcome {
  return {
    capturedContact: false,
    emergencyDetected: false,
    emergencyEscalated: false,
    classifiedTurns: 0,
    failedTurns: 0,
    lastLatencyMs: null,
  };
}

function bool(v: unknown): boolean {
  return v === true;
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Parse the raw jsonb column into an AiOutcome. Anything missing/invalid
 * falls back to the honest zero value — never guessed, never thrown.
 */
export function sanitizeAiOutcome(raw: unknown): AiOutcome {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyAiOutcome();
  }
  const r = raw as Record<string, unknown>;
  const latency = r.lastLatencyMs;
  return {
    capturedContact: bool(r.capturedContact),
    emergencyDetected: bool(r.emergencyDetected),
    emergencyEscalated: bool(r.emergencyEscalated),
    classifiedTurns: count(r.classifiedTurns),
    failedTurns: count(r.failedTurns),
    lastLatencyMs: typeof latency === "number" && Number.isFinite(latency) && latency >= 0 ? latency : null,
  };
}

/**
 * Whether the AI actually participated in this conversation: at least one
 * classification turn ran. Conversations the AI never touched (LLM not
 * configured at all, command-only texts) produce NO quality flags — there is
 * no AI behavior to review.
 */
export function hasAiActivity(o: AiOutcome): boolean {
  return o.classifiedTurns > 0 || o.failedTurns > 0;
}

export interface FlagInputs {
  /** The conversation's AI outcome signals (sanitized). */
  outcome: AiOutcome;
  /** Owner feedback on the thread, if any. */
  feedbackRating: "up" | "down" | null;
}

/**
 * Compute the review reasons for one conversation. Order is stable (tests +
 * UI). Rules:
 *
 *   negative_feedback            the owner gave this thread a thumbs-down.
 *   emergency_without_escalation an emergency was detected but the escalation
 *                                step did not complete (the flag the safety
 *                                postmortem would demand).
 *   ai_failed_repeatedly         ≥ REPEATED_FAILURE_MIN LLM turns fell back to
 *                                the rules backstop (repeated AI failure).
 *   no_contact_captured          ≥ CONTACT_CHANCE_MIN_TURNS classified turns
 *                                and still no name/email/address captured.
 *   high_latency                 the last classification took ≥
 *                                HIGH_LATENCY_MS (LLM timeout territory).
 */
export function computeReviewFlags(inputs: FlagInputs): ReviewReason[] {
  const { outcome, feedbackRating } = inputs;
  const flags: ReviewReason[] = [];
  if (feedbackRating === "down") flags.push("negative_feedback");
  if (outcome.emergencyDetected && !outcome.emergencyEscalated) {
    flags.push("emergency_without_escalation");
  }
  if (outcome.failedTurns >= REPEATED_FAILURE_MIN) flags.push("ai_failed_repeatedly");
  if (outcome.classifiedTurns >= CONTACT_CHANCE_MIN_TURNS && !outcome.capturedContact) {
    flags.push("no_contact_captured");
  }
  if (outcome.lastLatencyMs !== null && outcome.lastLatencyMs >= HIGH_LATENCY_MS) {
    flags.push("high_latency");
  }
  return flags;
}

export const REVIEW_REASON_LABELS: Record<ReviewReason, string> = {
  negative_feedback: "Owner gave negative feedback",
  emergency_without_escalation: "Emergency detected without completed escalation",
  ai_failed_repeatedly: "AI failed repeatedly (rules backstop)",
  no_contact_captured: "No contact info captured after several turns",
  high_latency: "Very slow AI response",
};
