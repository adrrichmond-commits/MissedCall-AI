/**
 * WEEKLY OPS DIGEST sweep — delivery orchestration.
 *
 * PLAIN server module (no RPC): called by the cron route
 * (/api/cron/ops-digest, the SAME CRON_SECRET gate pattern as
 * /api/cron/performance-digest) and directly by scripts/test-ops-digest.ts.
 *
 * DELIVERY PATH (follows what exists — nothing new invented):
 *   1. IN-APP  — an ops_digest notification row on the platform owner's
 *                business feed (q.createNotification — the ONE notification
 *                path every other alert uses, P5-5 digest convention).
 *   2. EMAIL   — a direct sendEmail() through src/lib/server/email.ts: the
 *                Knock missedcall-notify transport primary with the
 *                Resend-style fallback — the exact provider path the
 *                payment-failure email rides (emailDelivery.ts's
 *                queueNotificationEmail → sendEmail under the hood). The
 *                recipient is THE platform admin, not a per-business owner,
 *                so the business-scoped notification-channel gates do not
 *                apply; the provider-level isEmailConfigured() gate does.
 *
 * HONEST SKIPS (log + 200 at the route, never a fake "sent"):
 *   - no platform admin user in the DB → skipped: no_admin_user
 *   - this week's period key already digested → skipped: already_sent
 *   - email provider not configured → the in-app row still lands and the
 *     response reports email honestly as skipped_not_configured.
 *
 * IDEMPOTENCY: one digest per period key (opsDigestSentForPeriod, mirroring
 * the P5-5 digestSentForPeriod cap). The period is claimed by the in-app
 * notification row — the digest history IS the state, so a settings stamp
 * can never drift from reality.
 */
import { createNotification, opsDigestSentForPeriod } from "~/db/queries/notifications";
import { findPlatformAdminRecipient, opsDigestRaw } from "~/db/queries/opsDigest";
import { isEmailConfigured, sendEmail } from "~/lib/server/email";
import { buildOpsDigest, type OpsDigestView } from "~/lib/server/opsDigest";

export type OpsDigestSkipReason =
  | "no_admin_user"
  | "already_sent"
  | "email_not_configured"
  | "email_failed"
  | "error";

export interface OpsDigestSweepResult {
  ranAt: string;
  outcome: "delivered" | "skipped" | "error";
  /** Why a delivery did not fully happen (null on full success). */
  reason: OpsDigestSkipReason | null;
  detail: string | null;
  recipientEmail: string | null;
  periodKey: string | null;
  /** The in-app notification row id when one was written. */
  notificationId: string | null;
  email: {
    outcome: "sent" | "skipped_not_configured" | "failed";
    emailId: string | null;
    detail: string | null;
  } | null;
  /** The digest content actually assembled for this run (null on skips). */
  digest: OpsDigestView | null;
}

/**
 * Run one weekly ops digest attempt. `now` is injectable so tests can pin
 * the window/period key. Never throws for honest business outcomes — only
 * infrastructure failures surface as { outcome: "error" }.
 */
export async function runWeeklyOpsDigest(now: Date = new Date()): Promise<OpsDigestSweepResult> {
  const ranAt = now.toISOString();
  let recipient: { email: string; businessId: string } | null = null;
  try {
    // 1. Recipient — resolved fresh from the DB (users.is_platform_admin),
    //    never hard-coded. No admin user = nothing to deliver to.
    recipient = await findPlatformAdminRecipient();
    if (!recipient) {
      console.log("[ops-digest] skipped: no active platform admin user in the DB");
      return {
        ranAt,
        outcome: "skipped",
        reason: "no_admin_user",
        detail: "No active users.is_platform_admin row — nothing to deliver to.",
        recipientEmail: null,
        periodKey: null,
        notificationId: null,
        email: null,
        digest: null,
      };
    }

    // 2. Period idempotency — one digest per period key, whatever the cron
    //    ping cadence. The notification row IS the state.
    const digest = buildOpsDigest(
      await opsDigestRaw(new Date(now.getTime() - 7 * 24 * 60 * 60_000), now),
      now,
    );
    const already = await opsDigestSentForPeriod(recipient.businessId, digest.periodKey);
    if (already) {
      console.log("[ops-digest] skipped: period " + digest.periodKey + " already digested for " + recipient.businessId);
      return {
        ranAt,
        outcome: "skipped",
        reason: "already_sent",
        detail: "A digest for period " + digest.periodKey + " already exists.",
        recipientEmail: recipient.email,
        periodKey: digest.periodKey,
        notificationId: null,
        email: null,
        digest,
      };
    }

    // 3. In-app delivery — the platform owner's business feed (the ONE
    //    notification path; unconditional, like every other alert type).
    const notification = await createNotification(recipient.businessId, {
      type: "ops_digest",
      payload: {
        periodKey: digest.periodKey,
        windowStart: digest.startIso,
        windowEnd: digest.endIso,
        everythingQuiet: digest.everythingQuiet,
        text: digest.text,
        trials: digest.trials,
        leads: digest.leads,
        appointments: digest.appointments,
        attentionCounts: {
          failedLineTests: digest.attention.failedLineTests.length,
          takeoversWaiting: digest.attention.takeoversWaiting.length,
          paymentFailures: digest.attention.paymentFailures.length,
        },
        lines: digest.lines,
      },
    });

    // 4. Email attempt — the payment-failure provider path (Knock
    //    missedcall-notify primary). Provider-unconfigured and provider
    //    rejections are HONEST outcomes reported to the caller, never
    //    disguised as sends.
    let email: OpsDigestSweepResult["email"];
    if (!isEmailConfigured()) {
      console.log("[ops-digest] email skipped: no email provider configured (in-app digest delivered)");
      email = {
        outcome: "skipped_not_configured",
        emailId: null,
        detail: "No email provider in env — the in-app digest is the delivery.",
      };
    } else {
      try {
        const sent = await sendEmail({
          to: recipient.email,
          subject: digest.subject,
          text: digest.text,
        });
        console.log("[ops-digest] email accepted: " + sent.id + " → " + sent.to);
        email = { outcome: "sent", emailId: sent.id, detail: null };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.log("[ops-digest] email FAILED (in-app digest unaffected): " + detail);
        email = { outcome: "failed", emailId: null, detail };
      }
    }

    return {
      ranAt,
      outcome: "delivered",
      reason: email.outcome === "sent" ? null : email.outcome === "failed" ? "email_failed" : "email_not_configured",
      detail: email.outcome === "sent" ? null : email.detail,
      recipientEmail: recipient.email,
      periodKey: digest.periodKey,
      notificationId: notification.id,
      email,
      digest,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log("[ops-digest] sweep error: " + detail);
    return {
      ranAt,
      outcome: "error",
      reason: "error",
      detail,
      recipientEmail: recipient?.email ?? null,
      periodKey: null,
      notificationId: null,
      email: null,
      digest: null,
    };
  }
}
