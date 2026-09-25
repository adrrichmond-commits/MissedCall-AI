/**
 * Admin server functions (P3-G). Every fn funnels through
 * requirePlatformAdmin() — the platform-admin gate — before touching any
 * cross-business query. Results are client-safe shapes (dates as ISO
 * strings). Handler pattern matches appFns/authFns: return typed results,
 * never throw raw errors at the client.
 *
 * SSR NOTE (PR #27 — prod-only admin 500s): the GET reads used by ROUTE
 * LOADERS during SSR moved to plain functions in ./adminReads — a
 * createServerFn call inside a loader compiles to an SSR RPC stub
 * (createSsrRpc) = an HTTP self-call that is unreliable behind the hosting
 * proxy. The wrappers below delegate to those plain functions (one source of
 * truth) and remain for BROWSER-initiated calls: client-side navigation RPCs
 * and the admin action buttons (these carry real browser headers and work).
 */
import { createServerFn } from "@tanstack/react-start";
import {
  exitImpersonation,
  impersonateBusiness,
  overrideAccountPlan,
  requirePlatformAdmin,
  setAccountDisabled,
} from "./admin";
import {
  adminAccountsPage,
  adminAccountDetailPage,
  adminAuditPage,
  adminErrorToResult,
  adminGate,
  adminHealthPage,
  adminImpersonationState,
  stripeConfiguredBool,
  type AdminAccountDetailView,
  type AdminAccountsPage,
  type AdminAuditView,
  type AdminHealthView,
  type AdminResult,
} from "./adminReads";

// Re-exported for the route files, which import these types from here.
export type { AdminAccountView, AdminAccountDetailView, AdminAuditView, AdminHealthView } from "./adminReads";
export type { AdminResult } from "./adminReads";

// ---------------------------------------------------------------------------
// Impersonation state (banner) — readable by any signed-in session
// ---------------------------------------------------------------------------

/** The app shell calls this to decide whether to render the admin banner. */
export const getImpersonationStateFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ReturnType<typeof adminImpersonationState>> => {
    return adminImpersonationState();
  },
);
export type { ImpersonationState } from "./admin";

/** Exit view-as. Audited; restores the admin's own session. */
export const exitImpersonationFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<AdminResult<{ ok: true }>> => {
    try {
      const stashed = await adminImpersonationState();
      if (!stashed.active || !stashed.adminUserId) {
        return { ok: false, status: 404, error: "Not currently impersonating." };
      }
      const res = await exitImpersonation();
      if (!res.ok) return { ok: false, status: 404, error: res.error };
      return { ok: true, data: { ok: true } };
      // eslint-disable-next-line no-useless-return
    } catch (e) {
      return adminErrorToResult(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Route gate — browser-side navigation RPC. The /admin beforeLoad calls the
// PLAIN adminGate() from ./adminReads during SSR; this wrapper remains for
// client-side navigation so the route module never imports a plain server
// module into the browser bundle (import-protection-safe).
// ---------------------------------------------------------------------------

/** Runs requirePlatformAdmin() server-side; reports instead of throwing. */
export const platformAdminGateFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ReturnType<typeof adminGate>> => {
    return adminGate();
  },
);

// ---------------------------------------------------------------------------
// Accounts list + detail — RPC wrappers delegating to ./adminReads
// ---------------------------------------------------------------------------

/** Platform-wide accounts list with search + pagination. */
export const adminListAccountsFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => (d ?? {}) as { search?: string; page?: number })
  .handler(async ({ data }): Promise<AdminResult<AdminAccountsPage>> => {
    return adminAccountsPage(data);
  });

/** Account detail for the /admin/accounts/$businessId page. */
export const adminAccountDetailFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => d as { businessId?: string })
  .handler(async ({ data }): Promise<AdminResult<AdminAccountDetailView>> => {
    return adminAccountDetailPage(typeof data?.businessId === "string" ? data.businessId : "");
  });

// ---------------------------------------------------------------------------
// Privileged write actions (browser-initiated — wrappers stay)
// ---------------------------------------------------------------------------

/** Disable / re-enable a customer account. Audited. */
export const adminSetAccountDisabledFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { businessId?: string; disabled?: boolean; reason?: string })
  .handler(async ({ data }): Promise<AdminResult<{ ok: true }>> => {
    try {
      const admin = await requirePlatformAdmin();
      const businessId = typeof data?.businessId === "string" ? data.businessId : "";
      if (!/^[0-9a-f-]{36}$/i.test(businessId)) {
        return { ok: false, status: 404, error: "Not found." };
      }
      const res = await setAccountDisabled(
        admin.user.id,
        businessId,
        data?.disabled === true,
        typeof data?.reason === "string" ? data.reason.slice(0, 500) : undefined,
      );
      if (!res.ok) return { ok: false, status: 404, error: res.error };
      return { ok: true, data: { ok: true } };
    } catch (e) {
      return adminErrorToResult(e);
    }
  });

/** Manual plan change outside Stripe. Audited + billing-event logged. */
export const adminOverridePlanFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { businessId?: string; plan?: string; reason?: string })
  .handler(async ({ data }): Promise<AdminResult<{ ok: true }>> => {
    try {
      const admin = await requirePlatformAdmin();
      const businessId = typeof data?.businessId === "string" ? data.businessId : "";
      const plan = data?.plan;
      if (!/^[0-9a-f-]{36}$/i.test(businessId) || (plan !== "trial" && plan !== "starter" && plan !== "pro")) {
        return { ok: false, status: 404, error: "Not found." };
      }
      const res = await overrideAccountPlan(
        admin.user.id,
        businessId,
        plan,
        typeof data?.reason === "string" ? data.reason.slice(0, 500) : undefined,
      );
      if (!res.ok) return { ok: false, status: 404, error: res.error };
      return { ok: true, data: { ok: true } };
    } catch (e) {
      return adminErrorToResult(e);
    }
  });

/** Start view-as. Audited. Returns the business name for the banner. */
export const adminImpersonateFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { businessId?: string })
  .handler(async ({ data }): Promise<AdminResult<{ ok: true; viewedBusinessName: string }>> => {
    try {
      const admin = await requirePlatformAdmin();
      const businessId = typeof data?.businessId === "string" ? data.businessId : "";
      if (!/^[0-9a-f-]{36}$/i.test(businessId)) {
        return { ok: false, status: 404, error: "Not found." };
      }
      const res = await impersonateBusiness(admin.user.id, businessId);
      if (!res.ok) return { ok: false, status: 404, error: "Not found." };
      return { ok: true, data: { ok: true, viewedBusinessName: res.viewedBusinessName } };
    } catch (e) {
      return adminErrorToResult(e);
    }
  });

// ---------------------------------------------------------------------------
// Audit log + system health pages — RPC wrappers delegating to ./adminReads
// ---------------------------------------------------------------------------

/** Newest-first audit log page, optional action filter. */
export const adminAuditLogFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => (d ?? {}) as { page?: number; action?: string })
  .handler(async ({ data }): Promise<AdminResult<{ entries: AdminAuditView[]; total: number; page: number; pageSize: number }>> => {
    return adminAuditPage(data);
  });

/** The system-health payload: funnel aggregate + webhooks + env status. */
export const adminHealthFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminResult<AdminHealthView>> => {
    return adminHealthPage();
  },
);

/** Kept for backwards compatibility with earlier imports of this helper. */
export { stripeConfiguredBool };

// ---------------------------------------------------------------------------
// P4-A: funnel view + runtime prompt editor (platform-admin only)
// ---------------------------------------------------------------------------

import {
  adminFunnelPage,
  adminPromptsPage,
  type P4AFunnelView,
  type P4APromptsView,
} from "./adminReads";
import { insertPromptVersion, activatePromptVersion } from "~/db/queries/prompts";
import { clearPromptOverrideCache } from "./promptOverrides";
import { isPromptSurface, validatePromptBody, validatePromptNote } from "~/lib/analytics/prompts";

/** The /admin/funnel loader read (browser-initiated RPC wrapper). */
export const adminFunnelDataFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminResult<P4AFunnelView>> => {
    return adminFunnelPage();
  },
);

/** The /admin/prompts loader read (browser-initiated RPC wrapper). */
export const adminPromptsDataFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminResult<P4APromptsView>> => {
    return adminPromptsPage();
  },
);

/** Save a NEW prompt overlay version (never edits history) and activate it. */
export const savePromptVersionFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { surface?: unknown; body?: unknown; note?: unknown })
  .handler(async ({ data }): Promise<AdminResult<{ version: number }>> => {
    try {
      const ctx = await requirePlatformAdmin();
      if (!isPromptSurface(data?.surface)) {
        return { ok: false, status: 400, error: "Unknown prompt surface." };
      }
      const body = validatePromptBody(data?.body);
      if (!body) return { ok: false, status: 400, error: "Prompt text must be 1-8000 characters." };
      const note = validatePromptNote(data?.note);
      const row = await insertPromptVersion(data.surface, body, {
        note,
        editedBy: ctx.user.email,
      });
      clearPromptOverrideCache(data.surface);
      return { ok: true, data: { version: row.version } };
    } catch (e) {
      return adminErrorToResult(e);
    }
  });

/** Revert to a prior version by flipping the active pointer (history kept). */
export const revertPromptVersionFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { surface?: unknown; version?: unknown })
  .handler(async ({ data }): Promise<AdminResult<{ version: number }>> => {
    try {
      await requirePlatformAdmin();
      if (!isPromptSurface(data?.surface)) {
        return { ok: false, status: 400, error: "Unknown prompt surface." };
      }
      const version = Math.floor(Number(data?.version));
      if (!Number.isFinite(version) || version < 1) {
        return { ok: false, status: 400, error: "Invalid version number." };
      }
      const row = await activatePromptVersion(data.surface, version);
      if (!row) return { ok: false, status: 404, error: "That version does not exist." };
      clearPromptOverrideCache(data.surface);
      return { ok: true, data: { version: row.version } };
    } catch (e) {
      return adminErrorToResult(e);
    }
  });
