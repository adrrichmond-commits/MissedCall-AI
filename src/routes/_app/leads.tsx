import { createFileRoute, Outlet } from "@tanstack/react-router";

/**
 * Layout route for /leads: renders nothing itself. The list lives in
 * leads.index.tsx and the detail page in leads/$leadId.tsx — both render
 * through the Outlet below.
 */
export const Route = createFileRoute("/_app/leads")({
  component: () => <Outlet />,
});
