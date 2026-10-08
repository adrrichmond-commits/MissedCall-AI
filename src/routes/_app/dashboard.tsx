import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { getDashboardDataFn, getLineTestStatusFn, setFollowUpTaskDoneFn, startLineTestFn, type LineTestView } from "~/lib/server/appFns";
import type { LineTestLeg, LineTestLegKey, StoredLineTest } from "~/lib/lineTest";
import {
  EmptyState,
  ErrorState,
  MetricCard,
  PageHeader,
  PageLoading,
  PriorityBadge,
  StatusBadge,
} from "~/components/app/pageStates";
import { formatDateTime, formatMoney, formatRelative } from "~/lib/format";
import { trialValueView, type TrialValueView } from "~/lib/trialValue";
import type { RoiPanelData } from "~/lib/server/roi";
import { PLANS } from "~/lib/pricing";

export const Route = createFileRoute("/_app/dashboard")({
  // ?welcome=done — set by the onboarding finish step; renders the one-time
  // "you're live" panel below. Any non-empty value normalizes to "done".
  validateSearch: (s: Record<string, unknown>): { welcome?: string } => ({
    welcome: typeof s.welcome === "string" && s.welcome !== "" ? "done" : undefined,
  }),
  loader: async () => {
    const res = await getDashboardDataFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState message="The dashboard couldn't load. Check your connection and retry." onRetry={() => window.location.reload()} />
  ),
  component: DashboardPage,
});

/**
 * P4-O: the "you're live" landing state a plumber sees right after finishing
 * onboarding. Dismissible; honest about provider-gated delivery.
 */
function WelcomePanel() {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <div className="mb-4 rounded-2xl border border-green-200 bg-green-50 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-green-900">🎉 You're live!</h2>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-green-900">
            MissedCall AI is set up and watching your line. When a call goes unanswered, your
            caller gets a text-back, the AI captures what they need, and the lead shows up here.
          </p>
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-green-800">
            Email alerts deliver through your MissedCall AI email channel; real customer texting
            starts once carrier campaign approval (A2P) comes through. Your setup and data are
            ready now. Tune everything anytime in Settings.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Dismiss welcome message"
          className="shrink-0 rounded-md p-1 text-green-700 hover:bg-green-100"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

const LEG_LABELS: Record<LineTestLegKey, string> = {
  inbound: "Webhook received",
  aiReply: "AI reply sent",
  lead: "Lead captured",
  ownerAlert: "Owner alert",
};

/**
 * Phone line status (first-run self-test). On first load after the business
 * gets a line assigned, the system probes its own webhook with a signed,
 * honestly-labeled SYSTEM TEST message (from the business's own on-file alert
 * number — never a customer) and verifies the real pipeline answered: message
 * stored, AI reply sent, lead captured, owner alert recorded. The owner can
 * re-run it anytime; the result shown is always the stored outcome of a real
 * run — never a synthesized green.
 */
function PhoneLineStatusCard() {
  const [view, setView] = useState<LineTestView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const refresh = async () => {
    try {
      const res = await getLineTestStatusFn();
      if (res.ok) {
        setView(res.data);
        setLoadErr(null);
      } else {
        setLoadErr(res.error);
      }
    } catch {
      setLoadErr("Could not load the line status. Check your connection and retry.");
    }
  };

  // Poll while a run is in flight; stop when terminal so the page is calm.
  const running = view?.runningFresh === true;
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [running]);

  const runTest = async () => {
    setActionErr(null);
    setStarting(true);
    try {
      const res = await startLineTestFn();
      if (!res.ok) setActionErr(res.error);
      await refresh();
    } catch {
      setActionErr("Could not start the test. Check your connection and retry.");
    } finally {
      setStarting(false);
    }
  };

  const r: StoredLineTest | null = view?.result ?? null;
  const staleRun = r != null && r.status === "running" && !view?.runningFresh;

  return (
    <section
      data-testid="line-status-card"
      aria-labelledby="line-status"
      className="mt-4 rounded-xl border border-slate-200 bg-white"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
        <h2 id="line-status" className="text-sm font-semibold text-slate-900">
          Phone line status
        </h2>
        {view?.canRun && !running ? (
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={starting}
            className="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {starting ? "Starting…" : r ? "Run test again" : "Run test"}
          </button>
        ) : null}
      </div>
      <div className="px-4 py-4 sm:px-5">
        {loadErr ? (
          <p className="text-sm text-red-700">{loadErr}</p>
        ) : view == null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : !view.phoneAssigned ? (
          <p className="text-sm text-slate-600">
            No phone number is assigned to this business yet — the line test runs automatically once your
            number is provisioned.
          </p>
        ) : r == null ? (
          <p className="text-sm text-slate-600">
            Never run. The test fires automatically once, or run it now: it texts your own number with a
            clearly labeled SYSTEM TEST message and verifies the reply, the lead, and your alert all fire.
          </p>
        ) : r.status === "running" && view.runningFresh ? (
          <p className="text-sm text-slate-600" data-testid="line-status-running">
            Test running — the probe is in flight and the pipeline legs are being checked (up to ~90
            seconds)…
          </p>
        ) : staleRun ? (
          <div className="text-sm">
            <p className="font-semibold text-amber-700">A previous test is stuck (no result recorded).</p>
            <p className="mt-1 text-slate-600">
              Started {formatRelative(r.startedAt)}. Run again for a fresh result.
            </p>
          </div>
        ) : (
          <LineTestResultView r={r} />
        )}
        {actionErr ? <p className="mt-2 text-sm text-red-700">{actionErr}</p> : null}
      </div>
    </section>
  );
}

function LineTestResultView({ r }: { r: StoredLineTest }) {
  const tone =
    r.status === "pass"
      ? { chip: "bg-green-50 text-green-800 ring-green-600/20", text: "text-green-800", icon: "✅" }
      : r.status === "partial"
        ? { chip: "bg-amber-50 text-amber-800 ring-amber-600/20", text: "text-amber-800", icon: "🟠" }
        : r.status === "fail"
          ? { chip: "bg-red-50 text-red-800 ring-red-600/20", text: "text-red-800", icon: "❌" }
          : { chip: "bg-slate-100 text-slate-700 ring-slate-500/20", text: "text-slate-700", icon: "—" };
  const headline =
    r.status === "pass"
      ? "Pass — the full line pipeline answered."
      : r.status === "partial"
        ? "Partial — the pipeline ran, but not every leg verified."
        : r.status === "fail"
          ? "Failed — the line pipeline did not complete."
          : "Not configured";
  return (
    <div data-testid={"line-status-" + r.status}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset " +
            tone.chip
          }
        >
          {tone.icon} {r.status.toUpperCase()}
        </span>
        <span className={"text-sm font-medium " + tone.text}>{headline}</span>
        {r.finishedAt ? (
          <span className="text-xs text-slate-400">Run finished {formatRelative(r.finishedAt)}</span>
        ) : null}
        {r.trigger === "auto_first_run" ? (
          <span className="text-xs text-slate-400">· automatic first run</span>
        ) : null}
      </div>

      {r.status === "not_configured" ? (
        <p className="mt-2 text-sm text-slate-600">{r.reason ?? "Prerequisites for the test are missing."}</p>
      ) : (
        <>
          {r.lastPassAt && r.status !== "pass" ? (
            <p className="mt-1 text-xs text-slate-500">
              Last full pass: {formatRelative(r.lastPassAt)}.
            </p>
          ) : null}
          <ul className="mt-2 space-y-1.5">
            {(Object.keys(LEG_LABELS) as LineTestLegKey[]).map((key) => {
              const leg: LineTestLeg | undefined = r.legs?.[key];
              return (
                <li key={key} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span
                    className={
                      "inline-flex min-w-[6.5rem] justify-center rounded px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset " +
                      (!leg
                        ? "bg-slate-100 text-slate-500 ring-slate-400/20"
                        : leg.state === "observed"
                          ? "bg-green-50 text-green-800 ring-green-600/20"
                          : leg.state === "deduped"
                            ? "bg-sky-50 text-sky-800 ring-sky-600/20"
                            : "bg-red-50 text-red-800 ring-red-600/20")
                    }
                  >
                    {LEG_LABELS[key]}
                    {!leg ? " —" : leg.state === "observed" ? " ✓" : leg.state === "deduped" ? " ✓ (deduped)" : " ✗"}
                  </span>
                  <span className="text-slate-600">{leg?.detail ?? "Not checked this run."}</span>
                  {leg?.evidenceId ? (
                    <span className="text-xs text-slate-400">[{leg.evidenceId.slice(0, 8)}]</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {r.webhookHttpStatus != null && r.webhookHttpStatus !== 200 ? (
            <p className="mt-2 text-xs text-slate-500">
              Webhook evidence: HTTP {r.webhookHttpStatus}
              {r.webhookBodySnippet ? " — " + r.webhookBodySnippet : ""}
            </p>
          ) : null}
        </>
      )}
      {r.error ? <p className="mt-2 text-xs text-red-700">{r.error}</p> : null}
    </div>
  );
}

function DashboardPage() {
  const data = Route.useLoaderData();
  const { welcome } = Route.useSearch();
  // P4-V: the trial value indicator — the product paying for itself, visible
  // before the trial runs out. Real counts only (recovery-funnel "recovered").
  const trialView = data.trial
    ? trialValueView({
        isTrial: data.trial.active,
        recoveredCount: data.recoveredLeads,
        daysRemaining: data.trial.daysRemaining,
      })
    : null;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="A live view of your missed-call leads, conversations, and booked work."
        actions={
          data.isDemo ? (
            <span
              data-testid="demo-tag"
              className="inline-flex items-center rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-bold uppercase tracking-wide text-white"
              title="This dashboard shows the seeded demo data, not real customers."
            >
              Demo data
            </span>
          ) : undefined
        }
      />

      {welcome ? <WelcomePanel /> : null}

      {trialView?.show ? <TrialValueBanner view={trialView} /> : null}

      {/* Phone line status — the first-run self-test result. Honest states
          only: green only from a completed run, stale runs render as stale. */}
      <PhoneLineStatusCard />

      {/*
        P4-V owner priority order — what a plumber must act on, top to bottom:
        new leads → emergencies → recovered (missed-call saves) →
        appointment requests → revenue → follow-ups → recent activity.
      */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="New leads (7 days)"
          value={data.metrics.newLeadsThisWeek}
          tone="brand"
          hint="Calls captured in the last week"
          href="/leads"
        />
        <MetricCard
          label="Emergency leads"
          value={data.metrics.emergencyLeads}
          tone={data.metrics.emergencyLeads > 0 ? "red" : "amber"}
          hint={data.metrics.emergencyLeads > 0 ? "Open leads needing a callback today" : "No open emergencies"}
          href="/leads?priority=emergency"
        />
        <MetricCard
          label="Recovered (missed-call saves)"
          value={data.recoveredLeads}
          tone="aqua"
          hint="Missed callers the AI texted back and engaged"
          href="/leads?source=missed_call"
        />
        <MetricCard
          label="Appointment requests"
          value={data.metrics.requestedAppointments}
          tone="green"
          hint={
            data.metrics.requestedAppointments > 0
              ? data.metrics.confirmedAppointments + " confirmed upcoming - review and confirm"
              : "Requested by recovered leads, confirmed by you"
          }
          href="/appointments"
        />
      </div>

      {/* Priority 5: revenue — the "is this paying for itself" card */}
      <div className="mt-4">
        <RevenueCard revenue={data.revenue} />
      </div>

      {/* Priority 5b (P5-2): the ROI panel — what MissedCall AI recovered,
          measured counts + clearly-labeled estimates + subscription cost. */}
      <div className="mt-4">
        <RoiPanel roi={data.roi} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* Priority 6: follow-up queue (P3-C): open callbacks, oldest-due first */}
        <section aria-labelledby="follow-ups" className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 sm:px-5">
            <h2 id="follow-ups" className="text-sm font-semibold text-slate-900">
              Follow-ups
              {data.followUps.openCount > 0 ? (
                <span className="ml-2 inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-600/20">
                  {data.followUps.openCount} open
                </span>
              ) : null}
            </h2>
            <span className="text-xs text-slate-400">Call back, then mark done</span>
          </div>
          {data.followUps.tasks.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No follow-ups"
                description="Every captured lead gets a callback reminder here automatically."
              />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.followUps.tasks.map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
                  <MarkDoneButton taskId={t.id} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <a href={`/leads/${t.leadId}`} className="truncate text-sm font-semibold text-brand-700 hover:text-brand-800">
                        {t.leadName}
                      </a>
                      <span className="text-xs text-slate-400">Due {formatDateTime(t.dueAt)}</span>
                    </div>
                    <p className="mt-0.5 truncate text-sm text-slate-600">
                      {t.serviceNeed}
                      {t.leadPhone ? ` · ${t.leadPhone}` : ""}
                    </p>
                    {t.note ? <p className="mt-0.5 truncate text-xs text-slate-500">{t.note}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Priority 7: recent activity — leads first, then booked work */}
        <section aria-labelledby="recent-leads" className="rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 sm:px-5">
            <h2 id="recent-leads" className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              Recent leads
              {data.metrics.emergencyLeads > 0 ? (
                <a
                  href="/leads?priority=emergency"
                  title="Open leads marked emergency"
                  className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-600/20 hover:bg-red-100"
                >
                  🔴 {data.metrics.emergencyLeads} emergency
                </a>
              ) : null}
            </h2>
            <a href="/leads" className="text-xs font-semibold text-brand-700 hover:text-brand-800">
              View all
            </a>
          </div>
          {data.recentLeads.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="No leads yet"
                description="Leads appear here as soon as your first missed call is captured."
              />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentLeads.map((l) => (
                <li key={l.id}>
                  <a href={`/leads/${l.id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50 sm:px-5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-slate-900">{l.contactName}</p>
                        <PriorityBadge priority={l.priority} />
                        <StatusBadge status={l.status} />
                      </div>
                      <p className="mt-0.5 truncate text-sm text-slate-600">{l.serviceNeed}</p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        {formatRelative(l.createdAt)}
                        {l.hasConversation ? " · SMS conversation" : ""}
                      </p>
                    </div>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Next appointments */}
        <section aria-labelledby="next-appts" className="rounded-xl border border-slate-200 bg-white lg:col-span-2">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 sm:px-5">
            <h2 id="next-appts" className="text-sm font-semibold text-slate-900">
              Next appointments
            </h2>
            <a href="/appointments" className="text-xs font-semibold text-brand-700 hover:text-brand-800">
              View all
            </a>
          </div>
          {data.recentAppointments.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title="Nothing scheduled"
                description="Booked appointments will show up here once conversations convert."
              />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentAppointments.map((a) => (
                <li key={a.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-slate-900">{a.serviceSummary}</p>
                      <StatusBadge status={a.status} />
                    </div>
                    <p className="mt-0.5 text-sm text-slate-600">
                      {formatDateTime(a.scheduledAt)}
                      {a.technicianName ? ` · ${a.technicianName}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * P4-V: the trial value line. Prominent but honest — when the AI hasn't
 * recovered anyone yet it says exactly that and points at the fix
 * (connect your number), never a padded number.
 */
function TrialValueBanner({ view }: { view: TrialValueView }) {
  return (
    <div
      data-testid="trial-value-banner"
      role="status"
      aria-label="Trial value"
      className={`mt-4 rounded-2xl border p-5 ${
        view.zeroState ? "border-slate-200 bg-slate-50" : "border-green-200 bg-green-50"
      }`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className={`text-lg font-bold ${view.zeroState ? "text-slate-700" : "text-green-900"}`}>
          {view.headline}
        </p>
        {!view.zeroState ? (
          <a href="/leads" className="text-xs font-semibold text-green-700 hover:text-green-800">
            See recovered leads
          </a>
        ) : null}
      </div>
      <p className={`mt-1 text-sm ${view.zeroState ? "text-slate-500" : "text-green-800"}`}>
        {view.subline}
      </p>
    </div>
  );
}

function MarkDoneButton({ taskId }: { taskId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      aria-label="Mark follow-up done"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await setFollowUpTaskDoneFn({ data: { taskId, done: true } });
        window.location.reload();
      }}
      className="mt-0.5 h-5 w-5 flex-none rounded-full border-2 border-slate-300 hover:border-green-600 hover:bg-green-50 disabled:opacity-40"
      title="Mark done"
    >
      <span className="sr-only">Mark done</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// P3-D: Revenue Recovered — the primary KPI card
// ---------------------------------------------------------------------------

interface RevenueCardData {
  week: { wonLeads: number; recoveredCents: number };
  month: { wonLeads: number; recoveredCents: number };
  allTime: { wonLeads: number; recoveredCents: number };
  revenuePerLeadCents: number | null;
  conversionRate: number | null;
  recoveryRate: number | null;
  appointmentsPerRecoveredLead: number | null;
  hasRecovered: boolean;
}

function pct(rate: number | null): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

function ratioLabel(value: number | null): string {
  if (value == null) return "—";
  // One decimal is enough for a plumber's gut check ("1.3 jobs per lead").
  const rounded = Math.round(value * 10) / 10;
  return Number.isFinite(rounded) ? String(rounded) : "—";
}

/**
 * One card, not an analytics page: the three periods of recovered revenue up
 * front, the plain-language ratios underneath. All money arrives as USD cents
 * from the server and is formatted client-side via formatMoney.
 */
function RevenueCard({ revenue }: { revenue: RevenueCardData }) {
  return (
    <section
      aria-label="MissedCall AI generated revenue"
      className="rounded-xl border border-brand-200 bg-gradient-to-br from-brand-50 to-white p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">
          MissedCall AI generated revenue
        </h2>
        <p className="text-xs text-slate-400">From jobs won off recovered calls</p>
      </div>

      {!revenue.hasRecovered ? (
        <p className="mt-4 rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
          No recovered revenue yet — your first won job from a recovered call will show here.
        </p>
      ) : (
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {(
            [
              { label: "This week", sub: "jobs won from recovered calls", p: revenue.week },
              { label: "This month", sub: "won since the 1st, your timezone", p: revenue.month },
              { label: "All time", sub: "every job won since you started", p: revenue.allTime },
            ] as const
          ).map((item) => (
            <div key={item.label} className="rounded-lg bg-white/70 px-4 py-3 ring-1 ring-brand-100">
              <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
                {item.label}
              </p>
              <p className="mt-1 text-2xl font-bold text-slate-900">
                {formatMoney(item.p.recoveredCents)}
              </p>
              <p className="text-xs text-slate-500">
                {item.sub} · {item.p.wonLeads}
              </p>
            </div>
          ))}
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 border-t border-brand-100 pt-3 text-xs sm:grid-cols-4">
        <div>
          <dt className="text-slate-500">Revenue per lead</dt>
          <dd className="font-semibold text-slate-900">
            {formatMoney(revenue.revenuePerLeadCents)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Conversion rate</dt>
          <dd className="font-semibold text-slate-900" title="Won jobs ÷ all captured leads, all time">
            {pct(revenue.conversionRate)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Missed-call recovery</dt>
          <dd className="font-semibold text-slate-900" title="Missed calls we engaged ÷ captured missed calls, all time">
            {pct(revenue.recoveryRate)}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Appointments per lead</dt>
          <dd className="font-semibold text-slate-900" title="Appointments booked ÷ recovered missed-call leads">
            {ratioLabel(revenue.appointmentsPerRecoveredLead)}
          </dd>
        </div>
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------------------
// P5-2: Revenue & ROI panel — "is MissedCall AI paying for itself?"
// ---------------------------------------------------------------------------

/**
 * The visible "Estimate" chip — the honest-labeling contract made visible.
 * Rendered ONLY on derived figures (jobs won, revenue recovered, ROI); the
 * measured counts never carry it. The flags arrive from the server engine
 * (roi.ts estimateFlags) so the labeling cannot drift from the data.
 */
function EstimateChip({ title }: { title: string }) {
  return (
    <span
      data-testid="roi-estimate-chip"
      title={title}
      className="ml-1.5 inline-flex items-center rounded bg-amber-50 px-1.5 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-amber-700 ring-1 ring-inset ring-amber-600/20"
    >
      Estimate
    </span>
  );
}

function roiX(multiple: number | null): string {
  return multiple == null ? "—" : `${multiple}×`;
}

/**
 * The full ROI panel: measured funnel counts on top (live account data,
 * never estimated), the derived money figures beneath — every one visibly
 * labeled "Estimate" — and the subscription cost resolved from the one
 * pricing config (src/lib/pricing.ts). Trial businesses see their trial
 * state and what conversion means for billing; converted businesses see the
 * trial-to-paid conversion recorded.
 */
function RoiPanel({ roi }: { roi: RoiPanelData }) {
  const m = roi.measured;
  const est = roi.estimated;
  const billing = roi.billing;
  const cheapestPlanCents = Math.min(...PLANS.map((p) => p.priceCents));

  const measuredTiles = [
    { label: "Calls received", value: m.callsReceived, hint: "Calls captured - all missed calls until live voice answering is on" },
    { label: "Missed calls", value: m.missedCalls, hint: "Calls that rang out and were captured as leads" },
    { label: "Auto-responded", value: m.autoResponded, hint: "Missed calls your AI text-back handled" },
    { label: "Customer replies", value: m.customerReplies, hint: "Conversations where the customer texted back" },
    { label: "Leads recovered", value: m.leadsRecovered, hint: "Missed callers the AI engaged into a conversation" },
    { label: "Appointments booked", value: m.appointmentsBooked, hint: "Leads with at least one booked appointment" },
  ];

  return (
    <section
      data-testid="roi-panel"
      aria-label="Return on investment"
      className="rounded-xl border border-slate-200 bg-white p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Return on investment</h2>
        <a href="/analytics" className="text-xs font-semibold text-brand-700 hover:text-brand-800">
          Full analytics
        </a>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">
        Counts below are measured from your account's live data. Money figures are{" "}
        <span className="font-semibold text-amber-700">estimates</span> until verified by real jobs.
      </p>

      {/* Measured activity — real rows, never estimated */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {measuredTiles.map((t) => (
          <div key={t.label} className="rounded-lg bg-slate-50 px-3 py-2.5" title={t.hint}>
            <p className="text-[11px] font-medium leading-tight text-slate-500">{t.label}</p>
            <p className="mt-0.5 text-xl font-bold text-slate-900">{t.value}</p>
          </div>
        ))}
      </div>

      {/* Derived money figures — every one labeled "Estimate" */}
      {roi.hasActivity ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <div className="rounded-lg bg-brand-50 px-4 py-3 ring-1 ring-brand-100">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              Jobs won
              {roi.estimateFlags.jobsWon ? <EstimateChip title="Won leads valued at your invoice, quote, or the typical range for the job" /> : null}
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{est.jobsWon}</p>
            <p className="text-xs text-slate-500">leads marked won, all time</p>
          </div>
          <div className="rounded-lg bg-brand-50 px-4 py-3 ring-1 ring-brand-100">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              Revenue recovered
              {roi.estimateFlags.revenueRecovered ? <EstimateChip title="Valued at the invoice you entered, otherwise your quote, otherwise the typical range for the job" /> : null}
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-900">{formatMoney(est.revenueRecoveredCents)}</p>
            <p className="text-xs text-slate-500">all time · {formatMoney(est.revenueRecoveredMonthCents)} this month</p>
          </div>
          <div className="rounded-lg bg-brand-50 px-4 py-3 ring-1 ring-brand-100">
            <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
              ROI this month
              {roi.estimateFlags.roiMultiple ? <EstimateChip title="Estimated revenue recovered this month divided by your monthly subscription cost" /> : null}
            </p>
            <p
              className="mt-1 text-2xl font-bold text-slate-900"
              title={billing.monthlyCostCents > 0 ? "Estimated revenue recovered this month ÷ monthly subscription cost" : "Free trial — no billing yet"}
            >
              {roiX(est.roiMultiple)}
            </p>
            <p className="text-xs text-slate-500">
              {billing.monthlyCostCents > 0
                ? `${formatMoney(est.revenueRecoveredMonthCents)} ÷ ${formatMoney(billing.monthlyCostCents)}/mo`
                : "free trial — no billing yet"}
            </p>
          </div>
          <div className="rounded-lg bg-slate-50 px-4 py-3 ring-1 ring-slate-100">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Subscription</p>
            <p className="mt-1 text-2xl font-bold text-slate-900">
              {formatMoney(billing.monthlyCostCents)}
              <span className="text-sm font-medium text-slate-500">/mo</span>
            </p>
            <p className="text-xs text-slate-500">{billing.planName} plan</p>
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded-lg bg-slate-50 px-3 py-6 text-center text-sm text-slate-500">
          Nothing recovered yet — your first captured call starts the funnel, and estimated
          revenue appears after your first won job.
        </p>
      )}

      {/* Billing line — trial state and trial-to-paid conversion */}
      <p className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500" data-testid="roi-billing-line">
        {billing.onTrial
          ? `Free trial · ${billing.trialDaysRemaining ?? 0} day${billing.trialDaysRemaining === 1 ? "" : "s"} left · after the trial, plans start at ${formatMoney(cheapestPlanCents)}/mo.`
          : billing.trialToPaidConverted
            ? `Trial converted — you're on the ${billing.planName} plan at ${formatMoney(billing.monthlyCostCents)}/mo.`
            : `${billing.planName} plan · ${formatMoney(billing.monthlyCostCents)}/mo.`}{" "}
        <a href="/billing" className="font-semibold text-brand-700 hover:text-brand-800">
          Manage billing
        </a>
      </p>
    </section>
  );
}
