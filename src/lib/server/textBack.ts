/**
 * Missed-call text-back flow (Phase 2 build #4 pre-wire; P3-B rewiring).
 *
 * THE FLOW: a lead with source='missed_call' is captured. When Twilio is
 * configured (and the number is not opted out) the text-back template goes
 * out and the send is recorded honestly on the lead + in-app notification.
 * When Twilio is NOT configured, the lead is captured exactly as today, NO
 * message is sent, and the notification payload records textBack: "not_sent"
 * with a clear reason — the product never pretends a text went out.
 *
 * THE OPT-OUT RULE: nothing in this module (or any caller of sendSms) may
 * send to a phone present in sms_opt_outs for the business — checked before
 * every send. See migration 008's header and src/db/queries/smsComms.ts.
 *
 * P3-B (classification + advice pipeline): inbound SMS is classified by
 * src/lib/server/classifyPipeline.ts — LLM tier (KB guardrail prompt, output
 * post-screened) → rules tier default without LLM_API_KEY → rules backstop on
 * LLM error. Replies are produced honestly: KB emergency scripts verbatim,
 * KB FAQ policies, screened LLM text, or the human-routing fallback. When the
 * result is emergency-severity, the flow escalates: the lead (when linked) is
 * marked emergency, and an emergency-payload notification goes through the
 * EXISTING notification path (createNotification + queueNotificationEmail) —
 * no parallel notification system.
 *
 * Server-only: imports the query layer and the env-gated providers.
 */
import { parseSmsCommand } from "~/lib/smsCommands";
import { SMS_TEMPLATES, renderSmsTemplate } from "~/lib/smsTemplates";
import * as q from "~/db/queries";
import type { CreateLeadInput } from "~/db/queries/leads";
import type { Lead } from "~/db/schema";
import { isLlmConfigured, llmComplete, readLlmConfig } from "./llm";
import { isSmsConfigured, sendSms } from "./sms";
import { captureSystemError } from "./errorSink";
import { gateAction, loadPlanUsageContext, meterAction } from "./usageGate";
import { anchorForBusiness } from "./usageGate";
import type { GateDecision } from "./usage";
import {
  runClassificationPipeline,
  type PipelineInput,
  type PipelineLlm,
  type PipelineResult,
} from "./classifyPipeline";
import { maybeCreateFollowUpTaskForNewLead } from "./followUps";
import { sendWorkflowSms, type WorkflowEngineIo } from "./smsWorkflowEngine";
import { sanitizeSmsWorkflowsConfig } from "~/lib/smsWorkflows";
import {
  evaluateThreadAiLoop,
  handLoopedThreadToHuman,
  notifyOwnerViaSms,
  queueOwnerNotificationEmail,
} from "./smsWorkflowTriggers";
// P4-A learning loop: funnel stage recording, AI-quality signals, runtime
// prompt overlay (best-effort; none of these can fail the conversation).
import { trackFunnel } from "./funnelTrack";
import { recordClassificationTurn, markEmergencyEscalated } from "./qualityMonitor";
import { applyPromptOverlay } from "./promptOverrides";

/** What actually happened with the text-back for one captured lead. */
export type TextBackOutcome =
  | "sent"
  | "opted_out"
  | "not_configured"
  | "limit_reached"
  | "failed"
  // P4-S engine outcomes surfaced honestly (workflow off, safeguards, etc):
  | "disabled"
  | "duplicate_suppressed"
  | "quiet_hours"
  | "invalid_number"
  | "no_recipient";

export interface TextBackResult {
  outcome: TextBackOutcome;
  /** Twilio message SID when outcome === 'sent'. */
  sid: string | null;
  /** Machine-readable reason for non-sent outcomes. */
  reason: string | null;
  /**
   * P3-F: present ONLY when outcome === 'limit_reached' — the typed gate
   * decision (plan-named honest message + upgrade target) for the UI/API
   * upgrade prompt. A limit is never a silent drop.
   */
  gate: GateDecision | null;
}

function textBackResult(outcome: TextBackOutcome, reason: string | null, gate: GateDecision | null = null, sid: string | null = null): TextBackResult {
  return { outcome, sid, reason, gate };
}

export class TextBackError extends Error {
  constructor(
    message: string,
    readonly outcome: TextBackOutcome,
  ) {
    super(message);
    this.name = "TextBackError";
  }
}

/**
 * Capture a missed-call lead and run the text-back flow.
 *
 * Guarantees:
 *   - the lead is ALWAYS created (capture never depends on the provider);
 *   - NO outbound SMS is ever sent to an opted-out number;
 *   - outcome is honest: 'not_configured' | 'opted_out' | 'failed' rows get
 *     no message and a notification payload that says exactly why.
 */
export async function captureMissedCallLead(
  businessId: string,
  businessName: string,
  input: CreateLeadInput,
): Promise<{ lead: Lead; textBack: TextBackResult }> {
  // 1. Capture the lead first — provider state never blocks capture.
  const lead = await q.createLead(businessId, input);
  // P4-A funnel: the business's first AI-captured lead (SMS text-back or
  // voice receptionist both funnel through this function). Idempotent.
  void trackFunnel(businessId, "first_lead");

  // 2. In-app new_lead notification (always, matching build #3 semantics).
  //    P4-S: the owner's EMAIL and SMS channels for new_lead are gated by the
  //    business-level notification-channel controls (in-app stays on).
  let textBack: TextBackResult = textBackResult("not_configured", "Twilio not configured");
  try {
    const businessRow = await q.getBusiness(businessId).catch(() => null);
    const bizSettings = (businessRow as unknown as { settings?: Record<string, unknown> } | null)?.settings ?? {};
    const payload = {
      leadId: lead.id,
      leadName: lead.contactName,
      serviceNeed: lead.serviceNeed,
      priority: lead.priority,
      textBack: textBack.outcome,
      textBackReason: textBack.reason,
    };
    const notification = await q.createNotification(businessId, {
      type: "new_lead",
      payload,
    });
    // Fire-and-forget owner email + SMS (P4-S channel controls) — never block
    // or fail the capture.
    queueOwnerNotificationEmail({
      businessId,
      businessSettings: bizSettings,
      notificationId: notification.id,
      type: "new_lead",
      payload,
    });
    void notifyOwnerViaSms(businessId, "new_lead", {
      customerName: lead.contactName ?? "a customer",
      serviceNeed: lead.serviceNeed ?? "service request",
    }, { leadId: lead.id });
  } catch {
    // Notification failure must not fail the capture.
  }

  // 3. Text-back attempt — through the P4-S workflow engine (the ONE send
  //    path): env-gated, opt-out-checked, safeguarded, failures honest.
  textBack = await sendTextBack(businessId, businessName, lead);

  // 4. P3-C: the capture follow-up task ('lead_new', due next business day
  //    business time). Best-effort — never fails the capture.
  await maybeCreateFollowUpTaskForNewLead(businessId, lead);

  return { lead, textBack };
}

/**
 * Send the text-back for an already-created missed_call lead.
 *
 * P4-S: this is now a thin mapping over the ONE workflow engine — the
 * missed_call_recovery workflow carries the opt-out rule, the invalid-number
 * stop, quiet hours, the duplicate cooldown, the per-customer cap, the plan
 * usage gate, and honest recording. The engine's outcome maps 1:1 onto the
 * legacy TextBackResult so every existing caller keeps its semantics:
 *   - 'not_configured' and 'opted_out' remain silent skips (expected states);
 *   - only 'sent' may ever be reported as a send;
 *   - 'limit_reached' keeps the typed gate decision for the upgrade prompt.
 */
export async function sendTextBack(
  businessId: string,
  _businessName: string,
  lead: Lead,
  io?: WorkflowEngineIo,
): Promise<TextBackResult> {
  const outcome = await sendWorkflowSms({
    businessId,
    workflowKey: "missed_call_recovery",
    recipient: "customer",
    to: lead.contactPhone,
    leadId: lead.id,
    ...(io ? { io } : {}),
  });
  const map: Record<string, TextBackOutcome> = {
    sent: "sent",
    failed: "failed",
    disabled: "disabled",
    not_configured: "not_configured",
    opted_out: "opted_out",
    invalid_number: "invalid_number",
    quiet_hours: "quiet_hours",
    duplicate_suppressed: "duplicate_suppressed",
    cap_reached: "limit_reached",
    limit_reached: "limit_reached",
    no_recipient: "no_recipient",
  };
  const mapped = map[outcome.outcome] ?? "failed";
  return textBackResult(mapped, outcome.reason, outcome.gate, outcome.sid);
}

/**
 * Handle an inbound SMS for a business: STOP/START/HELP handling with
 * opt-out persistence, then classification through the P3-B pipeline —
 * LLM tier when configured (KB-guardrailed, post-screened), rule engine
 * (src/lib/server/classify.ts + KB) as the default without an LLM and as the
 * backstop when the configured LLM fails. The message is ALWAYS stored first;
 * classification is stamped honestly with which tier ran (classifier/tier/
 * tierReason/kbVersion). Emergency-severity results escalate: the linked
 * lead is re-stamped emergency and an emergency-payload notification goes
 * out through the existing path. An auto-reply is sent only when the
 * pipeline produced one and the number is not opted out.
 */
export async function handleInboundSms(args: {
  businessId: string;
  businessName: string;
  conversationId: string;
  body: string;
  from: string;
  externalId: string | null;
}): Promise<{
  command: "stop" | "start" | "help" | null;
  status: "unclassified" | "delivered";
  /** P3-F: the ai_turns/sms limit decision for this turn, when one was hit. */
  limitReached: GateDecision | null;
}> {
  // 1. Store the inbound message FIRST (data survives every later failure).
  const message = await q.appendMessage({
    businessId: args.businessId,
    conversationId: args.conversationId,
    direction: "inbound",
    body: args.body,
    status: "unclassified",
    externalId: args.externalId,
  });
  // P4-A funnel: the recovery loop actually ran for this business (first
  // AI-handled inbound SMS). Idempotent; failure never affects the flow.
  void trackFunnel(args.businessId, "first_recovered_call");

  // 2. Command handling (STOP persistence is the compliance gate).
  const command = parseSmsCommand(args.body);
  let status: "unclassified" | "delivered" = "unclassified";
  if (command === "stop") {
    await q.addSmsOptOut(args.businessId, {
      phone: args.from,
      reason: "stop_reply",
      sourceMessageSid: args.externalId,
    });
    await tryReplyCommand(args, SMS_TEMPLATES.stopConfirm);
  } else if (command === "start") {
    await q.removeSmsOptOut(args.businessId, args.from);
    await tryReplyCommand(args, SMS_TEMPLATES.startConfirm);
  } else if (command === "help") {
    await tryReplyCommand(args, SMS_TEMPLATES.help);
  }

  // 3. Classification through the P3-B pipeline. The message starts
  //    'unclassified'; 'delivered' + a classification payload is stamped only
  //    when the pipeline actually produced one. Every stored payload honestly
  //    records which tier ran and why (classifier + tier + tierReason +
  //    kbVersion). Expected engine failure never throws: an LLM error
  //    degrades to the rules tier for THIS turn (tierReason "backstop") and
  //    is logged.
  // P3-F: the ai_turns/sms limit decision for this turn, when one was hit.
  let turnGate: GateDecision | null = null;
  if (!command) {
    // P3-F usage gating, SAFETY-FIRST ORDER: classification itself is never
    // skipped — a customer texting about a flood must classify and escalate
    // even at the limit. What the ai_turns limit controls is the EXPENSIVE
    // LLM tier: at/over the limit the turn degrades to the rules engine
    // (still classified, still escalated, never dropped) and the typed
    // limit decision is returned for the UI/monitoring upgrade prompt. The
    // turn is metered either way (usage stays truthful).
    let llmAllowed = true;
    try {
      const bizRow = await q.getBusiness(args.businessId);
      if (bizRow) {
        const ctx = await loadPlanUsageContext(args.businessId, anchorForBusiness(bizRow));
        const gate = gateAction({ ctx, axis: "ai_turns_per_month" });
        if (!gate.allowed) {
          turnGate = gate;
          llmAllowed = false;
        }
      }
    } catch (gateErr) {
      // Gate failure must never block classification: fail OPEN for safety,
      // log honestly (metering/gating is degraded, not the conversation).
      console.log("[textback] usage gate unavailable - allowing LLM tier: " + String(gateErr));
    }
    // P4-A: wall-clock duration of the classification turn (quality signal).
    const turnStart = performance.now();
    const pipeline = await runInboundPipeline(args.businessId, args.body, llmAllowed ? undefined : { forceRulesTier: true });
    const turnLatencyMs = Math.round(performance.now() - turnStart);
    try {
      const bizRow = await q.getBusiness(args.businessId);
      if (bizRow) {
        const ctx = await loadPlanUsageContext(args.businessId, anchorForBusiness(bizRow));
        await meterAction({ businessId: args.businessId, ctx, axis: "ai_turns_per_month" });
      }
    } catch (meterErr) {
      console.log("[textback] ai_turn meter failed (classification unaffected): " + String(meterErr));
    }
    await q.setMessageClassification(args.businessId, message.id, pipeline.classification);
    status = "delivered";
    if (pipeline.tierReason === "backstop") {
      console.log(
        "[textback] LLM tier failed - rules backstop applied (confidence " +
          (pipeline.classification.confidence ?? 0).toFixed(2) +
          ")",
      );
    }
    // P4-A: record the AI outcome signal for this turn + refresh the review
    // flags. tierReason "backstop" = the LLM was configured but failed this
    // turn (the honest failure signal); "default" = no LLM configured at all
    // (no AI failure — the rules engine IS the launch configuration).
    void recordClassificationTurn(args.businessId, args.conversationId, {
      classification: pipeline.classification,
      latencyMs: turnLatencyMs,
      llmFailed: pipeline.tierReason === "backstop",
    });

    // 4. Emergency auto-escalation (fail toward emergency; never a parallel
    //    notification system — the in-app row + owner email/SMS ARE the
    //    notification path, same as new_lead).
    if (pipeline.classification.urgency === "emergency") {
      await escalateEmergency(args, pipeline);
    }

    // 5. Auto-reply: only the pipeline's screened/KB-sourced text, and never
    //    to an opted-out phone. Fire-and-forget: reply failure is logged and
    //    never fails the stored classification.
    //
    //    P4-S AI-LOOP PREVENTION: before auto-replying, count the consecutive
    //    inbound replies that echo our own outbound text. At the configured
    //    limit the engine stops auto-responding and hands the thread to a
    //    human (ai_loop_detected notification). Classification + emergency
    //    escalation above still run — a loop never silences an emergency.
    if (pipeline.reply && pipeline.reply.text) {
      let aiLoopMax = 3;
      let loopDecision: { suppress: boolean; echoCount: number } | null = null;
      try {
        const bizRow = await q.getBusiness(args.businessId).catch(() => null);
        const wfConfig = sanitizeSmsWorkflowsConfig(
          (bizRow as unknown as { settings?: Record<string, unknown> } | null)?.settings?.smsWorkflows,
        );
        aiLoopMax = wfConfig.safeguards.aiLoopMaxReplies;
        loopDecision = await evaluateThreadAiLoop(args.businessId, args.conversationId, aiLoopMax);
      } catch (loopErr) {
        console.log("[textback] ai-loop evaluation failed (reply unaffected): " + String(loopErr));
      }
      if (loopDecision?.suppress) {
        console.log(
          "[textback] AI loop detected on conversation " +
            args.conversationId +
            " (" +
            loopDecision.echoCount +
            " consecutive auto-echoed replies >= " +
            aiLoopMax +
            ") - auto-reply stopped, handing thread to a human",
        );
        await handLoopedThreadToHuman(args.businessId, args.conversationId, loopDecision.echoCount);
      } else {
        const replyGate = await tryPipelineReply(args, pipeline.reply.text, {
          // EMERGENCY EXCEPTION (pricing.ts): emergency replies are never
          // rate-limited — a flooded basement is not silenced by a counter.
          emergency: pipeline.classification.urgency === "emergency",
        });
        if (replyGate) turnGate = replyGate;
      }
    }
  }
  return { command, status, limitReached: turnGate };
}

/**
 * Build the pipeline input from business settings + run it.
 *
 * LLM tier seam: when LLM_API_KEY is configured, production passes a
 * PipelineLlm wrapping llmComplete; without the key, llm is null and the
 * rules tier is the DEFAULT (the keyless launch configuration). Timezone +
 * hours come from the existing business settings (businesses.timezone +
 * business_hours); a failed read fails toward after-hours (safe direction).
 */
async function runInboundPipeline(
  businessId: string,
  body: string,
  opts?: { forceRulesTier?: boolean },
): Promise<PipelineResult> {
  // P3-F: forceRulesTier skips the LLM tier for this turn (ai_turns limit
  // reached) — the rules engine still classifies, so the turn is useful.
  const llm: PipelineLlm | null =
    opts?.forceRulesTier === true
      ? null
      : isLlmConfigured()
    ? {
        model: readLlmConfig()?.model ?? "unknown",
        // P4-A: the runtime prompt overlay (admin console) is appended to
        // whatever system prompt the pipeline passes — the KB guardrail
        // prompt stays first and can never be weakened by the overlay.
        complete: async (system, user, llmOpts) =>
          llmComplete(await applyPromptOverlay(system, "lead_capture"), user, {
            maxTokens: llmOpts?.maxTokens ?? 500,
            timeoutMs: llmOpts?.timeoutMs ?? 15_000,
            temperature: 0,
          }),
      }
    : null;

  const [business, hours] = await Promise.all([
    q.getBusiness(businessId).catch(() => null),
    q.listBusinessHours(businessId).catch(() => null),
  ]);

  const input: PipelineInput = {
    body,
    now: new Date(),
    timezone: business?.timezone ?? null,
    hours: hours && hours.length > 0 ? hours : null,
    llm,
    // P5-1: the owner's emergency instructions reach the AI — the settings
    // surface promises "the AI follows these on emergency calls", so the
    // pipeline must actually receive them (LLM tier appends them to the
    // system prompt; the rules tier's KB safety scripts are verbatim by
    // design and use free text only for context, never for output).
    emergencyInstructions: readEmergencyInstructions(
      (business as unknown as { settings?: Record<string, unknown> } | null)?.settings,
    ),
  };
  return runClassificationPipeline(input);
}

/**
 * P5-1: extract the owner's emergency instructions from the business settings
 * jsonb. saveEmergencyPrefsFn persists the prefs FLAT on the settings blob
 * (`settings.emergencyInstructions`); the nested `emergencyPrefs.*` shape is
 * also accepted for forward-compatibility. Pure + tolerant of every malformed
 * shape — a broken settings blob yields null, never a throw. Exported for the
 * journey suite to prove the settings → AI handoff.
 */
export function readEmergencyInstructions(bizSettings: unknown): string | null {
  const s = (bizSettings ?? {}) as {
    emergencyInstructions?: unknown;
    emergencyPrefs?: { emergencyInstructions?: unknown };
  };
  const raw =
    typeof s.emergencyInstructions === "string"
      ? s.emergencyInstructions
      : s.emergencyPrefs?.emergencyInstructions;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Emergency auto-escalation for an emergency-severity classification:
 *   - re-stamp the linked lead (conversation → lead) to priority='emergency'
 *     + urgency='emergency' so triage ordering picks it up immediately;
 *   - record an emergency-payload notification through the EXISTING
 *     createNotification + queueNotificationEmail path with
 *     escalation metadata (afterHours, emergencyKey/severity, replySource).
 *
 * Best-effort by design: escalation failure is logged and never fails the
 * stored classification (the message data already survives).
 */
async function escalateEmergency(
  args: { businessId: string; conversationId: string },
  pipeline: PipelineResult,
): Promise<void> {
  const c = pipeline.classification;
  try {
    // Link the lead when the conversation has one (text-back conversations
    // are created against a lead; inbound webhooks may or may not be).
    // P3-C status automation contract: an emergency-classified lead is NOT
    // flagged follow_up_needed and its lifecycle status is untouched — it
    // stays where it is (typically new) with emergency priority; the
    // escalation notification below is how the shop gets paged.
    const conversation = await q.getConversation(args.businessId, args.conversationId);
    const leadId = conversation?.leadId ?? null;
    if (leadId) {
      await q.updateLead(args.businessId, leadId, {
        priority: "emergency",
        urgency: "emergency",
      });
    }

    const payload = {
      leadId: leadId ?? undefined,
      serviceNeed: c.serviceNeed ?? "Emergency (unspecified)",
      priority: "emergency",
      emergency: true,
      emergencyKey: c.emergencyKey ?? undefined,
      emergencySeverity: c.emergencySeverity ?? undefined,
      afterHours: pipeline.afterHours,
      afterHoursEscalation: pipeline.afterHoursEscalation,
      replySource: c.replySource ?? undefined,
      classifier: c.classifier ?? undefined,
    };
    const notification = await q.createNotification(args.businessId, {
      type: "new_lead",
      payload,
    });
    // P4-S: owner email gated by the email channel toggle, owner SMS by the
    // SMS toggle (emergency_escalation workflow, which by design overrides
    // quiet hours and caps but never the opt-out rule).
    const bizRow = await q.getBusiness(args.businessId).catch(() => null);
    const bizSettings = (bizRow as unknown as { settings?: Record<string, unknown> } | null)?.settings ?? {};
    queueOwnerNotificationEmail({
      businessId: args.businessId,
      businessSettings: bizSettings,
      notificationId: notification.id,
      type: "new_lead",
      payload,
    });
    void notifyOwnerViaSms(
      args.businessId,
      "emergency",
      {
        customerName: leadId ? undefined : "A customer",
        serviceNeed: c.serviceNeed ?? "an emergency",
      },
      { emergency: true, leadId: leadId },
    );
    // P4-A: the escalation COMPLETED — record it so the review queue does not
    // flag this conversation as "emergency without escalation".
    void markEmergencyEscalated(args.businessId, args.conversationId);
    console.log(
      "[textback] EMERGENCY escalated (key " +
        (c.emergencyKey ?? "unclassified") +
        ", afterHours " +
        pipeline.afterHours +
        ", lead " +
        (leadId ?? "none") +
        ")",
    );
  } catch (err) {
    console.log("[textback] emergency escalation failed (classification stored): " + String(err));
  }
}

/**
 * Best-effort screened auto-reply send; opt-out rule enforced here too.
 * P3-F: the reply is a plan-metered outbound SMS — at the limit the reply is
 * withheld and the typed gate decision is returned for the upgrade prompt,
 * EXCEPT for emergency replies, which are NEVER rate-limited (pricing.ts
 * safety decision; still metered so usage stays truthful).
 */
async function tryPipelineReply(
  args: { businessId: string; conversationId: string; from: string },
  body: string,
  gateOpts?: { emergency?: boolean },
): Promise<GateDecision | null> {
  try {
    if (await q.isSmsOptedOut(args.businessId, args.from)) return null;
    if (!isSmsConfigured()) return null;
    const bizRow = await q.getBusiness(args.businessId).catch(() => null);
    let ctx: Awaited<ReturnType<typeof loadPlanUsageContext>> | null = null;
    if (bizRow) {
      ctx = await loadPlanUsageContext(args.businessId, anchorForBusiness(bizRow));
      const gate = gateAction({ ctx, axis: "sms_per_month", emergency: gateOpts?.emergency === true });
      if (!gate.allowed) {
        console.log("[textback] sms limit reached - auto-reply withheld for conversation " + args.conversationId);
        return gate;
      }
    }
    await sendSms({ to: args.from, body });
    // Record the outbound reply on the conversation thread honestly.
    await q.appendMessage({
      businessId: args.businessId,
      conversationId: args.conversationId,
      direction: "outbound",
      body,
      status: "sent",
    });
    if (ctx) {
      await meterAction({ businessId: args.businessId, ctx, axis: "sms_per_month" });
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log("[textback] auto-reply failed: " + reason);
    // P4-I: record the failed delivery; the stored inbound message and any
    // classification survive (this fires after they are persisted).
    captureSystemError({
      source: "sms_delivery",
      businessId: args.businessId,
      message: "Auto-reply delivery failed for conversation " + args.conversationId + ": " + reason,
      detail: { conversationId: args.conversationId, phone: args.from, flow: "auto_reply" },
    });
  }
  return null;
}

async function tryReplyCommand(
  args: { businessId: string; businessName: string; conversationId: string; from: string },
  template: string,
): Promise<void> {
  // Opt-out rule applies to ALL outbound texts, including STOP confirmations
  // (Twilio/carriers suppress those; our store already holds the opt-out).
  if (await q.isSmsOptedOut(args.businessId, args.from)) return;
  if (!isSmsConfigured()) return;
  try {
    await sendSms({ to: args.from, body: renderSmsTemplate(template, args.businessName) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log("[textback] command reply failed: " + reason);
    // P4-I: STOP/START/HELP confirmations are compliance-relevant; a failed
    // one is recorded (the opt-out itself is already safely persisted).
    captureSystemError({
      source: "sms_delivery",
      businessId: args.businessId,
      message: "Command reply delivery failed for conversation " + args.conversationId + ": " + reason,
      detail: { conversationId: args.conversationId, phone: args.from, flow: "command_reply" },
    });
  }
}

