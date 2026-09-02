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
  user_data: User;
}

export async function getSessionByTokenHash(tokenHash: string): Promise<SessionWithUser | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT s.*, to_jsonb(u.*) AS user_data
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
