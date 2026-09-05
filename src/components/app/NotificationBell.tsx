import { useCallback, useEffect, useRef, useState } from "react";
import {
  getNotificationsFn,
  markAllNotificationsReadFn,
  markNotificationReadFn,
  type NotificationView,
} from "~/lib/server/notificationFns";
import { formatRelative } from "~/lib/format";

/**
 * In-app notification center bell (Phase 2 build #3). Lives in the app shell
 * so the unread count is visible from every app page. "Real-time feel"
 * WITHOUT real-time infra: the feed refetches on app navigation and polls
 * every 30 seconds while the page is open — no websockets, stated honestly.
 *
 * Provider channels (email/SMS) stay honest placeholders: the footer states
 * they switch on with provider setup; in-app delivery is the real thing.
 */

const TYPE_META: Record<
  string,
  { icon: string; label: string; tone: string; href: (p: NotificationView["payload"]) => string | null }
> = {
  new_lead: {
    icon: "M13 10V3L4 14h7v7l9-11h-7z",
    label: "New lead",
    tone: "bg-brand-50 text-brand-700",
    href: (p) => (p.leadId ? `/leads/${p.leadId}` : null),
  },
  lead_booked: {
    icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
    label: "Lead booked",
    tone: "bg-emerald-50 text-emerald-700",
    href: (p) => (p.leadId ? `/leads/${p.leadId}` : null),
  },
  appointment_requested: {
    icon: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
    label: "Appointment requested",
    tone: "bg-amber-50 text-amber-800",
    href: (p) => (p.appointmentId ? "/appointments" : null),
  },
  appointment_confirmed: {
    icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
    label: "Appointment confirmed",
    tone: "bg-emerald-50 text-emerald-700",
    href: (p) => (p.appointmentId ? "/appointments" : null),
  },
  appointment_declined: {
    icon: "M10 14L21 3m-9.375 4.5h-3A2.25 2.25 0 006 9.75v10.5A2.25 2.25 0 008.25 22.5h7.5A2.25 2.25 0 0018 20.25V9.75a2.25 2.25 0 00-2.25-2.25h-3",
    label: "Appointment declined",
    tone: "bg-red-50 text-red-700",
    href: (p) => (p.appointmentId ? "/appointments" : null),
  },
};

const POLL_MS = 30_000;

export function NotificationBell({ pathname }: { pathname: string }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await getNotificationsFn();
      if (res.ok) {
        setUnread(res.data.unreadCount);
        setItems(res.data.notifications);
        setLoaded(true);
      }
    } catch {
      // Silent: the bell is a convenience surface; page loads must not break.
    }
  }, []);

  // Refetch on navigation (pathname change) + poll while mounted.
  useEffect(() => {
    let alive = true;
    void refresh();
    const t = setInterval(() => {
      if (alive) void refresh();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refresh, pathname]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function markRead(id: string) {
    setBusyId(id);
    try {
      const res = await markNotificationReadFn({ data: { notificationId: id } });
      if (res.ok) {
        setUnread(res.data.unreadCount);
        setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
      }
    } finally {
      setBusyId(null);
    }
  }

  async function markAll() {
    try {
      const res = await markAllNotificationsReadFn();
      if (res.ok) {
        setUnread(0);
        setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      }
    } catch {
      // Leave state as-is on failure; the next poll corrects the count.
    }
  }

  function itemHref(n: NotificationView): string | null {
    return TYPE_META[n.type]?.href(n.payload) ?? null;
  }

  const bell = (
    <button
      type="button"
      data-testid="notification-bell"
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      aria-expanded={open}
      onClick={() => setOpen((v) => !v)}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5" aria-hidden="true">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
        />
      </svg>
      {unread > 0 ? (
        <span
          data-testid="notification-unread-count"
          className={`absolute -top-1 -right-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[11px] font-bold text-white ring-2 ring-white ${
            unread > 9 ? "text-[10px]" : ""
          }`}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </button>
  );

  const dropdown = open ? (
    <div
      data-testid="notification-dropdown"
      className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-lg sm:w-96"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <p className="text-sm font-semibold text-slate-900">Notifications</p>
        {unread > 0 ? (
          <button
            type="button"
            onClick={() => void markAll()}
            className="text-xs font-semibold text-brand-700 hover:text-brand-800"
          >
            Mark all read
          </button>
        ) : (
          <span className="text-xs text-slate-400">All caught up</span>
        )}
      </div>
      <div className="max-h-96 overflow-y-auto">
        {!loaded ? (
          <p className="px-4 py-6 text-center text-sm text-slate-400">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500">
            Nothing yet. New leads, bookings, and appointment requests land here.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((n) => {
              const meta = TYPE_META[n.type];
              const href = itemHref(n);
              const isUnread = n.readAt === null;
              return (
                <li key={n.id} className={isUnread ? "bg-brand-50/40" : ""}>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${meta?.tone ?? "bg-slate-100 text-slate-600"}`}>
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-4 w-4" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" d={meta?.icon ?? "M12 8v4m0 4h.01"} />
                      </svg>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className={`truncate text-sm ${isUnread ? "font-semibold text-slate-900" : "text-slate-700"}`}>
                          {meta?.label ?? n.type}
                          {n.payload.leadName ? ` — ${n.payload.leadName}` : ""}
                        </p>
                        {isUnread ? <span className="h-2 w-2 shrink-0 rounded-full bg-brand-600" aria-label="Unread" /> : null}
                      </div>
                      {n.payload.serviceNeed ? (
                        <p className="truncate text-xs text-slate-500">{n.payload.serviceNeed}</p>
                      ) : null}
                      <p className="mt-0.5 text-xs text-slate-400">{formatRelative(n.createdAt)}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {isUnread ? (
                        <button
                          type="button"
                          disabled={busyId === n.id}
                          onClick={() => void markRead(n.id)}
                          className="text-xs font-semibold text-slate-500 hover:text-brand-700 disabled:opacity-50"
                        >
                          {busyId === n.id ? "…" : "Mark read"}
                        </button>
                      ) : null}
                      {href ? (
                        <a
                          href={href}
                          onClick={() => setOpen(false)}
                          className="text-xs font-semibold text-brand-700 hover:text-brand-800"
                        >
                          Open →
                        </a>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="border-t border-slate-100 bg-slate-50 px-4 py-2.5">
        <p className="text-xs text-slate-500">
          In-app notifications are live. Email delivery activates when EMAIL_API_KEY is set (new
          leads, appointment requests, and payment failures email the owner); SMS remains pending provider setup.
        </p>
      </div>
    </div>
  ) : null;

  return (
    <div ref={wrapRef} className="relative">
      {bell}
      {dropdown}
    </div>
  );
}
