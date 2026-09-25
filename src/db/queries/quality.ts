/**
 * Server-only queries: P4-A AI-quality monitoring + owner feedback
 * (migration 019).
 *
 *   - per-conversation feedback ("How did MissedCall AI handle this?"):
 *     set/list/aggregate, business-scoped.
 *   - ai_outcome jsonb maintenance: the SMS pipeline merges turn counters,
 *     latency and emergency/contact booleans after each classified turn.
 *   - review flags: rules output (src/lib/analytics/quality.ts) is persisted
 *     per conversation; recomputing REPLACES the unresolved auto flags so a
 *     conversation's flag set always mirrors the current signals. Resolved
 *     flags are never deleted or re-raised by the recompute (a human closed
 *     them; reopening is the human's call).
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it.
 */
import type { AiOutcome, ReviewReason } from "../schema";
import { assertServer, sql } from "./shared";

// ---------------------------------------------------------------------------
// Owner feedback
// ---------------------------------------------------------------------------

export interface ConversationFeedback {
  id: string;
  rating: "up" | "down" | null;
  note: string | null;
  feedbackAt: Date | null;
}

/** Store (or clear, rating=null) the owner's feedback on a conversation. */
export async function setConversationFeedback(
  businessId: string,
  conversationId: string,
  rating: "up" | "down" | null,
  note: string | null,
): Promise<ConversationFeedback | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    UPDATE conversations
    SET feedback_rating = ${rating},
        feedback_note = ${rating === null ? null : note},
        feedback_at = ${rating === null ? null : new Date().toISOString()}
    WHERE id = ${conversationId} AND business_id = ${businessId}
    RETURNING id, feedback_rating, feedback_note, feedback_at`;
  const r = rows[0] as unknown as
    | { id: string; feedback_rating: "up" | "down" | null; feedback_note: string | null; feedback_at: string | null }
    | undefined;
  if (!r) return null;
  return { id: r.id, rating: r.feedback_rating, note: r.feedback_note, feedbackAt: r.feedback_at === null ? null : new Date(r.feedback_at) };
}

export interface FeedbackListItem {
  conversationId: string;
  customerPhone: string;
  leadName: string | null;
  rating: "up" | "down";
  note: string | null;
  feedbackAt: Date;
}

/** A business's feedback entries, newest first. */
export async function listConversationFeedback(businessId: string, limit = 50): Promise<FeedbackListItem[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT c.id, c.customer_phone, c.feedback_rating, c.feedback_note, c.feedback_at,
           l.contact_name AS lead_name
    FROM conversations c
    LEFT JOIN leads l ON l.id = c.lead_id
    WHERE c.business_id = ${businessId} AND c.feedback_rating IS NOT NULL
    ORDER BY c.feedback_at DESC
    LIMIT ${limit}`;
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    conversationId: String(r.id),
    customerPhone: String(r.customer_phone),
    leadName: (r.lead_name as string | null) ?? null,
    rating: r.feedback_rating as "up" | "down",
    note: (r.feedback_note as string | null) ?? null,
    feedbackAt: new Date(r.feedback_at as string),
  }));
}

// ---------------------------------------------------------------------------
// AI outcome signals
// ---------------------------------------------------------------------------

/** Raw conversation row (business-scoped) for the monitor's read-modify-write. */
export async function getConversationRaw(
  businessId: string,
  conversationId: string,
): Promise<{ id: string; aiOutcome: unknown; feedbackRating: "up" | "down" | null } | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT id, ai_outcome, feedback_rating
    FROM conversations
    WHERE id = ${conversationId} AND business_id = ${businessId}
    LIMIT 1`;
  const r = rows[0] as unknown as { id: string; ai_outcome: unknown; feedback_rating: "up" | "down" | null } | undefined;
  if (!r) return null;
  return { id: r.id, aiOutcome: r.ai_outcome, feedbackRating: r.feedback_rating };
}

/** Merge the pipeline's observed turn outcome into conversations.ai_outcome. */
export async function mergeAiOutcome(
  businessId: string,
  conversationId: string,
  patch: Partial<AiOutcome>,
): Promise<void> {
  assertServer();
  const db = sql();
  await db`
    UPDATE conversations
    SET ai_outcome = COALESCE(ai_outcome, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb
    WHERE id = ${conversationId} AND business_id = ${businessId}`;
}

// ---------------------------------------------------------------------------
// Review flags
// ---------------------------------------------------------------------------

/**
 * Replace a conversation's UNRESOLVED auto flags with the current rule
 * output. Flags the owner already resolved are left alone. Returns the
 * conversation's open flags after the recompute.
 */
export async function replaceReviewFlags(
  businessId: string,
  conversationId: string,
  reasons: ReviewReason[],
  details: Partial<Record<ReviewReason, string>> = {},
): Promise<void> {
  assertServer();
  const db = sql();
  await db.query(`BEGIN`);
  try {
    await db.query(
      `DELETE FROM ai_review_flags
       WHERE business_id = $1 AND conversation_id = $2 AND resolved = false`,
      [businessId, conversationId],
    );
    for (const reason of reasons) {
      await db.query(
        `INSERT INTO ai_review_flags (business_id, conversation_id, reason, detail)
         VALUES ($1, $2, $3, $4)`,
        [businessId, conversationId, reason, details[reason] ?? null],
      );
    }
    await db.query(`COMMIT`);
  } catch (err) {
    await db.query(`ROLLBACK`).catch(() => undefined);
    throw err;
  }
}

export interface ReviewFlagItem {
  id: string;
  conversationId: string;
  reason: ReviewReason;
  detail: string | null;
  createdAt: Date;
  customerPhone: string;
  leadName: string | null;
}

/** Open (or resolved) review flags for a business, newest first. */
export async function listReviewFlags(businessId: string, opts: { resolved?: boolean; limit?: number } = {}): Promise<ReviewFlagItem[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT f.id, f.conversation_id, f.reason, f.detail, f.created_at,
           c.customer_phone, l.contact_name AS lead_name
    FROM ai_review_flags f
    JOIN conversations c ON c.id = f.conversation_id
    LEFT JOIN leads l ON l.id = c.lead_id
    WHERE f.business_id = ${businessId}
      AND f.resolved = ${opts.resolved ?? false}
    ORDER BY f.created_at DESC
    LIMIT ${opts.limit ?? 50}`;
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    conversationId: String(r.conversation_id),
    reason: r.reason as ReviewReason,
    detail: (r.detail as string | null) ?? null,
    createdAt: new Date(r.created_at as string),
    customerPhone: String(r.customer_phone),
    leadName: (r.lead_name as string | null) ?? null,
  }));
}

/** Resolve a flag (records who + when). Returns whether a row changed. */
export async function resolveReviewFlag(
  businessId: string,
  flagId: string,
  resolvedBy: string | null,
): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`
    UPDATE ai_review_flags
    SET resolved = true, resolved_by = ${resolvedBy}, resolved_at = ${new Date().toISOString()}
    WHERE id = ${flagId} AND business_id = ${businessId} AND resolved = false
    RETURNING id`;
  return rows.length > 0;
}

/** Count of open review flags for a business (queue-depth badge). */
export async function countOpenReviewFlags(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT COUNT(*)::int AS n FROM ai_review_flags
    WHERE business_id = ${businessId} AND resolved = false`;
  return Number((rows[0] as unknown as { n: number } | undefined)?.n ?? 0);
}

/**
 * Cross-business open-flag count for the admin health surface (deliberately
 * not business-scoped — platform-owner telemetry).
 */
export async function countOpenReviewFlagsAll(): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT COUNT(*)::int AS n FROM ai_review_flags WHERE resolved = false`;
  return Number((rows[0] as unknown as { n: number } | undefined)?.n ?? 0);
}

/** A business's conversations that have ai_outcome (the AI ran at least once). */
export async function aiOutcomeStats(businessId: string): Promise<{
  conversationsWithAi: number;
  classifiedTurns: number;
  failedTurns: number;
  avgLatencyMs: number | null;
  emergencyDetected: number;
  capturedContact: number;
}> {
  assertServer();
  const db = sql();
  const rows = (await db`
    SELECT
      COUNT(*)::int AS conversations_with_ai,
      COALESCE(SUM((ai_outcome->>'classifiedTurns')::int), 0)::int AS classified_turns,
      COALESCE(SUM((ai_outcome->>'failedTurns')::int), 0)::int AS failed_turns,
      AVG(NULLIF(ai_outcome->>'lastLatencyMs', '')::numeric) AS avg_latency,
      COUNT(*) FILTER (WHERE (ai_outcome->>'emergencyDetected')::boolean IS TRUE)::int AS emergency_detected,
      COUNT(*) FILTER (WHERE (ai_outcome->>'capturedContact')::boolean IS TRUE)::int AS captured_contact
    FROM conversations
    WHERE business_id = ${businessId} AND ai_outcome IS NOT NULL`) as unknown as {
    conversations_with_ai: number;
    classified_turns: number;
    failed_turns: number;
    avg_latency: string | null;
    emergency_detected: number;
    captured_contact: number;
  }[];
  const r = rows[0];
  return {
    conversationsWithAi: Number(r?.conversations_with_ai ?? 0),
    classifiedTurns: Number(r?.classified_turns ?? 0),
    failedTurns: Number(r?.failed_turns ?? 0),
    avgLatencyMs: r?.avg_latency !== null && r?.avg_latency !== undefined ? Math.round(Number(r.avg_latency)) : null,
    emergencyDetected: Number(r?.emergency_detected ?? 0),
    capturedContact: Number(r?.captured_contact ?? 0),
  };
}
