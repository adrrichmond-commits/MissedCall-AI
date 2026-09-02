import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getSessionFn, type CurrentUserView } from "~/lib/server/sessionFns";
import { AppShell } from "~/components/app/AppShell";
import { VerifyEmailBanner } from "~/components/app/VerifyEmailBanner";

export const Route = createFileRoute("/_app")({
  beforeLoad: async (): Promise<{ user: CurrentUserView } | void> => {
    // Server-side session check. No valid session → redirect to /login
    // before anything renders. This is the protected-route gate.
    const session = await getSessionFn();
    if (!session)
      throw redirect({
        to: "/login",
        search: { next: undefined } as { next: string | undefined },
      });
    return { user: session };
  },
  component: AppLayout,
});

function AppLayout() {
  const { user } = Route.useRouteContext() as { user: CurrentUserView };
  return (
    <AppShell user={user}>
      {!user.emailVerified ? <VerifyEmailBanner /> : null}
      <Outlet />
    </AppShell>
  );
}
