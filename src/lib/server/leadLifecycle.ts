/**
 * Lead lifecycle (P3-C): the legal transitions of the lead-to-job pipeline.
 *
 * THE PIPELINE (migration 011):
 *
 *   new → contacted → qualified → appointment_scheduled → won
 *                                   ↑
 *   new/contacted/qualified ────────┘ (a booking can also be made early)
 *   any live state → follow_up_needed   (the "call them back" queue)
 *   any live state → lost
 *
 *   Won and Lost are TERMINAL except the single reopen edge
 *   won|lost → follow_up_needed (a "lost" customer calls back — reopen as a
 *   follow-up, never silently back to new).
 *
 * Status changes are HUMAN decisions (owner/manager in the UI); nothing in
 * the automation may move a lead to won or lost. Light automation exists for
 * the two mechanical moments only:
 *   - appointment request confirmed  → appointment_scheduled
 *     (src/lib/server/appFns.ts confirmAppointmentFn)
 *   - follow_up_needed flag          → a follow-up task is created
 *     (updateLeadStatusFn → maybeCreateFollowUpTaskForTransition)
 * Emergency classification deliberately does NOT flag follow_up_needed — the
 * lead stays in its current status with emergency priority; escalation
 * (textBack.ts) already pages the shop.
 *
 * PURE MODULE: no I/O, no env, no DB. Unit-tested DBless (scripts/test-crm.ts),
 * same contract as classifyPipeline.ts.
 */

export type LeadLifecycleStatus =
  | "new"
  | "contacted"
  | "qualified"
  | "follow_up_needed"
  | "appointment_scheduled"
  | "won"
  | "lost";

/** Ordered for UI select options / filter dropdowns (pipeline order). */
export const LEAD_LIFECYCLE_STATUSES: readonly LeadLifecycleStatus[] = [
  "new",
  "contacted",
  "qualified",
  "follow_up_needed",
  "appointment_scheduled",
  "won",
  "lost",
];

export const LEAD_STATUS_LABELS: Record<LeadLifecycleStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  follow_up_needed: "Follow-up needed",
  appointment_scheduled: "Appointment scheduled",
  won: "Won",
  lost: "Lost",
};

/** The Phase 2 statuses migration 011 rewires (documented in the migration). */
export type LegacyLeadStatus = "booked" | "completed";

export const LEGACY_STATUS_MAP: Record<LegacyLeadStatus, LeadLifecycleStatus> = {
  booked: "appointment_scheduled",
  completed: "won",
};

export function isLegacyLeadStatus(v: string): v is LegacyLeadStatus {
  return v === "booked" || v === "completed";
}

/** Map any stored status (including pre-011 rows) to the lifecycle union. */
export function toLifecycleStatus(v: string): LeadLifecycleStatus | null {
  if ((LEAD_LIFECYCLE_STATUSES as readonly string[]).includes(v)) return v as LeadLifecycleStatus;
  if (isLegacyLeadStatus(v)) return LEGACY_STATUS_MAP[v];
  return null;
}

/**
 * The forward pipeline edges plus the two "escape hatch" families. A lead may
 * skip stages (a hot referral can go new → appointment_scheduled) — the
 * pipeline is a set of legal edges, not a forced ladder.
 */
const LIVE_STATUSES: LeadLifecycleStatus[] = [
  "new",
  "contacted",
  "qualified",
  "follow_up_needed",
  "appointment_scheduled",
];
const TERMINAL_STATUSES: LeadLifecycleStatus[] = ["won", "lost"];


/**
 * Is `to` a legal transition from `from`?
 *
 *   - Same-status is a no-op and reported legal (idempotent save).
 *   - Live → any other status: forward pipeline movement, side-queues
 *     (follow_up_needed), and honest corrections. Live statuses are WORKING
 *     states — the shop may re-triage (a mis-clicked "contacted" must be
 *     undoable), so among live statuses back-moves stay legal; the pipeline
 *     order is the happy path, not a ratchet.
 *   - won/lost → follow_up_needed only (the reopen edge). Every other exit
 *     from a terminal state is blocked WITH A CLEAR ERROR (checkLeadTransition).
 */
export function leadTransitionIsValid(
  from: LeadLifecycleStatus,
  to: LeadLifecycleStatus,
): boolean {
  if (from === to) return true;
  if (TERMINAL_STATUSES.includes(from)) return to === "follow_up_needed";
  return LIVE_STATUSES.includes(to) || to === "won" || to === "lost";
}

/** Which statuses may `from` move to — drives the UI's status <select>. */
export function allowedNextStatuses(from: LeadLifecycleStatus): LeadLifecycleStatus[] {
  if (TERMINAL_STATUSES.includes(from)) return ["follow_up_needed"];
  return LEAD_LIFECYCLE_STATUSES.filter((s) => s !== from && leadTransitionIsValid(from, s));
}

export interface TransitionCheckResult {
  ok: boolean;
  /** Human-readable reason when ok is false. */
  error: string | null;
}

/** Validate with a customer-facing error message (appFns surfaces it 1:1). */
export function checkLeadTransition(
  from: LeadLifecycleStatus,
  to: LeadLifecycleStatus,
): TransitionCheckResult {
  if (leadTransitionIsValid(from, to)) return { ok: true, error: null };
  const toLabel = LEAD_STATUS_LABELS[to];
  if (from === "won") {
    return {
      ok: false,
      error: `This job is already won. A won job can only be reopened to Follow-up needed (picked "${toLabel}").`,
    };
  }
  if (from === "lost") {
    return {
      ok: false,
      error: `This lead is lost and closed. Reopen it to Follow-up needed if the customer came back (picked "${toLabel}").`,
    };
  }
  return {
    ok: false,
    error: `Can't move a lead from ${LEAD_STATUS_LABELS[from]} back to ${toLabel}.`,
  };
}
