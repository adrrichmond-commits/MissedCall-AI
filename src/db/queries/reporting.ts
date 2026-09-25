/**
 * Server-only queries: performance-reporting window counts (P5-5).
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it —
 * the WHERE clause is the isolation boundary, so no function may omit it.
 *
 * NO MIGRATION: everything here reads columns the earlier migrations already
 * shipped (leads.created_at/source/status/pipeline_value_cents/converted_at,
 * conversations.created_at, messages.direction/classification,
 * appointments.created_at). Window bounds come from the pure engine
 * (src/lib/server/reporting.ts — the SAME local-calendar math as revenue.ts)
 * and arrive as parameterized UTC instants; no period math lives in SQL.
 *
 * The FILTER-over-windows shape (one query per table family, N windows) keeps
 * the analytics page and the digest sweep at a fixed 4 round trips regardless
 * of how many windows a caller needs.
 */
import { assertServer, sql, toNumber } from "./shared";
import type { ReportingCounts } from "../../lib/server/reporting";
import { sanitizeCounts } from "../../lib/server/reporting";

/** A [from, to) half-open UTC window; `key` is a caller-chosen ascii id. */
export interface CountWindow {
  key: string;
  from: Date;
  to: Date;
}

const KEY_RE = /^[a-z0-9_]+$/;

/**
 * Build the row key the db layer will hand back for an alias. src/db.ts
 * camelCases every returned key (snake_case -> camelCase), so the SQL alias
 * `leads_day_current` arrives as `leadsDayCurrent` — a raw snake_case read is
 * always undefined and silently zeroes the count (the same P3-H isolation-suite
 * trap revenue.ts documents). Every read below goes through this helper.
 */
const col = (prefix: string, key: string): string =>
  `${prefix}_${key}`.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * Per-window counts for the business. Keys echo the input windows; every
 * count passes the engine's sanitizers, so a window with no rows yields an
 * all-zero ReportingCounts (never undefined, never NaN).
 */
export async function periodCountsForWindows(
  businessId: string,
  windows: CountWindow[],
): Promise<Record<string, ReportingCounts>> {
  assertServer();
  if (windows.length === 0) return {};
  for (const w of windows) {
    if (!KEY_RE.test(w.key)) throw new Error(`Invalid window key: ${w.key}`);
  }
  const db = sql();

  // Each of the four SELECTs gets its OWN params array: $1 = businessId, then
  // (from, to) pairs in window order. Sharing one array across statements made
  // later statements reference $14+ while $2..$13 stayed unreferenced —
  // Postgres must infer a type for every parameter up to the highest number
  // referenced, and a never-referenced parameter has none
  // (NeonDbError: could not determine data type of parameter $2).
  const makeBind = (): {
    params: unknown[];
    bind: (w: CountWindow) => { f: string; t: string };
  } => {
    const params: unknown[] = [businessId];
    const bind = (w: CountWindow): { f: string; t: string } => {
      params.push(w.from, w.to);
      const f = `$${params.length - 1}`;
      const t = `$${params.length}`;
      return { f, t };
    };
    return { params, bind };
  };

  // --- Leads: captured + missed-call (callsReceived mirrors missedCalls
  // until the voice receptionist lands — the documented revenue.ts convention).
  const { params: leadParams, bind: leadBind } = makeBind();
  const leadSelect = windows
    .map((w) => {
      const { f, t } = leadBind(w);
      return `count(*) FILTER (WHERE created_at >= ${f} AND created_at < ${t}) AS leads_${w.key},
        count(*) FILTER (WHERE source = 'missed_call' AND created_at >= ${f} AND created_at < ${t}) AS missed_${w.key}`;
    })
    .join(", ");
  const leadRows = await db.query(
    `SELECT ${leadSelect} FROM leads WHERE business_id = $1`,
    leadParams,
  );
  const lr = leadRows[0] as unknown as Record<string, unknown>;

  // --- Conversations: AI-handled (≥1 outbound AI reply) + customer replies
  // (≥1 inbound message). Windowed on the conversation's capture time.
  const { params: convParams, bind: convBind } = makeBind();
  const convSelect = windows
    .map((w) => {
      const { f, t } = convBind(w);
      return `count(*) FILTER (
          WHERE c.created_at >= ${f} AND c.created_at < ${t}
            AND EXISTS (SELECT 1 FROM messages m
                        WHERE m.conversation_id = c.id AND m.business_id = $1
                          AND m.direction = 'outbound'
                          AND m.classification->>'replySource' IS NOT NULL)
        ) AS auto_${w.key},
        count(*) FILTER (
          WHERE c.created_at >= ${f} AND c.created_at < ${t}
            AND EXISTS (SELECT 1 FROM messages m
                        WHERE m.conversation_id = c.id AND m.business_id = $1
                          AND m.direction = 'inbound')
        ) AS replies_${w.key}`;
    })
    .join(", ");
  const convRows = await db.query(
    `SELECT ${convSelect} FROM conversations c WHERE c.business_id = $1`,
    convParams,
  );
  const cr = convRows[0] as unknown as Record<string, unknown>;

  // --- Appointments booked (created) in the window.
  const { params: apptParams, bind: apptBind } = makeBind();
  const apptSelect = windows
    .map((w) => {
      const { f, t } = apptBind(w);
      return `count(*) FILTER (WHERE created_at >= ${f} AND created_at < ${t}) AS appt_${w.key}`;
    })
    .join(", ");
  const apptRows = await db.query(
    `SELECT ${apptSelect} FROM appointments WHERE business_id = $1`,
    apptParams,
  );
  const ar = apptRows[0] as unknown as Record<string, unknown>;

  // --- Won jobs + estimated recovered revenue: pipeline_value_cents of won
  // leads converted in the window (the SAME money source as revenue.ts /
  // roi.ts — an ESTIMATE, labeled upstream by the engine's estimateFlags).
  const { params: wonParams, bind: wonBind } = makeBind();
  const wonSelect = windows
    .map((w) => {
      const { f, t } = wonBind(w);
      return `count(*) FILTER (WHERE converted_at >= ${f} AND converted_at < ${t}) AS won_${w.key},
        COALESCE(SUM(pipeline_value_cents) FILTER (WHERE converted_at >= ${f} AND converted_at < ${t}), 0) AS cents_${w.key}`;
    })
    .join(", ");
  const wonRows = await db.query(
    `SELECT ${wonSelect} FROM leads WHERE business_id = $1 AND status = 'won' AND pipeline_value_cents IS NOT NULL`,
    wonParams,
  );
  const wr = wonRows[0] as unknown as Record<string, unknown>;

  const out: Record<string, ReportingCounts> = {};
  for (const w of windows) {
    out[w.key] = sanitizeCounts({
      callsReceived: toNumber(lr[col("missed", w.key)]),
      missedCalls: toNumber(lr[col("missed", w.key)]),
      autoResponded: toNumber(cr[col("auto", w.key)]),
      customerReplies: toNumber(cr[col("replies", w.key)]),
      leadsCaptured: toNumber(lr[col("leads", w.key)]),
      appointmentsBooked: toNumber(ar[col("appt", w.key)]),
      jobsWon: toNumber(wr[col("won", w.key)]),
      revenueRecoveredCents: toNumber(wr[col("cents", w.key)]),
    });
  }
  return out;
}
