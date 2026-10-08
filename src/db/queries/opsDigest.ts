/**
 * Server-only queries: the WEEKLY OPS DIGEST read (cross-business).
 *
 * ISOLATION NOTE — deliberately cross-business like src/db/queries/adminMetrics.ts:
 * the digest reports the STATE OF THE PLATFORM to THE platform owner, so every
 * function here is reachable ONLY from the ops digest sweep
 * (src/lib/server/opsDigestSweep.ts), which itself resolves the recipient from
 * users.is_platform_admin and runs inside the CRON_SECRET-gated cron route.
 * No client input reaches any statement here. Read-only: no INSERT/UPDATE/DELETE.
 *
 * HONESTY CONTRACT: every number is what the DB holds — no estimates, no
 * padding, no invented rows. A zero is returned as zero and rendered as an
 * honest empty state ("No new leads this week"), never dressed up.
 *
 * Demo businesses (seed data, migration 018) are excluded everywhere, matching
 * the P5-6 admin-metrics real-vs-demo convention.
 *
 * Trial/conversion counts reuse the P5-6 shared read (funnelTrialPaidCounts)
 * so the digest and /admin/metrics can never drift on what counts as a trial
 * start or a conversion.
 */
import { funnelTrialPaidCounts } from "./adminMetrics";
import { assertServer, sql } from "./shared";

type Row = Record<string, unknown>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export interface OpsDigestAttentionItem {
  businessId: string;
  name: string;
  /** Type-specific detail (line-test status detail, handoff reason, plan). */
  detail: string | null;
}

export interface OpsDigestLineRollup {
  /** Non-demo businesses on the platform. */
  businesses: number;
  /** Businesses with a non-empty businesses.phone. */
  withPhone: number;
  /** Latest line-test status rollup (businesses.settings->'lineTest'->>'status'). */
  lineTest: { pass: number; partial: number; fail: number; notConfigured: number; running: number; neverRun: number };
}

export interface OpsDigestRaw {
  /** ISO instant the read was taken. */
  generatedAt: string;
  /** Trials — P5-6 shared reads, demo excluded. */
  trials: {
    /** plan='trial' and the trial window has not lapsed (or unset). */
    active: number;
    /** funnel_events stage='trial_start' to date. */
    startsToDate: number;
    /** funnel_events stage='paid' to date. */
    paidToDate: number;
    /** funnel_events stage='trial_start' inside the 7-day window. */
    startsThisWeek: number;
  };
  /** Leads — this week (leads.created_at in window), demo excluded. */
  leads: {
    total: number;
    bySource: Record<string, number>;
  };
  /** Appointments created this week by current status, demo excluded. */
  appointments: { requested: number; confirmed: number };
  /** Attention lists — real problems only, empty means empty. */
  attention: {
    /** subscription_status='past_due' (invoice.payment_failed marks this). */
    paymentFailures: OpsDigestAttentionItem[];
    /** conversations.handoff_status='needed' — flagged, still waiting for a human. */
    takeoversWaiting: OpsDigestAttentionItem[];
    /** Latest line test per business came back fail. */
    failedLineTests: OpsDigestAttentionItem[];
  };
  /** Phone line rollup across non-demo businesses. */
  lines: OpsDigestLineRollup;
}

/**
 * The full ops-digest read. `windowStart` (inclusive) bounds the "this week"
 * counts; lifetime figures are unbounded. Demo businesses never appear.
 */
export async function opsDigestRaw(windowStart: Date, now: Date): Promise<OpsDigestRaw> {
  assertServer();
  const db = sql();

  const [
    activeTrialRows,
    trialStartWeekRows,
    funnel,
    leadTotalRows,
    leadSourceRows,
    apptRows,
    pastDueRows,
    takeoverRows,
    lineFailRows,
    lineRollupRows,
  ] = await Promise.all([
    // 1. Active trials: plan='trial' with the window not lapsed (or unset) —
    //    the P5-6 active-trial rule verbatim (demo excluded).
    db.query(
      `SELECT count(*)::int AS n
       FROM businesses b
       WHERE b.plan::text = 'trial'
         AND b.is_demo = false
         AND (b.trial_ends_at IS NULL OR b.trial_ends_at >= $1::timestamptz)`,
      [now],
    ),
    // 2. Trial starts inside the window (funnel_events, demo excluded).
    db.query(
      `SELECT count(*)::int AS n
       FROM funnel_events fe
       JOIN businesses b ON b.id = fe.business_id
       WHERE b.is_demo = false AND fe.stage = 'trial_start'
         AND fe.created_at >= $1::timestamptz`,
      [windowStart],
    ),
    // 3. Trial starts + conversions TO DATE — the P5-6 SHARED read so the
    //    digest and /admin/metrics can never drift.
    funnelTrialPaidCounts(),
    // 4. New leads in the window, demo excluded.
    db.query(
      `SELECT count(*)::int AS n
       FROM leads l
       JOIN businesses b ON b.id = l.business_id
       WHERE b.is_demo = false AND l.created_at >= $1::timestamptz`,
      [windowStart],
    ),
    // 5. New leads in the window by source.
    db.query(
      `SELECT l.source::text AS source, count(*)::int AS n
       FROM leads l
       JOIN businesses b ON b.id = l.business_id
       WHERE b.is_demo = false AND l.created_at >= $1::timestamptz
       GROUP BY 1`,
      [windowStart],
    ),
    // 6. Appointments CREATED in the window by current status (requested /
    //    confirmed are the two that matter to the owner; a row created as a
    //    request and since confirmed shows under confirmed — the status the
    //    DB holds now, not a guess about the past).
    db.query(
      `SELECT a.status::text AS status, count(*)::int AS n
       FROM appointments a
       JOIN businesses b ON b.id = a.business_id
       WHERE b.is_demo = false AND a.created_at >= $1::timestamptz
         AND a.status::text IN ('requested', 'confirmed')
       GROUP BY 1`,
      [windowStart],
    ),
    // 7. Payment failures: past_due accounts (invoice.payment_failed marks
    //    subscription_status='past_due' — stripeWebhook.ts handlePaymentFailed).
    db.query(
      `SELECT b.id AS "businessId", b.name, b.plan::text AS detail
       FROM businesses b
       WHERE b.is_demo = false AND b.subscription_status = 'past_due'
       ORDER BY b.name ASC
       LIMIT 50`,
      [],
    ),
    // 8. Takeovers still waiting: handoff_status='needed' (flagged for a
    //    human, nobody has taken over — 'human' means already handled).
    db.query(
      `SELECT c.business_id AS "businessId", b.name,
              c.handoff_reason AS detail
       FROM conversations c
       JOIN businesses b ON b.id = c.business_id
       WHERE b.is_demo = false AND c.handoff_status = 'needed'
       ORDER BY c.handoff_at ASC NULLS LAST
       LIMIT 50`,
      [],
    ),
    // 9. Failed line tests (latest stored run per business says 'fail') —
    //    PR #54's businesses.settings->'lineTest' shape, read defensively.
    db.query(
      `SELECT b.id AS "businessId", b.name,
              b.settings->'lineTest'->>'status' AS detail
       FROM businesses b
       WHERE b.is_demo = false
         AND b.settings->'lineTest'->>'status' = 'fail'
       ORDER BY b.name ASC
       LIMIT 50`,
      [],
    ),
    // 10. Line rollup: businesses, phone-assigned, and the latest line-test
    //     status per business in one pass (single jsonb column = latest run).
    db.query(
      `SELECT count(*)::int AS businesses,
              count(*) FILTER (WHERE b.phone IS NOT NULL AND btrim(b.phone) <> '')::int AS "withPhone",
              count(*) FILTER (WHERE b.settings->'lineTest'->>'status' = 'pass')::int AS pass,
              count(*) FILTER (WHERE b.settings->'lineTest'->>'status' = 'partial')::int AS partial,
              count(*) FILTER (WHERE b.settings->'lineTest'->>'status' = 'fail')::int AS fail,
              count(*) FILTER (WHERE b.settings->'lineTest'->>'status' = 'not_configured')::int AS "notConfigured",
              count(*) FILTER (WHERE b.settings->'lineTest'->>'status' = 'running')::int AS running,
              count(*) FILTER (WHERE b.settings->'lineTest'->>'status' IS NULL
                                 OR b.settings->'lineTest'->>'status' = '')::int AS "neverRun"
       FROM businesses b
       WHERE b.is_demo = false`,
      [],
    ),
  ]);

  const bySource: Record<string, number> = {};
  for (const r of leadSourceRows as Row[]) bySource[String(r.source)] = num(r.n);

  const apptByStatus: Record<string, number> = {};
  for (const r of apptRows as Row[]) apptByStatus[String(r.status)] = num(r.n);

  const rollup = (lineRollupRows as Row[])[0] ?? {};

  return {
    generatedAt: now.toISOString(),
    trials: {
      active: num((activeTrialRows as Row[])[0]?.n),
      startsToDate: funnel.trialStarts,
      paidToDate: funnel.paidAccounts,
      startsThisWeek: num((trialStartWeekRows as Row[])[0]?.n),
    },
    leads: { total: num((leadTotalRows as Row[])[0]?.n), bySource },
    appointments: { requested: apptByStatus["requested"] ?? 0, confirmed: apptByStatus["confirmed"] ?? 0 },
    attention: {
      paymentFailures: (pastDueRows as Row[]).map((r) => ({
        businessId: String(r.businessId),
        name: String(r.name),
        detail: r.detail === null || r.detail === undefined ? null : String(r.detail),
      })),
      takeoversWaiting: (takeoverRows as Row[]).map((r) => ({
        businessId: String(r.businessId),
        name: String(r.name),
        detail: r.detail === null || r.detail === undefined ? null : String(r.detail),
      })),
      failedLineTests: (lineFailRows as Row[]).map((r) => ({
        businessId: String(r.businessId),
        name: String(r.name),
        detail: r.detail === null || r.detail === undefined ? null : String(r.detail),
      })),
    },
    lines: {
      businesses: num(rollup.businesses),
      withPhone: num(rollup.withPhone),
      lineTest: {
        pass: num(rollup.pass),
        partial: num(rollup.partial),
        fail: num(rollup.fail),
        notConfigured: num(rollup.notConfigured),
        running: num(rollup.running),
        neverRun: num(rollup.neverRun),
      },
    },
  };
}

/** The platform owner (admin) recipient, resolved fresh from the DB. */
export interface OpsDigestRecipient {
  /** The admin user's email (lowercased at the DB by the unique index). */
  email: string;
  /** The admin user's business — the in-app ops_digest notification lands here. */
  businessId: string;
}

/**
 * THE platform owner: the active user carrying migration 014's
 * is_platform_admin flag. The brief's "role='ADMIN'" maps to this flag —
 * users.role is business-scoped ('owner'|'manager'|'employee') and has no
 * ADMIN value; is_platform_admin is the ONE flag that opens /admin and marks
 * the platform operator. Oldest qualifying row wins; never hard-coded.
 * Returns null when no admin user exists — the honest skip case.
 */
export async function findPlatformAdminRecipient(): Promise<OpsDigestRecipient | null> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    // Explicit camelCase aliases: the Neon driver camel-cases snake_case
    // columns on its own, the local-pg shim (CI) does not — quoted aliases
    // make the row shape identical on both (the repo-wide convention).
    `SELECT email, business_id AS "businessId"
     FROM users
     WHERE is_platform_admin = true AND is_active = true
     ORDER BY created_at ASC
     LIMIT 1`,
    [],
  );
  const r = (rows as Row[])[0];
  if (!r || typeof r.email !== "string" || typeof r.businessId !== "string") return null;
  return { email: r.email, businessId: r.businessId };
}
