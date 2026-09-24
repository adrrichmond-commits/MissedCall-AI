/**
 * Twilio inbound-VOICE webhook (P3-E — AI voice receptionist).
 *
 * POST /api/webhooks/twilio/voice — receives Twilio's form-encoded voice
 * request + Gather results + status/recording callbacks, validates the
 * X-Twilio-Signature HMAC (same helper as the SMS path), and hands off to
 * the receptionist orchestrator (src/lib/server/voiceReceptionist.ts).
 * The response is always TwiML XML (application/xml) or a bare 403 —
 * Twilio NEVER receives a JSON error or an error page on the voice path.
 *
 * HONESTY RULE: without TWILIO_AUTH_TOKEN the route cannot verify anything —
 * 503, never a silent accept (same rule as the SMS webhook).
 *
 * Route shape: createFileRoute(...).options.server.handlers (see twilio.ts;
 * there is no createAPIFileRoute export in 1.158).
 */
import { createFileRoute } from "@tanstack/react-router";
import { checkRateLimit, clientIpFromHeaders } from "~/lib/server/rateLimit";
import { captureSystemError } from "~/lib/server/errorSink";
import { readSmsConfig } from "~/lib/server/sms";
import { TWILIO_SIGNATURE_HEADER } from "~/lib/server/twilioSignature";
import { handleVoiceWebhook, neonVoiceCallStore, parseVoiceParams } from "~/lib/server/voiceReceptionist";

const VOICE_STORE = neonVoiceCallStore();
const TWINML_HEADERS = { "content-type": "application/xml" };
/**
 * P4-I NEVER-A-DEAD-END fallback TwiML: if anything UNEXPECTED throws while
 * handling a live call, the caller still hears an apology and can leave a
 * voicemail — the failure is recorded in system_errors (visible on
 * /admin/health) and the call is never answered with silence or an error
 * page. (Handled outcomes — signature 403s, DB-down flows — already return
 * their own TwiML inside handleVoiceWebhook.)
 */
function fallbackTwiML(): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Say>We are sorry, we had trouble with this call. Please leave a message after the beep.</Say><Record timeout="10"/></Response>';
}

async function handlePost(request: Request): Promise<Response> {
  // 0. P4-I per-IP rate limit (generous: Twilio bursts + retries fit). A
  //    429 is TwiML too — Twilio speaks the fallback instead of erroring.
  const rl = checkRateLimit("twilio_webhook", clientIpFromHeaders(request.headers));
  if (!rl.allowed) {
    return new Response(fallbackTwiML(), { status: 429, headers: { ...TWINML_HEADERS, "Retry-After": String(rl.retryAfterSec) } });
  }
  // 1. Honest gate: no Twilio credentials → nothing can be verified.
  const config = readSmsConfig();
  if (!config) {
    return Response.json(
      { error: "twilio_not_configured", message: "Voice answering is not active: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set. Nothing was processed." },
      { status: 503 },
    );
  }

  try {
  // 2. Parse + validate signature BEFORE any business work.
  const raw = await request.text();
  const { all, typed } = parseVoiceParams(raw);
  const result = await handleVoiceWebhook({
    params: typed,
    allParams: all,
    url: request.url,
    signature: request.headers.get(TWILIO_SIGNATURE_HEADER),
    authToken: config.authToken,
    store: VOICE_STORE,
  });

  if (result.xml === null) {
    // Signature failure (or an unparseable payload on a guarded path) —
    // the same 403 contract as the SMS webhook.
    return new Response("Forbidden", { status: result.status });
  }
  return new Response(result.xml, {
    status: result.status,
    headers: TWINML_HEADERS,
  });
  } catch (err) {
    // P4-I: record AND keep serving the caller — never a dead end.
    captureSystemError({
      source: "voice_call",
      message: "Voice webhook failed unexpectedly: " + (err instanceof Error ? err.message : String(err)),
      detail: { url: new URL(request.url).pathname },
    });
    return new Response(fallbackTwiML(), { status: 200, headers: TWINML_HEADERS });
  }
}

export const Route = createFileRoute("/api/webhooks/twilio/voice")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) => handlePost(request),
    },
  },
});
