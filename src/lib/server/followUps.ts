/**
 * Follow-up task creation hooks (P3-C).
 *
 * The two moments a follow-up task is born automatically:
 *   - lead capture            → 'lead_new', due next business day 9 AM
 *                               in the business's timezone (no scheduler:
 *                               the dashboard list IS the surface);
 *   - follow_up_needed flag   → 'status_follow_up', due tomorrow 9 AM,
 *                               carrying the business's note.
 *
 * Best-effort by the same contract as notifications: a failed task insert is
 * logged and NEVER fails the lead write that caused it (the lead row is the
 * durable record; the task is the reminder). Emergency-classified leads do
 * NOT get the follow_up_needed treatment — they stay in their current status
 * with emergency priority; escalation pages the shop (textBack.ts).
 *
 * Server-only: imports the query layer and the business settings.
 */
import * as q from "~/db/queries";
import type { Lead } from "~/db/schema";
import { nextBusinessDayAt9 } from "./crmValue";

export type FollowUpTaskOutcome = "created" | "skipped" | "failed";

export interface FollowUpTaskResult {
  outcome: FollowUpTaskOutcome;
  taskId: string | null;
}

/** Resolve the due date: next business day 9 AM business time; UTC fallback. */
async function resolveDueAt(businessId: string, now: Date) {
  const business = await q.getBusiness(businessId).catch(() => null);
  const due = nextBusinessDayAt9(now, business?.timezone ?? null);
  // Honest fallback when the timezone is unreadable: tomorrow 09:00 UTC.
  return due ?? new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Auto-create the capture follow-up ('lead_new') for a freshly created lead.
 * Called from every lead-capture path (notify.captureLead and the text-back
 * flow) so no new lead ever lands without a callback reminder.
 */
export async function maybeCreateFollowUpTaskForNewLead(
  businessId: string,
  lead: Lead,
  now: Date = new Date(),
): Promise<FollowUpTaskResult> {
  try {
    const dueAt = await resolveDueAt(businessId, now);
    const task = await q.createFollowUpTask(businessId, {
      leadId: lead.id,
      dueAt,
      createdReason: "lead_new",
      note: null,
    });
    return { outcome: "created", taskId: task.id };
  } catch (err) {
    console.log("[followups] auto-create failed for lead " + lead.id + ": " + String(err));
    return { outcome: "failed", taskId: null };
  }
}

/**
 * Create the follow-up task for a lead moved to follow_up_needed
 * ('status_follow_up'). `note` is the business's own instruction (nullable).
 */
export async function maybeCreateFollowUpTaskForTransition(
  businessId: string,
  lead: Lead,
  note: string | null,
  now: Date = new Date(),
): Promise<FollowUpTaskResult> {
  try {
    const dueAt = await resolveDueAt(businessId, now);
    const task = await q.createFollowUpTask(businessId, {
      leadId: lead.id,
      dueAt,
      createdReason: "status_follow_up",
      note,
    });
    return { outcome: "created", taskId: task.id };
  } catch (err) {
    console.log("[followups] status-follow-up create failed for lead " + lead.id + ": " + String(err));
    return { outcome: "failed", taskId: null };
  }
}
