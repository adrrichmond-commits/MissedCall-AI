/**
 * /admin layout — the platform-owner-only route group.
 *
 * GATE (server-side, beforeLoad): requirePlatformAdmin() re-resolves the
 * session from the request cookie and re-reads users.is_platform_admin from
 * the DB. Signed-in non-admins AND a closed gate (PLATFORM_OWNER_EMAIL
 * unset) both get the root 404 — the admin surface does not exist for
 * them. Unauthenticated users go to /login?next=/admin.
 *
 * The layout's loader also resolves the impersonation state so the
 * persistent "Viewing as <business> — admin session" banner renders on
 * every /admin page, with the Exit control.
 */
import { useState } from "react";
import { createFileRoute, Outlet, redirect, notFound } from "@tanstack/react-router";
import {
  exitImpersonationFn,
  getImpersonationStateFn,
  platformAdminGateFn,
} from "~/lib/server/adminFns";

export const Route = createFileRoute("/admin")({
  beforeLoad: async () => {
    const gate = await platformAdminGateFn();
    if (gate.ok) return;
    if (gate.kind === "unauthenticated") {
      throw redirect({ to: "/login", search: { next: "/admin" } });
    }
    // Signed in but not the platform admin (or gate closed): 404.
    throw notFound();
  },
  loader: async () => {
    const imp = await getImpersonationStateFn();
    return {
      active: imp.active,
      viewedBusinessName: imp.viewedBusinessName,
      adminEmail: imp.adminEmail,
    };
  },
  component: AdminLayout,
});

function AdminLayout() {
  const imp = Route.useLoaderData() as {
    active: boolean;
    viewedBusinessName: string | null;
    adminEmail: string | null;
  };
  const [exiting, setExiting] = useState(false);

  async function exit() {
    setExiting(true);
    try {
      const res = await exitImpersonationFn();
      // Full navigation: the restored session changes the whole shell.
      if (res.ok) window.location.href = "/admin/accounts";
    } finally {
      setExiting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-100">
      {imp.active ? (
        <div className="sticky top-0 z-50 border-b-2 border-amber-600 bg-amber-400 px-4 py-2.5 text-amber-950">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold">
              Viewing as {imp.viewedBusinessName} — admin session
              {imp.adminEmail ? (
                <span className="ml-2 text-xs font-normal opacity-80">({imp.adminEmail})</span>
              ) : null}
            </p>
            <button
              type="button"
              onClick={exit}
              disabled={exiting}
              className="rounded-md border border-amber-700 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-white disabled:opacity-50"
            >
              {exiting ? "Exiting…" : "Exit view-as"}
            </button>
          </div>
        </div>
      ) : null}
      <Outlet />
    </div>
  );
}
