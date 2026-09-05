#!/usr/bin/env bun
/**
 * Unit tests for the Stripe webhook path (Phase 2 build #5).
 * Run: bun scripts/test-stripe.ts — no DB, no network, no real Stripe keys.
 *
 * Covers: v1 signature verification (valid / tampered / missing / stale),
 * event parsing, event-id dedupe, subscription-status mapping, plan mapping
 * (env price IDs + exact-amount fallback from the locked pricing module),
 * every webhook event handler against an in-memory store, handler-failure
 * retry semantics, and the 503-when-unconfigured honesty gate.
 *
 * Local Postgres is not available in this environment, so handlers are
 * exercised through the StripeEventStore seam (src/lib/server/stripeWebhook.ts)
 * with an in-memory implementation mirroring the Neon store's semantics
 * (claim-first dedupe, values-only idempotent writes).
 */
import {
  SIGNATURE_TOLERANCE_SECONDS,
  handleStripeEvent,
  mapSubscriptionStatus,
  parseStripeEvent,
  parseStripeSignatureHeader,
  planForStripePrice,
  planForSubscription,
  readStripeConfig,
  verifyStripeSignature,
  type StripeEventStore,
  type StripeSubscription,
} from "../src/lib/server/stripeWebhook";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log("FAIL " + name + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  } else {
    console.log("ok   " + name);
  }
}

// --- Config gating (no real keys; forced-clean env) ---------------------------
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
delete process.env.STRIPE_PRICE_STARTER;
delete process.env.STRIPE_PRICE_PRO;

check("unconfigured: readStripeConfig null", readStripeConfig(), null);

process.env.STRIPE_SECRET_KEY = "sk_test_unit_test";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit_test";
check("configured: reads both keys", readStripeConfig() !== null, true);

// --- Signature scheme (v1: t=<sec>,v1=hex(HMAC-SHA256(`${t}.${payload}`))) ----
const WEBHOOK_SECRET = "whsec_test_secret_123";
const PAYLOAD = JSON.stringify({ id: "evt_test_1", type: "ping", data: { object: {} } });

async function sign(payload: string, secret: string, timestampSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestampSeconds}.${payload}`));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

const NOW_MS = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const goodHeader = `t=${NOW_SEC},v1=${await sign(PAYLOAD, WEBHOOK_SECRET, NOW_SEC)}`;

/** Verify and unwrap the failure reason (null when valid) for terse checks. */
async function failReason(args: Parameters<typeof verifyStripeSignature>[0]) {
  const result = await verifyStripeSignature(args);
  return result.valid ? null : result.reason;
}

check("signature: valid accepted", await verifyStripeSignature({ payload: PAYLOAD, header: goodHeader, webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS }), { valid: true });
check("signature: tampered payload rejected", (await verifyStripeSignature({ payload: PAYLOAD + "x", header: goodHeader, webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS })).valid, false);
check("signature: wrong secret rejected", (await verifyStripeSignature({ payload: PAYLOAD, header: `t=${NOW_SEC},v1=${await sign(PAYLOAD, "whsec_other", NOW_SEC)}`, webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS })).valid, false);
check("signature: missing header rejected", await failReason({ payload: PAYLOAD, header: null, webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS }), "missing_header");
check("signature: malformed header rejected", await failReason({ payload: PAYLOAD, header: "garbage", webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS }), "malformed_header");
check("signature: t-without-v1 rejected", await failReason({ payload: PAYLOAD, header: `t=${NOW_SEC}`, webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS }), "malformed_header");
check("signature: non-numeric t rejected", await failReason({ payload: PAYLOAD, header: "t=abc,v1=00", webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS }), "malformed_header");
check("signature: stale timestamp rejected", await failReason({
  payload: PAYLOAD,
  header: `t=${NOW_SEC - SIGNATURE_TOLERANCE_SECONDS - 1},v1=${await sign(PAYLOAD, WEBHOOK_SECRET, NOW_SEC - SIGNATURE_TOLERANCE_SECONDS - 1)}`,
  webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS,
}), "stale_timestamp");
check("signature: future-beyond-tolerance rejected", (await verifyStripeSignature({
  payload: PAYLOAD,
  header: `t=${NOW_SEC + SIGNATURE_TOLERANCE_SECONDS + 1},v1=${await sign(PAYLOAD, WEBHOOK_SECRET, NOW_SEC + SIGNATURE_TOLERANCE_SECONDS + 1)}`,
  webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS,
})).valid, false);
check("signature: exactly at tolerance accepted", (await verifyStripeSignature({
  payload: PAYLOAD,
  header: `t=${NOW_SEC - SIGNATURE_TOLERANCE_SECONDS},v1=${await sign(PAYLOAD, WEBHOOK_SECRET, NOW_SEC - SIGNATURE_TOLERANCE_SECONDS)}`,
  webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS,
})).valid, true);
check("signature: multi-v1 header, second matches", (await verifyStripeSignature({
  payload: PAYLOAD,
  header: `t=${NOW_SEC},v1=deadbeef,v1=${await sign(PAYLOAD, WEBHOOK_SECRET, NOW_SEC)}`,
  webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS,
})).valid, true);
check("signature: constant-time compare — wrong length rejected", await failReason({ payload: PAYLOAD, header: `t=${NOW_SEC},v1=abcd`, webhookSecret: WEBHOOK_SECRET, nowMs: NOW_MS }), "signature_mismatch");
check("header parse: t extracted", parseStripeSignatureHeader("t=123,v1=abc")?.timestampSeconds, 123);
check("header parse: v1 list", parseStripeSignatureHeader("t=123,v1=abc,v1=def")?.v1, ["abc", "def"]);
check("header parse: empty header → null", parseStripeSignatureHeader(""), null);
check("header parse: null header → null", parseStripeSignatureHeader(null), null);

// --- Event parsing --------------------------------------------------------------
check("parse: valid event", parseStripeEvent(PAYLOAD), { id: "evt_test_1", type: "ping", object: {} });
check("parse: missing id → null", parseStripeEvent(JSON.stringify({ type: "x", data: { object: {} } })), null);
check("parse: missing type → null", parseStripeEvent(JSON.stringify({ id: "evt_1", data: { object: {} } })), null);
check("parse: no data.object → null", parseStripeEvent(JSON.stringify({ id: "evt_1", type: "x" })), null);
check("parse: invalid JSON → null (never throws)", parseStripeEvent("{not json"), null);

// --- Status mapping ---------------------------------------------------------------
check("status map: active", mapSubscriptionStatus("active"), "active");
check("status map: trialing", mapSubscriptionStatus("trialing"), "trialing");
check("status map: past_due", mapSubscriptionStatus("past_due"), "past_due");
check("status map: unpaid → past_due", mapSubscriptionStatus("unpaid"), "past_due");
check("status map: canceled", mapSubscriptionStatus("canceled"), "canceled");
check("status map: incomplete_expired → canceled", mapSubscriptionStatus("incomplete_expired"), "canceled");
check("status map: incomplete → null (transitional, never guessed)", mapSubscriptionStatus("incomplete"), null);
check("status map: unknown → null", mapSubscriptionStatus("made_up_status"), null);

// --- Plan mapping: env price IDs first, then exact-amount from locked pricing -----
process.env.STRIPE_PRICE_STARTER = "price_STARTER_111";
process.env.STRIPE_PRICE_PRO = "price_PRO_222";
check("plan: env starter price id", planForStripePrice({ id: "price_STARTER_111", unit_amount: null }), "starter");
check("plan: env pro price id", planForStripePrice({ id: "price_PRO_222", unit_amount: null }), "pro");
check("plan: env ids never leak across tiers", planForStripePrice({ id: "price_STARTER_111", unit_amount: null }) === "pro", false);
delete process.env.STRIPE_PRICE_STARTER;
delete process.env.STRIPE_PRICE_PRO;
check("plan: exact $149 amount → starter (locked pricing module)", planForStripePrice({ id: "price_UNKNOWN", unit_amount: 14900 }), "starter");
check("plan: exact $249 amount → pro", planForStripePrice({ id: "price_UNKNOWN", unit_amount: 24900 }), "pro");
check("plan: unknown price + unknown amount → null (never guessed)", planForStripePrice({ id: "price_UNKNOWN", unit_amount: 999 }), null);
check("plan: null amount + no env → null", planForStripePrice({ id: "price_UNKNOWN", unit_amount: null }), null);
check("planForSubscription: first mappable item wins", planForSubscription({
  id: "sub_1", status: "active", customer: "cus_1", current_period_end: null, metadata: null,
  items: { data: [{ price: { id: "price_X", unit_amount: 12345 } }, { price: { id: "price_Y", unit_amount: 24900 } }] },
}), "pro");
check("planForSubscription: unmapped items → null", planForSubscription({
  id: "sub_1", status: "active", customer: "cus_1", current_period_end: null, metadata: null,
  items: { data: [{ price: { id: "price_X", unit_amount: 12345 } }] },
}), null);

// --- In-memory store mirroring the Neon store's semantics --------------------------
interface BizRow {
  id: string;
  name: string;
  email: string | null;
  plan: "trial" | "starter" | "growth" | "pro";
  subscriptionStatus: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEndSeconds: number | null;
}

interface MemState {
  businesses: Map<string, BizRow>;
  notifications: { businessId: string; type: string; payload: unknown }[];
  claimed: Set<string>;
  processed: Set<string>;
}
interface BizRow {
  id: string;
  name: string;
  email: string | null;
  plan: "trial" | "starter" | "growth" | "pro";
  subscriptionStatus: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEndSeconds: number | null;
}

function makeStore(): { state: MemState; store: StripeEventStore } {
  const state: MemState = {
    businesses: new Map([
      ["biz-1", { id: "biz-1", name: "Rapid Rooter", email: "owner@rapidrooter.test", plan: "trial", subscriptionStatus: null, stripeCustomerId: null, stripeSubscriptionId: null, currentPeriodEndSeconds: null }],
      ["biz-2", { id: "biz-2", name: "Pro Plumbers", email: "owner@proplumbers.test", plan: "trial", subscriptionStatus: null, stripeCustomerId: null, stripeSubscriptionId: null, currentPeriodEndSeconds: null }],
    ]),
    notifications: [],
    claimed: new Set<string>(),
    processed: new Set<string>(),
  };
  const store: StripeEventStore = {
    // Mirrors claimStripeEvent: INSERT ON CONFLICT DO NOTHING, then processed_at
    // decides first / duplicate / unprocessed_retry.
    async claimEvent(eventId) {
      if (!state.claimed.has(eventId)) {
        state.claimed.add(eventId);
        return "first";
      }
      return state.processed.has(eventId) ? "duplicate" : "unprocessed_retry";
    },
    async markEventProcessed(eventId) {
      state.processed.add(eventId);
    },
    async findBusinessIdByStripeCustomer(customerId) {
      if (!customerId) return null;
      for (const b of state.businesses.values()) {
        if (b.stripeCustomerId === customerId) return b.id;
      }
      return null;
    },
    async findBusinessIdByStripeSubscription(subscriptionId) {
      if (!subscriptionId) return null;
      for (const b of state.businesses.values()) {
        if (b.stripeSubscriptionId === subscriptionId) return b.id;
      }
      return null;
    },
    async findBusinessIdByEmail(email) {
      if (!email) return null;
      for (const b of state.businesses.values()) {
        if (b.email && b.email.toLowerCase() === email.toLowerCase()) return b.id;
      }
      return null;
    },
    async linkStripeIdentity({ businessId, customerId, subscriptionId }) {
      const b = state.businesses.get(businessId);
      if (!b) throw new Error("unknown business " + businessId);
      if (customerId) b.stripeCustomerId = customerId;
      if (subscriptionId) b.stripeSubscriptionId = subscriptionId;
    },
    async setSubscriptionState({ businessId, status, currentPeriodEndSeconds, plan, subscriptionId }) {
      const b = state.businesses.get(businessId);
      if (!b) throw new Error("unknown business " + businessId);
      if (status) b.subscriptionStatus = status;
      if (currentPeriodEndSeconds != null) b.currentPeriodEndSeconds = currentPeriodEndSeconds;
      if (plan) b.plan = plan;
      if (subscriptionId && !b.stripeSubscriptionId) b.stripeSubscriptionId = subscriptionId;
    },
    async createPaymentFailedNotification({ businessId, payload }) {
      state.notifications.push({ businessId, type: "payment_failed", payload });
    },
  };
  return { state, store };
}

function subEvent(id: string, sub: Partial<StripeSubscription>): ParsedStripeEventLike {
  return {
    id,
    type: "customer.subscription.updated",
    object: { id: "sub_new", status: "active", customer: null, current_period_end: null, metadata: null, ...sub },
  };
}
/** Local structural type (mirrors ParsedStripeEvent<T>) so tests stay decoupled. */
interface ParsedStripeEventLike {
  id: string;
  type: string;
  object: unknown;
}
void subEvent;

// --- checkout.session.completed ---------------------------------------------------
{
  const { state, store } = makeStore();
  const outcome = await handleStripeEvent(
    {
      id: "evt_co_1",
      type: "checkout.session.completed",
      object: {
        id: "cs_1",
        customer: "cus_abc",
        subscription: "sub_abc",
        metadata: { businessId: "biz-1" },
        customer_email: null,
        customer_details: { email: null },
      },
    },
    store,
  );
  check("checkout: processed via metadata", outcome.action, "processed");
  check("checkout: customer linked", state.businesses.get("biz-1")!.stripeCustomerId, "cus_abc");
  check("checkout: subscription linked", state.businesses.get("biz-1")!.stripeSubscriptionId, "sub_abc");
  check("checkout: status untouched by link-only event", state.businesses.get("biz-1")!.subscriptionStatus, null);
  check("checkout: event marked processed", state.processed.has("evt_co_1"), true);
}
{
  // Email fallback when metadata is missing.
  const { state, store } = makeStore();
  const outcome = await handleStripeEvent(
    {
      id: "evt_co_2",
      type: "checkout.session.completed",
      object: {
        id: "cs_2",
        customer: "cus_def",
        subscription: null,
        metadata: null,
        customer_email: null,
        customer_details: { email: "OWNER@ProPlumbers.Test" },
      },
    },
    store,
  );
  check("checkout: email fallback processed", outcome.action, "processed");
  check("checkout: linked via email (case-insensitive)", state.businesses.get("biz-2")!.stripeCustomerId, "cus_def");
  check("checkout: no subscription → status stays untouched", state.businesses.get("biz-2")!.subscriptionStatus, null);
}
{
  // Unresolvable session: linked nothing, plan unchanged — honest ignore.
  const { state, store } = makeStore();
  const outcome = await handleStripeEvent(
    {
      id: "evt_co_3",
      type: "checkout.session.completed",
      object: {
        id: "cs_3", customer: "cus_ghost", subscription: null,
        metadata: null, customer_email: null, customer_details: { email: "nobody@ghost.test" },
      },
    },
    store,
  );
  check("checkout: unresolvable → ignored (honest)", outcome.action, "ignored");
  check("checkout: unresolvable linked nothing", state.businesses.get("biz-1")!.stripeCustomerId, null);
}

// --- customer.subscription.updated / created (the activation path) ---------------
{
  const { state, store } = makeStore();
  // First link the business (as checkout would).
  await store.linkStripeIdentity({ businessId: "biz-1", customerId: "cus_777", subscriptionId: null });
  const outcome = await handleStripeEvent(
    {
      id: "evt_sub_1",
      type: "customer.subscription.updated",
      object: {
        id: "sub_777",
        status: "active",
        customer: "cus_777",
        current_period_end: 1_800_000_000,
        metadata: null,
        items: { data: [{ price: { id: "price_STARTER_999", unit_amount: 14900 } }] },
      },
    },
    store,
  );
  check("subscription.updated: active processed", outcome.action, "processed");
  check("subscription.updated: plan → starter (amount-mapped)", state.businesses.get("biz-1")!.plan, "starter");
  check("subscription.updated: status active", state.businesses.get("biz-1")!.subscriptionStatus, "active");
  check("subscription.updated: period end stored (unix sec)", state.businesses.get("biz-1")!.currentPeriodEndSeconds, 1_800_000_000);
  check("subscription.updated: subscription id linked", state.businesses.get("biz-1")!.stripeSubscriptionId, "sub_777");
}
{
  // Env price-ID mapping wins over amount.
  process.env.STRIPE_PRICE_PRO = "price_PRO_42";
  const { state, store } = makeStore();
  await store.linkStripeIdentity({ businessId: "biz-2", customerId: "cus_888", subscriptionId: "sub_888" });
  await handleStripeEvent(
    {
      id: "evt_sub_2",
      type: "customer.subscription.updated",
      object: {
        id: "sub_888", status: "trialing", customer: "cus_888", current_period_end: null, metadata: null,
        items: { data: [{ price: { id: "price_PRO_42", unit_amount: 12345 } }] },
      },
    },
    store,
  );
  check("subscription.updated: env price id → pro", state.businesses.get("biz-2")!.plan, "pro");
  check("subscription.updated: trialing status synced", state.businesses.get("biz-2")!.subscriptionStatus, "trialing");
  check("subscription.updated: no period end → left alone", state.businesses.get("biz-2")!.currentPeriodEndSeconds, null);
  delete process.env.STRIPE_PRICE_PRO;
}
{
  // Unpaid → past_due; canceled → plan honestly back to trial.
  const { state, store } = makeStore();
  await store.linkStripeIdentity({ businessId: "biz-1", customerId: "cus_999", subscriptionId: "sub_999" });
  await handleStripeEvent(
    {
      id: "evt_sub_3", type: "customer.subscription.updated",
      object: { id: "sub_999", status: "unpaid", customer: "cus_999", current_period_end: null, metadata: null, items: { data: [{ price: { id: "p", unit_amount: 14900 } }] } },
    },
    store,
  );
  check("subscription.updated: unpaid → past_due", state.businesses.get("biz-1")!.subscriptionStatus, "past_due");
  await handleStripeEvent(
    {
      id: "evt_sub_4", type: "customer.subscription.deleted",
      object: { id: "sub_999", status: "canceled", customer: "cus_999", current_period_end: null, metadata: null },
    },
    store,
  );
  check("subscription.deleted: status canceled", state.businesses.get("biz-1")!.subscriptionStatus, "canceled");
  check("subscription.deleted: plan honestly back to trial", state.businesses.get("biz-1")!.plan, "trial");
  check("subscription.deleted: data preserved (name intact)", state.businesses.get("biz-1")!.name, "Rapid Rooter");
}
{
  // Unmapped subscription status → ignored, nothing guessed.
  const { state, store } = makeStore();
  await store.linkStripeIdentity({ businessId: "biz-1", customerId: "cus_1000", subscriptionId: "sub_1000" });
  const outcome = await handleStripeEvent(
    {
      id: "evt_sub_5", type: "customer.subscription.updated",
      object: { id: "sub_1000", status: "incomplete", customer: "cus_1000", current_period_end: null, metadata: null, items: { data: [] } },
    },
    store,
  );
  check("subscription.updated: incomplete → ignored (transitional)", outcome.action, "ignored");
  check("subscription.updated: incomplete → status untouched", state.businesses.get("biz-1")!.subscriptionStatus, null);
}
{
  // Unresolvable subscription → ignored, nothing linked.
  const { store } = makeStore();
  const outcome = await handleStripeEvent(
    {
      id: "evt_sub_6", type: "customer.subscription.updated",
      object: { id: "sub_ghost", status: "active", customer: "cus_ghost", current_period_end: null, metadata: null, items: { data: [] } },
    },
    store,
  );
  check("subscription.updated: unresolvable → ignored", outcome.action, "ignored");
}

// --- invoice.payment_failed -------------------------------------------------------
{
  const { state, store } = makeStore();
  await store.linkStripeIdentity({ businessId: "biz-1", customerId: "cus_555", subscriptionId: "sub_555" });
  await handleStripeEvent(
    {
      id: "evt_inv_1", type: "customer.subscription.updated",
      object: { id: "sub_555", status: "active", customer: "cus_555", current_period_end: null, metadata: null, items: { data: [{ price: { id: "p", unit_amount: 24900 } }] } },
    },
    store,
  );
  const outcome = await handleStripeEvent(
    {
      id: "evt_inv_2", type: "invoice.payment_failed",
      object: { id: "in_123", customer: "cus_555", subscription: "sub_555", amount_due: 24900, currency: "usd", attempt_count: 2, hosted_invoice_url: "https://invoice.test/123" },
    },
    store,
  );
  check("payment_failed: processed", outcome.action, "processed");
  check("payment_failed: status past_due", state.businesses.get("biz-1")!.subscriptionStatus, "past_due");
  check("payment_failed: plan NOT downgraded (grace period)", state.businesses.get("biz-1")!.plan, "pro");
  check("payment_failed: notification created", state.notifications, [{ businessId: "biz-1", type: "payment_failed", payload: { invoiceId: "in_123", amountDue: 24900, currency: "usd", attemptCount: 2, hostedInvoiceUrl: "https://invoice.test/123" } }]);
}
{
  const { state, store } = makeStore();
  const outcome = await handleStripeEvent(
    {
      id: "evt_inv_2", type: "invoice.payment_failed",
      object: { id: "in_ghost", customer: "cus_nobody", subscription: null, amount_due: 1000, currency: "usd", attempt_count: 1, hosted_invoice_url: null },
    },
    store,
  );
  check("payment_failed: unresolvable → ignored", outcome.action, "ignored");
  check("payment_failed: no notification for unknown customer", state.notifications.length, 0);
}

// --- Event-id dedupe (INSERT ON CONFLICT DO NOTHING semantics) ---------------------
{
  const { state, store } = makeStore();
  const event = {
    id: "evt_dup_1", type: "checkout.session.completed",
    object: { id: "cs_d", customer: "cus_dup", subscription: "sub_dup", metadata: { businessId: "biz-1" }, customer_email: null, customer_details: null },
  };
  const first = await handleStripeEvent(event, store);
  check("dedupe: first delivery processed", first.action, "processed");
  // Stripe redelivers the same event id.
  const second = await handleStripeEvent(event, store);
  check("dedupe: redelivery reported duplicate", second.action, "duplicate");
  check("dedupe: handler ran exactly once", state.businesses.get("biz-1")!.stripeCustomerId === "cus_dup" && state.businesses.get("biz-1")!.stripeSubscriptionId === "sub_dup", true);
  // markEventProcessed stays consistent: claim → skip is processed, not pending.
  check("dedupe: duplicate marked processed", state.processed.has("evt_dup_1"), true);
}
{
  // Claimed but never processed (crash mid-handler) → honestly reprocessed.
  const { state, store } = makeStore();
  state.claimed.add("evt_crash_1"); // claimed, no markProcessed, no handler ran
  const event = {
    id: "evt_crash_1", type: "checkout.session.completed",
    object: { id: "cs_c", customer: "cus_re", subscription: null, metadata: { businessId: "biz-1" }, customer_email: null, customer_details: null },
  };
  const outcome = await handleStripeEvent(event, store);
  check("recovery: claimed-but-unprocessed event is reprocessed", outcome.action, "processed");
  check("recovery: link applied", state.businesses.get("biz-1")!.stripeCustomerId, "cus_re");
}
{
  // Handler throws → event NOT marked processed → next delivery retries.
  const { state, store } = makeStore();
  let calls = 0;
  const failingStore: StripeEventStore = {
    ...store,
    async claimEvent(eventId) {
      if (state.claimed.has(eventId)) {
        return state.processed.has(eventId) ? "duplicate" : "unprocessed_retry";
      }
      state.claimed.add(eventId);
      return "first";
    },
    async findBusinessIdByStripeCustomer() {
      calls++;
      if (calls === 1) throw new Error("db down");
      return "biz-1";
    },
  };
  const event = { id: "evt_err_1", type: "invoice.payment_failed", object: { id: "in_e", customer: "cus_x", subscription: null, amount_due: 1, currency: "usd", attempt_count: 1, hosted_invoice_url: null } };
  let threw = false;
  try {
    await handleStripeEvent(event, failingStore);
  } catch {
    threw = true;
  }
  check("failure: handler error propagates (route → 500 → redelivery)", threw, true);
  check("failure: event not marked processed", state.processed.has("evt_err_1"), false);
  const retried = await handleStripeEvent(event, { ...failingStore, findBusinessIdByStripeCustomer: async () => "biz-1" });
  check("failure: redelivery after fix succeeds", retried.action, "processed");
}
{
  // Unhandled event types are acknowledged, not 500s — Stripe stops redelivering.
  const { store } = makeStore();
  const outcome = await handleStripeEvent({ id: "evt_other_1", type: "customer.created", object: { id: "cus_new" } }, store);
  check("unhandled type: acknowledged+ignored", outcome.action, "ignored");
}

// --- 503-when-unconfigured honesty gate (module-level, no server needed) ----------
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;
check("503 gate: unconfigured after clearing env", readStripeConfig(), null);
process.env.STRIPE_SECRET_KEY = "sk_test_unit_test";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_unit_test";
check("503 gate: configured again", readStripeConfig() !== null, true);

console.log(failures === 0 ? "\nALL TESTS PASSED" : "\n" + failures + " TEST(S) FAILED");
process.exit(failures === 0 ? 0 : 1);
