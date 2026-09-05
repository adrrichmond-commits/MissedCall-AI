/**
 * Server-only queries: Revenue Recovered analytics (P3-D).
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it —
 * the WHERE clause is the isolation boundary, so no function may omit it.
 *
 * NO MIGRATION: everything here reads columns migration 011 already shipped
 * (leads.pipeline_value_cents + converted_at; the partial index
 * leads_business_pipeline_idx ON leads(business_id, pipeline_value_cents)
 * WHERE pipeline_value_cents IS NOT NULL covers the money query's hot path).
 *
 * The period math ("this week"/"this month" in the business's timezone) lives
 * ONLY in src/lib/server/revenue.ts — won-lead rows are fetched and bucketed
 * through bucketForPeriod, so there is exactly one definition of the period
 * boundaries and it is unit-tested DBless. SQL supplies plain row aggregates.
 */
import { assertServer, sql, toNumber } from "./shared";
import {
  bucketForPeriod,
  computePeriodBounds,
  computeRevenueMetrics,
  funnelStages,
  type FunnelCounts,
  type RevenueMetrics,
} from "../../lib/server/revenue";

// ---------------------------------------------------------------------------
// Revenue Recovered — the primary KPI
// ---------------------------------------------------------------------------

/** The money query: one aggregate pass over the business's leads. */
async function leadAggregates(
  businessId: string,
): Promise<{
  totalLeads: number;
  leadsWithValue: number;
  wonRows: { convertedAt: Date; cents: number }[];
}> {
  assertServer();
  const db = sql();
  const [countsRows, wonRows] = await Promise.all([
    db`
      SELECT
        count(*) AS total_leads,
        count(*) FILTER (WHERE pipeline_value_cents IS NOT NULL) AS leads_with_value
      FROM leads
      WHERE business_id = ${businessId}`,
    // Won leads only: the recovered-revenue set. At plumber scale (hundreds
    // of won jobs) bucketing in JS is cheap and keeps period math in the
    // tested engine instead of duplicated in SQL.
    db`
      SELECT converted_at, pipeline_value_cents
      FROM leads
      WHERE business_id = ${businessId}
        AND status = 'won'
        AND pipeline_value_cents IS NOT NULL`,
  ]);
  const c = countsRows[0] as unknown as Record<string, unknown>;
  const rows = wonRows as unknown as { converted_at: Date; pipeline_value_cents: unknown }[];
  return {
    totalLeads: toNumber(c.total_leads),
    leadsWithValue: toNumber(c.leads_with_value),
    wonRows: rows.map((r) => ({
      convertedAt: new Date(r.converted_at),
      cents: toNumber(r.pipeline_value_cents),
    })),
  };
}

/**
 * Missed-call recovery counts — the SAME definition the Phase 2 analytics
 * page ships (leads from missed calls; recovered = ≥1 SMS conversation), so
 * every surface reports identical numbers.
 */
export async function missedCallRecoveryCounts(
  businessId: string,
): Promise<{ missedCalls: number; recovered: number }> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT
      count(*) AS missed_calls,
      count(c.lead_id) AS recovered
    FROM leads l
    LEFT JOIN (
      SELECT DISTINCT lead_id FROM conversations
      WHERE lead_id IS NOT NULL AND business_id = ${businessId}
    ) c ON c.lead_id = l.id
    WHERE l.business_id = ${businessId} AND l.source = 'missed_call'`;
  const r = rows[0] as unknown as Record<string, unknown>;
  return { missedCalls: toNumber(r.missed_calls), recovered: toNumber(r.recovered) };
}

/** Appointment rows tied to recovered missed-call leads (business-scoped). */
export async function appointmentsFromRecoveredLeads(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT count(*) AS n
    FROM appointments a
    WHERE a.business_id = ${businessId}
      AND a.lead_id IN (
        SELECT l.id FROM leads l
        WHERE l.business_id = ${businessId}
          AND l.source = 'missed_call'
          AND EXISTS (
            SELECT 1 FROM conversations c
            WHERE c.lead_id = l.id AND c.business_id = ${businessId}
          )
      )`;
  return toNumber((rows[0] as unknown as Record<string, unknown>).n);
}

/**
 * The Revenue Recovered metric set for one business. `timezone` is the
 * business's IANA zone (from the businesses row — never client input);
 * null/unusable zones fall back to UTC inside the engine.
 */
export async function revenueMetrics(
  businessId: string,
  timezone: string | null,
): Promise<RevenueMetrics> {
  assertServer();
  const now = new Date();
  const bounds = computePeriodBounds(now, timezone);
  const [agg, recovery, apptFromRecovered] = await Promise.all([
    leadAggregates(businessId),
    missedCallRecoveryCounts(businessId),
    appointmentsFromRecoveredLeads(businessId),
  ]);
  const week = { wonLeads: 0, recoveredCents: 0 };
  const month = { wonLeads: 0, recoveredCents: 0 };
  const allTime = { wonLeads: 0, recoveredCents: 0 };
  for (const row of agg.wonRows) {
    // Non-finite converted_at buckets to null and is skipped — the engine
    // treats an unreadable instant as "no period", never as an error.
    const b = bucketForPeriod(row.convertedAt, bounds);
    allTime.wonLeads += 1;
    allTime.recoveredCents += row.cents;
    if (b === "week") {
      week.wonLeads += 1;
      week.recoveredCents += row.cents;
    }
    if (b === "month") {
      month.wonLeads += 1;
      month.recoveredCents += row.cents;
    }
  }
  return computeRevenueMetrics({
    week,
    month,
    allTime,
    leadsWithValue: agg.leadsWithValue,
    totalLeads: agg.totalLeads,
    missedCalls: recovery.missedCalls,
    recoveredMissedCalls: recovery.recovered,
    appointmentsFromRecovered: apptFromRecovered,
  });
}

// ---------------------------------------------------------------------------
// Funnel — captured calls → won jobs (used by the dashboard and P4-A later)
// ---------------------------------------------------------------------------

export async function revenueFunnelCounts(businessId: string): Promise<FunnelCounts> {
  assertServer();
  const db = sql();
  const [leadRows, convRows, apptRows] = await Promise.all([
    db`
      SELECT
        count(*) AS leads,
        count(*) FILTER (WHERE source = 'missed_call') AS missed_calls,
        count(*) FILTER (
          WHERE source = 'missed_call' AND EXISTS (
            SELECT 1 FROM conversations c
            WHERE c.lead_id = leads.id AND c.business_id = ${businessId}
          )
        ) AS missed_recovered,
        count(*) FILTER (
          WHERE status IN ('qualified', 'appointment_scheduled', 'won')
        ) AS qualified,
        count(*) FILTER (WHERE status = 'won') AS won
      FROM leads
      WHERE business_id = ${businessId}`,
    db`
      SELECT count(*) AS handled
      FROM conversations c
      WHERE c.business_id = ${businessId}
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id
            AND m.direction = 'outbound'
            AND m.classification->>'replySource' IS NOT NULL
        )
        AND EXISTS (
          SELECT 1 FROM leads l
          WHERE l.id = c.lead_id AND l.business_id = ${businessId}
            AND l.source = 'missed_call'
        )`,
    db`
      SELECT count(DISTINCT lead_id) AS appt_leads
      FROM appointments
      WHERE business_id = ${businessId} AND lead_id IS NOT NULL`,
  ]);
  const lr = leadRows[0] as unknown as Record<string, unknown>;
  const cr = convRows[0] as unknown as Record<string, unknown>;
  const ar = apptRows[0] as unknown as Record<string, unknown>;
  const missedCalls = toNumber(lr.missed_calls);
  return {
    // Until the P3-E voice receptionist exists, every call the system sees is
    // a missed call — callsReceived mirrors missedCalls (documented in
    // revenue.ts) and splits apart when voice lands. No fake numbers.
    callsReceived: missedCalls,
    callsHandledByAi: toNumber(cr.handled),
    missedCalls,
    missedCallsRecovered: toNumber(lr.missed_recovered),
    leads: toNumber(lr.leads),
    qualified: toNumber(lr.qualified),
    appointments: toNumber(ar.appt_leads),
    won: toNumber(lr.won),
  };
}

/**
 * The dashboard revenue card payload: metrics + funnel + ordered stages in
 * one call, so the server fn makes exactly this one query-module call.
 */
export async function revenueDashboardPayload(
  businessId: string,
  timezone: string | null,
): Promise<{ metrics: RevenueMetrics; funnel: FunnelCounts; stages: ReturnType<typeof funnelStages> }> {
  assertServer();
  const [metrics, funnel] = await Promise.all([
    revenueMetrics(businessId, timezone),
    revenueFunnelCounts(businessId),
  ]);
  return { metrics, funnel, stages: funnelStages(funnel) };
}
