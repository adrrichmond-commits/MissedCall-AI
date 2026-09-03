/**
 * Read-only server functions for the authenticated app pages (dashboard,
 * leads, inbox, appointments, analytics).
 *
 * EVERY handler resolves businessId from the authenticated session
 * (requireAuth) — never from client input — and passes it down to the
 * business-scoped query layer, whose WHERE clauses are the isolation
 * boundary. Client inputs are whitelisted/validated before reaching the
 * queries; Dates are coerced to ISO strings before crossing the wire.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAuth, requireRole } from "~/lib/server/auth.server";
import type { AuthContext } from "~/lib/server/auth";
import { authErrorToResult } from "~/lib/server/sessionFns";
import * as q from "~/db/queries";

const LEAD_STATUSES = ["new", "contacted", "booked", "completed", "lost"] as const;
const LEAD_SOURCES = ["missed_call", "web_form", "referral", "repeat_customer", "other"] as const;
const LEAD_PRIORITIES = ["emergency", "high", "normal"] as const;
const CONVERSATION_STATUSES = ["active", "awaiting_customer", "booked", "closed"] as const;

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  for (const a of allowed) if (a === value) return a;
  return undefined;
}

function pageParams(raw: { page?: unknown; perPage?: unknown }) {
  const page = Math.max(1, Math.floor(Number(raw.page) || 1));
  const perPage = Math.min(50, Math.max(5, Math.floor(Number(raw.perPage) || 10)));
  return { page, perPage, offset: (page - 1) * perPage };
}

function pickSearch(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().slice(0, 80);
  return s.length > 0 ? s : undefined;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

export type AppResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardData {
  metrics: {
    newLeadsThisWeek: number;
    openConversations: number;
    upcomingAppointments: number;
    /** won / (won + lost) — a conversion proxy, not a promise. */
    conversionRate: number | null;
    /** Open (not booked/completed/lost) leads marked priority='emergency'. */
    emergencyLeads: number;
  };
  recentLeads: {
    id: string;
    contactName: string;
    contactPhone: string;
    serviceNeed: string;
    urgency: string;
    priority: string;
    status: string;
    source: string;
    createdAt: string;
    hasConversation: boolean;
  }[];
  recentAppointments: {
    id: string;
    serviceSummary: string;
    technicianName: string | null;
    scheduledAt: string;
    status: string;
  }[];
}

export const getDashboardDataFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AppResult<DashboardData>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [newLeadsThisWeek, convoCounts, upcoming, leadStatusCounts, priorityCounts, recentLeads, recentAppointments] =
        await Promise.all([
          q.countLeadsCreatedSince(businessId, weekAgo),
          q.countConversationsByStatus(businessId),
          q.countUpcoming(businessId),
          q.countLeadsByStatus(businessId),
          q.countLeadsByPriority(businessId),
          q.listLeads(businessId, {}, { limit: 6, order: "desc" }),
          q.listAppointments(businessId, {}, { limit: 5, order: "asc" }),
        ]);
      const withConv = await q.leadIdsWithConversations(businessId, recentLeads.map((l) => l.id));
      return {
        ok: true,
        data: {
          metrics: {
            newLeadsThisWeek,
            openConversations: convoCounts.active + convoCounts.awaiting_customer,
            upcomingAppointments: upcoming,
            conversionRate:
              leadStatusCounts.completed + leadStatusCounts.lost > 0
                ? leadStatusCounts.completed / (leadStatusCounts.completed + leadStatusCounts.lost)
                : null,
            emergencyLeads: priorityCounts.emergency,
          },
          recentLeads: recentLeads.map((l) => ({
            id: l.id,
            contactName: l.contactName,
            contactPhone: l.contactPhone,
            serviceNeed: l.serviceNeed,
            urgency: l.urgency,
            priority: l.priority,
            status: l.status,
            source: l.source,
            createdAt: iso(l.createdAt) ?? "",
            hasConversation: withConv.has(l.id),
          })),
          recentAppointments: recentAppointments.map((a) => ({
            id: a.id,
            serviceSummary: a.serviceSummary,
            technicianName: a.technicianName,
            scheduledAt: iso(a.scheduledAt) ?? "",
            status: a.status,
          })),
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Leads (filterable list + detail)
// ---------------------------------------------------------------------------

export interface LeadsPageData {
  leads: {
    id: string;
    contactName: string;
    contactPhone: string;
    serviceNeed: string;
    urgency: string;
    priority: string;
    status: string;
    source: string;
    estimatedValueCents: number | null;
    createdAt: string;
    hasConversation: boolean;
  }[];
  total: number;
  page: number;
  perPage: number;
}

export const getLeadsFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => d as { status?: unknown; source?: unknown; priority?: unknown; search?: unknown; page?: unknown })
  .handler(async ({ data }): Promise<AppResult<LeadsPageData>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const { page, perPage, offset } = pageParams(data ?? {});
      const filters = {
        status: pickEnum(data?.status, LEAD_STATUSES),
        source: pickEnum(data?.source, LEAD_SOURCES),
        priority: pickEnum(data?.priority, LEAD_PRIORITIES),
        search: pickSearch(data?.search),
      };
      const leads = await q.listLeads(businessId, filters, { limit: perPage, offset, order: "desc" });
      const [total, withConv] = await Promise.all([
        q.countLeads(businessId, filters),
        q.leadIdsWithConversations(businessId, leads.map((l) => l.id)),
      ]);
      return {
        ok: true,
        data: {
          total,
          page,
          perPage,
          leads: leads.map((l) => ({
            id: l.id,
            contactName: l.contactName,
            contactPhone: l.contactPhone,
            serviceNeed: l.serviceNeed,
            urgency: l.urgency,
            priority: l.priority,
            status: l.status,
            source: l.source,
            estimatedValueCents: l.estimatedValueCents,
            createdAt: iso(l.createdAt) ?? "",
            hasConversation: withConv.has(l.id),
          })),
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  });

export interface LeadDetailData {
  id: string;
  source: string;
  status: string;
  priority: string;
  serviceNeed: string;
  urgency: string;
  /** True when the viewer's role may change the lifecycle status. */
  canEditStatus: boolean;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  contactAddress: string | null;
  description: string | null;
  estimatedValueCents: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  conversations: {
    id: string;
    status: string;
    summary: string | null;
    messageCount: number;
    lastMessageAt: string | null;
  }[];
}

export const getLeadFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => d as { leadId?: unknown })
  .handler(async ({ data }): Promise<AppResult<LeadDetailData>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const leadId = typeof data?.leadId === "string" ? data.leadId : "";
      const lead = await q.getLead(businessId, leadId);
      if (!lead) return { ok: false, status: 404, error: "Lead not found." };
      const summaries = await q.conversationSummariesForLead(businessId, lead.id);
      return {
        ok: true,
        data: {
          id: lead.id,
          source: lead.source,
          status: lead.status,
          priority: lead.priority,
          serviceNeed: lead.serviceNeed,
          urgency: lead.urgency,
          canEditStatus: ctx.role === "owner" || ctx.role === "manager",
          contactName: lead.contactName,
          contactPhone: lead.contactPhone,
          contactEmail: lead.contactEmail,
          contactAddress: lead.contactAddress,
          description: lead.description,
          estimatedValueCents: lead.estimatedValueCents,
          notes: lead.notes,
          createdAt: iso(lead.createdAt) ?? "",
          updatedAt: iso(lead.updatedAt) ?? "",
          conversations: summaries.map((c) => ({
            id: c.id,
            status: c.status,
            summary: c.summary,
            messageCount: c.messageCount,
            lastMessageAt: iso(c.lastMessageAt),
          })),
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  });

/**
 * Write: change a lead's lifecycle status. Owner + manager only (employee is
 * read-only, matching the settings pattern); the value is whitelisted against
 * the Phase 2 lifecycle and the WHERE clause is business-scoped, so a lead id
 * from another business is a 404.
 */
export const updateLeadStatusFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { leadId?: unknown; status?: unknown })
  .handler(
    async ({
      data,
    }): Promise<AppResult<{ leadId: string; status: string; convertedAt: string | null }>> => {
      try {
        const ctx: AuthContext = await requireRole("owner", "manager");
        const businessId = ctx.business.id;
        const leadId = typeof data?.leadId === "string" ? data.leadId.trim() : "";
        const status = pickEnum(data?.status, LEAD_STATUSES);
        if (!leadId) return { ok: false, status: 400, error: "Missing lead." };
        if (!status) {
          return {
            ok: false,
            status: 400,
            error: "Unknown status. Choose new, contacted, booked, completed, or lost.",
          };
        }
        const existing = await q.getLead(businessId, leadId);
        if (!existing) return { ok: false, status: 404, error: "Lead not found." };
        const updated = await q.updateLead(businessId, leadId, { status });
        if (!updated) return { ok: false, status: 404, error: "Lead not found." };
        return {
          ok: true,
          data: {
            leadId: updated.id,
            status: updated.status,
            convertedAt: updated.convertedAt ? updated.convertedAt.toISOString() : null,
          },
        };
      } catch (e) {
        return authErrorToResult(e);
      }
    },
  );

// ---------------------------------------------------------------------------
// Inbox (conversation list + thread)
// ---------------------------------------------------------------------------

export interface InboxListData {
  conversations: {
    id: string;
    status: string;
    summary: string | null;
    customerPhone: string;
    leadName: string | null;
    serviceNeed: string | null;
    lastMessageBody: string | null;
    lastMessageDirection: string | null;
    lastMessageAt: string | null;
    messageCount: number;
    leadId: string | null;
  }[];
  total: number;
}

export const getInboxListFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => d as { status?: unknown })
  .handler(async ({ data }): Promise<AppResult<InboxListData>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const status = pickEnum(data?.status, CONVERSATION_STATUSES);
      const rows = await q.listConversationsWithPreview(businessId, { status }, { limit: 50, order: "desc" });
      const total = await q.countConversations(businessId, { status });
      return {
        ok: true,
        data: {
          total,
          conversations: rows.map((c) => ({
            id: c.id,
            status: c.status,
            summary: c.summary,
            customerPhone: c.customerPhone,
            leadName: c.leadName,
            serviceNeed: c.serviceNeed,
            lastMessageBody: c.lastMessageBody,
            lastMessageDirection: c.lastMessageDirection,
            lastMessageAt: iso(c.lastMessageAtRaw),
            messageCount: Number(c.messageCount),
            leadId: c.leadId,
          })),
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  });

export interface InboxThreadData {
  conversation: {
    id: string;
    status: string;
    summary: string | null;
    customerPhone: string;
    leadName: string | null;
    serviceNeed: string | null;
    leadId: string | null;
  };
  messages: {
    id: string;
    direction: string;
    body: string;
    status: string;
    sentAt: string | null;
  }[];
}

export const getConversationThreadFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => d as { conversationId?: unknown })
  .handler(async ({ data }): Promise<AppResult<InboxThreadData>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const conversationId = typeof data?.conversationId === "string" ? data.conversationId : "";
      const conv = await q.getConversation(businessId, conversationId);
      if (!conv) return { ok: false, status: 404, error: "Conversation not found." };
      const lead = conv.leadId ? await q.getLead(businessId, conv.leadId) : null;
      const messages = await q.listMessages(businessId, conversationId, { limit: 200, order: "asc" });
      return {
        ok: true,
        data: {
          conversation: {
            id: conv.id,
            status: conv.status,
            summary: conv.summary,
            customerPhone: conv.customerPhone,
            leadName: lead?.contactName ?? null,
            serviceNeed: lead?.serviceNeed ?? null,
            leadId: conv.leadId,
          },
          messages: messages.map((m) => ({
            id: m.id,
            direction: m.direction,
            body: m.body,
            status: m.status,
            sentAt: iso(m.sentAt ?? m.createdAt),
          })),
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  });

// ---------------------------------------------------------------------------
// Appointments (upcoming vs past)
// ---------------------------------------------------------------------------

export interface AppointmentsPageData {
  upcoming: {
    id: string;
    serviceSummary: string;
    technicianName: string | null;
    scheduledAt: string;
    durationMinutes: number;
    status: string;
    address: string | null;
    notes: string | null;
    leadName: string | null;
    leadPhone: string | null;
  }[];
  past: {
    id: string;
    serviceSummary: string;
    technicianName: string | null;
    scheduledAt: string;
    durationMinutes: number;
    status: string;
    address: string | null;
    notes: string | null;
    leadName: string | null;
    leadPhone: string | null;
  }[];
}

function apptOut(a: q.AppointmentWithLead) {
  return {
    id: a.id,
    serviceSummary: a.serviceSummary,
    technicianName: a.technicianName,
    scheduledAt: iso(a.scheduledAt) ?? "",
    durationMinutes: a.durationMinutes,
    status: a.status,
    address: a.address,
    notes: a.notes,
    leadName: a.leadName,
    leadPhone: a.leadPhone,
  };
}

export const getAppointmentsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AppResult<AppointmentsPageData>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const now = new Date();
      const [upcoming, past] = await Promise.all([
        q.listAppointmentsWithLead(businessId, { from: now }, { limit: 50, order: "asc" }),
        q.listAppointmentsWithLead(businessId, { to: now }, { limit: 50, order: "desc" }),
      ]);
      return { ok: true, data: { upcoming: upcoming.map(apptOut), past: past.map(apptOut) } };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Analytics (honest aggregates over the business's own rows)
// ---------------------------------------------------------------------------

export interface AnalyticsData {
  leadsByStatus: Record<string, number>;
  leadsBySource: Record<string, number>;
  appointmentsByWeekday: number[];
  conversationsByStatus: Record<string, number>;
  totalLeads: number;
  totalMessages: number;
  openPipelineValueCents: number;
  /** Missed-call recovery funnel — real aggregates, never synthetic. */
  recovery: {
    /** Leads whose source is a captured missed call (all time). */
    missedCalls: number;
    /** Of those, leads that got a captured SMS conversation (recovered). */
    recovered: number;
    /** Of those, leads that were won (status booked/completed). */
    booked: number;
  };
}

export const getAnalyticsFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<AppResult<AnalyticsData>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const [leadsByStatus, leadsBySource, appointmentsByWeekday, conversationsByStatus, totalMessages, pipeline, recovery] =
        await Promise.all([
          q.countLeadsByStatus(businessId),
          q.countLeadsBySource(businessId),
          q.countAppointmentsByWeekday(businessId),
          q.countConversationsByStatus(businessId),
          q.countMessages(businessId),
          q.sumOpenPipelineValue(businessId),
          q.missedCallRecoveryStats(businessId),
        ]);
      const totalLeads = Object.values(leadsByStatus).reduce((a, b) => a + b, 0);
      return {
        ok: true,
        data: {
          leadsByStatus,
          leadsBySource,
          appointmentsByWeekday,
          conversationsByStatus,
          totalLeads,
          totalMessages,
          openPipelineValueCents: pipeline,
          recovery,
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);
