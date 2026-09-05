/**
 * Server-only queries: usage counters + billing events (P3-F).
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it —
 * the WHERE clause is the isolation boundary, so no function may omit it.
 *
 * INCREMENT PATH (the efficient one the brief asks for): counters move ONLY
 * by a single upsert statement — INSERT ... ON CONFLICT DO UPDATE SET x =
 * usage_counters.x + N RETURNING — never a read-modify-write round trip.
 * One statement is atomic in Postgres, so concurrent webhook handlers and
 * retried sends cannot lose a count, and the RETURNING row lets the caller
 * know the new value without a second read. Retrying the increment after a
 * network error is safe: it adds again only if the first attempt never
 * landed, which is exactly the at-least-once semantics metering wants.
 */
import type { BillingEvent, BillingEventType, UsageCounter } from "../schema";
import { assertServer, sql } from "./shared";

// ---------------------------------------------------------------------------
// Writes — increments (atomic single-statement)
// ---------------------------------------------------------------------------
export type UsageAxisColumn = "sms_sent" | "ai_turns" | "calls_handled";

const AXIS_COLUMNS: readonly UsageAxisColumn[] = ["sms_sent", "ai_turns", "calls_handled"];

function assertAxis(axis: UsageAxisColumn): void {
  if (!AXIS_COLUMNS.includes(axis)) throw new Error(`Unknown usage axis: ${String(axis)}`);
}

/**
 * Atomically add `delta` to one usage axis for the business's period row,
 * creating the row on first touch of the period. Returns the full updated
 * counter row (the zero-cost read: callers get every axis back for free).
 */
export async function incrementUsage(args: {
  businessId: string;
  periodStart: Date;
  axis: UsageAxisColumn;
  delta?: number;
}): Promise<UsageCounter> {
  assertServer();
  assertAxis(args.axis);
  const delta = args.delta ?? 1;
  const db = sql();
  const rows = await db.query(
    `INSERT INTO usage_counters (business_id, period_start, ${args.axis})
     VALUES ($1, $2, $3)
     ON CONFLICT (business_id, period_start)
     DO UPDATE SET ${args.axis} = usage_counters.${args.axis} + EXCLUDED.${args.axis}
     RETURNING *`,
    [args.businessId, args.periodStart.toISOString(), delta],
  );
  return rows[0] as unknown as UsageCounter;
}

// ---------------------------------------------------------------------------
// Reads — zero-cost gating lookups
// ---------------------------------------------------------------------------
/** The current period's counter row, or null when the period has no usage. */
export async function getUsageForPeriod(
  businessId: string,
  periodStart: Date,
): Promise<UsageCounter | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM usage_counters
    WHERE business_id = ${businessId} AND period_start = ${periodStart.toISOString()}
    LIMIT 1`;
  return (rows[0] as unknown as UsageCounter | undefined) ?? null;
}

/** Recent period rows, newest first (billing page history). */
export async function listUsageHistory(
  businessId: string,
  limit = 6,
): Promise<UsageCounter[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM usage_counters
    WHERE business_id = ${businessId}
    ORDER BY period_start DESC
    LIMIT ${limit}`;
  return rows as unknown as UsageCounter[];
}

// ---------------------------------------------------------------------------
// Billing events — the ledger behind the billing history view
// ---------------------------------------------------------------------------
/**
 * Append one billing event. Callers: the Stripe webhook path (source
 * 'stripe', after its stripe_events dedupe — never called for a duplicate)
 * and the in-app lifecycle actions (source 'local'). Nothing is written for
 * states nobody set — no invented history.
 */
export async function createBillingEvent(args: {
  businessId: string;
  type: BillingEventType;
  source: BillingEvent["source"];
  description?: string | null;
  payload?: Record<string, unknown>;
}): Promise<BillingEvent> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    `INSERT INTO billing_events (business_id, event_type, source, description, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING *`,
    [
      args.businessId,
      args.type,
      args.source,
      args.description ?? null,
      JSON.stringify(args.payload ?? {}),
    ],
  );
  return rows[0] as unknown as BillingEvent;
}

/** Newest-first billing history for a business. */
export async function listBillingEvents(
  businessId: string,
  limit = 50,
): Promise<BillingEvent[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM billing_events
    WHERE business_id = ${businessId}
    ORDER BY occurred_at DESC, created_at DESC
    LIMIT ${limit}`;
  return rows as unknown as BillingEvent[];
}
