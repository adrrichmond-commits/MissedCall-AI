/**
 * Server-only queries: P5-6 admin business metrics (cross-business).
 *
 * ISOLATION NOTE — deliberately cross-business like src/db/queries/admin.ts:
 * every function here is reachable ONLY through the admin gate
 * (src/lib/server/admin.ts requirePlatformAdmin), which verifies the session
 * user's is_platform_admin flag from the DB. The functions take sanitized
 * filter params (whitelisted plan/window from src/lib/server/adminMetrics.ts)
 * and never a businessId — there is no per-business read on this surface.
 * Not re-exported through index.ts. Read-only: no INSERT/UPDATE/DELETE here.
 *
 * Demo businesses (seed data, migration 018) are excluded from trial metrics
 * and attention lists, matching the P4-A funnel view's real-vs-demo rule.
 *
 * All statements use db.query() with per-statement $n params (Neon typed-param
 * safety, the P5-5 lesson) and explicit ::casts. Counts come back ::int.
 */
import type {
  AdminAttentionItem,
  AdminMetricsFilters,
  AdminMetricsRaw,
  AdminPlanStatusCount,
} from "~/lib/server/adminMetrics";
import {
  TRIAL_ENDING_SOON_DAYS,
  ZERO_ACTIVITY_MIN_AGE_DAYS,
  adminMetricWindowDays,
} from "~/lib/server/adminMetrics";
import { assertServer, sql } from "./shared";

type Row = Record<string, unknown>;

const isoOrNull = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The plan filter as a SQL param: null = all plans (whitelisted upstream). */
function planParam(filters: AdminMetricsFilters): string | null {
  return filters.plan === "all" ? null : filters.plan;
}

/**
 * The full metrics read, one connection round-trip set per call. Every query
 * is scoped by the sanitized plan filter where a plan column exists; the
 * window applies to calls + signups. Demo businesses never appear in trial
 * metrics or attention lists.
 */
export async function adminMetricsRaw(
  filters: AdminMetricsFilters,
  now: Date,
): Promise<AdminMetricsRaw> {
  assertServer();
  const db = sql();
  const plan = planParam(filters);
  const windowDays = adminMetricWindowDays(filters.window);

  const [statusRows, signupRows, callRows, funnelRows, activeTrialRows, endingSoonRows, expiredRows, zeroRows, demoRows] =
    await Promise.all([
      // 1. (plan, subscription_status) account grid — the MRR/distribution base.
      db.query(
        `SELECT b.plan::text AS plan, b.subscription_status AS "subscriptionStatus",
                count(*)::int AS n
         FROM businesses b
         WHERE ($1::text IS NULL OR b.plan::text = $1::text)
         GROUP BY 1, 2`,
        [plan],
      ),
      // 2. New signups inside the window (null window → null count, not 0).
      db.query(
        `SELECT count(*)::int AS n
         FROM businesses b
         WHERE ($1::timestamptz IS NULL OR b.created_at >= $1::timestamptz)
           AND ($2::text IS NULL OR b.plan::text = $2::text)`,
        [windowDays === null ? null : new Date(now.getTime() - windowDays * 24 * 60 * 60_000), plan],
      ),
      // 3. Voice calls processed in the window (+ how many businesses).
      db.query(
        `SELECT count(*)::int AS n, count(DISTINCT b.id)::int AS biz
         FROM calls c
         JOIN businesses b ON b.id = c.business_id
         WHERE ($1::timestamptz IS NULL OR c.created_at >= $1::timestamptz)
           AND ($2::text IS NULL OR b.plan::text = $2::text)`,
        [windowDays === null ? null : new Date(now.getTime() - windowDays * 24 * 60 * 60_000), plan],
      ),
      // 4. P4-A funnel events (first-occurrence rows), demo excluded.
      db.query(
        `SELECT fe.stage::text AS stage, count(*)::int AS n
         FROM funnel_events fe
         JOIN businesses b ON b.id = fe.business_id
         WHERE b.is_demo = false AND fe.stage IN ('trial_start', 'paid')
         GROUP BY 1`,
        [],
      ),
      // 5. Active trials: plan='trial' with the window not lapsed (or unset).
      db.query(
        `SELECT count(*)::int AS n
         FROM businesses b
         WHERE b.plan::text = 'trial'
           AND b.is_demo = false
           AND (b.trial_ends_at IS NULL OR b.trial_ends_at >= $1::timestamptz)
           AND ($2::text IS NULL OR b.plan::text = $2::text)`,
        [now, plan],
      ),
      // 6. Trials ending soon (within TRIAL_ENDING_SOON_DAYS), demo excluded.
      db.query(
        `SELECT b.id AS "businessId", b.name, b.trial_ends_at AS at
         FROM businesses b
         WHERE b.plan::text = 'trial'
           AND b.is_demo = false
           AND b.trial_ends_at IS NOT NULL
           AND b.trial_ends_at >= $1::timestamptz
           AND b.trial_ends_at <= $1::timestamptz + make_interval(days => $2::int)
           AND ($3::text IS NULL OR b.plan::text = $3::text)
         ORDER BY b.trial_ends_at ASC
         LIMIT 50`,
        [now, TRIAL_ENDING_SOON_DAYS, plan],
      ),
      // 7. Expired trials never converted (plan still 'trial'), demo excluded.
      db.query(
        `SELECT b.id AS "businessId", b.name, b.trial_ends_at AS at
         FROM businesses b
         WHERE b.plan::text = 'trial'
           AND b.is_demo = false
           AND b.trial_ends_at IS NOT NULL
           AND b.trial_ends_at < $1::timestamptz
           AND ($2::text IS NULL OR b.plan::text = $2::text)
         ORDER BY b.trial_ends_at ASC
         LIMIT 50`,
        [now, plan],
      ),
      // 8. Zero activity since signup: old enough, and no leads, calls,
      //    conversations, appointments, or user logins ever. Demo excluded.
      db.query(
        `SELECT b.id AS "businessId", b.name, b.created_at AS at
         FROM businesses b
         WHERE b.is_demo = false
           AND b.created_at <= $1::timestamptz - make_interval(days => $2::int)
           AND ($3::text IS NULL OR b.plan::text = $3::text)
           AND NOT EXISTS (SELECT 1 FROM leads l WHERE l.business_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM calls c WHERE c.business_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM conversations v WHERE v.business_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.business_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM users u WHERE u.business_id = b.id AND u.last_login_at IS NOT NULL)
         ORDER BY b.created_at ASC
         LIMIT 50`,
        [now, ZERO_ACTIVITY_MIN_AGE_DAYS, plan],
      ),
      // 9. Demo businesses (disclosed separately, never counted in the above).
      db.query(`SELECT count(*)::int AS n FROM businesses WHERE is_demo = true`, []),
    ]);

  const attention = (rows: Row[]): AdminAttentionItem[] =>
    rows.map((r) => ({
      businessId: String(r.businessId),
      name: String(r.name),
      at: isoOrNull(r.at) ?? new Date(0).toISOString(),
    }));

  const trialStarts = num((funnelRows as Row[]).find((r) => r.stage === "trial_start")?.n);
  const paid = num((funnelRows as Row[]).find((r) => r.stage === "paid")?.n);

  const planStatusCounts: AdminPlanStatusCount[] = (statusRows as Row[]).map((r) => ({
    plan: String(r.plan),
    subscriptionStatus: r.subscriptionStatus === null || r.subscriptionStatus === undefined ? null : String(r.subscriptionStatus),
    n: num(r.n),
  }));

  return {
    planStatusCounts,
    totalAccounts: planStatusCounts.reduce((acc, r) => acc + r.n, 0),
    signupsInWindow: windowDays === null ? null : num((signupRows as Row[])[0]?.n),
    callsInWindow: num((callRows as Row[])[0]?.n),
    callsBusinesses: num((callRows as Row[])[0]?.biz),
    trialStarts,
    paidAccounts: paid,
    activeTrials: num((activeTrialRows as Row[])[0]?.n),
    trialEndingSoon: attention(endingSoonRows as Row[]),
    trialsExpiredNotConverted: attention(expiredRows as Row[]),
    zeroActivity: attention(zeroRows as Row[]),
    demoCount: num((demoRows as Row[])[0]?.n),
  };
}
