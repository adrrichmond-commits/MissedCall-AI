/**
 * Inbound SMS command detection (Phase 2 build #4 pre-wire).
 *
 * Pure + client-safe: no imports, no I/O — used by the Twilio inbound webhook
 * (src/routes/api/webhooks/twilio.ts) and unit-tested by scripts/test-sms.ts.
 *
 * Keyword set follows the Twilio/industry standard for SMS compliance:
 *   stop  → STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT
 *   start → START, UNSTOP (resubscribe — deliberately NOT "YES", which callers
 *           say in normal conversation and must never silently re-subscribe
 *           someone who opted out)
 *   help  → HELP, INFO
 *
 * A keyword matches when the trimmed body, uppercased with surrounding
 * punctuation stripped, EQUALS the keyword, or when its first
 * whitespace-separated token does ("STOP please" matches; "please stop"
 * does not — that is a sentence, not a carrier-standard command).
 */

export type SmsCommand = "stop" | "start" | "help";

const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"] as const;
const START_WORDS = ["START", "UNSTOP"] as const;
const HELP_WORDS = ["HELP", "INFO"] as const;

function firstToken(body: string): string {
  const cleaned = body.trim().toUpperCase().replace(/[^A-Z ]/g, "").trim();
  if (cleaned.length === 0) return "";
  return cleaned.split(/\s+/)[0] ?? "";
}

export function parseSmsCommand(body: string | null | undefined): SmsCommand | null {
  if (!body) return null;
  const token = firstToken(body);
  if (token.length === 0) return null;
  if ((STOP_WORDS as readonly string[]).includes(token)) return "stop";
  if ((START_WORDS as readonly string[]).includes(token)) return "start";
  if ((HELP_WORDS as readonly string[]).includes(token)) return "help";
  return null;
}

/**
 * Normalize a phone number to E.164-ish for storage/matching:
 *   "+1 (512) 555-0134" → "+15125550134"
 *   "512-555-0134"      → "+15125550134"  (10 digits ⇒ US +1)
 *   "1-512-555-0134"    → "+15125550134"  (11 digits starting with 1)
 * Returns null when the input carries no 7+ digit run we can trust —
 * callers must treat null as "cannot act", never guess a country code.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7) return null;
  if (plus) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  // Too ambiguous (international, extension codes) — keep the digits with +
  // so lookups stay consistent, but flag nothing; matching is best-effort.
  return "+" + digits;
}

/** Last 10 digits of a phone, for tolerant matching between stored formats. */
export function phoneKey(input: string | null | undefined): string | null {
  const digits = (input ?? "").replace(/\D/g, "");
  if (digits.length < 7) return null;
  return digits.slice(-10);
}
