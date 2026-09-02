/**
 * Settings + onboarding server functions.
 *
 * EVERY handler resolves businessId from the authenticated session
 * (requireAuth / requireRole) — never from client input — and passes it down
 * to the business-scoped query layer. Client input is whitelisted and
 * validated server-side; Date objects never cross the wire; failures return
 * typed results instead of throwing.
 */
import { createServerFn } from "@tanstack/react-start";
import { getSessionFromRequest, requireAuth, requireRole } from "~/lib/server/auth.server";
import { authErrorToResult } from "~/lib/server/sessionFns";
import * as q from "~/db/queries";
import type { Business } from "~/db/schema";
import {
  BUSINESS_DAYS,
  COMMON_TIMEZONES,
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_PREF_KEYS,
  type NotificationPrefs,
  type OnboardingState,
  type SettingsView,
} from "~/lib/settingsTypes";

export type SettingsResult<T> = { ok: true; data: T } | { ok: false; status: 400 | 401 | 403 | 404; error: string };

// ---------------------------------------------------------------------------
// Server-side validation helpers
// ---------------------------------------------------------------------------
class ValidationError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.field = field;
  }
}

function str(value: unknown, field: string, opts: { max: number; min?: number }): string {
  if (typeof value !== "string") throw new ValidationError(`${field} is required.`, field);
  const s = value.trim();
  const min = opts.min ?? 1;
  if (s.length < min) throw new ValidationError(`${field} is required.`, field);
  if (s.length > opts.max) throw new ValidationError(`${field} must be at most ${opts.max} characters.`, field);
  return s;
}

function optionalStr(value: unknown, field: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new ValidationError(`${field} must be text.`, field);
  const s = value.trim();
  if (s.length === 0) return null;
  if (s.length > max) throw new ValidationError(`${field} must be at most ${max} characters.`, field);
  return s;
}

function optionalInt(value: unknown, field: string, max: number): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > max) {
    throw new ValidationError(`${field} must be a whole number between 1 and ${max}.`, field);
  }
  return n;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9()\-. ]{7,20}$/;
const URL_RE = /^https?:\/\/[^\s]+\.[^\s]+$/i;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function optionalEmail(value: unknown, field: string): string | null {
  const s = optionalStr(value, field, 160);
  if (s === null) return null;
  if (!EMAIL_RE.test(s)) throw new ValidationError(`${field} is not a valid email address.`, field);
  return s.toLowerCase();
}

function optionalPhone(value: unknown, field: string): string | null {
  const s = optionalStr(value, field, 32);
  if (s === null) return null;
  if (!PHONE_RE.test(s)) throw new ValidationError(`${field} is not a valid phone number.`, field);
  return s;
}

function optionalUrl(value: unknown, field: string): string | null {
  const s = optionalStr(value, field, 200);
  if (s === null) return null;
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  if (!URL_RE.test(withScheme)) throw new ValidationError(`${field} is not a valid website address.`, field);
  return withScheme;
}

function optionalState(value: unknown, field: string): string | null {
  const s = optionalStr(value, field, 2);
  if (s === null) return null;
  return s.toUpperCase();
}

function pickTimezone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return (COMMON_TIMEZONES as readonly string[]).includes(value) ? value : undefined;
}

function hhmm(value: unknown, field: string): string {
  if (typeof value !== "string" || !TIME_RE.test(value)) {
    throw new ValidationError(`${field} must be a time like 08:00.`, field);
  }
  return value;
}

/** Notification prefs are stored as a known-shape jsonb object on businesses.settings. */
function sanitizeNotificationPrefs(raw: unknown): NotificationPrefs {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_NOTIFICATION_PREFS };
  for (const key of NOTIFICATION_PREF_KEYS) {
    if (typeof source[key] === "boolean") out[key] = source[key] as boolean;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Onboarding progress (derived from DB state — nothing extra is stored)
// ---------------------------------------------------------------------------
const ONBOARDING_STEPS = [
  { id: 1, key: "company" as const, label: "Company info" },
  { id: 2, key: "services" as const, label: "Services" },
  { id: 3, key: "hours" as const, label: "Business hours" },
  { id: 4, key: "areas" as const, label: "Service areas" },
  { id: 5, key: "notifications" as const, label: "Notifications" },
  { id: 6, key: "review" as const, label: "Review" },
];

interface StepDoneArgs {
  business: Business;
  serviceCount: number;
  areaCount: number;
  hourCount: number;
  configuredHours: boolean;
  prefs: NotificationPrefs;
  prefsTouched: boolean;
}

function computeStepDone(args: StepDoneArgs): boolean[] {
  const companyDone =
    args.business.name.trim().length > 0 &&
    args.business.phone != null &&
    args.business.email != null &&
    args.business.addressLine1 != null;
  return [
    companyDone,
    args.serviceCount > 0,
    args.configuredHours,
    args.areaCount > 0,
    args.prefsTouched,
    // Review counts as done only when every real step is done.
    companyDone && args.serviceCount > 0 && args.configuredHours && args.areaCount > 0 && args.prefsTouched,
  ];
}

function onboardingState(business: Business, done: boolean[]): OnboardingState {
  const steps = ONBOARDING_STEPS.map((s, i) => ({ ...s, done: done[i] }));
  const percent = Math.round((done.filter(Boolean).length / steps.length) * 100);
  const resumeStep = done.findIndex((d) => !d);
  const firstUnfinished = resumeStep === -1 ? steps.length : steps[resumeStep].id;
  const skipped =
    typeof (business as unknown as { settings?: Record<string, unknown> }).settings
      ?.onboardingSkippedAt === "string";
  return {
    steps,
    percent,
    resumeStep: firstUnfinished,
    // The wizard is only pushed on businesses missing baseline configuration;
    // a business that explicitly skipped is never nagged again.
    needsOnboarding: done.slice(0, 4).some((d) => !d) && !skipped,
  };
}

// ---------------------------------------------------------------------------
// Read: the whole settings view (any role — employees can read)
// ---------------------------------------------------------------------------
export const getSettingsFn = createServerFn({ method: "GET" }).handler(async (): Promise<SettingsResult<SettingsView>> => {
  try {
    const ctx = await requireAuth();
    const businessId = ctx.business.id;
    const b = ctx.business;
    const [services, areas, hours, defaults, serviceCount, areaCount, hourCount] = await Promise.all([
      q.listServices(businessId),
      q.listServiceAreas(businessId),
      q.listBusinessHours(businessId),
      q.listServiceDefaults(),
      q.countServices(businessId),
      q.countServiceAreas(businessId),
      q.countBusinessHours(businessId),
    ]);
    const prefs = sanitizeNotificationPrefs((b as unknown as { settings?: unknown }).settings);
    // Hours are "configured" when all 7 days exist AND at least one day is open.
    const hourMap = new Map(hours.map((h) => [h.dayOfWeek, h]));
    const configuredHours = hourCount === 7 && BUSINESS_DAYS.some((d) => hourMap.get(d)?.isOpen);
    const done = computeStepDone({
      business: b,
      serviceCount,
      areaCount,
      hourCount,
      configuredHours,
      prefs,
      prefsTouched:
        typeof (b as unknown as { settings?: Record<string, unknown> }).settings
          ?.notificationPrefsSavedAt === "string",
    });
    return {
      ok: true,
      data: {
        role: ctx.role,
        canEdit: ctx.role === "owner" || ctx.role === "manager",
        business: {
          name: b.name,
          phone: b.phone,
          email: b.email,
          website: b.website,
          addressLine1: b.addressLine1,
          addressLine2: b.addressLine2,
          city: b.city,
          state: b.state,
          postalCode: b.postalCode,
          timezone: b.timezone,
        },
        hours: BUSINESS_DAYS.map((d) => {
          const row = hours.find((h) => h.dayOfWeek === d);
          return {
            dayOfWeek: d,
            isOpen: row?.isOpen ?? false,
            opensAt: row?.opensAt ? String(row.opensAt).slice(0, 5) : null,
            closesAt: row?.closesAt ? String(row.closesAt).slice(0, 5) : null,
          };
        }),
        services: services.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          basePriceCents: s.basePriceCents == null ? null : Number(s.basePriceCents),
          durationMinutes: s.durationMinutes == null ? null : Number(s.durationMinutes),
          isDefault: s.isDefault,
          isActive: s.isActive,
        })),
        serviceAreas: areas.map((a) => ({
          id: a.id,
          kind: a.kind,
          value: a.value,
          state: a.state,
        })),
        serviceDefaults: defaults.map((d) => ({ id: d.id, name: d.name, description: d.description })),
        notificationPrefs: prefs,
        onboarding: onboardingState(b, done),
      },
    };
  } catch (e) {
    return authErrorToResult(e);
  }
});

// ---------------------------------------------------------------------------
// Write: business info (owner/manager)
// ---------------------------------------------------------------------------
export interface BusinessInfoInput {
  name: string;
  phone: string;
  email: string;
  website: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  timezone: string;
}

export const updateBusinessInfoFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as Partial<BusinessInfoInput>)
  .handler(async ({ data }): Promise<SettingsResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      if (data.name !== undefined) {
        const name = str(data.name, "Business name", { max: 120, min: 2 });
        await q.updateBusiness(businessId, { name });
      }
      const patch: Partial<Business> = {};
      if (data.phone !== undefined) patch.phone = optionalPhone(data.phone, "Phone");
      if (data.email !== undefined) patch.email = optionalEmail(data.email, "Email");
      if (data.website !== undefined) patch.website = optionalUrl(data.website, "Website");
      if (data.addressLine1 !== undefined) patch.addressLine1 = optionalStr(data.addressLine1, "Address", 200);
      if (data.addressLine2 !== undefined) patch.addressLine2 = optionalStr(data.addressLine2, "Address line 2", 200);
      if (data.city !== undefined) patch.city = optionalStr(data.city, "City", 100);
      if (data.state !== undefined) patch.state = optionalState(data.state, "State");
      if (data.postalCode !== undefined) {
        const zip = optionalStr(data.postalCode, "ZIP code", 10);
        if (zip && !/^[0-9]{5}(-[0-9]{4})?$/.test(zip)) {
          throw new ValidationError("ZIP code must look like 12345 or 12345-6789.", "postalCode");
        }
        patch.postalCode = zip;
      }
      if (data.timezone !== undefined) {
        const tz = pickTimezone(data.timezone);
        if (!tz) throw new ValidationError("Choose a supported time zone.", "timezone");
        patch.timezone = tz;
      }
      if (Object.keys(patch).length > 0) await q.updateBusiness(businessId, patch);
      return { ok: true, data: { message: "Business info saved." } };
    } catch (e) {
      return validationToResult(e);
    }
  });

// ---------------------------------------------------------------------------
// Write: business hours — one upsert per day, all 7 days in one save
// ---------------------------------------------------------------------------
export interface HoursInput {
  days: { dayOfWeek: number; isOpen: boolean; opensAt: string; closesAt: string }[];
}

export const saveBusinessHoursFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as HoursInput)
  .handler(async ({ data }): Promise<SettingsResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      if (!Array.isArray(data.days)) throw new ValidationError("Hours payload is malformed.", "days");
      const byDay = new Map<number, HoursInput["days"][number]>();
      for (const raw of data.days) {
        const d = Number(raw?.dayOfWeek);
        if (!Number.isInteger(d) || d < 0 || d > 6) throw new ValidationError("Invalid day of week.", "days");
        if (byDay.has(d)) throw new ValidationError("Duplicate day in hours payload.", "days");
        const isOpen = raw.isOpen === true;
        if (isOpen) {
          const opensAt = hhmm(raw.opensAt, "Opening time");
          const closesAt = hhmm(raw.closesAt, "Closing time");
          if (opensAt >= closesAt) {
            throw new ValidationError("Opening time must be earlier than closing time.", "opensAt");
          }
          byDay.set(d, { dayOfWeek: d, isOpen: true, opensAt, closesAt });
        } else {
          byDay.set(d, { dayOfWeek: d, isOpen: false, opensAt: "", closesAt: "" });
        }
      }
      if (byDay.size === 0) throw new ValidationError("No hours were submitted.", "days");
      for (const day of byDay.values()) {
        await q.upsertBusinessHour(businessId, {
          dayOfWeek: day.dayOfWeek,
          isOpen: day.isOpen,
          opensAt: day.isOpen ? `${day.opensAt}:00` : null,
          closesAt: day.isOpen ? `${day.closesAt}:00` : null,
        });
      }
      return { ok: true, data: { message: "Business hours saved." } };
    } catch (e) {
      return validationToResult(e);
    }
  });

// ---------------------------------------------------------------------------
// Write: services — create from defaults or custom, update, deactivate
// ---------------------------------------------------------------------------
export interface AddServiceInput {
  name: string;
  description: string;
  basePriceCents: number;
  durationMinutes: number;
  defaultServiceId: string;
}

export const addServiceFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as Partial<AddServiceInput>)
  .handler(async ({ data }): Promise<SettingsResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      const name = str(data.name, "Service name", { max: 100, min: 2 });
      let descFromDefault: string | null = null;
      const description = optionalStr(data.description, "Description", 500);
      const basePriceCents = optionalInt(data.basePriceCents, "Price (cents)", 100_000_00);
      const durationMinutes = optionalInt(data.durationMinutes, "Duration", 1440);
      let defaultServiceId: string | null = null;
      let isDefault = false;
      if (typeof data.defaultServiceId === "string" && data.defaultServiceId.trim().length > 0) {
        const defaults = await q.listServiceDefaults();
        const match = defaults.find((d) => d.id === data.defaultServiceId);
        if (!match) throw new ValidationError("Unknown service default.", "defaultServiceId");
        defaultServiceId = match.id;
        isDefault = true;
        if (data.description === undefined && description === null) descFromDefault = match.description;
      }
      const existing = await q.listServices(businessId);
      if (existing.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
        throw new ValidationError(`You already have a service called "${name}".`, "name");
      }
      const maxSort = existing.reduce((m, s) => Math.max(m, Number(s.sortOrder)), 0);
      await q.createService(businessId, {
        name,
        description: description ?? descFromDefault,
        basePriceCents,
        durationMinutes,
        isDefault,
        defaultServiceId,
        isActive: true,
        sortOrder: maxSort + 10,
      });
      return { ok: true, data: { message: `Service "${name}" added.` } };
    } catch (e) {
      return validationToResult(e);
    }
  });

export interface UpdateServiceInput {
  id: string;
  name: string;
  description: string;
  basePriceCents: number;
  durationMinutes: number;
  isActive: boolean;
}

export const updateServiceFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as Partial<UpdateServiceInput>)
  .handler(async ({ data }): Promise<SettingsResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      const id = str(data.id, "Service", { max: 64 });
      const current = await q.getService(businessId, id);
      if (!current) return { ok: false, status: 404, error: "Service not found." };
      const patch: q.UpdateServiceInput = {};
      const nextName = data.name !== undefined ? str(data.name, "Service name", { max: 100, min: 2 }) : null;
      if (nextName) patch.name = nextName;
      if (data.description !== undefined) patch.description = optionalStr(data.description, "Description", 500);
      if (data.basePriceCents !== undefined) patch.basePriceCents = optionalInt(data.basePriceCents, "Price (cents)", 100_000_00);
      if (data.durationMinutes !== undefined) patch.durationMinutes = optionalInt(data.durationMinutes, "Duration", 1440);
      if (data.isActive !== undefined) patch.isActive = data.isActive === true;
      if (nextName && nextName.toLowerCase() !== current.name.toLowerCase()) {
        const others = await q.listServices(businessId);
        if (others.some((s) => s.id !== id && s.name.toLowerCase() === nextName.toLowerCase())) {
          throw new ValidationError(`You already have a service called "${nextName}".`, "name");
        }
      }
      await q.updateService(businessId, id, patch);
      return { ok: true, data: { message: "Service updated." } };
    } catch (e) {
      return validationToResult(e);
    }
  });

/** Deactivate keeps the row (history may reference it); delete removes a never-used custom row. */
export const deactivateServiceFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { id: string })
  .handler(async ({ data }): Promise<SettingsResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      const id = str(data?.id, "Service", { max: 64 });
      const updated = await q.updateService(businessId, id, { isActive: false });
      if (!updated) return { ok: false, status: 404, error: "Service not found." };
      return { ok: true, data: { message: "Service deactivated." } };
    } catch (e) {
      return validationToResult(e);
    }
  });

export const deleteServiceFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { id: string })
  .handler(async ({ data }): Promise<SettingsResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      const id = str(data?.id, "Service", { max: 64 });
      const deleted = await q.deleteService(businessId, id);
      if (!deleted) return { ok: false, status: 404, error: "Service not found." };
      return { ok: true, data: { message: "Service removed." } };
    } catch (e) {
      return validationToResult(e);
    }
  });

/**
 * Seed the catalog from service_defaults when the business has no services
 * yet (used by the onboarding "start from the standard plumbing list" action).
 */
export const seedServicesFromDefaultsFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<SettingsResult<{ message: string; added: number }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      const existing = await q.listServices(businessId);
      const defaults = await q.listServiceDefaults();
      const have = new Set(existing.map((s) => s.name.toLowerCase()));
      const toAdd = defaults.filter((d) => !have.has(d.name.toLowerCase()));
      let sort = existing.reduce((m, s) => Math.max(m, Number(s.sortOrder)), 0);
      for (const d of toAdd) {
        sort += 10;
        await q.createService(businessId, {
          name: d.name,
          description: d.description,
          isDefault: true,
          defaultServiceId: d.id,
          isActive: true,
          sortOrder: sort,
        });
      }
      return { ok: true, data: { message: `${toAdd.length} standard services added.`, added: toAdd.length } };
    } catch (e) {
      return validationToResult(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Write: service areas — add (zip or city+state) and remove
// ---------------------------------------------------------------------------
export interface AddAreaInput {
  kind: "zip" | "city";
  value: string;
  state: string;
}

export const addServiceAreaFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as Partial<AddAreaInput>)
  .handler(async ({ data }): Promise<SettingsResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      const kind = data.kind === "zip" || data.kind === "city" ? data.kind : null;
      if (!kind) throw new ValidationError("Area type must be ZIP or city.", "kind");
      const value = str(data.value, kind === "zip" ? "ZIP code" : "City", { max: 100, min: 2 });
      let normalized: string;
      let state: string | null = null;
      if (kind === "zip") {
        if (!/^[0-9]{5}$/.test(value)) throw new ValidationError("ZIP must be 5 digits.", "value");
        normalized = value;
      } else {
        normalized = value.replace(/\s+/g, " ");
        state = optionalState(data.state, "State");
      }
      const created = await q.createServiceArea(businessId, { kind, value: normalized, state });
      if (!created) return { ok: false, status: 400, error: "That area is already on your list." };
      return { ok: true, data: { message: "Service area added." } };
    } catch (e) {
      return validationToResult(e);
    }
  });

export const removeServiceAreaFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { id: string })
  .handler(async ({ data }): Promise<SettingsResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      const id = str(data?.id, "Area", { max: 64 });
      const deleted = await q.deleteServiceArea(businessId, id);
      if (!deleted) return { ok: false, status: 404, error: "Service area not found." };
      return { ok: true, data: { message: "Service area removed." } };
    } catch (e) {
      return validationToResult(e);
    }
  });

// ---------------------------------------------------------------------------
// Write: notification prefs (saved to businesses.settings; delivery pending
// provider setup — shown honestly in the UI)
// ---------------------------------------------------------------------------
export const saveNotificationPrefsFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as Record<string, unknown>)
  .handler(async ({ data }): Promise<SettingsResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      const prefs = sanitizeNotificationPrefs(data);
      const current = await q.getBusiness(businessId);
      if (!current) return { ok: false, status: 404, error: "Business not found." };
      const settings = {
        ...((current as unknown as { settings?: Record<string, unknown> }).settings ?? {}),
        ...prefs,
        notificationPrefsSavedAt: new Date().toISOString(),
      };
      await q.updateBusinessSettings(businessId, settings);
      return { ok: true, data: { message: "Notification preferences saved." } };
    } catch (e) {
      return validationToResult(e);
    }
  });

// ---------------------------------------------------------------------------
// Onboarding: skip + lightweight nudge check for the app layout gate
// ---------------------------------------------------------------------------
export const skipOnboardingFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<SettingsResult<{ message: string }>> => {
    try {
      const ctx = await requireRole("owner", "manager");
      const businessId = ctx.business.id;
      const current = await q.getBusiness(businessId);
      if (!current) return { ok: false, status: 404, error: "Business not found." };
      const settings = {
        ...((current as unknown as { settings?: Record<string, unknown> }).settings ?? {}),
        onboardingSkippedAt: new Date().toISOString(),
      };
      await q.updateBusinessSettings(businessId, settings);
      return { ok: true, data: { message: "Onboarding skipped. You can finish setup anytime from Settings." } };
    } catch (e) {
      return validationToResult(e);
    }
  },
);

export interface OnboardingNudge {
  needsOnboarding: boolean;
  resumeStep: number;
  percent: number;
  canEdit: boolean;
}

/** Cheap gate used by the /_app layout: should this user be walked to /onboarding? */
export const getOnboardingNudgeFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<OnboardingNudge | null> => {
    const ctx = await getSessionFromRequest();
    if (!ctx) return null;
    const businessId = ctx.business.id;
    const [serviceCount, areaCount, hourCount, hours] = await Promise.all([
      q.countServices(businessId),
      q.countServiceAreas(businessId),
      q.countBusinessHours(businessId),
      q.listBusinessHours(businessId),
    ]);
    const settings = (ctx.business as unknown as { settings?: Record<string, unknown> }).settings ?? {};
    const prefs = sanitizeNotificationPrefs(settings);
    const hourMap = new Map(hours.map((h) => [h.dayOfWeek, h]));
    const configuredHours = hourCount === 7 && BUSINESS_DAYS.some((d) => hourMap.get(d)?.isOpen);
    const done = computeStepDone({
      business: ctx.business,
      serviceCount,
      areaCount,
      hourCount,
      configuredHours,
      prefs,
      prefsTouched: typeof settings.notificationPrefsSavedAt === "string",
    });
    const state = onboardingState(ctx.business, done);
    return {
      needsOnboarding: state.needsOnboarding,
      resumeStep: state.resumeStep,
      percent: state.percent,
      canEdit: ctx.role === "owner" || ctx.role === "manager",
    };
  },
);

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------
function validationToResult(e: unknown): SettingsResult<never> {
  if (e instanceof ValidationError) {
    return { ok: false, status: 400, error: e.message };
  }
  return authErrorToResult(e);
}
