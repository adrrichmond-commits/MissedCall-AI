import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { getDashboardDataFn, setFollowUpTaskDoneFn } from "~/lib/server/appFns";
import {
  EmptyState,
  ErrorState,
  MetricCard,
  PageHeader,
  PageLoading,
  PriorityBadge,
  StatusBadge,
} from "~/components/app/pageStates";
import { formatDateTime, formatMoney, formatRelative } from "~/lib/format";

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

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="A live view of your missed-call leads, conversations, and booked work."
      />

      {/* P3-D: Revenue Recovered — the primary KPI card */}
      <RevenueCard revenue={data.revenue} />

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
          hint={
            data.metrics.upcomingAppointments > 0
              ? data.metrics.confirmedAppointments + " confirmed - " + data.metrics.requestedAppointments + " requested"
              : "Requested and confirmed from now on"
          }
          href="/appointments"
        />
        <MetricCard
          label="Emergency leads"
          value={data.metrics.emergencyLeads}
          tone="amber"
          hint={data.metrics.emergencyLeads > 0 ? "Open leads needing a callback today" : "No open emergencies"}
          href="/leads?priority=emergency"
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

        {/* Follow-up queue (P3-C): open callbacks, oldest-due first */}
        <section aria-labelledby="follow-ups" className="rounded-xl border border-slate-200 bg-white lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 sm:px-5">
            <h2 id="follow-ups" className="text-sm font-semibold text-slate-900">
              Follow-ups
              {data.followUps.openCount > 0 ? (
                <span className="ml-2 inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20">
                  {data.followUps.openCount} open
                </span>
              ) : null}
            </h2>
            <span className="text-xs text-slate-400">Call back, then mark done</span>
          </div>
          {data.followUps.tasks.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No follow-ups"
                description="Every captured lead gets a callback reminder here automatically."
              />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.followUps.tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <MarkDoneButton taskId={t.id} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <a href={`/leads/${t.leadId}`} className="truncate text-sm font-semibold text-brand-700 hover:text-brand-800">
                        {t.leadName}
                      </a>
                      <span className="text-xs text-slate-400">Due {formatDateTime(t.dueAt)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-slate-600">
                      {t.serviceNeed}
                      {t.leadPhone ? ` · ${t.leadPhone}` : ""}
                    </p>
                    {t.note ? <p className="mt-0.5 truncate text-xs text-slate-500">{t.note}</p> : null}
                  </div>
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

function MarkDoneButton({ taskId }: { taskId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label="Mark follow-up done"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await setFollowUpTaskDoneFn({ data: { taskId, done: true } });
        window.location.reload();
      }}
      className="mt-0.5 h-5 w-5 flex-none rounded-full border-2 border-slate-300 hover:border-green-600 hover:bg-green-50 disabled:opacity-40"
      title="Mark done"
    >
      <span className="sr-only">Mark done</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// P3-D: Revenue Recovered — the primary KPI card
// ---------------------------------------------------------------------------

interface RevenueCardData {
  week: { wonLeads: number; recoveredCents: number };
  month: { wonLeads: number; recoveredCents: number };
  allTime: { wonLeads: number; recoveredCents: number };
  revenuePerLeadCents: number | null;
  conversionRate: number | null;
  recoveryRate: number | null;
  appointmentsPerRecoveredLead: number | null;
  hasRecovered: boolean;
}

function pct(rate: number | null): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

function ratioLabel(value: number | null): string {
  if (value == null) return "—";
  // One decimal is enough for a plumber's gut check ("1.3 jobs per lead").
  const rounded = Math.round(value * 10) / 10;
  return Number.isFinite(rounded) ? String(rounded) : "—";
}

/**
 * One card, not an analytics page: the three periods of recovered revenue up
 * front, the plain-language ratios underneath. All money arrives as USD cents
 * from the server and is formatted client-side via formatMoney.
 */
function RevenueCard({ revenue }: { revenue: RevenueCardData }) {
  return (
    <section
      aria-label="MissedCall AI generated revenue"
      className="rounded-xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          MissedCall AI generated revenue
        </h2>
        <p className="text-xs text-slate-400">From jobs won off recovered calls</p>
      </div>

      {!revenue.hasRecovered ? (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
          No recovered revenue yet — your first won job from a recovered call will show here.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {(
            [
              { label: "This week", sub: "jobs won from recovered calls", p: revenue.week },
              { label: "This month", sub: "won since the 1st, your timezone", p: revenue.month },
              { label: "All time", sub: "every job won since you started", p: revenue.allTime },
            ] as const
          ).map((item) => (
            <div key={item.label} className="rounded-lg bg-white/70 px-4 py-3 ring-1 ring-brand-100">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                {item.label}
              </p>
              <p className="mt-1 text-2xl font-bold text-slate-900">
                {formatMoney(item.p.recoveredCents)}
              </p>
              <p className="text-xs text-slate-500">
                {item.sub} · {item.p.wonLeads}
              </p>
            </div>
          ))}
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-brand-100 pt-3 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-slate-500">Revenue per lead</dt>
          <dd className="font-semibold text-slate-900">
            {formatMoney(revenue.revenuePerLeadCents)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Conversion rate</dt>
          <dd className="font-semibold text-slate-900" title="Won jobs ÷ all captured leads, all time">
            {pct(revenue.conversionRate)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Missed-call recovery</dt>
          <dd className="font-semibold text-slate-900" title="Missed calls we engaged ÷ captured missed calls, all time">
            {pct(revenue.recoveryRate)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Appointments per lead</dt>
          <dd className="font-semibold text-slate-900" title="Appointments booked ÷ recovered missed-call leads">
            {ratioLabel(revenue.appointmentsPerRecoveredLead)}
          </dd>
        </div>
      </dl>
    </section>
  );
}
