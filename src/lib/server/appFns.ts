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
import { requireActiveWrite, requireAuth } from "~/lib/server/auth.server";
import type { AuthContext } from "~/lib/server/auth";
import { authErrorToResult } from "~/lib/server/sessionFns";
import * as q from "~/db/queries";
import {
  LEAD_LIFECYCLE_STATUSES,
  LEAD_STATUS_LABELS,
  allowedNextStatuses,
  toLifecycleStatus,
} from "~/lib/server/leadLifecycle";
import { maybeCreateFollowUpTaskForTransition } from "~/lib/server/followUps";
import type { LeadStatus } from "~/db/schema";

const LEAD_STATUSES = LEAD_LIFECYCLE_STATUSES;
/** Legacy statuses still accepted from old clients/filters, mapped forward. */
const LEAD_LEGACY_STATUSES = ["booked", "completed"] as const;
const LEAD_SOURCES = ["missed_call", "web_form", "referral", "repeat_customer", "other"] as const;
const LEAD_PRIORITIES = ["emergency", "high", "normal"] as const;
/** Phase 2 appointment lifecycle (migration 006). */
const CONVERSATION_STATUSES = ["active", "awaiting_customer", "booked", "closed"] as const;

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  for (const a of allowed) if (a === value) return a;
  return undefined;
}

/** Accept legacy statuses too, normalizing to the 011 lifecycle. */
function pickLeadStatus(value: unknown): LeadStatus | undefined {
  const legacy = pickEnum(value, LEAD_LEGACY_STATUSES);
  if (legacy) return toLifecycleStatus(legacy) ?? undefined;
  return pickEnum(value, LEAD_STATUSES);
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
    /** Split of the upcoming metric: confirmed vs requested (migration 006). */
    confirmedAppointments: number;
    requestedAppointments: number;
    /** won / (won + lost) — a conversion proxy, not a promise. */
    conversionRate: number | null;
    /** Open (not won/lost) leads marked priority='emergency'. */
    emergencyLeads: number;
  };
  /** P3-C: open follow-up tasks — the callback queue (count + first rows). */
  followUps: FollowUpsData;
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
      // P3-C: the open follow-up queue (count + oldest-due rows), same shape
      // getFollowUpsFn returns — dashboard renders it inline.
      const followUpsRes = await (async (): Promise<FollowUpsData> => {
        const [tasks, openCount] = await Promise.all([
          q.listFollowUpTasks(businessId, { done: false }, { limit: 6, order: "asc" }),
          q.countFollowUpTasks(businessId, { done: false }),
        ]);
        return {
          openCount,
          tasks: tasks.map((t) => ({
            id: t.id,
            leadId: t.leadId,
            leadName: t.leadName,
            leadPhone: t.leadPhone,
            leadStatus: t.leadStatus,
            serviceNeed: t.serviceNeed,
            dueAt: iso(t.dueAt) ?? "",
            createdReason: t.createdReason,
            note: t.note,
          })),
        };
      })();
      const [newLeadsThisWeek, convoCounts, upcoming, upcomingConfirmed, upcomingRequested, leadStatusCounts, priorityCounts, recentLeads, recentAppointments] =
        await Promise.all([
          q.countLeadsCreatedSince(businessId, weekAgo),
          q.countConversationsByStatus(businessId),
          q.countUpcoming(businessId),
          q.countUpcomingByStatus(businessId, "confirmed"),
          q.countUpcomingByStatus(businessId, "requested"),
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
            confirmedAppointments: upcomingConfirmed,
            requestedAppointments: upcomingRequested,
            conversionRate:
              leadStatusCounts.won + leadStatusCounts.lost > 0
                ? leadStatusCounts.won / (leadStatusCounts.won + leadStatusCounts.lost)
                : null,
            emergencyLeads: priorityCounts.emergency,
          },
          followUps: followUpsRes,
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
    /** P3-C: KB-seeded typical job value range (nulls when no KB service matched). */
    estimatedJobValueLowCents: number | null;
    estimatedJobValueHighCents: number | null;
    createdAt: string;
    hasConversation: boolean;
    /** Migration 007: in_area / out_of_area / unknown (service-area check). */
    serviceAreaStatus: string;
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
        status: pickLeadStatus(data?.status),
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
            estimatedJobValueLowCents: l.estimatedJobValueLowCents,
            estimatedJobValueHighCents: l.estimatedJobValueHighCents,
            createdAt: iso(l.createdAt) ?? "",
            hasConversation: withConv.has(l.id),
            serviceAreaStatus: l.serviceAreaStatus,
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
  /** P3-C: KB-seeded typical job value range. */
  estimatedJobValueLowCents: number | null;
  estimatedJobValueHighCents: number | null;
  /** P3-C: the actual invoice amount stamped when the lead was won. */
  actualWonValueCents: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** Migration 007: in_area / out_of_area / unknown (service-area check). */
  serviceAreaStatus: string;
  /** P3-C: lifecycle statuses this lead may legally move to (UI select). */
  allowedStatuses: string[];
  followUps: {
    id: string;
    dueAt: string;
    done: boolean;
    doneAt: string | null;
    createdReason: string;
    note: string | null;
  }[];
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
      const followUps = await q.listFollowUpTasks(businessId, {}, { limit: 20, order: "asc" });
      const current = toLifecycleStatus(lead.status) ?? "new";
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
          estimatedJobValueLowCents: lead.estimatedJobValueLowCents,
          estimatedJobValueHighCents: lead.estimatedJobValueHighCents,
          actualWonValueCents: lead.actualWonValueCents,
          notes: lead.notes,
          createdAt: iso(lead.createdAt) ?? "",
          updatedAt: iso(lead.updatedAt) ?? "",
          serviceAreaStatus: lead.serviceAreaStatus,
          allowedStatuses: allowedNextStatuses(current),
          followUps: followUps
            .filter((t) => t.leadId === lead.id)
            .map((t) => ({
              id: t.id,
              dueAt: iso(t.dueAt) ?? "",
              done: t.done,
              doneAt: iso(t.doneAt),
              createdReason: t.createdReason,
              note: t.note,
            })),
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
 * Write: change a lead's lifecycle status (P3-C full lifecycle). Owner +
 * manager only (employee is read-only, matching the settings pattern); the
 * value is whitelisted against the migration-011 lifecycle, illegal
 * transitions (e.g. won → new) are rejected with a clear error, and the WHERE
 * clause is business-scoped, so a lead id from another business is a 404.
 *
 * P3-C behaviors:
 *   - won: captures actual_won_value_cents (optional; prefilled by the UI
 *     from the estimate) and fires the lead_booked notification;
 *   - follow_up_needed: auto-creates a 'status_follow_up' task carrying the
 *     business's note (best-effort, like notifications);
 *   - appointment confirmation automation lives in confirmAppointmentFn —
 *     won/lost are ALWAYS human calls, nothing auto-sets them.
 */
export const updateLeadStatusFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { leadId?: unknown; status?: unknown; note?: unknown; wonValueDollars?: unknown })
  .handler(
    async ({
      data,
    }): Promise<AppResult<{ leadId: string; status: string; convertedAt: string | null }>> => {
      try {
        const ctx: AuthContext = await requireActiveWrite("owner", "manager");
        const businessId = ctx.business.id;
        const leadId = typeof data?.leadId === "string" ? data.leadId.trim() : "";
        const status = pickLeadStatus(data?.status);
        if (!leadId) return { ok: false, status: 400, error: "Missing lead." };
        if (!status) {
          return {
            ok: false,
            status: 400,
            error:
              "Unknown status. Choose " +
              LEAD_STATUSES.map((s) => LEAD_STATUS_LABELS[s]).join(", ") +
              ".",
          };
        }
        const existing = await q.getLead(businessId, leadId);
        if (!existing) return { ok: false, status: 404, error: "Lead not found." };
        const note = typeof data?.note === "string" ? data.note.trim().slice(0, 500) : null;
        // P3-C: capture the actual won value when marking a job won. Accepted
        // as dollars (the unit a shop owner types), stored as integer cents.
        let wonValueCents: number | null = null;
        if (status === "won" && data?.wonValueDollars != null && data.wonValueDollars !== "") {
          const n = Number(data.wonValueDollars);
          if (!Number.isFinite(n) || n < 0) {
            return { ok: false, status: 400, error: "Won value must be a non-negative dollar amount." };
          }
          if (n > 1_000_000) {
            return { ok: false, status: 400, error: "Won value looks too large — check the amount." };
          }
          wonValueCents = Math.round(n * 100);
        }
        // Lifecycle legality (pure module): invalid transitions are rejected
        // with the reason — never written.
        const from = toLifecycleStatus(existing.status);
        if (!from) return { ok: false, status: 500, error: "Lead has an unknown stored status." };
        const transition = q.validateLeadTransition(existing.status, status);
        if (!transition.ok) return { ok: false, status: 400, error: transition.error ?? "Invalid status transition." };
        const updated = await q.updateLead(businessId, leadId, {
          status,
          ...(wonValueCents != null ? { actualWonValueCents: wonValueCents } : {}),
        });
        if (!updated) return { ok: false, status: 404, error: "Lead not found." };
        // Notification center (build #3): winning the job is a lead_booked
        // event for the whole shop. Never blocks the status change itself.
        if (updated.status === "won" && existing.status !== "won") {
          try {
            await q.createNotification(businessId, {
              type: "lead_booked",
              payload: {
                leadId: updated.id,
                leadName: updated.contactName,
                serviceNeed: updated.serviceNeed,
                priority: updated.priority,
                wonValueCents: updated.actualWonValueCents ?? undefined,
                pipelineValueCents: updated.pipelineValueCents ?? undefined,
              },
            });
          } catch {
            // Notification failure must not fail the business write.
          }
        }
        // P3-C: flagging follow_up_needed creates the callback task with the
        // business's note. Best-effort (same contract as notifications).
        if (updated.status === "follow_up_needed" && existing.status !== "follow_up_needed") {
          await maybeCreateFollowUpTaskForTransition(businessId, updated, note);
        }
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
// Won value (P3-C): update/correct the actual invoice amount on a won lead.
// Owner + manager, mirroring updateLeadStatusFn.
// ---------------------------------------------------------------------------
export const updateLeadWonValueFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { leadId?: unknown; wonValueDollars?: unknown })
  .handler(
    async ({ data }): Promise<AppResult<{ leadId: string; actualWonValueCents: number | null }>> => {
      try {
        const ctx: AuthContext = await requireActiveWrite("owner", "manager");
        const businessId = ctx.business.id;
        const leadId = typeof data?.leadId === "string" ? data.leadId.trim() : "";
        if (!leadId) return { ok: false, status: 400, error: "Missing lead." };
        const existing = await q.getLead(businessId, leadId);
        if (!existing) return { ok: false, status: 404, error: "Lead not found." };
        // Empty string clears the value; otherwise a non-negative dollar amount.
        let cents: number | null = null;
        const raw = data?.wonValueDollars;
        if (raw != null && raw !== "") {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) {
            return { ok: false, status: 400, error: "Won value must be a non-negative dollar amount." };
          }
          if (n > 1_000_000) {
            return { ok: false, status: 400, error: "Won value looks too large — check the amount." };
          }
          cents = Math.round(n * 100);
        }
        const updated = await q.updateLead(businessId, leadId, { actualWonValueCents: cents });
        if (!updated) return { ok: false, status: 404, error: "Lead not found." };
        return {
          ok: true,
          data: { leadId: updated.id, actualWonValueCents: updated.actualWonValueCents },
        };
      } catch (e) {
        return authErrorToResult(e);
      }
    },
  );

// ---------------------------------------------------------------------------
// Follow-up tasks (P3-C): the dashboard callback queue. The list IS the
// scheduler surface — no cron, no reminders worker.
// ---------------------------------------------------------------------------
export interface FollowUpsData {
  openCount: number;
  tasks: {
    id: string;
    leadId: string;
    leadName: string;
    leadPhone: string;
    leadStatus: string;
    serviceNeed: string;
    dueAt: string;
    createdReason: string;
    note: string | null;
  }[];
}

export const getFollowUpsFn = createServerFn({ method: "GET" })
  .validator((d: unknown) => d as { includeDone?: unknown; limit?: unknown })
  .handler(async ({ data }): Promise<AppResult<FollowUpsData>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const limit = Math.min(Math.max(Math.floor(Number(data?.limit)) || 15, 1), 50);
      const [tasks, openCount] = await Promise.all([
        q.listFollowUpTasks(businessId, { done: false }, { limit, order: "asc" }),
        q.countFollowUpTasks(businessId, { done: false }),
      ]);
      return {
        ok: true,
        data: {
          openCount,
          tasks: tasks.map((t) => ({
            id: t.id,
            leadId: t.leadId,
            leadName: t.leadName,
            leadPhone: t.leadPhone,
            leadStatus: t.leadStatus,
            serviceNeed: t.serviceNeed,
            dueAt: iso(t.dueAt) ?? "",
            createdReason: t.createdReason,
            note: t.note,
          })),
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  });

/** Mark a follow-up task done / reopen it. Owner + manager (a shop write). */
export const setFollowUpTaskDoneFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { taskId?: unknown; done?: unknown })
  .handler(
    async ({ data }): Promise<AppResult<{ taskId: string; done: boolean }>> => {
      try {
        const ctx: AuthContext = await requireActiveWrite("owner", "manager");
        const businessId = ctx.business.id;
        const taskId = typeof data?.taskId === "string" ? data.taskId.trim() : "";
        const done = data?.done === true;
        if (!taskId) return { ok: false, status: 400, error: "Missing task." };
        const task = await q.getFollowUpTask(businessId, taskId);
        if (!task) return { ok: false, status: 404, error: "Task not found." };
        const updated = await q.setFollowUpTaskDone(businessId, taskId, done);
        if (!updated) return { ok: false, status: 404, error: "Task not found." };
        return { ok: true, data: { taskId: updated.id, done: updated.done } };
      } catch (e) {
        return authErrorToResult(e);
      }
    },
  );

// ---------------------------------------------------------------------------
// Appointment requests (migration 006): the business confirms or declines a
// REQUESTED booking. Owner + manager only, mirroring updateLeadStatusFn;
// writes go through requireActiveWrite so an expired trial blocks them.
// ---------------------------------------------------------------------------
export const confirmAppointmentFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { appointmentId?: unknown })
  .handler(
    async ({ data }): Promise<AppResult<{ appointmentId: string; status: string }>> => {
      try {
        const ctx = await requireActiveWrite("owner", "manager");
        const businessId = ctx.business.id;
        const appointmentId =
          typeof data?.appointmentId === "string" ? data.appointmentId.trim() : "";
        if (!appointmentId) return { ok: false, status: 400, error: "Missing appointment." };
        const existing = await q.getAppointment(businessId, appointmentId);
        if (!existing) return { ok: false, status: 404, error: "Appointment not found." };
        if (existing.status !== "requested" && existing.status !== "declined") {
          return {
            ok: false,
            status: 400,
            error: "Only requested appointments can be confirmed.",
          };
        }
        const updated = await q.setAppointmentStatus(businessId, appointmentId, "confirmed");
        if (!updated) return { ok: false, status: 404, error: "Appointment not found." };
        // P3-C status automation (light): a CONFIRMED appointment means the
        // job is on the books — move the linked lead to
        // appointment_scheduled automatically when the lead is still live
        // (never from won/lost; those are human calls). Best-effort.
        if (updated.leadId) {
          try {
            const lead = await q.getLead(businessId, updated.leadId);
            if (lead) {
              const from = toLifecycleStatus(lead.status);
              const legal =
                from != null &&
                q.validateLeadTransition(lead.status, "appointment_scheduled").ok;
              if (from !== "appointment_scheduled" && legal) {
                await q.updateLead(businessId, lead.id, { status: "appointment_scheduled" });
              }
            }
          } catch {
            // Automation failure must not fail the confirmation.
          }
        }
        // Notification center (build #3): confirmations are shop-visible
        // events (owner sees what a manager confirmed). Never blocks the write.
        try {
          const lead = updated.leadId ? await q.getLead(businessId, updated.leadId) : null;
          await q.createNotification(businessId, {
            type: "appointment_confirmed",
            payload: {
              appointmentId: updated.id,
              leadId: updated.leadId ?? undefined,
              leadName: lead?.contactName ?? undefined,
              serviceNeed: updated.serviceSummary,
              scheduledAt: updated.scheduledAt.toISOString(),
            },
          });
        } catch {
          // Notification failure must not fail the business write.
        }
        return { ok: true, data: { appointmentId: updated.id, status: updated.status } };
      } catch (e) {
        return authErrorToResult(e);
      }
    },
  );

export const declineAppointmentFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { appointmentId?: unknown })
  .handler(
    async ({ data }): Promise<AppResult<{ appointmentId: string; status: string }>> => {
      try {
        const ctx = await requireActiveWrite("owner", "manager");
        const businessId = ctx.business.id;
        const appointmentId =
          typeof data?.appointmentId === "string" ? data.appointmentId.trim() : "";
        if (!appointmentId) return { ok: false, status: 400, error: "Missing appointment." };
        const existing = await q.getAppointment(businessId, appointmentId);
        if (!existing) return { ok: false, status: 404, error: "Appointment not found." };
        if (existing.status !== "requested") {
          return {
            ok: false,
            status: 400,
            error: "Only requested appointments can be declined.",
          };
        }
        const updated = await q.setAppointmentStatus(businessId, appointmentId, "declined");
        if (!updated) return { ok: false, status: 404, error: "Appointment not found." };
        // Notification center (build #3). Never blocks the write.
        try {
          const lead = updated.leadId ? await q.getLead(businessId, updated.leadId) : null;
          await q.createNotification(businessId, {
            type: "appointment_declined",
            payload: {
              appointmentId: updated.id,
              leadId: updated.leadId ?? undefined,
              leadName: lead?.contactName ?? undefined,
              serviceNeed: updated.serviceSummary,
              scheduledAt: updated.scheduledAt.toISOString(),
            },
          });
        } catch {
          // Notification failure must not fail the business write.
        }
        return { ok: true, data: { appointmentId: updated.id, status: updated.status } };
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
