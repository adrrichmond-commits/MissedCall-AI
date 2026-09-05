/**
 * Transactional email service (Phase 2 build #6 pre-wire).
 *
 * Sends email through a plain HTTP API provider (Resend-style POST /emails
 * with a Bearer token) — no SDK dependency, mirroring how sms.ts talks to
 * Twilio with bare fetch. nodemailer is intentionally NOT added: it is not in
 * package.json, and the repo rule is no new heavy deps for an env-gated
 * pre-wire. Swapping providers later means changing one function here.
 *
 * Reads configuration from the environment ONCE per call (never hard-coded,
 * never cached at module scope so test runs and dev servers pick changes up):
 *
 *   EMAIL_API_KEY    provider API key (Bearer)
 *   EMAIL_FROM       "Name <addr>" or bare address (e.g. "MissedCall AI <notifications@missedcall.ai>")
 *   EMAIL_API_BASE   optional; default https://api.resend.com
 *   EMAIL_PROVIDER   optional display name for the init log line only
 *
 * HONESTY RULE: if EMAIL_API_KEY or EMAIL_FROM is missing, isEmailConfigured()
 * is false and sendEmail() throws EmailNotConfiguredError. Callers decide the
 * fallback — nothing here pretends a message was sent. A provider rejection
 * (non-2xx) or network failure throws EmailSendError carrying the provider's
 * own message, never a synthesized success.
 */
import "@tanstack/react-start/server-only";

const DEFAULT_EMAIL_API_BASE = "https://api.resend.com";

export interface EmailConfig {
  apiKey: string;
  from: string;
  apiBase: string;
  /** Display name for logs only (EMAIL_PROVIDER); never used for auth. */
  provider: string;
}

/** Read + validate email env config. Returns null when anything required is missing. */
export function readEmailConfig(): EmailConfig | null {
  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return null;
  if (apiKey.length === 0 || from.length === 0) return null;
  return {
    apiKey,
    from,
    apiBase: process.env.EMAIL_API_BASE || DEFAULT_EMAIL_API_BASE,
    provider: process.env.EMAIL_PROVIDER || "resend-style HTTP API",
  };
}

/** True only when every required credential is present. */
export function isEmailConfigured(): boolean {
  return readEmailConfig() !== null;
}

/** One honest init line — says which state, never claims a provider exists. */
export function logEmailStatus(): void {
  if (isEmailConfigured()) {
    const config = readEmailConfig();
    console.log("[email] " + config!.provider + " configured - outbound email enabled");
  } else {
    console.log(
      "[email] not configured (EMAIL_API_KEY / EMAIL_FROM missing) - email delivery disabled, sends will fail fast",
    );
  }
}

/** Typed error so callers can distinguish "not wired" from "provider failed". */
export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email is not configured: set EMAIL_API_KEY and EMAIL_FROM.");
    this.name = "EmailNotConfiguredError";
  }
}

export class EmailSendError extends Error {
  constructor(
    message: string,
    /** Provider error code when the API returned one (Resend-style `name`). */
    readonly providerCode: string | null,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "EmailSendError";
  }
}

export interface SendEmailArgs {
  to: string;
  subject: string;
  /** Plain-text body. Always sent; used as the primary content by text-only clients. */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
}

export interface SendEmailResult {
  /** Provider message id when accepted by the API. */
  id: string;
  status: string;
  to: string;
  from: string;
}

/**
 * Minimal in-process rate guard (one email per recipient per second, so a
 * burst of notifications cannot hammer the provider or a customer's inbox).
 * Deliberately not distributed — this is a courtesy backstop, not an SLA.
 */
const lastSendAtByRecipient = new Map<string, number>();
const MIN_SEND_INTERVAL_MS = 1000;

/** Test-only: clear the in-process rate gate (used by scripts/test-email.ts). */
export function resetEmailRateGateForTests(): void {
  lastSendAtByRecipient.clear();
}

function rateGate(to: string): void {
  const now = Date.now();
  const last = lastSendAtByRecipient.get(to.toLowerCase());
  if (last !== undefined && now - last < MIN_SEND_INTERVAL_MS) {
    const wait = MIN_SEND_INTERVAL_MS - (now - last);
    throw new EmailSendError("Local rate limit: retry in " + wait + "ms", "rate_limited", 429);
  }
  lastSendAtByRecipient.set(to.toLowerCase(), now);
}

/**
 * Send one email via POST {EMAIL_API_BASE}/emails. Throws
 * EmailNotConfiguredError when credentials are absent; EmailSendError when the
 * provider rejects the send (4xx/5xx, malformed response, network error).
 */
export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const config = readEmailConfig();
  if (!config) throw new EmailNotConfiguredError();
  rateGate(args.to);
  const body: Record<string, unknown> = {
    from: config.from,
    to: [args.to],
    subject: args.subject,
    text: args.text,
  };
  if (args.html !== undefined) body.html = args.html;
  let response: Response;
  try {
    response = await fetch(config.apiBase + "/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new EmailSendError("Network error contacting the email provider: " + String(cause), null, 0);
  }
  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    status?: string;
    message?: string;
    name?: string;
  };
  if (!response.ok) {
    throw new EmailSendError(
      "Email provider rejected the message: " + (payload.message ?? payload.name ?? response.statusText),
      payload.name ?? null,
      response.status,
  );
  }
  if (!payload.id) {
    throw new EmailSendError("Email provider response missing message id", null, response.status);
  }
  return { id: payload.id, status: payload.status ?? "sent", to: args.to, from: config.from };
}
