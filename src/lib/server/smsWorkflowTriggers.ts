/**
 * P4-S workflow trigger helpers — the integration points call sites use.
 *
 * Every customer-facing or owner-facing templated text in the product goes
 * through the ONE engine (sendWorkflowSms); these wrappers resolve the
 * business context, consult the business-level notification-channel controls,
 * and keep call-site code tiny. All of them are fire-and-forget-safe: a
 * workflow failure NEVER breaks the caller's primary write (capture,
 * confirmation, webhook), matching the notify/email delivery contracts.
 *
 * Honesty: outcomes come back typed and are logged; nothing here pretends a
 * send happened. Real customer messaging stays gated on Twilio/A2P — while
 * keys are present but A2P is pending, sends fail with the REAL provider
 * error and are recorded as failed, never faked.
 */
import "@tanstack/react-start/server-only";
import {
  evaluateAiLoop,
  OWNER_SMS_WORKFLOW_FOR_EVENT,
  sanitizeNotificationChannelSettings,
  smsChannelEnabled,
  type LoopThreadMessage,
  type NotificationChannelEventType,
  type WorkflowKey,
  type WorkflowTemplateVars,
} from "~/lib/smsWorkflows";
import { sendWorkflowSms, type WorkflowSendResult } from "~/lib/server/smsWorkflowEngine";
import * as q from "~/db/queries";
import { queueNotificationEmail, notificationEmailStore } from "~/lib/server/emailDelivery";
import { emailChannelEnabled } from "~/lib/smsWorkflows";

/**
 * Fire the owner SMS for a business event, honoring the per-event SMS channel
 * toggle. The workflow's own enabled flag is ALSO respected by the engine, so
 * an event only texts the owner when BOTH the channel toggle and the workflow
 * are on.
 */
export async function notifyOwnerViaSms(
  businessId: string,
  notificationType: NotificationChannelEventType,
  vars: WorkflowTemplateVars,
  opts?: { emergency?: boolean; leadId?: string | null; appointmentId?: string | null },
): Promise<WorkflowSendResult | null> {
  try {
    const business = await q.getBusiness(businessId).catch(() => null);
    if (!business) return null;
    const settings = (business as unknown as { settings?: Record<string, unknown> }).settings ?? {};
    const channels = sanitizeNotificationChannelSettings(settings.notificationChannels);
    if (!smsChannelEnabled(channels, notificationType)) return null;
    const workflowKey = OWNER_SMS_WORKFLOW_FOR_EVENT[notificationType];
    if (!workflowKey) return null;
    return await sendWorkflowSms({
      businessId,
      workflowKey,
      recipient: "owner",
      vars,
      emergency: opts?.emergency === true,
      leadId: opts?.leadId ?? null,
      appointmentId: opts?.appointmentId ?? null,
    });
  } catch (err) {
    console.log("[workflow] owner SMS trigger failed (caller unaffected): " + String(err));
    return null;
  }
}

/**
 * Fire a customer workflow (confirmation, reminder, follow-up, etc). The
 * engine owns every safeguard; this just resolves business name for the
 * template and never throws.
 */
export async function sendCustomerWorkflow(
  businessId: string,
  workflowKey: WorkflowKey,
  args: {
    to: string | null | undefined;
    vars?: WorkflowTemplateVars;
    leadId?: string | null;
    appointmentId?: string | null;
    conversationId?: string | null;
    emergency?: boolean;
  },
): Promise<WorkflowSendResult | null> {
  try {
    return await sendWorkflowSms({
      businessId,
      workflowKey,
      recipient: "customer",
      to: args.to ?? null,
      vars: args.vars,
      leadId: args.leadId ?? null,
      appointmentId: args.appointmentId ?? null,
      conversationId: args.conversationId ?? null,
      emergency: args.emergency === true,
    });
  } catch (err) {
    console.log("[workflow] customer workflow " + workflowKey + " trigger failed (caller unaffected): " + String(err));
    return null;
  }
}

/**
 * Queue the owner EMAIL for a notification type IF the business's email
 * channel toggle for that type is on. Wraps queueNotificationEmail with the
 * channel check so every queue site gets the control for free. In-app
 * delivery is never affected (it is unconditional by design).
 */
export function queueOwnerNotificationEmail(args: {
  businessId: string;
  businessSettings: Record<string, unknown> | null | undefined;
  notificationId: string;
  type: Parameters<typeof queueNotificationEmail>[0]["type"];
  payload: Record<string, unknown>;
}): void {
  const channels = sanitizeNotificationChannelSettings(args.businessSettings?.notificationChannels);
  if (!emailChannelEnabled(channels, args.type)) return;
  queueNotificationEmail({
    businessId: args.businessId,
    notificationId: args.notificationId,
    type: args.type,
    payload: args.payload,
    store: notificationEmailStore,
  });
}

/**
 * AI-loop evaluation for an inbound message: count consecutive auto-echoed
 * inbound replies in the thread (newest first) and decide whether the engine
 * must stop auto-responding and hand the thread to a human.
 */
export async function evaluateThreadAiLoop(
  businessId: string,
  conversationId: string,
  maxReplies: number,
): Promise<{ suppress: boolean; echoCount: number }> {
  const messages = await q
    .listMessages(businessId, conversationId, { limit: 12, order: "desc" })
    .catch(() => []);
  const thread: LoopThreadMessage[] = messages.map((m) => ({
    direction: (m.direction === "outbound" ? "outbound" : "inbound") as LoopThreadMessage["direction"],
    body: m.body,
  }));
  return evaluateAiLoop(thread, maxReplies);
}

/**
 * Hand a looping thread to a human: an ai_loop_detected in-app notification
 * through the standard path (the engine has already stopped auto-replying by
 * the time this is called). Best-effort — never throws.
 */
export async function handLoopedThreadToHuman(
  businessId: string,
  conversationId: string,
  echoCount: number,
): Promise<void> {
  try {
    const payload = {
      conversationId,
      echoCount,
      message:
        "This text thread looped on automated replies — auto-responses are paused. A person should take over the conversation.",
    };
    await q.createNotification(businessId, { type: "ai_loop_detected", payload });
  } catch (err) {
    console.log("[workflow] ai-loop handoff notification failed: " + String(err));
  }
}

/**
 * One-time welcome text when onboarding completes. Guarded by the
 * `welcomeSentAt` stamp in the business settings so it fires exactly once
 * even though several save handlers can complete onboarding. Best-effort.
 */
export async function maybeSendOnboardingWelcome(businessId: string): Promise<void> {
  try {
    const business = await q.getBusiness(businessId).catch(() => null);
    if (!business) return;
    const settings = { ...((business as unknown as { settings?: Record<string, unknown> }).settings ?? {}) };
    if (typeof settings.welcomeSentAt === "string") return;
    await sendWorkflowSms({
      businessId,
      workflowKey: "welcome",
      recipient: "owner",
      vars: {},
    });
    settings.welcomeSentAt = new Date().toISOString();
    await q.updateBusinessSettings(businessId, settings);
  } catch (err) {
    console.log("[workflow] welcome SMS trigger failed (onboarding unaffected): " + String(err));
  }
}
