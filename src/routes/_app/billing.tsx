import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  cancelSubscriptionFn,
  changePlanFn,
  getBillingOverviewFn,
  type BillingOverview,
} from "~/lib/server/billingFns";
import { formatPlanPrice } from "~/lib/pricing";
import { PageHeader, PageLoading, ErrorState } from "~/components/app/pageStates";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";

export const Route = createFileRoute("/_app/billing")({
  loader: async () => {
    const res = await getBillingOverviewFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState
      message="Billing couldn't load. Check your connection and retry."
      onRetry={() => window.location.reload()}
    />
  ),
  component: BillingPage,
});

type SaveState = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string };

function PlanCard({
  plan,
  currentPlanId,
  canEdit,
  busy,
  onSwitch,
}: {
  plan: BillingOverview["plans"][number];
  currentPlanId: string;
  canEdit: boolean;
  busy: boolean;
  onSwitch: (planId: string) => void;
}) {
  const isCurrent = plan.id === currentPlanId;
  return (
    <section
      className={`flex flex-col rounded-2xl border bg-white p-5 shadow-sm sm:p-6 ${
        isCurrent ? "border-brand-500 ring-2 ring-brand-500/20" : "border-slate-200"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-900">{plan.name}</h3>
          <p className="mt-1 text-sm text-slate-600">{plan.tagline}</p>
        </div>
        {isCurrent ? <Badge tone="brand">Current plan</Badge> : null}
      </div>
      <p className="mt-4 flex items-baseline gap-1">
        <span className="text-3xl font-bold text-slate-900">${formatPlanPrice(plan)}</span>
        <span className="text-sm text-slate-500">/month</span>
      </p>
      <ul className="mt-4 flex-1 space-y-2">
        {plan.features.map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-slate-700">
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="mt-0.5 h-4 w-4 shrink-0 text-brand-600"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M16.704 5.29a1 1 0 010 1.415l-7.5 7.5a1 1 0 01-1.414 0l-3.5-3.5a1 1 0 111.414-1.415l2.793 2.793 6.793-6.793a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            {feature}
          </li>
        ))}
      </ul>
      <div className="mt-5">
        {canEdit ? (
          <Button
            variant={isCurrent ? "secondary" : "primary"}
            disabled={isCurrent || busy}
            onClick={() => onSwitch(plan.id)}
            className="w-full"
          >
            {isCurrent ? "Current plan" : `Switch to ${plan.name}`}
          </Button>
        ) : (
          <Button variant="secondary" disabled className="w-full">
            Owner access required
          </Button>
        )}
      </div>
    </section>
  );
}

function BillingPage() {
  const data = Route.useLoaderData();
  const [view, setView] = useState(data);
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const canEdit = view.canEdit;
  const canceled = view.subscriptionStatus === "canceled";

  const refresh = async () => {
    const res = await getBillingOverviewFn();
    if (res.ok) setView(res.data);
  };

  const switchPlan = async (planId: string) => {
    setState({ kind: "busy" });
    setStatusMessage(null);
    const res = await changePlanFn({ data: { planId } });
    if (res.ok) {
      setStatusMessage(res.data.message);
      await refresh();
    } else {
      setState({ kind: "error", message: res.error });
      return;
    }
    setState({ kind: "idle" });
  };

  const cancel = async () => {
    setState({ kind: "busy" });
    setStatusMessage(null);
    const res = await cancelSubscriptionFn();
    setConfirmingCancel(false);
    if (res.ok) {
      setStatusMessage(res.data.message);
      await refresh();
    } else {
      setState({ kind: "error", message: res.error });
      return;
    }
    setState({ kind: "idle" });
  };

  return (
    <div>
      <PageHeader
        title="Billing"
        description="Choose the plan that fits your shop. Only the business owner can make plan changes."
      />

      <div aria-live="polite" className="space-y-2">
        {state.kind === "error" ? (
          <p className="text-sm font-medium text-red-700" role="alert">
            {state.message}
          </p>
        ) : null}
        {statusMessage ? (
          <p className="text-sm font-medium text-green-700" role="status">
            ✓ {statusMessage}
          </p>
        ) : null}
        {state.kind === "busy" ? (
          <p className="text-sm text-slate-500" role="status">
            Working…
          </p>
        ) : null}
      </div>

      {!canEdit ? (
        <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          Your role has read-only access to billing. Ask the business owner to make plan changes.
        </p>
      ) : null}

      <p className="mb-4 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900 ring-1 ring-inset ring-sky-200">
        {view.phaseNote}
      </p>

      {/* Current plan + trial state */}
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold text-slate-900">Current plan</h2>
          {view.trialEndsAt && view.trialDaysRemaining !== null && !view.trialExpired ? (
            <Badge tone={view.trialDaysRemaining <= 3 ? "amber" : "brand"}>
              Trial: {view.trialDaysRemaining} {view.trialDaysRemaining === 1 ? "day" : "days"} remaining
            </Badge>
          ) : null}
          {view.trialExpired ? <Badge tone="amber">Trial ended</Badge> : null}
          {canceled ? <Badge tone="slate">Subscription canceled</Badge> : null}
        </div>
        <p className="mt-2 text-2xl font-bold text-slate-900">
          {view.planName ?? "No plan selected"}
        </p>
        <p className="mt-1 text-sm text-slate-600">
          {view.plan === "trial"
            ? "You're on the free trial tier. Pick Starter or Pro below whenever you're ready."
            : "Your plan selection is recorded on the account."}
          {view.trialEndsAt
            ? ` Trial ends ${new Date(view.trialEndsAt).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}.`
            : ""}
        </p>
      </section>

      {/* Tier cards */}
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {view.plans.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            currentPlanId={view.plan}
            canEdit={canEdit}
            busy={state.kind === "busy"}
            onSwitch={switchPlan}
          />
        ))}
      </div>

      {/* Cancel — owner only, two-step confirm, data-preserving by design */}
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">Cancel subscription</h2>
        <p className="mt-1 text-sm text-slate-600">
          Canceling stops your subscription. Your account, leads, and settings are preserved, and
          you can pick a plan again anytime.
        </p>
        {canEdit ? (
          confirmingCancel ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <p className="text-sm font-medium text-slate-900">
                Cancel your subscription and stop future billing?
              </p>
              <div className="flex gap-2">
                <Button variant="primary" disabled={state.kind === "busy"} onClick={cancel}>
                  Yes, cancel subscription
                </Button>
                <Button variant="secondary" disabled={state.kind === "busy"} onClick={() => setConfirmingCancel(false)}>
                  Keep subscription
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <Button variant="secondary" disabled={state.kind === "busy"} onClick={() => setConfirmingCancel(true)}>
                Cancel subscription
              </Button>
            </div>
          )
        ) : null}
      </section>
    </div>
  );
}
