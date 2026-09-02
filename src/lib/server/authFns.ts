/**
 * Auth server functions: signup, login, logout, password reset, email
 * verification. Every handler below runs server-side only.
 *
 * Honest-delivery note: no email provider is connected in Phase 1. Token
 * emails are NOT faked — the delivery step logs the link server-side and the
 * UI states that delivery is pending provider setup.
 */
import { createServerFn } from "@tanstack/react-start";
import type { UserRole } from "~/db/schema";
import * as q from "~/db/queries/auth";
import { AuthError, EMAIL_VERIFICATION_TTL_MS, PASSWORD_RESET_TTL_MS } from "~/lib/server/auth";
import {
  destroyCurrentSession,
  getSessionFromRequest,
  hashToken,
  issueSession,
  newSessionToken,
} from "~/lib/server/auth.server";
import { hashPassword, verifyPassword } from "~/lib/server/password";

// ---------------------------------------------------------------------------
// Validation helpers (server-side, never trust client input)
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw: unknown): string {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email)) throw new AuthError("bad_request", "Enter a valid email address.");
  return email;
}

function requiredString(raw: unknown, field: string, min: number, max = 120): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length < min) throw new AuthError("bad_request", `${field} is required (min ${min} characters).`);
  if (value.length > max) throw new AuthError("bad_request", `${field} is too long (max ${max} characters).`);
  return value;
}

function assertStrongPassword(raw: unknown): string {
  const pw = typeof raw === "string" ? raw : "";
  if (pw.length < 8) throw new AuthError("bad_request", "Password must be at least 8 characters.");
  if (pw.length > 200) throw new AuthError("bad_request", "Password is too long (max 200 characters).");
  return pw;
}

/**
 * Map internal errors to client-safe results. Auth errors from this module
 * carry safe messages; anything else is logged and reported generically so
 * internals never leak to the client.
 */
function toClientError(e: unknown): { ok: false; error: string } {
  if (e instanceof AuthError) return { ok: false, error: e.message };
  console.error("[auth] unexpected error:", e);
  return { ok: false, error: "Something went wrong. Please try again." };
}

// ---------------------------------------------------------------------------
// Signup — creates business + owner user in ONE transaction, then auto-login
// ---------------------------------------------------------------------------

export type SignupResult =
  | { ok: true }
  | { ok: false; error: string };

export const signupFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { businessName: string; fullName: string; email: string; password: string })
  .handler(async ({ data }): Promise<SignupResult> => {
  try {
    const businessName = requiredString(data?.businessName, "Business name", 1, 120);
    const fullName = requiredString(data?.fullName, "Name", 1, 120);
    const email = normalizeEmail(data?.email);
    const password = assertStrongPassword(data?.password);

    if (await q.emailExists(email)) {
      return { ok: false, error: "An account with this email already exists." };
    }

    const passwordHash = await hashPassword(password);
    const { user } = await q.createBusinessWithOwner({
      businessName,
      ownerEmail: email,
      ownerFullName: fullName,
      passwordHash,
    });

    // Delivery is pending provider setup — log the link server-side only.
    const vt = await issueEmailVerificationToken(user.id);
    logDeliveryLink("email-verification", email, vt.rawToken);

    await issueSession(user.id); // auto-login after signup
    return { ok: true };
  } catch (e) {
    return toClientError(e);
  }
});

// ---------------------------------------------------------------------------
// Login / logout
// ---------------------------------------------------------------------------

export type LoginResult =
  | { ok: true; redirect: string }
  | { ok: false; error: string; code: "invalid" | "unverified" };

export const loginFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { email: string; password: string })
  .handler(async ({ data }): Promise<LoginResult> => {
  try {
    const email = normalizeEmail(data?.email);
    const password = typeof data?.password === "string" ? data.password : "";

    const user = await q.findUserByEmail(email);
    const hash = user?.passwordHash ?? "";
    // Constant-shape verification: even for unknown emails we burn a hash check.
    const valid = hash
      ? await verifyPassword(password, hash)
      : await verifyPassword(password, await hashPassword("timing-equalizer"));
    if (!user || !valid) {
      return { ok: false, code: "invalid", error: "Invalid email or password." };
    }
    if (!user.isActive) {
      return { ok: false, code: "invalid", error: "This account has been deactivated. Contact your account owner." };
    }
    // Demo-friendly gate: unverified users can log in; the app shows a
    // "verify your email" banner instead of blocking them.
    await q.touchLastLogin(user.id);
    await issueSession(user.id);
    return { ok: true, redirect: "/dashboard" };
  } catch (e) {
    return { ...(toClientError(e) as { ok: false; error: string }), code: "invalid" as const };
  }
});

export const logoutFn = createServerFn({ method: "POST" }).handler(async (): Promise<{ ok: true }> => {
  await destroyCurrentSession();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Password reset — request → token (hashed, single-use, expiry) → reset page
// ---------------------------------------------------------------------------

export const forgotPasswordFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { email: string })
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
  try {
    const email = normalizeEmail(data?.email);
    const user = await q.findUserByEmail(email);
    if (user) {
      const t = await issuePasswordResetToken(user.id);
      logDeliveryLink("password-reset", email, t.rawToken);
    }
    // Identical response whether or not the email exists (no enumeration).
    return { ok: true };
  } catch (e) {
    return toClientError(e);
  }
});

export const resetPasswordFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { token: string; password: string })
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
  try {
    const token = requiredString(data?.token, "Token", 10, 200);
    const password = assertStrongPassword(data?.password);
    const tokenHash = await hashToken(token);
    const record = await q.findValidPasswordResetToken(tokenHash);
    if (!record) {
      return { ok: false, error: "This reset link is invalid or has expired. Request a new one." };
    }
    const passwordHash = await hashPassword(password);
    await q.updateUserPasswordHash(record.userId, passwordHash);
    await q.markPasswordResetTokenUsed(tokenHash); // single-use
    await q.invalidatePasswordResetTokens(record.userId); // burn any other outstanding links
    await q.deleteSessionsForUser(record.userId); // invalidate all sessions after a reset
    return { ok: true };
  } catch (e) {
    return { ...toClientError(e) };
  }
});

// ---------------------------------------------------------------------------
// Email verification — token flow; signup marks the user unverified
// ---------------------------------------------------------------------------

export const verifyEmailFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as { token: string })
  .handler(async ({ data }): Promise<{ ok: boolean; error?: string }> => {
  try {
    const token = requiredString(data?.token, "Token", 10, 200);
    const tokenHash = await hashToken(token);
    const record = await q.findValidEmailVerificationToken(tokenHash);
    if (!record) {
      return { ok: false, error: "This verification link is invalid or has expired. Request a new one from the banner." };
    }
    await q.markEmailVerified(tokenHash);
    await q.setUserEmailVerified(record.userId);
    return { ok: true };
  } catch (e) {
    return toClientError(e);
  }
});

/** Re-issue a verification token for the logged-in user (banner button). */
export const resendVerificationFn = createServerFn({ method: "POST" }).handler(async (): Promise<{ ok: boolean; error?: string }> => {
  try {
    const ctx = await getSessionFromRequest();
    if (!ctx) return { ok: false, error: "Authentication required." };
    if (ctx.user.emailVerified) return { ok: true };
    await q.invalidateEmailVerificationTokens(ctx.user.id);
    const t = await issueEmailVerificationToken(ctx.user.id);
    logDeliveryLink("email-verification", ctx.user.email, t.rawToken);
    return { ok: true };
  } catch (e) {
    return toClientError(e);
  }
});

// ---------------------------------------------------------------------------
// Token issuance helpers (shared shape: raw token → client link, hash → DB)
// ---------------------------------------------------------------------------

async function issueEmailVerificationToken(userId: string) {
  const rawToken = newSessionToken();
  const tokenHash = await hashToken(rawToken);
  const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
  await q.createEmailVerificationToken(userId, tokenHash, expiresAt);
  return { rawToken };
}

async function issuePasswordResetToken(userId: string) {
  const rawToken = newSessionToken();
  const tokenHash = await hashToken(rawToken);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
  await q.createPasswordResetToken(userId, tokenHash, expiresAt);
  return { rawToken };
}

/**
 * The "email delivery" step. NO email provider is connected in Phase 1, so
 * nothing is faked: the link is logged server-side for manual delivery, and
 * every UI surface says delivery is pending provider setup.
 */
function logDeliveryLink(kind: "email-verification" | "password-reset", email: string, rawToken: string): void {
  const path = kind === "email-verification" ? "/verify-email" : "/reset-password";
  console.info(
    `[auth:delivery] ${kind} for ${email}: ${path}?token=${rawToken} (email delivery pending provider setup)`,
  );
}

// Re-export for route guards that want the enum of roles without deep imports.
export type { UserRole };
