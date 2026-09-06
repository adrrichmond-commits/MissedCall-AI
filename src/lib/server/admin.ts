/**
 * P3-G — Internal admin dashboard gate + privileged actions.
 *
 * THE GATE: every admin server fn and /admin route loader calls
 * requirePlatformAdmin(), which re-resolves the session from the request
 * cookie, re-reads users.is_platform_admin from the DB (no caching), and
 * requires BOTH the PLATFORM_OWNER_EMAIL env precondition AND the flag.
 * No client-supplied input participates in the decision — the email match
 * happens at promotion time (promotePlatformOwnerIfPresent), never
 * per-request.
 *
 * When PLATFORM_OWNER_EMAIL is unset the gate is closed unconditionally:
 * admin pages 404 for everyone (a 404, not a 403 — the surface does not
 * exist for non-admins) and admin fns refuse.
 *
 * IMPERSONATION MODEL (no sudo flag on the target, no second session row
 * beyond the two ordinary ones): impersonateBusiness() stashes the admin's
 * CURRENT session token in the mca_admin_return cookie, issues a NEW
 * session bound to the target business's active owner user (which becomes
 * the active cookie), and audits the start. The admin's original session
 * stays live server-side — it is the thing exit restores, so it is never
 * revoked during impersonation. While the return cookie holds a live
 * token for a DIFFERENT business than the active session, the app shell
 * renders the "Viewing as <business> — admin session" banner with an Exit
 * control. Every start/stop writes an appendAdminAudit row; the audit
 * write is REQUIRED (awaited first, failure aborts the action) so the
 * trail can never silently miss an impersonation.
 */
import "@tanstack/react-start/server-only";
import { getCookie, setCookie, deleteCookie } from "@tanstack/react-start/server";
import type { AuthContext } from "./auth";
import { AuthError, SESSION_TTL_MS } from "./auth";
import {
  createSession,
  deleteSession,
  getBusiness,
  getSessionByTokenHash,
} from "~/db/queries/auth";
import {
  appendAdminAudit,
  platformAdminGateOpen,
  promotePlatformOwnerIfPresent,
} from "~/db/queries/admin";
import { SESSION_COOKIE, getSessionFromRequest, hashToken, readSessionCookie } from "./auth.server";

/** Cookie that holds the admin's own session token during impersonation. */
export const ADMIN_RETURN_COOKIE = "mca_admin_return";

/** Shared cookie attributes for the two admin cookies. */
const ADMIN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
} as const;

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * The single admin authorization point. Env precondition → session →
 * is_platform_admin, all fresh from the DB. Signed-in non-admin and
 * gate-closed both throw AuthError("forbidden") with a generic "Not
 * found." message (pages translate that into a real 404).
 */
export async function requirePlatformAdmin(): Promise<AuthContext> {
  if (!platformAdminGateOpen()) {
    throw new AuthError("forbidden", "Not found.");
  }
  // Self-healing promotion: a no-op unless the session user's email IS the
  // env owner's. Keeps the flag correct without a hard-coded-email migration.
  await promotePlatformOwnerIfPresent();
  const ctx = await getSessionFromRequest();
  if (!ctx) throw new AuthError("unauthenticated", "Authentication required.");
  if (!ctx.user.isPlatformAdmin) {
    throw new AuthError("forbidden", "Not found.");
  }
  return ctx;
}

export interface ImpersonationState {
  /** The active session belongs to a different business than the admin's. */
  active: boolean;
  /** Business currently being viewed (the active session's business). */
  viewedBusinessId: string | null;
  viewedBusinessName: string | null;
  /** The impersonated business's admin-flagged original admin user id. */
  adminUserId: string | null;
  adminEmail: string | null;
}

/**
 * Impersonation status for the app-shell banner. Safe for any session —
 * it reports state only; the EXIT action does the privileged work. When
 * the stashed token is dead (expired/revoked) the cookie is cleared and
 * impersonation reports off; the admin re-authenticates normally.
 */
export async function getImpersonationState(): Promise<ImpersonationState> {
  const raw = getCookie(ADMIN_RETURN_COOKIE);
  const ctx = await getSessionFromRequest();
  if (!raw || !ctx) {
    return {
      active: false,
      viewedBusinessId: ctx?.business.id ?? null,
      viewedBusinessName: ctx?.business.name ?? null,
      adminUserId: null,
      adminEmail: null,
    };
  }
  const stashed = await getSessionByTokenHash(await hashToken(raw));
  if (!stashed) {
    // Stashed admin session died (expired/revoked) — can't exit back into
    // it. Clear the cookie; the user is the target owner until they sign out.
    deleteCookie(ADMIN_RETURN_COOKIE, { path: "/" });
    return {
      active: false,
      viewedBusinessId: ctx.business.id,
      viewedBusinessName: ctx.business.name,
      adminUserId: null,
      adminEmail: null,
    };
  }
  const active = stashed.userData.businessId !== ctx.business.id;
  return {
    active,
    viewedBusinessId: ctx.business.id,
    viewedBusinessName: ctx.business.name,
    adminUserId: stashed.userData.id,
    adminEmail: stashed.userData.email,
  };
}

// ---------------------------------------------------------------------------
// Privileged actions (each one audit-logged, audit write REQUIRED)
// ---------------------------------------------------------------------------

export type ImpersonateResult =
  | { ok: true; viewedBusinessName: string }
  | { ok: false; error: string };

/**
 * Start viewing-as. Audit row is written BEFORE any cookie/session change;
 * a logging failure aborts the impersonation (no unaudited session swap).
 */
export async function impersonateBusiness(
  adminUserId: string,
  targetBusinessId: string,
): Promise<ImpersonateResult> {
  const target = await getBusiness(targetBusinessId);
  if (!target) return { ok: false, error: "Business not found." };
  if (target.disabledAt != null) {
    return {
      ok: false,
      error: "This account is disabled — re-enable it before viewing as.",
    };
  }
  const raw = readSessionCookie();
  if (!raw) return { ok: false, error: "No active session." };

  // Audit FIRST — required, awaited, aborts on failure.
  await appendAdminAudit({
    adminUserId,
    action: "impersonate_start",
    targetBusinessId,
    detail: { targetBusinessName: target.name },
  });

  // The target's ACTIVE owner user (an account with no active owner cannot
  // be impersonated into — honest refusal instead of a broken session).
  const ownerId = await getActiveOwnerUserId(targetBusinessId);
  if (!ownerId) {
    return { ok: false, error: "This account has no active owner user to view as." };
  }

  // Stash the admin's token, then make the impersonated session active.
  // The admin's own session row stays live — exit restores it by token.
  setCookie(ADMIN_RETURN_COOKIE, raw, {
    ...ADMIN_COOKIE_OPTIONS,
    maxAge: 60 * 60 * 8, // 8h — the stash never outlives a workday
  });
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await createSession(ownerId, await hashToken(token), new Date(Date.now() + SESSION_TTL_MS));
  setCookie(SESSION_COOKIE, token, { ...ADMIN_COOKIE_OPTIONS, maxAge: SESSION_TTL_MS / 1000 });

  return { ok: true, viewedBusinessName: target.name };
}

export type ExitResult = { ok: true } | { ok: false; error: string };

/**
 * Exit viewing-as: destroy the impersonated session, restore the stashed
 * admin token as the active cookie, clear the stash, audit the stop. The
 * admin user id for the audit comes from the STASHED session (the current
 * session belongs to the target's owner, not the admin).
 */
export async function exitImpersonation(): Promise<ExitResult> {
  const raw = getCookie(ADMIN_RETURN_COOKIE);
  if (!raw) return { ok: false, error: "Not currently impersonating." };
  const stashed = await getSessionByTokenHash(await hashToken(raw));
  if (!stashed) {
    deleteCookie(ADMIN_RETURN_COOKIE, { path: "/" });
    return { ok: false, error: "Admin session expired — sign in again." };
  }
  const ctx = await getSessionFromRequest();
  const impersonating = ctx != null && ctx.business.id !== stashed.userData.businessId;
  if (!impersonating) {
    // Stash exists but the active session is already the admin's own
    // (e.g. double-exit) — just clear the stale cookie, no audit noise.
    deleteCookie(ADMIN_RETURN_COOKIE, { path: "/" });
    return { ok: true };
  }

  await appendAdminAudit({
    adminUserId: stashed.userData.id,
    action: "impersonate_stop",
    targetBusinessId: ctx!.business.id,
    detail: { targetBusinessName: ctx!.business.name },
  });

  // Destroy the impersonated session, restore the admin's own.
  await deleteSession(await hashToken(ctx!.session.tokenHash));
  deleteCookie(ADMIN_RETURN_COOKIE, { path: "/" });
  setCookie(SESSION_COOKIE, raw, { ...ADMIN_COOKIE_OPTIONS, maxAge: SESSION_TTL_MS / 1000 });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Account disable / enable (kill switch + session revocation)
// ---------------------------------------------------------------------------

/**
 * Disable or re-enable a customer account. Disable revokes EVERY live
 * session belonging to the business's users (delete of session rows joined
 * through users) and sets businesses.disabled_at; the session resolver and
 * loginFn both honor the flag afterwards. Both actions are audit-logged
 * with the reason when given.
 */
export async function setAccountDisabled(
  adminUserId: string,
  targetBusinessId: string,
  disabled: boolean,
  reason?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = await getBusiness(targetBusinessId);
  if (!target) return { ok: false, error: "Business not found." };
  await appendAdminAudit({
    adminUserId,
    action: disabled ? "account_disable" : "account_enable",
    targetBusinessId,
    detail: { businessName: target.name, reason: reason ?? null },
  });
  const { setBusinessDisabled } = await import("~/db/queries/admin");
  await setBusinessDisabled(targetBusinessId, disabled ? new Date() : null);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Plan override (manual, honest)
// ---------------------------------------------------------------------------

/**
 * Change a business's plan outside Stripe. Writes the plan, clears Stripe
 * subscription lifecycle state the old plan claimed (subscription_status,
 * period end) so the billing page doesn't advertise a live Stripe
 * subscription the platform isn't collecting on, records a local
 * billing_event (plan_change, source local, description says manual), and
 * audits the override.
 */
export async function overrideAccountPlan(
  adminUserId: string,
  targetBusinessId: string,
  plan: "trial" | "starter" | "pro",
  reason?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const target = await getBusiness(targetBusinessId);
  if (!target) return { ok: false, error: "Business not found." };
  if (target.plan === plan) {
    return { ok: false, error: `Plan is already ${plan}.` };
  }
  await appendAdminAudit({
    adminUserId,
    action: "plan_override",
    targetBusinessId,
    detail: {
      businessName: target.name,
      from: target.plan,
      to: plan,
      reason: reason ?? null,
      note: "manual override (Stripe not configured)",
    },
  });
  const db = (await import("~/db/queries/shared")).sql();
  await db.query(
    `UPDATE businesses
     SET plan = $2::business_plan,
         subscription_status = NULL,
         current_period_end = NULL
     WHERE id = $1`,
    [targetBusinessId, plan],
  );
  const { createBillingEvent } = await import("~/db/queries/usage");
  await createBillingEvent({
    businessId: targetBusinessId,
    type: "plan_change",
    source: "local",
    description: `Manual plan override: ${target.plan} → ${plan} (Stripe not configured)`,
    payload: { from: target.plan, to: plan, actor: "admin", reason: reason ?? null },
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getActiveOwnerUserId(businessId: string): Promise<string | null> {
  const db = (await import("~/db/queries/shared")).sql();
  const rows = await db`
    SELECT id FROM users
    WHERE business_id = ${businessId} AND role = 'owner' AND is_active = true
    ORDER BY created_at ASC
    LIMIT 1`;
  const row = rows[0] as unknown as { id: string } | undefined;
  return row?.id ?? null;
}
