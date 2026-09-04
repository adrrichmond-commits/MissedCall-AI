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

/**
 * Send one SMS via Twilio's REST API (POST /Messages.json). Throws
 * SmsNotConfiguredError when credentials are absent; SmsSendError when the
 * API rejects (bad number, opt-out violation, carrier error, network).
 */
export async function sendSms(args: { to: string; body: string }): Promise<SendSmsResult> {
  const config = readSmsConfig();
  if (!config) throw new SmsNotConfiguredError();
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
