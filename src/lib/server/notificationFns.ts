/**
 * Server functions for the in-app notification center (Phase 2 build #3).
 *
 * The unread count + recent feed power the bell in the app shell; the client
 * refetches on navigation and polls every 30s (no websockets — honest
 * polling). Every handler resolves businessId from the authenticated session
 * via requireAuth; notification ids from the client are always scoped by the
 * business_id WHERE clause, so cross-business ids are no-ops (null / 0).
 *
 * In-app delivery is unconditional. The email/SMS notification prefs from
 * onboarding/build #2 gate provider channels that don't exist yet — they are
 * surfaced in Settings and referenced (honestly) in the bell dropdown footer.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "~/lib/server/auth.server";
import { authErrorToResult } from "~/lib/server/sessionFns";
import * as q from "~/db/queries";
import type { AppResult } from "~/lib/server/appFns";

export interface NotificationView {
  id: string;
  type: string;
  payload: {
    leadId?: string;
    leadName?: string;
    serviceNeed?: string;
    appointmentId?: string;
    scheduledAt?: string;
    priority?: string;
  };
  readAt: string | null;
  createdAt: string;
}

export interface NotificationsData {
  unreadCount: number;
  notifications: NotificationView[];
}

export const getNotificationsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AppResult<NotificationsData>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const [unread, rows] = await Promise.all([
        q.countUnreadNotifications(businessId),
        q.listNotifications(businessId, { limit: 15, order: "desc" }),
      ]);
      return {
        ok: true,
        data: {
          unreadCount: unread,
          notifications: rows.map((n) => ({
            id: n.id,
            type: n.type,
            payload: (n.payload ?? {}) as NotificationView["payload"],
            readAt: n.readAt ? n.readAt.toISOString() : null,
            createdAt: n.createdAt.toISOString(),
          })),
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);

export const markNotificationReadFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { notificationId?: unknown })
  .handler(async ({ data }): Promise<AppResult<{ marked: boolean; unreadCount: number }>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const id = typeof data?.notificationId === "string" ? data.notificationId.trim() : "";
      if (!id) return { ok: false, status: 400, error: "Missing notification." };
      const updated = await q.markNotificationRead(businessId, id);
      const unread = await q.countUnreadNotifications(businessId);
      return { ok: true, data: { marked: updated !== null, unreadCount: unread } };
    } catch (e) {
      return authErrorToResult(e);
    }
  });

export const markAllNotificationsReadFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<AppResult<{ marked: number; unreadCount: number }>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const marked = await q.markAllNotificationsRead(businessId);
      return { ok: true, data: { marked, unreadCount: 0 } };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);
