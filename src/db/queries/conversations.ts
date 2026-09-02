/**
 * Server-only queries: conversations and messages (the AI SMS threads).
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it. Message
 * reads join through conversations so a foreign conversation id cannot leak rows.
 */
import type { Conversation, ConversationStatus, Message, MessageDirection, MessageStatus } from "../schema";
import { assertServer, listClause, sql, type ListOptions } from "./shared";

export interface ConversationFilters {
  status?: ConversationStatus;
  /** Matches customer phone or summary. */
  search?: string;
}

export interface CreateConversationInput {
  leadId?: string | null;
  customerPhone: string;
  status?: ConversationStatus;
  summary?: string | null;
}

export interface UpdateConversationInput {
  status?: ConversationStatus;
  summary?: string | null;
  leadId?: string | null;
}

const FILTERABLE_STATUS: ConversationStatus[] = ["active", "awaiting_customer", "booked", "closed"];

function conversationWhere(
  businessId: string,
  f: ConversationFilters,
): { text: string; values: unknown[] } {
  const values: unknown[] = [businessId];
  const clauses = ["business_id = $1"];
  if (f.status && FILTERABLE_STATUS.includes(f.status)) {
    values.push(f.status);
    clauses.push(`status = $${values.length}`);
  }
  if (f.search && f.search.trim()) {
    const like = `%${f.search.trim()}%`;
    values.push(like);
    const n = values.length;
    clauses.push(`(customer_phone ILIKE $${n} OR summary ILIKE $${n})`);
  }
  return { text: clauses.join(" AND "), values };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function getConversation(businessId: string, conversationId: string): Promise<Conversation | null> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM conversations WHERE id = ${conversationId} AND business_id = ${businessId} LIMIT 1`;
  return (rows[0] as unknown as Conversation | undefined) ?? null;
}

export async function listConversations(
  businessId: string,
  filters: ConversationFilters = {},
  opts?: ListOptions,
): Promise<Conversation[]> {
  assertServer();
  const { limit, offset, order } = listClause(opts);
  const dir = order === "asc" ? "ASC" : "DESC"; // whitelisted
  const w = conversationWhere(businessId, filters);
  const db = sql();
  const rows = await db.query(
    `SELECT * FROM conversations WHERE ${w.text} ORDER BY updated_at ${dir} LIMIT ${limit} OFFSET ${offset}`,
    w.values,
  );
  return rows as unknown as Conversation[];
}

export async function countConversations(
  businessId: string,
  filters: ConversationFilters = {},
): Promise<number> {
  assertServer();
  const w = conversationWhere(businessId, filters);
  const db = sql();
  const rows = await db.query(`SELECT count(*) AS n FROM conversations WHERE ${w.text}`, w.values);
  return Number((rows[0] as unknown as { n: unknown }).n);
}

export async function countConversationsByStatus(businessId: string): Promise<Record<ConversationStatus, number>> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT status, count(*) AS n FROM conversations WHERE business_id = ${businessId} GROUP BY status`;
  const out: Record<ConversationStatus, number> = { active: 0, awaiting_customer: 0, booked: 0, closed: 0 };
  for (const row of rows as unknown as { status: ConversationStatus; n: unknown }[]) {
    out[row.status] = Number(row.n);
  }
  return out;
}

/** Every conversation linked to one lead (lead detail page). */
export async function listConversationsByLead(businessId: string, leadId: string): Promise<Conversation[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM conversations
    WHERE business_id = ${businessId} AND lead_id = ${leadId}
    ORDER BY updated_at DESC`;
  return rows as unknown as Conversation[];
}

/** Which of the given lead ids (this business only) have a conversation. */
export async function leadIdsWithConversations(businessId: string, leadIds: string[]): Promise<Set<string>> {
  assertServer();
  if (leadIds.length === 0) return new Set();
  const db = sql();
  const placeholders = leadIds.map((_, i) => `$${i + 2}`).join(", ");
  const rows = await db.query(
    `SELECT DISTINCT lead_id FROM conversations WHERE business_id = $1 AND lead_id IN (${placeholders})`,
    [businessId, ...leadIds],
  );
  return new Set((rows as unknown as { lead_id: string }[]).map((r) => r.lead_id));
}

export interface ConversationSummaryRow {
  id: string;
  status: ConversationStatus;
  summary: string | null;
  messageCount: number;
  lastMessageAt: Date | null;
}

/** Per-conversation stats for one lead's detail page (single query, no N+1). */
export async function conversationSummariesForLead(
  businessId: string,
  leadId: string,
): Promise<ConversationSummaryRow[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT c.id, c.status, c.summary,
           (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
           (SELECT max(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at
    FROM conversations c
    WHERE c.business_id = ${businessId} AND c.lead_id = ${leadId}
    ORDER BY c.updated_at DESC`;
  return (rows as unknown as {
    id: string; status: ConversationStatus; summary: string | null;
    message_count: unknown; last_message_at: Date | null;
  }[]).map((r) => ({
    id: r.id,
    status: r.status,
    summary: r.summary,
    messageCount: Number(r.message_count),
    lastMessageAt: r.last_message_at,
  }));
}

export interface ConversationListItem extends Conversation {
  leadName: string | null;
  serviceNeed: string | null;
  lastMessageBody: string | null;
  lastMessageDirection: MessageDirection | null;
  /** ISO string — the caller (server fn) converts before returning to the client. */
  lastMessageAtRaw: Date | string | null;
  messageCount: number;
}

/**
 * Inbox list rows: conversation + parent lead context + last message preview +
 * message count, in one query. Isolation: `c.business_id = $1` and the lead
 * join is also business-bounded so a foreign lead_id cannot leak names.
 */
export async function listConversationsWithPreview(
  businessId: string,
  filters: ConversationFilters = {},
  opts?: ListOptions,
): Promise<ConversationListItem[]> {
  assertServer();
  const { limit, offset, order } = listClause(opts);
  const dir = order === "asc" ? "ASC" : "DESC"; // whitelisted
  const w = conversationWhere(businessId, filters);
  const db = sql();
  const rows = await db.query(
    `SELECT c.*,
       l.contact_name AS lead_name, l.service_need AS service_need,
       lm.body AS last_message_body, lm.direction AS last_message_direction,
       lm.created_at AS last_message_at_raw,
       (SELECT count(*) FROM messages mc WHERE mc.conversation_id = c.id) AS message_count
     FROM conversations c
     LEFT JOIN leads l ON l.id = c.lead_id AND l.business_id = $1
     LEFT JOIN LATERAL (
       SELECT m.body, m.direction, m.created_at
       FROM messages m WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC LIMIT 1
     ) lm ON true
     WHERE ${w.text}
     ORDER BY c.updated_at ${dir} LIMIT ${limit} OFFSET ${offset}`,
    w.values,
  );
  return rows as unknown as ConversationListItem[];
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function listMessages(
  businessId: string,
  conversationId: string,
  opts?: ListOptions,
): Promise<Message[]> {
  assertServer();
  const { limit, offset, order } = listClause(opts);
  const dir = order === "asc" ? "ASC" : "DESC"; // whitelisted
  const db = sql();
  // Join through conversations: isolation holds even for a foreign conversation id.
  const rows = await db.query(
    `SELECT m.* FROM messages m
     JOIN conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = $1 AND c.business_id = $2
     ORDER BY m.created_at ${dir} LIMIT ${limit} OFFSET ${offset}`,
    [conversationId, businessId],
  );
  return rows as unknown as Message[];
}

export async function countMessages(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT count(*) AS n FROM messages WHERE business_id = ${businessId}`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

export async function countMessagesByDirection(businessId: string): Promise<{ inbound: number; outbound: number }> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT direction, count(*) AS n FROM messages WHERE business_id = ${businessId} GROUP BY direction`;
  const out = { inbound: 0, outbound: 0 };
  for (const row of rows as unknown as { direction: "inbound" | "outbound"; n: unknown }[]) {
    out[row.direction] = Number(row.n);
  }
  return out;
}

export async function getLatestMessage(businessId: string, conversationId: string): Promise<Message | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT m.* FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.conversation_id = ${conversationId} AND c.business_id = ${businessId}
    ORDER BY m.created_at DESC LIMIT 1`;
  return (rows[0] as unknown as Message | undefined) ?? null;
}

export async function appendMessage(input: {
  businessId: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  body: string;
  status?: MessageStatus;
  sentAt?: Date | null;
  externalId?: string | null;
}): Promise<Message> {
  assertServer();
  // Verify the conversation belongs to this business before writing.
  const owner = await getConversation(input.businessId, input.conversationId);
  if (!owner) throw new Error("Conversation not found for this business");
  const db = sql();
  const rows = await db.query(
    `INSERT INTO messages (business_id, conversation_id, direction, body, status, sent_at, external_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      input.businessId,
      input.conversationId,
      input.direction,
      input.body,
      input.status ?? "sent",
      (input.sentAt ?? new Date()).toISOString(),
      input.externalId ?? null,
    ],
  );
  // Touch the parent conversation so "updated_at" ordering follows activity.
  await db`UPDATE conversations SET updated_at = now() WHERE id = ${input.conversationId}`;
  return rows[0] as unknown as Message;
}

export async function updateMessageStatus(
  businessId: string,
  messageId: string,
  status: MessageStatus,
): Promise<Message | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    UPDATE messages SET status = ${status}
    WHERE id = ${messageId} AND business_id = ${businessId}
    RETURNING *`;
  return (rows[0] as unknown as Message | undefined) ?? null;
}

export async function createConversation(businessId: string, input: CreateConversationInput): Promise<Conversation> {
  assertServer();
  const db = sql();
  const rows = await db`
    INSERT INTO conversations (business_id, lead_id, customer_phone, status, summary)
    VALUES (${businessId}, ${input.leadId ?? null}, ${input.customerPhone}, ${input.status ?? "active"}, ${input.summary ?? null})
    RETURNING *`;
  return rows[0] as unknown as Conversation;
}

export async function updateConversation(
  businessId: string,
  conversationId: string,
  input: UpdateConversationInput,
): Promise<Conversation | null> {
  assertServer();
  const snake = (k: string): string => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const allowed = ["status", "summary", "leadId"] as const;
  const cols = Object.keys(input).filter((k) => (allowed as readonly string[]).includes(k));
  if (cols.length === 0) return getConversation(businessId, conversationId);
  const sets = cols.map((k, i) => `${snake(k)} = $${i + 3}`).join(", ");
  const values = cols.map((k) => input[k as keyof UpdateConversationInput]);
  const db = sql();
  const rows = await db.query(
    `UPDATE conversations SET ${sets} WHERE id = $1 AND business_id = $2 RETURNING *`,
    [conversationId, businessId, ...values],
  );
  return (rows[0] as unknown as Conversation | undefined) ?? null;
}

export async function deleteConversation(businessId: string, conversationId: string): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`DELETE FROM conversations WHERE id = ${conversationId} AND business_id = ${businessId} RETURNING id`;
  return rows.length > 0;
}
