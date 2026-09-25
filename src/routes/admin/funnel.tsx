/**
 * /admin/funnel — P4-A signup→paid funnel (platform-owner only).
 *
 * HONEST ZERO STATES: this page ships before launch traffic exists. A stage
 * with zero businesses shows 0 and "—", not a fabricated percentage. Demo
 * (seed) businesses are excluded from the primary series and reported
 * separately so the seed data can never dress the funnel up.
 */
import { createFileRoute } from "@tanstack/react-router";
import { adminFunnelDataFn } from "~/lib/server/adminFns";
import type { P4AFunnelView } from "~/lib/server/adminReads";

export const Route = createFileRoute("/admin/funnel")({
  loader: async (): Promise<P4AFunnelView> => {
    // PR #27 SSR rule: plain read during SSR (adminReads), RPC in the browser.
    if (import.meta.env.SSR) {
      const { adminFunnelPage } = await import("~/lib/server/adminReads");
      const res = await adminFunnelPage();
      if (!res.ok) throw new Error(res.error);
      return res.data;
    }
    const res = await adminFunnelDataFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  component: FunnelPage,
});

function FunnelPage() {
  const data = Route.useLoaderData() as P4AFunnelView;
  const hasAny = data.steps.some((s) => s.count > 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">Signup → paid funnel</h1>
          <p className="mt-1 text-sm text-slate-600">
            First-occurrence stage events per business (migration 019). Demo businesses are excluded
            from the numbers below.
          </p>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <a href="/admin/accounts" className="text-slate-600 hover:text-brand-700">Accounts</a>
          <a href="/admin/funnel" className="font-semibold text-brand-700">Funnel</a>
          <a href="/admin/prompts" className="text-slate-600 hover:text-brand-700">AI prompts</a>
          <a href="/admin/health" className="text-slate-600 hover:text-brand-700">System health</a>
          <a href="/admin/audit" className="text-slate-600 hover:text-brand-700">Audit log</a>
        </nav>
      </div>

      <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-900">End-to-end conversion (paid ÷ signup)</h2>
          <p className="text-2xl font-bold tracking-tight text-slate-900">
            {data.overallConversion === null ? "—" : data.overallConversion + "%"}
          </p>
        </div>
        {data.overallConversion === null ? (
          <p className="mt-1 text-xs text-slate-500">
            No conversions measurable yet — this fills as real businesses reach paid.
          </p>
        ) : null}
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2.5 font-semibold">Stage</th>
              <th className="px-4 py-2.5 font-semibold">Businesses</th>
              <th className="px-4 py-2.5 font-semibold">From previous stage</th>
            </tr>
          </thead>
          <tbody>
            {data.steps.map((s) => (
              <tr key={s.stage} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-3 font-medium text-slate-900">{s.label}</td>
                <td className="px-4 py-3 tabular-nums text-slate-700">{s.count}</td>
                <td className="px-4 py-3 tabular-nums text-slate-700">
                  {s.conversionFromPrev === null ? (
                    <span className="text-slate-400">—</span>
                  ) : (
                    s.conversionFromPrev + "%"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!hasAny ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          No funnel events recorded yet. This is the expected pre-launch state: the stage hooks are
          wired (signup, trial start, onboarding, phone connected, first lead, first recovered call,
          paid) and real numbers appear as businesses move through the pipeline. Nothing here is
          seeded or estimated.
        </div>
      ) : null}

      {data.demoCount > 0 ? (
        <p className="mt-4 text-xs text-slate-500">
          {data.demoCount} demo business{data.demoCount === 1 ? "" : "es"} on the platform are
          excluded above. Their stage counts (for reference):{" "}
          {Object.entries(data.allStages)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => k + " " + n)
            .join(", ") || "none"}.
        </p>
      ) : null}
    </div>
  );
}
