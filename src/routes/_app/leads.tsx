import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "~/components/app/AppShell";

export const Route = createFileRoute("/_app/leads")({
  component: LeadsPage,
});

function LeadsPage() {
  return (
    <PagePlaceholder
      title="Leads"
      description="Every missed call becomes a lead here — contact, service need, urgency, and status."
    />
  );
}
