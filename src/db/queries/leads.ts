/**
 * Server-only queries: leads.
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it —
 * the WHERE clause is the isolation boundary, so no function may omit it.
 */
import { classifyServiceArea } from "../../lib/serviceArea";
import { listServiceAreas } from "./settings";
import type { Lead, LeadPriority, LeadSource, LeadStatus, LeadUrgency } from "../schema";
import { assertServer, listClause, sql, type ListOptions } from "./shared";
import { computePipelineValueCents, estimateJobValueCents } from "../../lib/server/crmValue";
import { checkLeadTransition, toLifecycleStatus } from "../../lib/server/leadLifecycle";

export interface LeadFilters {
  status?: LeadStatus;
  source?: LeadSource;
  urgency?: LeadUrgency;
  priority?: LeadPriority;
  /** Matches contact name / phone / service need. */
  search?: string;
}

export interface CreateLeadInput {
  source?: LeadSource;
  status?: LeadStatus;
  serviceNeed: string;
  urgency?: LeadUrgency;
  contactName: string;
  contactPhone: string;
  contactEmail?: string | null;
  contactAddress?: string | null;
  description?: string | null;
  estimatedValueCents?: number | null;
  notes?: string | null;
}

export interface UpdateLeadInput {
  status?: LeadStatus;
  serviceNeed?: string;
  urgency?: LeadUrgency;
  priority?: LeadPriority;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string | null;
  contactAddress?: string | null;
  description?: string | null;
  estimatedValueCents?: number | null;
  /** P3-C: KB-stamped typical value range (set by the capture pipeline). */
  estimatedJobValueLowCents?: number | null;
  estimatedJobValueHighCents?: number | null;
  /** P3-C: the actual invoice amount, entered when the lead is marked won. */
  actualWonValueCents?: number | null;
  notes?: string | null;
}

/** Legacy statuses accepted by filters/updates, mapped forward on read. */
const FILTERABLE_STATUS: (LeadStatus | "booked" | "completed")[] = [
  "new", "contacted", "qualified", "follow_up_needed", "appointment_scheduled", "won", "lost",
  "booked", "completed",
];
const FILTERABLE_SOURCE: LeadSource[] = ["missed_call", "web_form", "referral", "repeat_customer", "other"];
const FILTERABLE_URGENCY: LeadUrgency[] = ["emergency", "same_day", "within_week", "flexible"];
const FILTERABLE_PRIORITY: LeadPriority[] = ["emergency", "high", "normal"];

/** Build the shared WHERE for list/count. All enum filters are whitelisted. */
function leadWhere(businessId: string, f: LeadFilters): { text: string; values: unknown[] } {
  const values: unknown[] = [businessId];
  const clauses = ["business_id = $1"];
  if (f.status && FILTERABLE_STATUS.includes(f.status)) {
    values.push(toLifecycleStatus(f.status) ?? f.status);
    clauses.push(`status = $${values.length}`);
  }
  if (f.source && FILTERABLE_SOURCE.includes(f.source)) {
    values.push(f.source);
    clauses.push(`source = $${values.length}`);
  }
  if (f.urgency && FILTERABLE_URGENCY.includes(f.urgency)) {
    values.push(f.urgency);
    clauses.push(`urgency = $${values.length}`);
  }
  if (f.priority && FILTERABLE_PRIORITY.includes(f.priority)) {
    values.push(f.priority);
    clauses.push(`priority = $${values.length}`);
  }
  if (f.search && f.search.trim()) {
    const like = `%${f.search.trim()}%`;
    values.push(like);
    const n = values.length;
    clauses.push(`(contact_name ILIKE $${n} OR contact_phone ILIKE $${n} OR service_need ILIKE $${n})`);
  }
  return { text: clauses.join(" AND "), values };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLead(businessId: string, leadId: string): Promise<Lead | null> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM leads WHERE id = ${leadId} AND business_id = ${businessId} LIMIT 1`;
  return (rows[0] as unknown as Lead | undefined) ?? null;
}

export async function listLeads(
  businessId: string,
  filters: LeadFilters = {},
  opts?: ListOptions,
): Promise<Lead[]> {
  assertServer();
  const { limit, offset, order } = listClause(opts);
  const dir = order === "asc" ? "ASC" : "DESC"; // whitelisted
  const w = leadWhere(businessId, filters);
  const db = sql();
  const rows = await db.query(
    `SELECT * FROM leads WHERE ${w.text} ORDER BY created_at ${dir} LIMIT ${limit} OFFSET ${offset}`,
    w.values,
  );
  return rows as unknown as Lead[];
}

export async function countLeads(businessId: string, filters: LeadFilters = {}): Promise<number> {
  assertServer();
  const w = leadWhere(businessId, filters);
  const db = sql();
  const rows = await db.query(`SELECT count(*) AS n FROM leads WHERE ${w.text}`, w.values);
  return Number((rows[0] as unknown as { n: unknown }).n);
}

/** Pipeline value of every lead that is not lost. */
export async function sumOpenPipelineValue(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT coalesce(sum(pipeline_value_cents), 0) AS total
    FROM leads WHERE business_id = ${businessId} AND status <> 'lost'`;
  return Number((rows[0] as unknown as { total: unknown }).total);
}

/** The migration-011 lifecycle, in pipeline order, zeroed. */
export function emptyLeadStatusCounts(): Record<LeadStatus, number> {
  return { new: 0, contacted: 0, qualified: 0, follow_up_needed: 0, appointment_scheduled: 0, won: 0, lost: 0 };
}

export async function countLeadsByStatus(businessId: string): Promise<Record<LeadStatus, number>> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT status, count(*) AS n FROM leads WHERE business_id = ${businessId} GROUP BY status`;
  const out = emptyLeadStatusCounts();
  for (const row of rows as unknown as { status: string; n: unknown }[]) {
    const s = toLifecycleStatus(row.status);
    if (s) out[s] += Number(row.n);
  }
  return out;
}

export async function countLeadsBySource(businessId: string): Promise<Record<LeadSource, number>> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT source, count(*) AS n FROM leads WHERE business_id = ${businessId} GROUP BY source`;
  const out: Record<LeadSource, number> = {
    missed_call: 0, web_form: 0, referral: 0, repeat_customer: 0, other: 0,
  };
  for (const row of rows as unknown as { status: LeadSource; n: unknown }[]) {
    out[row.status] = Number(row.n);
  }
  return out;
}

/** Leads created at/after `since` (e.g. the dashboard's "new this week"). */
export async function countLeadsCreatedSince(businessId: string, since: Date): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT count(*) AS n FROM leads
    WHERE business_id = ${businessId} AND created_at >= ${since.toISOString()}`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

export async function countLeadsByPriority(
  businessId: string,
): Promise<Record<LeadPriority, number>> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT priority, count(*) AS n FROM leads WHERE business_id = ${businessId} GROUP BY priority`;
  const out: Record<LeadPriority, number> = { emergency: 0, high: 0, normal: 0 };
  for (const row of rows as unknown as { priority: LeadPriority; n: unknown }[]) {
    out[row.priority] = Number(row.n);
  }
  return out;
}

/**
 * Missed-call recovery funnel, all real rows:
 *   missedCalls = leads created from a captured missed call;
 *   recovered   = of those, leads with at least one SMS conversation
 *                 (the text-back actually engaged the customer);
 *   booked      = of those, leads the shop won (status booked/completed).
 */
export async function missedCallRecoveryStats(
  businessId: string,
): Promise<{ missedCalls: number; recovered: number; booked: number }> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT
      count(*) AS missed_calls,
      count(c.lead_id) AS recovered,
      count(*) FILTER (WHERE l.status IN ('appointment_scheduled', 'won')) AS booked
    FROM leads l
    LEFT JOIN (
      SELECT DISTINCT lead_id FROM conversations
      WHERE lead_id IS NOT NULL AND business_id = ${businessId}
    ) c ON c.lead_id = l.id
    WHERE l.business_id = ${businessId} AND l.source = 'missed_call'`;
  const r = rows[0] as unknown as {
    missedCalls: unknown;
    recovered: unknown;
    booked: unknown;
  };
  return {
    missedCalls: Number(r.missedCalls),
    recovered: Number(r.recovered),
    booked: Number(r.booked),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createLead(businessId: string, input: CreateLeadInput): Promise<Lead> {
  assertServer();
  const db = sql();
  // Phase 2 build #3: classify the job address against the business's service
  // areas at capture time. The lead is ALWAYS captured — out-of-area rows are
  // flagged (service_area_status), never dropped. No service areas configured
  // or undecidable address => 'unknown', not a guess.
  const areas = await listServiceAreas(businessId);
  const serviceAreaStatus = classifyServiceArea(input.contactAddress, areas);
  // P3-C: stamp the KB typical value range when the service need resolves to
  // a KB service (pure, keyless). Never overwrites a shop-entered estimate —
  // the range seeds the estimate, it is not a quote.
  const estimate = estimateJobValueCents(input.serviceNeed);
  const status = input.status ?? "new";
  const pipelineValue = computePipelineValueCents({
    status: status === "won" ? "won" : status === "lost" ? "lost" : "open",
    actualWonValueCents: null,
    estimatedValueCents: input.estimatedValueCents ?? null,
    estimatedJobValueLowCents: estimate?.lowCents ?? null,
    estimatedJobValueHighCents: estimate?.highCents ?? null,
  });
  const rows = await db.query(
    `INSERT INTO leads (business_id, source, status, service_need, urgency, contact_name, contact_phone,
       contact_email, contact_address, description, estimated_value_cents, notes, service_area_status,
       estimated_job_value_low_cents, estimated_job_value_high_cents, pipeline_value_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      businessId,
      input.source ?? "missed_call",
      status,
      input.serviceNeed,
      input.urgency ?? "flexible",
      input.contactName,
      input.contactPhone,
      input.contactEmail ?? null,
      input.contactAddress ?? null,
      input.description ?? null,
      input.estimatedValueCents ?? null,
      input.notes ?? null,
      serviceAreaStatus,
      estimate?.lowCents ?? null,
      estimatedJobValueHighCentsOrNull(estimate),
      pipelineValue,
    ],
  );
  return rows[0] as unknown as Lead;
}

function estimatedJobValueHighCentsOrNull(estimate: ReturnType<typeof estimateJobValueCents>): number | null {
  return estimate ? estimate.highCents : null;
}

const LEAD_PATCH_COLUMNS = [
  "status",
  "serviceNeed",
  "urgency",
  "priority",
  "contactName",
  "contactPhone",
  "contactEmail",
  "contactAddress",
  "description",
  "estimatedValueCents",
  "estimatedJobValueLowCents",
  "estimatedJobValueHighCents",
  "actualWonValueCents",
  "notes",
] as const;

/**
 * P3-C: the pure derived-fields recompute for a lead row. Given the merged
 * "what the row will say", compute the columns that always follow it:
 * pipeline_value_cents, plus converted_at / won transitions.
 */
interface LeadDerivedFields {
  pipelineValueCents: number | null;
}

function leadDerivedFields(merged: {
  status: string;
  estimatedValueCents: number | null;
  estimatedJobValueLowCents: number | null;
  estimatedJobValueHighCents: number | null;
  actualWonValueCents: number | null;
}): LeadDerivedFields {
  return {
    pipelineValueCents: computePipelineValueCents({
      status: merged.status === "won" ? "won" : merged.status === "lost" ? "lost" : "open",
      actualWonValueCents: merged.actualWonValueCents,
      estimatedValueCents: merged.estimatedValueCents,
      estimatedJobValueLowCents: merged.estimatedJobValueLowCents,
      estimatedJobValueHighCents: merged.estimatedJobValueHighCents,
    }),
  };
}

/**
 * P3-C: validate the transition against the lifecycle and compute the money
 * recompute. Caller contract: the caller (updateLead / appFns) has already
 * loaded the row; this never touches the DB.
 */
export interface LeadTransitionValidation {
  ok: boolean;
  error: string | null;
}

export function validateLeadTransition(
  fromRaw: string,
  toRaw: LeadStatus,
): LeadTransitionValidation {
  const from = toLifecycleStatus(fromRaw);
  if (!from) return { ok: false, error: "Lead has an unknown stored status." };
  const check = checkLeadTransition(from, toRaw);
  return check.ok ? { ok: true, error: null } : { ok: false, error: check.error };
}

export async function updateLead(
  businessId: string,
  leadId: string,
  input: UpdateLeadInput,
): Promise<Lead | null> {
  assertServer();
  const existing = await getLead(businessId, leadId);
  if (!existing) return null;
  // P3-C: status changes go through the lifecycle validator with a clear
  // error — invalid transitions (e.g. won → new) throw rather than write.
  if (input.status != null) {
    const validation = validateLeadTransition(existing.status, input.status);
    if (!validation.ok) {
      throw new Error(validation.error ?? "Invalid status transition.");
    }
  }
  const snake = (k: string): string => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const cols = Object.keys(input).filter((k) =>
    (LEAD_PATCH_COLUMNS as readonly string[]).includes(k),
  );
  if (cols.length === 0) return existing;
  // $1 = leadId, $2 = businessId, then one param per patched column.
  const sets = cols.map((k, i) => snake(k) + " = $" + String(i + 3)).join(", ");
  const values = cols.map((k) => input[k as keyof UpdateLeadInput]);
  // Keep converted_at in sync with lifecycle transitions: winning the job
  // (won) stamps it once; moving back to an open/lost state clears it.
  let convertedClause = "";
  if (cols.includes("status")) {
    convertedClause =
      input.status === "won"
        ? ", converted_at = coalesce(converted_at, now())"
        : ", converted_at = NULL";
  }
  // P3-C: recompute the derived money columns from the merged row state.
  const merged = {
    status: cols.includes("status") ? (input.status as string) : existing.status,
    estimatedValueCents: cols.includes("estimatedValueCents")
      ? input.estimatedValueCents ?? null
      : existing.estimatedValueCents,
    estimatedJobValueLowCents: cols.includes("estimatedJobValueLowCents")
      ? input.estimatedJobValueLowCents ?? null
      : existing.estimatedJobValueLowCents,
    estimatedJobValueHighCents: cols.includes("estimatedJobValueHighCents")
      ? input.estimatedJobValueHighCents ?? null
      : existing.estimatedJobValueHighCents,
    actualWonValueCents: cols.includes("actualWonValueCents")
      ? input.actualWonValueCents ?? null
      : existing.actualWonValueCents,
  };
  const derived = leadDerivedFields(merged);
  const pipelineClause =
    ", pipeline_value_cents = $" + String(cols.length + 3) + " ";
  const db = sql();
  const rows = await db.query(
    "UPDATE leads SET " + sets + pipelineClause + convertedClause + " WHERE id = $1 AND business_id = $2 RETURNING *",
    [leadId, businessId, ...values, derived.pipelineValueCents],
  );
  return (rows[0] as unknown as Lead | undefined) ?? null;
}

/**
 * "Booked" = the job is on the books (P3-C: appointment_scheduled status).
 * Kept for the programmatic capture path (textBack/AI receptionist callers);
 * winning the job outright is the human `won` transition via updateLead.
 * converted_at marks when the lead was won.
 */
export async function markLeadConverted(businessId: string, leadId: string): Promise<Lead | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    UPDATE leads SET status = 'appointment_scheduled', converted_at = coalesce(converted_at, now())
    WHERE id = ${leadId} AND business_id = ${businessId}
    RETURNING *`;
  return (rows[0] as unknown as Lead | undefined) ?? null;
}

export async function deleteLead(businessId: string, leadId: string): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`DELETE FROM leads WHERE id = ${leadId} AND business_id = ${businessId} RETURNING id`;
  return rows.length > 0;
}
