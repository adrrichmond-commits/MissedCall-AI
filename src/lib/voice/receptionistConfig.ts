/**
 * Receptionist studio config — pure, client-safe module (P4-O part 2).
 *
 * THE CONTRACT (mirrors twiml.ts / transferRules.ts): string/JSON in, values
 * out. No DB, no env, no server imports at runtime — the studio page (client),
 * the server fns (validation) and the live voice webhook driver all use the
 * SAME pure helpers, so what the plumber configures is exactly what callers
 * hear and what the flow engine consumes.
 *
 * STORAGE (no migration needed — deliberate): the config lives as a nested
 * object under the `receptionist` key of the EXISTING businesses.settings
 * jsonb blob, exactly like notification prefs, emergency prefs and
 * settings.transferNumber already do (migration 003 introduced the column).
 * One row per business — business isolation comes from the businesses row
 * itself; there is no second table to scope.
 *
 * CONSUMPTION MAP (every field has at least one real consumer — nothing is
 * stored for decoration):
 *   name             → default greeting ("This is <name>.")
 *   greeting         → verbatim first <Say> of a live call + onboarding step 4
 *   emergencyHandling → emergency lead notes + emergency notification payload
 *   neverPromise     → the spoken confirm prompt drops its "will reach out
 *                      shortly" promise line (neutral wording instead) + lead
 *                      notes for staff
 *   escalationNotes  → lead notes + emergency notification payload
 *   transferNumber   → resolveTransferRules (the <Dial> target)
 *   faqs[]           → the call-flow FAQ branch (spoken answer, then flow
 *                      resumes) + studio test-call simulation
 *   instructions     → post-call AI summary system prompt
 */

import type { CallFlowState } from "~/lib/voice/callFlow";
import type { MessageClassification } from "~/db/schema";

// ---------------------------------------------------------------------------
// Types + limits
// ---------------------------------------------------------------------------

export interface ReceptionistFaq {
  /** Stable id for React keys / reorder operations (generated when absent). */
  id: string;
  question: string;
  answer: string;
}

export interface ReceptionistConfig {
  /** The receptionist's persona name ("" → "the office assistant"). */
  name: string;
  /** Custom greeting spoken verbatim ("" → default built from name). */
  greeting: string;
  /** Emergency handling notes for staff + notifications. */
  emergencyHandling: string;
  /** Things the AI must never promise (drops the confirm promise line). */
  neverPromise: string;
  /** Escalation/transfer rules for staff + notifications. */
  escalationNotes: string;
  /** Explicit transfer target (resolveTransferRules <Dial> number). */
  transferNumber: string;
  /** Question → answer pairs the receptionist may answer from. */
  faqs: ReceptionistFaq[];
  /** Free-form company instructions (post-call AI summary prompt). */
  instructions: string;
}

export const RECEPTIONIST_LIMITS = {
  name: 60,
  greeting: 600,
  policy: 2000,
  transferNumber: 32,
  faqQuestion: 200,
  faqAnswer: 600,
  maxFaqs: 12,
  instructions: 2000,
} as const;

export const DEFAULT_RECEPTIONIST_CONFIG: ReceptionistConfig = {
  name: "",
  greeting: "",
  emergencyHandling: "",
  neverPromise: "",
  escalationNotes: "",
  transferNumber: "",
  faqs: [],
  instructions: "",
};

// ---------------------------------------------------------------------------
// Sanitize (tolerant read from the jsonb blob) — never throws
// ---------------------------------------------------------------------------

function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, max);
}

let faqSeq = 0;
function nextFaqId(): string {
  faqSeq += 1;
  return "faq_" + Date.now().toString(36) + "_" + faqSeq.toString(36);
}

/** Tolerant read: garbage in → defaults out (clamped to the limits). */
export function sanitizeReceptionistConfig(raw: unknown): ReceptionistConfig {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: ReceptionistConfig = {
    name: cleanText(src.name, RECEPTIONIST_LIMITS.name),
    greeting: cleanText(src.greeting, RECEPTIONIST_LIMITS.greeting),
    emergencyHandling: cleanText(src.emergencyHandling, RECEPTIONIST_LIMITS.policy),
    neverPromise: cleanText(src.neverPromise, RECEPTIONIST_LIMITS.policy),
    escalationNotes: cleanText(src.escalationNotes, RECEPTIONIST_LIMITS.policy),
    transferNumber: cleanText(src.transferNumber, RECEPTIONIST_LIMITS.transferNumber),
    instructions: cleanText(src.instructions, RECEPTIONIST_LIMITS.instructions),
    faqs: [],
  };
  if (Array.isArray(src.faqs)) {
    for (const entry of src.faqs.slice(0, RECEPTIONIST_LIMITS.maxFaqs)) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const question = cleanText(e.question, RECEPTIONIST_LIMITS.faqQuestion);
      const answer = cleanText(e.answer, RECEPTIONIST_LIMITS.faqAnswer);
      if (!question || !answer) continue; // drop malformed/partial entries
      out.faqs.push({
        id: typeof e.id === "string" && e.id.trim().length > 0 ? e.id.trim().slice(0, 64) : nextFaqId(),
        question,
        answer,
      });
    }
  }
  return out;
}

/** Read the config out of a businesses.settings jsonb blob (or its absence). */
export function receptionistConfigFromSettings(settings: unknown): ReceptionistConfig {
  const blob = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  return sanitizeReceptionistConfig(blob.receptionist);
}

// ---------------------------------------------------------------------------
// Validate (strict — the save path; pure so the suite tests every rule)
// ---------------------------------------------------------------------------

export interface ReceptionistValidationIssue {
  field: string;
  message: string;
}

export type ReceptionistValidationResult =
  | { ok: true; value: ReceptionistConfig }
  | { ok: false; issues: ReceptionistValidationIssue[] };

function requireText(
  raw: unknown,
  field: string,
  label: string,
  max: number,
  issues: ReceptionistValidationIssue[],
): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    issues.push({ field, message: `${label} is required.` });
    return "";
  }
  const s = raw.trim();
  if (s.length > max) {
    issues.push({ field, message: `${label} must be at most ${max} characters.` });
  }
  return s;
}

function optionalText(raw: unknown, field: string, label: string, max: number, issues: ReceptionistValidationIssue[]): string {
  if (raw == null || (typeof raw === "string" && raw.trim().length === 0)) return "";
  if (typeof raw !== "string") {
    issues.push({ field, message: `${label} must be text.` });
    return "";
  }
  const s = raw.trim();
  if (s.length > max) issues.push({ field, message: `${label} must be at most ${max} characters.` });
  return s;
}

/**
 * Strict server-side validation for a studio save. Returns every issue (the
 * UI can show them all); an ok result carries the normalized config.
 */
export function validateReceptionistInput(raw: unknown): ReceptionistValidationResult {
  const issues: ReceptionistValidationIssue[] = [];
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const name = optionalText(src.name, "name", "Receptionist name", RECEPTIONIST_LIMITS.name, issues);
  const greeting = optionalText(src.greeting, "greeting", "Greeting", RECEPTIONIST_LIMITS.greeting, issues);
  const emergencyHandling = optionalText(src.emergencyHandling, "emergencyHandling", "Emergency handling", RECEPTIONIST_LIMITS.policy, issues);
  const neverPromise = optionalText(src.neverPromise, "neverPromise", "Never-promise policy", RECEPTIONIST_LIMITS.policy, issues);
  const escalationNotes = optionalText(src.escalationNotes, "escalationNotes", "Escalation rules", RECEPTIONIST_LIMITS.policy, issues);
  const instructions = optionalText(src.instructions, "instructions", "Company instructions", RECEPTIONIST_LIMITS.instructions, issues);

  // Transfer number: optional, but when present it must be dialable — the
  // same normalization the live transfer path applies (never guess).
  const transferNumberRaw = optionalText(src.transferNumber, "transferNumber", "Transfer number", RECEPTIONIST_LIMITS.transferNumber, issues);
  let transferNumber = "";
  if (transferNumberRaw) {
    const normalized = normalizeDialable(transferNumberRaw);
    if (!normalized) {
      issues.push({ field: "transferNumber", message: "Transfer number must be a real, dialable phone number (10–11 digits)." });
    } else {
      transferNumber = normalized;
    }
  }

  const faqs: ReceptionistFaq[] = [];
  if (src.faqs != null) {
    if (!Array.isArray(src.faqs)) {
      issues.push({ field: "faqs", message: "FAQ entries are malformed." });
    } else {
      if (src.faqs.length > RECEPTIONIST_LIMITS.maxFaqs) {
        issues.push({ field: "faqs", message: `At most ${RECEPTIONIST_LIMITS.maxFaqs} FAQ entries are allowed.` });
      }
      src.faqs.slice(0, RECEPTIONIST_LIMITS.maxFaqs).forEach((entry, i) => {
        const e = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        const question = requireText(e.question, `faqs.${i}.question`, `FAQ ${i + 1} question`, RECEPTIONIST_LIMITS.faqQuestion, issues);
        const answer = requireText(e.answer, `faqs.${i}.answer`, `FAQ ${i + 1} answer`, RECEPTIONIST_LIMITS.faqAnswer, issues);
        if (question && answer) {
          const id = typeof e.id === "string" && e.id.trim().length > 0 ? e.id.trim().slice(0, 64) : nextFaqId();
          faqs.push({ id, question, answer });
        }
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: { name, greeting, emergencyHandling, neverPromise, escalationNotes, transferNumber, faqs, instructions },
  };
}

/** Local copy of the transferRules dialable check (pure modules stay independent). */
function normalizeDialable(raw: string): string | null {
  const trimmed = raw.trim();
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 10) return null;
  if (plus || digits.length > 10) {
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (plus) return `+${digits}`;
  }
  return `+1${digits}`;
}

// ---------------------------------------------------------------------------
// Greeting resolution (the live voice path + onboarding step 4 + the studio
// preview all call THIS, so the three surfaces can never drift)
// ---------------------------------------------------------------------------

export const FALLBACK_RECEPTIONIST_NAME = "the office assistant";

/**
 * The exact first sentence a caller hears. A configured greeting is spoken
 * verbatim; otherwise the default is built from the receptionist name and —
 * when both are unset — is byte-identical to the pre-studio DEFAULT_GREETING
 * (asserted in scripts/test-voice.ts so behavior never changes by accident).
 */
export function resolveReceptionistGreeting(config: ReceptionistConfig, businessName: string | null): string {
  const custom = config.greeting.trim();
  if (custom.length > 0) return custom;
  const persona = config.name.trim() || FALLBACK_RECEPTIONIST_NAME;
  return businessName
    ? `Thank you for calling ${businessName}. This is ${persona}. How can I help you today?`
    : `Thank you for calling. This is ${persona}. How can I help you today?`;
}

/**
 * Confirm-stage prompt override: when the business lists promises the AI must
 * never make, the default confirm line ("Someone from the team will reach out
 * shortly") is a promise the AI cannot keep to that standard — it is replaced
 * with neutral wording. Null = use the flow engine's default.
 */
export const NEUTRAL_CONFIRM_PROMPT =
  "So I have that down. Would you like me to transfer you to someone right now, or stay on the line to leave a message?";

export function confirmPromptOverride(config: ReceptionistConfig): string | null {
  return config.neverPromise.trim().length > 0 ? NEUTRAL_CONFIRM_PROMPT : null;
}

// ---------------------------------------------------------------------------
// FAQ matching (the flow engine's FAQ branch + the simulation)
// ---------------------------------------------------------------------------

const FAQ_STOPWORDS = new Set([
  "a","an","the","do","does","did","you","your","yours","i","me","my","we","our","is","are","was","were",
  "be","been","can","could","will","would","shall","should","to","of","for","in","on","at","by","with",
  "and","or","but","if","it","its","this","that","these","those","how","what","when","where","who","why",
  "have","has","had","get","got","much","many","any","about","there","here","please","hi","hello",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !FAQ_STOPWORDS.has(t));
}

export interface FaqPair {
  question: string;
  answer: string;
}

/**
 * Best-matching FAQ for a caller utterance, or null when nothing matches
 * well enough to speak. Scoring: share of the question's content words that
 * appear in the utterance — forgiving of filler ("Do you guys install…"),
 * strict about subject matter (an unrelated question never matches).
 */
export function matchFaq(faqs: FaqPair[], utterance: string): FaqPair | null {
  const utteranceTokens = new Set(tokenize(utterance));
  if (utteranceTokens.size === 0) return null;
  let best: { entry: FaqPair; score: number } | null = null;
  for (const entry of faqs) {
    const qTokens = tokenize(entry.question);
    if (qTokens.length === 0) continue;
    let matched = 0;
    for (const t of qTokens) {
      if (utteranceTokens.has(t)) matched++;
    }
    const score = matched / qTokens.length;
    if (matched >= 2 && score >= 0.65 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }
  return best ? best.entry : null;
}

// ---------------------------------------------------------------------------
// Policy notes for staff (consumed by the lead-capture + notification path)
// ---------------------------------------------------------------------------

/**
 * The policy lines appended to a captured lead's notes so the human who works
 * the lead sees exactly what the owner configured. Emergency handling rides
 * only on emergency captures; empty policies add nothing.
 */
export function policyNotesForLead(
  config: ReceptionistConfig,
  opts: { emergency: boolean },
): string[] {
  const notes: string[] = [];
  const never = config.neverPromise.trim();
  if (never) notes.push("Owner policy — the AI must never promise: " + never);
  const escalation = config.escalationNotes.trim();
  if (escalation) notes.push("Owner escalation rules: " + escalation);
  if (opts.emergency) {
    const handling = config.emergencyHandling.trim();
    if (handling) notes.push("Owner emergency handling: " + handling);
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Simulation state coercion (test-call preview)
// ---------------------------------------------------------------------------

const FLOW_STAGES = ["greet", "need", "callback_number", "confirm", "wrapup"] as const;

/**
 * Validate a client-supplied simulation flow state (opaque round-trip JSON).
 * Anything malformed falls back to a fresh initial state — the simulation can
 * never be pushed into an impossible stage by crafted input.
 */
export function coerceFlowState(raw: unknown): CallFlowState {
  const fallback: CallFlowState = {
    stage: "need",
    exchanges: 0,
    silences: 0,
    serviceNeed: null,
    urgency: null,
    callbackNumber: null,
    askedForHuman: false,
    classification: null,
    emergency: null,
    emergencyScriptSpoken: false,
    leadCaptured: false,
  };
  if (!raw || typeof raw !== "object") return fallback;
  const src = raw as Record<string, unknown>;
  const stage = typeof src.stage === "string" && (FLOW_STAGES as readonly string[]).includes(src.stage)
    ? (src.stage as CallFlowState["stage"])
    : "need";
  const num = (v: unknown, max: number): number => {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= max ? n : 0;
  };
  return {
    stage,
    exchanges: num(src.exchanges, 50),
    silences: num(src.silences, 50),
    serviceNeed: typeof src.serviceNeed === "string" ? src.serviceNeed.slice(0, 300) : null,
    urgency: isUrgency(src.urgency) ? src.urgency : null,
    callbackNumber: typeof src.callbackNumber === "string" && src.callbackNumber.length <= 24 ? src.callbackNumber : null,
    askedForHuman: src.askedForHuman === true,
    classification: null, // stamps are re-derived per turn in the simulation
    emergency: null, // never trust a client-supplied emergency KB entry
    emergencyScriptSpoken: src.emergencyScriptSpoken === true,
    leadCaptured: false, // the simulation captures nothing
  };
}

function isUrgency(v: unknown): v is MessageClassification["urgency"] {
  return v === "emergency" || v === "same_day" || v === "within_week" || v === "flexible";
}
