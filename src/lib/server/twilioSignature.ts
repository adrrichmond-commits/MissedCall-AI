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

/**
 * Behind the platform's reverse proxy the origin does not see the public URL
 * Twilio signed: `request.url` carries an internal host, and multi-hop proxies
 * may rewrite `x-forwarded-host` to an intermediate host. Verified 2026-09-28
 * against the live platform (temporary echo route): a request to the public
 * dev URL arrived with `request.url` = an internal `*.prod.aws.beamlit.net`
 * host and `x-forwarded-host` = an intermediate `*.preview.bl.run` host.
 * Neither equals the public origin Twilio puts in its signature. The signature
 * URL is therefore resolved, in priority order:
 *
 *   1. `TWILIO_WEBHOOK_BASE_URL` (site secret/env) - the exact public base the
 *      Twilio number's webhooks are configured with; path+query come from the
 *      incoming request. The only source that survives proxy chains that
 *      rewrite the forwarded host.
 *   2. `x-forwarded-proto` + `x-forwarded-host` (+ `x-forwarded-port` when
 *      non-default) - the standard single-proxy case.
 *   3. `request.url` unchanged - local dev and host-preserving proxies.
 *
 * SECURITY: candidate-set validation never loosens the contract. Every
 * candidate is a deterministic URL built ONLY from configuration, proxy
 * headers, and the incoming request line - never from POST parameters - and
 * a signature is accepted only if it validates (HMAC-SHA1 with the real
 * TWILIO_AUTH_TOKEN) against at least one candidate. An attacker cannot forge
 * a valid signature for any candidate without the auth token, so "valid
 * signature implies token holder" is preserved exactly; the 403/503/404
 * honesty contracts are unchanged.
 */

/** First element of a comma-separated forwarded header value, trimmed. */
export function firstForwardedValue(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim() ?? "";
  return first.length > 0 ? first : null;
}

function isDefaultPort(port: string, proto: string): boolean {
  return (proto === "https" && port === "443") || (proto === "http" && port === "80");
}

/**
 * Best-effort public origin from proxy headers. Returns null when no usable
 * forwarded/host header is present (plain local dev).
 */
export function forwardedPublicOrigin(headers: Headers): string | null {
  const host = firstForwardedValue(headers.get("x-forwarded-host")) ?? firstForwardedValue(headers.get("host"));
  if (!host) return null;
  const port = firstForwardedValue(headers.get("x-forwarded-port"));
  const protoRaw = firstForwardedValue(headers.get("x-forwarded-proto"));
  // No proto header: infer from the port (80=http), defaulting to https.
  const proto = protoRaw === "http" || protoRaw === "https" ? protoRaw : port === "80" ? "http" : "https";
  let hostPart = host;
  // A port belongs in the host only when non-default for the scheme and not
  // already embedded (x-forwarded-host may carry "host:port" itself).
  if (port && /^\d{1,5}$/.test(port) && !isDefaultPort(port, proto) && !hostPart.includes(":")) {
    hostPart = hostPart + ":" + port;
  }
  try {
    return new URL(proto + "://" + hostPart).origin;
  } catch {
    // Malformed forwarded host (proxy garbage) - no candidate from headers.
    return null;
  }
}

function requestPathAndSearch(request: Request): string {
  const u = new URL(request.url);
  return u.pathname + u.search;
}

function configuredWebhookBase(): string | null {
  const raw = (process.env.TWILIO_WEBHOOK_BASE_URL ?? "").trim();
  return raw.length > 0 ? raw : null;
}

/**
 * The single best-known public request URL: configured base first, then
 * forwarded headers, then request.url. Used where ONE url is needed (voice
 * TwiML action/callback URLs must be publicly reachable by Twilio's servers).
 */
export function publicRequestUrl(request: Request): string {
  const rest = requestPathAndSearch(request);
  const configured = configuredWebhookBase();
  if (configured) {
    try {
      return new URL(rest, configured).toString();
    } catch {
      // Fall through to header reconstruction on a malformed override.
    }
  }
  const origin = forwardedPublicOrigin(request.headers);
  if (origin) {
    try {
      return new URL(rest, origin).toString();
    } catch {
      // Fall through to request.url.
    }
  }
  return request.url;
}

/**
 * Every honest candidate for "the URL Twilio signed", in priority order
 * (configured override, forwarded-header reconstruction, request.url).
 * Deduplicated; never empty.
 */
export function candidateSignatureUrls(request: Request): string[] {
  const rest = requestPathAndSearch(request);
  const out: string[] = [];
  const configured = configuredWebhookBase();
  if (configured) {
    try {
      out.push(new URL(rest, configured).toString());
    } catch {
      // Ignore malformed override; other candidates still apply.
    }
  }
  const origin = forwardedPublicOrigin(request.headers);
  if (origin) {
    try {
      out.push(new URL(rest, origin).toString());
    } catch {
      // Ignore malformed header origin.
    }
  }
  out.push(request.url);
  return [...new Set(out)];
}

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

/**
 * Validate a Twilio signature against ANY of the candidate URLs (see
 * candidateSignatureUrls). Passes only when at least one candidate validates
 * with the real auth token - never accepts unsigned or wrongly-signed traffic.
 */
export async function twilioSignatureIsValidAny(args: {
  urls: string[];
  params: Record<string, string>;
  signature: string | null;
  authToken: string;
}): Promise<boolean> {
  if (!args.signature) return false;
  for (const url of args.urls) {
    if (await twilioSignatureIsValid({ url, params: args.params, signature: args.signature, authToken: args.authToken })) {
      return true;
    }
  }
  return false;
}
