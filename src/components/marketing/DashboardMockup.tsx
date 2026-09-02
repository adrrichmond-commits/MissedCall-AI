import type { ReactNode } from "react";
import { Badge } from "~/components/ui/Badge";

/** Browser chrome wrapper for the hero product mockup (CSS/SVG only, no images). */
export function BrowserFrame({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl shadow-slate-900/10">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-2.5">
        <span className="h-3 w-3 rounded-full bg-red-400" aria-hidden />
        <span className="h-3 w-3 rounded-full bg-amber-400" aria-hidden />
        <span className="h-3 w-3 rounded-full bg-emerald-400" aria-hidden />
        <div className="ml-3 flex h-6 flex-1 items-center rounded-md bg-white px-3 text-xs text-slate-400 ring-1 ring-inset ring-slate-200">
          app.missedcall.ai/dashboard
        </div>
      </div>
      <div className="p-4 sm:p-6">{children}</div>
    </div>
  );
}

type Stat = {
  label: string;
  value: string;
  hint: string;
};

const stats: Stat[] = [
  { label: "Missed Calls", value: "38", hint: "this week" },
  { label: "Recovered Leads", value: "31", hint: "82% followed up" },
  { label: "Appointments", value: "14", hint: "booked" },
  { label: "Estimated Revenue Recovered", value: "$12.4k", hint: "estimated" },
];

export function DashboardMockup() {
  return (
    <BrowserFrame>
      <div className="grid gap-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-900">Good morning, Mike</p>
            <p className="text-xs text-slate-500">Here&apos;s what came in while you were on the job.</p>
          </div>
          <span className="rounded-md bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 ring-1 ring-inset ring-brand-600/20">
            Live
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg border border-slate-200 bg-white p-3">
              <p className="text-[11px] font-medium text-slate-500">{s.label}</p>
              <p className="mt-1 text-xl font-bold tracking-tight text-slate-900">{s.value}</p>
              <p className="text-[11px] text-slate-400">{s.hint}</p>
            </div>
          ))}
        </div>

        {/* New Lead card */}
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">
                JS
              </span>
              <div>
                <p className="text-sm font-semibold text-slate-900">John Smith</p>
                <p className="text-xs text-slate-500">(801) 555-1234</p>
              </div>
            </div>
            <Badge tone="red">
              <span aria-hidden>🚨</span> URGENT
            </Badge>
          </div>

          <div className="grid gap-3 px-4 py-3 text-sm sm:grid-cols-2">
            <div>
              <p className="text-[11px] font-medium text-slate-500">Service</p>
              <p className="font-medium text-slate-900">Water heater leak</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-500">Address</p>
              <p className="font-medium text-slate-900">123 Main Street</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-500">Preferred time</p>
              <p className="font-medium text-slate-900">Tomorrow morning</p>
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-500">AI summary</p>
              <p className="text-slate-600">
                Customer reports active water heater leak. Wants a technician as soon as possible.
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-slate-100 px-4 py-3 sm:flex-row">
            <button className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">
              Call Customer
            </button>
            <button className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-slate-900 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
              View Lead
            </button>
          </div>
        </div>
      </div>
    </BrowserFrame>
  );
}
