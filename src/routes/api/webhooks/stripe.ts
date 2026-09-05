/**
 * Stripe webhook (Phase 2 build #5) — POST /api/webhooks/stripe
 *
 * Receives Stripe event deliveries. HONESTY RULE: without
 * STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET the route answers 503 with a
 * clear JSON error and never accepts or processes unauthenticated traffic it
 * cannot verify (mirror of the Twilio webhook's 503 gate). With credentials
 * present, EVERY delivery must carry a valid Stripe-Signature v1 HMAC (fresh
 * timestamp, constant-time compare) — a bad or stale signature is a 403 with
 * nothing processed.
 *
 * Dispatch (see src/lib/server/stripeWebhook.ts):
 *   checkout.session.completed      → link business→customer/subscription
 *                                     (metadata.businessId, else email lookup)
 *   customer.subscription.updated   → sync subscription_status +
 *                                     current_period_end + plan from price;
 *                                     active clears the expired-trial lockout
 *   customer.subscription.deleted   → canceled: plan honestly back to trial
 *   invoice.payment_failed          → subscription_status='past_due' + in-app
 *                                     'payment_failed' notification
 * Every event is deduped by id (stripe_events, INSERT ON CONFLICT DO
 * NOTHING) so Stripe's at-least-once redelivery never double-applies.
 *
 * Route shape: this TanStack Start version wires server handlers through
 * `createFileRoute(...).options.server.handlers` (see the Twilio webhook;
 * there is no createAPIFileRoute export in 1.158).
 */
import { createFileRoute } from "@tanstack/react-router";
import {
  STRIPE_SIGNATURE_HEADER,
  isStripeConfigured,
  handleStripeEvent,
  parseStripeEvent,
  readStripeConfig,
  verifyStripeSignature,
} from "~/lib/server/stripeWebhook";
import {
  applyStripeSubscriptionState,
  claimStripeEvent,
  createPaymentFailedNotification,
  findBusinessIdByEmail,
  findBusinessIdByStripeCustomer,
  findBusinessIdByStripeSubscription,
  markStripeEventProcessed,
} from "~/db/queries/stripe";
import type { StripeEventStore } from "~/lib/server/stripeWebhook";

function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}

/** Production store: every write goes through the Neon-backed query layer. */
const neonStore: StripeEventStore = {
  claimEvent: (eventId, type, payload) => claimStripeEvent(eventId, type, payload),
  markEventProcessed: (eventId) => markStripeEventProcessed(eventId),
  findBusinessIdByStripeCustomer: (customerId) => findBusinessIdByStripeCustomer(customerId),
  findBusinessIdByStripeSubscription: (subscriptionId) =>
    findBusinessIdByStripeSubscription(subscriptionId),
  findBusinessIdByEmail: (email) => findBusinessIdByEmail(email),
  linkStripeIdentity: (args) =>
    applyStripeSubscriptionState({
      businessId: args.businessId,
      customerId: args.customerId,
      subscriptionId: args.subscriptionId,
      status: null,
      currentPeriodEndSeconds: null,
      plan: null,
    }),
  setSubscriptionState: (args) =>
    applyStripeSubscriptionState({
      businessId: args.businessId,
      customerId: null,
      subscriptionId: args.subscriptionId,
      status: args.status,
      currentPeriodEndSeconds: args.currentPeriodEndSeconds,
      plan: args.plan,
    }),
  createPaymentFailedNotification: (args) =>
    createPaymentFailedNotification(args.businessId, args.payload),
};

async function handlePost(request: Request): Promise<Response> {
  // 1. Honest gate: without Stripe credentials this endpoint cannot verify or
  //    process anything — 503, never a silent accept. (Shape mirrors the
  //    Twilio webhook's 503 exactly.)
  if (!isStripeConfigured()) {
    return jsonError(
      503,
      "stripe_not_configured",
      "Stripe webhooks are not active: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are not set. Nothing was processed.",
    );
  }

  // 2. Raw body FIRST — the signature covers exactly these bytes.
  const payload = await request.text();

  // 3. Signature validation (v1 HMAC-SHA256 over `${t}.${payload}`, fresh
  //    timestamp, constant-time compare). Before ANY business resolution or
  //    DB access.
  const config = readStripeConfig();
  if (!config) {
    return jsonError(
      503,
      "stripe_not_configured",
      "Stripe webhooks are not active: STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are not set. Nothing was processed.",
    );
  }
  const signature = request.headers.get(STRIPE_SIGNATURE_HEADER);
  const check = await verifyStripeSignature({
    payload,
    header: signature,
    webhookSecret: config.webhookSecret,
  });
  if (!check.valid) {
    const headers = new Headers();
    headers.set("Www-Authenticate", 'Signature realm="stripe-webhook"');
    return Response.json(
      {
        error: "invalid_signature",
        message: "Stripe-Signature validation failed (" + check.reason + "). Nothing was processed.",
      },
      { status: 403, headers },
    );
  }

  // 4. Parse AFTER the signature proves the payload is authentic.
  const event = parseStripeEvent(payload);
  if (!event) {
    return jsonError(
      400,
      "bad_request",
      "Body is not a parseable Stripe event — nothing was processed.",
    );
  }

  // 5. Dispatch through the dedupe + handlers. Infrastructure failure → 500 so
  //    Stripe redelivers; the event stays unprocessed in stripe_events.
  try {
    const outcome = await handleStripeEvent(event, neonStore);
    if (outcome.action === "processed") {
      console.log("[stripe] " + event.type + " " + event.id + ": " + outcome.detail);
    }
    return Response.json({ received: true, action: outcome.action });
  } catch (error) {
    console.error("[stripe] event " + event.id + " handler failed: " + String(error));
    return jsonError(
      500,
      "handler_failed",
      "The event was verified and stored but processing failed — Stripe will redeliver.",
    );
  }
}

export const Route = createFileRoute("/api/webhooks/stripe")({
  server: {
    handlers: {
      // Handler receives the route-method ctx ({ request, params, ... }).
      POST: ({ request }: { request: Request }) => handlePost(request),
      // Honest method routing: anything else is 405, never a silent 200.
      GET: () =>
        jsonError(405, "method_not_allowed", "Use POST — Stripe delivers events via POST."),
      PUT: () =>
        jsonError(405, "method_not_allowed", "Use POST — Stripe delivers events via POST."),
      DELETE: () =>
        jsonError(405, "method_not_allowed", "Use POST — Stripe delivers events via POST."),
    },
  },
});
