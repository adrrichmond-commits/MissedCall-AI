/**
 * Performance digest sweep (P5-5) — the retention layer's delivery engine.
 *
 * PLAIN server module (no RPC): called by the cron route
 * (/api/cron/performance-digest, the CRON_SECRET pattern from
 * sms-workflows) and directly by scripts/test-p55-reporting.ts. One sweep
 * iterates businesses ONCE and, per business:
 *
 *   1. CONFIG GATE   — settings.performanceDigest must be explicitly enabled
 *                      (sanitizePerformanceDigestConfig defaults to OFF);
 *   2. WINDOW        — the completed previous day/week in the business's
 *                      timezone (digest.ts, revenue.ts calendar math);
 *   3. CONTENT GATE  — skip unless the window carries real activity (no
 *                      "nothing happened this period" spam);
 *   4. MIN INTERVAL  — skip when the last performance_digest notification is
 *                      younger than the frequency's floor (daily 20h /
 *                      weekly 6d);
 *   5. PERIOD IDEMPOTENCY — skip when a digest with this periodKey already
 *                      exists (cron can be pinged any number of times);
 *   6. DELIVERY      — in-app notification (always) + owner email/SMS ONLY
 *                      through the existing channel gates the business
 *                      already controls (queueOwnerNotificationEmail /
 *                      notifyOwnerViaSms → the ONE workflow engine with
 *                      opt-outs, quiet hours, caps intact).
 *
 * ISOLATION: every query is business-scoped (the WHERE clause is the
 * boundary); the sweep never crosses businesses and never trusts client input.
 *
 * ESTIMATE HONESTY: recovered revenue in the digest copy is always
 * "(estimate)"-labeled — the same labeling contract as the P5-2 ROI panel.
 */
import * as q from "~/db/queries";
import { getBusiness } from "~/db/queries/auth";
import {
  digestShouldSend,
  digestWindow,
  digestSummaryLine,
  sanitizePerformanceDigestConfig,
  type DigestSkipReason,
} from "~/lib/digest";
import { queueOwnerNotificationEmail, notifyOwnerViaSms } from "~/lib/server/smsWorkflowTriggers";

export interface DigestSweepItem {
  businessId: string;
  outcome: "sent" | "skipped";
  reason: DigestSkipReason | "no_configuration" | "error" | null;
  periodKey?: string;
  detail?: string | null;
}

export interface DigestSweepSummary {
  ranAt: string;
  businessesScanned: number;
  digestsSent: number;
  skipped: number;
  failed: number;
  items: DigestSweepItem[];
}

/**
 * Run one digest sweep. Total: a business erroring mid-sweep is recorded as a
 * failed item and never aborts the sweep (the sms-workflows cron contract).
 * `now` is injectable so tests can pin the period windows.
 */
export async function runPerformanceDigestSweep(now: Date = new Date()): Promise<DigestSweepSummary> {
  const items: DigestSweepItem[] = [];
  let digestsSent = 0;
  let skipped = 0;
  let failed = 0;

  const businesses = await q.listBusinessSummaries().catch(() => []);
  for (const biz of businesses) {
    const businessId = biz.id;
    try {
      const businessRow = await getBusiness(businessId).catch(() => null);
      if (!businessRow) {
        items.push({ businessId, outcome: "skipped", reason: "no_configuration", detail: "business row unreadable" });
        skipped++;
        continue;
      }
      const settings = (businessRow as unknown as { settings?: Record<string, unknown> }).settings ?? {};
      const config = sanitizePerformanceDigestConfig(settings.performanceDigest);
      if (!config.enabled) {
        items.push({ businessId, outcome: "skipped", reason: "disabled" });
        skipped++;
        continue;
      }

      const timezone = (businessRow as unknown as { timezone?: string | null }).timezone ?? null;
      const window = digestWindow(now, config.frequency, timezone);
      const windows = [{ key: "digest", from: window.from, to: window.to }];
      const counts = (await q.periodCountsForWindows(businessId, windows)).digest;

      const last = await q.lastDigestNotification(businessId).catch(() => null);
      const lastSentAt = last?.createdAt ? new Date(last.createdAt) : null;
      const already = await q.digestSentForPeriod(businessId, window.periodKey).catch(() => false);

      const gate = digestShouldSend({
        config,
        counts,
        lastSentAt,
        alreadySentForPeriod: already,
        now,
      });
      if (!gate.send) {
        items.push({ businessId, outcome: "skipped", reason: gate.reason, periodKey: window.periodKey });
        skipped++;
        continue;
      }

      const summary = digestSummaryLine({
        businessName: businessRow.name,
        window,
        counts: {
          leadsCaptured: counts.leadsCaptured,
          missedCalls: counts.missedCalls,
          autoResponded: counts.autoResponded,
          customerReplies: counts.customerReplies,
          appointmentsBooked: counts.appointmentsBooked,
          jobsWon: counts.jobsWon,
          revenueRecoveredCents: counts.revenueRecoveredCents,
        },
      });

      const notification = await q.createNotification(businessId, {
        type: "performance_digest",
        payload: {
          periodKey: window.periodKey,
          periodLabel: window.periodLabel,
          summary,
          frequency: config.frequency,
          leadsCaptured: counts.leadsCaptured,
          missedCalls: counts.missedCalls,
          autoResponded: counts.autoResponded,
          customerReplies: counts.customerReplies,
          appointmentsBooked: counts.appointmentsBooked,
          jobsWon: counts.jobsWon,
          revenueRecoveredCents: counts.revenueRecoveredCents,
          // The P5-2 estimateFlags contract, restated for the payload: money
          // figures in this digest are estimates until verified by real jobs.
          estimateFlags: { jobsWon: true, revenueRecovered: true },
        },
      });

      // Email + SMS ONLY through the existing channel gates (fire-and-forget;
      // the workflow engine owns opt-outs, quiet hours, caps, honest outcomes).
      queueOwnerNotificationEmail({
        businessId,
        businessSettings: settings,
        notificationId: notification.id,
        type: "performance_digest",
        payload: {
          periodKey: window.periodKey,
          periodLabel: window.periodLabel,
          summary,
        },
      });
      void notifyOwnerViaSms(businessId, "performance_digest", {
        periodLabel: window.periodLabel,
        digestSummary: summary.replace(/^Yesterday \(.*?\): |^Last week \(.*?\): /, ""),
      });

      digestsSent++;
      items.push({ businessId, outcome: "sent", reason: null, periodKey: window.periodKey });
    } catch (err) {
      failed++;
      items.push({
        businessId,
        outcome: "skipped",
        reason: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    ranAt: now.toISOString(),
    businessesScanned: businesses.length,
    digestsSent,
    skipped,
    failed,
    items: items.slice(0, 200),
  };
}
