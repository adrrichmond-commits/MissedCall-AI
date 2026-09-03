import { useEffect, useState } from "react";
import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { getSessionFn, type CurrentUserView } from "~/lib/server/sessionFns";
import { getOnboardingNudgeFn, type OnboardingNudge } from "~/lib/server/settingsFns";
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
      <OnboardingNudgeBanner role={user.role} />
      <Outlet />
    </AppShell>
  );
}

/**
 * Soft nudge for businesses that haven't finished setup. No redirects — the
 * banner links to /onboarding and can be dismissed for the session. Owners
 * and managers only; employees never see it.
 */
function OnboardingNudgeBanner({ role }: { role: CurrentUserView["role"] }) {
  const [nudge, setNudge] = useState<OnboardingNudge | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (role !== "owner" && role !== "manager") return;
    let alive = true;
    getOnboardingNudgeFn()
      .then((n) => {
        if (alive && n) setNudge(n);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [role]);
  if (dismissed || !nudge || !nudge.needsOnboarding || !nudge.canEdit) return null;
  return (
    <div className="border-b border-brand-100 bg-brand-50 px-4 py-2.5 sm:px-6">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <p className="text-sm text-brand-900">
          Finish setting up your business —{" "}
          <Link to="/onboarding" className="font-semibold underline underline-offset-2">
            continue onboarding ({nudge.percent}% complete)
          </Link>
          . It takes about 5 minutes.
        </p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss setup reminder"
          className="shrink-0 rounded-md p-1 text-brand-700 hover:bg-brand-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
