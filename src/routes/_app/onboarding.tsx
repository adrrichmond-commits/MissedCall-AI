import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  addServiceAreaFn,
  getOnboardingNudgeFn,
  getSettingsFn,
  removeServiceAreaFn,
  saveBusinessHoursFn,
  saveEmergencyPrefsFn,
  saveNotificationPrefsFn,
  seedServicesFromDefaultsFn,
  skipOnboardingFn,
  updateBusinessInfoFn,
} from "~/lib/server/settingsFns";
import { PageHeader, PageLoading, ErrorState } from "~/components/app/pageStates";
import { Field, TextInput } from "~/components/ui/Form";
import { Button } from "~/components/ui/Button";
import { COMMON_TIMEZONES, US_STATES, type SettingsView } from "~/lib/settingsTypes";

/** Shared styling for raw <select> elements (matches settings.tsx inputCls). */
const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-slate-50 disabled:text-slate-400";

const TOTAL_STEPS = 9;

/**
 * Wizard labels (owner brief #12, 9 steps: account -> company info -> services
 * -> hours -> emergency prefs -> notifications -> phone number -> test AI ->
 * activate). Step 1 "Account" is complete at signup (the session IS the
 * account) and has no server-derived done-flag; DERIVED_LABELS below mirror
 * the 8 derived steps in settingsFns ONBOARDING_STEPS so the nudge's 0-based
 * resumeStep can be mapped to a wizard step.
 */
const STEP_LABELS = [
  "Account",
  "Company info",
  "Services & area",
  "Business hours",
  "Emergency prefs",
  "Notifications",
  "Phone number",
  "Test the AI",
  "Review & activate",
] as const;

const DERIVED_LABELS = [
  "Company info",
  "Services & area",
  "Business hours",
  "Emergency prefs",
  "Notifications",
  "Phone number",
  "Test the AI",
  "Review & activate",
] as const;

/** dayOfWeek -> label, Monday-first (matches DB 0=Mon..6=Sun convention). */
const DAY_LABELS: Record<number, string> = {
  0: "Monday",
  1: "Tuesday",
  2: "Wednesday",
  3: "Thursday",
  4: "Friday",
  5: "Saturday",
  6: "Sunday",
};

/** DB row order for the 7-day week, Monday-first. */
const BUSINESS_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** The four notification switches offered in onboarding (settings.tsx uses the same keys). */
const NOTIFICATION_PREF_KEYS = [
  { key: "onMissedCallSms", label: "Text me when a missed call is captured" },
  { key: "onNewLeadEmail", label: "Email me when a new lead comes in" },
  { key: "dailySummaryEmail", label: "Send a daily summary email" },
  { key: "weeklySummaryEmail", label: "Send a weekly summary email" },
] as const;

/** Honest note: prefs save now, delivery waits for the Phase 2 messaging provider. */
const PREFS_DELIVERY_NOTE =
  "Your choices are saved now. Email/SMS delivery switches on when the messaging provider is connected (Phase 2) - nothing is sent until then.";

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

type DayHours = { isOpen: boolean; opensAt: string; closesAt: string };

type AreaChip = { id: string; kind: string; value: string; state: string | null };

function toAreaChips(list: SettingsView["serviceAreas"]): AreaChip[] {
  return list.map((a) => ({ id: a.id, kind: a.kind, value: a.value, state: a.state ?? null }));
}

export const Route = createFileRoute("/_app/onboarding")({
  loader: async () => {
    const res = await getSettingsFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState
      message="Setup couldn't load. Check your connection and retry."
      onRetry={() => window.location.reload()}
    />
  ),
  component: OnboardingPage,
});

// ---------------------------------------------------------------------------
// Small shared bits (mirrors settings.tsx patterns)
// ---------------------------------------------------------------------------
type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string };

function SaveFeedback({ state }: { state: SaveState }) {
  if (state.kind === "saved") {
    return <p className="text-sm font-medium text-green-700" role="status">✓ {state.message}</p>;
  }
  if (state.kind === "error") {
    return <p className="text-sm font-medium text-red-700" role="alert">{state.message}</p>;
  }
  if (state.kind === "saving") {
    return <p className="text-sm text-slate-500" role="status">Saving…</p>;
  }
  return null;
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-xs font-medium text-red-700">{msg}</p>;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
function OnboardingPage() {
  const data = Route.useLoaderData();
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [skip, setSkip] = useState<SaveState>({ kind: "idle" });
  // Resume: jump to the first incomplete step once the nudge data arrives.
  // resumeStep is the 0-based index into the 8 server-derived steps; wizard
  // step = derived index + 2 (step 1 "Account" has no derived done-flag).
  useEffect(() => {
    let alive = true;
    getOnboardingNudgeFn()
      .then((n) => {
        if (alive && n && n.resumeStep >= 0 && n.resumeStep <= 7) setStep(n.resumeStep + 2);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const percent = Math.round(((step - 1) / TOTAL_STEPS) * 100);

  const onSkip = async () => {
    setSkip({ kind: "saving" });
    const res = await skipOnboardingFn();
    if (res.ok) {
      await navigate({ to: "/dashboard" });
    } else {
      setSkip({ kind: "error", message: res.error });
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Set up MissedCall AI"
        description="Nine quick steps so missed calls become booked jobs."
      />

      {/* Progress: "Step X of 9" + percent bar */}
      <div className="mb-6">
        <div className="flex items-center justify-between text-sm">
          <p className="font-medium text-slate-700">
            Step {step} of {TOTAL_STEPS} — {STEP_LABELS[step - 1]}
          </p>
          <p className="text-slate-500">{percent}%</p>
        </div>
        <div
          className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-200"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={`Onboarding progress: step ${step} of ${TOTAL_STEPS}`}
        >
          <div
            className="h-full rounded-full bg-brand-600 transition-all duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>
        <ol className="mt-3 hidden gap-1 text-xs text-slate-500 sm:flex">
          {STEP_LABELS.map((label, i) => (
            <li key={label} className={i + 1 === step ? "font-semibold text-brand-700" : undefined}>
              {i + 1}. {label}
            </li>
          ))}
        </ol>
      </div>

      {step === 1 ? <AccountStep view={data} onDone={() => setStep(2)} /> : null}
      {step === 2 ? <CompanyInfoStep view={data} onDone={() => setStep(3)} /> : null}
      {step === 3 ? <ServicesStep view={data} onBack={() => setStep(2)} onDone={() => setStep(4)} /> : null}
      {step === 4 ? <HoursStep view={data} onBack={() => setStep(3)} onDone={() => setStep(5)} /> : null}
      {step === 5 ? <EmergencyStep view={data} onBack={() => setStep(4)} onDone={() => setStep(6)} /> : null}
      {step === 6 ? <PrefsStep view={data} onBack={() => setStep(5)} onDone={() => setStep(7)} /> : null}
      {step === 7 ? <PhoneStep view={data} onBack={() => setStep(6)} onDone={() => setStep(8)} /> : null}
      {step === 8 ? <TestAiStep onBack={() => setStep(7)} onDone={() => setStep(9)} /> : null}
      {step === 9 ? <ReviewStep view={data} onBack={() => setStep(8)} /> : null}

      <div className="mt-6 flex items-center justify-between gap-3 border-t border-slate-200 pt-4">
        <SaveFeedback state={skip} />
        <Button variant="ghost" onClick={onSkip} disabled={skip.kind === "saving"}>
          {skip.kind === "saving" ? "Skipping…" : "Skip for now — go to dashboard"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: company info (same fields + validation as settings.tsx BusinessInfoSection)
// ---------------------------------------------------------------------------
function CompanyInfoStep({ view, onDone }: { view: SettingsView; onDone: () => void }) {
  const initial = view.business;
  const canEdit = view.canEdit;
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [website, setWebsite] = useState(initial.website ?? "");
  const [addressLine1, setAddressLine1] = useState(initial.addressLine1 ?? "");
  const [addressLine2, setAddressLine2] = useState(initial.addressLine2 ?? "");
  const [city, setCity] = useState(initial.city ?? "");
  const [state, setState] = useState(initial.state ?? "");
  const [postalCode, setPostalCode] = useState(initial.postalCode ?? "");
  const [timezone, setTimezone] = useState(initial.timezone);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const clientValidate = (): boolean => {
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = "Business name is required (at least 2 characters).";
    if (phone.trim() && !/^\+?[0-9()\-. ]{7,20}$/.test(phone.trim())) {
      errs.phone = "Use 7–20 digits; spaces, dashes and parentheses allowed.";
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      errs.email = "Enter a valid email address.";
    }
    if (postalCode.trim() && !/^[0-9]{5}(-[0-9]{4})?$/.test(postalCode.trim())) {
      errs.postalCode = "ZIP must look like 12345 or 12345-6789.";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientValidate()) return;
    setSave({ kind: "saving" });
    const res = await updateBusinessInfoFn({
      data: { name, phone, email, website, addressLine1, addressLine2, city, state, postalCode, timezone },
    });
    if (res.ok) {
      setSave({ kind: "saved", message: res.data.message });
      onDone();
    } else {
      setSave({ kind: "error", message: res.error });
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">Company info</h2>
      <p className="mt-1 text-sm text-slate-600">
        Shown to customers and used across the app. You can change this anytime in Settings.
      </p>
      <form onSubmit={onSubmit} className="mt-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name" htmlFor="onb-name">
            <TextInput id="onb-name" value={name} disabled={!canEdit} onChange={setName} required />
            <FieldError msg={errors.name} />
          </Field>
          <Field label="Phone" htmlFor="onb-phone" hint="Customers see this number.">
            <TextInput id="onb-phone" value={phone} disabled={!canEdit} onChange={setPhone} />
            <FieldError msg={errors.phone} />
          </Field>
          <Field label="Email" htmlFor="onb-email">
            <TextInput id="onb-email" type="email" value={email} disabled={!canEdit} onChange={setEmail} />
            <FieldError msg={errors.email} />
          </Field>
          <Field label="Website" htmlFor="onb-website" hint="Your domain — https:// is added for you.">
            <TextInput id="onb-website" value={website} disabled={!canEdit} onChange={setWebsite} />
            <FieldError msg={errors.website} />
          </Field>
          <Field label="Address line 1" htmlFor="onb-addr1">
            <TextInput id="onb-addr1" value={addressLine1} disabled={!canEdit} onChange={setAddressLine1} />
          </Field>
          <Field label="Address line 2" htmlFor="onb-addr2">
            <TextInput id="onb-addr2" value={addressLine2} disabled={!canEdit} onChange={setAddressLine2} />
          </Field>
          <Field label="City" htmlFor="onb-city">
            <TextInput id="onb-city" value={city} disabled={!canEdit} onChange={setCity} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="State" htmlFor="onb-state">
              <select
                id="onb-state"
                className={inputCls}
                value={state}
                disabled={!canEdit}
                onChange={(e) => setState(e.target.value)}
              >
                <option value="">—</option>
                {US_STATES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
            <Field label="ZIP code" htmlFor="onb-zip">
              <TextInput id="onb-zip" value={postalCode} disabled={!canEdit} onChange={setPostalCode} />
              <FieldError msg={errors.postalCode} />
            </Field>
          </div>
          <Field label="Time zone" htmlFor="onb-tz" hint="Hours and appointments render in this zone.">
            <select
              id="onb-tz"
              className={inputCls}
              value={timezone}
              disabled={!canEdit}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {COMMON_TIMEZONES.includes(timezone as (typeof COMMON_TIMEZONES)[number]) || timezone === "" ? null : (
                <option value={timezone}>{timezone}</option>
              )}
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3 pt-1">
          <SaveFeedback state={save} />
          <Button type="submit" disabled={!canEdit || save.kind === "saving"}>
            {save.kind === "saving" ? "Saving…" : "Save & continue"}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 2: services checklist from service_defaults
// ---------------------------------------------------------------------------
function ServicesStep({
  view,
  onBack,
  onDone,
}: {
  view: SettingsView;
  onBack: () => void;
  onDone: () => void;
}) {
  const canEdit = view.canEdit;
  const [checked, setChecked] = useState<Set<string>>(() => new Set(view.serviceDefaults.map((d) => d.id)));
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onContinue = async () => {
    setSave({ kind: "saving" });
    if (checked.size === 0) {
      onDone();
      return;
    }
    const res = await seedServicesFromDefaultsFn({ data: { defaultIds: [...checked] } });
    if (res.ok) {
      setSave({ kind: "saved", message: res.data.message });
      onDone();
    } else {
      setSave({ kind: "error", message: res.error });
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">Services you offer</h2>
      <p className="mt-1 text-sm text-slate-600">
        Check the jobs you take — we'll build your service list from them. You can edit this anytime in Settings.
      </p>
      <fieldset disabled={!canEdit} className="mt-4">
        <legend className="sr-only">Services</legend>
        <ul className="space-y-2">
          {view.serviceDefaults.map((d) => (
            <li key={d.id}>
              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 px-4 py-3 transition-colors hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50/50">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/20"
                  checked={checked.has(d.id)}
                  onChange={() => toggle(d.id)}
                />
                <span>
                  <span className="block text-sm font-medium text-slate-900">{d.name}</span>
                  {d.description ? <span className="block text-xs text-slate-500">{d.description}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      {/* Brief #8/#9: service areas fold into the services step — "what you do
         + where you do it". Areas save immediately as they are added. */}
      <div className="mt-6 border-t border-slate-100 pt-5">
        <h3 className="text-sm font-semibold text-slate-900">Where you work</h3>
        <p className="mt-1 text-sm text-slate-600">
          ZIP codes or cities you serve — the AI uses this to accept or politely decline out-of-area jobs.
        </p>
        <AreaEditor view={view} />
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <SaveFeedback state={save} />
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack} disabled={save.kind === "saving"}>
            Back
          </Button>
          <Button onClick={onContinue} disabled={!canEdit || save.kind === "saving"}>
            {save.kind === "saving" ? "Adding services…" : "Continue"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 3: business hours (7-day rows, mirrors settings.tsx HoursSection shape)
// ---------------------------------------------------------------------------
function HoursStep({
  view,
  onBack,
  onDone,
}: {
  view: SettingsView;
  onBack: () => void;
  onDone: () => void;
}) {
  const canEdit = view.canEdit;

  const initial = (): Record<number, DayHours> => {
    const out: Record<number, DayHours> = {};
    for (const d of BUSINESS_DAYS) {
      const row = view.hours.find((h) => h.dayOfWeek === d);
      out[d] = {
        isOpen: row?.isOpen ?? false,
        opensAt: row?.opensAt ?? "08:00",
        closesAt: row?.closesAt ?? "17:00",
      };
    }
    return out;
  };

  const [days, setDays] = useState<Record<number, DayHours>>(initial);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const setDay = (d: number, patch: Partial<DayHours>) => {
    setDays((prev) => ({ ...prev, [d]: { ...prev[d], ...patch } }));
  };

  const clientValidate = (): boolean => {
    const errs: Record<number, string> = {};
    for (const d of BUSINESS_DAYS) {
      const row = days[d];
      if (!row.isOpen) continue;
      if (!TIME_RE.test(row.opensAt) || !TIME_RE.test(row.closesAt)) {
        errs[d] = "Open days need both times in HH:MM (24-hour) format.";
      } else if (row.opensAt >= row.closesAt) {
        errs[d] = "Opening time must be earlier than closing time.";
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const onContinue = async () => {
    if (!clientValidate()) return;
    setSave({ kind: "saving" });
    const res = await saveBusinessHoursFn({
      data: {
        days: BUSINESS_DAYS.map((d) => ({
          dayOfWeek: d,
          isOpen: days[d].isOpen,
          opensAt: days[d].opensAt,
          closesAt: days[d].closesAt,
        })),
      },
    });
    if (res.ok) {
      setSave({ kind: "saved", message: res.data.message });
      onDone();
    } else {
      setSave({ kind: "error", message: res.error });
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">Business hours</h2>
      <p className="mt-1 text-sm text-slate-600">
        When customers can reach you. Unchecked days are closed. You can change this anytime in Settings.
      </p>
      <fieldset disabled={!canEdit} className="mt-4">
        <legend className="sr-only">Business hours</legend>
        <ul className="space-y-2">
          {BUSINESS_DAYS.map((d) => (
            <li key={d} className="rounded-xl border border-slate-200 px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex min-w-[10rem] flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/20"
                    checked={days[d].isOpen}
                    onChange={(e) => setDay(d, { isOpen: e.target.checked })}
                  />
                  <span className="text-sm font-medium text-slate-900">{DAY_LABELS[d]}</span>
                </label>
                {days[d].isOpen ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="08:00"
                      aria-label={`${DAY_LABELS[d]} opening time`}
                      className={`${inputCls} w-24`}
                      value={days[d].opensAt}
                      onChange={(e) => setDay(d, { opensAt: e.target.value })}
                    />
                    <span className="text-sm text-slate-500">–</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="17:00"
                      aria-label={`${DAY_LABELS[d]} closing time`}
                      className={`${inputCls} w-24`}
                      value={days[d].closesAt}
                      onChange={(e) => setDay(d, { closesAt: e.target.value })}
                    />
                  </div>
                ) : (
                  <span className="text-sm text-slate-400">Closed</span>
                )}
              </div>
              <FieldError msg={errors[d]} />
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="mt-5 flex items-center justify-between gap-3">
        <SaveFeedback state={save} />
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack} disabled={save.kind === "saving"}>
            Back
          </Button>
          <Button onClick={onContinue} disabled={!canEdit || save.kind === "saving"}>
            {save.kind === "saving" ? "Saving…" : "Continue"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 3 helper: area editor (chips + add form), shared shape with the old
// standalone AreasStep — areas now live on the Services step per brief #8.
// ---------------------------------------------------------------------------
function AreaEditor({ view }: { view: SettingsView }) {
  const canEdit = view.canEdit;
  const [areas, setAreas] = useState<AreaChip[]>(() => toAreaChips(view.serviceAreas));
  const [kind, setKind] = useState<"zip" | "city">("zip");
  const [value, setValue] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [addError, setAddError] = useState("");
  const [busy, setBusy] = useState(false);

  const onAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError("");
    const trimmed = value.trim();
    if (kind === "zip" && !/^[0-9]{5}$/.test(trimmed)) {
      setAddError("ZIP must be exactly 5 digits.");
      return;
    }
    if (kind === "city" && trimmed.length < 2) {
      setAddError("Enter a city name.");
      return;
    }
    if (kind === "city" && stateCode && !US_STATES.includes(stateCode as (typeof US_STATES)[number])) {
      setAddError("Pick a valid state.");
      return;
    }
    setBusy(true);
    const res = await addServiceAreaFn({ data: { kind, value: trimmed, state: stateCode || undefined } });
    if (res.ok) {
      // Optimistic chip with a temp id, then reconcile with the server list.
      setAreas((prev) => [
        ...prev,
        { id: "tmp-" + String(Date.now()), kind, value: trimmed, state: stateCode || null },
      ]);
      setValue("");
      setStateCode("");
      const fresh = await getSettingsFn();
      if (fresh.ok) setAreas(toAreaChips(fresh.data.serviceAreas));
    } else {
      setAddError(res.error);
    }
    setBusy(false);
  };

  const onRemove = async (id: string) => {
    if (!canEdit || busy) return;
    setBusy(true);
    const prev = areas;
    setAreas((cur) => cur.filter((a) => a.id !== id));
    const res = await removeServiceAreaFn({ data: { id } });
    if (!res.ok) {
      setAreas(prev);
      setAddError(res.error);
    }
    setBusy(false);
  };

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        {areas.length === 0 ? (
          <p className="text-sm text-slate-500">No areas yet — add at least one below.</p>
        ) : (
          areas.map((a) => {
            const chipLabel = a.kind === "zip" ? a.value : a.value + (a.state ? ", " + a.state : "");
            return (
              <span
                key={a.id}
                className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 py-1.5 pl-3.5 pr-2 text-sm text-slate-800"
              >
                {chipLabel}
                <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {a.kind}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(a.id)}
                  disabled={!canEdit || busy}
                  aria-label={"Remove " + chipLabel}
                  className="flex h-5 w-5 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-200 hover:text-slate-700 disabled:opacity-40"
                >
                  ×
                </button>
              </span>
            );
          })
        )}
      </div>

      <form onSubmit={onAdd} className="mt-3 flex flex-wrap items-start gap-3">
        <div className="w-28">
          <label htmlFor="onb-area-kind" className="mb-1.5 block text-sm font-medium text-slate-700">
            Kind
          </label>
          <select
            id="onb-area-kind"
            className={inputCls}
            value={kind}
            disabled={!canEdit}
            onChange={(e) => {
              setKind(e.target.value === "city" ? "city" : "zip");
              setAddError("");
            }}
          >
            <option value="zip">ZIP code</option>
            <option value="city">City</option>
          </select>
        </div>
        <div className="w-44">
          <label htmlFor="onb-area-value" className="mb-1.5 block text-sm font-medium text-slate-700">
            {kind === "zip" ? "ZIP code" : "City"}
          </label>
          <TextInput
            id="onb-area-value"
            value={value}
            disabled={!canEdit}
            placeholder={kind === "zip" ? "12345" : "Austin"}
            onChange={(v) => {
              setValue(v);
              setAddError("");
            }}
          />
        </div>
        {kind === "city" ? (
          <div className="w-28">
            <label htmlFor="onb-area-state" className="mb-1.5 block text-sm font-medium text-slate-700">
              State <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <select
              id="onb-area-state"
              className={inputCls}
              value={stateCode}
              disabled={!canEdit}
              onChange={(e) => setStateCode(e.target.value)}
            >
              <option value="">—</option>
              {US_STATES.map((st) => (
                <option key={st} value={st}>{st}</option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="pt-[1.65rem]">
          <Button type="submit" disabled={!canEdit || busy}>
            Add
          </Button>
        </div>
      </form>
      <FieldError msg={addError} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: account (complete at signup — informational, keeps the brief's 9
// steps without faking a done-flag the server does not track)
// ---------------------------------------------------------------------------
function AccountStep({ view, onDone }: { view: SettingsView; onDone: () => void }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">Account</h2>
      <p className="mt-1 text-sm text-slate-600">
        Your account is live — this step is already done.
      </p>
      <dl className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200">
        <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
          <dt className="w-32 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">Business</dt>
          <dd className="text-sm text-slate-900">{view.business.name}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
          <dt className="w-32 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">Signed in as</dt>
          <dd className="text-sm text-slate-900">{view.business.email}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
          <dt className="w-32 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">Your role</dt>
          <dd className="text-sm text-slate-900">{view.role}</dd>
        </div>
      </dl>
      <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600">
        Your 14-day free trial started at signup — plan options are on the Billing page whenever you are ready.
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button onClick={onDone}>Continue</Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 5: emergency prefs (brief #1/#8: after-hours policy + instructions the
// AI follows on emergency calls; delivery waits for the messaging provider)
// ---------------------------------------------------------------------------
function EmergencyStep({
  view,
  onBack,
  onDone,
}: {
  view: SettingsView;
  onBack: () => void;
  onDone: () => void;
}) {
  const canEdit = view.canEdit;
  const [prefs, setPrefs] = useState(view.emergencyPrefs);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const onContinue = async () => {
    setSave({ kind: "saving" });
    const res = await saveEmergencyPrefsFn({ data: prefs as unknown as Record<string, unknown> });
    if (res.ok) {
      setSave({ kind: "saved", message: "Emergency preferences saved." });
      onDone();
    } else {
      setSave({ kind: "error", message: res.error });
    }
  };

  const toggles: { key: "afterHoursEmergency" | "emergencyNotificationEmail" | "emergencyNotificationSms"; label: string }[] = [
    { key: "afterHoursEmergency", label: "Take emergency calls after hours (flooding, burst pipes, gas)" },
    { key: "emergencyNotificationEmail", label: "Email me the moment a lead is an emergency" },
    { key: "emergencyNotificationSms", label: "Text me the moment a lead is an emergency" },
  ];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">Emergency prefs</h2>
      <p className="mt-1 text-sm text-slate-600">
        How the AI handles emergencies when you are on a job or closed.
      </p>
      <fieldset disabled={!canEdit} className="mt-4">
        <legend className="sr-only">Emergency preferences</legend>
        <ul className="space-y-2">
          {toggles.map((t) => (
            <li key={t.key}>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 transition-colors hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50/50">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/20"
                  checked={prefs[t.key]}
                  onChange={(e) => setPrefs((prev) => ({ ...prev, [t.key]: e.target.checked }))}
                />
                <span className="text-sm font-medium text-slate-900">{t.label}</span>
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-3">
          <label htmlFor="onb-emg-instructions" className="mb-1.5 block text-sm font-medium text-slate-700">
            Emergency instructions <span className="font-normal text-slate-400">(the AI follows these)</span>
          </label>
          <textarea
            id="onb-emg-instructions"
            className={inputCls + " min-h-24"}
            maxLength={500}
            rows={4}
            value={prefs.emergencyInstructions}
            placeholder="e.g. Tell the caller to shut off the main water valve if it is safe, take the address first, and we will call right back."
            onChange={(e) => setPrefs((prev) => ({ ...prev, emergencyInstructions: e.target.value }))}
          />
        </div>
      </fieldset>
      <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600">
        Saved now. Emergency email/SMS delivery switches on when the messaging provider is connected (Phase 2) — nothing is sent until then.
      </p>
      <div className="mt-5 flex items-center justify-between gap-3">
        <SaveFeedback state={save} />
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack} disabled={save.kind === "saving"}>
            Back
          </Button>
          <Button onClick={onContinue} disabled={!canEdit || save.kind === "saving"}>
            {save.kind === "saving" ? "Saving…" : "Continue"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 7: phone number (honest placeholder until the messaging provider is
// connected — the number is assigned then, nothing to fake today)
// ---------------------------------------------------------------------------
function PhoneStep({
  view,
  onBack,
  onDone,
}: {
  view: SettingsView;
  onBack: () => void;
  onDone: () => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">Phone number</h2>
      <p className="mt-1 text-sm text-slate-600">
        Missed-call text-back runs through a dedicated MissedCall AI number, so your main line stays free.
      </p>
      <div className="mt-4 rounded-xl border border-slate-200 p-4">
        <p className="text-sm text-slate-700">
          Your main line: <span className="font-semibold">{view.business.phone || "add one in Company info"}</span>
        </p>
        <p className="mt-2 text-sm text-slate-500">
          Your texting number is assigned automatically once the messaging provider is connected (next build).
          Nothing to configure here yet.
        </p>
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <span />
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onDone}>Continue</Button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 8: test the AI (honest placeholder until the receptionist is live)
// ---------------------------------------------------------------------------
function TestAiStep({
  onBack,
  onDone,
}: {
  onBack: () => void;
  onDone: () => void;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">Test the AI</h2>
      <p className="mt-1 text-sm text-slate-600">
        Call or text your AI receptionist to hear how it answers before your customers do.
      </p>
      <div className="mt-4 rounded-xl border border-slate-200 p-4">
        <p className="text-sm text-slate-500">
          Test calls switch on with the AI receptionist (next build). Finish setup now — this step
          stays available from Settings.
        </p>
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <span />
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
          <Button onClick={onDone}>Continue</Button>
        </div>
      </div>
    </section>
  );
}
// ---------------------------------------------------------------------------
// Step 5: notification preferences (4 checkboxes + honest delivery note)
// ---------------------------------------------------------------------------
function PrefsStep({
  view,
  onBack,
  onDone,
}: {
  view: SettingsView;
  onBack: () => void;
  onDone: () => void;
}) {
  const canEdit = view.canEdit;
  const [prefs, setPrefs] = useState({
    onMissedCallSms: view.notificationPrefs.onMissedCallSms,
    onNewLeadEmail: view.notificationPrefs.onNewLeadEmail,
    dailySummaryEmail: view.notificationPrefs.dailySummaryEmail,
    weeklySummaryEmail: view.notificationPrefs.weeklySummaryEmail,
  });
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const onContinue = async () => {
    setSave({ kind: "saving" });
    const res = await saveNotificationPrefsFn({ data: prefs });
    if (res.ok) {
      setSave({ kind: "saved", message: "Notification preferences saved." });
      onDone();
    } else {
      setSave({ kind: "error", message: res.error });
    }
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">Notification preferences</h2>
      <p className="mt-1 text-sm text-slate-600">Choose how you want to be kept in the loop.</p>
      <fieldset disabled={!canEdit} className="mt-4">
        <legend className="sr-only">Notification preferences</legend>
        <ul className="space-y-2">
          {NOTIFICATION_PREF_KEYS.map((p) => (
            <li key={p.key}>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 transition-colors hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50/50">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500/20"
                  checked={prefs[p.key]}
                  onChange={(e) => setPrefs((prev) => ({ ...prev, [p.key]: e.target.checked }))}
                />
                <span className="text-sm font-medium text-slate-900">{p.label}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <p className="mt-3 rounded-xl bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600">
        {PREFS_DELIVERY_NOTE}
      </p>
      <div className="mt-5 flex items-center justify-between gap-3">
        <SaveFeedback state={save} />
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack} disabled={save.kind === "saving"}>
            Back
          </Button>
          <Button onClick={onContinue} disabled={!canEdit || save.kind === "saving"}>
            {save.kind === "saving" ? "Saving…" : "Continue"}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 6: review (read-only summary) + finish (derived from onboarding nudge)
// ---------------------------------------------------------------------------
function formatHoursSummary(hours: SettingsView["hours"]): string {
  const open = BUSINESS_DAYS.filter((d) => hours.find((h) => h.dayOfWeek === d)?.isOpen);
  if (open.length === 0) return "No open days yet";
  const segs: string[] = [];
  let i = 0;
  while (i < open.length) {
    let j = i;
    while (j + 1 < open.length && open[j + 1] === open[j] + 1) j += 1;
    segs.push(
      open[i] === open[j]
        ? DAY_LABELS[open[i]].slice(0, 3)
        : DAY_LABELS[open[i]].slice(0, 3) + "–" + DAY_LABELS[open[j]].slice(0, 3),
    );
    i = j + 1;
  }
  const times = open
    .map((d) => hours.find((h) => h.dayOfWeek === d))
    .filter((h): h is NonNullable<typeof h> => Boolean(h));
  const first = times[0];
  const sameTimes = times.every((h) => h.opensAt === first.opensAt && h.closesAt === first.closesAt);
  return sameTimes
    ? segs.join(", ") + " " + first.opensAt + "–" + first.closesAt
    : segs.join(", ") + " (varies by day — see Settings)";
}

function ReviewStep({ view: initialView, onBack }: { view: SettingsView; onBack: () => void }) {
  const navigate = useNavigate();
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  // The route loader ran once at wizard mount — before steps 1-5 saved anything
  // — so `initialView` can be stale. Re-fetch the persisted values when the
  // Review step mounts so the summary shows what is actually in the database.
  const [view, setView] = useState(initialView);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    getSettingsFn()
      .then((res) => {
        if (!alive) return;
        if (res.ok) setView(res.data);
        // Even on failure, fall back to the loader data instead of spinning.
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const onFinish = async () => {
    setSave({ kind: "saving" });
    // getOnboardingNudgeFn resolves to the nudge object itself (or null on failure) — no result wrapper.
    const nudge = await getOnboardingNudgeFn();
    // "Phone number" and "Test the AI" stay open until the messaging provider
    // and receptionist are connected (build 3+) — they must not block finish.
    // Everything self-serve done -> finish succeeds even below 100%.
    if (nudge && nudge.percent === 100) {
      await navigate({ to: "/dashboard" });
    } else if (nudge) {
      // resumeStep is a 0-based index into the 8 server-derived steps; wizard
      // step = derived index + 2 (step 1 "Account" has no derived done-flag).
      const idx = typeof nudge.resumeStep === "number" ? nudge.resumeStep : -1;
      const nextUp =
        idx >= 0 && idx < DERIVED_LABELS.length ? "Next up: " + DERIVED_LABELS[idx] + ". " : "";
      const missing: string[] = [];
      if (!view.business.name) missing.push("Company info");
      if (view.services.length === 0) missing.push("Services");
      if (view.serviceAreas.length === 0) missing.push("Service area (on the Services step)");
      if (
        view.hours.length < BUSINESS_DAYS.length ||
        BUSINESS_DAYS.every((d) => !view.hours.find((h) => h.dayOfWeek === d)?.isOpen)
      ) {
        missing.push("Business hours (at least one open day)");
      }
      if (!view.emergencyPrefsSaved) missing.push("Emergency prefs");
      if (!view.notificationPrefs.onMissedCallSms && !view.notificationPrefs.onNewLeadEmail) {
        missing.push("Notifications (turn at least one on)");
      }
      if (missing.length === 0) {
        await navigate({ to: "/dashboard" });
        return;
      }
      const msg =
        nextUp +
        "Not finished yet" +
        (missing.length > 0 ? ": " + missing.join(", ") : ".");
      setSave({ kind: "error", message: msg });
    } else {
      setSave({ kind: "error", message: "Couldn't verify setup status. Please try again." });
    }
  };

  const b = view.business;
  const summary: Array<[string, string]> = [
    [
      "Business",
      b.name +
        (b.phone ? " · " + b.phone : "") +
        (b.city ? " · " + b.city + (b.state ? ", " + b.state : "") : ""),
    ],
    ["Time zone", b.timezone],
    ["Services", String(view.services.length) + " selected"],
    ["Service areas", String(view.serviceAreas.length) + " added"],
    ["Hours", formatHoursSummary(view.hours)],
    [
      "Emergency prefs",
      view.emergencyPrefs.afterHoursEmergency
        ? "After-hours emergencies on" +
          (view.emergencyPrefs.emergencyInstructions ? " - instructions saved" : "")
        : "Off (no after-hours emergency handling)",
    ],
    [
      "Notifications",
      NOTIFICATION_PREF_KEYS.filter((p) => view.notificationPrefs[p.key])
        .map((p) => p.label)
        .join(", ") || "None on",
    ],
  ];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">Review &amp; finish</h2>
      <p className="mt-1 text-sm text-slate-600">
        A quick look at what you've set up. Everything stays editable in Settings.
      </p>
      {!loaded ? (
        <p className="mt-4 text-sm text-slate-500" role="status">
          Loading your saved setup…
        </p>
      ) : (
        <dl className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200">
          {summary.map(([label, val]) => (
            <div key={label} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-4">
              <dt className="w-32 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
              <dd className="text-sm text-slate-900">{val}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-5 flex items-center justify-between gap-3">
        <SaveFeedback state={save} />
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onBack} disabled={save.kind === "saving" || !loaded}>
            Back
          </Button>
          <Button onClick={onFinish} disabled={save.kind === "saving" || !loaded}>
            {!loaded ? "Loading…" : save.kind === "saving" ? "Checking…" : "Finish — go to dashboard"}
          </Button>
        </div>
      </div>
    </section>
  );
}
