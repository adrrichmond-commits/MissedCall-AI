/**
 * Notification helpers for the lead-capture and appointment-request paths
 * (Phase 2 build #3). The confirm/decline/booked events are wired directly
 * inside appFns; these wrappers are the integration point for the AI
 * receptionist / text-back builds (build #4+), which capture new leads and
 * appointment requests programmatically:
 *
 *   import { captureLead } from "~/lib/server/notify";
 *   const lead = await captureLead(businessId, input); // + fires new_lead
 *
 * In-app delivery is always on. Since build #6, the business-critical types
 * (new_lead, appointment_requested) ALSO get a fire-and-forget email attempt
 * when the provider is configured (EMAIL_API_KEY / EMAIL_FROM) — see
 * emailDelivery.ts. The email never blocks or fails the in-app insert.
 */
import * as q from "~/db/queries";
import type { CreateLeadInput } from "~/db/queries/leads";
import type { Lead } from "~/db/schema";
import { notificationEmailStore, queueNotificationEmail } from "~/lib/server/emailDelivery";
import { maybeCreateFollowUpTaskForNewLead } from "~/lib/server/followUps";
/** Capture a lead AND record the new_lead in-app notification. */
export async function captureLead(businessId: string, input: CreateLeadInput): Promise<Lead> {
  const lead = await q.createLead(businessId, input);
  const payload = {
    leadId: lead.id,
    leadName: lead.contactName,
    serviceNeed: lead.serviceNeed,
    priority: lead.priority,
    estimatedJobValue: lead.estimatedJobValueHighCents ?? undefined,
  };
  const notification = await q.createNotification(businessId, {
    type: "new_lead",
    payload,
  });
  // Fire-and-forget email (no-op unless the provider is configured). Never
  // blocks or throws into the caller.
  queueNotificationEmail({
    businessId,
    notificationId: notification.id,
    type: "new_lead",
    payload,
    store: notificationEmailStore,
  });
  // P3-C: the capture follow-up task ('lead_new') — best-effort, never fails
  // the capture (the same contract as the notification above).
  await maybeCreateFollowUpTaskForNewLead(businessId, lead);
  return lead;
}
export interface AppointmentRequestInput {
  appointmentId: string;
  leadId?: string | null;
  leadName?: string | null;
  serviceSummary: string;
  scheduledAt: Date;
}
/** Record the appointment_requested in-app notification for an AI/customer booking. */
export async function notifyAppointmentRequested(
  businessId: string,
  input: AppointmentRequestInput,
): Promise<void> {
  const payload = {
    appointmentId: input.appointmentId,
    leadId: input.leadId ?? undefined,
    leadName: input.leadName ?? undefined,
    serviceNeed: input.serviceSummary,
    scheduledAt: input.scheduledAt.toISOString(),
  };
  const notification = await q.createNotification(businessId, {
    type: "appointment_requested",
    payload,
  });
  // Fire-and-forget email (no-op unless the provider is configured). Never
  // blocks or throws into the caller.
  queueNotificationEmail({
    businessId,
    notificationId: notification.id,
    type: "appointment_requested",
    payload,
    store: notificationEmailStore,
  });
}
