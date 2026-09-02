import { useState } from "react";
import type { CurrentUserView } from "~/lib/server/sessionFns";
import { Badge } from "~/components/ui/Badge";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: "M3 12l9-8 9 8M5 10v10h5v-6h4v6h5V10" },
  { href: "/leads", label: "Leads", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { href: "/inbox", label: "Inbox", icon: "M3 8l9 6 9-6M3 8V6a2 2 0 012-2h14a2 2 0 012 2v2M3 8v10a2 2 0 002 2h14a2 2 0 002-2V8" },
  { href: "/appointments", label: "Appointments", icon: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" },
  { href: "/analytics", label: "Analytics", icon: "M9 19v-6m4 6V9m4 10v-4M5 21h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2z" },
  { href: "/settings", label: "Settings", icon: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" },
];

function NavIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5 shrink-0" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

function isActivePath(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Authenticated app shell: sidebar nav (collapses to a top sheet on mobile)
 * + topbar with the business name, user, and logout. Content comes from the
 * child route's Outlet.
 */
export function AppShell({ user, children }: { user: CurrentUserView; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = window.location.pathname;
  const roleTone = user.role === "owner" ? "brand" : user.role === "manager" ? "aqua" : "slate";

  async function logout() {
    const { logoutFn } = await import("~/lib/server/authFns");
    await logoutFn();
    window.location.href = "/login";
  }

  const nav = (
    <nav className="space-y-1">
      {NAV.map((item) => {
        const active = isActivePath(item.href, pathname);
        return (
          <a
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "bg-brand-50 text-brand-700"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
            aria-current={active ? "page" : undefined}
          >
            <NavIcon path={item.icon} />
            {item.label}
          </a>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-dvh bg-slate-50">
      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 lg:hidden">
        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100"
          onClick={() => setOpen(!open)}
          aria-label="Toggle navigation"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className="h-5 w-5">
            {open ? (
              <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
            ) : (
              <path strokeLinecap="round" d="M4 7h16M4 12h16M4 17h16" />
            )}
          </svg>
        </button>
        <span className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-brand-600 text-xs font-bold text-white">M</span>
          {user.businessName}
        </span>
        <span className="h-9 w-9" aria-hidden="true" />
      </div>

      <div className="mx-auto flex w-full max-w-7xl">
        {/* Sidebar (desktop) */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-5 lg:flex">
          <a href="/" className="mb-6 flex items-center gap-2 px-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-white">
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.2.2 2.4.6 3.6.1.3 0 .7-.2 1l-2.3 2.2z" fill="currentColor" />
              </svg>
            </span>
            <span className="text-sm font-bold tracking-tight text-slate-900">MissedCall AI</span>
          </a>
          {nav}
          <div className="mt-auto rounded-xl border border-slate-200 p-3">
            <p className="truncate text-sm font-semibold text-slate-900">{user.fullName}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
            <div className="mt-2 flex items-center justify-between">
              <Badge tone={roleTone}>{user.role}</Badge>
              <button
                type="button"
                onClick={() => void logout()}
                className="text-xs font-semibold text-slate-500 hover:text-red-600"
              >
                Log out
              </button>
            </div>
          </div>
        </aside>

        {/* Mobile nav sheet */}
        {open ? (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
            <div className="absolute inset-0 bg-slate-900/30" onClick={() => setOpen(false)} />
            <div className="absolute inset-x-0 top-[57px] rounded-b-xl border-b border-slate-200 bg-white p-4 shadow-lg">
              {nav}
              <div className="mt-4 border-t border-slate-100 pt-3">
                <p className="truncate text-sm font-semibold text-slate-900">{user.fullName}</p>
                <p className="truncate text-xs text-slate-500">{user.email}</p>
                <div className="mt-2 flex items-center justify-between">
                  <Badge tone={roleTone}>{user.role}</Badge>
                  <button
                    type="button"
                    onClick={() => void logout()}
                    className="text-xs font-semibold text-slate-500 hover:text-red-600"
                  >
                    Log out
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Main column */}
        <div className="min-w-0 flex-1">
          <header className="hidden items-center justify-between border-b border-slate-200 bg-white px-8 py-4 lg:flex">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-400">Business</p>
              <p className="text-sm font-semibold text-slate-900">{user.businessName}</p>
            </div>
            <div className="flex items-center gap-3">
              <Badge tone={user.businessPlan === "trial" ? "amber" : "green"}>{user.businessPlan} plan</Badge>
              {!user.emailVerified ? <Badge tone="red">email unverified</Badge> : null}
            </div>
          </header>
          <main className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</main>
        </div>
      </div>
    </div>
  );
}

/** Shared "coming in the next phase" panel for scaffolding pages. */
export function PagePlaceholder({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
}) {
  return (
    <div>
      <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">{title}</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">{description}</p>
      <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
        <p className="text-sm font-semibold text-slate-900">Real data lands in the next build</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
          This page is wired to your business account. Data backed by your leads, conversations, and
          appointments appears here as those features come online.
        </p>
        {children}
      </div>
    </div>
  );
}
