/**
 * /admin/accounts/$businessId — one customer account, all data, the admin
 * actions: disable/enable (kill switch), manual plan override, and view-as
 * (impersonation). Every action's server fn is gated + audited.
 */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  adminAccountDetailFn,
  adminImpersonateFn,
  adminOverridePlanFn,
  adminSetAccountDisabledFn,
  type AdminAccountDetailView,
} from "~/lib/server/adminFns";
import { formatDate, formatDateTime, formatMoney, formatRelative } from "~/lib/format";
import { Badge } from "~/components/ui/Badge";

export const Route = createFileRoute("/admin/accounts_/$businessId")({
  loader: async ({ params }) => {
    // PR #27: plain read during SSR (no HTTP self-call); RPC in the browser.
    if (import.meta.env.SSR) {
      const { adminAccountDetailPage } = await import("~/lib/server/adminReads");
      const res = await adminAccountDetailPage(params.businessId);
      if (!res.ok) throw new Error(res.error);
      return res.data;
    }
    const res = await adminAccountDetailFn({ data: { businessId: params.businessId } });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  component: AccountDetailPage,
});

type ActionState = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string } | { kind: "done"; message: string };

function AdminNav() {
  return (
    <nav className="flex items-center gap-3 text-sm">
      <Link to="/admin/accounts" className="text-brand-700 hover:underline">
        Accounts
      </Link>
      <Link to="/admin/health" className="text-brand-700 hover:underline">
        System health
      </Link>
      <Link to="/admin/metrics" search={{}} className="text-brand-700 hover:underline">
        Metrics
      </Link>
      <Link to="/admin/audit" className="text-brand-700 hover:underline">
        Audit log
      </Link>
    </nav>
  );
}

function AccountDetailPage() {
  const detail = Route.useLoaderData() as AdminAccountDetailView;
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const [reason, setReason] = useState("");
  const disabled = detail.disabledAt != null;

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>, doneMsg: string) {
    setAction({ kind: "busy" });
    try {
      const r = await fn();
      if (r.ok) {
        setAction({ kind: "done", message: doneMsg });
        window.location.reload();
      } else {
        setAction({ kind: "error", message: r.error ?? "Action failed." });
      }
    } catch {
      setAction({ kind: "error", message: "Action failed — try again." });
    }
  }

  const disable = () =>
    run(
      () =>
        adminSetAccountDisabledFn({ data: { businessId: detail.id, disabled: !disabled, reason: reason || undefined } }),
      disabled ? "Account enabled." : "Account disabled.",
    );
  const impersonate = () => run(() => adminImpersonateFn({ data: { businessId: detail.id } }), "Viewing as account…");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">{detail.name}</h1>
            {disabled ? <Badge tone="red">Disabled</Badge> : null}
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Created {formatDate(detail.createdAt)} · {detail.counts.users} user{detail.counts.users === 1 ? "" : "s"}
          </p>
        </div>
        <AdminNav />
      </div>

      {action.kind === "error" ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
          {action.message}
        </p>
      ) : null}
      {action.kind === "done" ? (
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {action.message}
        </p>
      ) : null}

      {/* Subscription + plan */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Subscription</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-xs text-slate-500">Plan</p>
            <p className="text-lg font-semibold capitalize text-slate-900">{detail.plan}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Subscription status</p>
            <p className="text-lg font-semibold text-slate-900">
              {detail.stripeConfigured ? (
                detail.subscriptionStatus ?? "—"
              ) : (
                <span className="text-slate-500">not configured</span>
              )}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Trial ends</p>
            <p className="text-lg font-semibold text-slate-900">
              {detail.trialEndsAt ? formatDateTime(detail.trialEndsAt) : "—"}
            </p>
          </div>
        </div>

        {/* Manual plan override — honest label */}
        <div className="mt-4 border-t border-slate-100 pt-4">
          <p className="text-xs font-medium text-slate-600">
            Change plan — <span className="italic text-amber-700">{detail.planOverrideNote}</span>
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["trial", "starter", "pro"] as const).map((p) => (
              <button
                key={p}
                type="button"
                disabled={action.kind === "busy" || detail.plan === p}
                onClick={() => run(() => adminOverridePlanFn({ data: { businessId: detail.id, plan: p, reason: reason || undefined } }), `Plan changed to ${p}.`)}
                className={`rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-40 ${
                  detail.plan === p
                    ? "border-brand-300 bg-brand-50 text-brand-700"
                    : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                {p === "trial" ? "Set Trial" : `Set ${p[0].toUpperCase()}${p.slice(1)}`}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Usage vs limits */}
      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Usage this period (started {formatDateTime(detail.usage.periodStart)})
        </h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <UsageBar label="SMS sent" used={detail.usage.smsSent} limit={detail.usage.limits?.sms ?? null} />
          <UsageBar label="AI turns" used={detail.usage.aiTurns} limit={detail.usage.limits?.aiTurns ?? null} />
          <UsageBar label="Calls handled" used={detail.usage.callsHandled} limit={detail.usage.limits?.calls ?? null} />
        </div>
      </section>

      {/* Money + funnel counts */}
      <section className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Revenue recovered</h2>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">This week</p>
              <p className="text-lg font-bold text-slate-900">{formatMoney(detail.revenue?.weekCents ?? 0)}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">This month</p>
              <p className="text-lg font-bold text-slate-900">{formatMoney(detail.revenue?.monthCents ?? 0)}</p>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <p className="text-xs text-slate-500">All time</p>
              <p className="text-lg font-bold text-slate-900">{formatMoney(detail.revenue?.allTimeCents ?? 0)}</p>
            </div>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {detail.revenue?.wonLeads ?? 0} won job{(detail.revenue?.wonLeads ?? 0) === 1 ? "" : "s"} ·{" "}
            {detail.revenue?.missedCalls ?? 0} missed calls captured · {detail.revenue?.recovered ?? 0} recovered
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Data counts</h2>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <Count label="Leads" value={detail.counts.leads} />
            <Count label="Calls" value={detail.counts.calls} />
            <Count label="Conversations" value={detail.counts.conversations} />
            <Count label="Appointments" value={detail.counts.appointments} />
            <Count label="Users" value={detail.counts.users} />
            <Count label="Notifications" value={detail.counts.notifications} />
          </div>
        </div>
      </section>

      {/* Users + recent notifications */}
      <section className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Users</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {detail.users.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2 py-2">
                <div>
                  <p className="font-medium text-slate-900">{u.fullName}</p>
                  <p className="text-xs text-slate-500">{u.email}</p>
                </div>
                <div className="text-right text-xs text-slate-500">
                  <span className="capitalize">{u.role}</span>
                  {u.lastLoginAt ? <span> · last login {formatRelative(u.lastLoginAt)}</span> : <span> · never signed in</span>}
                  {u.isActive ? null : <span className="ml-1 text-red-600">deactivated</span>}
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Recent notifications</h2>
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {detail.recentNotifications.length === 0 ? (
              <li className="py-2 text-slate-500">No notifications yet.</li>
            ) : null}
            {detail.recentNotifications.map((n) => (
              <li key={n.id} className="py-2">
                <p className="font-medium text-slate-900">{n.type.replace(/_/g, " ")}</p>
                <p className="text-xs text-slate-500">{formatDateTime(n.createdAt)}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Admin actions */}
      <section className="mt-5 rounded-xl border-2 border-amber-300 bg-amber-50 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-800">Admin actions</h2>
        <p className="mt-1 text-xs text-amber-800">
          Every action here is recorded in the audit log with your account and the reason you enter below.
        </p>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (recorded in the audit log, optional)"
          aria-label="Reason for admin action"
          className="mt-3 w-full max-w-md rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none"
        />
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="button"
            onClick={disable}
            disabled={action.kind === "busy"}
            className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${
              disabled ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700"
            }`}
          >
            {disabled ? "Enable account" : "Disable account"}
          </button>
          <button
            type="button"
            onClick={impersonate}
            disabled={action.kind === "busy" || disabled}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50"
          >
            View as this business
          </button>
        </div>
        {disabled ? (
          <p className="mt-3 text-xs text-amber-800">
            Disabled: this business's users cannot log in and existing sessions are revoked.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-lg font-bold text-slate-900">{value}</p>
    </div>
  );
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-xs text-slate-500">{label}</p>
        <p className="text-sm font-semibold text-slate-900">
          {used} / {limit ?? "—"}
        </p>
      </div>
      <div className="mt-1 h-2 rounded-full bg-slate-100" role="presentation">
        <div
          className={`h-2 rounded-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-brand-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
