/**
 * /admin/accounts — every business on the platform. Search by name/email,
 * paginate. Cross-business by design; the gate ran in the /admin layout.
 */
import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { AdminAccountView } from "~/lib/server/adminFns";
import { formatDate, formatRelative } from "~/lib/format";
import { Badge } from "~/components/ui/Badge";

interface AccountsData {
  accounts: AdminAccountView[];
  total: number;
  page: number;
  pageSize: number;
  stripeConfigured: boolean;
}

export const Route = createFileRoute("/admin/accounts")({
  validateSearch: (search: Record<string, unknown>): { q?: string; page?: number } => ({
    q: typeof search.q === "string" ? search.q.slice(0, 120) : undefined,
    page: search.page != null ? Number(search.page) || 1 : undefined,
  }),
  loaderDeps: ({ search }): [string | undefined, number | undefined] => [search.q, search.page],
  loader: async ({ deps }) => {
    // PR #27: plain read during SSR (no HTTP self-call); RPC in the browser.
    if (import.meta.env.SSR) {
      const { adminAccountsPage } = await import("~/lib/server/adminReads");
      const res = await adminAccountsPage({ search: deps[0] ?? "", page: deps[1] ?? 1 });
      if (!res.ok) throw new Error(res.error);
      return res.data;
    }
    const { adminListAccountsFn } = await import("~/lib/server/adminFns");
    const res = await adminListAccountsFn({
      data: { search: deps[0] ?? "", page: deps[1] ?? 1 },
    });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: AdminLoading,
  component: AccountsPage,
});

function AdminLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="h-8 w-56 animate-pulse rounded bg-slate-200" />
      <div className="mt-6 h-64 animate-pulse rounded-xl bg-slate-200" />
    </div>
  );
}

function accountState(a: AdminAccountView): { label: string; tone: "green" | "amber" | "red" | "slate" } {
  if (a.disabledAt) return { label: "Disabled", tone: "red" };
  if (a.plan === "starter" || a.plan === "pro") {
    if (a.subscriptionStatus === "active" || a.subscriptionStatus === "trialing") {
      return { label: "Active", tone: "green" };
    }
    if (a.subscriptionStatus === "past_due") return { label: "Past due", tone: "amber" };
    if (a.subscriptionStatus === "canceled") return { label: "Canceled", tone: "red" };
    return { label: `Paid (${a.plan})`, tone: "green" };
  }
  if (a.trialEndsAt && new Date(a.trialEndsAt).getTime() <= Date.now()) {
    return { label: "Trial expired", tone: "amber" };
  }
  return { label: "Trial", tone: "slate" };
}

function AccountsPage() {
  const data = Route.useLoaderData() as AccountsData;
  const search = Route.useSearch() as { q?: string; page?: number };
  const navigate = useNavigate();
  const [q, setQ] = useState(search.q ?? "");
  const total = data.total;
  const pageSize = data.pageSize;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">Accounts</h1>
          <p className="mt-1 text-sm text-slate-600">
            {total} business{total === 1 ? "" : "es"} on the platform.
          </p>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <Link
            to="/admin/accounts"
            activeProps={{ className: "font-semibold text-brand-700" }}
            search={{ q: search.q, page: search.page }}
          >
            Accounts
          </Link>
          <Link to="/admin/health" search={{}} activeProps={{ className: "font-semibold text-brand-700" }}>
            System health
          </Link>
          <Link to="/admin/metrics" search={{}} activeProps={{ className: "font-semibold text-brand-700" }}>
            Metrics
          </Link>
          <Link to="/admin/funnel" search={{}} activeProps={{ className: "font-semibold text-brand-700" }}>
            Funnel
          </Link>
          <Link to="/admin/prompts" search={{}} activeProps={{ className: "font-semibold text-brand-700" }}>
            AI prompts
          </Link>
          <Link to="/admin/audit" search={{}} activeProps={{ className: "font-semibold text-brand-700" }}>
            Audit log
          </Link>
        </nav>
      </div>

      <form
        className="mt-5 flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void navigate({ to: "/admin/accounts", search: { q, page: 1 } });
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by business name or user email"
          aria-label="Search accounts"
          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700"
        >
          Search
        </button>
      </form>

      <div className="mt-5 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3">Plan</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Last activity</th>
              <th className="px-4 py-3">Users</th>
              <th className="px-4 py-3"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.accounts.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                  No accounts match that search.
                </td>
              </tr>
            ) : null}
            {data.accounts.map((a) => {
              const st = accountState(a);
              return (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <Link to="/admin/accounts/$businessId" params={{ businessId: a.id }} className="font-medium text-brand-700 hover:underline">
                      {a.name}
                    </Link>
                    {a.disabledAt ? (
                      <span className="ml-2 text-xs text-red-600">disabled {formatRelative(a.disabledAt)}</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={st.tone === "slate" ? "slate" : st.tone}>{st.label}</Badge>
                  </td>
                  <td className="px-4 py-3 capitalize">{a.plan}</td>
                  <td className="px-4 py-3 text-slate-600">{formatDate(a.createdAt)}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {a.lastActivityAt ? formatRelative(a.lastActivityAt) : "never signed in"}
                  </td>
                  <td className="px-4 py-3 text-slate-600">{a.userCount}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      to="/admin/accounts/$businessId"
                      params={{ businessId: a.id }}
                      className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Manage
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>
            Page {data.page} of {pages}
          </span>
          <div className="flex gap-2">
            <Link
              to="/admin/accounts"
              search={{ q: search.q, page: Math.max(1, data.page - 1) }}
              disabled={data.page <= 1}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 disabled:opacity-40"
            >
              Previous
            </Link>
            <Link
              to="/admin/accounts"
              search={{ q: search.q, page: Math.min(pages, data.page + 1) }}
              disabled={data.page >= pages}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 disabled:opacity-40"
            >
              Next
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
