/**
 * Server-only queries: SMS workflow safeguard state (migration 017, P4-S).
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it —
 * the WHERE clause is the isolation boundary.
 *
 * This module stores STATE, not configuration: one sms_workflow_sends row per
 * evaluated send attempt (sent / failed / suppressed) — the audit trail AND
 * the data duplicate-suppression and per-customer caps are computed from —
 * plus sms_invalid_numbers (stop texting, surface honestly). Configuration
 * lives in businesses.settings (see src/lib/smsWorkflows.ts).
 */
import type { SmsInvalidNumber, SmsWorkflowSend } from "../schema";
import { assertServer, sql } from "./shared";

/** Record one evaluated workflow send attempt. Outcome is honest: 'sent' rows
 *  carry provider_sid and are the ONLY rows counted by suppression/caps.
 *  sentAt is the engine's decision time (defaults to insert time). */
export async function recordWorkflowSend(
  businessId: string,
  input: {
    workflowKey: string;
    phone: string;
    recipient: "customer" | "owner";
    outcome: string;
    suppressReason?: string | null;
    body?: string | null;
    providerSid?: string | null;
    leadId?: string | null;
    appointmentId?: string | null;
    conversationId?: string | null;
    /** The engine's decision time; stamps created_at (defaults to insert time). */
    sentAt?: Date | null;
  },
): Promise<void> {
  assertServer();
  const db = sql();
  await db.query(
    `INSERT INTO sms_workflow_sends
       (business_id, workflow_key, phone, recipient, outcome, suppress_reason,
        body, provider_sid, lead_id, appointment_id, conversation_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      businessId,
      input.workflowKey,
      input.phone,
      input.recipient,
      input.outcome,
      input.suppressReason ?? null,
      input.body ?? null,
      input.providerSid ?? null,
      input.leadId ?? null,
      input.appointmentId ?? null,
      input.conversationId ?? null,
      input.sentAt ?? new Date(),
    ],
  );
}

/** Most recent successful ('sent') send for this customer+workflow, or null. */
export async function lastWorkflowSentAt(
  businessId: string,
  phone: string,
  workflowKey: string,
): Promise<Date | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT created_at FROM sms_workflow_sends
    WHERE business_id = ${businessId} AND phone = ${phone}
      AND workflow_key = ${workflowKey} AND outcome = 'sent'
    ORDER BY created_at DESC
    LIMIT 1`;
  const row = rows[0] as unknown as { created_at: Date | string } | undefined;
  if (!row) return null;
  return row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
}

/** Successful workflow sends to this phone since a cutoff (rolling cap window). */
export async function countWorkflowSentsForPhoneSince(
  businessId: string,
  phone: string,
  since: Date,
): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT count(*) AS n FROM sms_workflow_sends
    WHERE business_id = ${businessId} AND phone = ${phone}
      AND outcome = 'sent' AND created_at >= ${since.toISOString()}`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

/** True when a workflow already went out for a specific appointment (reminder/confirmation dedup). */
export async function workflowSentForAppointment(
  businessId: string,
  appointmentId: string,
  workflowKey: string,
): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT 1 AS one FROM sms_workflow_sends
    WHERE business_id = ${businessId} AND appointment_id = ${appointmentId}
      AND workflow_key = ${workflowKey} AND outcome = 'sent'
    LIMIT 1`;
  return rows.length > 0;
}

/** True when a workflow already went out for a specific lead (welcome/follow-up dedup). */
export async function workflowSentForLead(
  businessId: string,
  leadId: string,
  workflowKey: string,
): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT 1 AS one FROM sms_workflow_sends
    WHERE business_id = ${businessId} AND lead_id = ${leadId}
      AND workflow_key = ${workflowKey} AND outcome = 'sent'
    LIMIT 1`;
  return rows.length > 0;
}

/** Workflow send audit rows for one business (newest first). */
export async function listWorkflowSends(
  businessId: string,
  opts?: { limit?: number },
): Promise<SmsWorkflowSend[]> {
  assertServer();
  const db = sql();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const rows = await db`
    SELECT * FROM sms_workflow_sends
    WHERE business_id = ${businessId}
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  return rows as unknown as SmsWorkflowSend[];
}

// ---------------------------------------------------------------------------
// Invalid numbers
// ---------------------------------------------------------------------------

/** Mark a number non-textable for this business. Idempotent (unique pair):
 *  the first reason wins so the UI always shows how it was first detected. */
export async function markInvalidNumber(
  businessId: string,
  phone: string,
  reason: string,
): Promise<void> {
  assertServer();
  const db = sql();
  await db.query(
    `INSERT INTO sms_invalid_numbers (business_id, phone, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id, phone) DO NOTHING`,
    [businessId, phone, reason],
  );
}

/** True when this number was detected invalid for this business. */
export async function isInvalidNumber(businessId: string, phone: string): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT 1 AS one FROM sms_invalid_numbers
    WHERE business_id = ${businessId} AND phone = ${phone}
    LIMIT 1`;
  return rows.length > 0;
}

export async function listInvalidNumbers(businessId: string): Promise<SmsInvalidNumber[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM sms_invalid_numbers
    WHERE business_id = ${businessId}
    ORDER BY detected_at DESC
    LIMIT 200`;
  return rows as unknown as SmsInvalidNumber[];
}

/** Clear a wrongly-flagged number (owner action in settings). */
export async function clearInvalidNumber(businessId: string, phone: string): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`
    DELETE FROM sms_invalid_numbers
    WHERE business_id = ${businessId} AND phone = ${phone}
    RETURNING id`;
  return rows.length > 0;
}

/**
 * DELIBERATELY CROSS-BUSINESS (like login email lookup / getBusinessByPhoneKey):
 * the P4-S cron sweep walks every business's due workflow sends and carries no
 * session — only the CRON_SECRET guard. Used exclusively by
 * src/routes/api/cron/sms-workflows.ts. Returns only the ids the sweep needs.
 */
export async function listBusinessSummaries(): Promise<{ id: string }[]> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT id FROM businesses ORDER BY created_at ASC LIMIT 500`;
  return rows as unknown as { id: string }[];
}
