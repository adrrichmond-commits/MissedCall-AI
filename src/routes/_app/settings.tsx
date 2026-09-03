import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  addServiceAreaFn,
  addServiceFn,
  deactivateServiceFn,
  deleteServiceFn,
  getSettingsFn,
  removeServiceAreaFn,
  saveBusinessHoursFn,
  saveEmergencyPrefsFn,
  saveNotificationPrefsFn,
  seedServicesFromDefaultsFn,
  updateBusinessInfoFn,
  updateServiceFn,
} from "~/lib/server/settingsFns";
import { PageHeader, PageLoading, ErrorState, EmptyState } from "~/components/app/pageStates";
import { Badge } from "~/components/ui/Badge";
import { Field, TextInput } from "~/components/ui/Form";
import { Button } from "~/components/ui/Button";
import {
  COMMON_TIMEZONES,
  DAY_LABELS,
  NOTIFICATION_PREF_KEYS,
  US_STATES,
  type EmergencyPrefs,
  type NotificationPrefs,
  type SettingsView,
} from "~/lib/settingsTypes";

/** Shared styling for raw <select>/<input> elements (matches ui/Form fieldCls). */
const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-slate-50 disabled:text-slate-400";

export const Route = createFileRoute("/_app/settings")({
  validateSearch: (search: Record<string, unknown>): { step?: string } => ({
    step: typeof search.step === "string" ? search.step : undefined,
  }),
  loader: async () => {
    const res = await getSettingsFn();
    if (!res.ok) throw new Error(res.error);
    return res.data;
  },
  pendingComponent: PageLoading,
  errorComponent: () => (
    <ErrorState
      message="Settings couldn't load. Check your connection and retry."
      onRetry={() => window.location.reload()}
    />
  ),
  component: SettingsPage,
});

// ---------------------------------------------------------------------------
// Small shared bits
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

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <h2 className="text-base font-semibold text-slate-900">{title}</h2>
      {description ? <p className="mt-1 text-sm text-slate-600">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
function SettingsPage() {
  const data = Route.useLoaderData();
  const [view, setView] = useState(data);
  const canEdit = view.canEdit;

  const refresh = async () => {
    const res = await getSettingsFn();
    if (res.ok) setView(res.data);
    return res;
  };

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Business info, hours, services, and service areas — editable by owners and managers."
        actions={canEdit ? undefined : <Badge tone="slate">Read-only access</Badge>}
      />
      {!canEdit ? (
        <p className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
          Your role ({view.role}) has read-only access. Ask an owner or manager to make changes.
        </p>
      ) : null}
      <div className="space-y-6">
        <BusinessInfoSection view={view} refresh={refresh} canEdit={canEdit} />
        <HoursSection view={view} refresh={refresh} canEdit={canEdit} />
        <ServicesSection view={view} refresh={refresh} canEdit={canEdit} />
        <AreasSection view={view} refresh={refresh} canEdit={canEdit} />
        <NotificationsSection view={view} refresh={refresh} canEdit={canEdit} />
        <EmergencySection view={view} refresh={refresh} canEdit={canEdit} />
        {view.role === "owner" ? <SubscriptionSection /> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Business info
// ---------------------------------------------------------------------------
function BusinessInfoSection({
  view,
  refresh,
  canEdit,
}: {
  view: SettingsView;
  refresh: () => Promise<unknown>;
  canEdit: boolean;
}) {
  const initial = view.business;
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
      await refresh();
    } else {
      setSave({ kind: "error", message: res.error });
    }
  };

  return (
    <SectionCard title="Business info" description="Shown to customers and used across the app.">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name" htmlFor="biz-name">
            <TextInput id="biz-name" value={name} disabled={!canEdit} onChange={setName} required />
            <FieldError msg={errors.name} />
          </Field>
          <Field label="Phone" htmlFor="biz-phone" hint="Customers see this number.">
            <TextInput id="biz-phone" value={phone} disabled={!canEdit} onChange={setPhone} />
            <FieldError msg={errors.phone} />
          </Field>
          <Field label="Email" htmlFor="biz-email">
            <TextInput id="biz-email" type="email" value={email} disabled={!canEdit} onChange={setEmail} />
            <FieldError msg={errors.email} />
          </Field>
          <Field label="Website" htmlFor="biz-website" hint="Your domain — https:// is added for you.">
            <TextInput id="biz-website" value={website} disabled={!canEdit} onChange={setWebsite} />
            <FieldError msg={errors.website} />
          </Field>
          <Field label="Address line 1" htmlFor="biz-addr1">
            <TextInput id="biz-addr1" value={addressLine1} disabled={!canEdit} onChange={setAddressLine1} />
          </Field>
          <Field label="Address line 2" htmlFor="biz-addr2">
            <TextInput id="biz-addr2" value={addressLine2} disabled={!canEdit} onChange={setAddressLine2} />
          </Field>
          <Field label="City" htmlFor="biz-city">
            <TextInput id="biz-city" value={city} disabled={!canEdit} onChange={setCity} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="State" htmlFor="biz-state">
              <select
                id="biz-state"
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
            <Field label="ZIP code" htmlFor="biz-zip">
              <TextInput id="biz-zip" value={postalCode} disabled={!canEdit} onChange={setPostalCode} />
              <FieldError msg={errors.postalCode} />
            </Field>
          </div>
          <Field label="Time zone" htmlFor="biz-tz" hint="Hours and appointments render in this zone.">
            <select
              id="biz-tz"
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
          {canEdit ? (
            <Button type="submit" disabled={save.kind === "saving"}>
              {save.kind === "saving" ? "Saving…" : "Save business info"}
            </Button>
          ) : null}
        </div>
      </form>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 2. Business hours
// ---------------------------------------------------------------------------
function HoursSection({
  view,
  refresh,
  canEdit,
}: {
  view: SettingsView;
  refresh: () => Promise<unknown>;
  canEdit: boolean;
}) {
  const [days, setDays] = useState(view.hours);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [errors, setErrors] = useState<Record<string, string>>({});

  const updateDay = (dayOfWeek: number, patch: Partial<(typeof days)[number]>) => {
    setDays((prev) => prev.map((d) => (d.dayOfWeek === dayOfWeek ? { ...d, ...patch } : d)));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const d of days) {
      if (!d.isOpen) continue;
      if (!d.opensAt || !d.closesAt) {
        errs[`day-${d.dayOfWeek}`] = "Open days need both times.";
      } else if (d.opensAt >= d.closesAt) {
        errs[`day-${d.dayOfWeek}`] = "Opening time must be before closing time.";
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setSave({ kind: "saving" });
    const res = await saveBusinessHoursFn({
      data: {
        days: days.map((d) => ({
          dayOfWeek: d.dayOfWeek,
          isOpen: d.isOpen,
          opensAt: d.isOpen ? (d.opensAt ?? "") : "",
          closesAt: d.isOpen ? (d.closesAt ?? "") : "",
        })),
      },
    });
    if (res.ok) {
      setSave({ kind: "saved", message: res.data.message });
      await refresh();
    } else {
      setSave({ kind: "error", message: res.error });
    }
  };

  return (
    <SectionCard title="Business hours" description="Used to decide what counts as after-hours.">
      <form onSubmit={onSubmit} className="space-y-2">
        {days.map((d) => (
          <div
            key={d.dayOfWeek}
            className="flex flex-col gap-2 rounded-xl px-2 py-2 ring-1 ring-transparent hover:ring-slate-100 sm:flex-row sm:items-center sm:gap-3"
          >
            <label className="flex w-full items-center gap-2 sm:w-44">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                checked={d.isOpen}
                disabled={!canEdit}
                onChange={(e) => updateDay(d.dayOfWeek, { isOpen: e.target.checked })}
              />
              <span className="text-sm font-medium text-slate-800">{DAY_LABELS[d.dayOfWeek]}</span>
            </label>
            {d.isOpen ? (
              <div className="flex items-center gap-2">
                <input
                  type="time"
                  aria-label={`${DAY_LABELS[d.dayOfWeek]} opens at`}
                  className={`${inputCls} max-w-[8rem]`}
                  value={d.opensAt ?? ""}
                  disabled={!canEdit}
                  onChange={(e) => updateDay(d.dayOfWeek, { opensAt: e.target.value })}
                />
                <span className="text-sm text-slate-500">to</span>
                <input
                  type="time"
                  aria-label={`${DAY_LABELS[d.dayOfWeek]} closes at`}
                  className={`${inputCls} max-w-[8rem]`}
                  value={d.closesAt ?? ""}
                  disabled={!canEdit}
                  onChange={(e) => updateDay(d.dayOfWeek, { closesAt: e.target.value })}
                />
              </div>
            ) : (
              <span className="text-sm text-slate-400">Closed</span>
            )}
            <FieldError msg={errors[`day-${d.dayOfWeek}`]} />
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 pt-2">
          <SaveFeedback state={save} />
          {canEdit ? (
            <Button type="submit" disabled={save.kind === "saving"}>
              {save.kind === "saving" ? "Saving…" : "Save hours"}
            </Button>
          ) : null}
        </div>
      </form>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 3. Services
// ---------------------------------------------------------------------------
function ServicesSection({
  view,
  refresh,
  canEdit,
}: {
  view: SettingsView;
  refresh: () => Promise<unknown>;
  canEdit: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "ok" | "err"; message: string } | null>(null);

  const runAction = async (fn: () => Promise<{ ok: true; data: { message: string } } | { ok: false; error: string }>) => {
    const res = await fn();
    if (res.ok) {
      setFeedback({ tone: "ok", message: res.data.message });
      await refresh();
    } else {
      setFeedback({ tone: "err", message: res.error });
    }
  };

  return (
    <SectionCard title="Services" description="What you offer — used on leads, quotes, and the AI receptionist later.">
      {feedback ? (
        <p
          className={`mb-3 text-sm font-medium ${feedback.tone === "ok" ? "text-green-700" : "text-red-700"}`}
          role={feedback.tone === "ok" ? "status" : "alert"}
        >
          {feedback.tone === "ok" ? "✓ " : ""}{feedback.message}
        </p>
      ) : null}
      {view.services.length === 0 ? (
        <EmptyState
          title="No services yet"
          description="Start from the standard plumbing list, then tune it."
          action={
            canEdit ? (
              <Button onClick={() => runAction(() => seedServicesFromDefaultsFn())}>Add standard plumbing services</Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl ring-1 ring-slate-200">
          {view.services.map((s) =>
            editingId === s.id ? (
              <li key={s.id} className="p-3">
                <ServiceEditRow
                  service={s}
                  onCancel={() => setEditingId(null)}
                  onSaved={async (msg) => {
                    setEditingId(null);
                    setFeedback({ tone: "ok", message: msg });
                    await refresh();
                  }}
                />
              </li>
            ) : (
              <li key={s.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                    {s.name}
                    {s.isDefault ? <Badge tone="brand">standard</Badge> : <Badge tone="slate">custom</Badge>}
                    {!s.isActive ? <Badge tone="amber">inactive</Badge> : null}
                  </p>
                  {s.description ? <p className="truncate text-xs text-slate-500">{s.description}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {s.basePriceCents != null ? (
                    <span className="text-sm text-slate-600">from ${(s.basePriceCents / 100).toFixed(0)}</span>
                  ) : null}
                  {canEdit ? (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => setEditingId(s.id)}>Edit</Button>
                      {s.isActive ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => runAction(() => deactivateServiceFn({ data: { id: s.id } }))}
                        >
                          Deactivate
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => runAction(() => deleteServiceFn({ data: { id: s.id } }))}
                        >
                          Remove
                        </Button>
                      )}
                    </>
                  ) : null}
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      {canEdit ? (
        <div className="mt-4">
          {adding ? (
            <ServiceAddRow
              defaults={view.serviceDefaults}
              onCancel={() => setAdding(false)}
              onSaved={async (msg) => {
                setAdding(false);
                setFeedback({ tone: "ok", message: msg });
                await refresh();
              }}
            />
          ) : (
            <Button variant="secondary" onClick={() => setAdding(true)}>+ Add a service</Button>
          )}
        </div>
      ) : null}
    </SectionCard>
  );
}

function ServiceAddRow({
  defaults,
  onCancel,
  onSaved,
}: {
  defaults: SettingsView["serviceDefaults"];
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [duration, setDuration] = useState("");
  const [fromDefault, setFromDefault] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (name.trim().length < 2) {
      setError("Give the service a name (at least 2 characters).");
      return;
    }
    if (price.trim()) {
      const n = parseFloat(price);
      if (!Number.isFinite(n) || n <= 0) {
        setError("Price must be a positive number.");
        return;
      }
    }
    setPending(true);
    setError(null);
    const res = await addServiceFn({
      data: {
        name,
        description: fromDefault ? undefined : null,
        basePriceCents: price.trim() ? Math.round(parseFloat(price) * 100) : null,
        durationMinutes: duration.trim() ? parseInt(duration, 10) : null,
        defaultServiceId: fromDefault || null,
      },
    });
    setPending(false);
    if (res.ok) onSaved(res.data.message);
    else setError(res.error);
  };

  return (
    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <Field label="Service name" htmlFor="svc-name">
          <TextInput id="svc-name" value={name} onChange={setName} placeholder="e.g. Water heater install" />
        </Field>
        <Field label="Price from ($)" htmlFor="svc-price">
          <TextInput id="svc-price" value={price} placeholder="149" onChange={setPrice} />
        </Field>
        <Field label="Minutes" htmlFor="svc-duration">
          <TextInput id="svc-duration" value={duration} placeholder="90" onChange={setDuration} />
        </Field>
      </div>
      {defaults.length > 0 ? (
        <div className="mt-2">
          <label htmlFor="svc-default" className="mb-1.5 block text-sm font-medium text-slate-700">
            Or start from a standard service
          </label>
          <select
            id="svc-default"
            className={inputCls}
            value={fromDefault}
            onChange={(e) => {
              setFromDefault(e.target.value);
              const d = defaults.find((x) => x.id === e.target.value);
              if (d && !name) setName(d.name);
            }}
          >
            <option value="">— custom service —</option>
            {defaults.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-sm font-medium text-red-700" role="alert">{error}</p> : null}
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={submit} disabled={pending}>{pending ? "Adding…" : "Add service"}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function ServiceEditRow({
  service,
  onCancel,
  onSaved,
}: {
  service: SettingsView["services"][number];
  onCancel: () => void;
  onSaved: (message: string) => void;
}) {
  const [name, setName] = useState(service.name);
  const [price, setPrice] = useState(service.basePriceCents == null ? "" : (service.basePriceCents / 100).toString());
  const [duration, setDuration] = useState(service.durationMinutes == null ? "" : String(service.durationMinutes));
  const [isActive, setIsActive] = useState(service.isActive);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (name.trim().length < 2) {
      setError("Service name is required.");
      return;
    }
    setPending(true);
    const res = await updateServiceFn({
      data: {
        id: service.id,
        name,
        basePriceCents: price.trim() ? Math.round(parseFloat(price) * 100) : null,
        durationMinutes: duration.trim() ? parseInt(duration, 10) : null,
        isActive,
      },
    });
    setPending(false);
    if (res.ok) onSaved("Service updated.");
    else setError(res.error);
  };

  return (
    <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
        <Field label="Service name" htmlFor={`svc-edit-name-${service.id}`}>
          <TextInput id={`svc-edit-name-${service.id}`} value={name} onChange={setName} />
        </Field>
        <Field label="Price from ($)" htmlFor={`svc-edit-price-${service.id}`}>
          <TextInput id={`svc-edit-price-${service.id}`} value={price} onChange={setPrice} />
        </Field>
        <Field label="Minutes" htmlFor={`svc-edit-duration-${service.id}`}>
          <TextInput id={`svc-edit-duration-${service.id}`} value={duration} onChange={setDuration} />
        </Field>
      </div>
      <label className="mt-2 flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        Active (offered to customers)
      </label>
      {error ? <p className="mt-2 text-sm font-medium text-red-700" role="alert">{error}</p> : null}
      <div className="mt-3 flex items-center gap-2">
        <Button onClick={submit} disabled={pending}>{pending ? "Saving…" : "Save"}</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Service areas
// ---------------------------------------------------------------------------
function AreasSection({
  view,
  refresh,
  canEdit,
}: {
  view: SettingsView;
  refresh: () => Promise<unknown>;
  canEdit: boolean;
}) {
  const [kind, setKind] = useState<"zip" | "city">("zip");
  const [value, setValue] = useState("");
  const [state, setState] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOkMsg(null);
    if (kind === "zip" && !/^[0-9]{5}$/.test(value.trim())) {
      setError("ZIP must be 5 digits.");
      return;
    }
    if (kind === "city" && value.trim().length < 2) {
      setError("Enter a city name.");
      return;
    }
    setPending(true);
    const res = await addServiceAreaFn({ data: { kind, value, state } });
    setPending(false);
    if (res.ok) {
      setOkMsg("Service area added.");
      setValue("");
      setState("");
      await refresh();
    } else {
      setError(res.error);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    setOkMsg(null);
    const res = await removeServiceAreaFn({ data: { id } });
    if (res.ok) {
      setOkMsg("Service area removed.");
      await refresh();
    } else {
      setError(res.error);
    }
  };

  return (
    <SectionCard title="Service areas" description="Where you work — ZIPs and/or cities.">
      {view.serviceAreas.length === 0 ? (
        <EmptyState title="No service areas yet" description="Add the ZIP codes and cities you serve." />
      ) : (
        <ul className="mb-4 flex flex-wrap gap-2">
          {view.serviceAreas.map((a) => (
            <li
              key={a.id}
              className="inline-flex items-center gap-2 rounded-full bg-slate-100 py-1 pl-3 pr-1 text-sm text-slate-800 ring-1 ring-inset ring-slate-200"
            >
              <span className="font-medium">{a.value}</span>
              {a.kind === "city" && a.state ? <span className="text-slate-500">{a.state}</span> : null}
              <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-500">
                {a.kind}
              </span>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => remove(a.id)}
                  aria-label={`Remove ${a.value}`}
                  className="rounded-full px-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form onSubmit={add} className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Type" htmlFor="area-kind">
              <select id="area-kind" className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as "zip" | "city")}>
                <option value="zip">ZIP code</option>
                <option value="city">City</option>
              </select>
            </Field>
            <Field label={kind === "zip" ? "ZIP code" : "City"} htmlFor="area-value">
              <TextInput
                id="area-value"
                value={value}
                placeholder={kind === "zip" ? "78701" : "Austin"}
                onChange={setValue}
              />
            </Field>
            {kind === "city" ? (
              <Field label="State" htmlFor="area-state">
                <select id="area-state" className={inputCls} value={state} onChange={(e) => setState(e.target.value)}>
                  <option value="">—</option>
                  {US_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </Field>
            ) : null}
            <div className="pb-0.5">
              <Button type="submit" disabled={pending}>{pending ? "Adding…" : "Add area"}</Button>
            </div>
          </div>
          {error ? <p className="mt-2 text-sm font-medium text-red-700" role="alert">{error}</p> : null}
          {okMsg ? <p className="mt-2 text-sm font-medium text-green-700" role="status">✓ {okMsg}</p> : null}
        </form>
      ) : null}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 5. Notifications (honest placeholder — saved, delivery pending provider setup)
// ---------------------------------------------------------------------------
function NotificationsSection({
  view,
  refresh,
  canEdit,
}: {
  view: SettingsView;
  refresh: () => Promise<unknown>;
  canEdit: boolean;
}) {
  const [prefs, setPrefs] = useState<NotificationPrefs>(view.notificationPrefs);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const toggle = (key: (typeof NOTIFICATION_PREF_KEYS)[number], value: boolean) => {
    setPrefs((p) => ({ ...p, [key]: value }));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSave({ kind: "saving" });
    const res = await saveNotificationPrefsFn({ data: prefs as unknown as Record<string, unknown> });
    if (res.ok) {
      setSave({ kind: "saved", message: res.data.message });
      await refresh();
    } else {
      setSave({ kind: "error", message: res.error });
    }
  };

  const labels: Record<(typeof NOTIFICATION_PREF_KEYS)[number], { title: string; hint: string }> = {
    onMissedCallSms: { title: "Text customers when a call is missed", hint: "Automatic SMS follow-up (Phase 2)." },
    onNewLeadEmail: { title: "Email me when a new lead arrives", hint: "Instant notification per lead." },
    dailySummaryEmail: { title: "Daily summary email", hint: "One recap each morning." },
    weeklySummaryEmail: { title: "Weekly summary email", hint: "Recap of leads, conversations, booked jobs." },
  };

  return (
    <SectionCard title="Notifications" description="Choose what MissedCall AI tells you about.">
      <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
        Your choices are saved now. Email/SMS delivery switches on when the messaging provider is connected (Phase 2) —
        nothing is sent until then.
      </p>
      <form onSubmit={onSubmit} className="space-y-2">
        {NOTIFICATION_PREF_KEYS.map((key) => (
          <label key={key} className="flex items-start gap-3 rounded-xl px-2 py-2 hover:bg-slate-50">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              checked={prefs[key]}
              disabled={!canEdit}
              onChange={(e) => toggle(key, e.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium text-slate-800">{labels[key].title}</span>
              <span className="block text-xs text-slate-500">{labels[key].hint}</span>
            </span>
          </label>
        ))}
        <div className="flex items-center justify-between gap-3 pt-2">
          <SaveFeedback state={save} />
          {canEdit ? (
            <Button type="submit" disabled={save.kind === "saving"}>
              {save.kind === "saving" ? "Saving…" : "Save preferences"}
            </Button>
          ) : null}
        </div>
      </form>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 5b. Emergency prefs (brief #1/#8: after-hours policy + instructions the AI
// follows on emergency calls; delivery waits for the messaging provider)
// ---------------------------------------------------------------------------
function EmergencySection({
  view,
  refresh,
  canEdit,
}: {
  view: SettingsView;
  refresh: () => Promise<unknown>;
  canEdit: boolean;
}) {
  const [prefs, setPrefs] = useState<EmergencyPrefs>(view.emergencyPrefs);
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSave({ kind: "saving" });
    const res = await saveEmergencyPrefsFn({ data: prefs as unknown as Record<string, unknown> });
    if (res.ok) {
      setSave({ kind: "saved", message: res.data.message });
      await refresh();
    } else {
      setSave({ kind: "error", message: res.error });
    }
  };

  const toggles: { key: "afterHoursEmergency" | "emergencyNotificationEmail" | "emergencyNotificationSms"; title: string; hint: string }[] = [
    {
      key: "afterHoursEmergency",
      title: "Take emergency calls after hours",
      hint: "The AI flags flooding, burst pipes, and gas concerns even when you are closed.",
    },
    {
      key: "emergencyNotificationEmail",
      title: "Email me on an emergency lead",
      hint: "Instant email the moment a call is classified an emergency.",
    },
    {
      key: "emergencyNotificationSms",
      title: "Text me on an emergency lead",
      hint: "SMS to your phone the moment a call is classified an emergency.",
    },
  ];

  return (
    <SectionCard title="Emergency prefs" description="How the AI handles emergency calls and alerts you.">
      <p className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
        Preferences are saved now. Emergency email/SMS delivery switches on when the messaging
        provider is connected (Phase 2) — nothing is sent until then.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        {toggles.map((t) => (
          <label key={t.key} className="flex items-start gap-3 rounded-xl px-2 py-2 hover:bg-slate-50">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              checked={prefs[t.key]}
              disabled={!canEdit}
              onChange={(e) => setPrefs((p) => ({ ...p, [t.key]: e.target.checked }))}
            />
            <span>
              <span className="block text-sm font-medium text-slate-800">{t.title}</span>
              <span className="block text-xs text-slate-500">{t.hint}</span>
            </span>
          </label>
        ))}
        <Field label="Emergency instructions" htmlFor="emg-instructions" hint="What should the AI say and do on an emergency call? Up to 500 characters.">
          <textarea
            id="emg-instructions"
            className={inputCls + " min-h-24"}
            maxLength={500}
            rows={4}
            value={prefs.emergencyInstructions}
            placeholder="e.g. Tell the caller to shut off the main water valve if it is safe, take the address first, and we will call right back."
            disabled={!canEdit}
            onChange={(e) => setPrefs((p) => ({ ...p, emergencyInstructions: e.target.value }))}
          />
        </Field>
        <div className="flex items-center justify-between gap-3 pt-1">
          <SaveFeedback state={save} />
          {canEdit ? (
            <Button type="submit" disabled={save.kind === "saving"}>
              {save.kind === "saving" ? "Saving…" : "Save emergency prefs"}
            </Button>
          ) : null}
        </div>
      </form>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// 6. Subscription — owner-only placeholder (honest, links to future billing)
// ---------------------------------------------------------------------------
function SubscriptionSection() {
  return (
    <SectionCard
      title="Subscription"
      description="Owner-only. Plan and billing management arrive with Stripe in Phase 2."
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="text-sm text-slate-700">
          <p>
            Current plan: <Badge tone="brand">14-day free trial</Badge>
          </p>
          <p className="mt-1 text-slate-500">
            Starter $149/mo · Pro $249/mo — pick a plan when billing goes live. No card on file, nothing charges today.
          </p>
        </div>
        <span className="inline-flex cursor-not-allowed items-center justify-center rounded-lg bg-slate-100 px-4 py-2 text-sm font-medium text-slate-400">
          Billing coming soon
        </span>
      </div>
    </SectionCard>
  );
}
