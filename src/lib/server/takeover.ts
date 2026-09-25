/**
 * P5-4: Human takeover / escalation — server-side wiring.
 *
 * The pure trigger DECISION lives in src/lib/takeover.ts; this module does the
 * I/O: flag the conversation (idempotent, ai→needed only) and notify the
 * plumber through the EXISTING notification path —
 *   in-app:  createNotification (type takeover_needed), always on;
 *   email:   queueOwnerNotificationEmail (channel-toggle gated);
 *   SMS:     notifyOwnerViaSms → the ONE workflow engine, so the takeover
 *            alert rides the same safeguard chain as every owner text
 *            (opt-out rule, invalid-number stop, quiet hours, cooldown, caps,
 *            plan limit; emergency flag stays reserved for the emergency
 *            workflow — a takeover alert is NOT an emergency escalation).
 *
 * Best-effort by contract: a flag/notification failure is logged and never
 * breaks the conversation turn that triggered it.
 */
import "@tanstack/react-start/server-only";
import * as q from "~/db/queries";
import {
  TAKEOVER_REASON_LABELS,
  detectTakeoverReasons,
  topTakeoverReason,
  type TakeoverReasonKey,
} from "~/lib/takeover";
import type { PipelineResult } from "./classifyPipeline";
import { notifyOwnerViaSms, queueOwnerNotificationEmail } from "./smsWorkflowTriggers";

export interface TakeoverFlagResult {
  /** True only when the state actually moved ai→needed this call. */
  flagged: boolean;
  /** The reason stored/alerted, when flagged. */
  reason: TakeoverReasonKey | null;
}

/**
 * Flag one conversation as needing a human and notify the owner. The
 * conditional UPDATE (WHERE handoff_status='ai') makes this idempotent per
 * thread: repeat triggers on an already-flagged or human-owned thread change
 * nothing and send nothing.
 */
export async function flagConversationNeedsHuman(
  businessId: string,
  conversationId: string,
  reason: TakeoverReasonKey,
  detail: Record<string, unknown> | null,
): Promise<TakeoverFlagResult> {
  try {
    const marked = await q.markConversationNeedsHuman(businessId, conversationId, reason, detail);
    if (!marked) return { flagged: false, reason: null };

    const payload: Record<string, unknown> = {
      conversationId,
      reason,
      reasonLabel: TAKEOVER_REASON_LABELS[reason],
      customerPhone: marked.customerPhone,
      ...(marked.leadId ? { leadId: marked.leadId } : {}),
      ...(detail && typeof detail.preview === "string" ? { preview: detail.preview } : {}),
    };
    const notification = await q.createNotification(businessId, {
      type: "takeover_needed",
      payload,
    });
    // Owner EMAIL via the existing channel-gated queue; owner SMS via the ONE
    // workflow engine (human_takeover workflow + takeover_needed channel
    // toggle → safeguards chain). Never blocks the flag write.
    try {
      const bizRow = await q.getBusiness(businessId).catch(() => null);
      const bizSettings =
        (bizRow as unknown as { settings?: Record<string, unknown> } | null)?.settings ?? {};
      queueOwnerNotificationEmail({
        businessId,
        businessSettings: bizSettings,
        notificationId: notification.id,
        type: "takeover_needed",
        payload,
      });
    } catch (emailErr) {
      console.log("[takeover] owner email queue failed (flag stored): " + String(emailErr));
    }
    void notifyOwnerViaSms(
      businessId,
      "takeover_needed",
      {
        customerName: undefined,
        // The takeover alert leads with WHY the AI needs a human — the reason
        // label rides the template's {serviceNeed} variable.
        serviceNeed: TAKEOVER_REASON_LABELS[reason],
      },
      { leadId: marked.leadId },
    );
    console.log(
      "[takeover] conversation " +
        conversationId +
        " flagged for a human (" +
        reason +
        ")",
    );
    return { flagged: true, reason };
  } catch (err) {
    console.log("[takeover] flagging failed (conversation turn unaffected): " + String(err));
    return { flagged: false, reason: null };
  }
}

/**
 * Evaluate one completed classification turn for takeover triggers and flag
 * when warranted. Emergency is deliberately NOT handled here — the existing
 * emergency escalation path (textBack.escalateEmergency) flags the thread
 * itself; this function is only called for non-emergency turns.
 */
export async function evaluateTakeoverForTurn(
  businessId: string,
  conversationId: string,
  pipeline: PipelineResult,
  body: string,
): Promise<TakeoverFlagResult> {
  const c = pipeline.classification;
  const reasons = detectTakeoverReasons({
    body,
    urgency: c.urgency,
    priority: c.priority,
    category: c.category ?? null,
    serviceNeed: c.serviceNeed,
    confidence: c.confidence ?? null,
    replySource: c.replySource ?? null,
    tierReason: pipeline.tierReason,
  });
  const reason = topTakeoverReason(reasons);
  if (!reason) return { flagged: false, reason: null };
  return flagConversationNeedsHuman(businessId, conversationId, reason, {
    reasons,
    preview: body.slice(0, 120),
    tier: pipeline.tier,
    tierReason: pipeline.tierReason,
    confidence: c.confidence ?? null,
    classifier: c.classifier ?? null,
  });
}
