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
 * In-app delivery is always on; provider channels (email/SMS) remain
 * provider-pending and are governed by businesses.settings prefs — no
 * provider calls happen here.
 */
import * as q from "~/db/queries";
import type { CreateLeadInput } from "~/db/queries/leads";
import type { Lead } from "~/db/schema";

/** Capture a lead AND record the new_lead in-app notification. */
export async function captureLead(businessId: string, input: CreateLeadInput): Promise<Lead> {
  const lead = await q.createLead(businessId, input);
  await q.createNotification(businessId, {
    type: "new_lead",
    payload: {
      leadId: lead.id,
      leadName: lead.contactName,
      serviceNeed: lead.serviceNeed,
      priority: lead.priority,
    },
  });
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
  await q.createNotification(businessId, {
    type: "appointment_requested",
    payload: {
      appointmentId: input.appointmentId,
      leadId: input.leadId ?? undefined,
      leadName: input.leadName ?? undefined,
      serviceNeed: input.serviceSummary,
      scheduledAt: input.scheduledAt.toISOString(),
    },
  });
}
