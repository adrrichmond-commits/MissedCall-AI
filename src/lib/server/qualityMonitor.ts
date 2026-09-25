/**
 * P4-A AI-quality monitoring service — records outcome signals per
 * conversation and maintains the review queue.
 *
 * The SMS pipeline calls recordClassificationTurn() after each classified
 * turn (with the wall-clock latency and the tier outcome) and
 * markEmergencyEscalated() when escalation completes. Recompute then mirrors
 * the rule engine's (src/lib/analytics/quality.ts) current verdict into the
 * ai_review_flags table.
 *
 * Best-effort by design: quality monitoring failure is logged and NEVER
 * fails the conversation (classification, escalation and replies all run
 * without it).
 */
import type { MessageClassification, ReviewReason } from "~/db/schema";
import * as q from "~/db/queries/quality";
import { computeReviewFlags, hasAiActivity, sanitizeAiOutcome } from "~/lib/analytics/quality";

/** Outcome of one classified inbound turn, observed by the pipeline caller. */
export interface TurnObservation {
  classification: MessageClassification;
  /** Wall-clock duration of the classification turn, ms. */
  latencyMs: number;
  /** The LLM tier was configured but failed this turn (rules backstop ran). */
  llmFailed: boolean;
}

/**
 * Record one classified turn and refresh the conversation's review flags.
 * "Captured contact" is honest and concrete: this or any earlier turn
 * extracted a name, an email, or a service address (the customer's phone is
 * known from the SMS itself and not counted as an AI capture).
 */
export async function recordClassificationTurn(
  businessId: string,
  conversationId: string,
  obs: TurnObservation,
): Promise<void> {
  try {
    const c = obs.classification;
    const capturedThisTurn = Boolean(c.contactName || c.contactEmail || c.serviceAddress);
    // Read-modify-write: single worker per inbound message in practice; a
    // lost update only skews counters by one turn (never correctness of the
    // conversation itself).
    const conv = await q.getConversationRaw(businessId, conversationId);
    const current = sanitizeAiOutcome(conv?.aiOutcome);
    await q.mergeAiOutcome(businessId, conversationId, {
      capturedContact: current.capturedContact || capturedThisTurn,
      emergencyDetected: current.emergencyDetected || c.urgency === "emergency",
      classifiedTurns: current.classifiedTurns + 1,
      failedTurns: current.failedTurns + (obs.llmFailed ? 1 : 0),
      lastLatencyMs: obs.latencyMs,
    });
    await recomputeConversationFlags(businessId, conversationId);
  } catch (err) {
    console.log("[quality] turn recording failed (conversation unaffected): " + String(err));
  }
}

/** Emergency escalation completed for this conversation — clear that flag source. */
export async function markEmergencyEscalated(businessId: string, conversationId: string): Promise<void> {
  try {
    await q.mergeAiOutcome(businessId, conversationId, { emergencyEscalated: true, emergencyDetected: true });
  } catch (err) {
    console.log("[quality] escalation stamp failed (conversation unaffected): " + String(err));
  }
}

/**
 * Recompute the review flags for one conversation from its stored signals +
 * feedback and persist the set (replacing unresolved auto flags only).
 */
export async function recomputeConversationFlags(businessId: string, conversationId: string): Promise<void> {
  const conv = await q.getConversationRaw(businessId, conversationId);
  if (!conv) return;
  const outcome = sanitizeAiOutcome(conv.aiOutcome);
  if (!hasAiActivity(outcome) && conv.feedbackRating !== "down") {
    await q.replaceReviewFlags(businessId, conversationId, []);
    return;
  }
  const reasons = computeReviewFlags({ outcome, feedbackRating: conv.feedbackRating });
  const details: Partial<Record<ReviewReason, string>> = {};
  if (reasons.includes("no_contact_captured")) {
    details.no_contact_captured = outcome.classifiedTurns + " AI turns, no name/email/address captured";
  }
  if (reasons.includes("ai_failed_repeatedly")) {
    details.ai_failed_repeatedly = outcome.failedTurns + " turns fell back to the rules engine";
  }
  if (reasons.includes("high_latency")) {
    details.high_latency = "last AI response took " + outcome.lastLatencyMs + "ms";
  }
  await q.replaceReviewFlags(businessId, conversationId, reasons, details);
}
