/**
 * Twilio SMS service (Phase 2 build #4 pre-wire).
 *
 * Sends SMS through Twilio's REST API with plain fetch — no SDK dependency.
 * Reads configuration from the environment ONCE per call (never hard-coded,
 * never cached at module scope so test runs and dev servers pick changes up):
 *
 *   TWILIO_ACCOUNT_SID   e.g. ACxxxxxxxx...
 *   TWILIO_AUTH_TOKEN    the account auth token
 *   TWILIO_SMS_NUMBER    the sending number, E.164 (e.g. +15125550134)
 *
 * HONESTY RULE: if any variable is missing, isSmsConfigured() is false and
 * sendSms() throws SmsNotConfiguredError. Callers decide the fallback —
 * nothing here pretends a message was sent. Callers MUST NOT log or report a
 * send that did not happen; on failure they surface the honest state
 * (see captureMissedCallLead in textBack.ts).
 */
import "@tanstack/react-start/server-only";

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";

export interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

/** Read + validate Twilio env config. Returns null when anything is missing. */
export function readSmsConfig(): SmsConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_SMS_NUMBER;
  if (!accountSid || !authToken || !fromNumber) return null;
  if (accountSid.length === 0 || authToken.length === 0 || fromNumber.length === 0) return null;
  return { accountSid, authToken, fromNumber };
}

/** True only when every Twilio credential is present. */
export function isSmsConfigured(): boolean {
  return readSmsConfig() !== null;
}

/** One honest init line — says which state, never claims a provider exists. */
export function logSmsStatus(): void {
  if (isSmsConfigured()) {
    console.log("[sms] Twilio configured - outbound SMS enabled");
  } else {
    console.log("[sms] Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_SMS_NUMBER missing) - SMS disabled, sending will fail fast");
  }
}

/** Typed error so callers can distinguish "not wired" from "provider failed". */
export class SmsNotConfiguredError extends Error {
  constructor() {
    super("SMS is not configured: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_SMS_NUMBER.");
    this.name = "SmsNotConfiguredError";
  }
}

export class SmsSendError extends Error {
  constructor(
    message: string,
    /** Twilio error code when the API returned one (e.g. 21606 for opt-out). */
    readonly twilioCode: number | null,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "SmsSendError";
  }
}

export interface SendSmsResult {
  /** Twilio message SID (SM...) when accepted by the API. */
  sid: string;
  status: string;
  to: string;
  from: string;
}
// ---------------------------------------------------------------------------
// P4-I: retry-with-backoff on the send path.
//
// Transient Twilio/API failures (network errors, 429, 5xx) are retried with
// exponential backoff BEFORE the caller ever sees a failure — a blip should
// not silently drop a text-back. Permanent rejections (4xx other than 429,
// e.g. opt-out violation 21606, invalid number) fail immediately: retrying
// them cannot succeed and would hammer the API. On FINAL failure the CALLER
// (textBack.ts) records a failed-delivery system_error — this module only
// retries, it never hides the outcome.
// ---------------------------------------------------------------------------
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = [400, 1200];
export interface SendSmsOptions {
  /** Extra attempts after the first (default 2; 0 = single attempt). */
  retries?: number;
  /** Backoff before attempt i+1 (default [400, 1200] ms). */
  backoffMs?: number[];
}
function isTransientSmsFailure(err: unknown): boolean {
  if (!(err instanceof SmsSendError)) return false;
  return err.httpStatus === 0 || err.httpStatus === 429 || err.httpStatus >= 500;
}
async function sendSmsOnce(config: SmsConfig, args: { to: string; body: string }): Promise<SendSmsResult> {
  const auth = Buffer.from(config.accountSid + ":" + config.authToken).toString("base64");
  const form = new URLSearchParams({ To: args.to, From: config.fromNumber, Body: args.body });
  let response: Response;
  try {
    response = await fetch(TWILIO_API_BASE + "/Accounts/" + config.accountSid + "/Messages.json", {
      method: "POST",
      headers: {
        Authorization: "Basic " + auth,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (cause) {
    throw new SmsSendError("Network error contacting Twilio: " + String(cause), null, 0);
  }
  const payload = (await response.json().catch(() => ({}))) as {
    sid?: string;
    status?: string;
    message?: string;
    code?: number;
  };
  if (!response.ok) {
    throw new SmsSendError(
      "Twilio rejected the message: " + (payload.message ?? response.statusText),
      payload.code ?? null,
      response.status,
    );
  }
  if (!payload.sid) {
    throw new SmsSendError("Twilio response missing message SID", null, response.status);
  }
  return { sid: payload.sid, status: payload.status ?? "queued", to: args.to, from: config.fromNumber };
}
/**
 * Send one SMS via Twilio's REST API (POST /Messages.json) with bounded
 * retry-with-backoff on transient failures. Throws SmsNotConfiguredError
 * when credentials are absent; SmsSendError (the LAST attempt's error) when
 * the API ultimately rejects. The signature is backward compatible — every
 * existing caller keeps working and now benefits from the retries.
 */
export async function sendSms(args: { to: string; body: string }, opts?: SendSmsOptions): Promise<SendSmsResult> {
  const config = readSmsConfig();
  if (!config) throw new SmsNotConfiguredError();
  const retries = Math.max(0, opts?.retries ?? DEFAULT_RETRIES);
  const backoff = opts?.backoffMs ?? DEFAULT_BACKOFF_MS;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 1000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await sendSmsOnce(config, args);
    } catch (err) {
      lastError = err;
      if (err instanceof SmsNotConfiguredError) throw err;
      if (!isTransientSmsFailure(err)) throw err;
      console.log("[sms] transient failure (attempt " + (attempt + 1) + "/" + (retries + 1) + "): " + String(err));
    }
  }
  throw lastError;
}
