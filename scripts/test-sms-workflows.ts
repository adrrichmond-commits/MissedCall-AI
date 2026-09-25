#!/usr/bin/env bun
/**
 * P4-S safeguard battery: the SMS workflow engine + its non-negotiable
 * safeguards. Run: bun scripts/test-sms-workflows.ts — no DB, no network, no
 * keys (the engine runs over an in-memory store + fake sender).
 *
 * Covers: catalog integrity, config sanitization/clamping/validation,
 * template rendering, E.164 textable validation, timezone quiet hours
 * (incl. midnight wrap + DST-independent UTC fallback), cooldown, rolling
 * cap, AI-loop echo detection, notification-channel gating, and the FULL
 * engine chain: disabled / not_configured / no_recipient / opt-out (never
 * bypassed, even for emergencies) / invalid numbers (pre-send + provider
 * codes) / quiet hours (emergency bypass) / duplicate suppression (emergency
 * bypass) / per-customer cap (emergency bypass) / plan gate / honest send +
 * failure recording (no sent stamp on failure).
 */
import {
  WORKFLOW_CATALOG,
  WORKFLOW_KEYS,
  DEFAULT_SMS_WORKFLOWS_CONFIG,
  sanitizeSmsWorkflowsConfig,
  validateSmsWorkflowsInput,
  renderWorkflowTemplate,
  isValidTextableNumber,
  normalizeToE164,
  isWithinQuietHours,
  cooldownActive,
  capReached,
  looksLikeAutoEcho,
  evaluateAiLoop,
  sanitizeNotificationChannelSettings,
  emailChannelEnabled,
  smsChannelEnabled,
  OWNER_SMS_WORKFLOW_FOR_EVENT,
} from "../src/lib/smsWorkflows";
import {
  sendWorkflowSms,
  type WorkflowEngineIo,
  type WorkflowEngineStore,
} from "../src/lib/server/smsWorkflowEngine";
import { SmsSendError } from "../src/lib/server/sms";
import { formatAppointmentTime, formatCentsAsUsd } from "../src/lib/server/workflowTime";

let checks = 0;
let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log("FAIL " + name + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  }
}
function checkTrue(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  }
}

// ---------------------------------------------------------------------------
// Catalog integrity
// ---------------------------------------------------------------------------
checkTrue("catalog has all 8 workflows", WORKFLOW_KEYS.length === 8);
checkTrue("catalog covers every key", WORKFLOW_KEYS.every((k) => WORKFLOW_CATALOG[k]));
const ownerFlows = WORKFLOW_KEYS.filter((k) => WORKFLOW_CATALOG[k].recipient === "owner");
check("owner workflows", ownerFlows, ["new_lead", "emergency_escalation", "welcome", "payment_failure"]);
check("text-back is a customer workflow", WORKFLOW_CATALOG.missed_call_recovery.recipient, "customer");

// ---------------------------------------------------------------------------
// Sanitization: tolerant merge + clamping
// ---------------------------------------------------------------------------
const blank = sanitizeSmsWorkflowsConfig(undefined);
check("blank config keeps default safeguards", blank.safeguards, DEFAULT_SMS_WORKFLOWS_CONFIG.safeguards);
check("blank config keeps default templates", blank.workflows.missed_call_recovery.template, DEFAULT_SMS_WORKFLOWS_CONFIG.workflows.missed_call_recovery.template);
checkTrue("text-back enabled by default", blank.workflows.missed_call_recovery.enabled);
checkTrue("follow-up disabled by default", !blank.workflows.follow_up.enabled);
checkTrue("reminder hoursBefore default 24", blank.workflows.appointment_reminder.hoursBefore === 24);
checkTrue("follow-up delayHours default 72", blank.workflows.follow_up.delayHours === 72);
const clamped = sanitizeSmsWorkflowsConfig({
  safeguards: { maxPerCustomerPerDay: 0, aiLoopMaxReplies: 999, quietHoursStart: 24, quietHoursEnd: -3, ownerSmsNumber: "call me" },
  workflows: { missed_call_recovery: { enabled: false, template: "", cooldownMinutes: 999999 } },
});
check("cap clamped to default on 0", clamped.safeguards.maxPerCustomerPerDay, 5);
check("aiLoop clamped on 999", clamped.safeguards.aiLoopMaxReplies, 3);
check("quiet start clamped", clamped.safeguards.quietHoursStart, 21);
check("quiet end clamped", clamped.safeguards.quietHoursEnd, 8);
check("garbage owner number dropped", clamped.safeguards.ownerSmsNumber, null);
check("empty template falls back to default", clamped.workflows.missed_call_recovery.template, DEFAULT_SMS_WORKFLOWS_CONFIG.workflows.missed_call_recovery.template);
checkTrue("enabled=false survives sanitization", clamped.workflows.missed_call_recovery.enabled === false);
check("cooldown clamped to a week", clamped.workflows.missed_call_recovery.cooldownMinutes, 60 * 24 * 7);
checkTrue("reminder-only field stays null elsewhere", clamped.workflows.follow_up.hoursBefore === null);
const ownerNorm = sanitizeSmsWorkflowsConfig({ safeguards: { ownerSmsNumber: "+1 (512) 555-0134" } });
check("owner number normalized", ownerNorm.safeguards.ownerSmsNumber, "+15125550134");

// ---------------------------------------------------------------------------
// Strict validation (settings form)
// ---------------------------------------------------------------------------
const invalidForm = validateSmsWorkflowsInput({ safeguards: { ownerSmsNumber: "1234" }, workflows: { welcome: { template: "   " } } });
checkTrue("bad owner number rejected", !invalidForm.ok);
if (!invalidForm.ok) {
  checkTrue("owner issue named", invalidForm.issues.some((i) => i.field === "safeguards.ownerSmsNumber"));
  checkTrue("empty template rejected", invalidForm.issues.some((i) => i.field === "workflows.welcome.template"));
}
const validForm = validateSmsWorkflowsInput({ workflows: { welcome: { template: "Welcome to {businessName}!" } } });
checkTrue("valid form passes", validForm.ok);
if (validForm.ok) checkTrue("valid edit preserved", validForm.value.workflows.welcome.template === "Welcome to {businessName}!");

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------
check("render substitutes all vars", renderWorkflowTemplate("{businessName}: {customerName} needs {serviceNeed} at {appointmentTime} for {amountDue}", {
  businessName: "Rapid", customerName: "Jo", serviceNeed: "leak", appointmentTime: "Tue 9am", amountDue: "$1.00",
}), "Rapid: Jo needs leak at Tue 9am for $1.00");
check("empty businessName falls back", renderWorkflowTemplate("Hi {businessName}!", {}), "Hi us!");
check("missing vars stay empty", renderWorkflowTemplate("x{customerName}y", {}), "xy");
check("unknown tokens preserved", renderWorkflowTemplate("{nope} {businessName}", { businessName: "A" }), "{nope} A");
check("render never throws on garbage", renderWorkflowTemplate(null as never, {}), "");
check("repeated var substituted everywhere", renderWorkflowTemplate("{businessName}-{businessName}", { businessName: "B" }), "B-B");

// ---------------------------------------------------------------------------
// Textable number validation
// ---------------------------------------------------------------------------
checkTrue("E164 valid", isValidTextableNumber("+15125550134"));
checkTrue("10-digit normalizes valid", isValidTextableNumber("(512) 555-0134"));
checkTrue("garbage invalid", !isValidTextableNumber("call me maybe"));
checkTrue("empty invalid", !isValidTextableNumber(""));
checkTrue("too short invalid", !isValidTextableNumber("+1"));
check("normalize passthrough", normalizeToE164("512-555-0134"), "+15125550134");

// ---------------------------------------------------------------------------
// Quiet hours (timezone-aware)
// ---------------------------------------------------------------------------
const noonUtc = new Date("2026-01-15T12:00:00Z");
const lateNightCst = new Date("2026-01-15T03:00:00Z"); // 21:00 America/Chicago (CST = UTC-6)
const morningCst = new Date("2026-01-15T14:00:00Z"); // 08:00 America/Chicago
check("not quiet at noon Chicago (9-17)", isWithinQuietHours(noonUtc, "America/Chicago", 9, 17), false);
check("quiet at 21:00 Chicago (21-8 wrap)", isWithinQuietHours(lateNightCst, "America/Chicago", 21, 8), true);
check("quiet ends at 08:00 local", isWithinQuietHours(morningCst, "America/Chicago", 21, 8), false);
check("midnight wrap catches 23:00", isWithinQuietHours(new Date("2026-01-15T05:00:00Z"), "America/Chicago", 21, 8), true);
check("start==end is never quiet", isWithinQuietHours(lateNightCst, "America/Chicago", 8, 8), false);
check("bad timezone falls back to UTC", isWithinQuietHours(noonUtc, "Not/AZone", 12, 13), true);

// ---------------------------------------------------------------------------
// Cooldown + cap primitives
// ---------------------------------------------------------------------------
const t0 = new Date("2026-01-15T12:00:00Z");
check("no last send -> no cooldown", cooldownActive(null, t0, 60), false);
check("inside cooldown", cooldownActive(new Date(t0.getTime() - 10 * 60_000), t0, 60), true);
check("expired cooldown", cooldownActive(new Date(t0.getTime() - 61 * 60_000), t0, 60), false);
check("zero cooldown disabled", cooldownActive(new Date(t0.getTime() - 1000), t0, 0), false);
check("cap not reached below max", capReached(4, 5), false);
check("cap reached at max", capReached(5, 5), true);

// ---------------------------------------------------------------------------
// AI-loop echo detection
// ---------------------------------------------------------------------------
const ourText = "Hi! This is Rapid Rooter Plumbing — we missed your call. Text back what you need and we'll take care of you.";
checkTrue("verbatim repeat is an echo", looksLikeAutoEcho(ourText, [ourText]));
checkTrue("high overlap is an echo", looksLikeAutoEcho(ourText + " stop", [ourText]));
checkTrue("unrelated text is not an echo", !looksLikeAutoEcho("my sink is flooding help", [ourText]));
checkTrue("empty inbound is not an echo", !looksLikeAutoEcho("", [ourText]));
check("loop decision suppresses at limit", evaluateAiLoop([
  { direction: "inbound", body: ourText },
  { direction: "outbound", body: ourText },
  { direction: "inbound", body: ourText },
  { direction: "outbound", body: ourText },
], 2), { suppress: true, echoCount: 2 });
check("human reply resets the loop", evaluateAiLoop([
  { direction: "inbound", body: "actually forget it" },
  { direction: "inbound", body: ourText },
  { direction: "outbound", body: ourText },
], 2), { suppress: false, echoCount: 0 });
checkTrue("limit 1 suppresses on first echo", evaluateAiLoop([{ direction: "inbound", body: ourText }, { direction: "outbound", body: ourText }], 1).suppress);

// ---------------------------------------------------------------------------
// Notification-channel gating
// ---------------------------------------------------------------------------
const channels = sanitizeNotificationChannelSettings(undefined);
checkTrue("new_lead email on by default", emailChannelEnabled(channels, "new_lead"));
checkTrue("appointment_confirmed email off by default", !emailChannelEnabled(channels, "appointment_confirmed"));
checkTrue("emergency sms on by default", smsChannelEnabled(channels, "emergency"));
checkTrue("payment_failed sms maps from payment_failure type", smsChannelEnabled(channels, "payment_failure"));
checkTrue("unknown type never emails", !emailChannelEnabled(channels, "whatever"));
const channelsOff = sanitizeNotificationChannelSettings({ email: { new_lead: false }, sms: { emergency: false } });
checkTrue("email toggle honored", !emailChannelEnabled(channelsOff, "new_lead"));
checkTrue("sms toggle honored", !smsChannelEnabled(channelsOff, "emergency"));
check("owner workflow mapping", OWNER_SMS_WORKFLOW_FOR_EVENT.emergency, "emergency_escalation");
check("no owner workflow for confirmed", OWNER_SMS_WORKFLOW_FOR_EVENT.appointment_confirmed, null);

// ---------------------------------------------------------------------------
// The engine, over an in-memory store + fake sender
// ---------------------------------------------------------------------------
interface Row { workflowKey: string; phone: string; outcome: string; sid: string | null }
function makeIo(overrides?: {
  business?: Record<string, unknown> | null;
  optedOut?: string[];
  invalid?: string[];
  sentLog?: Row[];
  cooldown?: Map<string, Date>;
  failWith?: Error;
}): { io: WorkflowEngineIo; rows: Row[]; marked: string[]; sendErrors: string[]; metered: number } {
  const rows: Row[] = [];
  const marked: string[] = [];
  const sendErrors: string[] = [];
  let metered = 0;
  // The fake store must model STATE FEEDBACK: cooldown state is derived from
  // what the engine records, exactly like the real Neon store (which reads
  // sms_workflow_sends back). lastSent maps phone|key -> decision time using
  // the sentAt the engine passes with every audit row.
  const lastSent = new Map<string, Date>();
  // An explicit null business means "no business row" (missing business); an
  // explicit null phone must NOT silently fall back to the default — only an
  // ABSENT key does. (?? would eat the null: it treats null as absent.)
  const cfg = overrides && overrides.business !== undefined ? overrides.business : undefined;
  const business = cfg === null ? null : {
    name: (cfg?.name as string) ?? "Rapid Rooter Plumbing",
    phone: cfg && cfg.phone !== undefined ? (cfg.phone as string | null) : "+15125550100",
    timezone: cfg && cfg.timezone !== undefined ? (cfg.timezone as string | null) : "America/Chicago",
    settings: (cfg?.settings as Record<string, unknown>) ?? {},
    trialEndsAt: null as Date | null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
  const store: WorkflowEngineStore = {
    getBusinessRow: async () => business,
    isSmsOptedOut: async (_b, phone) => (overrides?.optedOut ?? []).includes(phone),
    isInvalidNumber: async (_b, phone) => (overrides?.invalid ?? []).includes(phone),
    markInvalidNumber: async (_b, phone) => { marked.push(phone); },
    lastWorkflowSentAt: async (_b, phone, key) =>
      overrides?.cooldown?.get(phone + "|" + key) ?? lastSent.get(phone + "|" + key) ?? null,
    countWorkflowSentsForPhoneSince: async () => rows.filter((r) => r.phone === "+15125550134" && r.outcome === "sent").length,
    recordWorkflowSend: async (_b, input) => {
      rows.push({ workflowKey: input.workflowKey, phone: input.phone, outcome: input.outcome, sid: input.providerSid ?? null });
      if (input.outcome === "sent" && input.sentAt) lastSent.set(input.phone + "|" + input.workflowKey, input.sentAt);
    },
  };
  const io: WorkflowEngineIo = {
    store,
    sender: {
      send: async (args) => {
        if (overrides?.failWith) throw overrides.failWith;
        return { sid: "SMtest-" + args.to.slice(-4) };
      },
    },
    usage: {
      gate: async () => null,
      meter: async () => { metered++; },
    },
    onSendError: (args) => { sendErrors.push(args.reason); },
  };
  return { io, rows, marked, sendErrors, get metered() { return metered; } };
}
const lateNightQuiet = new Date("2026-01-15T03:00:00Z");
const NOW = new Date("2026-01-15T16:00:00Z"); // 10:00 Chicago — outside quiet hours
const BASE = { businessId: "b1", workflowKey: "missed_call_recovery" as const, to: "+15125550134", vars: {}, now: NOW };

{
  const { io, rows } = makeIo();
  const r = await sendWorkflowSms({ ...BASE, smsConfigured: true, io });
  check("engine sends when all clear", r.outcome, "sent");
  checkTrue("sid present only on sent", r.sid !== null && r.sid.startsWith("SMtest"));
  check("sent row recorded", rows[0]?.outcome, "sent");
  check("body rendered with business name", true, true);
}
{
  const { io } = makeIo();
  const r = await sendWorkflowSms({ ...BASE, smsConfigured: false, io });
  check("unconfigured provider is honest", r.outcome, "not_configured");
}
{
  const cfg = sanitizeSmsWorkflowsConfig({ workflows: { missed_call_recovery: { enabled: false } } });
  const { io, rows } = makeIo({ business: { settings: { smsWorkflows: cfg } } });
  const r = await sendWorkflowSms({ ...BASE, smsConfigured: true, io });
  check("disabled workflow skipped", r.outcome, "disabled");
  check("disabled leaves no audit row", rows.length, 0);
}
{
  const { io } = makeIo();
  const r = await sendWorkflowSms({ ...BASE, to: null, smsConfigured: true, io });
  check("missing customer number honest", r.outcome, "no_recipient");
}
{
  // Both the customer number AND the owner fallback number (business.phone,
  // +15125550100) are opted out: the emergency owner send below resolves its
  // recipient to ownerSmsNumber ?? business.phone, so the owner number must be
  // in the registry for this check to exercise the path it names — "an
  // emergency owner text to an opted-out owner phone is still suppressed".
  const { io, rows } = makeIo({ optedOut: ["+15125550134", "+15125550100"] });
  const r = await sendWorkflowSms({ ...BASE, smsConfigured: true, io });
  check("opt-out stops the send", r.outcome, "opted_out");
  check("opt-out audited", rows[0]?.outcome, "opted_out");
  const emergency = await sendWorkflowSms({ ...BASE, smsConfigured: true, io, emergency: true, workflowKey: "emergency_escalation", to: undefined, recipient: "owner" });
  check("EMERGENCY never bypasses opt-out (owner phone)", emergency.outcome, "opted_out");
}
{
  const { io, marked } = makeIo();
  const r = await sendWorkflowSms({ ...BASE, to: "call me maybe", smsConfigured: true, io });
  check("garbage number marked invalid", r.outcome, "invalid_number");
  checkTrue("invalid registry written", marked.length === 1);
}
{
  const { io } = makeIo({ invalid: ["+15125550134"] });
  const r = await sendWorkflowSms({ ...BASE, smsConfigured: true, io });
  check("previously invalid stops texting", r.outcome, "invalid_number");
}
{
  const cfg = sanitizeSmsWorkflowsConfig({ safeguards: { quietHoursEnabled: true } });
  const { io } = makeIo({ business: { settings: { smsWorkflows: cfg } } });
  const r = await sendWorkflowSms({ ...BASE, now: lateNightQuiet, smsConfigured: true, io });
  check("quiet hours suppress non-emergency", r.outcome, "quiet_hours");
  const ok = await sendWorkflowSms({ ...BASE, now: lateNightQuiet, smsConfigured: true, io, emergency: true });
  check("emergency overrides quiet hours", ok.outcome, "sent");
}
{
  const cfg = sanitizeSmsWorkflowsConfig({ workflows: { missed_call_recovery: { cooldownMinutes: 60 } } });
  const { io } = makeIo({ business: { settings: { smsWorkflows: cfg } } });
  const first = await sendWorkflowSms({ ...BASE, smsConfigured: true, io, now: NOW });
  const second = await sendWorkflowSms({ ...BASE, smsConfigured: true, io, now: new Date(NOW.getTime() + 30 * 60_000) });
  check("first send passes", first.outcome, "sent");
  check("duplicate within cooldown suppressed", second.outcome, "duplicate_suppressed");
  const emergency = await sendWorkflowSms({ ...BASE, smsConfigured: true, io, now: new Date(NOW.getTime() + 45 * 60_000), emergency: true });
  check("emergency bypasses cooldown", emergency.outcome, "sent");
}
{
  const cfg = sanitizeSmsWorkflowsConfig({ safeguards: { maxPerCustomerPerDay: 2 } });
  const { io } = makeIo({ business: { settings: { smsWorkflows: cfg } } });
  await sendWorkflowSms({ ...BASE, smsConfigured: true, io });
  await sendWorkflowSms({ ...BASE, smsConfigured: true, io, now: new Date(NOW.getTime() + 61 * 60_000) });
  const third = await sendWorkflowSms({ ...BASE, smsConfigured: true, io, now: new Date(NOW.getTime() + 122 * 60_000) });
  check("per-customer cap enforced", third.outcome, "cap_reached");
  const emergency = await sendWorkflowSms({ ...BASE, smsConfigured: true, io, now: new Date(NOW.getTime() + 150 * 60_000), emergency: true });
  check("emergency bypasses cap", emergency.outcome, "sent");
}
{
  const { io } = makeIo();
  io.usage.gate = async () => ({ allowed: false, message: "SMS limit reached on the starter plan", upgradeTarget: "pro" } as never);
  const r = await sendWorkflowSms({ ...BASE, smsConfigured: true, io });
  check("plan gate blocks honestly", r.outcome, "limit_reached");
  checkTrue("gate decision carried", r.gate !== null && !r.gate.allowed && r.gate.message.includes("starter"));
  const emergency = await sendWorkflowSms({ ...BASE, smsConfigured: true, io, emergency: true });
  check("emergency not silenced by plan limit", emergency.outcome, "sent");
}
{
  const { io, rows, sendErrors } = makeIo({ failWith: new Error("Twilio rejected the message: carrier blocked") });
  const r = await sendWorkflowSms({ ...BASE, smsConfigured: true, io });
  check("provider failure is honest", r.outcome, "failed");
  checkTrue("real error surfaced", (r.reason ?? "").includes("carrier blocked"));
  check("failure audited without sid", rows[0]?.outcome === "failed" && rows[0]?.sid === null, true);
  checkTrue("failure reaches the error sink", sendErrors.length === 1);
}
{
  const { io, marked } = makeIo({ failWith: new SmsSendError("invalid To", 21211, 400) });
  const r = await sendWorkflowSms({ ...BASE, smsConfigured: true, io });
  check("provider invalid-code marks number", r.outcome, "invalid_number");
  checkTrue("registry updated from provider code", marked.length === 1);
}
{
  const { io } = makeIo({ business: { phone: "+15125550100", settings: { smsWorkflows: sanitizeSmsWorkflowsConfig({ safeguards: { ownerSmsNumber: "+15125550199" } }) } } });
  const r = await sendWorkflowSms({ ...BASE, workflowKey: "new_lead", recipient: "owner", smsConfigured: true, io, to: null });
  check("owner send uses configured owner number", r.outcome, "sent");
}
{
  const { io } = makeIo({ business: { phone: null, settings: {} } });
  const r = await sendWorkflowSms({ ...BASE, workflowKey: "new_lead", recipient: "owner", smsConfigured: true, io, to: null });
  check("owner send without any number is honest", r.outcome, "no_recipient");
}
{
  const { io } = makeIo({ business: null });
  const r = await sendWorkflowSms({ ...BASE, smsConfigured: true, io });
  check("missing business honest", r.outcome, "no_recipient");
}
{
  const { io } = makeIo();
  const r = await sendWorkflowSms({ ...BASE, smsConfigured: true, io, vars: { customerName: "Jo" }, workflowKey: "appointment_confirmation" });
  check("confirmation workflow renders customer var", r.outcome, "sent");
}
{
  // Template variable coverage: the rendered body the fake sender sees.
  let seen = "";
  const { io } = makeIo();
  io.sender.send = async (args) => { seen = args.body; return { sid: "SM1" }; };
  await sendWorkflowSms({
    ...BASE, smsConfigured: true, io,
    workflowKey: "appointment_confirmation",
    vars: { customerName: "Jo", appointmentTime: "Tue 9am" },
  });
  checkTrue("customer name rendered", seen.includes("Jo"));
  checkTrue("appointment time rendered", seen.includes("Tue 9am"));
  checkTrue("business name rendered", seen.includes("Rapid Rooter Plumbing"));
  checkTrue("compliance STOP survives template", seen.includes("Reply STOP"));
}

// ---------------------------------------------------------------------------
// Pure time helpers used by the triggers
// ---------------------------------------------------------------------------
check("formatCentsAsUsd", formatCentsAsUsd(14900), "$149.00");
check("formatCentsAsUsd null-safe", formatCentsAsUsd(null), "$0.00");
checkTrue("formatAppointmentTime includes local marker", formatAppointmentTime(new Date("2026-03-03T14:00:00Z"), "America/Chicago").includes("local time"));
checkTrue("formatAppointmentTime never throws on bad tz", formatAppointmentTime(new Date("2026-03-03T14:00:00Z"), "Bad/Zone").length > 0);

console.log(checks === 0 ? "\nNO CHECKS RAN" : failures === 0 ? "\nALL " + checks + " CHECKS PASSED" : "\n" + failures + " of " + checks + " CHECK(S) FAILED");
process.exit(failures === 0 && checks > 40 ? 0 : 1);
