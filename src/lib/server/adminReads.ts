/**
 * Plain (non-RPC) admin server reads — the SSR-executed admin data paths.
 *
 * WHY THIS MODULE EXISTS (PR #26/#27 postmortem, prod-only 500s): the
 * TanStack Start compiler rewrites every `createServerFn` export into an RPC
 * stub — inside the SSR/server bundle too (`createSsrRpc("<id>")`, an HTTP
 * self-call to /_serverFn/<id>). A route loader or beforeLoad that calls a
 * server-fn wrapper during SSR therefore makes an HTTP request to the app's
 * own public origin, which travels back through the hosting proxy. That
 * round trip is unreliable behind the proxy (intermittent 503/403) and
 * surfaced as error pages on /admin/health and /admin/audit — and, being
 * per-request chance, occasionally on every other /admin page too. Dev never
 * shows it because the dev module graph calls the handler directly.
 *
 * Lesson (same as healthProbe.ts): route loaders execute on the server
 * during SSR — they must call PLAIN server functions from a module like this
 * one. The createServerFn wrappers in adminFns.ts stay for the calls the
 * BROWSER initiates (client-side navigation RPCs with real browser headers,
 * and the admin action buttons); those work and are untouched.
 *
 * Import-protection: this module is server-only (db + session code). Route
 * files import it ONLY inside `if (import.meta.env.SSR)` branches, which the
 * client build dead-code-eliminates — so it never reaches the browser bundle.
 *
 * Behavior contract: identical result shapes to the RPC wrappers (the RPC
 * handlers in adminFns.ts delegate here), so no page shows anything
 * different — only how the data is fetched during SSR changes.
 */
import {
  getImpersonationState,
  requirePlatformAdmin,
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
// P4-I: in-app error sink reads (platform-admin health view only).
import { countRecentSystemErrors, listRecentSystemErrors } from "~/db/queries/systemErrors";
import { getUsageForPeriod } from "~/db/queries/usage";
import { currentPeriodStart } from "./usage";
import { limitsForPlan } from "~/lib/pricing";
// P4-A: funnel counts + prompt version history (plain reads for /admin/funnel
// and /admin/prompts loaders).
import { funnelStageCounts } from "~/db/queries/funnel";
import { listPromptVersions } from "~/db/queries/prompts";
import { funnelSteps, overallConversion } from "~/lib/analytics/funnel";
import { PROMPT_SURFACES, PROMPT_SURFACE_LABELS, promptVersionView } from "~/lib/analytics/prompts";
// P5-6: business-metrics view (pure compute + cross-business SQL read).
import { adminMetricsRaw } from "~/db/queries/adminMetrics";
import {
  computeAdminMetrics,
  sanitizeAdminMetricsFilters,
  type AdminMetricsFilters,
  type AdminMetricsView,
} from "~/lib/server/adminMetrics";

// ---------------------------------------------------------------------------
// Shared result shapes (adminFns.ts re-exports these)
// ---------------------------------------------------------------------------

export type AdminResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: 400 | 401 | 403 | 404; error: string };

export function adminErrorToResult(e: unknown): AdminResult<never> {
  if (e instanceof AuthError) {
    return { ok: false, status: e.kind === "unauthenticated" ? 401 : 404, error: e.message };
  }
  console.error("[admin] unexpected server error:", e);
  return { ok: false, status: 404, error: "Not found." };
}

const isoOrNull = (d: Date | null): string | null => (d ? d.toISOString() : null);

// ---------------------------------------------------------------------------
// Gate + impersonation state (the /admin layout beforeLoad + loader)
// ---------------------------------------------------------------------------

export type PlatformAdminGateResult =
  | { ok: true }
  | { ok: false; kind: "unauthenticated" | "forbidden"; message: string };

/** Runs requirePlatformAdmin() directly; reports instead of throwing. */
export async function adminGate(): Promise<PlatformAdminGateResult> {
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
}

/** The /admin layout loader's impersonation state (banner data). */
export async function adminImpersonationState(): Promise<ImpersonationState> {
  return getImpersonationState();
}

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

/** Stripe env presence — the honest configured check (shared with adminFns). */
export function stripeConfiguredBool(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export interface AdminAccountsPage {
  accounts: AdminAccountView[];
  total: number;
  page: number;
  pageSize: number;
  stripeConfigured: boolean;
}

/** Platform-wide accounts list with search + pagination (plain, SSR-safe). */
export async function adminAccountsPage(data: {
  search?: string;
  page?: number;
}): Promise<AdminResult<AdminAccountsPage>> {
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
}

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
export async function adminAccountDetailPage(
  businessId: string,
): Promise<AdminResult<AdminAccountDetailView>> {
  try {
    await requirePlatformAdmin();
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
}

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

/** Newest-first audit log page, optional action filter (plain, SSR-safe). */
export async function adminAuditPage(data: {
  action?: string;
  page?: number;
}): Promise<AdminResult<{ entries: AdminAuditView[]; total: number; page: number; pageSize: number }>> {
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
}

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
  /** P4-I: recent rows from the in-app error sink (system_errors). */
  systemErrors: {
    id: string;
    source: string;
    severity: string;
    message: string;
    businessId: string | null;
    createdAt: string;
  }[];
  /** P4-I: system_errors rows in the trailing hour (readiness signal). */
  systemErrorCount1h: number;
}

/** The system-health payload: funnel aggregate + webhooks + env status. */
export async function adminHealthPage(): Promise<AdminResult<AdminHealthView>> {
  try {
    await requirePlatformAdmin();
    const [funnel, notificationsByType, stripeEvents, systemErrors, systemErrorCount1h] = await Promise.all([
      adminAggregateFunnelCounts(),
      adminNotificationTypeCounts(),
      listRecentStripeEvents(20),
      // P4-I: the in-app error sink — recent rows + trailing-hour count.
      listRecentSystemErrors(10).catch(() => []),
      countRecentSystemErrors(60).catch(() => 0),
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
        systemErrors: systemErrors.map((e) => ({
          id: e.id,
          source: e.source,
          severity: e.severity,
          message: e.message,
          businessId: e.businessId,
          // Coerce Date → string: React refuses to render Date objects.
          createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : String(e.createdAt),
        })),
        systemErrorCount1h,
      },
    };
  } catch (e) {
    return adminErrorToResult(e);
  }
}

// ---------------------------------------------------------------------------
// P4-A: signup→paid funnel + runtime prompt editor (plain reads)
// ---------------------------------------------------------------------------

/**
 * The visitor→paid funnel view for /admin/funnel. Real counts only
 * (businesses flagged is_demo are excluded from the primary series and
 * reported separately) — this page shows honest infrastructure zeros until
 * launch traffic arrives; it never invents numbers.
 */
export async function adminFunnelPage(): Promise<AdminResult<P4AFunnelView>> {
  try {
    await requirePlatformAdmin();
    const agg = await funnelStageCounts();
    const steps = funnelSteps(agg.real);
    return {
      ok: true,
      data: {
        steps,
        overallConversion: overallConversion(agg.real),
        totalBusinessesExDemo: Math.max(...steps.map((s) => s.count), 0),
        demoCount: agg.demoCount,
        allStages: agg.all,
      },
    };
  } catch (e) {
    return adminErrorToResult(e);
  }
}

export interface P4AFunnelView {
  steps: ReturnType<typeof funnelSteps>;
  overallConversion: number | null;
  /** Businesses at the first stage excluding demo — the funnel's true top. */
  totalBusinessesExDemo: number;
  demoCount: number;
  /** Per-stage counts including demo businesses (shown as a secondary note). */
  allStages: Record<string, number>;
}

export interface P4APromptsView {
  surfaces: {
    surface: "lead_capture" | "receptionist";
    label: string;
    activeVersion: number | null;
    versions: {
      id: string;
      version: number;
      body: string;
      note: string | null;
      editedBy: string | null;
      isActive: boolean;
      createdAt: string;
    }[];
  }[];
}

/** The /admin/prompts editor payload: full version history per surface. */
export async function adminPromptsPage(): Promise<AdminResult<P4APromptsView>> {
  try {
    await requirePlatformAdmin();
    const surfaces = await Promise.all(
      PROMPT_SURFACES.map(async (surface) => {
        const versions = (await listPromptVersions(surface)).map(promptVersionView);
        const active = versions.find((v) => v.isActive);
        return {
          surface,
          label: PROMPT_SURFACE_LABELS[surface],
          activeVersion: active?.version ?? null,
          versions,
        };
      }),
    );
    return { ok: true, data: { surfaces } };
  } catch (e) {
    return adminErrorToResult(e);
  }
}

// ---------------------------------------------------------------------------
// P5-6: business metrics page (read-only cross-business aggregates)
// ---------------------------------------------------------------------------

export type { AdminMetricsFilters, AdminMetricsView };

/**
 * The /admin/metrics payload: MRR, trial/paying account breakdown, trial→paid
 * conversion, plan distribution, calls processed, and the accounts-needing-
 * attention lists. READ-ONLY and gate-first, exactly like every other plain
 * read in this module. Filters arrive from route search params and are
 * whitelist-sanitized before they touch SQL.
 */
export async function adminMetricsPage(data: {
  plan?: string;
  window?: string;
}): Promise<AdminResult<AdminMetricsView>> {
  try {
    await requirePlatformAdmin();
    const filters = sanitizeAdminMetricsFilters(data);
    const now = new Date();
    const raw = await adminMetricsRaw(filters, now);
    return { ok: true, data: computeAdminMetrics(raw, filters, now) };
  } catch (e) {
    return adminErrorToResult(e);
  }
}
