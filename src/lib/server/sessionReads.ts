/**
 * Plain (non-RPC) session read — the SSR-executed protected-route gate.
 *
 * WHY (PR #26/#27 postmortem, prod-only 500s): a createServerFn call inside
 * a route beforeLoad/loader compiles to an SSR RPC stub (createSsrRpc) — an
 * HTTP self-call through the hosting proxy that intermittently fails. The
 * /_app layout's beforeLoad used to call getSessionFn() during SSR, so every
 * authenticated page load gambled on that round trip. Route gates must call
 * PLAIN server functions during SSR; the getSessionFn() RPC wrapper in
 * sessionFns.ts stays for BROWSER-initiated calls (client-side navigation).
 *
 * Import-protection: server-only. Routes import this module only inside
 * `if (import.meta.env.SSR)` branches, dead-code-eliminated from the client
 * build.
 */
import { getSessionFromRequest } from "~/lib/server/auth.server";
import type { CurrentUserView } from "~/lib/server/sessionFns";

/**
 * Resolve the current session to a client-safe view (null when signed out).
 * Body identical to getSessionFn's handler — the wrapper delegates here.
 */
export async function currentSession(): Promise<CurrentUserView | null> {
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
}
