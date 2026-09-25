import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { getAnalyticsFn, type AnalyticsData } from "~/lib/server/appFns";
import { ErrorState, PageHeader, PageLoading } from "~/components/app/pageStates";
import { formatMoney } from "~/lib/format";
import type { PerformanceReport, PeriodKey, ReportingCounts, TrendDirection } from "~/lib/server/reporting";

export const Route = createFileRoute("/_app/analytics")({
  loader: async (): Promise<AnalyticsData> => {
    // SSR: plain server read (createServerFn in a loader compiles to an SSR
    // RPC self-call through the hosting proxy that intermittently fails —
    // sessionReads/adminReads postmortem). Browser: the RPC wrapper.
    if (import.meta.env.SSR) {
      const { analyticsPageDataForSession } = await import("~/lib/server/reportingReads");
      const data = await analyticsPageDataForSession();
      if (!data) throw new Error("Not signed in.");
      return data;
    }
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
  const funnelMax = Math.max(1, ...data.funnel.map((s) => s.count));

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Straightforward aggregates over your leads, conversations, and appointments — no invented trends."
      />

      {/* P5-5: performance over time — daily/weekly/monthly with trends */}
      <PerformanceSection report={data.performance} />

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

      {/* P3-D: recovered-revenue summary (all time + periods) */}
      <section className="rounded-xl border border-brand-200 bg-white p-5" aria-label="Recovered revenue">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Recovered revenue</h2>
          <p className="text-xs text-slate-400">Won jobs, by when they closed</p>
        </div>
        <p className="mt-0.5 text-xs text-slate-500">
          What jobs won from MissedCall AI captured work were worth — the actual invoice when you
          entered one, otherwise your quote, otherwise the typical range for the job.
        </p>
        {data.revenue == null || (!data.revenue.hasRecovered && data.totalLeads === 0) ? (
          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
            Revenue tracking starts with your first lead.
          </p>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            {(
              [
                { label: "This week", p: data.revenue.week },
                { label: "This month", p: data.revenue.month },
                { label: "All time", p: data.revenue.allTime },
              ] as const
            ).map((item) => (
              <div key={item.label}>
                <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                  {item.label}
                </p>
                <p className="mt-1 text-2xl font-bold text-slate-900">
                  {formatMoney(item.p.recoveredCents)}
                </p>
                <p className="text-xs text-slate-500">
                  {item.p.wonLeads}
                  {item.p.wonLeads === 1 ? " job won" : " jobs won"}
                </p>
              </div>
            ))}
          </div>
        )}
        {/* P5-2: the ROI line — estimated, honestly labeled, cost from the pricing config */}
        {data.roi ? (
          <p
            className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500"
            data-testid="analytics-roi-line"
          >
            ROI this month:{" "}
            <span className="font-semibold text-slate-900">
              {data.roi.estimated.roiMultiple == null ? "—" : `${data.roi.estimated.roiMultiple}×`}
            </span>
            {data.roi.estimateFlags.roiMultiple ? (
              <span className="ml-1 font-semibold text-amber-700">(estimate)</span>
            ) : null}
            {data.roi.billing.monthlyCostCents > 0
              ? ` — estimated revenue recovered this month ÷ ${formatMoney(data.roi.billing.monthlyCostCents)}/mo (${data.roi.billing.planName}).`
              : " — free trial, no billing yet."}
          </p>
        ) : null}
      </section>

      {/* P3-D: the captured-calls funnel, top to bottom */}
      <section className="mt-4 rounded-xl border border-slate-200 bg-white p-5" aria-label="Calls to jobs funnel">
        <h2 className="text-sm font-semibold text-slate-900">From calls to jobs</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          Every stage, all time. Today the assistant captures missed calls by text-back; when the
          AI receptionist answers live calls, they enter at the top too.
        </p>
        <ol className="mt-4 space-y-2">
          {data.funnel.map((s, i) => (
            <li key={s.key}>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-700">
                  <span className="mr-2 inline-block w-5 text-right text-xs text-slate-400">{i + 1}.</span>
                  {s.label}
                </span>
                <span className="font-semibold text-slate-900">{s.count}</span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-slate-100">
                <div
                  className={`h-2 rounded-full ${s.key === "won" ? "bg-green-500" : "bg-brand-500"}`}
                  style={{ width: `${funnelMax === 0 ? 0 : Math.max(2, Math.round((s.count / funnelMax) * 100))}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      </section>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
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

// ---------------------------------------------------------------------------
// P5-5: performance over time — daily / weekly / monthly periods with trend
// direction vs the previous period. Measured counts stay measured; the money
// figures carry the P5-2 "Estimate" chip contract (report.estimateFlags).
// ---------------------------------------------------------------------------

const PERFORMANCE_PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

const PERFORMANCE_METRICS: { key: keyof ReportingCounts; label: string }[] = [
  { key: "callsReceived", label: "Calls received" },
  { key: "missedCalls", label: "Missed calls captured" },
  { key: "autoResponded", label: "Auto-responded" },
  { key: "customerReplies", label: "Customer replies" },
  { key: "leadsCaptured", label: "Leads captured" },
  { key: "appointmentsBooked", label: "Appointments booked" },
];

function TrendArrow({ direction }: { direction: TrendDirection }) {
  const glyph = direction === "up" ? "▲" : direction === "down" ? "▼" : "—";
  return (
    <span
      className={`ml-2 text-xs ${direction === "up" ? "text-green-600" : direction === "down" ? "text-amber-600" : "text-slate-400"}`}
      title="vs the previous period"
    >
      {glyph}
    </span>
  );
}

/** The visible P5-2-contract "Estimate" chip — always rendered for money. */
function EstimateChip() {
  return (
    <span
      data-testid="performance-estimate-chip"
      className="ml-1.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700"
    >
      Estimate
    </span>
  );
}

function PerformanceSection({ report }: { report: PerformanceReport }) {
  const [tab, setTab] = useState<PeriodKey>("weekly");
  const period = report.periods[tab];
  const roi = period.roiMultiple;
  return (
    <section className="rounded-xl border border-brand-200 bg-white p-5" aria-label="Performance over time">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">Performance over time</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Measured counts with the trend direction vs the previous period — counts are real rows;
            money figures are estimates.
          </p>
        </div>
        <div className="flex rounded-lg border border-slate-200 p-0.5" role="tablist" aria-label="Reporting period">
          {PERFORMANCE_PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              role="tab"
              aria-selected={tab === p.key}
              onClick={() => setTab(p.key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium ${
                tab === p.key ? "bg-brand-500 text-white" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {PERFORMANCE_METRICS.map((m) => (
          <div key={m.key}>
            <p className="text-xs text-slate-500">
              {m.label}
              <TrendArrow direction={period.trends[m.key]} />
            </p>
            <p className="text-xl font-bold text-slate-900">{period.current[m.key]}</p>
            <p className="text-[11px] text-slate-400">prev: {period.previous[m.key]}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 border-t border-slate-100 pt-3">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
          <div>
            <p className="text-xs text-slate-500">
              Jobs won
              <TrendArrow direction={period.trends.jobsWon} />
              <EstimateChip />
            </p>
            <p className="text-xl font-bold text-slate-900">{period.current.jobsWon}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">
              Revenue recovered
              <TrendArrow direction={period.trends.revenueRecoveredCents} />
              <EstimateChip />
            </p>
            <p className="text-xl font-bold text-aqua-700">{formatMoney(period.current.revenueRecoveredCents)}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500">
              ROI vs subscription
              <EstimateChip />
            </p>
            <p className="text-xl font-bold text-slate-900">{roi == null ? "—" : `${roi}×`}</p>
            <p className="text-[11px] text-slate-400">
              {roi == null ? "free trial — no subscription cost yet" : "period revenue ÷ monthly plan cost"}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
