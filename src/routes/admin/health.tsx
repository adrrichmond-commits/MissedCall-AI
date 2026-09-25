/**
 * /admin/health — platform system health: the 8-stage funnel in aggregate
 * across ALL businesses, DB-backed notification counts (the error-ish
 * signal), recent Stripe webhook events, and honest integration status
 * straight from env presence (configured vs dormant — never fake).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import type { AdminHealthView } from "~/lib/server/adminFns";
import { formatDateTime } from "~/lib/format";
import { Badge } from "~/components/ui/Badge";

export const Route = createFileRoute("/admin/health")({
  loader: async () => {
    // PR #27: plain read during SSR (no HTTP self-call); RPC in the browser.
    if (import.meta.env.SSR) {
      const { adminHealthPage } = await import("~/lib/server/adminReads");
      const res = await adminHealthPage();
      if (!res.ok) throw new Error(res.error);
      return res.data;
    }
    const { adminHealthFn } = await import("~/lib/server/adminFns");
    const res = await adminHealthFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  component: HealthPage,
});

function Nav() {
  return (
    <nav className="flex items-center gap-3 text-sm">
      <Link to="/admin/accounts" search={{}} className="text-brand-700 hover:underline">Accounts</Link>
      <Link to="/admin/metrics" search={{}} className="text-brand-700 hover:underline">Metrics</Link>
      <Link to="/admin/health" search={{}} className="font-semibold text-brand-700">System health</Link>
      <Link to="/admin/audit" search={{}} className="text-brand-700 hover:underline">Audit log</Link>
    </nav>
  );
}

function HealthPage() {
  const h = Route.useLoaderData() as AdminHealthView;
  const maxCount = Math.max(1, ...h.funnel.map((s) => s.count));
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">System health</h1>
          <p className="mt-1 text-sm text-slate-600">
            {h.totals.businesses} business{h.totals.businesses === 1 ? "" : "es"} · {h.totals.users} users ·
            all numbers aggregate across every account.
          </p>
        </div>
        <Nav />
      </div>

      {/* Aggregate funnel */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Recovery funnel — all businesses
        </h2>
        <div className="mt-4 space-y-2">
          {h.funnel.map((s) => (
            <div key={s.key} className="flex items-center gap-3">
              <span className="w-48 shrink-0 text-sm text-slate-600">{s.label}</span>
              <div className="h-4 flex-1 rounded bg-slate-100">
                <div
                  className="h-4 rounded bg-brand-500"
                  style={{ width: `${Math.round((s.count / maxCount) * 100)}%` }}
                />
              </div>
              <span className="w-12 text-right text-sm font-semibold text-slate-900">{s.count}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Notifications / errors */}
      <section className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Notifications by type (DB-backed)
          </h2>
          {Object.keys(h.notificationsByType).length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">No notifications recorded yet.</p>
          ) : (
            <ul className="mt-3 space-y-1.5 text-sm">
              {Object.entries(h.notificationsByType).map(([type, n]) => (
                <li key={type} className="flex items-center justify-between">
                  <span className="capitalize text-slate-700">{type.replace(/_/g, " ")}</span>
                  <Badge tone={type === "payment_failed" ? "red" : "slate"}>{n}</Badge>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Recent Stripe webhook events
          </h2>
          {h.stripeEvents.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              No Stripe webhook events received (Stripe not connected yet).
            </p>
          ) : (
            <ul className="mt-3 max-h-64 space-y-1.5 overflow-y-auto text-sm">
              {h.stripeEvents.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-slate-700" title={e.id}>{e.type}</span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {formatDateTime(e.receivedAt)}{" "}
                    {e.processed ? (
                      <Badge tone="green">processed</Badge>
                    ) : (
                      <Badge tone="amber">unprocessed</Badge>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {h.stripeUnprocessedCount > 0 ? (
            <p className="mt-2 text-xs font-medium text-amber-700">
              {h.stripeUnprocessedCount} unprocessed event{h.stripeUnprocessedCount === 1 ? "" : "s"} —
              deliveries crashed mid-handler or are awaiting retry.
            </p>
          ) : null}
        </div>
      </section>

      {/* Integration status — honest, env-only */}
      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Integrations — configured vs dormant
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {h.integrations.map((i) => (
            <div key={i.key} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-slate-900">{i.label}</p>
                {i.configured ? <Badge tone="green">configured</Badge> : <Badge tone="slate">dormant</Badge>}
              </div>
              <p className="mt-1 text-xs text-slate-500">{i.note}</p>
              <p className="mt-2 font-mono text-[11px] text-slate-400">{i.envKeys.join(", ")}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-slate-400">
          Status is derived from environment variable presence only — the app never fabricates a
          connection.
        </p>
      </section>
      {/* P4-I: in-app error sink — recent unhandled errors + failed deliveries */}
      <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Recent system errors
          </h2>
          <Badge tone={h.systemErrorCount1h > 0 ? "amber" : "green"}>
            {h.systemErrorCount1h} in the last hour
          </Badge>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Recorded by the in-app error sink (system_errors): unhandled route/server errors, failed
          SMS deliveries, and degraded voice calls. Also exposed as a count on /api/healthz/ready
          for external uptime monitors.
        </p>
        {h.systemErrors.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No errors recorded. The sink is armed and empty.</p>
        ) : (
          <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto text-sm">
            {h.systemErrors.map((e) => (
              <li key={e.id} className="rounded-lg border border-slate-200 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-xs text-slate-500">{e.source}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone={e.severity === "error" ? "red" : "amber"}>{e.severity}</Badge>
                    <span className="text-xs text-slate-400">{formatDateTime(e.createdAt)}</span>
                  </span>
                </div>
                <p className="mt-1 break-words text-slate-700">{e.message}</p>
                {e.businessId ? (
                  <p className="mt-1 font-mono text-[11px] text-slate-400">business {e.businessId}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
