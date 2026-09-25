/**
 * Configurable SMS workflows (P4-S) — the ONE client-safe source of workflow
 * types, defaults, validation, and pure safeguard logic.
 *
 * Design contract:
 *   - CONFIG lives per-business in businesses.settings.jsonb under the nested
 *     `smsWorkflows` + `notificationChannels` keys (same pattern as the
 *     `receptionist` config blob). No dedicated table for configuration.
 *   - STATE (what was actually sent, to whom, when) lives in the
 *     sms_workflow_sends table — the engine's decisions are computed from it.
 *   - Every outbound customer-facing copy is rendered from a workflow template
 *     that supports the SAME variables the existing SMS_TEMPLATES use
 *     ({businessName}) plus the workflow vars. Rendering never throws.
 *   - Safeguards are NON-NEGOTIABLE and evaluated in a fixed order by the
 *     engine (src/lib/server/smsWorkflowEngine.ts):
 *        1. opt-out (STOP) — compliance, never bypassed, not even for
 *           emergencies;
 *        2. invalid number — stop texting, surface honestly;
 *        3. quiet hours — per business, emergency send overrides;
 *        4. duplicate suppression — same customer+workflow cooldown;
 *        5. per-customer daily cap;
 *        6. usage gate (plan limits).
 *   - Everything here is PURE (no DB, no env, no fetch) so the safeguard
 *     battery (scripts/test-sms-workflows.ts) can exercise it directly and the
 *     server engine only adds I/O.
 */
import { normalizePhone } from "~/lib/smsCommands";

// ---------------------------------------------------------------------------
// Workflow catalog
// ---------------------------------------------------------------------------

export const WORKFLOW_KEYS = [
  "missed_call_recovery",
  "new_lead",
  "appointment_confirmation",
  "appointment_reminder",
  "follow_up",
  "emergency_escalation",
  "welcome",
  "payment_failure",
] as const;

export type WorkflowKey = (typeof WORKFLOW_KEYS)[number];

/** Who the text goes to: the plumber's customer, or the business owner. */
export type WorkflowRecipient = "customer" | "owner";

export interface WorkflowMeta {
  key: WorkflowKey;
  label: string;
  description: string;
  recipient: WorkflowRecipient;
}

/**
 * The fixed catalog. Recipients are structural (not editable): customer
 * workflows text the lead/customer's phone; owner workflows text the
 * business's owner SMS number (settings.smsWorkflows.safeguards.ownerSmsNumber,
 * falling back to the business phone).
 */
export const WORKFLOW_CATALOG: Record<WorkflowKey, WorkflowMeta> = {
  missed_call_recovery: {
    key: "missed_call_recovery",
    label: "Missed-call recovery text",
    description: "Sent automatically when a call is missed — turns the caller into a lead conversation.",
    recipient: "customer",
  },
  new_lead: {
    key: "new_lead",
    label: "New-lead alert (owner)",
    description: "Texts you when the AI captures a new lead so you never find out late.",
    recipient: "owner",
  },
  appointment_confirmation: {
    key: "appointment_confirmation",
    label: "Appointment confirmation",
    description: "Sent to the customer when their appointment is confirmed.",
    recipient: "customer",
  },
  appointment_reminder: {
    key: "appointment_reminder",
    label: "Appointment reminder",
    description: "Sent before a confirmed appointment to cut no-shows.",
    recipient: "customer",
  },
  follow_up: {
    key: "follow_up",
    label: "Follow-up",
    description: "Re-engagement text for older untouched leads.",
    recipient: "customer",
  },
  emergency_escalation: {
    key: "emergency_escalation",
    label: "Emergency escalation (owner)",
    description: "Texts you immediately when the AI classifies an emergency. Overrides quiet hours and caps.",
    recipient: "owner",
  },
  welcome: {
    key: "welcome",
    label: "Welcome (onboarding complete)",
    description: "One-time text to you when your AI goes live after onboarding.",
    recipient: "owner",
  },
  payment_failure: {
    key: "payment_failure",
    label: "Payment-failure notice (owner)",
    description: "Texts you when a subscription payment fails so billing never surprises you.",
    recipient: "owner",
  },
};

/** Per-workflow editable configuration (stored in businesses.settings). */
export interface WorkflowConfig {
  enabled: boolean;
  /** Template with {variables} — rendered before every send. */
  template: string;
  /** Duplicate-suppression cooldown for this workflow (minutes, 0 = off). */
  cooldownMinutes: number;
  /** appointment_reminder only: send when the appointment is within this many hours. */
  hoursBefore: number | null;
  /** follow_up only: only leads older than this many hours are eligible. */
  delayHours: number | null;
}

export interface SafeguardConfig {
  /** Max texts to one customer phone per rolling 24h (all customer workflows combined). */
  maxPerCustomerPerDay: number;
  /**
   * AI-loop prevention: after this many consecutive auto-sourced replies in one
   * thread, stop auto-responding and hand the thread to a human.
   */
  aiLoopMaxReplies: number;
  /** Suppress non-emergency customer texts during local quiet hours. */
  quietHoursEnabled: boolean;
  /** Quiet-hours start hour, local business time (0–23, inclusive). */
  quietHoursStart: number;
  /** Quiet-hours end hour, local business time (0–23, exclusive). */
  quietHoursEnd: number;
  /** Where owner texts go; null = fall back to the business phone. */
  ownerSmsNumber: string | null;
}

export interface SmsWorkflowsConfig {
  safeguards: SafeguardConfig;
  workflows: Record<WorkflowKey, WorkflowConfig>;
}

// ---------------------------------------------------------------------------
// Defaults — honest copy, sane limits. Templates carry {businessName} like the
// built-in SMS_TEMPLATES so the compliance posture (brand identification,
// STOP instructions) survives owner edits reviewed for A2P.
// ---------------------------------------------------------------------------

export const DEFAULT_SAFEGUARDS: SafeguardConfig = {
  maxPerCustomerPerDay: 5,
  aiLoopMaxReplies: 3,
  quietHoursEnabled: false,
  quietHoursStart: 21,
  quietHoursEnd: 8,
  ownerSmsNumber: null,
};

export const DEFAULT_WORKFLOW_TEMPLATES: Record<WorkflowKey, string> = {
  missed_call_recovery:
    "Hi! This is {businessName} — we missed your call. Text back what you need and we'll take care of you. Reply STOP to opt out.",
  new_lead:
    "{businessName} alert: new lead {customerName} — {serviceNeed}. Details in your MissedCall AI dashboard.",
  appointment_confirmation:
    "{businessName}: your appointment is confirmed for {appointmentTime}. Need to change it? Call us. Reply STOP to opt out.",
  appointment_reminder:
    "{businessName} reminder: your appointment is coming up {appointmentTime}. Reply if you need to reschedule.",
  follow_up:
    "Hi {customerName}, this is {businessName} following up — still need help with {serviceNeed}? Text back and we'll get you taken care of. Reply STOP to opt out.",
  emergency_escalation:
    "{businessName} EMERGENCY: {customerName} reported {serviceNeed}. Check your dashboard or call the customer back now.",
  welcome:
    "You're live! {businessName}'s AI receptionist is answering and your missed-call texts are on. We'll alert you here when leads come in.",
  payment_failure:
    "{businessName}: your MissedCall AI payment of {amountDue} failed. Update billing in your dashboard to keep your AI running.",
};

export const DEFAULT_WORKFLOW_CONFIGS: Record<WorkflowKey, WorkflowConfig> = {
  missed_call_recovery: { enabled: true, template: DEFAULT_WORKFLOW_TEMPLATES.missed_call_recovery, cooldownMinutes: 60, hoursBefore: null, delayHours: null },
  new_lead: { enabled: true, template: DEFAULT_WORKFLOW_TEMPLATES.new_lead, cooldownMinutes: 0, hoursBefore: null, delayHours: null },
  appointment_confirmation: { enabled: true, template: DEFAULT_WORKFLOW_TEMPLATES.appointment_confirmation, cooldownMinutes: 0, hoursBefore: null, delayHours: null },
  appointment_reminder: { enabled: true, template: DEFAULT_WORKFLOW_TEMPLATES.appointment_reminder, cooldownMinutes: 0, hoursBefore: 24, delayHours: null },
  follow_up: { enabled: false, template: DEFAULT_WORKFLOW_TEMPLATES.follow_up, cooldownMinutes: 0, hoursBefore: null, delayHours: 72 },
  emergency_escalation: { enabled: true, template: DEFAULT_WORKFLOW_TEMPLATES.emergency_escalation, cooldownMinutes: 0, hoursBefore: null, delayHours: null },
  welcome: { enabled: true, template: DEFAULT_WORKFLOW_TEMPLATES.welcome, cooldownMinutes: 0, hoursBefore: null, delayHours: null },
  payment_failure: { enabled: true, template: DEFAULT_WORKFLOW_TEMPLATES.payment_failure, cooldownMinutes: 0, hoursBefore: null, delayHours: null },
};

export const DEFAULT_SMS_WORKFLOWS_CONFIG: SmsWorkflowsConfig = {
  safeguards: DEFAULT_SAFEGUARDS,
  workflows: DEFAULT_WORKFLOW_CONFIGS,
};

// ---------------------------------------------------------------------------
// Limits used by validation (shared by the server fns and the settings UI)
// ---------------------------------------------------------------------------

export const TEMPLATE_MAX_LENGTH = 480;
export const COOLDOWN_MAX_MINUTES = 60 * 24 * 7; // one week
export const MAX_PER_CUSTOMER_PER_DAY_LIMIT = 20;
export const AI_LOOP_MAX_REPLIES_LIMIT = 10;
export const OWNER_SMS_MAX_LENGTH = 20;

// ---------------------------------------------------------------------------
// Template variables + rendering
// ---------------------------------------------------------------------------

/** The variables a workflow template may reference (all optional per send). */
export type WorkflowTemplateVars = Partial<{
  businessName: string;
  customerName: string;
  serviceNeed: string;
  appointmentTime: string;
  amountDue: string;
}>;

export const WORKFLOW_TEMPLATE_VARIABLES = [
  "businessName",
  "customerName",
  "serviceNeed",
  "appointmentTime",
  "amountDue",
] as const;

/** Human labels for the settings UI template editor. */
export const WORKFLOW_TEMPLATE_VARIABLE_LABELS: Record<(typeof WORKFLOW_TEMPLATE_VARIABLES)[number], string> = {
  businessName: "Business name",
  customerName: "Customer name",
  serviceNeed: "Service need",
  appointmentTime: "Appointment time",
  amountDue: "Amount due",
};

function cleanVar(value: string | undefined): string {
  return (value ?? "").trim();
}

/**
 * Render a workflow template. Unknown {tokens} are left verbatim (an honest
 * signal that the template references a variable this send didn't provide,
 * instead of silently shipping a gap). Never throws.
 */
export function renderWorkflowTemplate(template: string, vars: WorkflowTemplateVars): string {
  let out = typeof template === "string" ? template : "";
  const businessName = cleanVar(vars.businessName) || "us";
  out = out.split("{businessName}").join(businessName);
  for (const key of ["customerName", "serviceNeed", "appointmentTime", "amountDue"] as const) {
    out = out.split("{" + key + "}").join(cleanVar(vars[key]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sanitization — tolerant merge over the defaults. Anything absent, wrong
// typed, or out of range falls back to the default; the saved config is ALWAYS
// complete and in range.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? Math.floor(value) : Number.NaN;
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function sanitizeTemplate(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, TEMPLATE_MAX_LENGTH);
}

function sanitizeE164OrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return isValidTextableNumber(trimmed) ? normalizeToE164(trimmed) : null;
}

/** Tolerant, total: always returns a complete in-range config. */
export function sanitizeSmsWorkflowsConfig(raw: unknown): SmsWorkflowsConfig {
  const root = asRecord(raw) ?? {};
  const safeguardsRaw = asRecord(root.safeguards) ?? {};
  const workflowsRaw = asRecord(root.workflows) ?? {};

  const safeguards: SafeguardConfig = {
    maxPerCustomerPerDay: intInRange(
      safeguardsRaw.maxPerCustomerPerDay,
      DEFAULT_SAFEGUARDS.maxPerCustomerPerDay,
      1,
      MAX_PER_CUSTOMER_PER_DAY_LIMIT,
    ),
    aiLoopMaxReplies: intInRange(
      safeguardsRaw.aiLoopMaxReplies,
      DEFAULT_SAFEGUARDS.aiLoopMaxReplies,
      1,
      AI_LOOP_MAX_REPLIES_LIMIT,
    ),
    quietHoursEnabled: boolOr(safeguardsRaw.quietHoursEnabled, DEFAULT_SAFEGUARDS.quietHoursEnabled),
    quietHoursStart: intInRange(safeguardsRaw.quietHoursStart, DEFAULT_SAFEGUARDS.quietHoursStart, 0, 23),
    quietHoursEnd: intInRange(safeguardsRaw.quietHoursEnd, DEFAULT_SAFEGUARDS.quietHoursEnd, 0, 23),
    ownerSmsNumber: sanitizeE164OrNull(safeguardsRaw.ownerSmsNumber),
  };

  const workflows = {} as Record<WorkflowKey, WorkflowConfig>;
  for (const key of WORKFLOW_KEYS) {
    const wRaw = asRecord(workflowsRaw[key]) ?? {};
    const base = DEFAULT_WORKFLOW_CONFIGS[key];
    workflows[key] = {
      enabled: boolOr(wRaw.enabled, base.enabled),
      template: sanitizeTemplate(wRaw.template, base.template),
      cooldownMinutes: intInRange(wRaw.cooldownMinutes, base.cooldownMinutes, 0, COOLDOWN_MAX_MINUTES),
      hoursBefore:
        key === "appointment_reminder"
          ? intInRange(wRaw.hoursBefore, base.hoursBefore ?? 24, 1, 168)
          : null,
      delayHours: key === "follow_up" ? intInRange(wRaw.delayHours, base.delayHours ?? 72, 1, 24 * 30) : null,
    };
  }
  return { safeguards, workflows };
}

// ---------------------------------------------------------------------------
// Validation for the settings form (strict, with reasons) — unlike the
// tolerant sanitizer this reports what a human typed wrong.
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  field: string;
  message: string;
}

export function validateSmsWorkflowsInput(raw: unknown): { ok: true; value: SmsWorkflowsConfig } | { ok: false; issues: ValidationIssue[] } {
  const sanitized = sanitizeSmsWorkflowsConfig(raw);
  const issues: ValidationIssue[] = [];
  const root = asRecord(raw) ?? {};
  const safeguardsRaw = asRecord(root.safeguards) ?? {};
  const workflowsRaw = asRecord(root.workflows) ?? {};

  // Owner number: empty is fine (falls back), but garbage is an error, not a
  // silent fallback — the owner must see that their number was not saved.
  const ownerRaw = safeguardsRaw.ownerSmsNumber;
  if (typeof ownerRaw === "string" && ownerRaw.trim().length > 0 && !isValidTextableNumber(ownerRaw)) {
    issues.push({ field: "safeguards.ownerSmsNumber", message: "Owner mobile must be a real phone number (e.g. +15125550134)." });
  }

  for (const key of WORKFLOW_KEYS) {
    const wRaw = asRecord(workflowsRaw[key]) ?? {};
    if (typeof wRaw.template === "string") {
      const trimmed = wRaw.template.trim();
      if (trimmed.length === 0) {
        issues.push({ field: `workflows.${key}.template`, message: `${WORKFLOW_CATALOG[key].label}: template cannot be empty.` });
      } else if (trimmed.length > TEMPLATE_MAX_LENGTH) {
        issues.push({ field: `workflows.${key}.template`, message: `${WORKFLOW_CATALOG[key].label}: template is over ${TEMPLATE_MAX_LENGTH} characters.` });
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: sanitized };
}

// ---------------------------------------------------------------------------
// Safeguard primitives (pure)
// ---------------------------------------------------------------------------

const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Normalize a phone to E.164 for sending (delegates to smsCommands). */
export function normalizeToE164(phone: string): string | null {
  return normalizePhone(phone);
}

/**
 * A number is textable when it normalizes to E.164. Garbage ("call me"),
 * too-short, or letter-bearing inputs are invalid and must NEVER be attempted:
 * the engine marks them invalid and stops.
 */
export function isValidTextableNumber(phone: string): boolean {
  if (typeof phone !== "string") return false;
  const normalized = normalizeToE164(phone);
  return normalized !== null && E164_RE.test(normalized);
}

/**
 * Quiet-hours evaluation in the business's timezone. Supports windows that
 * wrap midnight (e.g. 21 → 8). A window where start === end is "always quiet"
 * is nonsensical — treated as disabled (never quiet).
 */
export function isWithinQuietHours(now: Date, timezone: string | null, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return false;
  const hour = localHourInTz(now, timezone);
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

/** Local wall-clock hour (0–23) for an instant, in an IANA timezone. */
export function localHourInTz(now: Date, timezone: string | null | undefined): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: timezone || "UTC" });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === "hour");
    const hour = hourPart ? parseInt(hourPart.value, 10) : Number.NaN;
    // Intl can render midnight as "24" with hour12: false in some runtimes.
    if (hour === 24) return 0;
    return Number.isFinite(hour) ? hour : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/** True when a previous send for this exact customer+workflow is still inside its cooldown. */
export function cooldownActive(lastSentAt: Date | null, now: Date, cooldownMinutes: number): boolean {
  if (!lastSentAt || cooldownMinutes <= 0) return false;
  const elapsedMs = now.getTime() - lastSentAt.getTime();
  return elapsedMs >= 0 && elapsedMs < cooldownMinutes * 60_000;
}

/** True when the rolling-24h sent count for this phone hit the cap. */
export function capReached(sentCount24h: number, maxPerCustomerPerDay: number): boolean {
  return sentCount24h >= maxPerCustomerPerDay;
}

// ---------------------------------------------------------------------------
// AI-loop prevention (pure)
// ---------------------------------------------------------------------------

/** A minimal thread message for loop evaluation (direction + body only). */
export interface LoopThreadMessage {
  direction: "inbound" | "outbound";
  body: string;
}

function normalizeForCompare(text: string): string {
  return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function wordSet(text: string): Set<string> {
  return new Set(normalizeForCompare(text).split(" ").filter(Boolean));
}

/**
 * Detect whether an inbound body is an echo of our own outbound text — a
 * customer-side autoresponder quoting our template, a carrier loop, or the
 * customer pasting our message back. Word-overlap similarity against ANY of
 * the recent outbound bodies.
 */
export function looksLikeAutoEcho(inboundBody: string, recentOutboundBodies: string[]): boolean {
  const inboundWords = wordSet(inboundBody);
  if (inboundWords.size === 0) return false;
  for (const outbound of recentOutboundBodies) {
    const outboundWords = wordSet(outbound);
    if (outboundWords.size === 0) continue;
    let overlap = 0;
    for (const w of inboundWords) if (outboundWords.has(w)) overlap++;
    const ratio = overlap / Math.min(inboundWords.size, outboundWords.size);
    if (ratio >= 0.7) return true;
    // Strong containment: the inbound repeats a long verbatim run of ours.
    const outNorm = normalizeForCompare(outbound);
    const inNorm = normalizeForCompare(inboundBody);
    if (outNorm.length >= 40 && inNorm.includes(outNorm.slice(0, 40))) return true;
  }
  return false;
}

export interface AiLoopDecision {
  /** Stop auto-responding and hand the thread to a human. */
  suppress: boolean;
  /** How many consecutive auto-echoed inbound replies the thread shows. */
  echoCount: number;
}

/**
 * Walk the thread NEWEST-FIRST and count consecutive inbound messages that
 * echo our own outbound text. When that count reaches the configured max, the
 * engine stops auto-responding (the count only ever crosses the threshold
 * once, which also makes the "hand to human" notification naturally
 * per-thread without extra dedup state).
 */
export function evaluateAiLoop(threadNewestFirst: LoopThreadMessage[], maxReplies: number): AiLoopDecision {
  let echoCount = 0;
  const outboundBodies: string[] = [];
  for (const msg of threadNewestFirst) {
    if (msg.direction === "outbound") {
      outboundBodies.push(msg.body);
      continue;
    }
    if (outboundBodies.length === 0) break; // reached real human/customer traffic before any of our sends
    if (looksLikeAutoEcho(msg.body, outboundBodies)) {
      echoCount++;
    } else {
      break;
    }
  }
  return { suppress: echoCount >= Math.max(1, maxReplies), echoCount };
}

// ---------------------------------------------------------------------------
// Business-level notification channel controls
// ---------------------------------------------------------------------------

/** Event types the owner can route per channel. In-app is always on. */
export const NOTIFICATION_CHANNEL_EVENT_TYPES = [
  "new_lead",
  "appointment_requested",
  "appointment_confirmed",
  "payment_failed",
  "emergency",
] as const;

export type NotificationChannelEventType = (typeof NOTIFICATION_CHANNEL_EVENT_TYPES)[number];

export const NOTIFICATION_CHANNEL_LABELS: Record<NotificationChannelEventType, string> = {
  new_lead: "New lead captured",
  appointment_requested: "Appointment requested",
  appointment_confirmed: "Appointment confirmed",
  payment_failed: "Payment failed",
  emergency: "Emergency escalation",
};

export interface NotificationChannelSettings {
  email: Record<NotificationChannelEventType, boolean>;
  sms: Record<NotificationChannelEventType, boolean>;
}

export const DEFAULT_NOTIFICATION_CHANNEL_SETTINGS: NotificationChannelSettings = {
  // Mirrors today's EMAIL_DELIVERY_TYPES behavior: new_lead,
  // appointment_requested and payment_failed email; confirmed does not.
  email: {
    new_lead: true,
    appointment_requested: true,
    appointment_confirmed: false,
    payment_failed: true,
    emergency: true,
  },
  sms: {
    new_lead: true,
    appointment_requested: false,
    appointment_confirmed: false,
    payment_failed: true,
    emergency: true,
  },
};

/** Map a notification type / workflow key onto the channel-control event. */
export function channelEventFor(type: string): NotificationChannelEventType | null {
  if ((NOTIFICATION_CHANNEL_EVENT_TYPES as readonly string[]).includes(type)) {
    return type as NotificationChannelEventType;
  }
  if (type === "emergency_escalation") return "emergency";
  if (type === "payment_failure") return "payment_failed";
  return null;
}

/** Tolerant merge over the channel defaults. */
export function sanitizeNotificationChannelSettings(raw: unknown): NotificationChannelSettings {
  const root = asRecord(raw) ?? {};
  const emailRaw = asRecord(root.email) ?? {};
  const smsRaw = asRecord(root.sms) ?? {};
  const out: NotificationChannelSettings = {
    email: { ...DEFAULT_NOTIFICATION_CHANNEL_SETTINGS.email },
    sms: { ...DEFAULT_NOTIFICATION_CHANNEL_SETTINGS.sms },
  };
  for (const key of NOTIFICATION_CHANNEL_EVENT_TYPES) {
    out.email[key] = boolOr(emailRaw[key], DEFAULT_NOTIFICATION_CHANNEL_SETTINGS.email[key]);
    out.sms[key] = boolOr(smsRaw[key], DEFAULT_NOTIFICATION_CHANNEL_SETTINGS.sms[key]);
  }
  return out;
}

/**
 * Should this notification type email the owner? Pure helper the queue sites
 * consult BEFORE calling queueNotificationEmail (in-app delivery is
 * unconditional and never consults these flags).
 */
export function emailChannelEnabled(channels: NotificationChannelSettings, notificationType: string): boolean {
  const event = channelEventFor(notificationType);
  return event !== null && channels.email[event];
}

/** Should this notification type ALSO text the owner (via the workflow engine)? */
export function smsChannelEnabled(channels: NotificationChannelSettings, notificationType: string): boolean {
  const event = channelEventFor(notificationType);
  return event !== null && channels.sms[event];
}
