/**
 * Server-only queries: Stripe webhook persistence (Phase 2 build #5).
 *
 * Backs the StripeEventStore seam in src/lib/server/stripeWebhook.ts.
 *
 * ISOLATION RULE (AGENTS.md): every function that reads business data takes
 * an explicit key (stripe customer id, subscription id, or the checkout
 * metadata businessId) and returns only an id — the webhook route then calls
 * business-scoped writers with that resolved id. The three find* functions
 * are deliberately cross-business (like login email lookup / the Twilio
 * webhook's getBusinessByPhoneKey), used exclusively by the Stripe webhook.
 * Writes go through typed key lists — never raw client input.
 */
import type { BusinessPlan } from "../schema";
import { assertServer, sql } from "./shared";
import type { WebhookSubscriptionStatus } from "~/lib/server/stripeWebhook";

// ---------------------------------------------------------------------------
// Stripe event dedupe (stripe_events, migration 009)
// ---------------------------------------------------------------------------

/**
 * INSERT the event id ON CONFLICT DO NOTHING. Returns true when this call
 * inserted the row (first delivery) and false when the id was already
 * present (duplicate delivery — the caller skips processing).
 */
export async function claimStripeEvent(
  eventId: string,
  type: string,
  payload: unknown,
): Promise<"first" | "duplicate" | "unprocessed_retry"> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    `INSERT INTO stripe_events (id, type, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [eventId, type, JSON.stringify(payload ?? null)],
  );
  if (rows.length > 0) return "first";
  // Conflict: the event already exists. Was it fully processed? (A claim with
  // no processed_at means a previous delivery crashed mid-handler — the
  // honest move is to process it again, not to drop it.)
  const existing = await db.query(
    `SELECT processed_at FROM stripe_events WHERE id = $1 LIMIT 1`,
    [eventId],
  );
  const row = existing[0] as { processedAt: Date | null } | undefined;
  return row && row.processedAt != null ? "duplicate" : "unprocessed_retry";
}

/** Stamp processed_at after the handlers commit their writes. */
export async function markStripeEventProcessed(eventId: string): Promise<void> {
  assertServer();
  const db = sql();
  await db.query(`UPDATE stripe_events SET processed_at = now() WHERE id = $1`, [eventId]);
}

// ---------------------------------------------------------------------------
// Cross-business lookups (webhook-only, like getBusinessByPhoneKey)
// ---------------------------------------------------------------------------

export async function findBusinessIdByStripeCustomer(customerId: string): Promise<string | null> {
  assertServer();
  if (!customerId) return null;
  const db = sql();
  const rows = await db.query(`SELECT id FROM businesses WHERE stripe_customer_id = $1 LIMIT 1`, [
    customerId,
  ]);
  const row = rows[0] as { id: string } | undefined;
  return row ? row.id : null;
}

export async function findBusinessIdByStripeSubscription(subscriptionId: string): Promise<string | null> {
  assertServer();
  if (!subscriptionId) return null;
  const db = sql();
  const rows = await db.query(
    `SELECT id FROM businesses WHERE stripe_subscription_id = $1 LIMIT 1`,
    [subscriptionId],
  );
  const row = rows[0] as { id: string } | null;
  return row ? row.id : null;
}

/** Email fallback for checkout sessions without metadata.businessId. */
export async function findBusinessIdByEmail(email: string): Promise<string | null> {
  assertServer();
  if (!email) return null;
  const db = sql();
  // The business email or any owner/manager user's email can claim the account.
  const rows = await db.query(
    `SELECT b.id
     FROM businesses b
     LEFT JOIN users u ON u.business_id = b.id AND u.role IN ('owner', 'manager')
     WHERE lower(b.email) = lower($1) OR lower(u.email) = lower($1)
     ORDER BY (u.role = 'owner') DESC NULLS LAST, b.created_at ASC
     LIMIT 1`,
    [email],
  );
  const row = rows[0] as { id: string } | null;
  return row ? row.id : null;
}

// ---------------------------------------------------------------------------
// Writes — webhook-only, keyed by the resolved businessId
// ---------------------------------------------------------------------------

/** One statement: link identity + sync status/period/plan, honest NULLs. */
export async function applyStripeSubscriptionState(args: {
  businessId: string;
  customerId: string | null;
  subscriptionId: string | null;
  status: WebhookSubscriptionStatus | null;
  currentPeriodEndSeconds: number | null;
  plan: BusinessPlan | null;
}): Promise<void> {
  assertServer();
  const db = sql();
  await db.query(
    `UPDATE businesses SET
       stripe_customer_id     = COALESCE($2, stripe_customer_id),
       stripe_subscription_id = COALESCE($3, stripe_subscription_id),
       subscription_status    = COALESCE($4, subscription_status),
       current_period_end     = COALESCE($5::timestamptz, current_period_end),
       plan                   = COALESCE($6::business_plan, plan)
     WHERE id = $1`,
    [
      args.businessId,
      args.customerId,
      args.subscriptionId,
      args.status,
      args.currentPeriodEndSeconds != null
        ? new Date(args.currentPeriodEndSeconds * 1000).toISOString()
        : null,
      args.plan,
    ],
  );
}
/** Create the in-app 'payment_failed' notification (honest, always-on channel). */
export async function createPaymentFailedNotification(
  businessId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  assertServer();
  const db = sql();
  await db.query(
    `INSERT INTO notifications (business_id, type, payload)
     VALUES ($1, 'payment_failed', $2::jsonb)`,
    [businessId, JSON.stringify(payload)],
  );
}
