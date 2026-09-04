/**
 * Twilio inbound-SMS webhook (Phase 2 build #4 pre-wire).
 *
 * POST /api/webhooks/twilio — receives Twilio's form-encoded inbound message
 * callbacks, validates the X-Twilio-Signature HMAC (only when credentials are
 * present), stores the message honestly, runs STOP/START/HELP handling with
 * opt-out persistence, and triggers LLM classification when the LLM is
 * configured (status 'unclassified' otherwise — never an invented parse).
 *
 * HONESTY RULE: without TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN the route
 * answers 503 with a clear JSON error — it never accepts or processes
 * unauthenticated traffic it cannot verify.
 *
 * Route shape: this TanStack Start version wires server handlers through
 * `createFileRoute(...).options.server.handlers` (see the createStartHandler
 * server-route pipeline; there is no createAPIFileRoute export in 1.158).
 */
import { createFileRoute } from "@tanstack/react-router";
import { isSmsConfigured, readSmsConfig } from "~/lib/server/sms";
import { TWILIO_SIGNATURE_HEADER, twilioSignatureIsValid } from "~/lib/server/twilioSignature";
import { handleInboundSms } from "~/lib/server/textBack";
import { normalizePhone, phoneKey } from "~/lib/smsCommands";
import * as q from "~/db/queries";

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}

interface TwilioInboundParams {
  MessageSid?: string;
  From?: string;
  To?: string;
  Body?: string;
}

async function handlePost(request: Request): Promise<Response> {
  // 1. Honest gate: without Twilio credentials this endpoint cannot verify or
  //    process anything — 503, never a silent accept.
  if (!isSmsConfigured()) {
    return jsonError(
      503,
      "twilio_not_configured",
      "Inbound SMS is not active: TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_SMS_NUMBER are not set. Nothing was processed.",
    );
  }

  // 2. Parse the form-encoded payload.
  const raw = await request.text();
  const params: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw).entries()) params[k] = v;
  const inbound = params as TwilioInboundParams;
  const from = typeof inbound.From === "string" ? inbound.From : "";
  const body = typeof inbound.Body === "string" ? inbound.Body : "";
  const messageSid = typeof inbound.MessageSid === "string" ? inbound.MessageSid : null;
  if (!from || !body) {
    return jsonError(400, "bad_request", "Missing From or Body in the Twilio payload.");
  }

  // 3. Signature validation (HMAC-SHA1 over URL + sorted params).
  const config = readSmsConfig();
  if (!config) return jsonError(503, "twilio_not_configured", "Twilio credentials unavailable.");
  const signature = request.headers.get(TWILIO_SIGNATURE_HEADER);
  const valid = await twilioSignatureIsValid({
    url: request.url,
    params,
    signature,
    authToken: config.authToken,
  });
  if (!valid) {
    return jsonError(403, "invalid_signature", "X-Twilio-Signature validation failed.");
  }

  // 4. Route to the business that owns the called (To) number. Twilio gives
  //    us the number; every query is business-scoped by what it resolves to.
  //    Until phone-number assignment ships (onboarding step 6), match on the
  //    last-10-digits key of businesses.phone so the flow is provable against
  //    seeded data; unresolvable numbers are a 404, never a guess.
  const toKey = phoneKey(inbound.To ?? config.fromNumber);
  const businessRow = toKey
    ? ((await q.getBusinessByPhoneKey(toKey)) as { id: string; name: string } | null)
    : null;
  if (!businessRow) {
    return jsonError(404, "unknown_number", "No business is assigned the called number yet.");
  }
  const businessId = businessRow.id;
  const customerPhone = normalizePhone(from) ?? from;

  // 5. STOP check FIRST for already-opted-out numbers: store nothing new
  //    except a repeated STOP; never classify opt-out traffic.
  const commandParsingOnly = body.trim().toUpperCase();
  const isStop = commandParsingOnly.startsWith("STOP");
  if (await q.isSmsOptedOut(businessId, customerPhone)) {
    if (!isStop) {
      // Opted-out numbers get no processing, no replies, no classification.
      return Response.json({ ok: true, ignored: "opted_out" });
    }
  }

  // 6. Find or create the conversation for this customer phone. Conversations
  //    may pre-exist from the text-back; a fresh caller starts a new one.
  const conversation = await q.findOrCreateConversationForPhone(businessId, customerPhone);

  // 7. Store + command handling + (optional) LLM classification.
  const result = await handleInboundSms({
    businessId,
    businessName: businessRow.name,
    conversationId: conversation.id,
    body,
    from: customerPhone,
    externalId: messageSid,
  });

  return Response.json({ ok: true, command: result.command, status: result.status });
}

export const Route = createFileRoute("/api/webhooks/twilio")({
  server: {
    handlers: {
      // Handler receives the route-method ctx ({ request, params, ... }).
      POST: ({ request }: { request: Request }) => handlePost(request),
    },
  },
});
