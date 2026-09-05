/**
 * Server-only queries: the in-app notification center feed (migration 007).
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it.
 *
 * Event types are whitelisted by the DB CHECK (notifications_type_check);
 * payloads are small JSON blobs (lead/appointment ids + display fields) so
 * the dropdown renders and links without extra joins. In-app delivery is
 * unconditional — the email/SMS notification prefs in businesses.settings
 * gate provider channels that do not exist yet, never the in-app feed.
 */
import type { Notification } from "../schema";
import { assertServer, listClause, sql, type ListOptions } from "./shared";

/** Must match the notifications_type_check constraint (007, widened by 009). */
export const NOTIFICATION_TYPES = [
  "new_lead",
  "lead_booked",
  "appointment_requested",
  "appointment_confirmed",
  "appointment_declined",
  "payment_failed",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationPayload {
  leadId?: string;
  leadName?: string;
  serviceNeed?: string;
  appointmentId?: string;
  scheduledAt?: string;
  priority?: string;
  [key: string]: unknown;
}

export interface CreateNotificationInput {
  type: NotificationType;
  payload?: NotificationPayload;
}

export async function createNotification(
  businessId: string,
  input: CreateNotificationInput,
): Promise<Notification> {
  assertServer();
  if (!(NOTIFICATION_TYPES as readonly string[]).includes(input.type)) {
    throw new Error(`Unknown notification type: ${String(input.type)}`);
  }
  const db = sql();
  const rows = await db.query(
    `INSERT INTO notifications (business_id, type, payload)
     VALUES ($1, $2, $3::jsonb)
     RETURNING *`,
    [businessId, input.type, JSON.stringify(input.payload ?? {})],
  );
  return rows[0] as unknown as Notification;
}

// ---------------------------------------------------------------------------
// Email delivery accounting (Phase 2 build #6, migration 010)
// ---------------------------------------------------------------------------

/** The notification types the fire-and-forget email hook covers (build #6). */
export const EMAIL_DELIVERY_TYPES = [
  "new_lead",
  "appointment_requested",
  "payment_failed",
] as const;
export type EmailDeliveryType = (typeof EMAIL_DELIVERY_TYPES)[number];

export function isEmailDeliveryType(type: NotificationType): boolean {
  return (EMAIL_DELIVERY_TYPES as readonly string[]).includes(type);
}

/**
 * Stamp email_sent_at on a notification — ONLY after the provider accepted a
 * send. This is the double-send guard: the delivery hook skips notifications
 * where this is already set. Business-scoped.
 */
export async function markNotificationEmailed(
  businessId: string,
  notificationId: string,
): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    `UPDATE notifications SET email_sent_at = now()
     WHERE id = $1 AND business_id = $2 AND email_sent_at IS NULL
     RETURNING id`,
    [notificationId, businessId],
  );
  return rows.length > 0;
}

/** True when a notification already had a successful email send (double-send guard). */
export async function isNotificationEmailed(
  businessId: string,
  notificationId: string,
): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    `SELECT email_sent_at FROM notifications WHERE id = $1 AND business_id = $2 LIMIT 1`,
    [notificationId, businessId],
  );
  const row = rows[0] as unknown as { emailSentAt: Date | null } | undefined;
  return row != null && row.emailSentAt != null;
}

/**
 * Owner email for delivery: the most senior user of the business
 * (owner, then manager, then employee — deterministic on ties by oldest
 * account). Business-scoped; null when the business has no active user.
 */
export async function getBusinessOwnerEmail(businessId: string): Promise<string | null> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    `SELECT email FROM users
     WHERE business_id = $1 AND is_active = true
     ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, created_at ASC
     LIMIT 1`,
    [businessId],
  );
  const row = rows[0] as unknown as { email: string } | undefined;
  return row?.email ?? null;
}

export async function listNotifications(
  businessId: string,
  opts?: ListOptions,
): Promise<Notification[]> {
  assertServer();
  const { limit, offset, order } = listClause(opts);
  const dir = order === "asc" ? "ASC" : "DESC"; // whitelisted
  const db = sql();
  const rows = await db.query(
    `SELECT * FROM notifications WHERE business_id = $1
     ORDER BY created_at ${dir} LIMIT ${limit} OFFSET ${offset}`,
    [businessId],
  );
  return rows as unknown as Notification[];
}

export async function countUnreadNotifications(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT count(*) AS n FROM notifications
    WHERE business_id = ${businessId} AND read_at IS NULL`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

export async function countNotifications(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT count(*) AS n FROM notifications WHERE business_id = ${businessId}`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

/** Mark one notification read (business-scoped). Returns the updated row. */
export async function markNotificationRead(
  businessId: string,
  notificationId: string,
): Promise<Notification | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    UPDATE notifications SET read_at = now()
    WHERE id = ${notificationId} AND business_id = ${businessId} AND read_at IS NULL
    RETURNING *`;
  return (rows[0] as unknown as Notification | undefined) ?? null;
}

/** Mark every unread notification read (business-scoped). Returns rows affected. */
export async function markAllNotificationsRead(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    UPDATE notifications SET read_at = now()
    WHERE business_id = ${businessId} AND read_at IS NULL
    RETURNING id`;
  return rows.length;
}
