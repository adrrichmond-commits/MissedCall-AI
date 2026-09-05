import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { getLeadsFn } from "~/lib/server/appFns";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  PageLoading,
  PriorityBadge,
  ServiceAreaBadge,
  StatusBadge,
} from "~/components/app/pageStates";
import { formatDate, formatMoney, labelEnum } from "~/lib/format";

type LeadSearch = {
  status?: string;
  source?: string;
  priority?: string;
  search?: string;
  page?: number;
};

export const Route = createFileRoute("/_app/leads/")({
  validateSearch: (s: Record<string, unknown>): LeadSearch => ({
    status: typeof s.status === "string" ? s.status : undefined,
    source: typeof s.source === "string" ? s.source : undefined,
    priority: typeof s.priority === "string" ? s.priority : undefined,
    search: typeof s.search === "string" ? s.search : undefined,
    page: typeof s.page === "number" ? s.page : undefined,
  }),
  loaderDeps: ({ search }) => [search.status, search.source, search.priority, search.search, search.page],
  loader: async ({ deps }) => {
    const res = await getLeadsFn({
      data: {
        status: deps[0] as string | undefined,
        source: deps[1] as string | undefined,
        priority: deps[2] as string | undefined,
        search: deps[3] as string | undefined,
        page: deps[4] as number | undefined,
      },
    });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState message="Leads couldn't load. Check your connection and retry." onRetry={() => window.location.reload()} />
  ),
  component: LeadsPage,
});

const STATUS_OPTS = [
  "new",
  "contacted",
  "qualified",
  "follow_up_needed",
  "appointment_scheduled",
  "won",
  "lost",
] as const;
const PRIORITY_OPTS = ["emergency", "high", "normal"] as const;
const SOURCE_OPTS = ["missed_call", "web_form", "referral", "repeat_customer", "other"] as const;

function LeadsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState(search.search ?? "");

  const totalPages = Math.max(1, Math.ceil(data.total / data.perPage));
  const rangeStart = data.total === 0 ? 0 : (data.page - 1) * data.perPage + 1;
  const rangeEnd = Math.min(data.total, data.page * data.perPage);

  function updateSearch(next: Partial<LeadSearch>) {
    const merged: Record<string, string | number | undefined> = { ...search, page: undefined, ...next };
    for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
    navigate({ to: "/leads", search: merged as LeadSearch });
  }

  const selectCls =
    "h-9 rounded-lg border-0 bg-white pl-3 pr-8 text-sm text-slate-700 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-500";

  return (
    <div>
      <PageHeader
        title="Leads"
        description="Every missed call becomes a lead here — contact, service need, urgency, and status."
      />

      {/* Filters */}
      <form
        className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center"
        onSubmit={(e) => {
          e.preventDefault();
          updateSearch({ search: searchInput || undefined });
        }}
      >
        <input
          type="search"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="Search name, phone, or service…"
          aria-label="Search leads"
          className="h-9 w-full rounded-lg border-0 bg-white px-3 text-sm text-slate-900 ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-brand-500 sm:max-w-xs"
        />
        <select
          aria-label="Filter by status"
          value={search.status ?? ""}
          onChange={(e) => updateSearch({ status: e.target.value || undefined })}
          className={selectCls}
        >
          <option value="">All statuses</option>
          {STATUS_OPTS.map((s) => (
            <option key={s} value={s}>
              {labelEnum(s)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by source"
          value={search.source ?? ""}
          onChange={(e) => updateSearch({ source: e.target.value || undefined })}
          className={selectCls}
        >
          <option value="">All sources</option>
          {SOURCE_OPTS.map((s) => (
            <option key={s} value={s}>
              {labelEnum(s)}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by priority"
          value={search.priority ?? ""}
          onChange={(e) => updateSearch({ priority: e.target.value || undefined })}
          className={selectCls}
        >
          <option value="">All priorities</option>
          {PRIORITY_OPTS.map((p) => (
            <option key={p} value={p}>
              {labelEnum(p)}
            </option>
          ))}
        </select>
      </form>

      {data.leads.length === 0 ? (
        <EmptyState
          title={search.search || search.status || search.source || search.priority ? "No leads match these filters" : "No leads yet"}
          description={
            search.search || search.status || search.source || search.priority
              ? "Try clearing the search or choosing a different status, priority, or source."
              : "Leads appear here as soon as your first missed call is captured."
          }
        />
      ) : (
        <>
          {/* Mobile card list */}
          <div className="space-y-3 lg:hidden">
            {data.leads.map((l) => (
              <a
                key={l.id}
                href={`/leads/${l.id}`}
                className="block rounded-xl border border-slate-200 bg-white p-4 hover:bg-slate-50"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold text-slate-900">{l.contactName}</p>
                  <span className="flex items-center gap-1.5">
                    <ServiceAreaBadge status={l.serviceAreaStatus} />
                    <PriorityBadge priority={l.priority} />
                    <StatusBadge status={l.status} />
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600">{l.serviceNeed}</p>
                <p className="mt-1 text-xs text-slate-400">
                  {l.contactPhone} · {formatDate(l.createdAt)} · {labelEnum(l.source)}
                  {l.estimatedValueCents != null
                  ? ` · ${formatMoney(l.estimatedValueCents)}`
                  : l.estimatedJobValueHighCents != null
                    ? ` · typical ${formatMoney(l.estimatedJobValueLowCents ?? 0)}-${formatMoney(l.estimatedJobValueHighCents)}`
                    : ""}
                </p>
              </a>
            ))}
          </div>

          {/* Desktop table */}
          <div className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white lg:block">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Contact</th>
                  <th className="px-4 py-3 font-semibold">Service need</th>
                  <th className="px-4 py-3 font-semibold">Source</th>
                  <th className="px-4 py-3 font-semibold">Priority</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 text-right font-semibold">Est. value</th>
                  <th className="px-4 py-3 text-right font-semibold">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-700"
                      onClick={() => updateSearch({})}
                      title="Newest first"
                    >
                      Created ↓
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.leads.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <a href={`/leads/${l.id}`} className="font-semibold text-brand-700 hover:text-brand-800">
                        {l.contactName}
                      </a>
                      <p className="text-xs text-slate-500">{l.contactPhone}</p>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {l.serviceNeed}
                      {l.hasConversation ? (
                        <span className="ml-2 inline-flex items-center rounded-full bg-aqua-50 px-2 py-0.5 text-xs font-semibold text-aqua-700 ring-1 ring-inset ring-aqua-600/20">
                          SMS
                        </span>
                      ) : null}
                      <ServiceAreaBadge status={l.serviceAreaStatus} />
                    </td>
                    <td className="px-4 py-3 text-slate-600">{labelEnum(l.source)}</td>
                    <td className="px-4 py-3">
                      <PriorityBadge priority={l.priority} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={l.status} />
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700">
                      {l.estimatedValueCents != null
                        ? formatMoney(l.estimatedValueCents)
                        : l.estimatedJobValueHighCents != null
                          ? <span className="text-slate-400" title="Typical range for this service">{formatMoney(l.estimatedJobValueLowCents ?? 0)}-{formatMoney(l.estimatedJobValueHighCents)}</span>
                          : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-500">{formatDate(l.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
            <p>
              Showing {rangeStart}–{rangeEnd} of {data.total}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={data.page <= 1}
                onClick={() => updateSearch({ page: data.page - 1 })}
                className="rounded-lg bg-white px-3 py-1.5 font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:opacity-40"
              >
                Previous
              </button>
              <span aria-current="page">
                Page {data.page} of {totalPages}
              </span>
              <button
                type="button"
                disabled={data.page >= totalPages}
                onClick={() => updateSearch({ page: data.page + 1 })}
                className="rounded-lg bg-white px-3 py-1.5 font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
