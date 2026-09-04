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

/** Must match the notifications_type_check constraint in migration 007. */
export const NOTIFICATION_TYPES = [
  "new_lead",
  "lead_booked",
  "appointment_requested",
  "appointment_confirmed",
  "appointment_declined",
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
