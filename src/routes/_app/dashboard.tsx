import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "~/components/app/AppShell";

export const Route = createFileRoute("/_app/dashboard")({
  component: DashboardPage,
});

function DashboardPage() {
  return (
    <PagePlaceholder
      title="Dashboard"
      description="A live view of missed-call leads, booked jobs, and recovery rate for your business."
    />
  );
}
