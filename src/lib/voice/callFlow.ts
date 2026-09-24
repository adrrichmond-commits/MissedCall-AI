/**
 * Pure call-flow logic for the AI voice receptionist (P3-E).
 *
 * THE CONTRACT (mirrors classifyPipeline.ts's "pure module, callers own I/O"
 * pattern): map a caller's spoken utterance + flow state to the next voice
 * action. No DB, no env, no network at import or runtime — classification
 * goes through runClassificationPipeline (which is itself pure/injected), so
 * the whole flow is unit-testable keyless and DBless.
 *
 * THE SAFETY RULE (same as the SMS path, and stronger because it is spoken):
 *   - Emergency call → the KB safety script is spoken VERBATIM via <Say>,
 *     the caller is offered an immediate transfer, and NO follow-up
 *     qualification questions are asked first. Pricing, booking, capture —
 *     nothing precedes the script.
 *   - Lead-qualifying call → capture service need + urgency + callback
 *     number, classify through the SAME pipeline as SMS (stamps included:
 *     tier/tierReason/kbVersion/emergencyKey/afterHoursEscalation), and hand
 *     the caller-facing flow to the driver, which creates the lead via the
 *     existing lead-creation path (captureMissedCallLead semantics, source
 *     'missed_call') and stamps afterHours from the business's hours.
 *
 * Transfer rules (business-controlled, read from the settings jsonb blob by
 * the driver — this module only decides):
 *   - emergency call   → transfer offered (transfer number if configured);
 *   - after-hours call → transfer offered when afterHoursEmergency is true;
 *   - caller asks      → ("transfer me to a person" / "let me speak to someone")
 *   - otherwise        → qualify → capture → confirm → goodbye.
 *
 * A call that has exchanged MAX_EXCHANGES utterances without classification
 * falls to the wrapup (voicemail) — a caller is never trapped in a loop.
 */
import type { MessageClassification } from "~/db/schema";
import { resolveEmergency, type EmergencyKbEntry } from "~/lib/server/kb";
import {
  runClassificationPipeline,
  type PipelineInput,
  type PipelineLlm,
  type PipelineHoursRow,
} from "~/lib/server/classifyPipeline";
import { matchFaq, type FaqPair } from "~/lib/voice/receptionistConfig";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Where the caller is in the qualification conversation. */
export type CallFlowStage = "greet" | "need" | "callback_number" | "confirm" | "wrapup";

/** The action the driver must take to produce the next TwiML response. */
export type CallFlowAction =
  | { kind: "gather"; prompt: string; stage: CallFlowStage }
  | { kind: "speak_then_gather"; preamble: string[]; prompt: string; stage: CallFlowStage }
  | {
      /** Emergency: safety script VERBATIM first, then the transfer offer. */
      kind: "emergency";
      scriptLines: readonly string[];
      emergencyKey: string | null;
      stage: CallFlowStage;
    }
  | { kind: "transfer"; preamble: string[]; stage: CallFlowStage }
  | { kind: "voicemail"; prompt: string; stage: CallFlowStage }
  | { kind: "goodbye"; text: string; stage: CallFlowStage };

/** Result pair: what to say next + the state to persist for the next turn. */
export interface CallFlowStep {
  action: CallFlowAction;
  state: CallFlowState;
}

export interface CallFlowState {
  stage: CallFlowStage;
  /** How many caller utterances processed (non-silent Gather results) so far. */
  exchanges: number;
  /** Consecutive silent Gather results (bounded loops on dead air). */
  silences: number;
  /** Captured service need (from any turn so far). */
  serviceNeed: string | null;
  /** Captured urgency (strongest so far). */
  urgency: MessageClassification["urgency"];
  /** Captured callback number (digits extracted from any turn so far). */
  callbackNumber: string | null;
  /** Caller explicitly asked for a human/transfer. */
  askedForHuman: boolean;
  /** Classification stamps from the strongest turn so far. */
  classification: MessageClassification | null;
  /** Emergency resolved by the KB on any turn so far. */
  emergency: EmergencyKbEntry | null;
  /** The safety script has been spoken — next answer decides the transfer. */
  emergencyScriptSpoken: boolean;
  /** Lead already captured by the driver for this call. */
  leadCaptured: boolean;
}

export function initialFlowState(stage: CallFlowStage = "need"): CallFlowState {
  return {
    stage,
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
}

/** Business context injected by the driver (all resolved, no I/O here). */
export interface CallFlowContext {
  businessName: string | null;
  /** "now" — injected for determinism (tests); real time in prod. */
  now: Date;
  timezone: string | null;
  hours: PipelineHoursRow[] | null;
  /** null = rules tier (the keyless launch default). */
  llm: PipelineLlm | null;
  /** True when the business takes emergency calls after hours (prefs). */
  afterHoursEmergency: boolean;
  /**
   * P4-O receptionist studio: the business's FAQ pairs. When the caller asks
   * something a FAQ answers (and the flow hasn't captured a need yet), the
   * answer is spoken and the flow resumes — bounded by the same exchange cap.
   * Absent/empty → no FAQ branch (every pre-studio behavior unchanged).
   */
  faqs?: FaqPair[];
  /**
   * P4-O: overrides the default confirm prompt when the business's
   * never-promise policy forbids the default's "will reach out shortly"
   * commitment. Undefined → PROMPTS.confirm, exactly as before.
   */
  confirmPrompt?: string;
}

// ---------------------------------------------------------------------------
// Extraction helpers (pure, honest — no invented values)
// ---------------------------------------------------------------------------

/** Pull the most phone-like digit run out of a spoken/typed utterance. */
export function extractCallbackNumber(utterance: string): string | null {
  const digits = utterance.replace(/[^\d]/g, "");
  // 10 (US) or 11 (leading 1) digits is a decidable number; anything else is
  // not a guess. Digit-by-digit speech ("five one two ...") works because the
  // digits survive stripping.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

const HUMAN_REQUEST_RE =
  /\b(human|person|real person|someone else|manager|owner|representative|operator|speak to (a )?(someone|somebody|person|human)|talk to (a )?(someone|somebody|person|human)|transfer me|let me talk to)\b/i;

export function asksForHuman(utterance: string): boolean {
  return HUMAN_REQUEST_RE.test(utterance);
}

/** Silence or non-speech results give the caller one nudge, then wrap up. */
export function isSilent(utterance: string): boolean {
  return utterance.trim().length === 0;
}

/** Merge a fresh classification over the strongest one so far. */
function strongerClassification(
  prev: MessageClassification | null,
  next: MessageClassification,
): MessageClassification {
  if (!prev) return next;
  const rank = (c: MessageClassification): number => {
    if (c.urgency === "emergency") return 3;
    if (c.priority === "high") return 2;
    if (c.serviceNeed) return 1;
    return 0;
  };
  return rank(next) >= rank(prev) ? next : prev;
}

// ---------------------------------------------------------------------------
// Stage prompts (single source of truth for the receptionist's voice)
// ---------------------------------------------------------------------------

export const PROMPTS = {
  need:
    "Tell me briefly what's going on — for example, a leak, a clog, no hot water, or something else.",
  callbackNumber: "Thanks. What's the best callback number for you?",
  confirm:
    "So I have that down. Someone from the team will reach out shortly. Would you like me to transfer you to someone right now? Say yes, or stay on the line to leave a message.",
  nudge: "Sorry, I didn't catch that. Could you say it again?",
  voicemailOffer:
    "I'm sorry, but I didn't get enough to route your request. Please leave a message with your name, number, and what you need after the beep.",
  transferPreamble: "Let me transfer you to someone who can help right now. Please hold.",
  emergencyTransferOffer:
    "Would you like me to transfer you to someone right now? Say yes, or stay on the line.",
  goodbye: "Thanks for calling. Goodbye!",
} as const;

// ---------------------------------------------------------------------------
// The step function
// ---------------------------------------------------------------------------

/**
 * Process one caller utterance (or silence) and return the next voice action
 * plus the state to persist. The driver owns ALL side effects (lead capture,
 * usage metering, notifications) — this function is pure.
 *
 * NEVER throws for expected engine failure: an LLM error inside the pipeline
 * degrades to the rules tier for this utterance (tierReason "backstop"), the
 * same contract as the SMS path. A thrown error here is a bug; the route
 * still owes Twilio a well-formed TwiML response (apology document).
 */
export async function stepCallFlow(
  state: CallFlowState,
  utterance: string,
  ctx: CallFlowContext,
): Promise<CallFlowStep> {
  const text = utterance.trim();

  // ---- Terminal wrapup guard -----------------------------------------------
  if (state.stage === "wrapup") {
    return { action: { kind: "voicemail", prompt: PROMPTS.voicemailOffer, stage: "wrapup" }, state };
  }

  // ---- Silence: nudge once per silence, then wrap up honestly ---------------
  if (isSilent(text)) {
    const silences = state.silences + 1;
    const after: CallFlowState = { ...state, silences };
    if (silences === 1 && state.stage !== "confirm") {
      return { action: { kind: "gather", prompt: PROMPTS.nudge, stage: state.stage }, state: after };
    }
    if (state.stage === "confirm") {
      return { action: { kind: "goodbye", text: PROMPTS.goodbye, stage: "confirm" }, state: after };
    }
    return {
      action: { kind: "voicemail", prompt: PROMPTS.voicemailOffer, stage: "wrapup" },
      state: { ...after, stage: "wrapup" },
    };
  }

  // ---- Emergency check FIRST — nothing else may run before it ---------------
  const kbEmergency = resolveEmergency(text.toLowerCase());
  if (kbEmergency && !state.emergencyScriptSpoken) {
    // Fail toward emergency: the safety script is spoken VERBATIM before
    // anything else — no follow-up qualification questions first (P3-E hard
    // rule). The next answer (yes/hold) decides the transfer.
    const next: CallFlowState = {
      ...state,
      stage: "need",
      emergency: kbEmergency.entry,
      emergencyScriptSpoken: true,
    };
    return {
      action: {
        kind: "emergency",
        scriptLines: kbEmergency.entry.customerScript,
        emergencyKey: kbEmergency.entry.key,
        stage: "need",
      },
      state: next,
    };
  }

  // ---- The caller is answering the emergency transfer offer -----------------
  if (state.emergencyScriptSpoken) {
    const wantsTransfer = /\b(yes|yeah|yep|sure|please|transfer|connect)\b/i.test(text);
    if (wantsTransfer) {
      return { action: { kind: "transfer", preamble: [PROMPTS.transferPreamble], stage: "need" }, state };
    }
    // Declined / unclear: leave the emergency voicemail instead — the KB
    // scripts have already been spoken; we do not re-ask questions.
    return {
      action: {
        kind: "voicemail",
        prompt: "Please leave your name and address after the beep, and a technician will be sent out.",
        stage: "need",
      },
      state,
    };
  }

  // ---- Exchange cap: a caller is never trapped in a loop --------------------
  if (state.exchanges >= MAX_EXCHANGES) {
    return {
      action: { kind: "voicemail", prompt: PROMPTS.voicemailOffer, stage: "wrapup" },
      state: { ...state, stage: "wrapup" },
    };
  }

  // ---- Caller asked for a human ----------------------------------------------
  if (asksForHuman(text)) {
    const next: CallFlowState = { ...state, askedForHuman: true };
    return { action: { kind: "transfer", preamble: [PROMPTS.transferPreamble], stage: state.stage }, state: next };
  }

  // ---- Classify through the SAME pipeline as the SMS path --------------------
  const input: PipelineInput = {
    body: text,
    now: ctx.now,
    timezone: ctx.timezone,
    hours: ctx.hours,
    llm: ctx.llm,
  };
  const pipeline = await runClassificationPipeline(input);
  const c = pipeline.classification;

  const next: CallFlowState = {
    ...state,
    exchanges: state.exchanges + 1,
    silences: 0,
    serviceNeed: c.serviceNeed ?? state.serviceNeed,
    urgency: pickUrgency(c.urgency, state.urgency),
    classification: strongerClassification(state.classification, c),
  };

  // ---- Stage machine ----------------------------------------------------------
  if (next.stage === "greet" || next.stage === "need") {
    if (next.serviceNeed) {
      return {
        action: {
          kind: "speak_then_gather",
          preamble: ["Got it — " + next.serviceNeed + "."],
          prompt: PROMPTS.callbackNumber,
          stage: "callback_number",
        },
        state: { ...next, stage: "callback_number" },
      };
    }
    // P4-O FAQ branch: the caller asked a question the business configured an
    // answer for (and this turn didn't capture a need) — answer it, then let
    // the qualification resume. The exchange was already counted, so a
    // question-only caller still hits the wrapup cap honestly.
    const faq = ctx.faqs && ctx.faqs.length > 0 ? matchFaq(ctx.faqs, text) : null;
    if (faq) {
      return {
        action: { kind: "speak_then_gather", preamble: [faq.answer], prompt: PROMPTS.need, stage: "need" },
        state: next,
      };
    }
    return { action: { kind: "gather", prompt: PROMPTS.need, stage: "need" }, state: { ...next, stage: "need" } };
  }

  if (next.stage === "callback_number") {
    const phone = extractCallbackNumber(text) ?? state.callbackNumber;
    if (phone) {
      const withPhone: CallFlowState = { ...next, callbackNumber: phone, stage: "confirm" };
      return {
        action: {
          kind: "speak_then_gather",
          preamble: ["Thanks — I'll pass that along."],
          prompt: ctx.confirmPrompt ?? PROMPTS.confirm,
          stage: "confirm",
        },
        state: withPhone,
      };
    }
    // The caller said something that isn't a number — answer a matching FAQ
    // if there is one, then ask for the number again.
    const faq = ctx.faqs && ctx.faqs.length > 0 ? matchFaq(ctx.faqs, text) : null;
    if (faq) {
      return {
        action: { kind: "speak_then_gather", preamble: [faq.answer], prompt: PROMPTS.callbackNumber, stage: "callback_number" },
        state: next,
      };
    }
    return {
      action: { kind: "gather", prompt: PROMPTS.callbackNumber, stage: "callback_number" },
      state: { ...next, stage: "callback_number" },
    };
  }

  if (next.stage === "confirm") {
    const wantsTransfer = /\b(yes|yeah|yep|sure|transfer|connect)\b/i.test(text);
    if (wantsTransfer) {
      return { action: { kind: "transfer", preamble: [PROMPTS.transferPreamble], stage: "confirm" }, state: next };
    }
    return { action: { kind: "goodbye", text: PROMPTS.goodbye, stage: "confirm" }, state: next };
  }

  // Unreachable (all stages handled) — honest fallback, not an invention.
  return {
    action: { kind: "voicemail", prompt: PROMPTS.voicemailOffer, stage: "wrapup" },
    state: { ...next, stage: "wrapup" },
  };
}

function pickUrgency(
  next: MessageClassification["urgency"],
  prev: MessageClassification["urgency"],
): MessageClassification["urgency"] {
  const rank = (u: MessageClassification["urgency"]): number =>
    u === "emergency" ? 3 : u === "same_day" ? 2 : u === "within_week" ? 1 : u ? 0 : -1;
  return rank(next) >= rank(prev) ? next : prev;
}

/** Safety cap: max caller utterances before honest wrapup. */
export const MAX_EXCHANGES = 3;

/**
 * After-hours facts for a call (re-exported for the driver + tests): the
 * afterHours flag stamped on captured leads comes from THIS decision, the
 * same isAfterHours the SMS path uses.
 */
export { isAfterHours } from "~/lib/server/classifyPipeline";
