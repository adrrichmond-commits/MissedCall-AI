/**
 * Server-only queries: P4-A funnel events (migration 019).
 *
 * One row per (business, stage) — the FIRST time the stage happened. The
 * unique index is the idempotency boundary: recording a stage a business has
 * already reached is a no-op, so hooks can fire on every relevant request
 * without inflating the funnel. ISOLATION RULE: writes take `businessId` and
 * filter on it; the aggregate read is deliberately cross-business (admin
 * view) and labeled as such.
 */
import type { FunnelStage } from "../schema";
import { assertServer, sql } from "./shared";

/**
 * Record the first occurrence of a funnel stage for a business. Returns true
 * when this call was the first occurrence (row inserted), false when the
 * business had already reached the stage.
 */
export async function recordFunnelEvent(businessId: string, stage: FunnelStage): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`
    INSERT INTO funnel_events (business_id, stage)
    VALUES (${businessId}, ${stage})
    ON CONFLICT (business_id, stage) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Whether a business has reached a stage (cheap gate for UI hints). */
export async function hasReachedFunnelStage(businessId: string, stage: FunnelStage): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT 1 FROM funnel_events
    WHERE business_id = ${businessId} AND stage = ${stage}
    LIMIT 1`;
  return rows.length > 0;
}

export interface FunnelAggregate {
  /** Businesses per stage, every business (including demo). */
  all: Record<FunnelStage, number>;
  /** Businesses per stage excluding businesses flagged is_demo (seed data). */
  real: Record<FunnelStage, number>;
  demoCount: number;
}

/**
 * Cross-business stage counts for the admin funnel view (deliberately not
 * business-scoped — this is the platform owner's view). Demo businesses are
 * counted separately so the admin page can show real onboarding numbers
 * honestly alongside the seed business's rows.
 */
export async function funnelStageCounts(): Promise<FunnelAggregate> {
  assertServer();
  const db = sql();
  const rows = (await db`
    SELECT fe.stage, COUNT(*)::int AS n,
           BOOL_OR(b.is_demo) AS any_demo
    FROM funnel_events fe
    JOIN businesses b ON b.id = fe.business_id
    GROUP BY fe.stage`) as unknown as { stage: string; n: number; any_demo: boolean }[];
  const demoRows = (await db`
    SELECT COUNT(*)::int AS n FROM businesses WHERE is_demo = true`) as unknown as { n: number }[];
  const all = emptyCounts();
  const real = emptyCounts();
  for (const r of rows) {
    if (r.stage in all) {
      all[r.stage as FunnelStage] = Number(r.n);
      if (!r.any_demo) real[r.stage as FunnelStage] = Number(r.n);
    }
  }
  return { all, real, demoCount: Number(demoRows[0]?.n ?? 0) };
}

function emptyCounts(): Record<FunnelStage, number> {
  return {
    signup: 0,
    trial_start: 0,
    onboarding_completed: 0,
    phone_connected: 0,
    first_lead: 0,
    first_recovered_call: 0,
    paid: 0,
  };
}
