import { createFileRoute } from "@tanstack/react-router";
import { getAnalyticsFn } from "~/lib/server/appFns";
import { ErrorState, PageHeader, PageLoading } from "~/components/app/pageStates";
import { formatMoney } from "~/lib/format";

export const Route = createFileRoute("/_app/analytics")({
  loader: async () => {
    const res = await getAnalyticsFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState
      message="Analytics couldn't load. Check your connection and retry."
      onRetry={() => window.location.reload()}
    />
  ),
  component: AnalyticsPage,
});

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  converted: "Converted",
  lost: "Lost",
};
const SOURCE_LABELS: Record<string, string> = {
  missed_call: "Missed call",
  web_form: "Web form",
  referral: "Referral",
  repeat_customer: "Repeat customer",
  other: "Other",
};
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function BarList({
  title,
  subtitle,
  rows,
  emptyLabel,
}: {
  title: string;
  subtitle: string;
  rows: { key: string; label: string; count: number }[];
  emptyLabel: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  const total = rows.reduce((acc, r) => acc + r.count, 0);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5" aria-label={title}>
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
      {total === 0 ? (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">{emptyLabel}</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-700">{r.label}</span>
                <span className="font-semibold text-slate-900">
                  {r.count}
                  <span className="ml-1.5 text-xs font-normal text-slate-400">
                    {Math.round((r.count / total) * 100)}%
                  </span>
                </span>
            </div>
            <div className="mt-1 h-2 rounded-full bg-slate-100">
              <div className="h-2 rounded-full bg-brand-500" style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
            </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AnalyticsPage() {
  const data = Route.useLoaderData();

  const statusRows = Object.entries(data.leadsByStatus).map(([key, count]) => ({
    key,
    label: STATUS_LABELS[key] ?? key,
    count,
  }));
  const sourceRows = Object.entries(data.leadsBySource).map(([key, count]) => ({
    key,
    label: SOURCE_LABELS[key] ?? key,
    count,
  }));
  const weekdayMax = Math.max(1, ...data.appointmentsByWeekday);
  const weekdayTotal = data.appointmentsByWeekday.reduce((a, b) => a + b, 0);

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Straightforward aggregates over your leads, conversations, and appointments — no invented trends."
      />

      {/* Primary value metric: missed-call recovery funnel (all real rows) */}
      <section  className="rounded-xl border border-brand-200 bg-white p-5" aria-label="Missed calls recovered">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Missed calls recovered</h2>
          <p className="text-xs text-slate-400">All time</p>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          Missed calls captured as leads, engaged by the text-back assistant, and won as jobs.
        </p>
        {data.recovery.missedCalls === 0 ? (
          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
            No missed-call leads yet — recovery tracking starts with your first captured missed call.
          </p>
        ) : (
          <div className="mt-4 flex flex-wrap items-end gap-x-8 gap-y-4">
            <div>
              <p className="text-3xl font-bold text-slate-900">{data.recovery.missedCalls}</p>
              <p className="mt-0.5 text-xs font-medium text-slate-500">missed calls captured</p>
            </div>
            <span className="pb-4 text-lg text-slate-400" aria-hidden="true">→</span>
            <div>
              <p className="text-3xl font-bold text-aqua-700">{data.recovery.recovered}</p>
              <p className="mt-0.5 text-xs font-medium text-slate-500">recovered by SMS</p>
            </div>
            <span className="pb-4 text-lg text-slate-400" aria-hidden="true">→</span>
            <div>
              <p className="text-3xl font-bold text-green-700">{data.recovery.booked}</p>
              <p className="mt-0.5 text-xs font-medium text-slate-500">booked jobs</p>
            </div>
          </div>
        )}
      </section>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-medium text-slate-600">Total leads</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{data.totalLeads}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-medium text-slate-600">SMS messages exchanged</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{data.totalMessages}</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <p className="text-sm font-medium text-slate-600">Open pipeline value</p>
          <p className="mt-2 text-2xl font-bold text-slate-900">{formatMoney(data.openPipelineValueCents)}</p>
          <p className="mt-1 text-xs text-slate-500">All non-lost leads' estimated value</p>
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <BarList
          title="Leads by status"
          subtitle="All leads, all time"
          rows={statusRows}
          emptyLabel="No leads yet."
        />
        <BarList
          title="Leads by source"
          subtitle="Where your leads come from"
          rows={sourceRows}
          emptyLabel="No leads yet."
        />
      </div>

      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5" aria-label="Appointments by weekday">
        <h2 className="text-sm font-semibold text-slate-900">Appointments by weekday</h2>
        <p className="mt-0.5 text-xs text-slate-500">All scheduled jobs, all time</p>
        {weekdayTotal === 0 ? (
          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
            No appointments yet.
          </p>
        ) : (
          <div className="mt-4 flex items-end gap-2 sm:gap-3">
            {data.appointmentsByWeekday.map((count, idx) => (
              <div key={idx} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-xs font-semibold text-slate-700">{count}</span>
                <div
                  className="w-full rounded-t bg-brand-500"
                  style={{ height: `${Math.max(4, Math.round((count / weekdayMax) * 96))}px` }}
                  aria-hidden="true"
                />
                <span className="text-xs text-slate-500">{WEEKDAY_LABELS[idx]}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
