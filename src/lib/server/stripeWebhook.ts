/**
 * Stripe webhook service (Phase 2 build #5) — env-gated, no Stripe SDK.
 *
 * Configuration from the environment, read ONCE per call (never cached at
 * module scope so test runs and dev servers pick changes up):
 *
 *   STRIPE_SECRET_KEY      sk_live_... / sk_test_... (presence gate)
 *   STRIPE_WEBHOOK_SECRET  whsec_... — signs every delivered event
 *   STRIPE_PRICE_STARTER   optional: price_xxx id that maps to the Starter tier
 *   STRIPE_PRICE_PRO       optional: price_xxx id that maps to the Pro tier
 *
 * Plan mapping NEVER hard-codes prices: businesses.plan is set from the
 * configured price IDs (starter/pro), and an unmapped price is reported
 * honestly instead of guessed. When no price env is set, a fallback maps by
 * unit_amount against PLANS.priceCents from src/lib/pricing.ts (the single
 * pricing source of truth) — a $149/mo price is Starter, a $249/mo price is
 * Pro, anything else is left untouched.
 *
 * HONESTY RULE: without STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET,
 * isStripeConfigured() is false and the webhook route answers 503 without
 * processing anything. Without a valid Stripe-Signature header nothing is
 * trusted: 403, nothing processed. Every event is deduped by its event id
 * (stripe_events, INSERT ON CONFLICT DO NOTHING) so Stripe's at-least-once
 * redelivery never double-applies a state change.
 *
 * Server-only (it validates secrets); imported by the webhook route in
 * src/routes/api/webhooks/stripe.ts and by scripts/test-stripe.ts (pure
 * helpers only — the Neon-backed store lives in src/db/queries/stripe.ts and
 * is never called by tests).
 */
import "@tanstack/react-start/server-only";
import { PLANS } from "~/lib/pricing";
import type { BusinessPlan } from "~/db/schema";

export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

/** Replay window: reject events whose signed timestamp drifts > 5 minutes. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Subscription statuses the DB CHECK (migration 009) accepts. */
export type WebhookSubscriptionStatus = "active" | "trialing" | "past_due" | "canceled";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** Optional explicit price-id → tier mapping (STRIPE_PRICE_* env vars). */
  priceStarter: string | null;
  pricePro: string | null;
}

/** Read + validate Stripe env config. Returns null when anything required is missing. */
export function readStripeConfig(): StripeConfig | null {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !webhookSecret) return null;
  if (secretKey.length === 0 || webhookSecret.length === 0) return null;
  const priceStarter = process.env.STRIPE_PRICE_STARTER || null;
  const pricePro = process.env.STRIPE_PRICE_PRO || null;
  return { secretKey, webhookSecret, priceStarter, pricePro };
}

/** True only when every credential Stripe webhooks require is present. */
export function isStripeConfigured(): boolean {
  return readStripeConfig() !== null;
}

/** One honest init line — says which state, never claims a provider exists. */
export function logStripeStatus(): void {
  if (isStripeConfigured()) {
    console.log("[stripe] configured - webhook activation enabled");
  } else {
    console.log(
      "[stripe] not configured (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET missing) - webhook route answers 503, nothing is processed",
    );
  }
}

/** Typed error so callers can distinguish "not wired" from "provider failed". */
export class StripeNotConfiguredError extends Error {
  constructor() {
    super("Stripe is not configured: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.");
    this.name = "StripeNotConfiguredError";
  }
}

// ---------------------------------------------------------------------------
// Signature verification (Stripe's v1 scheme, WebCrypto, no SDK)
// ---------------------------------------------------------------------------
/**
 * Parse the Stripe-Signature header: `t=<unix-seconds>,v1=<hex>[,v1=<hex>...]`.
 * Stripe may include several v1 signatures (key rotation); any valid one is
 * accepted. Returns null for a missing/malformed header.
 */
export function parseStripeSignatureHeader(
  header: string | null,
): { timestampSeconds: number; v1: string[] } | null {
  if (!header || header.length === 0) return null;
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || !/^\d+$/.test(value)) return null;
      timestamp = parsed;
    } else if (key === "v1") {
      if (value.length > 0) v1.push(value);
    }
    // v0 and other future schemes are ignored — we only verify v1.
  }
  if (timestamp === null || v1.length === 0) return null;
  return { timestampSeconds: timestamp, v1 };
}

/** Constant-time string compare (XOR-accumulate; no early return on mismatch). */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SignatureCheck {
  payload: string;
  /** Raw Stripe-Signature header value (or null when absent). */
  header: string | null;
  webhookSecret: string;
  /** Injected clock for tests; defaults to now. */
  nowMs?: number;
  /** Replay window; defaults to SIGNATURE_TOLERANCE_SECONDS. */
  toleranceSeconds?: number;
}

export type SignatureFailure = "missing_header" | "malformed_header" | "stale_timestamp" | "signature_mismatch";

export type SignatureResult = { valid: true } | { valid: false; reason: SignatureFailure };

/**
 * Verify Stripe's v1 signature scheme: HMAC-SHA256 over `${t}.${payload}`
 * keyed by the webhook secret, hex-encoded, compared constant-time against
 * every v1 entry; timestamps older/newer than the tolerance are rejected to
 * stop replays. Returns a typed result — never throws for a bad signature.
 */
export async function verifyStripeSignature(args: SignatureCheck): Promise<SignatureResult> {
  if (!args.header || args.header.length === 0) return { valid: false, reason: "missing_header" };
  const parsed = parseStripeSignatureHeader(args.header);
  if (!parsed) return { valid: false, reason: "malformed_header" };
  const tolerance = args.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - parsed.timestampSeconds) > tolerance) {
    return { valid: false, reason: "stale_timestamp" };
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(args.webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${parsed.timestampSeconds}.${args.payload}`),
  );
  const expected = toHex(new Uint8Array(mac));
  for (const candidate of parsed.v1) {
    if (constantTimeEquals(expected, candidate)) return { valid: true };
  }
  return { valid: false, reason: "signature_mismatch" };
}

// ---------------------------------------------------------------------------
// Event payload types (only the fields the handlers read)
// ---------------------------------------------------------------------------
export interface StripeEvent<T> {
  id: string;
  type: string;
  object: T;
}

export interface StripeCheckoutSession {
  id: string;
  customer: string | { id: string } | null;
  subscription: string | { id: string } | null;
  metadata: Record<string, string> | null;
  customer_email: string | null;
  customer_details: { email: string | null } | null;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string | { id: string } | null;
  /** Unix seconds; Stripe sends these as numbers on subscription objects. */
  current_period_end: number | null;
  metadata: Record<string, string> | null;
  items?: { data?: { price?: { id?: string | null; unit_amount?: number | null } }[] };
}

export interface StripeInvoice {
  id: string;
  customer: string | { id: string } | null;
  subscription: string | null;
  amount_due: number | null;
  currency: string | null;
  attempt_count: number | null;
  hosted_invoice_url: string | null;
}

export interface ParsedStripeEvent<T = unknown> {
  id: string;
  type: string;
  object: T;
}

/** Parse a webhook body into { id, type, object } or null (never throws). */
export function parseStripeEvent<T = unknown>(payload: string): ParsedStripeEvent<T> | null {
  try {
    const raw = JSON.parse(payload) as {
      id?: unknown;
      type?: unknown;
      data?: { object?: unknown };
    };
    if (typeof raw?.id !== "string" || raw.id.length === 0) return null;
    if (typeof raw?.type !== "string" || raw.type.length === 0) return null;
    const object = raw.data?.object;
    if (object === null || typeof object !== "object") return null;
    return { id: raw.id, type: raw.type, object: object as T };
  } catch {
    return null;
  }
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  return null;
}

/** Stripe statuses that are not in our CHECK map onto these (or null = ignore). */
export function mapSubscriptionStatus(status: string): WebhookSubscriptionStatus | null {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    // 'incomplete' (initial payment pending) is transitional — nothing true to
    // say yet, so nothing is written.
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Plan resolution — never hard-coded, env price IDs first, then price amount
// ---------------------------------------------------------------------------
/**
 * Map a Stripe price to the locked plan tier. Explicit env price IDs win
 * (STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO); without them, the price's
 * unit_amount must exactly match a priceCents value from the locked pricing
 * module (14900 → starter, 24900 → pro). Anything else returns null — an
 * unmapped price is never guessed into a tier.
 */
export function planForStripePrice(price: {
  id?: string | null;
  unit_amount?: number | null;
}): BusinessPlan | null {
  const config = readStripeConfig();
  const priceId = price.id ?? null;
  if (priceId) {
    if (config?.priceStarter && priceId === config.priceStarter) return "starter";
    if (config?.pricePro && priceId === config.pricePro) return "pro";
  }
  const amount = price.unit_amount ?? null;
  if (amount != null) {
    const exact = PLANS.filter((p) => p.priceCents === amount);
    if (exact.length === 1) return exact[0].id;
    if (exact.length > 1) return null; // ambiguous amount: never guess
  }
  return null;
}

/** First mappable price across the subscription's line items, or null. */
export function planForSubscription(sub: StripeSubscription): BusinessPlan | null {
  const items = sub.items?.data ?? [];
  for (const item of items) {
    if (!item?.price) continue;
    const plan = planForStripePrice(item.price);
    if (plan) return plan;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Store seam — production impl (src/db/queries/stripe.ts) + in-memory in tests
// ---------------------------------------------------------------------------
export interface StripeEventStore {
  /**
   * Claim the event id (INSERT ON CONFLICT DO NOTHING behind it).
   *   "first"             — this delivery inserted the row: process it.
   *   "duplicate"         — the event was already processed: skip.
   *   "unprocessed_retry" — a previous delivery claimed but never finished
   *                         (crash mid-handler): honestly process it again.
   */
  claimEvent(eventId: string, type: string, payload: unknown): Promise<"first" | "duplicate" | "unprocessed_retry">;
  /** Stamp processed_at after a successful (or deliberately-ignored) outcome. */
  markEventProcessed(eventId: string): Promise<void>;
  findBusinessIdByStripeCustomer(customerId: string): Promise<string | null>;
  findBusinessIdByStripeSubscription(subscriptionId: string): Promise<string | null>;
  findBusinessIdByEmail(email: string): Promise<string | null>;
  /** Link the business to its Stripe customer/subscription (one row upsert-ish update). */
  linkStripeIdentity(args: {
    businessId: string;
    customerId: string | null;
    subscriptionId: string | null;
  }): Promise<void>;
  /** Sync subscription lifecycle fields (status + period end + optional plan). */
  setSubscriptionState(args: {
    businessId: string;
    status: WebhookSubscriptionStatus;
    /** Unix seconds from the event, or null to leave current_period_end alone. */
    currentPeriodEndSeconds: number | null;
    /** null = leave businesses.plan unchanged (honest unknown-price path). */
    plan: BusinessPlan | null;
    /** The subscription id from the event; links the business when unset. */
    subscriptionId: string | null;
  }): Promise<void>;
  createPaymentFailedNotification(args: {
    businessId: string;
    payload: Record<string, unknown>;
  }): Promise<string | void>;
}

export type EventOutcome =
  | { handled: true; action: "processed"; detail: string }
  | { handled: true; action: "ignored"; detail: string }
  | { handled: true; action: "duplicate"; detail: string };

function sessionEmail(session: StripeCheckoutSession): string | null {
  const fromDetails = session.customer_details?.email ?? null;
  if (fromDetails && fromDetails.length > 0) return fromDetails;
  if (session.customer_email && session.customer_email.length > 0) return session.customer_email;
  return null;
}

function describeSubscriptionSync(sub: StripeSubscription): string {
  const plan = planForSubscription(sub);
  const priceIds = (sub.items?.data ?? [])
    .map((item) => item?.price?.id ?? null)
    .filter((v): v is string => v != null);
  const periodEnd =
    sub.current_period_end != null ? new Date(sub.current_period_end * 1000).toISOString() : "n/a";
  return `status=${sub.status} plan=${plan ?? "unmapped"} priceIds=[${priceIds.join(",")}] periodEnd=${periodEnd}`;
}

// ---------------------------------------------------------------------------
// Handlers — one per event type the app acts on; every write is idempotent
// (values-only state sync) and every event is claimed by id before dispatch.
// ---------------------------------------------------------------------------

/** checkout.session.completed — link business → stripe customer + subscription. */
async function handleCheckoutCompleted(
  event: ParsedStripeEvent<StripeCheckoutSession>,
  store: StripeEventStore,
): Promise<EventOutcome> {
  const session = event.object;
  const metadataBusinessId =
    typeof session.metadata?.businessId === "string" ? session.metadata.businessId : null;
  const email = sessionEmail(session);
  let businessId = metadataBusinessId ?? null;
  let resolvedVia = "metadata.businessId";
  if (!businessId && email) {
    businessId = await store.findBusinessIdByEmail(email);
    resolvedVia = "customer email lookup";
  }
  if (!businessId) {
    return {
      handled: true,
      action: "ignored",
      detail:
        "checkout.session.completed could not resolve a business (no metadata.businessId, no matching email) — linked nothing; plan unchanged.",
    };
  }
  const customerId = idOf(session.customer);
  const subscriptionId = idOf(session.subscription);
  await store.linkStripeIdentity({ businessId, customerId, subscriptionId });
  const parts = [
    "business " + businessId,
    customerId ? "customer " + customerId : "no customer",
    subscriptionId ? "subscription " + subscriptionId : "no subscription",
    "resolved via " + resolvedVia,
  ];
  if (!subscriptionId) {
    parts.push("no subscription on session — status/plan stay untouched until a subscription event arrives");
  }
  return { handled: true, action: "processed", detail: parts.join("; ") };
}

/**
 * customer.subscription.updated / .created — the activation path. When the
 * subscription is active/trialing the plan is set from its price (env-mapped
 * or exact-amount match) and current_period_end is recorded; an active
 * subscription clears the expired-trial lockout (requireActiveWrite honors
 * subscription_status='active' as an alternative to the trial window).
 * canceled/unpaid sync honestly: unpaid→past_due, canceled→plan 'trial'.
 */
async function handleSubscriptionUpdated(
  event: ParsedStripeEvent<StripeSubscription>,
  store: StripeEventStore,
): Promise<EventOutcome> {
  const sub = event.object;
  const businessId =
    (await store.findBusinessIdByStripeSubscription(sub.id)) ??
    (await store.findBusinessIdByStripeCustomer(idOf(sub.customer) ?? ""));
  if (!businessId) {
    return {
      handled: true,
      action: "ignored",
      detail:
        "customer.subscription.updated could not resolve a business by subscription id or customer id — nothing linked, plan unchanged.",
    };
  }
  const status = mapSubscriptionStatus(sub.status);
  if (!status) {
    return {
      handled: true,
      action: "ignored",
      detail:
        "subscription status '" +
        sub.status +
        "' is not mapped to a local state (" +
        describeSubscriptionSync(sub) +
        ") — left untouched rather than guessed.",
    };
  }
  const plan = planForSubscription(sub);
  await store.setSubscriptionState({
    businessId,
    status,
    currentPeriodEndSeconds: sub.current_period_end ?? null,
    plan,
    subscriptionId: sub.id,
  });
  return {
    handled: true,
    action: "processed",
    detail: describeSubscriptionSync(sub),
  };
}

/** customer.subscription.deleted — canceled: plan honestly back to trial. */
async function handleSubscriptionDeleted(
  event: ParsedStripeEvent<StripeSubscription>,
  store: StripeEventStore,
): Promise<EventOutcome> {
  const sub = event.object;
  const businessId =
    (await store.findBusinessIdByStripeSubscription(sub.id)) ??
    (await store.findBusinessIdByStripeCustomer(idOf(sub.customer) ?? ""));
  if (!businessId) {
    return {
      handled: true,
      action: "ignored",
      detail:
        "customer.subscription.deleted could not resolve a business — nothing changed.",
    };
  }
  await store.setSubscriptionState({
    businessId,
    status: "canceled",
    currentPeriodEndSeconds: sub.current_period_end ?? null,
    plan: "trial",
    subscriptionId: sub.id,
  });
  return {
    handled: true,
    action: "processed",
    detail:
      "subscription " +
      sub.id +
      " canceled — plan reset to trial, subscription_status='canceled', data preserved.",
  };
}

/** invoice.payment_failed — mark past_due + in-app notification (honest channel). */
async function handlePaymentFailed(
  event: ParsedStripeEvent<StripeInvoice>,
  store: StripeEventStore,
): Promise<EventOutcome> {
  const invoice = event.object;
  const businessId = await store.findBusinessIdByStripeCustomer(idOf(invoice.customer) ?? "");
  if (!businessId) {
    return {
      handled: true,
      action: "ignored",
      detail:
        "invoice.payment_failed could not resolve a business by customer id — no status change, no notification.",
    };
  }
  await store.setSubscriptionState({
    businessId,
    status: "past_due",
    currentPeriodEndSeconds: null,
    plan: null,
    subscriptionId: invoice.subscription && typeof invoice.subscription === "string" ? invoice.subscription : null,
  });
  await store.createPaymentFailedNotification({
    businessId,
    payload: {
      invoiceId: invoice.id,
      amountDue: invoice.amount_due,
      currency: invoice.currency,
      attemptCount: invoice.attempt_count,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
    },
  });
  return {
    handled: true,
    action: "processed",
    detail: "invoice " + invoice.id + " payment failed — business marked past_due + notified in-app.",
  };
}

/**
 * Route one verified Stripe event through the store. The event id is claimed
 * FIRST (INSERT ON CONFLICT DO NOTHING): an already-processed delivery is a
 * duplicate and short-circuits; a claimed-but-never-processed one (crashed
 * earlier) is honestly reprocessed. Throws only on infrastructure failure —
 * the route turns that into a 500 so Stripe redelivers, and the event stays
 * unprocessed in stripe_events.
 */
export async function handleStripeEvent<T>(
  event: ParsedStripeEvent<T>,
  store: StripeEventStore,
): Promise<EventOutcome> {
  const claim = await store.claimEvent(event.id, event.type, null);
  if (claim === "duplicate") {
    await store.markEventProcessed(event.id);
    return {
      handled: true,
      action: "duplicate",
      detail: "event " + event.id + " was already processed — skipped (idempotent redelivery).",
    };
  }
  // "first" and "unprocessed_retry" both run the handlers: a fresh delivery,
  // or an honest re-run after a crashed attempt (handlers are idempotent).
  let outcome: EventOutcome;
  try {
    switch (event.type) {
      case "checkout.session.completed":
        outcome = await handleCheckoutCompleted(
          event as ParsedStripeEvent<StripeCheckoutSession>,
          store,
        );
        break;
      case "customer.subscription.updated":
      case "customer.subscription.created":
        outcome = await handleSubscriptionUpdated(
          event as ParsedStripeEvent<StripeSubscription>,
          store,
        );
        break;
      case "customer.subscription.deleted":
        outcome = await handleSubscriptionDeleted(
          event as ParsedStripeEvent<StripeSubscription>,
          store,
        );
        break;
      case "invoice.payment_failed":
        outcome = await handlePaymentFailed(event as ParsedStripeEvent<StripeInvoice>, store);
        break;
      default:
        outcome = {
          handled: true,
          action: "ignored",
          detail: "event type '" + event.type + "' is not handled by this webhook — acknowledged, nothing done.",
        };
    }
  } catch (error) {
    // Do NOT mark processed: Stripe redelivers and we re-run (idempotent handlers).
    console.error("[stripe] handler failed for event " + event.id + ": " + String(error));
    throw error;
  }
  await store.markEventProcessed(event.id);
  return outcome;
}
