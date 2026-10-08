/**
 * /admin/sales — outside-sales comp visibility for the owner: reps, their
 * attributed accounts, accrued vs paid vs owed, and the collected-vs-cost
 * totals band. Everything renders from REAL rows through the pure comp
 * engine (src/lib/salesComp.ts) — no forecasts, no projections, and zeros
 * render as zeros with a stated reason where one exists.
 *
 * Auth: lives under /admin — the layout's beforeLoad gate (env precondition
 * + session + users.is_platform_admin, fresh from the DB) runs before this
 * page ever loads; business users never reach it.
 */
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { SalesTabView } from "~/lib/server/salesAdminFns";
import {
  salesAddRepFn,
  salesAttributeFn,
  salesRecordPayoutFn,
  salesSetRepActiveFn,
  salesUnattributeFn,
  salesUpdateRepFn,
} from "~/lib/server/salesAdminFns";
import { formatDate, formatDateTime } from "~/lib/format";
import { Badge } from "~/components/ui/Badge";

export const Route = createFileRoute("/admin/sales")({
  loader: async () => {
    // PR #27 pattern: plain read during SSR (no HTTP self-call); RPC in the browser.
    if (import.meta.env.SSR) {
      const { salesTabPage } = await import("~/lib/server/salesAdmin");
      const res = await salesTabPage();
      if (!res.ok) throw new Error(res.error);
      return res.data;
    }
    const { salesTabFn } = await import("~/lib/server/salesAdminFns");
    const res = await salesTabFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: AdminLoading,
  component: SalesPage,
});

function AdminLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="h-8 w-56 animate-pulse rounded bg-slate-200" />
      <div className="mt-6 h-64 animate-pulse rounded-xl bg-slate-200" />
    </div>
  );
}

function Nav() {
  return (
    <nav className="flex items-center gap-3 text-sm">
      <Link to="/admin/accounts" search={{}} className="text-brand-700 hover:underline">Accounts</Link>
      <Link to="/admin/metrics" search={{}} className="text-brand-700 hover:underline">Metrics</Link>
      <Link to="/admin/sales" search={{}} className="font-semibold text-brand-700">Sales</Link>
      <Link to="/admin/health" search={{}} className="text-brand-700 hover:underline">System health</Link>
      <Link to="/admin/audit" search={{}} className="text-brand-700 hover:underline">Audit log</Link>
    </nav>
  );
}

function money(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return sign + "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none";
const btnCls = "rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50";
const btnGhostCls =
  "rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50";

type ActionState = { kind: "idle" } | { kind: "busy" } | { kind: "error"; message: string } | { kind: "done"; message: string };

/** Shared submit helper: call → honest error banner → reload on success. */
function useAction(): [ActionState, (fn: () => Promise<{ ok: boolean; error?: string }>, doneMsg: string) => Promise<void>] {
  const [action, setAction] = useState<ActionState>({ kind: "idle" });
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, doneMsg: string) => {
    setAction({ kind: "busy" });
    try {
      const r = await fn();
      if (r.ok) {
        setAction({ kind: "done", message: doneMsg });
        window.location.reload();
      } else {
        setAction({ kind: "error", message: r.error ?? "Action failed." });
      }
    } catch {
      setAction({ kind: "error", message: "Action failed — try again." });
    }
  };
  return [action, run];
}

// ---------------------------------------------------------------------------
// Rep forms
// ---------------------------------------------------------------------------

interface ScheduleForm {
  name: string;
  contact: string;
  bountyStarter: string;
  bountyPro: string;
  monthlyStarter: string;
  monthlyPro: string;
  stepDownAfter: string;
  stepDownMonthlyStarter: string;
  stepDownMonthlyPro: string;
}

const EMPTY_FORM: ScheduleForm = {
  name: "",
  contact: "",
  bountyStarter: "",
  bountyPro: "",
  monthlyStarter: "",
  monthlyPro: "",
  stepDownAfter: "",
  stepDownMonthlyStarter: "",
  stepDownMonthlyPro: "",
};

function dollarsToCents(v: string): number | undefined {
  if (v.trim() === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100);
}

function repPayloadFrom(f: ScheduleForm): Record<string, unknown> | { error: string } {
  const fields: [string, string][] = [
    ["bountyStarterCents", f.bountyStarter],
    ["bountyProCents", f.bountyPro],
    ["monthlyStarterCents", f.monthlyStarter],
    ["monthlyProCents", f.monthlyPro],
  ];
  const payload: Record<string, unknown> = { name: f.name, contact: f.contact };
  for (const [key, raw] of fields) {
    const cents = dollarsToCents(raw);
    if (cents === undefined) return { error: "Comp amounts must be non-negative numbers." };
    payload[key] = cents;
  }
  if (f.stepDownAfter.trim() !== "") {
    payload.stepDownAfterMonths = f.stepDownAfter.trim();
    const s = dollarsToCents(f.stepDownMonthlyStarter);
    const p = dollarsToCents(f.stepDownMonthlyPro);
    if (s === undefined || p === undefined || s === 0 || p === 0) {
      return { error: "Step-down rates are required when a step-down month is set." };
    }
    payload.stepDownMonthlyStarterCents = s;
    payload.stepDownMonthlyProCents = p;
  }
  return payload;
}

function ScheduleFields(props: { form: ScheduleForm; onChange: (f: ScheduleForm) => void }) {
  const { form, onChange } = props;
  const set = (k: keyof ScheduleForm) => (e: { target: { value: string } }) => onChange({ ...form, [k]: e.target.value });
  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Bounty — Starter ($)" value={form.bountyStarter} onChange={set("bountyStarter")} />
        <Field label="Bounty — Pro ($)" value={form.bountyPro} onChange={set("bountyPro")} />
        <Field label="Monthly — Starter ($/mo)" value={form.monthlyStarter} onChange={set("monthlyStarter")} />
        <Field label="Monthly — Pro ($/mo)" value={form.monthlyPro} onChange={set("monthlyPro")} />
      </div>
      <p className="text-xs text-slate-400">
        Leave blank for $0. Bounty pays once, on the account's first successful payment — never on signup or trial.
      </p>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-3">
        <Field label="Step-down after N paid months (optional)" value={form.stepDownAfter} onChange={set("stepDownAfter")} />
        <Field label="Stepped monthly — Starter ($/mo)" value={form.stepDownMonthlyStarter} onChange={set("stepDownMonthlyStarter")} />
        <Field label="Stepped monthly — Pro ($/mo)" value={form.stepDownMonthlyPro} onChange={set("stepDownMonthlyPro")} />
      </div>
    </>
  );
}

function Field(props: { label: string; value: string; onChange: (e: { target: { value: string } }) => void; placeholder?: string }) {
  return (
    <label className="block text-xs font-semibold text-slate-500">
      <span>{props.label}</span>
      <input value={props.value} onChange={props.onChange} placeholder={props.placeholder} className={inputCls + " mt-1"} />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function SalesPage() {
  const data = Route.useLoaderData() as SalesTabView;
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<ScheduleForm>(EMPTY_FORM);
  const [addState, addRun] = useAction();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<ScheduleForm>(EMPTY_FORM);
  const [editState, editRun] = useAction();
  const [payoutRepId, setPayoutRepId] = useState<string | null>(null);
  const [payoutAmount, setPayoutAmount] = useState("");
  const [payoutNote, setPayoutNote] = useState("");
  const [payoutState, payoutRun] = useAction();
  const [attrBusinessId, setAttrBusinessId] = useState("");
  const [attrRepId, setAttrRepId] = useState("");
  const [attrState, attrRun] = useAction();
  const [clearState, clearRun] = useAction();

  const activeReps = data.reps.filter((r) => r.active);
  const canAttribute = attrBusinessId !== "" && attrRepId !== "";

  const submitAdd = () => {
    const payload = repPayloadFrom(addForm);
    if ("error" in payload) {
      setAddForm({ ...addForm });
      window.alert(payload.error);
      return;
    }
    void addRun(() => salesAddRepFn({ data: payload }), "Rep added.");
  };
  const submitEdit = () => {
    if (!editingId) return;
    const payload = repPayloadFrom(editForm);
    if ("error" in payload) {
      window.alert(payload.error);
      return;
    }
    void editRun(() => salesUpdateRepFn({ data: { ...payload, repId: editingId } }), "Rep updated.");
  };
  const submitPayout = () => {
    if (!payoutRepId) return;
    const cents = dollarsToCents(payoutAmount);
    if (cents === undefined || cents <= 0) {
      window.alert("Payout amount must be a positive number.");
      return;
    }
    void payoutRun(
      () => salesRecordPayoutFn({ data: { repId: payoutRepId, amountCents: cents, note: payoutNote } }),
      "Payout recorded.",
    );
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900 lg:text-2xl">Sales</h1>
          <p className="mt-1 text-sm text-slate-600">
            Outside-sales comp from real data — bounty on first successful payment, monthly while the account
            pays, owed = accrued − paid. No forecasts.
          </p>
        </div>
        <Nav />
      </div>

      {/* Totals band — collected vs rep cost vs net, real numbers, zeros render as zeros */}
      <section className="mt-6 grid gap-4 sm:grid-cols-3">
        <TotalCard
          label="Monthly collected — attributed accounts"
          value={money(data.totals.monthlyCollectedCents)}
          sub={
            data.totals.payingAccounts === 0
              ? "No paying attributed accounts yet."
              : `${data.totals.payingAccounts} paying account${data.totals.payingAccounts === 1 ? "" : "s"} · plan list prices ($${data.planPrices.starterCents / 100}/$${data.planPrices.proCents / 100} per mo)`
          }
        />
        <TotalCard
          label="Monthly rep cost"
          value={money(data.totals.monthlyRepCostCents)}
          sub={
            data.totals.payingAccounts === 0
              ? "No accrual — no paying attributed accounts."
              : "The deal's current-month accrual over the same paying accounts"
          }
        />
        <TotalCard
          label="Monthly kept after rep cost"
          value={money(data.totals.monthlyNetCents)}
          sub={data.totals.payingAccounts === 0 ? "Collected − rep cost." : "Collected − rep cost (this month, attributed accounts only)"}
        />
      </section>

      {/* ------------------------------------------------ REPS ------------- */}
      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Reps</h2>
          {!addOpen ? (
            <button type="button" className={btnCls} onClick={() => setAddOpen(true)}>
              Add rep
            </button>
          ) : null}
        </div>

        {data.reps.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">No reps added yet. Add the first rep to start attributing accounts.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {data.reps.map((rep) => (
              <div key={rep.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-slate-900">{rep.name}</p>
                    <Badge tone={rep.active ? "green" : "slate"}>{rep.active ? "Active" : "Deactivated"}</Badge>
                    {rep.contact ? <span className="text-sm text-slate-500">{rep.contact}</span> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className={btnGhostCls}
                      onClick={() => {
                        setEditingId(editingId === rep.id ? null : rep.id);
                        setEditForm({
                          name: rep.name,
                          contact: rep.contact ?? "",
                          bountyStarter: centsToDollarInput(rep.schedule.bountyStarterCents),
                          bountyPro: centsToDollarInput(rep.schedule.bountyProCents),
                          monthlyStarter: centsToDollarInput(rep.schedule.monthlyStarterCents),
                          monthlyPro: centsToDollarInput(rep.schedule.monthlyProCents),
                          stepDownAfter: rep.schedule.stepDownAfterMonths != null ? String(rep.schedule.stepDownAfterMonths) : "",
                          stepDownMonthlyStarter: centsToDollarInput(rep.schedule.stepDownMonthlyStarterCents),
                          stepDownMonthlyPro: centsToDollarInput(rep.schedule.stepDownMonthlyProCents),
                        });
                      }}
                    >
                      {editingId === rep.id ? "Cancel edit" : "Edit schedule"}
                    </button>
                    <button
                      type="button"
                      className={btnGhostCls}
                      onClick={() =>
                        void clearRun(
                          () => salesSetRepActiveFn({ data: { repId: rep.id, active: !rep.active } }),
                          rep.active ? "Rep deactivated." : "Rep reactivated.",
                        )
                      }
                    >
                      {rep.active ? "Deactivate" : "Reactivate"}
                    </button>
                    <button
                      type="button"
                      className={btnGhostCls}
                      onClick={() => {
                        setPayoutRepId(payoutRepId === rep.id ? null : rep.id);
                        setPayoutAmount("");
                        setPayoutNote("");
                      }}
                    >
                      {payoutRepId === rep.id ? "Close payout" : "Record payout"}
                    </button>
                  </div>
                </div>
                <p className="mt-1 text-xs text-slate-500">{rep.scheduleLabel}</p>
                {!rep.summary.hasSchedule ? (
                  <p className="mt-1 text-xs text-amber-700">
                    No comp schedule set — accrual is $0 until rates are saved on this rep.
                  </p>
                ) : null}
                <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-6">
                  <Stat label="Accounts brought" value={String(rep.summary.accountsBrought)} />
                  <Stat label="Currently active" value={String(rep.summary.activeAccounts)} />
                  <Stat label="Accrued this month" value={money(rep.summary.accruedThisMonthCents)} />
                  <Stat label="Lifetime accrued" value={money(rep.summary.lifetimeAccruedCents)} />
                  <Stat label="Paid to date" value={money(rep.summary.paidToDateCents)} />
                  <Stat label="Owed now" value={money(rep.summary.owedNowCents)} strong />
                </div>
                {editingId === rep.id ? (
                  <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Name" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                      <Field label="Contact" value={editForm.contact} onChange={(e) => setEditForm({ ...editForm, contact: e.target.value })} />
                    </div>
                    <ScheduleFields form={editForm} onChange={setEditForm} />
                    {editState.kind === "error" ? <p className="text-sm text-red-700">{editState.message}</p> : null}
                    <div className="flex justify-end">
                      <button type="button" className={btnCls} disabled={editState.kind === "busy"} onClick={submitEdit}>
                        {editState.kind === "busy" ? "Saving…" : "Save schedule"}
                      </button>
                    </div>
                  </div>
                ) : null}
                {payoutRepId === rep.id ? (
                  <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Field label="Amount ($)" value={payoutAmount} onChange={(e) => setPayoutAmount(e.target.value)} />
                      <Field label="Period note (e.g. Oct 2026 bounties)" value={payoutNote} onChange={(e) => setPayoutNote(e.target.value)} />
                    </div>
                    {payoutState.kind === "error" ? <p className="text-sm text-red-700">{payoutState.message}</p> : null}
                    <div className="flex justify-end">
                      <button type="button" className={btnCls} disabled={payoutState.kind === "busy"} onClick={submitPayout}>
                        {payoutState.kind === "busy" ? "Recording…" : "Record payout"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {addOpen ? (
          <div className="mt-4 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Name" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} />
              <Field label="Contact (phone or email)" value={addForm.contact} onChange={(e) => setAddForm({ ...addForm, contact: e.target.value })} />
            </div>
            <ScheduleFields form={addForm} onChange={setAddForm} />
            {addState.kind === "error" ? <p className="text-sm text-red-700">{addState.message}</p> : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={btnGhostCls}
                onClick={() => {
                  setAddOpen(false);
                  setAddForm(EMPTY_FORM);
                }}
              >
                Cancel
              </button>
              <button type="button" className={btnCls} disabled={addState.kind === "busy"} onClick={submitAdd}>
                {addState.kind === "busy" ? "Adding…" : "Add rep"}
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------ ACCOUNTS --------- */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Attributed accounts</h2>
        {data.reps.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">Add a rep first — attribution needs a rep to attribute to.</p>
        ) : data.accounts.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No attributed accounts yet. Attribute a business to a rep below.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-3 font-semibold">Business</th>
                  <th className="py-2 pr-3 font-semibold">Rep</th>
                  <th className="py-2 pr-3 font-semibold">Plan</th>
                  <th className="py-2 pr-3 font-semibold">Subscription</th>
                  <th className="py-2 pr-3 font-semibold">Attributed</th>
                  <th className="py-2 pr-3 font-semibold">Bounty</th>
                  <th className="py-2 pr-3 font-semibold">Monthly rate</th>
                  <th className="py-2 pr-3 font-semibold">Lifetime comp</th>
                  <th className="py-2 pr-3 font-semibold"></th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((a) => (
                  <tr key={a.businessId} className="border-b border-slate-100 align-top">
                    <td className="py-2 pr-3 font-medium text-slate-900">{a.businessName}</td>
                    <td className="py-2 pr-3">
                      {a.repName}
                      {!a.repActive ? <span className="ml-1 text-xs text-slate-400">(deactivated)</span> : null}
                    </td>
                    <td className="py-2 pr-3">{a.plan ?? "—"}</td>
                    <td className="py-2 pr-3"><SubStatusBadge status={a.subscriptionStatus} /></td>
                    <td className="py-2 pr-3 text-slate-500">{a.attributedAt ? formatDate(a.attributedAt) : "—"}</td>
                    <td className="py-2 pr-3">
                      {a.bountyPending ? (
                        <span className="text-slate-500">Pending first payment</span>
                      ) : (
                        money(a.bountyCents)
                      )}
                    </td>
                    <td className="py-2 pr-3">{a.accruesNow ? money(a.monthlyRateCents) + "/mo" : <span className="text-slate-400">$0.00/mo</span>}</td>
                    <td className="py-2 pr-3 font-semibold text-slate-900">{money(a.lifetimeCents)}</td>
                    <td className="py-2 pr-3">
                      <button
                        type="button"
                        className={btnGhostCls}
                        onClick={() => void clearRun(() => salesUnattributeFn({ data: { businessId: a.businessId } }), "Attribution cleared.")}
                      >
                        Unattribute
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {clearState.kind === "error" ? <p className="mt-2 text-sm text-red-700">{clearState.message}</p> : null}
          </div>
        )}

        {/* Attribute form */}
        <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <label className="block text-xs font-semibold text-slate-500">
            <span>Attribute a business</span>
            <select value={attrBusinessId} onChange={(e) => setAttrBusinessId(e.target.value)} className={inputCls + " mt-1 w-72"}>
              <option value="">
                {data.unattributed.length === 0 ? "No unattributed businesses" : "Pick a business…"}
              </option>
              {data.unattributed.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.plan && b.plan !== "trial" ? ` (${b.plan})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-semibold text-slate-500">
            <span>To rep</span>
            <select value={attrRepId} onChange={(e) => setAttrRepId(e.target.value)} className={inputCls + " mt-1 w-56"}>
              <option value="">{activeReps.length === 0 ? "No active reps" : "Pick a rep…"}</option>
              {activeReps.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={btnCls}
            disabled={!canAttribute || attrState.kind === "busy"}
            onClick={() => void attrRun(() => salesAttributeFn({ data: { businessId: attrBusinessId, repId: attrRepId } }), "Attributed.")}
          >
            {attrState.kind === "busy" ? "Attributing…" : "Attribute"}
          </button>
          {attrState.kind === "error" ? <p className="text-sm text-red-700">{attrState.message}</p> : null}
        </div>
      </section>

      {/* ------------------------------------------------ ACCOUNT NOTES ---- */}
      {data.accounts.some((a) => a.note) ? (
        <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Account notes (honest zeros)</h2>
          <ul className="mt-3 space-y-2 text-sm text-slate-600">
            {data.accounts
              .filter((a) => a.note)
              .map((a) => (
                <li key={a.businessId}>
                  <span className="font-medium text-slate-900">{a.businessName}</span> — {a.note}
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {/* ------------------------------------------------ PAYOUTS ---------- */}
      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Payout ledger</h2>
        {data.payouts.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No payouts recorded yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 text-sm">
            {data.payouts.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium text-slate-900">{p.repName}</span>
                  <span className="text-slate-500"> — {money(p.amountCents)}</span>
                  {p.note ? <span className="text-slate-500"> · {p.note}</span> : null}
                </span>
                <span className="text-xs text-slate-400">{formatDateTime(p.paidAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-400">
          Recording a payout never edits accrual — owed is always accrued minus this ledger.
        </p>
      </section>

      <p className="mt-6 text-xs text-slate-400">
        Comp math runs in the pure engine (src/lib/salesComp.ts): bounty on the account's first successful
        payment (derived from billing history — trial signup never pays), monthly per the plan the account is
        actually on while it pays, stopping on cancel. Paid months are counted from the first payment date;
        where billing history lacks the activation date, paid months are honestly 0 with a note above.
      </p>
    </div>
  );
}

function centsToDollarInput(cents: number | null): string {
  if (cents == null) return "";
  return (cents / 100).toString();
}

function TotalCard(props: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{props.label}</p>
      <p className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{props.value}</p>
      <p className="mt-1 text-xs text-slate-400">{props.sub}</p>
    </div>
  );
}

function Stat(props: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{props.label}</p>
      <p className={"mt-0.5 " + (props.strong ? "text-base font-bold text-slate-900" : "font-semibold text-slate-700")}>
        {props.value}
      </p>
    </div>
  );
}

function SubStatusBadge(props: { status: string | null }) {
  const s = props.status;
  if (s === "active") return <Badge tone="green">Active</Badge>;
  if (s === "trialing") return <Badge tone="slate">Trialing</Badge>;
  if (s === "past_due") return <Badge tone="amber">Past due</Badge>;
  if (s === "canceled") return <Badge tone="red">Canceled</Badge>;
  return <Badge tone="slate">No subscription</Badge>;
}
