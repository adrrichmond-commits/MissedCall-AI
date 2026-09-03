import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { getSettingsFn, seedServicesFromDefaultsFn, skipOnboardingFn, updateBusinessInfoFn } from "~/lib/server/settingsFns";
import { PageHeader, PageLoading, ErrorState } from "~/components/app/pageStates";
import { Field, TextInput } from "~/components/ui/Form";
import { Button } from "~/components/ui/Button";
import { COMMON_TIMEZONES, US_STATES, type SettingsView } from "~/lib/settingsTypes";

/** Shared styling for raw <select> elements (matches settings.tsx inputCls). */
const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-slate-50 disabled:text-slate-400";

const TOTAL_STEPS = 6;

const STEP_LABELS = [
  "Company info",
  "Services",
  "Business hours",
  "Service areas",
  "Notifications",
  "Review",
] as const;

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
        description="Six quick steps so missed calls become booked jobs."
      />

      {/* Progress: "Step X of 6" + percent bar */}
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

      {step === 1 ? <CompanyInfoStep view={data} onDone={() => setStep(2)} /> : null}
      {step === 2 ? <ServicesStep view={data} onBack={() => setStep(1)} onDone={() => setStep(3)} /> : null}
      {step >= 3 ? <PlaceholderStep step={step} onBack={() => setStep(step - 1)} onDone={() => setStep(step + 1)} /> : null}

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
// Steps 3-6: placeholders (built in later parts of this task)
// ---------------------------------------------------------------------------
function PlaceholderStep({
  step,
  onBack,
  onDone,
}: {
  step: number;
  onBack: () => void;
  onDone: () => void;
}) {
  const label = STEP_LABELS[step - 1];
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">{label}</h2>
      <p className="mt-1 text-sm text-slate-600">Coming in next step.</p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onDone}>Continue</Button>
      </div>
    </section>
  );
}
