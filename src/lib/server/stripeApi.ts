/**
 * Minimal Stripe REST client (live billing, Phase 4) — no SDK, fetch + form
 * encoding against https://api.stripe.com/v1, authenticated with
 * STRIPE_SECRET_KEY (read once per call via readStripeConfig — never cached,
 * never logged, never echoed).
 *
 * This module is the WRITE side of billing (checkout sessions + price
 * lookups). The READ/receive side (webhook signature verification + event
 * handling) lives in src/lib/server/stripeWebhook.ts; the DB store seam is
 * src/db/queries/stripe.ts.
 *
 * SERVER-ONLY: imported only from server fns via dynamic import (see
 * requestPlanChangeFn in src/lib/server/billingFns.ts) so the secret never
 * reaches a client bundle.
 *
 * Price resolution order (never hard-coded amounts):
 *   1. STRIPE_PRICE_STARTER / STRIPE_PRICE_PRO env (explicit price IDs)
 *   2. a live price with lookup_key "starter" / "pro" (provisioned catalog)
 * If neither resolves, checkout refuses honestly instead of guessing.
 *
 * Trial handling mirrors the app: the business's recorded 14-day trial window
 * (trial_ends_at, src/lib/pricing.ts TRIAL_DAYS) is carried onto the Stripe
 * subscription as subscription_data[trial_end] while it is still in the
 * future, so nobody is charged before their app trial ends and nobody gets a
 * second free trial after it. An expired/unset window means billing starts
 * immediately.
 */
import { getRequestHeaders } from "@tanstack/react-start/server";
import { readStripeConfig, type StripeConfig } from "./stripeWebhook";

const STRIPE_API_BASE = "https://api.stripe.com/v1";

/** Typed failure so callers can show an honest error (never includes the key). */
export class StripeApiError extends Error {
  readonly status: number;
  readonly stripeCode: string | null;
  constructor(status: number, message: string, stripeCode: string | null = null) {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
    this.stripeCode = stripeCode;
  }
}

/**
 * Flatten params into Stripe's bracket notation: nested objects become
 * `a[b]=c`, arrays become `a[0]=x`. Stripe rejects JSON bodies on form
 * endpoints, so every POST is encoded this way.
 */
export function encodeStripeParams(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const path = prefix ? prefix + "[" + key + "]" : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === "object") {
          parts.push(encodeStripeParams(item as Record<string, unknown>, path + "[" + i + "]"));
        } else {
          parts.push(encodeURIComponent(path + "[" + i + "]") + "=" + encodeURIComponent(String(item)));
        }
      });
    } else if (typeof value === "object") {
      parts.push(encodeStripeParams(value as Record<string, unknown>, path));
    } else {
      parts.push(encodeURIComponent(path) + "=" + encodeURIComponent(String(value)));
    }
  }
  return parts.filter(Boolean).join("&");
}

export interface StripeCheckoutSessionResult {
  id: string;
  url: string | null;
  status: string | null;
}

/** One REST call. Throws StripeApiError on any non-2xx (message from Stripe). */
export async function stripeRequest<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> | null,
  config: StripeConfig,
): Promise<T> {
  let url = STRIPE_API_BASE + path;
  const init: RequestInit = {
    method,
    headers: {
      // Authorization carries the secret; it must never appear in logs or errors.
      Authorization: "Bearer " + config.secretKey,
    },
  };
  if (params && Object.keys(params).length > 0) {
    const encoded = encodeStripeParams(params);
    if (method === "GET") {
      url += "?" + encoded;
    } else {
      init.headers = { ...init.headers, "Content-Type": "application/x-www-form-urlencoded" };
      init.body = encoded;
    }
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new StripeApiError(0, "Stripe API unreachable: " + String(err));
  }
  const body = (await res.json().catch(() => null)) as
    | (T & { error?: { message?: string; code?: string } })
    | null;
  if (!res.ok) {
    const message = body?.error?.message ?? "Stripe API returned HTTP " + res.status;
    throw new StripeApiError(res.status, message, body?.error?.code ?? null);
  }
  return body as T;
}

/**
 * Pure: unix seconds at which the app's recorded trial window ends, or null
 * when the window is unset/already over (→ the subscription bills immediately).
 */
export function trialEndSecondsFor(trialEndsAt: Date | null, nowMs: number = Date.now()): number | null {
  if (!trialEndsAt) return null;
  const seconds = Math.floor(trialEndsAt.getTime() / 1000);
  return seconds > Math.floor(nowMs / 1000) ? seconds : null;
}

/** Success/cancel URLs on the app's billing page (matches the app's routes). */
export function checkoutReturnUrls(origin: string): { successUrl: string; cancelUrl: string } {
  const base = origin.replace(/\/+$/, "");
  return { successUrl: base + "/billing?checkout=success", cancelUrl: base + "/billing?checkout=cancelled" };
}

/**
 * Pure: checkout-session params for a subscription (mode=subscription, one
 * recurring price, business id in metadata AND client_reference_id so the
 * webhook can resolve the business even without an email match). When
 * trialEndSeconds is present the Stripe subscription trials until the app's
 * recorded trial window ends — never a fresh 14 days on top.
 */
export function buildSubscriptionCheckoutParams(args: {
  priceId: string;
  businessId: string;
  successUrl: string;
  cancelUrl: string;
  trialEndSeconds: number | null;
  customerEmail: string | null;
}): Record<string, unknown> {
  const subscriptionData: Record<string, unknown> = { metadata: { businessId: args.businessId } };
  if (args.trialEndSeconds != null) subscriptionData.trial_end = args.trialEndSeconds;
  const params: Record<string, unknown> = {
    mode: "subscription",
    line_items: [{ price: args.priceId, quantity: 1 }],
    subscription_data: subscriptionData,
    client_reference_id: args.businessId,
    metadata: { businessId: args.businessId },
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  };
  if (args.customerEmail) params.customer_email = args.customerEmail;
  return params;
}

/**
 * Resolve the Stripe price id for a locked plan tier: STRIPE_PRICE_* env
 * first, then a live lookup_key lookup ("starter"/"pro" — the provisioned
 * catalog). Returns null when neither resolves — callers must refuse
 * honestly rather than guess a price.
 */
export async function resolveStripePriceId(planId: "starter" | "pro", config: StripeConfig): Promise<string | null> {
  const envId = planId === "starter" ? config.priceStarter : config.pricePro;
  if (envId) return envId;
  try {
    const res = await stripeRequest<{ data?: { id?: string }[] }>(
      "GET",
      "/prices",
      { lookup_keys: [planId], active: true, limit: 1 },
      config,
    );
    return res.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * The app's public origin, derived from the incoming request (host +
 * x-forwarded-proto) so every environment (live, working site, local dev)
 * gets correct success/cancel URLs without hard-coding anything.
 */
export function appOriginFromRequest(): string | null {
  const headers = getRequestHeaders();
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) return null;
  const proto = headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return proto + "://" + host;
}

/**
 * Create a subscription Checkout Session for a business (the API-driven
 * checkout path). Returns the hosted session URL, or a typed failure the
 * caller surfaces honestly. Never completes a payment itself — the customer
 * does that on Stripe's hosted page, and the webhook activates the plan.
 */
export async function createSubscriptionCheckout(args: {
  planId: "starter" | "pro";
  businessId: string;
  trialEndsAt: Date | null;
  customerEmail: string | null;
}): Promise<{ ok: true; url: string; sessionId: string } | { ok: false; status: 400; error: string }> {
  const config = readStripeConfig();
  if (!config) return { ok: false, status: 400, error: "Stripe is not configured in this deployment." };
  const priceId = await resolveStripePriceId(args.planId, config);
  if (!priceId) {
    return {
      ok: false,
      status: 400,
      error:
        "The Stripe price for the " +
        args.planId +
        " plan isn't provisioned yet (set STRIPE_PRICE_" +
        (args.planId === "starter" ? "STARTER" : "PRO") +
        ", or provision a price with lookup_key '" +
        args.planId +
        "' on the Stripe account).",
    };
  }
  const origin = appOriginFromRequest();
  if (!origin) return { ok: false, status: 400, error: "Couldn't determine the app origin for checkout return URLs." };
  const { successUrl, cancelUrl } = checkoutReturnUrls(origin);
  const session = await stripeRequest<StripeCheckoutSessionResult>(
    "POST",
    "/checkout/sessions",
    buildSubscriptionCheckoutParams({
      priceId,
      businessId: args.businessId,
      successUrl,
      cancelUrl,
      trialEndSeconds: trialEndSecondsFor(args.trialEndsAt),
      customerEmail: args.customerEmail,
    }),
    config,
  );
  if (!session?.url) {
    return { ok: false, status: 400, error: "Stripe didn't return a checkout URL for this session." };
  }
  return { ok: true, url: session.url, sessionId: session.id };
}
