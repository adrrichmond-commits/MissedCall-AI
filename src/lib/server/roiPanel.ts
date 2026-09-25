/**
 * ROI panel builder (P5-2) — the DB-facing caller for the pure engine in
 * roi.ts. PLAIN (non-RPC) server module, same pattern as adminReads.ts /
 * sessionReads.ts: route loaders execute this directly during SSR (no
 * createSsrRpc HTTP self-call — the P5-1 prod-500 fix), and RPC wrappers in
 * appFns.ts delegate here for browser-initiated fetches. Scripts
 * (scripts/test-p52-roi.ts) import it directly with an explicit businessId —
 * the caller is always the authenticated session in production; the
 * businessId parameter is NEVER taken from client input at a route boundary.
 *
 * All queries are business-scoped (the WHERE clause is the isolation
 * boundary); subscription cost resolves from src/lib/pricing.ts via the
 * business's plan id — no price literal lives here.
 */
import { getBusiness } from "~/db/queries/auth";
import { customerReplyCount, revenueFunnelCounts, revenueMetrics } from "~/db/queries/revenue";
import { trialDaysRemaining } from "~/lib/trialValue";
import { computeRoiPanel, type RoiPanelData } from "~/lib/server/roi";

/**
 * Build the full ROI panel payload for one business. Total: a business with
 * no data gets an all-zero panel (the engine's zero-data contract), never an
 * error — a brand-new plumber's dashboard must render.
 */
export async function buildRoiPanelData(businessId: string): Promise<RoiPanelData> {
  const business = await getBusiness(businessId);
  const timezone = business?.timezone ?? "UTC";
  const [funnel, metrics, customerReplies] = await Promise.all([
    revenueFunnelCounts(businessId),
    revenueMetrics(businessId, timezone),
    customerReplyCount(businessId),
  ]);
  return computeRoiPanel({
    measured: {
      callsReceived: funnel.callsReceived,
      missedCalls: funnel.missedCalls,
      autoResponded: funnel.callsHandledByAi,
      customerReplies,
      leadsRecovered: funnel.missedCallsRecovered,
      appointmentsBooked: funnel.appointments,
    },
    jobsWon: metrics.allTime.wonLeads,
    revenueRecoveredCents: metrics.allTime.recoveredCents,
    revenueRecoveredMonthCents: metrics.month.recoveredCents,
    planId: business?.plan ?? "",
    trialDaysRemaining:
      business?.trialEndsAt != null
        ? trialDaysRemaining(business.trialEndsAt.getTime(), Date.now())
        : null,
    hasTrialRecord: business?.trialEndsAt != null,
  });
}
