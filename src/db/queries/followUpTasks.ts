/**
 * Server-only queries: follow-up tasks (P3-C callback queue).
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it —
 * the WHERE clause is the isolation boundary, so no function may omit it.
 *
 * No scheduler, no cron: the dashboard's open-task list IS the surface.
 * Tasks are created by the lead-capture path ('lead_new'), by the
 * follow_up_needed status transition ('status_follow_up'), and by the
 * business itself ('manual'). They are linked to a lead (CASCADE on lead
 * delete) so the dashboard rows are always actionable callbacks.
 */
import type { FollowUpTask } from "../schema";
import { assertServer, listClause, sql, type ListOptions } from "./shared";

export type FollowUpTaskReason = FollowUpTask["createdReason"];

export interface CreateFollowUpTaskInput {
  leadId: string;
  /** UTC instant. Use nextBusinessDayAt9() for the auto-created default. */
  dueAt: Date;
  createdReason: FollowUpTaskReason;
  note?: string | null;
}

export async function createFollowUpTask(
  businessId: string,
  input: CreateFollowUpTaskInput,
): Promise<FollowUpTask> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    `INSERT INTO follow_up_tasks (business_id, lead_id, due_at, done, created_reason, note)
     VALUES ($1, $2, $3, false, $4, $5)
     RETURNING *`,
    [businessId, input.leadId, input.dueAt.toISOString(), input.createdReason, input.note ?? null],
  );
  return rows[0] as unknown as FollowUpTask;
}

export interface FollowUpTaskWithLead extends FollowUpTask {
  /** Denormalized for the dashboard rows (single query, no N+1). */
  leadName: string;
  leadPhone: string;
  leadStatus: string;
  serviceNeed: string;
}

export interface FollowUpFilters {
  done?: boolean;
}

/**
 * Open (or completed) tasks with their lead's display fields, oldest-due
 * first — the dashboard queue reads exactly this.
 */
export async function listFollowUpTasks(
  businessId: string,
  filters: FollowUpFilters = {},
  opts?: ListOptions,
): Promise<FollowUpTaskWithLead[]> {
  assertServer();
  const db = sql();
  const { limit, offset, order } = listClause(opts);
  const dir = order === "asc" ? "ASC" : "DESC";
  const values: unknown[] = [businessId];
  const clauses = ["business_id = $1"];
  if (filters.done != null) {
    values.push(filters.done);
    clauses.push(`done = $${values.length}`);
  }
  const rows = await db.query(
    `SELECT t.*, l.contact_name AS lead_name, l.contact_phone AS lead_phone,
            l.status AS lead_status, l.service_need AS service_need
     FROM follow_up_tasks t
     INNER JOIN leads l ON l.id = t.lead_id AND l.business_id = t.business_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY t.due_at ${dir}, t.created_at ASC
     LIMIT ${limit} OFFSET ${offset}`,
    values,
  );
  return rows as unknown as FollowUpTaskWithLead[];
}

export async function countFollowUpTasks(
  businessId: string,
  filters: FollowUpFilters = {},
): Promise<number> {
  assertServer();
  const db = sql();
  const values: unknown[] = [businessId];
  const clauses = ["business_id = $1"];
  if (filters.done != null) {
    values.push(filters.done);
    clauses.push(`done = $${values.length}`);
  }
  const rows = await db.query(`SELECT count(*) AS n FROM follow_up_tasks WHERE ${clauses.join(" AND ")}`, values);
  return Number((rows[0] as unknown as { n: unknown }).n);
}

export async function getFollowUpTask(
  businessId: string,
  taskId: string,
): Promise<FollowUpTask | null> {
  assertServer();
  const db = sql();
  const rows =
    await db`SELECT * FROM follow_up_tasks WHERE id = ${taskId} AND business_id = ${businessId} LIMIT 1`;
  return (rows[0] as unknown as FollowUpTask | undefined) ?? null;
}

/**
 * Stamp a task done (or reopen it). Returns the updated row or null when the
 * task doesn't exist in this business — never crosses the isolation boundary.
 */
export async function setFollowUpTaskDone(
  businessId: string,
  taskId: string,
  done: boolean,
): Promise<FollowUpTask | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    UPDATE follow_up_tasks
    SET done = ${done}, done_at = ${done ? new Date().toISOString() : null}
    WHERE id = ${taskId} AND business_id = ${businessId}
    RETURNING *`;
  return (rows[0] as unknown as FollowUpTask | undefined) ?? null;
}
