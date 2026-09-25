/**
 * Appointment booking core (P5-1 journey fix).
 *
 * WHY THIS EXISTS: before P5-1, `q.createAppointment` had NO production
 * caller — the appointments page could confirm/decline AI-requested slots
 * (seeded/demo data), but a real new business had no way to schedule an
 * appointment at all, so the owner journey "missed call → qualified lead →
 * booked job" dead-ended after the lead. This module is now the ONE booking
 * write path, shared by the lead-detail schedule form (via the
 * scheduleAppointmentFn server fn) and by tests.
 *
 * Session resolution, RBAC (owner/manager), and trial read-only gating stay
 * in the server-fn layer (requireActiveWrite) — this module is business-scoped
 * and takes the businessId exactly the way every other query caller does.
 *
 * Journey edge cases handled here (P5-1 definition of done):
 *   - duplicate submission: a double-click/double-POST of the same booking
 *     collapses onto the existing appointment (±15-minute, same-lead window)
 *     instead of creating a second row; the result is honestly flagged
 *     `duplicate: true`;
 *   - out-of-area requests: a definitive `out_of_area` classification (lead
 *     stamp or fresh classification of the job address against the business's
 *     service areas) is refused with a typed 422 until the owner explicitly
 *     confirms the exception — never silently booked, never silently dropped;
 *   - emergency requests: an emergency-priority lead books normally (status
 *     confirmed) and keeps its emergency stamp — the AI escalation already
 *     paged the owner; booking must never be blocked by it;
 *   - invalid input: strict server-side validation with client-safe messages.
 *
 * Side effects after a successful booking mirror confirmAppointmentFn exactly
 * (no parallel systems): the linked lead moves to appointment_scheduled when
 * that lifecycle edge is legal, an in-app appointment_confirmed notification
 * is created, and the customer confirmation text goes through the ONE
 * workflow engine (safeguarded, honest — never blocks the write).
 */
import { classifyServiceArea, extractZip, type ServiceAreaStatus } from "~/lib/serviceArea";
import * as q from "~/db/queries";
import type { Appointment } from "~/db/schema";
import { formatAppointmentTime } from "./workflowTime";
import { sendCustomerWorkflow } from "./smsWorkflowTriggers";

// ---------------------------------------------------------------------------
// Input validation (pure, exported for tests)
// ---------------------------------------------------------------------------

export interface BookingInput {
  leadId?: unknown;
  serviceSummary?: unknown;
  scheduledAt?: unknown;
  durationMinutes?: unknown;
  technicianName?: unknown;
  address?: unknown;
  notes?: unknown;
  /** Explicit owner confirmation required to book a definitive out-of-area job. */
  confirmOutOfArea?: unknown;
}

export interface ValidatedBooking {
  leadId: string | null;
  serviceSummary: string;
  scheduledAt: Date;
  durationMinutes: number;
  technicianName: string | null;
  address: string | null;
  notes: string | null;
  confirmOutOfArea: boolean;
}

export type ValidatedBookingResult =
  | ({ ok: true } & ValidatedBooking)
  | { ok: false; status: 400; error: string; field?: string };

const SUMMARY_MAX = 200;
const NOTES_MAX = 500;
const TECHNICIAN_MAX = 120;
const ADDRESS_MAX = 200;
const DURATION_MIN = 15;
const DURATION_MAX = 600;
/** Bookings may target up to one year out; past slots are rejected (a 10-minute
 * clock-skew grace keeps "now" bookings from flapping on slow devices). */
const MAX_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = 10 * 60 * 1000;
/** Duplicate-submission window: the same lead with a slot within ±15 minutes
 * of an existing non-declined appointment is the SAME booking, not a new one. */
export const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;

function str(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

export function validateBookingInput(input: BookingInput, now: Date = new Date()): ValidatedBookingResult {
  const serviceSummary = str(input.serviceSummary);
  if (serviceSummary.length === 0) {
    return { ok: false, status: 400, field: "serviceSummary", error: "Describe the work to be done (at least 1 character)." };
  }
  if (serviceSummary.length > SUMMARY_MAX) {
    return { ok: false, status: 400, field: "serviceSummary", error: `Service summary is too long (max ${SUMMARY_MAX} characters).` };
  }

  const rawWhen = str(input.scheduledAt);
  if (rawWhen.length === 0) {
    return { ok: false, status: 400, field: "scheduledAt", error: "Pick a date and time for the appointment." };
  }
  const scheduledAt = new Date(rawWhen);
  if (Number.isNaN(scheduledAt.getTime())) {
    return { ok: false, status: 400, field: "scheduledAt", error: "That date and time could not be read. Pick a valid slot." };
  }
  if (scheduledAt.getTime() < now.getTime() - PAST_GRACE_MS) {
    return { ok: false, status: 400, field: "scheduledAt", error: "Pick a time in the future — past slots cannot be booked." };
  }
  if (scheduledAt.getTime() > now.getTime() + MAX_HORIZON_MS) {
    return { ok: false, status: 400, field: "scheduledAt", error: "Pick a time within the next year." };
  }

  let durationMinutes = 60;
  if (input.durationMinutes != null && input.durationMinutes !== "") {
    const n = typeof input.durationMinutes === "number" ? input.durationMinutes : Number(str(String(input.durationMinutes)));
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < DURATION_MIN || n > DURATION_MAX) {
      return {
        ok: false,
        status: 400,
        field: "durationMinutes",
        error: `Duration must be a whole number between ${DURATION_MIN} and ${DURATION_MAX} minutes.`,
      };
    }
    durationMinutes = n;
  }

  const technicianName = str(input.technicianName);
  if (technicianName.length > TECHNICIAN_MAX) {
    return { ok: false, status: 400, field: "technicianName", error: `Technician name is too long (max ${TECHNICIAN_MAX} characters).` };
  }
  const address = str(input.address);
  if (address.length > ADDRESS_MAX) {
    return { ok: false, status: 400, field: "address", error: `Job address is too long (max ${ADDRESS_MAX} characters).` };
  }
  const notes = str(input.notes);
  if (notes.length > NOTES_MAX) {
    return { ok: false, status: 400, field: "notes", error: `Notes are too long (max ${NOTES_MAX} characters).` };
  }

  const leadId = str(input.leadId);
  return {
    ok: true,
    leadId: leadId.length > 0 ? leadId : null,
    serviceSummary,
    scheduledAt,
    durationMinutes,
    technicianName: technicianName.length > 0 ? technicianName : null,
    address: address.length > 0 ? address : null,
    notes: notes.length > 0 ? notes : null,
    confirmOutOfArea: input.confirmOutOfArea === true || str(String(input.confirmOutOfArea)) === "true",
  };
}

// ---------------------------------------------------------------------------
// Booking (DB)
// ---------------------------------------------------------------------------

export type BookingOutcome =
  | { ok: true; appointment: Appointment; duplicate: boolean; areaStatus: ServiceAreaStatus }
  | { ok: false; status: number; error: string; code?: "out_of_area"; areaStatus?: ServiceAreaStatus };

export interface BookingContext {
  businessId: string;
  timezone: string;
  /** Book-as confirmed (business scheduling) vs requested (customer proposal). */
  status?: "requested" | "confirmed";
}

/**
 * Find an existing non-declined appointment for the same lead inside the
 * duplicate window — the double-submit/double-click guard.
 */
export async function findDuplicateBooking(
  businessId: string,
  leadId: string,
  scheduledAt: Date,
): Promise<Appointment | null> {
  const t = scheduledAt.getTime();
  const windowed = await q.listAppointments(
    businessId,
    { from: new Date(t - DUPLICATE_WINDOW_MS), to: new Date(t + DUPLICATE_WINDOW_MS + 1) },
    { limit: 50, order: "asc" },
  );
  return (
    windowed.find((a) => a.leadId === leadId && a.status !== "declined") ?? null
  );
}

/**
 * Book an appointment for a business. See the module header for the journey
 * contract. Never throws for expected business outcomes — everything comes
 * back as a typed BookingOutcome so the server fn can map it 1:1.
 */
export async function bookAppointment(ctx: BookingContext, input: BookingInput): Promise<BookingOutcome> {
  const v = validateBookingInput(input);
  if (!v.ok) return { ok: false, status: v.status, error: v.error };

  // Lead scope: a leadId from another business is a 404 (isolation boundary).
  let lead: Awaited<ReturnType<typeof q.getLead>> | null = null;
  if (v.leadId) {
    lead = await q.getLead(ctx.businessId, v.leadId);
    if (!lead) return { ok: false, status: 404, error: "Lead not found." };
  }

  // DUPLICATE SUBMISSION: collapse a re-submitted identical booking onto the
  // existing appointment. Same lead + non-declined slot within ±15 minutes.
  if (v.leadId) {
    const dup = await findDuplicateBooking(ctx.businessId, v.leadId, v.scheduledAt);
    if (dup) return { ok: true, appointment: dup, duplicate: true, areaStatus: (lead?.serviceAreaStatus as ServiceAreaStatus) ?? "unknown" };
  }

  // OUT-OF-AREA: only a DEFINITIVE out_of_area classification blocks; the
  // owner can still book with the explicit confirmation flag (recorded in the
  // notes so the crew sees why). in_area/unknown book normally.
  const jobAddress = v.address ?? lead?.contactAddress ?? null;
  let areaStatus: ServiceAreaStatus = (lead?.serviceAreaStatus as ServiceAreaStatus | null) ?? "unknown";
  if (jobAddress) {
    const areas = await q.listServiceAreas(ctx.businessId);
    const fresh = classifyServiceArea(jobAddress, areas.map((a) => ({ kind: a.kind, value: a.value, state: a.state })));
    // A fresh definitive classification beats a stale/unknown lead stamp.
    if (fresh !== "unknown") areaStatus = fresh;
    else if (extractZip(jobAddress) && lead?.serviceAreaStatus) areaStatus = lead.serviceAreaStatus as ServiceAreaStatus;
  }
  if (areaStatus === "out_of_area" && !v.confirmOutOfArea) {
    return {
      ok: false,
      status: 422,
      code: "out_of_area",
      areaStatus,
      error: "This job address is outside your service areas" + (jobAddress ? ` (${jobAddress})` : "") + ". Tick “Book anyway” to schedule it as an exception.",
    };
  }

  const effectiveNotes = v.notes ?? "";
  const created = await q.createAppointment(ctx.businessId, {
    leadId: v.leadId,
    serviceSummary: v.serviceSummary + (areaStatus === "out_of_area" ? " [out-of-area exception confirmed by owner]" : ""),
    technicianName: v.technicianName,
    scheduledAt: v.scheduledAt,
    durationMinutes: v.durationMinutes,
    status: ctx.status ?? "confirmed",
    address: jobAddress,
    notes: effectiveNotes.length > 0 ? effectiveNotes : null,
  });

  // P3-C lifecycle automation, identical to confirmAppointmentFn: the job is
  // on the books, so a live lead moves to appointment_scheduled (never from
  // won/lost; automation failure never fails the booking).
  if (created.leadId) {
    try {
      const leadRow = await q.getLead(ctx.businessId, created.leadId);
      if (leadRow && q.validateLeadTransition(leadRow.status, "appointment_scheduled").ok && leadRow.status !== "appointment_scheduled") {
        await q.updateLead(ctx.businessId, leadRow.id, { status: "appointment_scheduled" });
      }
    } catch {
      // Lifecycle automation is best-effort.
    }
  }

  // In-app notification (owner sees what was booked). Never blocks.
  try {
    await q.createNotification(ctx.businessId, {
      type: "appointment_confirmed",
      payload: {
        appointmentId: created.id,
        leadId: created.leadId ?? undefined,
        leadName: lead?.contactName ?? undefined,
        serviceNeed: created.serviceSummary,
        scheduledAt: new Date(created.scheduledAt).toISOString(),
      },
    });
  } catch {
    // Notification failure must not fail the booking.
  }

  // Customer confirmation text through the ONE workflow engine (safeguarded,
  // honest). Never blocks the booking write.
  if (created.leadId && lead) {
    try {
      await sendCustomerWorkflow(ctx.businessId, "appointment_confirmation", {
        to: lead.contactPhone,
        leadId: lead.id,
        appointmentId: created.id,
        vars: {
          customerName: lead.contactName ?? undefined,
          serviceNeed: created.serviceSummary,
          appointmentTime: formatAppointmentTime(new Date(created.scheduledAt), ctx.timezone),
        },
      });
    } catch {
      // Workflow failure must not fail the booking.
    }
  }

  return { ok: true, appointment: created, duplicate: false, areaStatus };
}
