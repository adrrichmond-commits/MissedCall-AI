/**
 * Auth token email delivery (email verification + password reset links).
 *
 * Audit fix (2026-10-09, CRITICAL #1): before this module the two token links
 * were ONLY logged server-side (logDeliveryLink) — a pilot who forgot their
 * password was locked out unless the owner grepped logs, and RAW tokens sat in
 * server logs (account-takeover vector). This module rides the SAME transport
 * every other transactional email uses (src/lib/server/email.ts sendEmail —
 * Knock primary when KNOCK_API_KEY is set, Resend-style fallback), which is
 * the provider already proven live (ops digest delivered 2026-10).
 *
 * THE HONESTY RULES (mirroring emailDelivery.ts):
 *   - When no email transport is configured the outcome is
 *     "skipped_not_configured" with an EXPLICIT warning line in the log —
 *     never a faked "sent", never a silent drop. The link is NOT logged as a
 *     substitute: the caller triggers the flow again once a transport is
 *     configured (or delivers the new link by hand).
 *   - A raw token NEVER appears in any log line, on any path. The token
 *     travels in exactly one place: the email body itself. (This closes the
 *     audit's log-leak finding; suites assert it.)
 *   - A provider rejection or network failure becomes a "failed" outcome with
 *     the provider's own message — nothing pretends delivery happened.
 *   - This function NEVER throws into the caller: an email problem must not
 *     break signup/login/reset flows (same rule as notification email: the
 *     account action is the source of truth, email is best-effort delivery).
 *
 * The link origin is passed by the caller (authFns derives it from the
 * request via the same x-forwarded-host/host + x-forwarded-proto pattern
 * stripeApi.ts uses), so every environment (live site, working site, local
 * dev) builds links that actually resolve — nothing hard-coded.
 *
 * SEAM: tests inject a stub AuthEmailTransport (or point KNOCK_API_BASE at a
 * local stub server and go through the real sendEmail) — no DB, no network,
 * no real provider keys.
 */
import "@tanstack/react-start/server-only";
import { activeEmailTransport, isEmailConfigured, sendEmail } from "./email";

export type AuthEmailKind = "email-verification" | "password-reset";

export type AuthEmailOutcome =
  | "sent"
  | "skipped_not_configured"
  | "skipped_no_origin"
  | "failed";

export interface AuthEmailResult {
  outcome: AuthEmailOutcome;
  /** Provider message id when outcome === "sent". */
  emailId: string | null;
  /** Human-readable detail for the server log on skipped/failed outcomes. */
  detail: string | null;
}

/**
 * Transport seam. The production transport is src/lib/server/email.ts
 * sendEmail (Knock primary / Resend-style fallback) — the exact path the ops
 * digest and payment-failure emails ride. Tests substitute an in-memory stub.
 */
export interface AuthEmailTransport {
  /** True only when some transport's credentials are present. */
  isConfigured(): boolean;
  /** Transport label for honest log lines ("knock", "resend-style HTTP API"). */
  label(): string | null;
  send(args: { to: string; subject: string; text: string }): Promise<{ id: string }>;
}

/** Production transport: the shared sendEmail seam (unchanged). */
export const authEmailTransport: AuthEmailTransport = {
  isConfigured: isEmailConfigured,
  label: activeEmailTransport,
  send: (args) => sendEmail(args),
};

const PATHS: Record<AuthEmailKind, "/verify-email" | "/reset-password"> = {
  "email-verification": "/verify-email",
  "password-reset": "/reset-password",
};

/** The route the token link opens (kept in step with the token TTLs). */
export function buildAuthEmailPath(kind: AuthEmailKind): string {
  return PATHS[kind];
}

export function buildAuthEmailSubject(kind: AuthEmailKind): string {
  return kind === "email-verification"
    ? "Verify your email for MissedCall AI"
    : "Reset your MissedCall AI password";
}

/** Human expiry label from the token TTL ("24 hours", "60 minutes"). */
export function formatAuthEmailExpiry(ttlMs: number): string {
  const hours = ttlMs / (60 * 60 * 1000);
  if (Number.isInteger(hours) && hours >= 1) {
    return hours === 1 ? "1 hour" : hours + " hours";
  }
  const minutes = Math.max(1, Math.round(ttlMs / (60 * 1000)));
  return minutes === 1 ? "1 minute" : minutes + " minutes";
}

/**
 * Minimal, truthful plain-text body: what it is, the link, the expiry, and
 * the "ignore it" branch. No marketing, no invented claims.
 */
export function buildAuthEmailText(kind: AuthEmailKind, link: string, ttlMs: number): string {
  const expiry = formatAuthEmailExpiry(ttlMs);
  if (kind === "email-verification") {
    return (
      "Welcome to MissedCall AI.\n\n" +
      "Confirm the email address for your account by opening this link:\n" +
      link + "\n\n" +
      "The link expires in " + expiry + " and works once. " +
      "If you didn't create this account, you can ignore this email and nothing happens.\n\n" +
      "MissedCall AI"
    );
  }
  return (
    "We received a request to reset the password for the MissedCall AI account\n" +
    "with this email address.\n\n" +
    "Open this link to choose a new password:\n" +
    link + "\n\n" +
    "The link expires in " + expiry + " and works once. " +
    "If you didn't request a reset, you can ignore this email — your password stays unchanged.\n\n" +
    "MissedCall AI"
  );
}

export interface DeliverAuthEmailArgs {
  kind: AuthEmailKind;
  /** Recipient (the account holder's email). */
  to: string;
  /** The RAW token — goes ONLY into the email body, never into any log. */
  rawToken: string;
  /** Token TTL in ms (EMAIL_VERIFICATION_TTL_MS / PASSWORD_RESET_TTL_MS). */
  ttlMs: number;
  /** Absolute site origin ("https://www.answermissedcalls.com") for the link. */
  origin: string | null;
  /** Tests inject a stub; production uses the shared sendEmail transport. */
  transport?: AuthEmailTransport;
}

/**
 * Attempt the email for one auth token and record it honestly. NEVER throws —
 * every failure mode (unconfigured, no origin, provider, crash) becomes a
 * logged outcome. Callers do not branch on the result: signup/login/reset
 * succeeded before this ran and must not fail because email did.
 */
export async function deliverAuthEmail(args: DeliverAuthEmailArgs): Promise<AuthEmailResult> {
  const transport = args.transport ?? authEmailTransport;
  try {
    // 1. A link nobody can open is not a link — honest skip, no origin.
    if (!args.origin) {
      console.warn(
        "[auth:delivery] " + args.kind + " link NOT emailed to " + args.to +
          ": no request origin available to build a working link. The token " +
          "was discarded — run the flow again from the site so the link is built.",
      );
      return { outcome: "skipped_no_origin", emailId: null, detail: "no request origin available" };
    }
    // 2. Transport gate — honest, explicit, expected state before keys land.
    if (!transport.isConfigured()) {
      console.warn(
        "[auth:delivery] NO EMAIL TRANSPORT CONFIGURED — the " + args.kind +
          " link for " + args.to + " was NOT emailed and is NOT logged (raw " +
          "tokens never go to server logs). Configure KNOCK_API_KEY (primary) " +
          "or EMAIL_API_KEY + EMAIL_FROM (fallback), then trigger the flow " +
          "again so the link is emailed.",
      );
      return {
        outcome: "skipped_not_configured",
        emailId: null,
        detail: "no email transport configured (KNOCK_API_KEY / EMAIL_API_KEY + EMAIL_FROM missing)",
      };
    }
    const path = buildAuthEmailPath(args.kind);
    const link = args.origin.replace(/\/+$/, "") + path + "?token=" + encodeURIComponent(args.rawToken);
    const ttlMs = Math.max(60000, args.ttlMs);
    const subject = buildAuthEmailSubject(args.kind);
    const text = buildAuthEmailText(args.kind, link, ttlMs);
    const result = await transport.send({ to: args.to, subject, text });
    // Success log stays token-free on purpose — the token is inside the email.
    console.log(
      "[auth:delivery] " + args.kind + " email sent to " + args.to +
        " via " + (transport.label() ?? "email transport") + " (" + result.id + ")",
    );
    return { outcome: "sent", emailId: result.id, detail: null };
  } catch (err) {
    // Provider/network/seam failure: logged with the provider's own message,
    // never thrown into the caller, never reported as a send.
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      "[auth:delivery] " + args.kind + " email to " + args.to + " FAILED (" +
        detail + "). The link was not delivered — trigger the flow again.",
    );
    return { outcome: "failed", emailId: null, detail };
  }
}
