/**
 * Server-only auth layer: session cookies, token hashing, session resolution,
 * RBAC guards. NEVER import from client components — importing "@tanstack/
 * react-start/server" here makes any client-side reach a build error.
 *
 * Client code that needs auth types or AuthError imports the client-safe
 * sibling module auth.ts instead.
 */
import "@tanstack/react-start/server-only";
import { getCookie, setCookie, deleteCookie } from "@tanstack/react-start/server";
import type { Session, UserRole } from "~/db/schema";
import {
  createSession,
  deleteSession,
  getBusiness,
  getSessionByTokenHash,
} from "~/db/queries/auth";
import { AuthError, SESSION_TTL_MS, type AuthContext } from "./auth";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const SESSION_COOKIE = "mca_session";
const SESSION_COOKIE_MAX_AGE = SESSION_TTL_MS / 1000;

// ---------------------------------------------------------------------------
// Token + cookie primitives
// ---------------------------------------------------------------------------
/** 64 chars of entropy (two UUIDs, dashes stripped). */
export function newSessionToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}
/** SHA-256 hex digest — what the DB stores for sessions and auth tokens. */
export async function hashToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_COOKIE_MAX_AGE,
};

/** Read the raw session token from the request cookie (server only). */
export function readSessionCookie(): string | null {
  const raw = getCookie(SESSION_COOKIE);
  return raw ? raw : null;
}

/**
 * Issue a fresh DB-backed session for the user and set the cookie.
 * Call on signup and on every successful login (rotation: each login
 * creates a new session; the old one stays valid until logout/expiry —
 * individual devices each keep their own session).
 */
export async function issueSession(userId: string): Promise<Session> {
  const token = newSessionToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await createSession(userId, tokenHash, expiresAt);
  setCookie(SESSION_COOKIE, token, SESSION_COOKIE_OPTIONS);
  return session;
}

/** Destroy the current session (logout) and clear the cookie. Idempotent. */
export async function destroyCurrentSession(): Promise<void> {
  const raw = readSessionCookie();
  if (!raw) return;
  const tokenHash = await hashToken(raw);
  await deleteSession(tokenHash);
  deleteCookie(SESSION_COOKIE, { path: "/" });
}

// ---------------------------------------------------------------------------
// Session lookup — the single source of truth for every protected server fn
// ---------------------------------------------------------------------------

/**
 * Resolve the current request's session cookie to {user, business, role}.
 * Returns null when there is no valid session or the user is deactivated.
 */
export async function getSessionFromRequest(): Promise<AuthContext | null> {
  const raw = readSessionCookie();
  if (!raw) return null;
  const tokenHash = await hashToken(raw);
  const found = await getSessionByTokenHash(tokenHash);
  if (!found) return null;
  const user = found.userData;
  if (!user.isActive) return null;
  const business = await getBusiness(user.businessId);
  if (!business) return null;
  return { session: found, user, business, role: user.role };
}

// ---------------------------------------------------------------------------
// RBAC enforcement helpers (server fns must call these, never client checks)
// ---------------------------------------------------------------------------

/** Require a valid session; throws AuthError("unauthenticated") otherwise. */
export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getSessionFromRequest();
  if (!ctx) throw new AuthError("unauthenticated", "Authentication required.");
  return ctx;
}

/**
 * Require a session AND membership in one of the allowed roles.
 * The role lives in the DB (users.role), resolved from the session —
 * never from client input.
 */
export async function requireRole(...allowed: UserRole[]): Promise<AuthContext> {
  const ctx = await requireAuth();
  if (!allowed.includes(ctx.role)) {
    throw new AuthError("forbidden", `Requires role: ${allowed.join(" or ")}.`);
  }
  return ctx;
}
