/**
 * Missed-call text-back flow (Phase 2 build #4 pre-wire).
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
 * Server-only: imports the query layer and the env-gated providers.
 */
import { normalizePhone, parseSmsCommand } from "~/lib/smsCommands";
import { SMS_TEMPLATES, renderSmsTemplate } from "~/lib/smsTemplates";
import * as q from "~/db/queries";
import { notificationEmailStore, queueNotificationEmail } from "~/lib/server/emailDelivery";
import type { CreateLeadInput } from "~/db/queries/leads";
import type { Lead } from "~/db/schema";
import { isLlmConfigured, llmComplete, readLlmConfig } from "./llm";
import { isSmsConfigured, sendSms } from "./sms";
import type { MessageClassification } from "~/db/schema";

/** What actually happened with the text-back for one captured lead. */
export type TextBackOutcome = "sent" | "opted_out" | "not_configured" | "failed";

export interface TextBackResult {
  outcome: TextBackOutcome;
  /** Twilio message SID when outcome === 'sent'. */
  sid: string | null;
  /** Machine-readable reason for non-sent outcomes. */
  reason: string | null;
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

  // 2. In-app new_lead notification (always, matching build #3 semantics).
  let textBack: TextBackResult = { outcome: "not_configured", sid: null, reason: "Twilio not configured" };
  try {
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
    // Fire-and-forget email for the owner (build #6) — no-op unless the
    // email provider is configured; never blocks or fails the capture.
    queueNotificationEmail({
      businessId,
      notificationId: notification.id,
      type: "new_lead",
      payload,
      store: notificationEmailStore,
    });
  } catch {
    // Notification failure must not fail the capture.
  }

  // 3. Text-back attempt — env-gated, opt-out-checked, failures honest.
  textBack = await sendTextBack(businessId, businessName, lead);
  return { lead, textBack };
}

/**
 * Send the text-back for an already-created missed_call lead. Honesty rules:
 *   - opted-out phones NEVER receive anything;
 *   - 'not_configured' and 'opted_out' are silent skips (expected states);
 *   - only 'sent' may ever be reported as a send.
 */
export async function sendTextBack(
  businessId: string,
  businessName: string,
  lead: Lead,
): Promise<TextBackResult> {
  if (!isSmsConfigured()) {
    return { outcome: "not_configured", sid: null, reason: "Twilio not configured" };
  }
  const phone = normalizeForSend(lead.contactPhone);
  if (!phone) {
    return { outcome: "failed", sid: null, reason: "Lead phone is not a textable number" };
  }
  if (await q.isSmsOptedOut(businessId, phone)) {
    return { outcome: "opted_out", sid: null, reason: "Customer has opted out (STOP) - never texted" };
  }
  const body = renderSmsTemplate(SMS_TEMPLATES.textBack, businessName);
  try {
    const result = await sendSms({ to: phone, body });
    return { outcome: "sent", sid: result.sid, reason: null };
  } catch (err) {
    // Real failure (network, Twilio rejection). Lead survives; state is honest.
    const reason = err instanceof Error ? err.message : String(err);
    console.log("[textback] send failed for lead " + lead.id + ": " + reason);
    return { outcome: "failed", sid: null, reason };
  }
}

/**
 * Handle an inbound SMS for a business: STOP/START/HELP handling with
 * opt-out persistence, then LLM classification when configured. The message
 * is ALWAYS stored first — honest 'unclassified' when no LLM exists.
 */
export async function handleInboundSms(args: {
  businessId: string;
  businessName: string;
  conversationId: string;
  body: string;
  from: string;
  externalId: string | null;
}): Promise<{ command: "stop" | "start" | "help" | null; status: "unclassified" | "delivered" }> {
  // 1. Store the inbound message FIRST (data survives every later failure).
  const message = await q.appendMessage({
    businessId: args.businessId,
    conversationId: args.conversationId,
    direction: "inbound",
    body: args.body,
    status: "unclassified",
    externalId: args.externalId,
  });

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

  // 3. LLM classification — only when configured, never invented.
  if (!command && isLlmConfigured()) {
    const classification = await classifyInboundMessage(args.body);
    if (classification) {
      await q.setMessageClassification(args.businessId, message.id, classification);
      status = "delivered";
    }
  }
  return { command, status };
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
    console.log("[textback] command reply failed: " + String(err));
  }
}

async function classifyInboundMessage(body: string): Promise<MessageClassification | null> {
  if (!isLlmConfigured()) return null;
  const system = [
    "You are an SMS intake classifier for a plumbing company.",
    "Extract structured data from one customer text message.",
    'Return STRICT JSON only: {"serviceNeed": string|null, "urgency": "emergency"|"same_day"|"within_week"|"flexible"|null, "priority": "emergency"|"high"|"normal"|null, "contactName": string|null, "contactEmail": string|null, "serviceAddress": string|null, "safetyConcern": boolean|null, "notes": string|null}.',
    "urgency/priority: emergency = active flooding, burst pipe, sewer backup, gas smell, cannot shut off water; high = water heater failure, significant leak, no working toilet, major blockage; normal = everything else.",
    "safetyConcern = true only for gas smell, electrical hazard, or uncontrolled water.",
    "Omit nothing the message supports; use null for anything not stated. Never invent values.",
  ].join(" ");
  try {
    const raw = await llmComplete(system, body, { maxTokens: 300, temperature: 0, timeoutMs: 15_000 });
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    const model = readLlmConfig()?.model ?? "unknown";
    return {
      serviceNeed: str(parsed.serviceNeed),
      urgency: pickUrgency(parsed.urgency),
      priority: pickPriority(parsed.priority),
      contactName: str(parsed.contactName),
      contactEmail: str(parsed.contactEmail),
      serviceAddress: str(parsed.serviceAddress),
      safetyConcern: typeof parsed.safetyConcern === "boolean" ? parsed.safetyConcern : null,
      notes: str(parsed.notes),
      model,
    };
  } catch (err) {
    console.log("[textback] classification failed (message stays unclassified): " + String(err));
    return null;
  }
}

function pickUrgency(v: unknown): "emergency" | "same_day" | "within_week" | "flexible" | null {
  return v === "emergency" || v === "same_day" || v === "within_week" || v === "flexible" ? v : null;
}
function pickPriority(v: unknown): "emergency" | "high" | "normal" | null {
  return v === "emergency" || v === "high" || v === "normal" ? v : null;
}

/** Share one normalize implementation; fall back to the stored string. */
function normalizeForSend(phone: string): string {
  return normalizePhone(phone) ?? phone;
}
