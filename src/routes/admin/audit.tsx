/**
 * /admin/audit — the append-only admin action log (read-only page).
 * Impersonation start/stop, account disable/enable, and plan overrides all
 * land here.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { adminAuditLogFn, type AdminAuditView } from "~/lib/server/adminFns";
import { formatDateTime, formatRelative } from "~/lib/format";
import { Badge } from "~/components/ui/Badge";

export const Route = createFileRoute("/admin/audit")({
  validateSearch: (search: Record<string, unknown>): { action?: string; page?: number } => ({
    action: typeof search.action === "string" ? search.action : "",
    page: Number(search.page ?? 1) || 1,
  }),
  loader: async ({ deps }) => {
    const res = await adminAuditLogFn({ data: { action: deps?.action || undefined, page: deps?.page ?? 1 } });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  component: AuditPage,
});

const ACTION_LABELS: Record<string, { label: string; tone: "brand" | "amber" | "red" | "green" | "slate" }> = {
  impersonate_start: { label: "Impersonation started", tone: "amber" },
  impersonate_stop: { label: "Impersonation ended", tone: "slate" },
  account_disable: { label: "Account disabled", tone: "red" },
  account_enable: { label: "Account enabled", tone: "green" },
  plan_override: { label: "Plan override", tone: "brand" },
};

function detailSummary(e: AdminAuditView): string {
  try {
    const d = JSON.parse(e.detailJson) as Record<string, unknown>;
    const bits: string[] = [];
    if (typeof d.businessName === "string") bits.push(d.businessName);
    if (typeof d.targetBusinessName === "string") bits.push(d.targetBusinessName);
    if (typeof d.from === "string" && typeof d.to === "string") bits.push(`${d.from} → ${d.to}`);
    if (typeof d.reason === "string" && d.reason.length > 0) bits.push(`reason: ${d.reason}`);
    return bits.join(" · ");
  } catch {
    return "";
  }
}

function AuditPage() {
  const data = Route.useLoaderData() as { entries: AdminAuditView[]; total: number; page: number; pageSize: number };
  const search = Route.useSearch() as { action: string; page: number };
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">Audit log</h1>
          <p className="mt-1 text-sm text-slate-600">
            {data.total} entr{data.total === 1 ? "y" : "ies"} · append-only: admin actions can be
            reviewed here, never edited.
          </p>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <Link to="/admin/accounts" search={{}} className="text-brand-700 hover:underline">Accounts</Link>
          <Link to="/admin/health" search={{}} className="text-brand-700 hover:underline">System health</Link>
          <Link to="/admin/audit" search={{}} className="font-semibold text-brand-700">Audit log</Link>
        </nav>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          to="/admin/audit" search={{}}
          search={{ action: "", page: 1 }}
          className={`rounded-full border px-3 py-1 text-xs font-semibold ${
            search.action === "" ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 bg-white text-slate-600"
          }`}
        >
          All
        </Link>
        {Object.entries(ACTION_LABELS).map(([key, meta]) => (
          <Link
            key={key}
            to="/admin/audit" search={{}}
            search={{ action: key, page: 1 }}
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${
              search.action === key ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-300 bg-white text-slate-600"
            }`}
          >
            {meta.label}
          </Link>
        ))}
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Admin</th>
              <th className="px-4 py-3">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.entries.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-slate-500">
                  No audit entries{search.action ? " for this filter" : " yet"}.
                </td>
              </tr>
            ) : null}
            {data.entries.map((e) => {
              const meta = ACTION_LABELS[e.action] ?? { label: e.action, tone: "slate" as const };
              return (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                    {formatRelative(e.createdAt)}
                    <span className="block text-xs text-slate-400">{formatDateTime(e.createdAt)}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                  </td>
                  <td className="px-4 py-3 text-slate-700">{e.adminEmail ?? e.id.slice(0, 8)}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {detailSummary(e) || "—"}
                    {e.targetBusinessId ? (
                      <Link
                        to="/admin/accounts/$businessId"
                        params={{ businessId: e.targetBusinessId }}
                        className="ml-1 text-xs text-brand-700 hover:underline"
                      >
                        view account
                      </Link>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 ? (
        <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
          <span>Page {data.page} of {pages}</span>
          <div className="flex gap-2">
            <Link
              to="/admin/audit" search={{}}
              search={{ action: search.action, page: Math.max(1, data.page - 1) }}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5"
            >
              Previous
            </Link>
            <Link
              to="/admin/audit" search={{}}
              search={{ action: search.action, page: Math.min(pages, data.page + 1) }}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5"
            >
              Next
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
