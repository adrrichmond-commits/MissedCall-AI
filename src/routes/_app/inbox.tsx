import { createFileRoute } from "@tanstack/react-router";
import { PagePlaceholder } from "~/components/app/AppShell";

export const Route = createFileRoute("/_app/inbox")({
  component: InboxPage,
});

function InboxPage() {
  return (
    <PagePlaceholder
      title="Inbox"
      description="AI text conversations with your missed callers, threaded and summarized."
    />
  );
}
