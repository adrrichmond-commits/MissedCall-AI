/**
 * The ONE SMS workflow engine (P4-S). Every templated outbound text —
 * missed-call recovery, owner alerts, confirmations, reminders, follow-ups,
 * emergency escalation, welcome, payment-failure notice — goes through
 * sendWorkflowSms, which enforces the safeguard chain in a fixed order:
 *
 *   1. workflow enabled?                        → 'disabled'
 *   2. provider configured?                     → 'not_configured' (honest
 *      pre-wire state; NEVER a fake send)
 *   3. recipient resolvable?                    → 'no_recipient'
 *   4. opt-out (STOP) — COMPLIANCE, applies to every recipient and is never
 *      bypassed, not even for emergencies → 'opted_out'
 *   5. invalid number (pre-send format check + registry; post-send provider
 *      codes auto-mark)                         → 'invalid_number'
 *   6. quiet hours (business-local, emergency bypasses) → 'quiet_hours'
 *   7. duplicate suppression (per customer+workflow cooldown) →
 *      'duplicate_suppressed'
 *   8. per-customer rolling-24h cap             → 'cap_reached'
 *   9. plan usage gate                          → 'limit_reached'
 *  10. render + real provider send. Outcome is recorded HONESTLY:
 *      'sent' rows carry the provider SID; failures are recorded as 'failed'
 *      with the real error and NEVER stamped sent.
 *
 * Emergency sends (emergency_escalation, or any caller passing emergency:
 * true) bypass quiet hours, cooldown, cap, and the usage gate's limit —
 * a flooded basement is never silenced by a counter — but NEVER bypass the
 * opt-out or invalid-number stops.
 *
 * SEAMS: the store (safeguard state), sender (provider), usage gate, and
 * error sink are injectable so scripts/test-sms-workflows.ts exercises the
 * FULL engine — including suppression, caps, loop handling, and honesty on
 * failure — with an in-memory store and zero network/DB.
 */
import "@tanstack/react-start/server-only";
import {
  capReached,
  cooldownActive,
  isWithinQuietHours,
  isValidTextableNumber,
  normalizeToE164,
  renderWorkflowTemplate,
  sanitizeSmsWorkflowsConfig,
  WORKFLOW_CATALOG,
  type SmsWorkflowsConfig,
  type WorkflowKey,
  type WorkflowRecipient,
  type WorkflowTemplateVars,
} from "~/lib/smsWorkflows";
import { captureSystemError } from "~/lib/server/errorSink";
import { isSmsConfigured, sendSms, SmsSendError } from "~/lib/server/sms";
import { anchorForBusiness, gateAction, loadPlanUsageContext, meterAction } from "~/lib/server/usageGate";
import type { GateDecision } from "~/lib/server/usage";
import * as q from "~/db/queries";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The slice of the business row the engine needs. */
export interface EngineBusiness {
  name: string;
  phone: string | null;
  timezone: string | null;
  settings: Record<string, unknown>;
  /** Subscription anchor for the plan usage gate. */
  trialEndsAt: Date | null;
  createdAt: Date;
}

export interface WorkflowEngineStore {
  getBusinessRow(businessId: string): Promise<EngineBusiness | null>;
  isSmsOptedOut(businessId: string, phone: string): Promise<boolean>;
  isInvalidNumber(businessId: string, phone: string): Promise<boolean>;
  markInvalidNumber(businessId: string, phone: string, reason: string): Promise<void>;
  lastWorkflowSentAt(businessId: string, phone: string, workflowKey: string): Promise<Date | null>;
  countWorkflowSentsForPhoneSince(businessId: string, phone: string, since: Date): Promise<number>;
  recordWorkflowSend(
    businessId: string,
    input: {
      workflowKey: string;
      phone: string;
      recipient: WorkflowRecipient;
      outcome: string;
      suppressReason?: string | null;
      body?: string | null;
      providerSid?: string | null;
      leadId?: string | null;
      appointmentId?: string | null;
      conversationId?: string | null;
      /** Time of the engine's decision — lets stores keep cooldown state and stamp rows accurately. */
      sentAt?: Date;
    },
  ): Promise<void>;
}

/** Production store: the real Neon-backed query layer. */
export const productionWorkflowStore: WorkflowEngineStore = {
  getBusinessRow: async (businessId) => {
    const b = await q.getBusiness(businessId).catch(() => null);
    if (!b) return null;
    return {
      name: b.name,
      phone: (b as unknown as { phone?: string | null }).phone ?? null,
      timezone: (b as unknown as { timezone?: string | null }).timezone ?? null,
      settings: (b as unknown as { settings?: Record<string, unknown> }).settings ?? {},
      trialEndsAt: (b as unknown as { trialEndsAt?: Date | null }).trialEndsAt ?? null,
      createdAt: (b as unknown as { createdAt?: Date }).createdAt ?? new Date(0),
    };
  },
  isSmsOptedOut: (businessId, phone) => q.isSmsOptedOut(businessId, phone).catch(() => false),
  isInvalidNumber: (businessId, phone) => q.isInvalidNumber(businessId, phone).catch(() => false),
  markInvalidNumber: (businessId, phone, reason) =>
    q.markInvalidNumber(businessId, phone, reason).catch(() => undefined),
  lastWorkflowSentAt: (businessId, phone, workflowKey) =>
    q.lastWorkflowSentAt(businessId, phone, workflowKey).catch(() => null),
  countWorkflowSentsForPhoneSince: (businessId, phone, since) =>
    q.countWorkflowSentsForPhoneSince(businessId, phone, since).catch(() => 0),
  recordWorkflowSend: (businessId, input) =>
    q.recordWorkflowSend(businessId, input).catch(() => undefined),
};

export interface WorkflowSender {
  send(args: { to: string; body: string }): Promise<{ sid: string }>;
}

/** Production sender: the real Twilio REST path with P4-I retries. */
export const productionSender: WorkflowSender = {
  send: (args) => sendSms(args),
};

export interface WorkflowUsageGate {
  /** Plan-limit check; null decision = allowed. */
  gate(businessId: string, business: EngineBusiness, emergency: boolean): Promise<GateDecision | null>;
  /** Meter one successful send. */
  meter(businessId: string, business: EngineBusiness): Promise<void>;
}

/** Production usage gate: the same plan metering the text-back path uses. */
export const productionUsageGate: WorkflowUsageGate = {
  gate: async (businessId, business, emergency) => {
    const ctx = await loadPlanUsageContext(businessId, anchorForBusiness(business));
    return gateAction({ ctx, axis: "sms_per_month", emergency });
  },
  meter: async (businessId, business) => {
    const ctx = await loadPlanUsageContext(businessId, anchorForBusiness(business));
    await meterAction({ businessId, ctx, axis: "sms_per_month" });
  },
};

export interface WorkflowEngineIo {
  store: WorkflowEngineStore;
  sender: WorkflowSender;
  usage: WorkflowUsageGate;
  onSendError(args: { businessId: string; workflowKey: string; phone: string; reason: string }): void;
}

/** Production I/O bundle; tests substitute in-memory fakes. */
export const productionIo: WorkflowEngineIo = {
  store: productionWorkflowStore,
  sender: productionSender,
  usage: productionUsageGate,
  onSendError: (args) => {
    captureSystemError({
      source: "sms_delivery",
      businessId: args.businessId,
      message: "Workflow " + args.workflowKey + " delivery failed for " + args.phone + ": " + args.reason,
      detail: { workflowKey: args.workflowKey, phone: args.phone, flow: "workflow", outcome: "failed" },
    });
  },
};

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type WorkflowSendOutcome =
  | "sent"
  | "failed"
  | "disabled"
  | "not_configured"
  | "opted_out"
  | "invalid_number"
  | "quiet_hours"
  | "duplicate_suppressed"
  | "cap_reached"
  | "limit_reached"
  | "no_recipient";

export interface WorkflowSendResult {
  outcome: WorkflowSendOutcome;
  /** Machine-readable why (suppress reason, provider error, plan message). */
  reason: string | null;
  /** Provider SID — present ONLY when outcome === 'sent'. */
  sid: string | null;
  /** The plan-named upgrade decision when outcome === 'limit_reached'. */
  gate: GateDecision | null;
}

function result(outcome: WorkflowSendOutcome, reason: string | null, sid: string | null = null, gate: GateDecision | null = null): WorkflowSendResult {
  return { outcome, reason, sid, gate };
}

/** Twilio error codes that mean "this number can never receive texts" — the
 *  engine auto-marks the number invalid instead of retrying forever. */
const INVALID_NUMBER_TWILIO_CODES = new Set([21211, 21214, 21601, 21602, 21604, 21614]);

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export interface SendWorkflowSmsArgs {
  businessId: string;
  workflowKey: WorkflowKey;
  /** Template variables ({businessName} etc). businessName falls back to the business row's name. */
  vars?: WorkflowTemplateVars;
  /** Explicit customer phone (E.164 or normalizeable). Required for customer workflows. */
  to?: string | null;
  /** Owner sends go to safeguards.ownerSmsNumber ?? business.phone. */
  recipient?: WorkflowRecipient;
  /** Emergency context: bypasses quiet hours/cooldown/cap/limit, NEVER opt-out/invalid. */
  emergency?: boolean;
  leadId?: string | null;
  appointmentId?: string | null;
  conversationId?: string | null;
  now?: Date;
  io?: WorkflowEngineIo;
  /** Test seam: force the provider-configured state. */
  smsConfigured?: boolean;
}

/**
 * Run one workflow send through the full safeguard chain. Never throws —
 * every failure mode becomes an honest outcome (and a recorded audit row
 * where recording carries information: everything except the expected config
 * states 'disabled' / 'not_configured' / 'no_recipient').
 */
export async function sendWorkflowSms(args: SendWorkflowSmsArgs): Promise<WorkflowSendResult> {
  const io = args.io ?? productionIo;
  const now = args.now ?? new Date();
  const meta = WORKFLOW_CATALOG[args.workflowKey];
  const recipient: WorkflowRecipient = args.recipient ?? meta.recipient;
  const emergency = args.emergency === true;

  const business = await io.store.getBusinessRow(args.businessId);
  if (!business) return result("no_recipient", "Business not found");

  const config: SmsWorkflowsConfig = sanitizeSmsWorkflowsConfig(business.settings?.smsWorkflows);
  const wf = config.workflows[args.workflowKey];

  // 1. Enabled?
  if (!wf || !wf.enabled) {
    return result("disabled", "Workflow " + args.workflowKey + " is disabled for this business");
  }

  // 2. Provider configured? Honest pre-wire state — never a fake send.
  const providerConfigured = args.smsConfigured ?? isSmsConfigured();
  if (!providerConfigured) {
    return result("not_configured", "Twilio not configured");
  }

  // 3. Recipient. A number that is present but unparseable keeps its raw form
  // so the invalid-number stop below marks it in the registry — reporting
  // "no_recipient" for a garbage number would hide a data problem.
  const rawPhone =
    recipient === "customer" ? (args.to ?? null) : (config.safeguards.ownerSmsNumber ?? business.phone);
  if (!rawPhone || rawPhone.trim().length === 0) {
    return result("no_recipient", recipient === "owner" ? "No owner SMS number on file" : "No textable customer number");
  }
  const phone = normalizeToE164(rawPhone) ?? rawPhone;

  const audit = (outcome: string, suppressReason?: string | null, body?: string | null, sid?: string | null) =>
    io.store
      .recordWorkflowSend(args.businessId, {
        workflowKey: args.workflowKey,
        phone,
        recipient,
        outcome,
        suppressReason: suppressReason ?? null,
        body: body ?? null,
        providerSid: sid ?? null,
        leadId: args.leadId ?? null,
        appointmentId: args.appointmentId ?? null,
        conversationId: args.conversationId ?? null,
        sentAt: now,
      })
      .catch(() => undefined);

  // 4. Opt-out — COMPLIANCE. Applies to every recipient; never bypassed.
  // Audited: a suppressed compliance stop is exactly what the audit trail
  // exists to show.
  if (await io.store.isSmsOptedOut(args.businessId, phone)) {
    await audit("opted_out", "stop");
    return result("opted_out", "Customer has opted out (STOP) - never texted");
  }

  // 5. Invalid number — stop texting, surface honestly. The format check
  // runs on the NORMALIZED number (garbage never reaches the provider) and
  // the registry check stops previously-flagged numbers for good.
  if (!isValidTextableNumber(phone)) {
    await io.store.markInvalidNumber(args.businessId, phone, "Invalid phone number (not textable)");
    await audit("invalid_number", "invalid_format");
    return result("invalid_number", "Number is not textable (invalid format)");
  }
  if (await io.store.isInvalidNumber(args.businessId, phone)) {
    await audit("invalid_number", "previously_marked");
    return result("invalid_number", "Number previously marked invalid - texting stopped");
  }

  // 6. Quiet hours (business-local). Emergency overrides.
  if (!emergency && config.safeguards.quietHoursEnabled) {
    if (isWithinQuietHours(now, business.timezone, config.safeguards.quietHoursStart, config.safeguards.quietHoursEnd)) {
      await audit("quiet_hours", "quiet_hours");
      return result("quiet_hours", "Suppressed during quiet hours (" + config.safeguards.quietHoursStart + ":00–" + config.safeguards.quietHoursEnd + ":00 local)");
    }
  }

  // 7. Duplicate suppression — same customer+workflow cooldown. Emergency bypasses.
  if (!emergency && wf.cooldownMinutes > 0) {
    const last = await io.store.lastWorkflowSentAt(args.businessId, phone, args.workflowKey);
    if (cooldownActive(last, now, wf.cooldownMinutes)) {
      await audit("duplicate_suppressed", "cooldown_" + wf.cooldownMinutes + "m");
      return result("duplicate_suppressed", "Already sent this workflow to this customer within the " + wf.cooldownMinutes + " minute cooldown");
    }
  }

  // 8. Per-customer rolling-24h cap. Emergency bypasses.
  if (!emergency && config.safeguards.maxPerCustomerPerDay > 0) {
    const since = new Date(now.getTime() - 24 * 60 * 60_000);
    const sentCount = await io.store.countWorkflowSentsForPhoneSince(args.businessId, phone, since);
    if (capReached(sentCount, config.safeguards.maxPerCustomerPerDay)) {
      await audit("cap_reached", String(config.safeguards.maxPerCustomerPerDay) + "_per_24h");
      return result("cap_reached", "Per-customer messaging cap reached (" + config.safeguards.maxPerCustomerPerDay + " texts per 24h)");
    }
  }

  // 9. Plan usage gate (fail open on gate errors — same safety-first order as
  // the text-back path: a metering outage must not drop a safety text).
  // Emergencies are NEVER silenced by a plan limit: the engine bypasses a
  // negative gate decision outright (defense in depth on top of the
  // production gate's own emergency handling).
  let gateDecision: GateDecision | null = null;
  try {
    gateDecision = await io.usage.gate(args.businessId, business, emergency);
  } catch (gateErr) {
    console.log("[workflow] usage gate unavailable - allowing send: " + String(gateErr));
  }
  if (gateDecision && !gateDecision.allowed && !emergency) {
    await audit("limit_reached", gateDecision.message);
    return result("limit_reached", gateDecision.message, null, gateDecision);
  }

  // 10. Render + real send.
  const body = renderWorkflowTemplate(wf.template, {
    businessName: business.name,
    ...args.vars,
  });
  try {
    const sent = await io.sender.send({ to: phone, body });
    await audit("sent", null, body, sent.sid);
    try {
      await io.usage.meter(args.businessId, business);
    } catch (meterErr) {
      console.log("[workflow] meter failed (send unaffected): " + String(meterErr));
    }
    return result("sent", null, sent.sid);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const twilioCode = err instanceof SmsSendError ? err.twilioCode : null;
    if (twilioCode !== null && INVALID_NUMBER_TWILIO_CODES.has(twilioCode)) {
      await io.store.markInvalidNumber(args.businessId, phone, "Provider rejected the number (code " + twilioCode + ")");
      await audit("invalid_number", "provider_code_" + twilioCode);
      return result("invalid_number", "Provider rejected the number (code " + twilioCode + ") - marked invalid, texting stopped");
    }
    await audit("failed", null, body);
    io.onSendError({ businessId: args.businessId, workflowKey: args.workflowKey, phone, reason });
    return result("failed", reason);
  }
}
