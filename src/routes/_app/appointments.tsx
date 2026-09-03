import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  confirmAppointmentFn,
  declineAppointmentFn,
  getAppointmentsFn,
} from "~/lib/server/appFns";
import type { CurrentUserView } from "~/lib/server/sessionFns";
import {
  EmptyState,
  ErrorState,
  PageHeader,
  PageLoading,
  StatusBadge,
} from "~/components/app/pageStates";
import { Button } from "~/components/ui/Button";
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

interface ApptView {
  id: string;
  serviceSummary: string;
  technicianName: string | null;
  scheduledAt: string;
  durationMinutes: number;
  status: string;
  address: string | null;
  notes: string | null;
  leadName: string | null;
  leadPhone: string | null;
}

/**
 * One appointment card. Under the Phase 2 request-driven lifecycle
 * (migration 006) the business CONFIRMS or DECLINES a REQUESTED booking;
 * declined ones can be re-confirmed (the owner called the customer back).
 * Actions are owner/manager only and mirror the server-side requireActiveWrite
 * gate — employees simply never see the buttons.
 */
function ApptCard({ a, canManage }: { a: ApptView; canManage: boolean }) {
  const [status, setStatus] = useState(a.status);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const act = async (next: "confirm" | "decline") => {
    if (busy) return;
    setBusy(true);
    setErrorMsg(null);
    setOkMsg(null);
    const res =
      next === "confirm"
        ? await confirmAppointmentFn({ data: { appointmentId: a.id } })
        : await declineAppointmentFn({ data: { appointmentId: a.id } });
    if (res.ok) {
      setStatus(res.data.status);
      setOkMsg(next === "confirm" ? "Appointment confirmed." : "Appointment declined.");
    } else {
      setErrorMsg(res.error);
    }
    setBusy(false);
  };

  const actionable = canManage && (status === "requested" || status === "declined");

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-slate-900">{a.serviceSummary}</p>
        <StatusBadge status={status} />
      </div>
      <p className="mt-1 text-sm text-slate-700">
        {formatDateTime(a.scheduledAt)} · {a.durationMinutes} min
      </p>
      <p className="mt-0.5 text-sm text-slate-600">
        {a.leadName ?? "Customer removed"}{a.leadPhone ? " · " + a.leadPhone : ""}
      </p>
      {a.address ? <p className="mt-0.5 text-sm text-slate-500">{a.address}</p> : null}
      {a.technicianName ? <p className="mt-0.5 text-xs text-slate-500">Tech: {a.technicianName}</p> : null}
      {a.notes ? <p className="mt-1 rounded bg-slate-50 px-2 py-1 text-xs text-slate-600">{a.notes}</p> : null}
      {actionable ? (
        <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-3">
          {status === "requested" ? (
            <>
              <Button size="sm" onClick={() => void act("confirm")} disabled={busy}>
                {busy ? "Working…" : "Confirm"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void act("decline")} disabled={busy}>
                Decline
              </Button>
            </>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void act("confirm")} disabled={busy}>
              Confirm anyway
            </Button>
          )}
        </div>
      ) : null}
      {okMsg ? (
        <p className="mt-2 text-sm font-medium text-green-700" role="status">
          ✓ {okMsg}
        </p>
      ) : null}
      {errorMsg ? (
        <p className="mt-2 text-sm font-medium text-red-700" role="alert">
          {errorMsg}
        </p>
      ) : null}
    </li>
  );
}

function AppointmentsPage() {
  const data = Route.useLoaderData();
  const { user } = Route.useRouteContext() as { user: CurrentUserView };
  const canManage = user.role === "owner" || user.role === "manager";

  return (
    <div>
      <PageHeader
        title="Appointments"
        description={
          canManage
            ? "Requested bookings from captured leads — confirm or decline them, then they show as confirmed."
            : "Booked jobs from captured leads — upcoming on top, history below."
        }
      />

      <section aria-labelledby="appts-upcoming">
        <h2 id="appts-upcoming" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Upcoming ({data.upcoming.length})
        </h2>
        {data.upcoming.length === 0 ? (
          <EmptyState
            title="Nothing upcoming"
            description="Requested and confirmed appointments will appear here as conversations convert."
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {data.upcoming.map((a) => (
              <ApptCard key={a.id} a={a} canManage={canManage} />
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
            description="Completed and declined jobs will be listed here."
          />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {data.past.map((a) => (
              <ApptCard key={a.id} a={a} canManage={canManage} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
