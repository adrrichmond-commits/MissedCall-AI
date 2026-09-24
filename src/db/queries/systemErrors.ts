/**
 * Server-only queries for system_errors (P4-I in-app error sink).
 *
 * ISOLATION NOTE (deliberate, mirrors admin_audit): system_errors is a
 * PLATFORM-level observability table. insertSystemError filters nothing
 * (it inserts what the caller captured — businessId comes from the error's
 * runtime context, never from client input); listRecentSystemErrors and
 * countRecentSystemErrors are cross-business and are consumed ONLY by the
 * platform-admin /admin/health surface (adminReads.ts, gated by
 * is_platform_admin) and the unauthenticated readiness probe (which exposes
 * a COUNT only, never rows). No customer-facing path reads this table.
 */
import { assertServer } from "./shared";
import { sql } from "./shared";
import type { SystemError } from "~/db/schema";
export interface InsertSystemErrorInput {
  source: string;
  severity?: "error" | "warning";
  message: string;
  businessId?: string | null;
  detail?: Record<string, unknown>;
}
/** Insert one error row. Called by src/lib/server/errorSink.ts (best-effort). */
export async function insertSystemError(input: InsertSystemErrorInput): Promise<SystemError> {
  assertServer();
  const rows = (await sql()`INSERT INTO system_errors (business_id, source, severity, message, detail)
    VALUES (${input.businessId ?? null}, ${input.source}, ${input.severity ?? "error"}, ${input.message}, ${JSON.stringify(input.detail ?? {})}::jsonb)
    RETURNING *`) as unknown as SystemError[];
  return rows[0] as SystemError;
}
/** Recent errors, newest first — /admin/health (platform admin only). */
export async function listRecentSystemErrors(limit = 25): Promise<SystemError[]> {
  assertServer();
  const capped = Math.max(1, Math.min(limit, 100));
  const rows = (await sql()`SELECT * FROM system_errors ORDER BY created_at DESC LIMIT ${capped}`) as unknown as SystemError[];
  return rows;
}
/** Error count inside the trailing window (minutes) — readiness probe. */
export async function countRecentSystemErrors(minutes = 60): Promise<number> {
  assertServer();
  const rows = (await sql()`SELECT count(*)::int AS n FROM system_errors WHERE created_at > now() - (${minutes} || ' minutes')::interval`) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}
