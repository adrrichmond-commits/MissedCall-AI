import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "~/components/app/AppShell";

export const Route = createFileRoute("/_app/analytics")({
  component: AnalyticsPage,
});

function AnalyticsPage() {
  return (
    <PagePlaceholder
      title="Analytics"
      description="Call recovery, lead conversion, and revenue trends over time."
    />
  );
}
