/**
 * Server-only queries: appointments.
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it.
 */
import type { Appointment, AppointmentStatus } from "../schema";
import { assertServer, listClause, sql, type ListOptions } from "./shared";

export interface AppointmentFilters {
  status?: AppointmentStatus;
  /** Only appointments at/after this time. */
  from?: Date;
  /** Only appointments strictly before this time. */
  to?: Date;
  technician?: string;
}

export interface CreateAppointmentInput {
  leadId?: string | null;
  serviceId?: string | null;
  serviceSummary: string;
  technicianName?: string | null;
  scheduledAt: Date;
  durationMinutes?: number;
  status?: AppointmentStatus;
  address?: string | null;
  notes?: string | null;
}

export interface UpdateAppointmentInput {
  serviceId?: string | null;
  serviceSummary?: string;
  technicianName?: string | null;
  scheduledAt?: Date;
  durationMinutes?: number;
  status?: AppointmentStatus;
  address?: string | null;
  notes?: string | null;
}

const FILTERABLE_STATUS: AppointmentStatus[] = ["requested", "confirmed", "declined", "completed"];

/**
 * Build the WHERE clause for appointment reads. Every column is qualified with
 * `alias` -- `listAppointmentsWithLead` joins `leads`, which also has
 * `business_id`, and an unqualified `business_id` makes Postgres fail with
 * "column reference is ambiguous".
 */
function appointmentWhere(
  businessId: string,
  f: AppointmentFilters,
  alias: "a" | "appointments" = "appointments",
): { text: string; values: unknown[] } {
  const col = (name: string): string => `${alias}.${name}`;
  const values: unknown[] = [businessId];
  const clauses = [`${col("business_id")} = $1`];
  if (f.status && FILTERABLE_STATUS.includes(f.status)) {
    values.push(f.status);
    clauses.push(`${col("status")} = ${"$"}${values.length}`);
  }
  if (f.from) {
    values.push(f.from.toISOString());
    clauses.push(`${col("scheduled_at")} >= ${"$"}${values.length}`);
  }
  if (f.to) {
    values.push(f.to.toISOString());
    clauses.push(`${col("scheduled_at")} < ${"$"}${values.length}`);
  }
  if (f.technician) {
    values.push(f.technician);
    clauses.push(`${col("technician_name")} = ${"$"}${values.length}`);
  }
  return { text: clauses.join(" AND "), values };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getAppointment(businessId: string, appointmentId: string): Promise<Appointment | null> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM appointments WHERE id = ${appointmentId} AND business_id = ${businessId} LIMIT 1`;
  return (rows[0] as unknown as Appointment | undefined) ?? null;
}

export async function listAppointments(
  businessId: string,
  filters: AppointmentFilters = {},
  opts?: ListOptions,
): Promise<Appointment[]> {
  assertServer();
  const { limit, offset, order } = listClause(opts);
  const dir = order === "asc" ? "ASC" : "DESC"; // whitelisted
  const w = appointmentWhere(businessId, filters);
  const db = sql();
  const rows = await db.query(
    `SELECT * FROM appointments WHERE ${w.text} ORDER BY scheduled_at ${dir} LIMIT ${limit} OFFSET ${offset}`,
    w.values,
  );
  return rows as unknown as Appointment[];
}

export async function countAppointments(
  businessId: string,
  filters: AppointmentFilters = {},
): Promise<number> {
  assertServer();
  const w = appointmentWhere(businessId, filters);
  const db = sql();
  const rows = await db.query(`SELECT count(*) AS n FROM appointments WHERE ${w.text}`, w.values);
  return Number((rows[0] as unknown as { n: unknown }).n);
}

export async function countAppointmentsByStatus(businessId: string): Promise<Record<AppointmentStatus, number>> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT status, count(*) AS n FROM appointments WHERE business_id = ${businessId} GROUP BY status`;
  const out: Record<AppointmentStatus, number> = {
    requested: 0, confirmed: 0, declined: 0, completed: 0,
  };
  for (const row of rows as unknown as { status: AppointmentStatus; n: unknown }[]) {
    out[row.status] = Number(row.n);
  }
  return out;
}

/** Active upcoming appointments (requested or confirmed — the actionable set). */
export async function countUpcoming(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT count(*) AS n FROM appointments
    WHERE business_id = ${businessId} AND scheduled_at >= now()
      AND status IN ('requested', 'confirmed')`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

/** Confirmed upcoming appointments (dashboard metric: the confirmed slice). */
export async function countUpcomingByStatus(
  businessId: string,
  status: AppointmentStatus,
): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT count(*) AS n FROM appointments
    WHERE business_id = ${businessId} AND scheduled_at >= now()
      AND status = ${status}`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

/**
 * Appointment counts by weekday of scheduled_at, all-time.
 * Returns 7 numbers indexed Mon=0 … Sun=6 (Postgres ISODOW - 1).
 */
export async function countAppointmentsByWeekday(businessId: string): Promise<number[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT Extract(ISODOW FROM scheduled_at)::int AS isodow, count(*) AS n
    FROM appointments WHERE business_id = ${businessId}
    GROUP BY 1 ORDER BY 1`;
  const out = [0, 0, 0, 0, 0, 0, 0];
  for (const row of rows as unknown as { isodow: number; n: unknown }[]) {
    out[row.isodow - 1] = Number(row.n);
  }
  return out;
}

export interface AppointmentWithLead extends Appointment {
  /** Customer info from the parent lead (null when the lead was deleted). */
  leadName: string | null;
  leadPhone: string | null;
}

/** Appointments joined with their lead's contact info (both rows business-bounded). */
export async function listAppointmentsWithLead(
  businessId: string,
  filters: AppointmentFilters = {},
  opts?: ListOptions,
): Promise<AppointmentWithLead[]> {
  assertServer();
  const { limit, offset, order } = listClause(opts);
  const dir = order === "asc" ? "ASC" : "DESC"; // whitelisted
  const w = appointmentWhere(businessId, filters, "a");
  const db = sql();
  const rows = await db.query(
    `SELECT a.*, l.contact_name AS lead_name, l.contact_phone AS lead_phone
     FROM appointments a
     LEFT JOIN leads l ON l.id = a.lead_id AND l.business_id = $1
     WHERE ${w.text}
     ORDER BY a.scheduled_at ${dir} LIMIT ${limit} OFFSET ${offset}`,
    w.values,
  );
  return rows as unknown as AppointmentWithLead[];
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function createAppointment(businessId: string, input: CreateAppointmentInput): Promise<Appointment> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    `INSERT INTO appointments (business_id, lead_id, service_id, service_summary, technician_name,
       scheduled_at, duration_minutes, status, address, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      businessId,
      input.leadId ?? null,
      input.serviceId ?? null,
      input.serviceSummary,
      input.technicianName ?? null,
      input.scheduledAt.toISOString(),
      input.durationMinutes ?? 60,
      input.status ?? "requested",
      input.address ?? null,
      input.notes ?? null,
    ],
  );
  return rows[0] as unknown as Appointment;
}

const APPOINTMENT_PATCH_COLUMNS = [
  "serviceId",
  "serviceSummary",
  "technicianName",
  "scheduledAt",
  "durationMinutes",
  "status",
  "address",
  "notes",
] as const;

export async function updateAppointment(
  businessId: string,
  appointmentId: string,
  input: UpdateAppointmentInput,
): Promise<Appointment | null> {
  assertServer();
  const snake = (k: string): string => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const cols = Object.keys(input).filter((k) =>
    (APPOINTMENT_PATCH_COLUMNS as readonly string[]).includes(k),
  );
  if (cols.length === 0) return getAppointment(businessId, appointmentId);
  const sets = cols.map((k, i) => `${snake(k)} = $${i + 3}`).join(", ");
  const values = cols.map((k) => {
    const v = input[k as keyof UpdateAppointmentInput];
    return v instanceof Date ? v.toISOString() : v;
  });
  const db = sql();
  const rows = await db.query(
    `UPDATE appointments SET ${sets} WHERE id = $1 AND business_id = $2 RETURNING *`,
    [appointmentId, businessId, ...values],
  );
  return (rows[0] as unknown as Appointment | undefined) ?? null;
}

/**
 * Request-driven status change (migration 006): the business confirms or
 * declines a REQUESTED appointment. Guarded transitions — only requested
 * appointments may be confirmed or declined, and declined ones may be
 * re-confirmed (the owner called the customer back).
 */
export async function setAppointmentStatus(
  businessId: string,
  appointmentId: string,
  next: "confirmed" | "declined",
): Promise<Appointment | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    UPDATE appointments SET status = ${next}
    WHERE id = ${appointmentId} AND business_id = ${businessId}
      AND status IN ('requested', 'declined')
    RETURNING *`;
  return (rows[0] as unknown as Appointment | undefined) ?? null;
}

export async function deleteAppointment(businessId: string, appointmentId: string): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`DELETE FROM appointments WHERE id = ${appointmentId} AND business_id = ${businessId} RETURNING id`;
  return rows.length > 0;
}
