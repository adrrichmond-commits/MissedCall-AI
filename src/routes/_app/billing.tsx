import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  cancelSubscriptionFn,
  getBillingDetailsFn,
  getBillingOverviewFn,
  reactivateSubscriptionFn,
  requestPlanChangeFn,
  type BillingOverview,
  type BillingOverviewP3F,
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
  stripeApiConfigured,
}: {
  plan: BillingOverview["plans"][number];
  currentPlanId: string;
  canEdit: boolean;
  stripeApiConfigured: boolean;
}) {
  const isCurrent = plan.id === currentPlanId;
  const cta =
    plan.id === "pro"
      ? "Upgrade to Pro — $" + formatPlanPrice(plan) + "/mo"
      : "Switch to Starter — $" + formatPlanPrice(plan) + "/mo";
  const [busy, setBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);
  // API-driven checkout (primary when the Stripe key is configured): the
  // server creates a Checkout Session scoped to this business and the browser
  // redirects to Stripe's hosted page. Without keys, fall back to the hosted
  // payment link (pricing.ts checkoutUrl) — same behavior as before.
  const startCheckout = async () => {
    setBusy(true);
    setCardError(null);
    const res = await requestPlanChangeFn({ data: { planId: plan.id } });
    if (res.ok && res.data.checkoutUrl) {
      window.location.href = res.data.checkoutUrl;
      return;
    }
    setBusy(false);
    if (res.ok) {
      setCardError(res.data.message);
    } else {
      setCardError(res.error);
    }
  };
  const checkoutControl = canEdit ? (
    isCurrent ? (
      <Button variant="secondary" disabled className="w-full">
        Current plan
      </Button>
    ) : stripeApiConfigured ? (
      <Button variant="primary" disabled={busy} onClick={startCheckout} className="w-full">
        {busy ? "Opening Stripe checkout…" : cta}
      </Button>
    ) : (
      <a
        href={plan.checkoutUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
      >
        {cta}
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
          <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
          <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
        </svg>
      </a>
    )
  ) : (
    <Button variant="secondary" disabled className="w-full">
      Owner access required
    </Button>
  );
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
      {cardError ? (
        <p className="mt-4 text-sm font-medium text-red-700" role="alert">
          {cardError}
        </p>
      ) : null}
      <div className="mt-5">
        {checkoutControl}
        {!isCurrent ? (
          <p className="mt-2 text-center text-xs text-slate-400">
            {stripeApiConfigured
              ? "Checkout is handled securely on Stripe — your plan activates automatically after payment."
              : "Opens Stripe checkout in a new tab."}
          </p>
        ) : null}
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

  // Return landing from Stripe checkout (?checkout=success|cancelled — set by
  // the Checkout Session's success_url/cancel_url). Honest, read-only toast:
  // the plan itself only changes when the webhook confirms the subscription.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const result = new URLSearchParams(window.location.search).get("checkout");
    if (result === "success") {
      setStatusMessage(
        "Checkout started — welcome aboard! Your plan activates automatically once Stripe confirms the subscription.",
      );
    } else if (result === "cancelled") {
      setStatusMessage("Checkout was cancelled — nothing was charged and nothing changed. You can pick a plan anytime.");
    }
  }, []);

  const refresh = async () => {
    const res = await getBillingOverviewFn();
    if (res.ok) setView(res.data);
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
            stripeApiConfigured={view.stripeApiConfigured}
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
    <BillingDetailsSection />
      </div>
  );
}

// ---------------------------------------------------------------------------
// P3-F: usage vs limits, cancel banner (cancel_at_period_end), billing history
// ---------------------------------------------------------------------------
function UsageBar({ row }: { row: BillingOverviewP3F["usage"][number] }) {
  const pct = Math.min(100, row.percent);
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium text-slate-700">{row.label}</span>
        <span className={row.atLimit ? "font-semibold text-red-600" : "text-slate-500"}>
          {row.usageText}
          {row.atLimit ? " — limit reached" : ""}
        </span>
      </div>
      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${row.atLimit ? "bg-red-500" : "bg-brand-500"}`}
          style={{ width: pct + "%" }}
        />
      </div>
    </div>
  );
}

function BillingDetailsSection() {
  const [details, setDetails] = useState<BillingOverviewP3F | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // P3-H state sweep: usage/history load with explicit loading + error states
  // and a working retry. (The previous `useState(() => load())` ran a fetch as
  // a render side-effect, could double-fire, and swallowed failures silently.)
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoadState("loading");
    getBillingDetailsFn()
      .then((res) => {
        if (!alive) return;
        if (res.ok) {
          setDetails(res.data);
          setLoadState("ready");
        } else {
          setLoadState("error");
        }
      })
      .catch(() => {
        if (alive) setLoadState("error");
      });
    return () => {
      alive = false;
    };
  }, [reloadNonce]);
  if (loadState === "loading") {
    return (
      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-busy="true">
        <h3 className="text-base font-semibold text-slate-900">Usage this billing period</h3>
        <div className="mt-4 animate-pulse space-y-4" role="status" aria-label="Loading usage and billing history">
          {[0, 1].map((i) => (
            <div key={i} className="h-2 w-full rounded-full bg-slate-100" />
          ))}
          <div className="h-16 w-full rounded bg-slate-50" />
        </div>
      </section>
    );
  }
  if (loadState === "error" || !details) {
    return (
      <section className="mt-8">
        <ErrorState
          message="Usage and billing history couldn't load. Check your connection and retry."
          onRetry={() => setReloadNonce((n) => n + 1)}
        />
      </section>
    );
  }
  const reactivate = async () => {
    setBusy(true);
    const res = await reactivateSubscriptionFn();
    setBusy(false);
    setNote(res.ok ? res.data.message : res.error);
    // Re-read usage/history after reactivation (was load(), pre-refactor).
    setReloadNonce((n) => n + 1);
  };
  return (
    <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h3 className="text-base font-semibold text-slate-900">Usage this billing period</h3>
      <div className="mt-4 space-y-4">
        {details.usage.map((row) => (
          <UsageBar key={row.axis} row={row} />
        ))}
      </div>
      {details.usage.some((r) => r.atLimit) ? (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          You've used a plan allowance this month. Upgrade on the plan cards above to keep every recovery text flowing —
          emergency texts are never held back.
        </p>
      ) : null}
      {details.cancelAtPeriodEnd ? (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-amber-800">
            Cancellation scheduled — service continues for{" "}
            <strong>{details.daysUntilServiceEnd ?? 0} more days</strong>. Your data is preserved.
          </p>
          <Button variant="primary" disabled={busy} onClick={reactivate}>
            Reactivate
          </Button>
        </div>
      ) : null}
      {note ? <p className="mt-3 text-sm text-slate-600">{note}</p> : null}
      <h3 className="mt-8 text-base font-semibold text-slate-900">Billing history</h3>
      {details.billingConfigured ? null : (
        <p className="mt-2 text-sm text-slate-500">
          Billing isn't configured in this deployment yet — plan changes happen through the Stripe checkout links above,
          and this ledger fills in as payments and lifecycle changes land. No fake records here.
        </p>
      )}
      {details.history.length === 0 ? (
        <p className="mt-2 text-sm text-slate-500">No billing events yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {details.history.map((e) => (
            <li key={e.id} className="flex items-start justify-between gap-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-slate-700">{e.description ?? e.type}</p>
                <p className="text-xs text-slate-400">
                  {e.type} · {e.source}
                </p>
              </div>
              <time className="whitespace-nowrap text-xs text-slate-400">{e.occurredAt.slice(0, 10)}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
