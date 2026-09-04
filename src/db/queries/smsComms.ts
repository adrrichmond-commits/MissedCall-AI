/**
 * Server-only queries: SMS opt-outs and message classification (migration 008,
 * Phase 2 build #4).
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it —
 * the WHERE clause is the isolation boundary.
 *
 * THE OPT-OUT RULE (non-negotiable, TCPA/10DLC): a row in sms_opt_outs means
 * NOTHING goes out to that phone for this business, ever. Every outbound-SMS
 * call site must consult isSmsOptedOut() first; the send helpers in
 * src/lib/server/textBack.ts do, and any future sender must too.
 */
import type { MessageClassification, SmsOptOut } from "../schema";
import { assertServer, sql } from "./shared";

// ---------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------

/** True when this phone must never be texted by this business again. */
export async function isSmsOptedOut(businessId: string, phone: string): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT 1 AS one FROM sms_opt_outs
    WHERE business_id = ${businessId} AND phone = ${phone}
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * Persist a STOP opt-out. Idempotent (unique business+phone): re-STOPing an
 * already-opted-out number is a no-op and never duplicates the row.
 */
export async function addSmsOptOut(
  businessId: string,
  input: { phone: string; reason?: "stop_reply" | "owner_added"; sourceMessageSid?: string | null },
): Promise<SmsOptOut> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    `INSERT INTO sms_opt_outs (business_id, phone, reason, source_message_sid)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, phone) DO UPDATE
       SET reason = EXCLUDED.reason,
           source_message_sid = coalesce(sms_opt_outs.source_message_sid, EXCLUDED.source_message_sid)
     RETURNING *`,
    [businessId, input.phone, input.reason ?? "stop_reply", input.sourceMessageSid ?? null],
  );
  return rows[0] as unknown as SmsOptOut;
}

/**
 * Persist an explicit START/UNSTOP resubscribe: removes the opt-out row.
 * Returns true when a row was removed (the caller may reply confirming).
 */
export async function removeSmsOptOut(businessId: string, phone: string): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`
    DELETE FROM sms_opt_outs
    WHERE business_id = ${businessId} AND phone = ${phone}
    RETURNING id`;
  return rows.length > 0;
}

export async function listSmsOptOuts(businessId: string): Promise<SmsOptOut[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM sms_opt_outs
    WHERE business_id = ${businessId}
    ORDER BY created_at DESC
    LIMIT 500`;
  return rows as unknown as SmsOptOut[];
}

// ---------------------------------------------------------------------------
// Message classification (LLM parse)
// ---------------------------------------------------------------------------

/** Stamp the LLM parse on an inbound message and mark it classified. */
export async function setMessageClassification(
  businessId: string,
  messageId: string,
  classification: MessageClassification,
): Promise<void> {
  assertServer();
  const db = sql();
  await db.query(
    `UPDATE messages
     SET status = 'delivered', classification = $3::jsonb
     WHERE id = $1 AND business_id = $2`,
    [messageId, businessId, JSON.stringify(classification)],
  );
}
