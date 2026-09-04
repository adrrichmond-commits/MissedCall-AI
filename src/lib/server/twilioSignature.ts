/**
 * Twilio request signature validation (Phase 2 build #4 pre-wire).
 *
 * Twilio signs every webhook request with HMAC-SHA1 over the concatenation of
 * the full request URL and all POST parameters, sorted by parameter name,
 * base64-encoded — then puts it in the X-Twilio-Signature header. We implement
 * that exactly (no SDK dependency) using WebCrypto, which Bun and every edge
 * runtime provide. The auth token comes from TWILIO_AUTH_TOKEN at call time —
 * never hard-coded, never logged.
 *
 * Server-only (it validates secrets); imported exclusively by the webhook
 * route in src/routes/api/webhooks/twilio.ts.
 */

export const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";

function sortQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join("");
}

export async function twilioSignatureIsValid(args: {
  url: string;
  params: Record<string, string>;
  signature: string | null;
  authToken: string;
}): Promise<boolean> {
  if (!args.signature || args.signature.length === 0) return false;
  const data = args.url + sortQueryString(args.params);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(args.authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  // Length-prefixed compare guards the non-constant-time path from being
  // meaningfully exploitable on short-circuit; crypto.subtle output is fixed
  // length so in practice both are always equal length here.
  if (expected.length !== args.signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= (expected.charCodeAt(i) ?? 0) ^ (args.signature.charCodeAt(i) ?? 0);
  }
  return diff === 0;
}
