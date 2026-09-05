/**
 * Fire-and-forget email delivery for high-value notifications (Phase 2 build
 * #6 pre-wire).
 *
 * THE RULES (mirroring build #4's textBack honesty semantics):
 *   - Only the business-critical types are emailed: new_lead,
 *     appointment_requested, payment_failed (EMAIL_DELIVERY_TYPES). Everything
 *     else is a silent skip.
 *   - Runs ONLY when the email provider is configured (EMAIL_API_KEY +
 *     EMAIL_FROM) AND the business has an owner/manager/employee email to
 *     deliver to. Unconfigured is an expected, silent state — never an error.
 *   - NEVER blocks or throws into the caller: the in-app notification insert
 *     is the source of truth and must not fail because email did. Every
 *     failure path logs and returns honestly.
 *   - email_sent_at is stamped ONLY on provider-accepted sends and is checked
 *     first, so a notification is never double-emailed.
 *
 * SEAM: callers can inject a NotificationEmailStore (production impl =
 * src/db/queries/notifications.ts + src/lib/server/email.ts; tests use an
 * in-memory stub and a fetch monkey-patch).
 */
import {
  getBusinessOwnerEmail,
  isEmailDeliveryType,
  isNotificationEmailed,
  markNotificationEmailed,
  type NotificationType,
} from "~/db/queries/notifications";
import { getBusiness } from "~/db/queries/auth";
import { isEmailConfigured, sendEmail } from "~/lib/server/email";

export interface NotificationEmailStore {
  /** Business-scoped double-send guard: true when email_sent_at is set. */
  isNotificationEmailed(businessId: string, notificationId: string): Promise<boolean>;
  /** Stamp email_sent_at (called only after a provider-accepted send). */
  markNotificationEmailed(businessId: string, notificationId: string): Promise<boolean>;
  /** Most senior active user's email for the business; null when none. */
  getBusinessOwnerEmail(businessId: string): Promise<string | null>;
  /** Business display name for the email body. */
  getBusinessName(businessId: string): Promise<string | null>;
}


/**
 * Production store: real Neon-backed reads/writes (notifications + businesses
 * tables). Injected by call sites; tests substitute an in-memory store.
 */
export const notificationEmailStore: NotificationEmailStore = {
  isNotificationEmailed: (businessId, notificationId) =>
    isNotificationEmailed(businessId, notificationId),
  markNotificationEmailed: (businessId, notificationId) =>
    markNotificationEmailed(businessId, notificationId),
  getBusinessOwnerEmail: (businessId) => getBusinessOwnerEmail(businessId),
  getBusinessName: async (businessId) => (await getBusiness(businessId))?.name ?? null,
};

/** Per-send attempt outcome — logged honestly, never thrown into a caller. */
export type EmailDeliveryOutcome =
  | "sent"
  | "skipped_not_configured"
  | "skipped_no_recipient"
  | "skipped_duplicate"
  | "skipped_type"
  | "failed";

export interface EmailDeliveryResult {
  outcome: EmailDeliveryOutcome;
  notificationId: string;
  /** Provider message id when outcome === "sent". */
  emailId: string | null;
  /** Human-readable detail for the server log on skipped/failed outcomes. */
  detail: string | null;
}

export function buildEmailSubject(type: NotificationType, businessName: string): string {
  const shop = businessName || "your business";
  switch (type) {
    case "new_lead":
      return "New lead for " + shop;
    case "appointment_requested":
      return "New appointment request for " + shop;
    case "payment_failed":
      return "Payment failed - action needed for " + shop;
    default:
      return "Update for " + shop;
  }
}

/** Plain-text body for a notification email (kept deliberately short). */
export function buildEmailText(
  type: NotificationType,
  payload: Record<string, unknown>,
  businessName: string,
): string {
  const shop = businessName || "your business";
  const lead = typeof payload.leadName === "string" ? payload.leadName : null;
  const need = typeof payload.serviceNeed === "string" ? payload.serviceNeed : null;
  const when = typeof payload.scheduledAt === "string" ? payload.scheduledAt : null;
  switch (type) {
    case "new_lead":
      return (
        "New lead captured for " + shop + "." +
        (lead ? " Contact: " + lead + "." : "") +
        (need ? " Service need: " + need + "." : "") +
        " Open your MissedCall AI dashboard for full details."
      );
    case "appointment_requested":
      return (
        "A customer requested an appointment with " + shop + "." +
        (lead ? " Contact: " + lead + "." : "") +
        (need ? " Service: " + need + "." : "") +
        (when ? " Requested time: " + when + "." : "") +
        " Confirm or decline it in your dashboard."
      );
    case "payment_failed":
      return (
        "A card payment failed for " + shop + "'s MissedCall AI subscription." +
        " Update your billing details in your dashboard to avoid interruption."
      );
    default:
      return "You have a new update for " + shop + " in your MissedCall AI dashboard.";
  }
}

export interface DeliverNotificationEmailArgs {
  businessId: string;
  notificationId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  store: NotificationEmailStore;
}

/**
 * Attempt the email for one notification and record it honestly. NEVER
 * throws — every failure mode (provider, store, crash) becomes a logged
 * outcome. The in-app notification insert is the source of truth; email must
 * never break it.
 */
export async function deliverNotificationEmail(
  args: DeliverNotificationEmailArgs,
): Promise<EmailDeliveryResult> {
  try {
    return await attemptNotificationEmail(args);
  } catch (err) {
    // Store seam failures (DB down, etc.) land here — logged, never thrown.
    const detail = err instanceof Error ? err.message : String(err);
    console.log(
      "[email:delivery] delivery crashed for notification " +
        args.notificationId +
        ": " +
        detail,
    );
    return {
      outcome: "failed",
      notificationId: args.notificationId,
      emailId: null,
      detail,
    };
  }
}

async function attemptNotificationEmail(
  args: DeliverNotificationEmailArgs,
): Promise<EmailDeliveryResult> {
  // 1. Only the business-critical types are deliverable.
  if (!isEmailDeliveryType(args.type)) {
    return {
      outcome: "skipped_type",
      notificationId: args.notificationId,
      emailId: null,
      detail: "type " + args.type + " is in-app only",
    };
  }
  // 2. Provider gate — silent, expected state before keys land.
  if (!isEmailConfigured()) {
    return {
      outcome: "skipped_not_configured",
      notificationId: args.notificationId,
      emailId: null,
      detail: "EMAIL_API_KEY / EMAIL_FROM not set - email delivery disabled",
    };
  }
  // 3. Double-send guard: email_sent_at already stamped → never again.
  if (await args.store.isNotificationEmailed(args.businessId, args.notificationId)) {
    return {
      outcome: "skipped_duplicate",
      notificationId: args.notificationId,
      emailId: null,
      detail: "email already sent for this notification",
    };
  }
  // 4. A business email to deliver to (users table always has one in practice).
  const to = await args.store.getBusinessOwnerEmail(args.businessId);
  if (!to) {
    return {
      outcome: "skipped_no_recipient",
      notificationId: args.notificationId,
      emailId: null,
      detail: "business has no active user email",
    };
  }
  const businessName = (await args.store.getBusinessName(args.businessId)) ?? "";
  const subject = buildEmailSubject(args.type, businessName);
  const text = buildEmailText(args.type, args.payload, businessName);
  try {
    const result = await sendEmail({ to, subject, text });
    const stamped = await args.store.markNotificationEmailed(args.businessId, args.notificationId);
    if (!stamped) {
      // Lost a race with a concurrent delivery that already stamped it.
      console.log(
        "[email:delivery] notification " +
          args.notificationId +
          " email accepted (" +
          result.id +
          ") but email_sent_at was already stamped by a concurrent send",
      );
    }
    return {
      outcome: "sent",
      notificationId: args.notificationId,
      emailId: result.id,
      detail: null,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(
      "[email:delivery] send failed for notification " +
        args.notificationId +
        " (" +
        args.type +
        "): " +
        detail,
    );
    return {
      outcome: "failed",
      notificationId: args.notificationId,
      emailId: null,
      detail,
    };
  }
}

/**
 * The fire-and-forget wrapper call sites use: attempt the email in the
 * background and NEVER propagate anything into the caller — the in-app
 * notification insert is the source of truth and must not fail because email
 * did. Everything (including the crash guard) is logged honestly.
 */
export function queueNotificationEmail(args: DeliverNotificationEmailArgs): void {
  void deliverNotificationEmail(args).catch((err) => {
    console.log(
      "[email:delivery] background delivery crashed for notification " +
        args.notificationId +
        ": " +
        String(err),
    );
  });
}
