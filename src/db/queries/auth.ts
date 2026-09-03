/**
 * Server-only queries: businesses, users, sessions, and auth tokens.
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it, except
 * functions explicitly marked as cross-business (login lookup, token/session
 * lookup by hash) — those are scoped by the token/user itself, not the caller's
 * business, and are used only by the auth layer.
 */
import type {
  Business,
  BusinessPlan,
  EmailVerificationToken,
  PasswordResetToken,
  Session,
  User,
  UserRole,
} from "../schema";
import { assertServer, listClause, sql, type ListOptions } from "./shared";

// ---------------------------------------------------------------------------
// Businesses
// ---------------------------------------------------------------------------

export async function getBusiness(businessId: string): Promise<Business | null> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM businesses WHERE id = ${businessId} LIMIT 1`;
  return (rows[0] as unknown as Business | undefined) ?? null;
}

const BUSINESS_PATCH_COLUMNS = [
  "name",
  "phone",
  "email",
  "website",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "timezone",
  "plan",
] as const;

export async function updateBusiness(
  businessId: string,
  patch: Partial<Pick<Business, (typeof BUSINESS_PATCH_COLUMNS)[number]>>,
): Promise<Business | null> {
  assertServer();
  const snake = (k: string): string => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const cols = Object.keys(patch).filter((k) =>
    (BUSINESS_PATCH_COLUMNS as readonly string[]).includes(k),
  );
  if (cols.length === 0) return getBusiness(businessId);
  // $1 = businessId, then one param per patched column. Column names come from
  // the typed key list above — never from raw client input.
  const sets = cols.map((k, i) => `${snake(k)} = $${i + 2}`).join(", ");
  const values = cols.map((k) => patch[k as keyof typeof patch]);
  const db = sql();
  const rows = await db.query(
    `UPDATE businesses SET ${sets} WHERE id = $1 RETURNING *`,
    [businessId, ...values],
  );
  return (rows[0] as unknown as Business | undefined) ?? null;
}

export async function updateBusinessPlan(
  businessId: string,
  plan: BusinessPlan,
): Promise<Business | null> {
  assertServer();
  const db = sql();
  const rows = await db`UPDATE businesses SET plan = ${plan} WHERE id = ${businessId} RETURNING *`;
  return (rows[0] as unknown as Business | undefined) ?? null;
}

/**
 * Phase 1 billing: subscription state columns (migration 004). Writes go
 * through typed keys — never raw client input — per the isolation rules.
 */
export async function setSubscriptionStatus(
  businessId: string,
  status: string,
): Promise<Business | null> {
  assertServer();
  const db = sql();
  const rows = await db`UPDATE businesses SET subscription_status = ${status} WHERE id = ${businessId} RETURNING *`;
  return (rows[0] as unknown as Business | undefined) ?? null;
}

export async function clearSubscriptionStatus(businessId: string): Promise<Business | null> {
  assertServer();
  const db = sql();
  const rows = await db`UPDATE businesses SET subscription_status = NULL WHERE id = ${businessId} RETURNING *`;
  return (rows[0] as unknown as Business | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function getUserById(businessId: string, userId: string): Promise<User | null> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM users WHERE id = ${userId} AND business_id = ${businessId} LIMIT 1`;
  return (rows[0] as unknown as User | undefined) ?? null;
}

export async function listUsers(businessId: string, opts?: ListOptions): Promise<User[]> {
  assertServer();
  const { limit, offset, order } = listClause(opts);
  const dir = order === "asc" ? "ASC" : "DESC"; // whitelisted, not client input
  const db = sql();
  const rows = await db.query(
    `SELECT * FROM users WHERE business_id = $1 ORDER BY created_at ${dir} LIMIT ${limit} OFFSET ${offset}`,
    [businessId],
  );
  return rows as unknown as User[];
}

export async function countUsers(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT count(*) AS n FROM users WHERE business_id = ${businessId}`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

export async function countActiveUsers(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT count(*) AS n FROM users WHERE business_id = ${businessId} AND is_active`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

/** Cross-business: used by the login flow only — never expose beyond auth. */
export async function findUserByEmail(email: string): Promise<User | null> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM users WHERE lower(email) = ${email.toLowerCase()} LIMIT 1`;
  return (rows[0] as unknown as User | undefined) ?? null;
}

export async function createUser(input: {
  businessId: string;
  email: string;
  fullName: string;
  role: UserRole;
  passwordHash: string;
}): Promise<User> {
  assertServer();
  const db = sql();
  const rows = await db`
    INSERT INTO users (business_id, email, full_name, role, password_hash)
    VALUES (${input.businessId}, ${input.email}, ${input.fullName}, ${input.role}, ${input.passwordHash})
    RETURNING *`;
  return rows[0] as unknown as User;
}

export async function updateUserStatus(
  businessId: string,
  userId: string,
  isActive: boolean,
): Promise<User | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    UPDATE users SET is_active = ${isActive}
    WHERE id = ${userId} AND business_id = ${businessId}
    RETURNING *`;
  return (rows[0] as unknown as User | undefined) ?? null;
}

export async function touchLastLogin(userId: string): Promise<void> {
  assertServer();
  const db = sql();
  await db`UPDATE users SET last_login_at = now() WHERE id = ${userId}`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionWithUser extends Session {
  userData: User;
}

export async function getSessionByTokenHash(tokenHash: string): Promise<SessionWithUser | null> {
  assertServer();
  const db = sql();
  // s.*/to_jsonb(u.*) would serialize with Postgres's snake_case column names,
  // but every consumer reads the typed camelCase shape (session.userId,
  // user.businessId, user.isActive, ...). Explicit aliases keep the wire shape
  // identical to the TS interfaces — user_data is built with jsonb_build_object
  // for the same reason.
  const rows = await db`
    SELECT
      s.id,
      s.user_id AS "userId",
      s.token_hash AS "tokenHash",
      s.expires_at AS "expiresAt",
      s.created_at AS "createdAt",
      s.updated_at AS "updatedAt",
      jsonb_build_object(
        'id', u.id,
        'businessId', u.business_id,
        'email', u.email,
        'fullName', u.full_name,
        'role', u.role,
        'passwordHash', u.password_hash,
        'isActive', u.is_active,
        'emailVerified', u.email_verified,
        'lastLoginAt', u.last_login_at,
        'createdAt', u.created_at,
        'updatedAt', u.updated_at
      ) AS "userData"
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash} AND s.expires_at > now()
    LIMIT 1`;
  return (rows[0] as unknown as SessionWithUser | undefined) ?? null;
}

export async function createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<Session> {
  assertServer();
  const db = sql();
  const rows = await db`
    INSERT INTO sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt.toISOString()})
    RETURNING *`;
  return rows[0] as unknown as Session;
}

export async function deleteSession(tokenHash: string): Promise<void> {
  assertServer();
  const db = sql();
  await db`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
}

export async function deleteExpiredSessions(): Promise<void> {
  assertServer();
  const db = sql();
  await db`DELETE FROM sessions WHERE expires_at <= now()`;
}

// ---------------------------------------------------------------------------
// Password reset & email verification tokens
// ---------------------------------------------------------------------------

export async function createPasswordResetToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<PasswordResetToken> {
  assertServer();
  const db = sql();
  const rows = await db`
    INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt.toISOString()})
    RETURNING *`;
  return rows[0] as unknown as PasswordResetToken;
}

export async function findValidPasswordResetToken(tokenHash: string): Promise<PasswordResetToken | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM password_reset_tokens
    WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > now()
    LIMIT 1`;
  return (rows[0] as unknown as PasswordResetToken | undefined) ?? null;
}

export async function markPasswordResetTokenUsed(tokenHash: string): Promise<void> {
  assertServer();
  const db = sql();
  await db`UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = ${tokenHash}`;
}

export async function createEmailVerificationToken(
  userId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<EmailVerificationToken> {
  assertServer();
  const db = sql();
  const rows = await db`
    INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt.toISOString()})
    RETURNING *`;
  return rows[0] as unknown as EmailVerificationToken;
}

export async function findValidEmailVerificationToken(tokenHash: string): Promise<EmailVerificationToken | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM email_verification_tokens
    WHERE token_hash = ${tokenHash} AND verified_at IS NULL AND expires_at > now()
    LIMIT 1`;
  return (rows[0] as unknown as EmailVerificationToken | undefined) ?? null;
}

export async function markEmailVerified(tokenHash: string): Promise<void> {
  assertServer();
  const db = sql();
  await db`UPDATE email_verification_tokens SET verified_at = now() WHERE token_hash = ${tokenHash}`;
}

// ---------------------------------------------------------------------------
// Signup / password change primitives (atomic, single-statement writes)
// ---------------------------------------------------------------------------

/**
 * Create a business + its owner user atomically in ONE statement.
 *
 * A data-modifying CTE makes the two INSERTs a single implicit transaction:
 * either both rows exist or neither does. (The Neon driver's `transaction()`
 * only accepts non-interactive arrays, so an atomic CTE is the correct
 * primitive here — same guarantee, one round trip.)
 */
export async function createBusinessWithOwner(input: {
  businessName: string;
  ownerEmail: string;
  ownerFullName: string;
  passwordHash: string;
}): Promise<{ business: Business; user: User }> {
  assertServer();
  const db = sql();
  const rows = await db`
    WITH biz AS (
      INSERT INTO businesses (name)
      VALUES (${input.businessName})
      RETURNING *
    ), usr AS (
      INSERT INTO users (business_id, email, full_name, role, password_hash)
      SELECT biz.id, ${input.ownerEmail}, ${input.ownerFullName}, 'owner', ${input.passwordHash}
      FROM biz
      RETURNING *
    )
    SELECT to_jsonb(biz.*) AS business, to_jsonb(usr.*) AS user
    FROM biz, usr`;
  const row = rows[0] as unknown as { business: Business; user: User };
  return { business: row.business, user: row.user };
}

/** Mark a user's email verified (token flow callback). Cross-business by design: the token hash IS the authority. */
export async function setUserEmailVerified(userId: string): Promise<void> {
  assertServer();
  const db = sql();
  await db`UPDATE users SET email_verified = true WHERE id = ${userId}`;
}

/** Set a new password hash; returns the user so callers can invalidate sessions. */
export async function updateUserPasswordHash(
  userId: string,
  passwordHash: string,
): Promise<void> {
  assertServer();
  const db = sql();
  await db`UPDATE users SET password_hash = ${passwordHash} WHERE id = ${userId}`;
}

/** Delete all sessions for a user (password changed / account compromised). */
export async function deleteSessionsForUser(userId: string): Promise<void> {
  assertServer();
  const db = sql();
  await db`DELETE FROM sessions WHERE user_id = ${userId}`;
}

/** Invalidate any outstanding password-reset tokens for a user. */
export async function invalidatePasswordResetTokens(userId: string): Promise<void> {
  assertServer();
  const db = sql();
  await db`
    UPDATE password_reset_tokens SET used_at = now()
    WHERE user_id = ${userId} AND used_at IS NULL`;
}

/** Invalidate any outstanding (unverified) email-verification tokens for a user. */
export async function invalidateEmailVerificationTokens(userId: string): Promise<void> {
  assertServer();
  const db = sql();
  await db`
    UPDATE email_verification_tokens SET verified_at = now()
    WHERE user_id = ${userId} AND verified_at IS NULL`;
}

/** Check whether an email is already registered (case-insensitive; login identity is lowercased). */
export async function emailExists(email: string): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT 1 FROM users WHERE lower(email) = ${email.toLowerCase()} LIMIT 1`;
  return rows.length > 0;
}

/**
 * Merge-style update of the per-business settings jsonb blob (notification
 * prefs etc). The caller passes the full merged object; we only persist it.
 */
export async function updateBusinessSettings(
  businessId: string,
  settings: Record<string, unknown>,
): Promise<Business | null> {
  assertServer();
  const db = sql();
  const rows = await db`UPDATE businesses SET settings = ${JSON.stringify(settings)}::jsonb WHERE id = ${businessId} RETURNING *`;
  return (rows[0] as unknown as Business | undefined) ?? null;
}
