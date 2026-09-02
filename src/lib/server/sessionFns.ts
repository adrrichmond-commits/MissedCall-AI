/**
 * Server functions for the authenticated app shell: session resolution,
 * role-guarded example handlers. Route loaders call these to decide between
 * rendering the app shell and redirecting to /login.
 *
 * RBAC note: every guard here is server-side (requireAuth/requireRole throw
 * AuthError). The client only reacts to their results — it never decides.
 */
import { createServerFn } from "@tanstack/react-start";
import { AuthError } from "~/lib/server/auth";
import { getSessionFromRequest, requireAuth, requireRole } from "~/lib/server/auth.server";
import { countUsers } from "~/db/queries/auth";

/** Client-safe view of the session (no hashes, no tokens). */
export interface CurrentUserView {
  userId: string;
  email: string;
  fullName: string;
  role: "owner" | "manager" | "employee";
  emailVerified: boolean;
  businessId: string;
  businessName: string;
  businessPlan: string;
  /** ISO string for client rendering. */
  sessionExpiresAt: string;
}

/** Resolve the current session to a client-safe view (null when signed out). */
export const getSessionFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<CurrentUserView | null> => {
    const ctx = await getSessionFromRequest();
    if (!ctx) return null;
    return {
      userId: ctx.user.id,
      email: ctx.user.email,
      fullName: ctx.user.fullName,
      role: ctx.role,
      emailVerified: ctx.user.emailVerified,
      businessId: ctx.business.id,
      businessName: ctx.business.name,
      businessPlan: ctx.business.plan,
      sessionExpiresAt: ctx.session.expiresAt.toISOString(),
    };
  },
);

/**
 * Owner/manager-only example: shows RBAC enforced at the server-fn layer.
 * The settings/teams UI (next task) will call fns shaped like this one.
 */
export const getTeamCountFn = createServerFn({ method: "GET" }).handler(async (): Promise<
  { ok: true; count: number } | { ok: false; status: 401 | 403; error: string }
> => {
  try {
    const ctx = await requireRole("owner", "manager");
    const count = await countUsers(ctx.business.id);
    return { ok: true, count };
  } catch (e) {
    return authErrorToResult(e);
  }
});

/** Employee-readable example: any authenticated user may call it. */
export const getMyRoleFn = createServerFn({ method: "GET" }).handler(async (): Promise<
  { ok: true; role: string } | { ok: false; status: 401 | 403; error: string }
> => {
  try {
    const ctx = await requireAuth();
    return { ok: true, role: ctx.role };
  } catch (e) {
    return authErrorToResult(e);
  }
});

export function authErrorToResult(e: unknown): { ok: false; status: 401 | 403; error: string } {
  if (e instanceof AuthError) {
    return { ok: false, status: e.kind === "forbidden" ? 403 : 401, error: e.message };
  }
  console.error("[app] unexpected server error:", e);
  return { ok: false, status: 401, error: "Something went wrong." };
}
