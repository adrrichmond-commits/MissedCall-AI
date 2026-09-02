import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "~/components/app/AppShell";

export const Route = createFileRoute("/_app/appointments")({
  component: AppointmentsPage,
});

function AppointmentsPage() {
  return (
    <PagePlaceholder
      title="Appointments"
      description="Booked jobs with schedule, technician, and status at a glance."
    />
  );
}
