/**
 * Client-safe auth contract: shared shapes, the RBAC error type, and timing
 * constants.
 *
 * This module MUST stay importable from client code — it contains no server
 * implementation (no cookies, no DB access, no secrets). The server-only half
 * of the auth layer lives in auth.server.ts, which imports from this module.
 *
 * Session model: an opaque random token lives ONLY in an httpOnly cookie; the
 * DB stores its SHA-256 hash (sessions.token_hash, unique index). Lookup joins
 * users, so a session resolves to {user, business, role} in one query.
 */
import type { Business, Session, User, UserRole } from "~/db/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Password reset tokens live 60 minutes; email-verification tokens 24 hours. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shapes shared across the client/server boundary
// ---------------------------------------------------------------------------
export interface AuthContext {
  session: Session;
  user: User;
  business: Business;
  role: UserRole;
}

// ---------------------------------------------------------------------------
// RBAC error type — server fns throw it, client-safe code may inspect it
// ---------------------------------------------------------------------------
export class AuthError extends Error {
  readonly kind: "unauthenticated" | "forbidden" | "bad_request";
  constructor(kind: "unauthenticated" | "forbidden" | "bad_request", message: string) {
    super(message);
    this.name = "AuthError";
    this.kind = kind;
  }
}
