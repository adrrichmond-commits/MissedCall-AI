/**
 * /admin/metrics — P5-6 business-overview metrics for the platform owner.
 *
 * READ-ONLY aggregates across ALL businesses (the deliberate inverse of the
 * business-isolation rule — reachable only through the /admin layout gate,
 * which 404s for every non-admin before this route's loader ever runs).
 * MRR is computed from src/lib/pricing.ts plan prices × paying accounts;
 * derived rates are honest (no trials → "—", never a fabricated 0%).
 *
 * Loader follows the PR #27 pattern: plain read during SSR (no HTTP
 * self-call), RPC wrapper in the browser.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import type { AdminMetricsView } from "~/lib/server/adminFns";
import type { AdminMetricPlanFilter, AdminMetricWindow } from "~/lib/server/adminMetrics";
import {
  ADMIN_METRIC_PLAN_FILTERS,
  ADMIN_METRIC_WINDOWS,
  sanitizeAdminMetricsFilters,
} from "~/lib/server/adminMetrics";
import { formatDate, formatDateTime } from "~/lib/format";
import { Badge } from "~/components/ui/Badge";

/** Search shape with OPTIONAL keys (the `?` matters for Link typing). */
interface MetricsSearch {
  plan?: AdminMetricPlanFilter;
  window?: AdminMetricWindow;
}

export const Route = createFileRoute("/admin/metrics")({
  validateSearch: (search: Record<string, unknown>): MetricsSearch => {
    const f = sanitizeAdminMetricsFilters(search);
    // Only surface non-defaults in the URL.
    return {
      plan: f.plan === "all" ? undefined : f.plan,
      window: f.window === "all" ? undefined : f.window,
    };
  },
  loaderDeps: ({ search }): [string, string] => [search.plan ?? "all", search.window ?? "all"],
  loader: async ({ deps }) => {
    const [plan, window] = deps;
    // PR #27: plain read during SSR (no HTTP self-call); RPC in the browser.
    if (import.meta.env.SSR) {
      const { adminMetricsPage } = await import("~/lib/server/adminReads");
      const res = await adminMetricsPage({ plan, window });
      if (!res.ok) throw new Error(res.error);
      return res.data;
    }
    const { adminMetricsFn } = await import("~/lib/server/adminFns");
    const res = await adminMetricsFn({ data: { plan, window } });
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  component: MetricsPage,
});

function Nav() {
  return (
    <nav className="flex items-center gap-3 text-sm">
      <Link to="/admin/accounts" search={{}} className="text-brand-700 hover:underline">Accounts</Link>
      <Link to="/admin/metrics" search={{}} className="font-semibold text-brand-700">Metrics</Link>
      <Link to="/admin/health" search={{}} className="text-brand-700 hover:underline">System health</Link>
      <Link to="/admin/audit" search={{}} className="text-brand-700 hover:underline">Audit log</Link>
    </nav>
  );
}

function usd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function MetricCard(props: { label: string; value: string; sub?: string; note?: string; tone?: "green" | "slate" }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{props.label}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{props.value}</p>
      {props.sub ? <p className="mt-1 text-sm text-slate-600">{props.sub}</p> : null}
      {props.note ? <p className="mt-2 text-xs text-slate-400">{props.note}</p> : null}
    </div>
  );
}

function FilterRow(props: {
  label: string;
  options: readonly { value: string; label: string }[];
  active: string;
  current: MetricsSearch;
  keyName: "plan" | "window";
}) {
  const { label, options, active, current, keyName } = props;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      {options.map((o) => {
        const next: MetricsSearch =
          keyName === "plan"
            ? { ...current, plan: o.value === "all" ? undefined : (o.value as AdminMetricPlanFilter) }
            : { ...current, window: o.value === "all" ? undefined : (o.value as AdminMetricWindow) };
        return (
          <Link
            key={o.value}
            to="/admin/metrics"
            search={next}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium " +
              (o.value === active
                ? "border-brand-600 bg-brand-600 text-white"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50")
            }
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}

function AttentionList(props: {
  title: string;
  items: { businessId: string; name: string; at: string; daysLeft?: number }[];
  emptyNote: string;
  dateLabel: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{props.title}</h3>
        <Badge tone={props.items.length > 0 ? "amber" : "green"}>{props.items.length}</Badge>
      </div>
      {props.items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">{props.emptyNote}</p>
      ) : (
        <ul className="mt-3 max-h-72 space-y-2 overflow-y-auto text-sm">
          {props.items.map((i) => (
            <li key={i.businessId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
              <Link
                to="/admin/accounts/$businessId"
                params={{ businessId: i.businessId }}
                className="font-medium text-brand-700 hover:underline"
              >
                {i.name}
              </Link>
              <span className="text-xs text-slate-500">
                {props.dateLabel} {formatDate(i.at)}
                {typeof i.daysLeft === "number" ? (
                  <span className="ml-2">
                    <Badge tone={i.daysLeft <= 1 ? "red" : "amber"}>
                      {i.daysLeft === 0 ? "ends today" : `${i.daysLeft}d left`}
                    </Badge>
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MetricsPage() {
  const m = Route.useLoaderData() as AdminMetricsView;
  const search = Route.useSearch() as MetricsSearch;
  const current: MetricsSearch = { plan: search.plan, window: search.window };
  const windowLabel = ADMIN_METRIC_WINDOWS.find((w) => w === m.filters.window)?.replace("d", " days") ?? "all time";
  const conversionDisplay =
    m.conversion.ratePct === null
      ? "—"
      : `${m.conversion.ratePct}%`;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">Business metrics</h1>
          <p className="mt-1 text-sm text-slate-600">
            Cross-business aggregates for the whole platform · generated {formatDateTime(m.generatedAt)} · read-only.
          </p>
        </div>
        <Nav />
      </div>

      {/* Filters — plan + date window, reflected in the URL */}
      <section className="mt-5 space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <FilterRow
          label="Plan"
          keyName="plan"
          active={m.filters.plan}
          current={current}
          options={ADMIN_METRIC_PLAN_FILTERS.map((p) => ({ value: p, label: p === "all" ? "All plans" : p[0]!.toUpperCase() + p.slice(1) }))}
        />
        <FilterRow
          label="Window"
          keyName="window"
          active={m.filters.window}
          current={current}
          options={ADMIN_METRIC_WINDOWS.map((w) => ({ value: w, label: w === "all" ? "All time" : `Last ${w.replace("d", "")} days` }))}
        />
      </section>

      {/* Headline metrics */}
      <section className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="MRR"
          value={usd(m.mrr.cents)}
          sub={`${m.mrr.payingAccounts} paying account${m.mrr.payingAccounts === 1 ? "" : "s"}`}
          note={m.mrr.note}
        />
        <MetricCard
          label="Active trials"
          value={String(m.trials.active)}
          sub={`${m.trials.endingSoon.length} ending within ${m.trialEndingSoonDays} days`}
          note={`${m.trialLengthDays}-day trial; demo accounts excluded.`}
        />
        <MetricCard
          label="Trial → paid"
          value={conversionDisplay}
          sub={m.conversion.ratePct === null ? "No trials have started yet" : `${m.conversion.paid} paid of ${m.conversion.trialStarts} trial starts`}
          note={m.conversion.ratePct === null ? "Conversion shows — (not 0%) until a real trial exists." : "From recorded P4-A funnel events; demo excluded."}
        />
        <MetricCard
          label={`Calls processed (${windowLabel === "all" ? "all time" : windowLabel})`}
          value={String(m.callsProcessed.total)}
          sub={`across ${m.callsProcessed.businesses} business${m.callsProcessed.businesses === 1 ? "" : "es"}`}
          note="Voice receptionist + handled calls rows."
        />
      </section>

      {/* Paying vs cancelled + plan distribution */}
      <section className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Accounts by state {m.filters.plan === "all" ? "" : `(plan: ${m.filters.plan})`}
          </h2>
          <ul className="mt-3 space-y-1.5 text-sm">
            {([
              ["Paying (active subscription)", m.accounts.paying, "green"],
              ["Trialing on Stripe", m.accounts.trialing, "slate"],
              ["Past due", m.accounts.pastDue, "amber"],
              ["Cancelled", m.accounts.canceled, "red"],
              ["No subscription yet", m.accounts.noSubscription, "slate"],
              ["On trial plan", m.accounts.trial, "slate"],
              ["Total matching filter", m.accounts.total, "slate"],
            ] as const).map(([label, n, tone]) => (
              <li key={label} className="flex items-center justify-between">
                <span className="text-slate-700">{label}</span>
                <Badge tone={n > 0 ? tone : "slate"}>{n}</Badge>
              </li>
            ))}
          </ul>
          {m.demoCount > 0 ? (
            <p className="mt-2 text-xs text-slate-400">
              Includes {m.demoCount} demo business{m.demoCount === 1 ? "" : "es"} (seed data).
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Plan distribution</h2>
          <div className="mt-3 space-y-2">
            {([
              ["Starter", m.planDistribution.starter],
              ["Pro", m.planDistribution.pro],
              ["Trial", m.planDistribution.trial],
              ["Unknown plan", m.planDistribution.unknown],
            ] as const).map(([label, n]) => {
              const max = Math.max(1, m.planDistribution.starter, m.planDistribution.pro, m.planDistribution.trial, m.planDistribution.unknown);
              return (
                <div key={label} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-sm text-slate-600">{label}</span>
                  <div className="h-4 flex-1 rounded bg-slate-100">
                    <div className="h-4 rounded bg-brand-500" style={{ width: `${Math.round((n / max) * 100)}%` }} />
                  </div>
                  <span className="w-10 text-right text-sm font-semibold text-slate-900">{n}</span>
                </div>
              );
            })}
          </div>
          {m.signupsInWindow !== null ? (
            <p className="mt-3 text-xs text-slate-400">New signups in the selected window: {m.signupsInWindow}</p>
          ) : null}
        </div>
      </section>

      {/* Accounts needing attention */}
      <section className="mt-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Accounts needing attention
        </h2>
        <div className="mt-3 grid gap-5 lg:grid-cols-3">
          <AttentionList
            title={`Trials ending within ${m.trialEndingSoonDays} days`}
            items={m.attention.trialEndingSoon}
            emptyNote={`No trials end in the next ${m.trialEndingSoonDays} days.`}
            dateLabel="Ends"
          />
          <AttentionList
            title="Expired trials, not converted"
            items={m.attention.trialsExpiredNotConverted}
            emptyNote="No expired trials are waiting on a plan."
            dateLabel="Expired"
          />
          <AttentionList
            title={`Zero activity since signup (${m.zeroActivityMinAgeDays}+ days)`}
            items={m.attention.zeroActivity}
            emptyNote="Every account this old has at least one lead, call, conversation, appointment, or login."
            dateLabel="Signed up"
          />
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Demo businesses never appear in these lists. Counts respect the plan filter; windows apply to calls and
          signups. This view changes nothing — every write path stays in the accounts UI.
        </p>
      </section>
    </div>
  );
}
