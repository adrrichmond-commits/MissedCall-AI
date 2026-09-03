import { useEffect, useState } from "react";
import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { getSessionFn, type CurrentUserView } from "~/lib/server/sessionFns";
import { getOnboardingNudgeFn, type OnboardingNudge } from "~/lib/server/settingsFns";
import { getTrialStatusFn, type TrialStatus } from "~/lib/server/sessionFns";
import { PLANS } from "~/lib/pricing";
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
      <TrialBanner role={user.role} />
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
/**
 * Persistent trial banner (Phase 2 owner brief #14): owners and managers see
 * "X days left" while the 14-day trial runs, with upgrade CTAs built from the
 * pricing config (never hard-coded), and a read-only "Trial expired" state
 * once it ends. Data is never touched on expiry — writes are blocked at the
 * server-fn layer, reads and billing stay available.
 */
function TrialBanner({ role }: { role: CurrentUserView["role"] }) {
  const [status, setStatus] = useState<TrialStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (role !== "owner" && role !== "manager") return;
    let alive = true;
    getTrialStatusFn()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [role]);
  if (dismissed || !status || role === "employee") return null;
  if (status.onPaidPlan) return null;
  const upgradeHref = PLANS[0]?.checkoutUrl ?? "/billing";

  if (status.trialExpired) {
    return (
      <div className="border-b border-red-200 bg-red-50 px-4 py-2.5 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium text-red-900">
            Your free trial has ended, so your account is read-only. Your data is safe — upgrade to
            keep making changes.
          </p>
          <div className="flex shrink-0 items-center gap-3">
            <a
              href={upgradeHref}
              className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
            >
              View plans &amp; upgrade
            </a>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              aria-label="Dismiss trial notice"
              className="rounded-md p-1 text-red-700 hover:bg-red-100"
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    );
  }

  const days = status.trialDaysRemaining;
  if (days <= 0) return null;
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-amber-900">
          <span className="font-semibold">
            {days === 1 ? "1 day" : `${days} days`} left
          </span>{" "}
          in your free trial — upgrade anytime to keep MissedCall AI answering.
        </p>
        <div className="flex shrink-0 items-center gap-3">
          <a
            href={upgradeHref}
            className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-700"
          >
            Upgrade
          </a>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss trial reminder"
            className="rounded-md p-1 text-amber-700 hover:bg-amber-100"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
