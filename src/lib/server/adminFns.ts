/**
 * Admin server functions (P3-G). Every fn funnels through
 * requirePlatformAdmin() — the platform-admin gate — before touching any
 * cross-business query. Results are client-safe shapes (dates as ISO
 * strings). Handler pattern matches appFns/authFns: return typed results,
 * never throw raw errors at the client.
 */
import { createServerFn } from "@tanstack/react-start";
import {
  exitImpersonation,
  getImpersonationState,
  impersonateBusiness,
  overrideAccountPlan,
  requirePlatformAdmin,
  setAccountDisabled,
  type ImpersonationState,
} from "./admin";
import { AuthError } from "./auth";
import {
  adminAggregateFunnelCounts,
  adminNotificationTypeCounts,
  countAdminAccounts,
  countAdminAudit,
  getAdminAccountDetail,
  listAdminAccounts,
  listAdminAudit,
  listRecentNotificationsForAdmin,
  listRecentStripeEvents,
} from "~/db/queries/admin";
import { getUsageForPeriod } from "~/db/queries/usage";
import { currentPeriodStart } from "./usage";
import { limitsForPlan } from "~/lib/pricing";
// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type AdminResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 401 | 403 | 404; error: string };

function adminErrorToResult(e: unknown): AdminResult<never> {
  if (e instanceof AuthError) {
    return { ok: false, status: e.kind === "unauthenticated" ? 401 : 404, error: e.message };
  }
  console.error("[admin] unexpected server error:", e);
  return { ok: false, status: 404, error: "Not found." };
}

const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------
// Impersonation state (banner) — readable by any signed-in session
// ---------------------------------------------------------------------------

/** The app shell calls this to decide whether to render the admin banner. */
export const getImpersonationStateFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ImpersonationState> => {
    return getImpersonationState();
  },
);
export type { ImpersonationState } from "./admin";

/** Exit view-as. Audited; restores the admin's own session. */
export const exitImpersonationFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<AdminResult<{ ok: true }>> => {
    try {
      const stashed = await getImpersonationState();
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
// Route gate — the /admin beforeLoad calls this via RPC so the route module
// never imports a plain server module (import-protection-safe).
// ---------------------------------------------------------------------------

export type PlatformAdminGateResult =
  | { ok: true }
  | { ok: false; kind: "unauthenticated" | "forbidden"; message: string };

/** Runs requirePlatformAdmin() server-side; reports instead of throwing. */
export const platformAdminGateFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<PlatformAdminGateResult> => {
    try {
      await requirePlatformAdmin();
      return { ok: true };
    } catch (e) {
      if (e instanceof AuthError) {
        return {
          ok: false,
          kind: e.kind === "unauthenticated" ? "unauthenticated" : "forbidden",
          message: e.message,
        };
      }
      console.error("[admin] gate error:", e);
      return { ok: false, kind: "forbidden", message: "Not found." };
    }
  },
);

// ---------------------------------------------------------------------------
// Accounts list + detail
// ---------------------------------------------------------------------------

export interface AdminAccountView {
  id: string;
  name: string;
  plan: string;
  subscriptionStatus: string | null;
  trialEndsAt: string | null;
  disabledAt: string | null;
  stripeConfigured: boolean;
  createdAt: string;
  lastActivityAt: string | null;
  userCount: number;
}

/** Platform-wide accounts list with search + pagination. */
export const adminListAccountsFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => (d ?? {}) as { search?: string; page?: number })
  .handler(async ({ data }): Promise<AdminResult<{
    accounts: AdminAccountView[];
    total: number;
    page: number;
    pageSize: number;
    stripeConfigured: boolean;
  }>> => {
    try {
      await requirePlatformAdmin();
      const pageSize = 20;
      const page = Math.max(1, Math.min(1000, Math.floor(Number(data?.page ?? 1)) || 1));
      const search = typeof data?.search === "string" ? data.search.slice(0, 120) : "";
      const [rows, total] = await Promise.all([
        listAdminAccounts({ search: search || undefined, limit: pageSize, offset: (page - 1) * pageSize }),
        countAdminAccounts(search || undefined),
      ]);
      return {
        ok: true,
        data: {
          accounts: rows.map((r) => ({
            id: r.business.id,
            name: r.business.name,
            plan: r.business.plan,
            subscriptionStatus: r.business.subscriptionStatus,
            trialEndsAt: isoOrNull(r.business.trialEndsAt),
            disabledAt: isoOrNull(r.business.disabledAt ?? null),
            stripeConfigured: stripeConfiguredBool(),
            createdAt: r.business.createdAt.toISOString(),
            lastActivityAt: isoOrNull(r.lastActivityAt),
            userCount: r.userCount,
          })),
          total,
          page,
          pageSize,
          stripeConfigured: stripeConfiguredBool(),
        },
      };
    } catch (e) {
      return adminErrorToResult(e);
    }
  });

export interface AdminAccountDetailView extends AdminAccountView {
  users: { id: string; email: string; fullName: string; role: string; isActive: boolean; emailVerified: boolean; lastLoginAt: string | null }[];
  counts: { leads: number; calls: number; conversations: number; appointments: number; users: number; notifications: number };
  usage: { periodStart: string; smsSent: number; aiTurns: number; callsHandled: number; limits: { sms: number; aiTurns: number; calls: number } | null };
  revenue: { allTimeCents: number; weekCents: number; monthCents: number; wonLeads: number; missedCalls: number; recovered: number } | null;
  recentNotifications: { id: string; type: string; readAt: string | null; createdAt: string; payloadJson: string }[];
  planOverrideNote: string;
}

/**
 * Account detail: subscription, usage vs limits, revenue recovered (the
 * standard revenue queries with the target businessId override), counts,
 * recent notifications, plus the action payloads (users list for
 * impersonation context).
 */
export const adminAccountDetailFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => d as { businessId?: string })
  .handler(async ({ data }): Promise<AdminResult<AdminAccountDetailView>> => {
    try {
      await requirePlatformAdmin();
      const businessId = typeof data?.businessId === "string" ? data.businessId : "";
      if (!/^[0-9a-f-]{36}$/i.test(businessId)) {
        return { ok: false, status: 404, error: "Not found." };
      }
      const detail = await getAdminAccountDetail(businessId);
      if (!detail) return { ok: false, status: 404, error: "Not found." };
      const b = detail.business;
      const [usageRow, revenue, recovery, recentNotifications] = await Promise.all([
        getUsageForPeriod(businessId, currentPeriodStart(b.trialEndsAt ?? b.createdAt, new Date())),
        // Reuse the business-scoped revenue queries with an explicit id —
        // they filter on the parameter, so passing the admin-chosen id is
        // the documented cross-business override (gated above).
        import("~/db/queries/revenue").then((m) => m.revenueMetrics(businessId, b.timezone)),
        import("~/db/queries/revenue").then((m) => m.missedCallRecoveryCounts(businessId)),
        listRecentNotificationsForAdmin({ businessId, limit: 8 }),
      ]);
      const limits = limitsForPlan(b.plan);
      return {
        ok: true,
        data: {
          id: b.id,
          name: b.name,
          plan: b.plan,
          subscriptionStatus: b.subscriptionStatus,
          trialEndsAt: isoOrNull(b.trialEndsAt),
          disabledAt: isoOrNull(b.disabledAt ?? null),
          stripeConfigured: stripeConfiguredBool(),
          createdAt: b.createdAt.toISOString(),
          lastActivityAt: null,
          userCount: detail.counts.users,
          users: detail.users.map((u) => ({
            id: u.id,
            email: u.email,
            fullName: u.fullName,
            role: u.role,
            isActive: u.isActive,
            emailVerified: u.emailVerified,
            lastLoginAt: isoOrNull(u.lastLoginAt),
          })),
          counts: detail.counts,
          usage: {
            periodStart: currentPeriodStart(b.trialEndsAt ?? b.createdAt, new Date()).toISOString(),
            smsSent: usageRow?.smsSent ?? 0,
            aiTurns: usageRow?.aiTurns ?? 0,
            callsHandled: usageRow?.callsHandled ?? 0,
            limits: {
              sms: limits.sms_per_month,
              aiTurns: limits.ai_turns_per_month,
              calls: limits.calls_per_month,
            },
          },
          revenue: revenue
            ? {
                allTimeCents: revenue.allTime.recoveredCents,
                weekCents: revenue.week.recoveredCents,
                monthCents: revenue.month.recoveredCents,
                wonLeads: revenue.allTime.wonLeads,
                missedCalls: recovery.missedCalls,
                recovered: recovery.recovered,
              }
            : null,
          recentNotifications: recentNotifications.map((n) => ({
            id: n.id,
            type: n.type,
            readAt: isoOrNull(n.readAt),
            createdAt: n.createdAt.toISOString(),
            payloadJson: JSON.stringify(n.payload ?? {}),
          })),
          planOverrideNote: "manual override (Stripe not configured)",
        },
      };
    } catch (e) {
      return adminErrorToResult(e);
    }
  });

// ---------------------------------------------------------------------------
// Privileged write actions
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
// Audit log page
// ---------------------------------------------------------------------------

export interface AdminAuditView {
  id: string;
  action: string;
  adminEmail: string | null;
  targetBusinessId: string | null;
  detailJson: string;
  createdAt: string;
}

/** Newest-first audit log page, optional action filter. */
export const adminAuditLogFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => (d ?? {}) as { page?: number; action?: string })
  .handler(async ({ data }): Promise<AdminResult<{ entries: AdminAuditView[]; total: number; page: number; pageSize: number }>> => {
    try {
      await requirePlatformAdmin();
      const pageSize = 50;
      const page = Math.max(1, Math.min(1000, Math.floor(Number(data?.page ?? 1)) || 1));
      const action = data?.action === "impersonate_start" || data?.action === "impersonate_stop" ||
        data?.action === "account_disable" || data?.action === "account_enable" || data?.action === "plan_override"
        ? data.action
        : null;
      const [entries, total] = await Promise.all([
        listAdminAudit({ limit: pageSize, offset: (page - 1) * pageSize, action }),
        countAdminAudit(action),
      ]);
      // Admin emails join in one extra query to keep the log self-describing.
      const adminIds = [...new Set(entries.map((e) => e.adminUserId))];
      const db = (await import("~/db/queries/shared")).sql();
      const userRows = adminIds.length
        ? await db`SELECT id, email FROM users WHERE id = ANY(${adminIds}::uuid[])`
        : [];
      const emailById = new Map(
        (userRows as unknown as { id: string; email: string }[]).map((r) => [r.id, r.email]),
      );
      return {
        ok: true,
        data: {
          entries: entries.map((e) => ({
            id: e.id,
            action: e.action,
            adminEmail: emailById.get(e.adminUserId) ?? null,
            targetBusinessId: e.targetBusinessId,
            detailJson: JSON.stringify(e.detail ?? {}),
            createdAt: e.createdAt.toISOString(),
          })),
          total,
          page,
          pageSize,
        },
      };
    } catch (e) {
      return adminErrorToResult(e);
    }
  });

// ---------------------------------------------------------------------------
// System health page
// ---------------------------------------------------------------------------

export interface IntegrationStatus {
  key: string;
  label: string;
  configured: boolean;
  envKeys: string[];
  note: string;
}

/** Honest integration status straight from env presence — no probing. */
export function integrationStatuses(): IntegrationStatus[] {
  return [
    {
      key: "stripe",
      label: "Stripe billing",
      configured: Boolean(process.env.STRIPE_SECRET_KEY),
      envKeys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
      note: "Checkout runs on Stripe-hosted pages; keys dormant until the owner connects them.",
    },
    {
      key: "twilio-sms",
      label: "Twilio SMS",
      configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_SMS_NUMBER),
      envKeys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_SMS_NUMBER"],
      note: "Missed-call text-back + AI replies; A2P registration gates real delivery.",
    },
    {
      key: "twilio-voice",
      label: "Twilio Voice",
      configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      envKeys: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
      note: "AI receptionist webhook is code-ready; live calling needs the Twilio number.",
    },
    {
      key: "llm",
      label: "LLM classification",
      configured: Boolean(process.env.LLM_API_KEY),
      envKeys: ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"],
      note: "Rules engine is the always-on fallback when the LLM key is absent.",
    },
    {
      key: "email",
      label: "Outbound email",
      configured: Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM),
      envKeys: ["EMAIL_API_KEY", "EMAIL_FROM"],
      note: "Delivery is stubbed to server logs until the provider keys land.",
    },
  ];
}

export interface AdminHealthView {
  funnel: { key: string; label: string; count: number }[];
  notificationsByType: Record<string, number>;
  stripeEvents: { id: string; type: string; receivedAt: string; processed: boolean }[];
  stripeUnprocessedCount: number;
  integrations: IntegrationStatus[];
  totals: { businesses: number; users: number };
}

/** The system-health payload: funnel aggregate + webhooks + env status. */
export const adminHealthFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AdminResult<AdminHealthView>> => {
    try {
      await requirePlatformAdmin();
      const [funnel, notificationsByType, stripeEvents] = await Promise.all([
        adminAggregateFunnelCounts(),
        adminNotificationTypeCounts(),
        listRecentStripeEvents(20),
      ]);
      const db = (await import("~/db/queries/shared")).sql();
      const totalsRows = await db`
        SELECT
          (SELECT count(*) FROM businesses) AS businesses,
          (SELECT count(*) FROM users) AS users`;
      const t = totalsRows[0] as unknown as Record<string, unknown>;
      return {
        ok: true,
        data: {
          funnel: [
            { key: "callsReceived", label: "Calls received" },
            { key: "callsHandledByAi", label: "Handled by AI" },
            { key: "missedCalls", label: "Missed calls captured" },
            { key: "missedCallsRecovered", label: "Recovered by text-back" },
            { key: "leads", label: "Leads (all sources)" },
            { key: "qualified", label: "Qualified" },
            { key: "appointments", label: "Appointments booked" },
            { key: "won", label: "Jobs won" },
          ].map((s) => ({ ...s, count: funnel[s.key as keyof typeof funnel] })),
          notificationsByType,
          stripeEvents: stripeEvents.map((e) => ({
            id: e.id,
            type: e.type,
            receivedAt: e.receivedAt.toISOString(),
            processed: e.processedAt != null,
          })),
          stripeUnprocessedCount: stripeEvents.filter((e) => e.processedAt == null).length,
          integrations: integrationStatuses(),
          totals: { businesses: Number(t.businesses ?? 0), users: Number(t.users ?? 0) },
        },
      };
    } catch (e) {
      return adminErrorToResult(e);
    }
  },
);

/** Small shared helper — Stripe env presence, the honest configured check. */
function stripeConfiguredBool(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}
