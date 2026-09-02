import { createFileRoute } from "@tanstack/react-router";
import { getAppointmentsFn } from "~/lib/server/appFns";
import { EmptyState, ErrorState, PageHeader, PageLoading, StatusBadge } from "~/components/app/pageStates";
import { formatDateTime } from "~/lib/format";

export const Route = createFileRoute("/_app/appointments")({
  loader: async () => {
    const res = await getAppointmentsFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState
      message="Appointments couldn't load. Check your connection and retry."
      onRetry={() => window.location.reload()}
    />
  ),
  component: AppointmentsPage,
});

function ApptCard({ a }: { a: { id: string; serviceSummary: string; technicianName: string | null; scheduledAt: string; durationMinutes: number; status: string; address: string | null; notes: string | null; leadName: string | null; leadPhone: string | null } }) {
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">{a.serviceSummary}</p>
        <StatusBadge status={a.status} />
      </div>
      <p className="mt-1 text-sm text-slate-700">
        {formatDateTime(a.scheduledAt)} · {a.durationMinutes} min
      </p>
      <p className="mt-0.5 text-sm text-slate-600">
        {a.leadName ?? "Customer removed"}{a.leadPhone ? ` · ${a.leadPhone}` : ""}
      </p>
      {a.address ? <p className="mt-0.5 text-sm text-slate-500">{a.address}</p> : null}
      {a.technicianName ? <p className="mt-0.5 text-xs text-slate-500">Tech: {a.technicianName}</p> : null}
      {a.notes ? <p className="mt-1 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">{a.notes}</p> : null}
    </li>
  );
}

function AppointmentsPage() {
  const data = Route.useLoaderData();

  return (
    <div>
      <PageHeader
        title="Appointments"
        description="Booked jobs from captured leads — upcoming on top, history below."
      />

      <section aria-labelledby="appts-upcoming">
        <h2 id="appts-upcoming" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Upcoming ({data.upcoming.length})
        </h2>
        {data.upcoming.length === 0 ? (
          <EmptyState
            title="Nothing upcoming"
            description="Booked appointments will appear here as conversations convert."
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {data.upcoming.map((a) => (
              <ApptCard key={a.id} a={a} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="appts-past" className="mt-8">
        <h2 id="appts-past" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Past ({data.past.length})
        </h2>
        {data.past.length === 0 ? (
          <EmptyState
            title="No past appointments"
            description="Completed, cancelled, and no-show jobs will be listed here."
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {data.past.map((a) => (
              <ApptCard key={a.id} a={a} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
