/**
 * Plain (non-RPC) performance-reporting reads — the SSR-executed analytics
 * loader body + the digest sweep's shared builder (mirrors sessionReads.ts /
 * adminReads.ts / roiPanel.ts, PR #26/#27 postmortem): a createServerFn call
 * inside a route loader compiles to an SSR RPC stub — an HTTP self-call
 * through the hosting proxy that intermittently fails. Route loaders must
 * call PLAIN server functions during SSR; the RPC wrapper in appFns.ts stays
 * for BROWSER-initiated calls and delegates to the same body (one source of
 * truth, no drift).
 *
 * Import-protection: server-only (db + session code). Route files import this
 * module ONLY inside `if (import.meta.env.SSR)` branches, dead-code-eliminated
 * from the client bundle (verify: grep dist/client for reportingReads = 0).
 *
 * ISOLATION: every builder takes the businessId — in production always
 * resolved from the authenticated session, never from client input.
 */
import { getSessionFromRequest } from "~/lib/server/auth.server";
import * as q from "~/db/queries";
import { buildRoiPanelData } from "~/lib/server/roiPanel";
import { funnelStages } from "~/lib/server/revenue";
import {
  computePerformanceReport,
  computeReportingWindows,
  flattenWindows,
  type PerformanceReport,
} from "~/lib/server/reporting";
import { sanitizePerformanceDigestConfig, type PerformanceDigestConfig } from "~/lib/digest";
import type { RoiPanelData } from "~/lib/server/roi";

/** The digest half of the analytics payload. */
export interface DigestStatusView {
  config: PerformanceDigestConfig;
  /** ISO instant of the most recent performance_digest (null = never sent). */
  lastSentAt: string | null;
}

/** The analytics page payload — the P3-D/P5-2 shape plus the P5-5 report. */
export interface AnalyticsPageData {
  leadsByStatus: Record<string, number>;
  leadsBySource: Record<string, number>;
  appointmentsByWeekday: number[];
  conversationsByStatus: Record<string, number>;
  totalLeads: number;
  totalMessages: number;
  openPipelineValueCents: number;
  recovery: {
    missedCalls: number;
    recovered: number;
    booked: number;
  };
  revenue: {
    week: { wonLeads: number; recoveredCents: number };
    month: { wonLeads: number; recoveredCents: number };
    allTime: { wonLeads: number; recoveredCents: number };
    revenuePerLeadCents: number | null;
    conversionRate: number | null;
    recoveryRate: number | null;
    appointmentsPerRecoveredLead: number | null;
    hasRecovered: boolean;
  };
  funnel: { key: string; label: string; count: number }[];
  roi: RoiPanelData;
  /** P5-5: daily/weekly/monthly performance report with trend directions. */
  performance: PerformanceReport;
  /** P5-5: this business's digest config + last-send stamp (honest state). */
  digest: DigestStatusView;
}

/**
 * The analytics page body — byte-identical data shape to getAnalyticsFn's
 * (whose handler delegates here) plus the P5-5 report + digest status.
 */
export async function buildAnalyticsPageData(
  businessId: string,
  businessTimezone: string | null,
): Promise<AnalyticsPageData> {
  const [leadsByStatus, leadsBySource, appointmentsByWeekday, conversationsByStatus, totalMessages, pipeline, recovery] =
    await Promise.all([
      q.countLeadsByStatus(businessId),
      q.countLeadsBySource(businessId),
      q.countAppointmentsByWeekday(businessId),
      q.countConversationsByStatus(businessId),
      q.countMessages(businessId),
      q.sumOpenPipelineValue(businessId),
      q.missedCallRecoveryStats(businessId),
    ]);
  const totalLeads = Object.values(leadsByStatus).reduce((a, b) => a + b, 0);
  const [revenue, funnel, roi, performance, businessRow, lastDigest] = await Promise.all([
    q.revenueMetrics(businessId, businessTimezone),
    q.revenueFunnelCounts(businessId),
    buildRoiPanelData(businessId),
    buildPerformanceReportFor(businessId),
    q.getBusiness(businessId).catch(() => null),
    q.lastDigestNotification(businessId).catch(() => null),
  ]);
  const settings = (businessRow as unknown as { settings?: Record<string, unknown> } | null)?.settings ?? {};
  return {
    leadsByStatus,
    leadsBySource,
    appointmentsByWeekday,
    conversationsByStatus,
    totalLeads,
    totalMessages,
    openPipelineValueCents: pipeline,
    recovery,
    revenue: {
      week: revenue.week,
      month: revenue.month,
      allTime: revenue.allTime,
      revenuePerLeadCents: revenue.revenuePerLeadCents,
      conversionRate: revenue.conversionRate,
      recoveryRate: revenue.recoveryRate,
      appointmentsPerRecoveredLead: revenue.appointmentsPerRecoveredLead,
      hasRecovered: revenue.allTime.recoveredCents > 0 || revenue.allTime.wonLeads > 0,
    },
    funnel: funnelStages(funnel),
    roi,
    performance,
    digest: {
      config: sanitizePerformanceDigestConfig(settings.performanceDigest),
      lastSentAt: lastDigest ? new Date(lastDigest.createdAt).toISOString() : null,
    },
  };
}

/**
 * The P5-5 performance report for one business: six windows (current +
 * previous × day/week/month) in the business's timezone, one 4-query pass.
 * Total: an empty business gets the all-zero report.
 */
export async function buildPerformanceReportFor(businessId: string): Promise<PerformanceReport> {
  const business = await q.getBusiness(businessId);
  const timezone = business?.timezone ?? null;
  const planId = business?.plan ?? "";
  const windows = flattenWindows(computeReportingWindows(new Date(), timezone));
  const counts = await q.periodCountsForWindows(businessId, windows);
  return computePerformanceReport({ counts, planId });
}

/**
 * SSR session variant for the analytics route loader: resolves the business
 * from the signed-in session (null when signed out — the _app beforeLoad has
 * already gated, so null is a defensive fallback).
 */
export async function analyticsPageDataForSession(): Promise<AnalyticsPageData | null> {
  const ctx = await getSessionFromRequest();
  if (!ctx) return null;
  return buildAnalyticsPageData(ctx.business.id, ctx.business.timezone ?? null);
}
