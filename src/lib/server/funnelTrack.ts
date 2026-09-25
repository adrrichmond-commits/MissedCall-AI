/**
 * P4-A funnel tracking service — fire-and-forget stage recording.
 *
 * Every funnel hook calls trackFunnel() and NEVER lets a tracking failure
 * affect the user's flow: signup, onboarding, SMS handling, and the Stripe
 * webhook must all keep working if funnel_events is unavailable. Recording is
 * idempotent at the DB level (unique (business_id, stage) index), so hooks
 * can call this on every matching event.
 *
 * Stage semantics (honest, no backfill):
 *   signup                the business row was created (owner signed up).
 *   trial_start           the 14-day trial began — recorded at signup, the
 *                         moment createBusinessWithOwner stamps trial_ends_at.
 *   onboarding_completed  the business's five self-serve setup steps are all
 *                         done (checked on the nudge read) — or the owner
 *                         explicitly skipped (recorded as completed at skip:
 *                         they opted out of the wizard deliberately).
 *   phone_connected       the business saved a real contact phone (today's
 *                         honest signal; extends to the Twilio number when
 *                         live calling lands).
 *   first_lead            the AI captured the business's first lead
 *                         (SMS text-back or voice receptionist capture).
 *   first_recovered_call  the first inbound SMS the AI handled (the
 *                         recovery loop actually ran).
 *   paid                  the Stripe subscription became active (a payment
 *                         exists — activation path of the webhook).
 */
import type { FunnelStage } from "~/db/schema";
import * as q from "~/db/queries/funnel";

export async function trackFunnel(businessId: string, stage: FunnelStage): Promise<void> {
  try {
    await q.recordFunnelEvent(businessId, stage);
  } catch (err) {
    // Best-effort by design: tracking is telemetry, never a dependency.
    console.log("[funnel] stage recording failed (caller unaffected): " + String(err));
  }
}

export async function trackFunnelAll(businessId: string, stages: FunnelStage[]): Promise<void> {
  for (const stage of stages) {
    await trackFunnel(businessId, stage);
  }
}
