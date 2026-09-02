/**
 * Shared building blocks for the authenticated app pages: page header,
 * metric cards, and the required page states (loading, empty, error).
 * Client-safe — no server imports.
 */
import type { ReactNode } from "react";
import { Badge } from "~/components/ui/Badge";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-slate-600">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  tone = "brand",
  href,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "brand" | "aqua" | "green" | "amber";
  href?: string;
}) {
  const toneCls =
    tone === "brand"
      ? "text-brand-600 bg-brand-50"
      : tone === "aqua"
        ? "text-aqua-700 bg-aqua-50"
        : tone === "green"
          ? "text-emerald-700 bg-emerald-50"
          : "text-amber-700 bg-amber-50";
  const body = (
    <div className="rounded-xl border border-slate-200 bg-white p-5 transition-shadow hover:shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-600">{label}</p>
        <span className={`h-2.5 w-2.5 rounded-full ${toneCls.split(" ")[1]}`} aria-hidden="true" />
      </div>
      <p className="mt-3 text-2xl font-bold tracking-tight text-slate-900 lg:text-3xl">{value}</p>
      {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
  return href ? (
    <a href={href} className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
      {body}
    </a>
  ) : (
    body
  );
}

export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="animate-pulse space-y-4" role="status" aria-live="polite" aria-label={label}>
      <div className="h-8 w-40 rounded bg-slate-200" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-28 rounded-xl border border-slate-200 bg-white p-5">
            <div className="h-4 w-24 rounded bg-slate-200" />
            <div className="mt-4 h-8 w-16 rounded bg-slate-100" />
          </div>
        ))}
      </div>
      <div className="h-64 rounded-xl border border-slate-200 bg-white" />
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="mx-auto h-10 w-10 text-slate-300"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-4l-2 2h-4l-2-2H4"
        />
      </svg>
      <p className="mt-3 text-sm font-semibold text-slate-900">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-6 py-10 text-center" role="alert">
      <p className="text-sm font-semibold text-red-800">Something went wrong</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-red-700">
        {message ?? "We couldn't load this data. Try again in a moment."}
      </p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex h-9 items-center rounded-lg bg-red-600 px-4 text-sm font-semibold text-white hover:bg-red-700"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

const STATUS_META: Record<string, { tone: "brand" | "aqua" | "slate" | "amber" | "red" | "green"; label: string }> = {
  new: { tone: "brand", label: "New" },
  contacted: { tone: "aqua", label: "Contacted" },
  qualified: { tone: "amber", label: "Qualified" },
  converted: { tone: "green", label: "Converted" },
  lost: { tone: "slate", label: "Lost" },
  active: { tone: "green", label: "Active" },
  awaiting_customer: { tone: "amber", label: "Awaiting customer" },
  booked: { tone: "brand", label: "Booked" },
  closed: { tone: "slate", label: "Closed" },
  scheduled: { tone: "brand", label: "Scheduled" },
  confirmed: { tone: "green", label: "Confirmed" },
  in_progress: { tone: "amber", label: "In progress" },
  completed: { tone: "slate", label: "Completed" },
  cancelled: { tone: "red", label: "Cancelled" },
  no_show: { tone: "red", label: "No-show" },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status];
  return (
    <Badge tone={meta?.tone ?? "slate"}>
      {meta?.label ?? status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
    </Badge>
  );
}
