import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { getLeadFn, updateLeadStatusFn } from "~/lib/server/appFns";
import {
  ErrorState,
  PageLoading,
  PriorityBadge,
  StatusBadge,
} from "~/components/app/pageStates";
import { formatDateTime, formatMoney, labelEnum } from "~/lib/format";
export const Route = createFileRoute("/_app/leads/$leadId")({
  loader: async ({ params }) => {
    const res = await getLeadFn({ data: { leadId: params.leadId } });
    if (!res.ok) {
      throw res.status === 404
        ? { status: 404, message: "This lead doesn't exist or belongs to another business." }
        : new Error(res.error);
    }
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: ({ error }) => {
    const status = (error as { status?: number }).status;
    if (status === 404) {
      return (
        <EmptyStateish
          title="Lead not found"
          description="This lead doesn't exist or belongs to another business."
          backHref="/leads"
          backLabel="Back to leads"
        />
      );
    }
    return (
      <ErrorState
        message="The lead detail couldn't load. Check your connection and retry."
        onRetry={() => window.location.reload()}
      />
    );
  },
  component: LeadDetailPage,
});
function EmptyStateish({ title, description, backHref, backLabel }: { title: string; description: string; backHref: string; backLabel: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-slate-500">{description}</p>
      <a href={backHref} className="mt-4 inline-flex h-9 items-center rounded-lg bg-white px-4 text-sm font-semibold text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50">
        {backLabel}
      </a>
    </div>
  );
}
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-100 py-2.5 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-sm text-slate-800 sm:text-right">{children}</dd>
    </div>
  );
}
/** Lifecycle statuses from migration 005 (mirrors LEAD_STATUSES server-side). */
const STATUS_OPTIONS = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "booked", label: "Booked" },
  { value: "completed", label: "Completed" },
  { value: "lost", label: "Lost" },
] as const;
function LeadDetailPage() {
  const lead = Route.useLoaderData();
  const [status, setStatus] = useState(lead.status);
  const [savedStatus, setSavedStatus] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function changeStatus(next: string) {
    if (next === status || busy) return;
    setBusy(true);
    setErrorMsg(null);
    const res = await updateLeadStatusFn({ data: { leadId: lead.id, status: next } });
    if (res.ok) {
      setStatus(res.data.status);
      setSavedStatus(res.data.status);
      window.setTimeout(() => setSavedStatus(null), 2500);
    } else {
      setErrorMsg(res.error);
    }
    setBusy(false);
  }
  return (
    <div>
      <a href="/leads" className="text-sm font-semibold text-brand-700 hover:text-brand-800">
        ← Back to leads
      </a>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">{lead.contactName}</h1>
          <PriorityBadge priority={lead.priority} />
          <StatusBadge status={status} />
        </div>
        <p className="text-sm text-slate-500">Created {formatDateTime(lead.createdAt)}</p>
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {/* Contact + details */}
        <div className="space-y-4 lg:col-span-2">
          <section aria-labelledby="lead-contact" className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 id="lead-contact" className="text-sm font-semibold text-slate-900">
              Contact
            </h2>
            <dl className="mt-3">
              <DetailRow label="Name">{lead.contactName}</DetailRow>
              <DetailRow label="Phone">
                <a href={"tel:" + lead.contactPhone} className="text-brand-700 hover:text-brand-800">
                  {lead.contactPhone}
                </a>
              </DetailRow>
              <DetailRow label="Email">
                {lead.contactEmail ? (
                  <a href={"mailto:" + lead.contactEmail} className="text-brand-700 hover:text-brand-800">
                    {lead.contactEmail}
                  </a>
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label="Job address">{lead.contactAddress ?? "—"}</DetailRow>
            </dl>
          </section>
          <section aria-labelledby="lead-job" className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 id="lead-job" className="text-sm font-semibold text-slate-900">
              Job
            </h2>
            <dl className="mt-3">
              <DetailRow label="Service need">{lead.serviceNeed}</DetailRow>
              <DetailRow label="Priority">
                <PriorityBadge priority={lead.priority} />
              </DetailRow>
              <DetailRow label="Urgency">{labelEnum(lead.urgency)}</DetailRow>
              <DetailRow label="Source">{labelEnum(lead.source)}</DetailRow>
              <DetailRow label="Est. value">{lead.estimatedValueCents != null ? formatMoney(lead.estimatedValueCents) : "—"}</DetailRow>
              <DetailRow label="Description">{lead.description ?? "—"}</DetailRow>
              <DetailRow label="Internal notes">{lead.notes ?? "—"}</DetailRow>
            </dl>
          </section>
        </div>
        {/* Status + linked conversations */}
        <div className="space-y-4 self-start">
          <section aria-labelledby="lead-status" className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 id="lead-status" className="text-sm font-semibold text-slate-900">
              Lifecycle status
            </h2>
            {lead.canEditStatus ? (
              <div className="mt-3">
                <label htmlFor="lead-status-select" className="sr-only">
                  Lifecycle status
                </label>
                <select
                  id="lead-status-select"
                  value={status}
                  disabled={busy}
                  onChange={(e) => void changeStatus(e.target.value)}
                  className="h-9 w-full rounded-lg border-0 bg-white pl-3 pr-8 text-sm text-slate-700 ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-brand-500"
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <div aria-live="polite" className="mt-2 min-h-5 text-sm">
                  {busy ? <p className="text-slate-500" role="status">Saving…</p> : null}
                  {savedStatus ? (
                    <p className="text-green-700" role="status">
                      ✓ Saved — marked {savedStatus}
                    </p>
                  ) : null}
                  {errorMsg ? (
                    <p className="text-red-700" role="alert">{errorMsg}</p>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-slate-400">
                  Owner and manager only. Winning the job (booked/completed) records the conversion time.
                </p>
              </div>
            ) : (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
                Your role has read-only access to lead statuses. Ask the owner or a manager to make changes.
              </p>
            )}
          </section>
          <section aria-labelledby="lead-convs" className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 id="lead-convs" className="text-sm font-semibold text-slate-900">
              SMS conversations
            </h2>
            {lead.conversations.length === 0 ? (
              <p className="mt-3 rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
                No conversation was captured for this lead.
              </p>
            ) : (
              <ul className="mt-3 space-y-3">
                {lead.conversations.map((c) => (
                  <li key={c.id} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge status={c.status} />
                      <span className="text-xs text-slate-400">{c.messageCount} messages</span>
                    </div>
                    {c.summary ? <p className="mt-2 text-sm text-slate-700">{c.summary}</p> : null}
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-xs text-slate-400">
                        Last activity {c.lastMessageAt ? formatDateTime(c.lastMessageAt) : "—"}
                      </span>
                      <a href={"/inbox?c=" + c.id} className="text-xs font-semibold text-brand-700 hover:text-brand-800">
                        Open in inbox →
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
