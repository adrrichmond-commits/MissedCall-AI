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
import { readSmsConfig } from "~/lib/server/sms";
import { TWILIO_SIGNATURE_HEADER } from "~/lib/server/twilioSignature";
import { handleVoiceWebhook, neonVoiceCallStore, parseVoiceParams } from "~/lib/server/voiceReceptionist";

const VOICE_STORE = neonVoiceCallStore();

async function handlePost(request: Request): Promise<Response> {
  // 1. Honest gate: no Twilio credentials → nothing can be verified.
  const config = readSmsConfig();
  if (!config) {
    return Response.json(
      { error: "twilio_not_configured", message: "Voice answering is not active: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set. Nothing was processed." },
      { status: 503 },
    );
  }

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
    headers: { "content-type": "application/xml" },
  });
}

export const Route = createFileRoute("/api/webhooks/twilio/voice")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }) => handlePost(request),
    },
  },
});
