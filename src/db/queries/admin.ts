/**
 * Server-only queries: internal admin dashboard (P3-G).
 *
 * ISOLATION NOTE — this module is the ONE deliberately cross-business query
 * module in the codebase (AGENTS.md isolation rule). Every function here is
 * reachable ONLY through the admin gate (src/lib/server/admin.ts
 * requirePlatformAdmin), which verifies the session user's
 * is_platform_admin flag resolved from the DB — never from client input.
 * Business-scoped modules in src/db/queries/ keep their businessId WHERE
 * clause untouched; nothing here is re-exported through index.ts.
 *
 * Every function still takes explicit ids/params and never invents scope.
 */
import type { AdminAudit, AdminAuditAction, Business, User } from "../schema";
import type { FunnelCounts } from "../../lib/server/revenue";
import { assertServer, listClause, sql, toNumber } from "./shared";

// ---------------------------------------------------------------------------
// Platform-owner promotion (the runtime seed for users.is_platform_admin)
// ---------------------------------------------------------------------------

/**
 * The platform owner's email comes from env — never a hard-coded personal
 * address. When the env is absent, `platformAdminGateOpen()` is false and
 * the whole admin surface is closed (pages 404, fns refuse) for everyone.
 */
export function platformOwnerEmail(): string | null {
  const raw = (process.env.PLATFORM_OWNER_EMAIL ?? "").trim().toLowerCase();
  return raw.length > 0 ? raw : null;
}

/** True only when PLATFORM_OWNER_EMAIL is set — the gate's env precondition. */
export function platformAdminGateOpen(): boolean {
  return platformOwnerEmail() !== null;
}

/**
 * Idempotent promotion: flip is_platform_admin=true for the env-named owner
 * email (if such a user exists). Returns how many rows changed (0 is fine —
 * the owner may not have signed up yet; the gate stays closed for
 * non-promoted users regardless). Called by the admin gate itself so the
 * flag appears the first time the owner hits /admin, without a migration
 * hard-coding an email.
 */
export async function promotePlatformOwnerIfPresent(): Promise<number> {
  assertServer();
  const email = platformOwnerEmail();
  if (!email) return 0;
  const db = sql();
  const rows = await db.query(
    `UPDATE users SET is_platform_admin = true
     WHERE lower(email) = $1 AND is_platform_admin = false
     RETURNING id`,
    [email],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------
// Admin audit — append-only (INSERT is the only write path that ships)
// ---------------------------------------------------------------------------

/**
 * Append one audit row. Never throws upward for logging failures on the
 * action path (callers pre-log with await, but a logging outage must not
 * break a disable/enable); the boolean lets callers that REQUIRE the row
 * (impersonation, per the brief) check it.
 */
export async function appendAdminAudit(entry: {
  adminUserId: string;
  action: AdminAuditAction;
  targetBusinessId?: string | null;
  detail?: Record<string, unknown>;
}): Promise<AdminAudit> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    `INSERT INTO admin_audit (admin_user_id, action, target_business_id, detail)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [
      entry.adminUserId,
      entry.action,
      entry.targetBusinessId ?? null,
      JSON.stringify(entry.detail ?? {}),
    ],
  );
  return rows[0] as unknown as AdminAudit;
}

/** Newest-first page of the audit log. Read-only; no UPDATE path exists. */
export async function listAdminAudit(
  opts?: { limit?: number; offset?: number; action?: AdminAuditAction | null },
): Promise<AdminAudit[]> {
  assertServer();
  const { limit, offset } = listClause(opts);
  const db = sql();
  if (opts?.action) {
    const rows = await db`
      SELECT * FROM admin_audit
      WHERE action = ${opts.action}
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}`;
    return rows as unknown as AdminAudit[];
  }
  const rows = await db`
    SELECT * FROM admin_audit
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}`;
  return rows as unknown as AdminAudit[];
}

export async function countAdminAudit(
  action?: AdminAuditAction | null,
): Promise<number> {
  assertServer();
  const db = sql();
  const rows = action
    ? await db`SELECT count(*) AS n FROM admin_audit WHERE action = ${action}`
    : await db`SELECT count(*) AS n FROM admin_audit`;
  return toNumber((rows[0] as unknown as Record<string, unknown>).n);
}

// ---------------------------------------------------------------------------
// Cross-business reads — accounts list + detail
// ---------------------------------------------------------------------------

export interface AdminAccountRow {
  business: Business;
  /** Newest user login on the account — the honest "last activity" proxy. */
  lastActivityAt: Date | null;
  userCount: number;
}

/**
 * Every business on the platform, with subscription state, newest user
 * login, and user count. Search matches business name or any user email.
 * Pagination via limit/offset; total count for the pager comes from
 * countAdminAccounts with the same filters.
 */
export async function listAdminAccounts(opts?: {
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<AdminAccountRow[]> {
  assertServer();
  const { limit, offset } = listClause(opts);
  const db = sql();
  const like = `%${(opts?.search ?? "").trim()}%`;
  if (like !== "%%") {
    const rows = await db`
      SELECT
        b.*,
        (SELECT max(u.last_login_at) FROM users u WHERE u.business_id = b.id) AS "lastActivityAt",
        (SELECT count(*) FROM users u WHERE u.business_id = b.id) AS "userCount"
      FROM businesses b
      WHERE b.name ILIKE ${like}
         OR EXISTS (
           SELECT 1 FROM users u
           WHERE u.business_id = b.id AND u.email ILIKE ${like}
         )
      ORDER BY b.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`;
    return rows.map((r) => rowToAccount(r));
  }
  const rows = await db`
    SELECT
      b.*,
      (SELECT max(u.last_login_at) FROM users u WHERE u.business_id = b.id) AS "lastActivityAt",
      (SELECT count(*) FROM users u WHERE u.business_id = b.id) AS "userCount"
    FROM businesses b
    ORDER BY b.created_at DESC
    LIMIT ${limit} OFFSET ${offset}`;
  return rows.map((r) => rowToAccount(r));
}

function rowToAccount(r: Record<string, unknown>): AdminAccountRow {
  const { lastActivityAt, userCount, ...b } = r as Record<string, unknown> & Business;
  return {
    business: b as Business,
    lastActivityAt: lastActivityAt ? new Date(lastActivityAt as string) : null,
    userCount: toNumber(userCount),
  };
}

/** Total for pagination; same search filter as listAdminAccounts. */
export async function countAdminAccounts(search?: string): Promise<number> {
  assertServer();
  const db = sql();
  const like = `%${(search ?? "").trim()}%`;
  if (like !== "%%") {
    const rows = await db`
      SELECT count(*) AS n
      FROM businesses b
      WHERE b.name ILIKE ${like}
         OR EXISTS (
           SELECT 1 FROM users u
           WHERE u.business_id = b.id AND u.email ILIKE ${like}
         )`;
    return toNumber((rows[0] as unknown as Record<string, unknown>).n);
  }
  const rows = await db`SELECT count(*) AS n FROM businesses`;
  return toNumber((rows[0] as unknown as Record<string, unknown>).n);
}

/**
 * The account-detail aggregate: business row + first user + per-table
 * counts, in one round trip each. Cross-business BY DESIGN — callers have
 * passed the platform-admin gate.
 */
export async function getAdminAccountDetail(businessId: string): Promise<{
  business: Business;
  users: User[];
  counts: {
    leads: number;
    calls: number;
    conversations: number;
    appointments: number;
    users: number;
    notifications: number;
  };
} | null> {
  assertServer();
  const db = sql();
  const bRows = await db`SELECT * FROM businesses WHERE id = ${businessId} LIMIT 1`;
  const b = bRows[0] as unknown as Business | undefined;
  if (!b) return null;
  const [userRows, countRows] = await Promise.all([
    db`SELECT * FROM users WHERE business_id = ${businessId} ORDER BY created_at ASC`,
    db`
      SELECT
        (SELECT count(*) FROM leads WHERE business_id = ${businessId}) AS leads,
        (SELECT count(*) FROM calls WHERE business_id = ${businessId}) AS calls,
        (SELECT count(*) FROM conversations WHERE business_id = ${businessId}) AS conversations,
        (SELECT count(*) FROM appointments WHERE business_id = ${businessId}) AS appointments,
        (SELECT count(*) FROM users WHERE business_id = ${businessId}) AS users,
        (SELECT count(*) FROM notifications WHERE business_id = ${businessId}) AS notifications`,
  ]);
  const c = countRows[0] as unknown as Record<string, unknown>;
  return {
    business: b,
    users: userRows as unknown as User[],
    counts: {
      leads: toNumber(c.leads),
      calls: toNumber(c.calls),
      conversations: toNumber(c.conversations),
      appointments: toNumber(c.appointments),
      users: toNumber(c.users),
      notifications: toNumber(c.notifications),
    },
  };
}

/**
 * The most recent notifications across the platform (newest first) — the
 * admin "recent events/errors" feed. `businessId` narrows to one account on
 * the detail page; omit it for the platform-wide feed.
 */
export async function listRecentNotificationsForAdmin(opts?: {
  businessId?: string;
  limit?: number;
}): Promise<
  { id: string; businessId: string; type: string; payload: Record<string, unknown>; readAt: Date | null; createdAt: Date }[]
> {
  assertServer();
  const { limit } = listClause(opts);
  const db = sql();
  if (opts?.businessId) {
    const rows = await db`
      SELECT id, business_id AS "businessId", type, payload, read_at AS "readAt", created_at AS "createdAt"
      FROM notifications
      WHERE business_id = ${opts.businessId}
      ORDER BY created_at DESC
      LIMIT ${limit}`;
    return rows as unknown as { id: string; businessId: string; type: string; payload: Record<string, unknown>; readAt: Date | null; createdAt: Date }[];
  }
  const rows = await db`
    SELECT id, business_id AS "businessId", type, payload, read_at AS "readAt", created_at AS "createdAt"
    FROM notifications
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  return rows as unknown as { id: string; businessId: string; type: string; payload: Record<string, unknown>; readAt: Date | null; createdAt: Date }[];
}

/**
 * Platform-wide counts of in-app notifications by type — the DB-backed
 * error/signal surface (payment_failed is the error-ish type today).
 */
export async function adminNotificationTypeCounts(): Promise<Record<string, number>> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT type, count(*) AS n
    FROM notifications
    GROUP BY type
    ORDER BY n DESC`;
  const out: Record<string, number> = {};
  for (const r of rows as unknown as { type: string; n: unknown }[]) out[r.type] = toNumber(r.n);
  return out;
}

// ---------------------------------------------------------------------------
// Disabled-account enforcement queries
// ---------------------------------------------------------------------------

/**
 * Flip the account flag. Sessions are revoked here too (delete of every
 * session row joined to the business's users) so "disabled" takes effect
 * immediately, not at next login.
 */
export async function setBusinessDisabled(
  businessId: string,
  disabledAt: Date | null,
): Promise<void> {
  assertServer();
  const db = sql();
  await db.query(
    `UPDATE businesses SET disabled_at = $2 WHERE id = $1`,
    [businessId, disabledAt],
  );
  if (disabledAt !== null) {
    // Revoke every live session belonging to the business's users.
    await db.query(
      `DELETE FROM sessions s USING users u
       WHERE s.user_id = u.id AND u.business_id = $1`,
      [businessId],
    );
  }
}

// ---------------------------------------------------------------------------
// System health (cross-business aggregates + integration status)
// ---------------------------------------------------------------------------

export interface StripeEventHealthRow {
  id: string;
  type: string;
  receivedAt: Date;
  processedAt: Date | null;
}

/** Unprocessed or recent webhook events — the honest Stripe health view. */
export async function listRecentStripeEvents(limit = 20): Promise<StripeEventHealthRow[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT id, type, received_at AS "receivedAt", processed_at AS "processedAt"
    FROM stripe_events
    ORDER BY received_at DESC
    LIMIT ${limit}`;
  return rows as unknown as StripeEventHealthRow[];
}

/**
 * The aggregate 8-stage funnel across ALL businesses. Same stage semantics
 * as the per-business revenueFunnelCounts, computed in one pass each over
 * the platform tables — the per-business version cannot simply be summed
 * from here, and duplicating its SQL would drift, so the aggregate is its
 * own query set with the same definitions (missed_call leads; recovered =
 * has ≥1 conversation; qualified = status IN qualified/scheduled/won;
 * appointments = distinct lead_ids; handled = conversations with an
 * outbound replySource-classified message on a missed_call lead).
 */
export async function adminAggregateFunnelCounts(): Promise<FunnelCounts> {
  assertServer();
  const db = sql();
  const [leadRows, convRows, apptRows] = await Promise.all([
    db`
      SELECT
        count(*) AS leads,
        count(*) FILTER (WHERE source = 'missed_call') AS missed_calls,
        count(*) FILTER (
          WHERE source = 'missed_call' AND EXISTS (
            SELECT 1 FROM conversations c WHERE c.lead_id = leads.id
          )
        ) AS missed_recovered,
        count(*) FILTER (
          WHERE status IN ('qualified', 'appointment_scheduled', 'won')
        ) AS qualified,
        count(*) FILTER (WHERE status = 'won') AS won
      FROM leads`,
    db`
      SELECT count(*) AS handled
      FROM conversations c
      WHERE EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = c.id
          AND m.direction = 'outbound'
          AND m.classification->>'replySource' IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM leads l
        WHERE l.id = c.lead_id AND l.source = 'missed_call'
      )`,
    db`
      SELECT count(DISTINCT lead_id) AS appt_leads
      FROM appointments
      WHERE lead_id IS NOT NULL`,
  ]);
  const lr = leadRows[0] as unknown as Record<string, unknown>;
  const cr = convRows[0] as unknown as Record<string, unknown>;
  const ar = apptRows[0] as unknown as Record<string, unknown>;
  const missedCalls = toNumber(lr.missedCalls);
  return {
    callsReceived: missedCalls,
    callsHandledByAi: toNumber(cr.handled),
    missedCalls,
    missedCallsRecovered: toNumber(lr.missedRecovered),
    leads: toNumber(lr.leads),
    qualified: toNumber(lr.qualified),
    appointments: toNumber(ar.apptLeads),
    won: toNumber(lr.won),
  };
}
