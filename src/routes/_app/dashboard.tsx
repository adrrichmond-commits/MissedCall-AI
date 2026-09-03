import { createFileRoute } from "@tanstack/react-router";
import { getDashboardDataFn } from "~/lib/server/appFns";
import {
  EmptyState,
  ErrorState,
  MetricCard,
  PageHeader,
  PageLoading,
  PriorityBadge,
  StatusBadge,
} from "~/components/app/pageStates";
import { formatDateTime, formatRelative } from "~/lib/format";

export const Route = createFileRoute("/_app/dashboard")({
  loader: async () => {
    const res = await getDashboardDataFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState message="The dashboard couldn't load. Check your connection and retry." onRetry={() => window.location.reload()} />
  ),
  component: DashboardPage,
});

function DashboardPage() {
  const data = Route.useLoaderData();
  const convRate =
    data.metrics.conversionRate == null ? null : Math.round(data.metrics.conversionRate * 100);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="A live view of your missed-call leads, conversations, and booked work."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="New leads (7 days)"
          value={data.metrics.newLeadsThisWeek}
          tone="brand"
          hint="Calls captured in the last week"
          href="/leads"
        />
        <MetricCard
          label="Open conversations"
          value={data.metrics.openConversations}
          tone="aqua"
          hint="Active + awaiting customer"
          href="/inbox"
        />
        <MetricCard
          label="Upcoming appointments"
          value={data.metrics.upcomingAppointments}
          tone="green"
          hint="Scheduled from now on"
          href="/appointments"
        />
        <MetricCard
          label="Conversion rate"
          value={convRate == null ? "—" : `${convRate}%`}
          tone="amber"
          hint="Converted vs lost, all time"
          href="/analytics"
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* Recent lead activity */}
        <section aria-labelledby="recent-leads" className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 sm:px-5">
            <h2 id="recent-leads" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              Recent leads
              {data.metrics.emergencyLeads > 0 ? (
                <a
                  href="/leads?priority=emergency"
                  title="Open leads marked emergency"
                  className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-600/20 hover:bg-red-100"
                >
                  🔴 {data.metrics.emergencyLeads} emergency
                </a>
              ) : null}
            </h2>
            <a href="/leads" className="text-xs font-semibold text-brand-700 hover:text-brand-800">
              View all
            </a>
          </div>
          {data.recentLeads.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No leads yet"
                description="Leads appear here as soon as your first missed call is captured."
              />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentLeads.map((l) => (
                <li key={l.id}>
                  <a href={`/leads/${l.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-slate-900">{l.contactName}</p>
                        <PriorityBadge priority={l.priority} />
                        <StatusBadge status={l.status} />
                      </div>
                      <p className="mt-0.5 truncate text-sm text-slate-600">{l.serviceNeed}</p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {formatRelative(l.createdAt)}
                        {l.hasConversation ? " · SMS conversation" : ""}
                      </p>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Next appointments */}
        <section aria-labelledby="next-appts" className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 sm:px-5">
            <h2 id="next-appts" className="text-sm font-semibold text-slate-900">
              Next appointments
            </h2>
            <a href="/appointments" className="text-xs font-semibold text-brand-700 hover:text-brand-800">
              View all
            </a>
          </div>
          {data.recentAppointments.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="Nothing scheduled"
                description="Booked appointments will show up here once conversations convert."
              />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentAppointments.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-slate-900">{a.serviceSummary}</p>
                      <StatusBadge status={a.status} />
                    </div>
                    <p className="mt-0.5 text-sm text-slate-600">
                      {formatDateTime(a.scheduledAt)}
                      {a.technicianName ? ` · ${a.technicianName}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
