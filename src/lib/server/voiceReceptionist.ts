/**
 * AI voice receptionist — webhook orchestrator (P3-E).
 *
 * THE FLOW (matches the P3-E brief):
 *   Twilio POSTs the voice webhook → signature validated (same helper as
 *   SMS) → business resolved by the called (To) number → the pure flow
 *   engine (src/lib/voice/callFlow.ts) drives a Gather loop (max
 *   MAX_EXCHANGES caller utterances) → outcome:
 *     - lead-qualifying call → lead captured via the EXISTING lead path
 *       (captureMissedCallLead: createLead + new_lead notification +
 *       text-back + follow-up task), classified/stamped like SMS, afterHours
 *       from the business's hours → goodbye (or offered transfer);
 *     - emergency call → KB safety script VERBATIM, transfer offered
 *       immediately, lead captured as emergency;
 *     - transfer requested (or offered and accepted) → <Dial> per the
 *       business's transfer rules (transferRules.ts);
 *     - wrapup/silence/cap → voicemail <Record> + wrapup.
 *
 * TESTABILITY SEAM (mirrors stripeWebhook.ts's StripeEventStore): ALL side
 * effects go through VoiceCallStore. Production passes neonVoiceCallStore;
 * tests pass an in-memory implementation over recorded Twilio fixtures —
 * the production and test paths share every line of flow logic.
 *
 * USAGE-ON-VOICE (documented decision): a handled call increments the
 * calls_handled axis via meterAction. The gate check is LOG-ONLY — a live
 * call is NEVER dropped over a billing limit. Reasons: (1) an inbound call
 * is not an outbound spend; (2) the caller's safety and the business's
 * lead both matter more than the meter; (3) the honest alternative —
 * apologizing and hanging up on a paying-or-trialing customer's customer —
 * is worse for everyone. The gate result is logged for monitoring and the
 * Phase 4 upgrade prompts can react to usage counters without the flow
 * ever depending on them.
 *
 * HONEST DEGRADATION (documented decisions):
 *   - unknown To number → polite default greeting + voicemail, NO business
 *     lookup context (we cannot even confirm who they called) and NO lead
 *     creation (no business to own it); logged for ops.
 *   - invalid signature → 403 (handled in the route, like the SMS path).
 *   - DB failure mid-call → apology TwiML (transfer if the business has a
 *     number, else voicemail) — Twilio NEVER receives an error page.
 */
import type { Call, CallStatus, CallTranscript, CallTranscriptTurn, Lead } from "~/db/schema";
import { normalizePhone, phoneKey } from "~/lib/smsCommands";
import {
  stepCallFlow,
  initialFlowState,
  isAfterHours,
  PROMPTS,
  type CallFlowState,
  type CallFlowContext,
  type CallFlowAction,
} from "~/lib/voice/callFlow";
import {
  twiml,
  say,
  gather,
  dial,
  record,
  goodbyeDocument,
  apologyDocument,
  DEFAULT_GREETING,
  type TwiMLElement,
} from "~/lib/voice/twiml";
import { normalizeTransferNumber, resolveTransferRules } from "~/lib/voice/transferRules";
import { captureSystemError } from "~/lib/server/errorSink";
import type { CreateLeadInput } from "~/db/queries/leads";
import type { PipelineLlm } from "~/lib/server/classifyPipeline";

// ---------------------------------------------------------------------------
// The injectable store
// ---------------------------------------------------------------------------

/** Everything the flow touches the world through — one seam, injected. */
export interface VoiceCallStore {
  // --- reads ---------------------------------------------------------------
  findBusinessByPhoneKey(phoneKey: string): Promise<{
    id: string;
    name: string;
    phone: string | null;
    timezone: string | null;
    settings: unknown;
  } | null>;
  listBusinessHours(businessId: string): Promise<
    { dayOfWeek: number; isOpen: boolean; opensAt: string | null; closesAt: string | null }[]
  >;
  getCallBySid(callSid: string): Promise<Call | null>;
  // --- writes --------------------------------------------------------------
  upsertCallBySid(args: {
    businessId: string;
    callSid: string;
    fromNumber: string | null;
    toNumber: string | null;
  }): Promise<{ call: Call; created: boolean }>;
  writeCallTranscript(args: { businessId: string; callId: string; transcript: CallTranscript }): Promise<void>;
  updateCall(businessId: string, callId: string, input: Record<string, unknown>): Promise<Call | null>;
  /** Existing lead path: createLead + notification + text-back + follow-up. */
  captureLead(args: { businessId: string; businessName: string; input: CreateLeadInput }): Promise<Lead | null>;
  /** Emergency-payload notification through the EXISTING notification path. */
  notifyEmergency(args: { businessId: string; payload: Record<string, unknown> }): Promise<void>;
  /** usage_counters increment via the P3-F gate helpers (meterAction). */
  meterCallHandled(businessId: string): Promise<void>;
  /** Post-call AI summary; null when no summary could be produced. */
  summarizeCall(args: { businessId: string; transcript: CallTranscriptTurn[] }): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Fixture parsing (pure)
// ---------------------------------------------------------------------------

export interface VoiceWebhookParams {
  CallSid: string;
  From: string | null;
  To: string | null;
  /** The caller's speech from a <Gather> result ("" = silence). */
  SpeechResult: string | null;
  CallStatus: string | null;
  /** Dial result / recording metadata fields when present. */
  DialCallStatus?: string | null;
  RecordingUrl?: string | null;
  RecordingDuration?: string | null;
  CallDuration?: string | null;
}

/** Parse the form-encoded Twilio voice payload into the typed shape. */
export function parseVoiceParams(raw: string): { all: Record<string, string>; typed: VoiceWebhookParams } {
  const all: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw).entries()) all[k] = v;
  const params = all;
  const typed: VoiceWebhookParams = {
    CallSid: typeof params.CallSid === "string" ? params.CallSid : "",
    From: typeof params.From === "string" ? params.From : null,
    To: typeof params.To === "string" ? params.To : null,
    SpeechResult: typeof params.SpeechResult === "string" ? params.SpeechResult : null,
    CallStatus: typeof params.CallStatus === "string" ? params.CallStatus : null,
    ...(typeof params.DialCallStatus === "string" ? { DialCallStatus: params.DialCallStatus } : {}),
    ...(typeof params.RecordingUrl === "string" ? { RecordingUrl: params.RecordingUrl } : {}),
    ...(typeof params.RecordingDuration === "string" ? { RecordingDuration: params.RecordingDuration } : {}),
    ...(typeof params.CallDuration === "string" ? { CallDuration: params.CallDuration } : {}),
  };
  return { all, typed };
}

// ---------------------------------------------------------------------------
// Flow-state persistence helpers (transcript document is the source of truth)
// ---------------------------------------------------------------------------

function flowOf(transcript: CallTranscript): CallFlowState {
  const f = transcript.flow as { flow?: CallFlowState } | undefined;
  const raw = (transcript.flow ?? f?.flow) as CallFlowState | undefined;
  if (raw && typeof raw === "object" && typeof raw.stage === "string") {
    return raw;
  }
  return initialFlowState();
}

// ---------------------------------------------------------------------------
// TwiML assembly from flow actions (pure mapping, exported for tests)
// ---------------------------------------------------------------------------

export interface VoiceTurnOutcome {
  xml: string;
  /** The flow action chosen (for fixtures/tests + honest logging). */
  action: CallFlowAction;
  leadCaptured: boolean;
  transferedTo: string | null;
  status: CallStatus;
  metered: boolean;
}

function actionToTwiML(
  action: CallFlowAction,
  opts: { actionUrl: string; transferNumber: string | null; businessName: string | null },
): string {
  const { actionUrl, transferNumber } = opts;
  switch (action.kind) {
    case "gather":
      return twiml(gather({ actionUrl, prompt: action.prompt }));
    case "speak_then_gather":
      return twiml(
        ...action.preamble.map((line) => say(line)),
        gather({ actionUrl, prompt: action.prompt }),
      );
    case "emergency": {
      // SAFETY RULE: the KB script VERBATIM (one <Say> per script line, no
      // rewording), then the immediate transfer offer — no follow-up
      // qualification questions first.
      return twiml(
        ...action.scriptLines.map((line) => say(line)),
        gather({ actionUrl, prompt: PROMPTS.emergencyTransferOffer }),
      );
    }
    case "transfer": {
      const children: TwiMLElement[] = [
        ...action.preamble.map((line) => say(line)),
      ];
      if (transferNumber) {
        children.push(dial(transferNumber));
      } else {
        // No verified number to dial: honest apology + voicemail, never a
        // fake transfer.
        children.push(
          say("I'm sorry, but I couldn't complete the transfer. Please leave a message after the beep."),
          record({ actionUrl, prompt: "" }),
        );
      }
      return twiml(...children);
    }
    case "voicemail":
      return twiml(say(action.prompt), record({ actionUrl }));
    case "goodbye":
      return goodbyeDocument(action.text);
  }
}

// ---------------------------------------------------------------------------
// The main handler
// ---------------------------------------------------------------------------

export interface HandleVoiceWebhookArgs {
  params: VoiceWebhookParams;
  /** The FULL form-encoded param map — Twilio signs every field, so the
   *  signature is validated over this, not the filtered typed subset. */
  allParams: Record<string, string>;
  /** Full request URL (signature base) — the route passes request.url. */
  url: string;
  signature: string | null;
  authToken: string | null;
  store: VoiceCallStore;
  /** Injected clock (tests); real time in prod. */
  now?: Date;
}

/**
 * Handle one Twilio voice webhook POST. Returns the TwiML string to send —
 * the route only wraps it in a Response (content-type application/xml), and
 * Twilio NEVER sees an error page: every failure mode degrades to a spoken,
 * honest response or a hard 403.
 */
export async function handleVoiceWebhook(args: HandleVoiceWebhookArgs): Promise<{
  status: number;
  xml: string | null;
}> {
  const p = args.params;

  // 0. Signature FIRST (handled here so tests exercise the real path).
  if (!args.authToken) return { status: 403, xml: null };
  const sigValid = await verifySignature(args.url, args.allParams, args.signature, args.authToken);
  if (!sigValid) return { status: 403, xml: null };

  // 1. Idempotency + call record: a retried POST must not double-append.
  //    BUT the first request (no call row yet) has no prior state to protect —
  //    a retry of the FIRST request carries the same (empty) flow state, so
  //    replaying it is harmless; retries of LATER requests are blocked below.
  //    Unknown To number: the polite default flow with NO business lookup —
  //    we answer politely, take a voicemail, create nothing (documented).
  const callRow = p.CallSid ? await args.store.getCallBySid(p.CallSid).catch(() => null) : null;

  // 2. Callbacks that legitimately arrive AFTER the call reached an outcome
  //    (status callbacks, recording callbacks) must run BEFORE the terminal
  //    guard — the voicemail wrapup marks the call 'voicemail' and Twilio
  //    then delivers the recording to us. Retries of flow callbacks are
  //    answered honestly below.
  if (p.RecordingUrl && !p.SpeechResult) {
    return handleRecordingCallback(args, callRow, p);
  }
  if (p.CallStatus && ["completed", "busy", "failed", "no-answer", "canceled"].includes(p.CallStatus) && !p.SpeechResult) {
    return handleCallEnded(args, callRow, p);
  }
  if (callRow && callRow.status !== "in_progress") {
    // The call already reached an outcome — a retried flow callback is
    // answered politely, never re-processed.
    return { status: 200, xml: goodbyeDocument("Thanks for calling. Goodbye!") };
  }

  // 3. Load business context (or the honest unknown-number fallback).
  const toKey = p.To ? phoneKey(p.To) : "";
  const business = toKey ? await args.store.findBusinessByPhoneKey(toKey).catch(() => null) : null;

  // 4. Unknown business: polite default flow, no lookup, no lead (documented).
  if (!business) {
    return {
      status: 200,
      xml: apologyDocument(
        "Thank you for calling. We couldn't route your call automatically. Please leave a message after the beep.",
        null,
        args.url,
      ),
    };
  }

  // 5. Ensure the call row exists (creates on first touch for this CallSid).
  const { call, created } = await args.store
    .upsertCallBySid({
      businessId: business.id,
      callSid: p.CallSid,
      fromNumber: p.From,
      toNumber: p.To,
    })
    .catch(() => ({ call: null, created: false }) as unknown as { call: Call; created: boolean });
  if (!call) {
    // DB failure mid-call: apologize-and-transfer/voicemail (documented),
    // P4-I: the failure is RECORDED (system_errors → /admin/health), and
    // the caller still reaches a human or a voicemail — never a dead end.
    captureSystemError({
      source: "voice_call",
      businessId: business.id,
      message: "Voice call served degraded (call row unavailable - DB trouble): " + (p.CallSid ?? "unknown-sid"),
      detail: { callSid: p.CallSid ?? null, from: p.From ?? null, to: p.To ?? null, flow: "db_down" },
    });
    return { status: 200, xml: dbDownXml(args.url, business) };
  }

  // 6. Meter ONCE per call, on the first webhook touch (calls_handled).
  //    SOFT behavior: the gate is log-only — never drops a live call.
  if (created) {
    await args.store.meterCallHandled(business.id).catch((err) => {
      console.log("[voice] usage meter failed (call continues): " + String(err));
    });
  }

  // 7. First touch: greet + gather.
  if (created) {
    const flow = initialFlowState();
    const transcript: CallTranscript = {
      turns: [{ role: "ai", text: DEFAULT_GREETING(business.name || null), at: isoNow(args.now) }],
      flow: flow as unknown as Record<string, unknown>,
    };
    await args.store
      .writeCallTranscript({ businessId: business.id, callId: call.id, transcript })
      .catch(() => undefined);
    return {
      status: 200,
      xml: twiml(
        say(DEFAULT_GREETING(business.name || null)),
        gather({ actionUrl: args.url, prompt: PROMPTS.need }),
      ),
    };
  }

  // 8. Subsequent touch: run the pure flow engine over the caller's speech.
  const flow = flowOf(call.transcript);
  const turns = call.transcript?.turns ?? [];

  // 8a. Record the caller's utterance (including silence as an empty turn).
  const callerTurn: CallTurn = { role: "caller", text: p.SpeechResult ?? "", at: isoNow(args.now) };
  const turnsWithCaller = [...turns, callerTurn];

  // 8b. Step the pure flow engine.
  const ctx: CallFlowContext = {
    businessName: business.name || null,
    now: args.now ?? new Date(),
    timezone: business.timezone ?? null,
    hours: await args.store.listBusinessHours(business.id).catch(() => null),
    llm: await voiceLlmAsync(),
    afterHoursEmergency: readAfterHoursEmergency(business.settings),
  };
  const { action, state } = await stepCallFlow(flow, p.SpeechResult ?? "", ctx);

  // 8c. Lead capture when the flow reaches confirm (need + number in hand).
  let leadCaptured = false;
  let lead: Lead | null = null;
  if (action.kind === "speak_then_gather" && action.stage === "confirm" && !state.leadCaptured) {
    lead = await captureCallLead(args, business, state, turnsWithCaller, p);
    leadCaptured = lead != null;
    state.leadCaptured = leadCaptured;
  }

  // 8d. Emergency: capture the lead as emergency (script already spoken).
  if (action.kind === "emergency" && !state.leadCaptured) {
    lead = await captureEmergencyLead(args, business, state, turnsWithCaller, p);
    leadCaptured = lead != null;
    state.leadCaptured = leadCaptured;
  }

  // 8e. Transfer / voicemail / goodbye finalize the call row.
  let status: CallStatus = call.status;
  let transferedTo: string | null = null;
  if (action.kind === "transfer") {
    const rules = resolveTransferRules(
      {
        settings: business.settings,
        businessPhone: business.phone ?? null,
        afterHoursEmergency: readAfterHoursEmergency(business.settings),
      },
      state.emergency ? "emergency" : "human_request",
    );
    // P4-I: env-gated platform fallback — when the business has no verified
    // transfer number, TWILIO_VOICE_FORWARD_NUMBER (if set) is the last resort
    // before voicemail. Unset (default) → null → voicemail, exactly as before.
    transferedTo = rules.transferNumber ?? platformFallbackTransferNumber();
    status = "transfered";
    if (state.emergency && !leadCaptured) {
      // Lead capture (8d) already fired the emergency notification — only
      // notify here when no lead exists to attach it to.
      await args.store
        .notifyEmergency({
          businessId: business.id,
          payload: {
            source: "voice_call",
            callSid: p.CallSid,
            emergencyKey: state.emergency.key,
            emergencySeverity: state.emergency.severity,
            fromNumber: p.From,
            transferedTo: rules.transferNumber,
          },
        })
        .catch(() => undefined);
    }
  } else if (action.kind === "voicemail") {
    status = "voicemail";
  } else if (action.kind === "goodbye") {
    status = "completed";
  }

  // 8f. Append turns + persist flow state (classification stamps ride the
  //     flow state — the same stamps the SMS pipeline writes to jsonb).
  const aiLines = aiLinesForAction(action);
  const transcript: CallTranscript = {
    turns: [
      ...turnsWithCaller,
      ...aiLines.map((t) => ({ role: "ai" as const, text: t, at: isoNow(args.now) })),
    ],
    flow: state as unknown as Record<string, unknown>,
  };
  await args.store
    .writeCallTranscript({ businessId: business.id, callId: call.id, transcript })
    .catch(() => undefined);

  // 8h. Update the call row (status / transfer metadata).
  await args.store
    .updateCall(business.id, call.id, {
      ...(status !== call.status ? { status } : {}),
      ...(transferedTo ? { transferedTo } : {}),
    })
    .catch(() => undefined);

  // 8i. Post-call work for terminal outcomes (summary + lead attach).
  if (action.kind === "goodbye" || action.kind === "voicemail") {
    await finalizeCall(args, business.id, call.id, transcript.turns);
  }

  const xml = actionToTwiML(action, { actionUrl: args.url, transferNumber: transferedTo, businessName: business.name || null });
  return { status: 200, xml };
}

// ---------------------------------------------------------------------------
// Helpers (module-private)
// ---------------------------------------------------------------------------

type CallTurn = CallTranscriptTurn;

function isoNow(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

/**
 * The LLM seam for voice turns: configured key → the same PipelineLlm the
 * SMS path uses (KB-guardrailed prompt, output post-screened inside the
 * pipeline); no key → null → the rules tier (the keyless launch default).
 * Usage note: a voice call is metered ONCE on calls_handled — the AI turns
 * inside it are covered by the call, not double-metered on ai_turns
 * (documented usage-on-voice decision in the header).
 */
async function voiceLlmAsync(): Promise<PipelineLlm | null> {
  const { isLlmConfigured, readLlmConfig, llmComplete } = await import("~/lib/server/llm");
  if (!isLlmConfigured()) return null;
  const cfg = readLlmConfig();
  return {
    model: cfg?.model ?? "unknown",
    complete: (system, user, opts) =>
      llmComplete(system, user, {
        maxTokens: opts?.maxTokens ?? 500,
        timeoutMs: opts?.timeoutMs ?? 15_000,
        temperature: 0,
      }),
  };
}

/** Read afterHoursEmergency from the settings blob (sanitizer-shaped key). */
function readAfterHoursEmergency(settings: unknown): boolean {
  if (!settings || typeof settings !== "object") return true; // default is true
  const v = (settings as Record<string, unknown>).afterHoursEmergency;
  return typeof v === "boolean" ? v : true;
}

async function verifySignature(
  url: string,
  allParams: Record<string, string>,
  signature: string | null,
  authToken: string,
): Promise<boolean> {
  const { twilioSignatureIsValid } = await import("~/lib/server/twilioSignature");
  // Twilio signs ALL POST params (sorted by key, concatenated after the URL)
  // — validate over the exact map the body carried, same as the SMS path.
  return twilioSignatureIsValid({ url, params: allParams, signature, authToken });
}

/**
 * P4-I: platform-level human-transfer fallback, env-gated and DORMANT unless
 * the owner sets TWILIO_VOICE_FORWARD_NUMBER (an E.164 number you control).
 * It is the LAST rung of the voice failure ladder — used only when the
 * business has no verified transfer target and the AI path is degraded —
 * so it can never hijack a healthy business-configured transfer.
 */
export function platformFallbackTransferNumber(): string | null {
  return normalizeTransferNumber(process.env.TWILIO_VOICE_FORWARD_NUMBER ?? null);
}
/** DB-down TwiML: apologize, transfer when possible, else voicemail. */
function dbDownXml(url: string, business: { name: string; phone: string | null }): string {
  const rules = resolveTransferRules(
    {
      settings: undefined,
      businessPhone: business.phone ?? null,
      afterHoursEmergency: true,
      },
    "human_request",
  );
  return apologyDocument(
    "We're having technical trouble. Please hold while we transfer you, or leave a message after the beep.",
    // P4-I: platform forward fallback (env-gated) before falling to voicemail.
    rules.transferNumber ?? platformFallbackTransferNumber(),
    url,
  );
}

/** Build the lead input from captured flow state (honest fields only). */
function leadInputFromFlow(
  state: CallFlowState,
  p: VoiceWebhookParams,
  afterHours: boolean,
  transcriptTurns: CallTranscriptTurn[],
): CreateLeadInput {
  return {
    source: "missed_call",
    serviceNeed: state.serviceNeed ?? "Phone call — need not specified",
    urgency: state.urgency ?? (afterHours ? "same_day" : "flexible"),
    contactName: "Phone caller",
    contactPhone: state.callbackNumber ?? normalizePhone(p.From ?? "") ?? p.From ?? "unknown",
    description: null,
    notes: [
      "Captured by the AI voice receptionist.",
      afterHours ? "After-hours call." : "During business hours.",
      "Transcript: " + transcriptTurns.map((t) => (t.role === "caller" ? "Caller: " : "AI: ") + t.text).join(" | "),
    ].join(" "),
  };
}

async function captureCallLead(
  args: HandleVoiceWebhookArgs,
  business: { id: string; name: string },
  state: CallFlowState,
  turns: CallTranscriptTurn[],
  p: VoiceWebhookParams,
): Promise<Lead | null> {
  try {
    const afterHours = isAfterHours(
      args.now ?? new Date(),
      (business as { timezone?: string | null }).timezone ?? null,
      await args.store.listBusinessHours(business.id).catch(() => null),
    );
    const input = leadInputFromFlow(state, p, afterHours, turns);
    const lead = await args.store.captureLead({
      businessId: business.id,
      businessName: business.name,
      input,
    });
    return lead;
  } catch (err) {
    console.log("[voice] lead capture failed (call continues): " + String(err));
    return null;
  }
}

async function captureEmergencyLead(
  args: HandleVoiceWebhookArgs,
  business: { id: string; name: string },
  state: CallFlowState,
  turns: CallTranscriptTurn[],
  p: VoiceWebhookParams,
): Promise<Lead | null> {
  try {
    const afterHours = isAfterHours(
      args.now ?? new Date(),
      (business as { timezone?: string | null }).timezone ?? null,
      await args.store.listBusinessHours(business.id).catch(() => null),
    );
    const input = leadInputFromFlow(state, p, afterHours, turns);
    input.urgency = "emergency";
    input.serviceNeed = state.emergency
      ? state.emergency.name + " (emergency — safety script given)"
      : input.serviceNeed;
    const lead = await args.store.captureLead({
      businessId: business.id,
      businessName: business.name,
      input,
    });
    await args.store
      .notifyEmergency({
        businessId: business.id,
        payload: {
          source: "voice_call",
          callSid: p.CallSid,
          emergencyKey: state.emergency?.key,
          emergencySeverity: state.emergency?.severity,
          afterHours,
          fromNumber: p.From,
        },
      })
      .catch(() => undefined);
    return lead;
  } catch (err) {
    console.log("[voice] emergency lead capture failed (call continues): " + String(err));
    return null;
  }
}

/** The AI lines spoken for an action (transcript mirror of actionToTwiML). */
function aiLinesForAction(action: CallFlowAction): string[] {
  switch (action.kind) {
    case "gather":
      return [action.prompt];
    case "speak_then_gather":
      return [...action.preamble, action.prompt];
    case "emergency":
      return [...action.scriptLines, PROMPTS.emergencyTransferOffer];
    case "transfer":
      return [...action.preamble];
    case "voicemail":
      return [action.prompt];
    case "goodbye":
      return [action.text];
  }
}

/** Post-call: AI summary → stored on the call + attached to the lead. */
async function finalizeCall(
  args: HandleVoiceWebhookArgs,
  businessId: string,
  callId: string,
  turns: CallTranscriptTurn[],
): Promise<void> {
  try {
    const summary = await args.store.summarizeCall({ businessId, transcript: turns });
    if (summary) {
      await args.store.updateCall(businessId, callId, { aiSummary: summary });
    }
  } catch (err) {
    console.log("[voice] post-call summary failed (call record intact): " + String(err));
  }
}

/** Twilio status callback (call ended) — close the call row honestly. */
async function handleCallEnded(
  args: HandleVoiceWebhookArgs,
  callRow: Call | null,
  p: VoiceWebhookParams,
): Promise<{ status: number; xml: string | null }> {
  if (!callRow) return { status: 200, xml: null };
  try {
    const duration = p.CallDuration ? parseInt(p.CallDuration, 10) : null;
    const statusMap: Record<string, CallStatus> = {
      completed: callRow.status === "in_progress" ? "completed" : callRow.status,
      busy: "no_answer",
      failed: "failed",
      "no-answer": "no_answer",
      canceled: "failed",
    };
    const nextStatus = statusMap[p.CallStatus ?? "completed"] ?? "completed";
    await args.store.updateCall(callRow.businessId, callRow.id, {
      status: nextStatus,
      ...(duration != null && !Number.isNaN(duration) ? { durationSec: duration } : {}),
    });
    return { status: 200, xml: null };
  } catch (err) {
    console.log("[voice] status callback failed: " + String(err));
    return { status: 200, xml: null };
  }
}

/** Recording callback — store the voicemail URL (and duration) honestly. */
async function handleRecordingCallback(
  args: HandleVoiceWebhookArgs,
  callRow: Call | null,
  p: VoiceWebhookParams,
): Promise<{ status: number; xml: string | null }> {
  if (!callRow) return { status: 200, xml: null };
  try {
    const dur = p.RecordingDuration ? parseInt(p.RecordingDuration, 10) : null;
    await args.store.updateCall(callRow.businessId, callRow.id, {
      status: "voicemail",
      recordingUrl: p.RecordingUrl ?? null,
      ...(dur != null && !Number.isNaN(dur) ? { durationSec: dur } : {}),
    });
    return { status: 200, xml: goodbyeDocument("Thanks — your message has been received. Goodbye!") };
  } catch (err) {
    console.log("[voice] recording callback failed: " + String(err));
    return { status: 200, xml: null };
  }
}

// ---------------------------------------------------------------------------
// Production store (Neon via the existing query layer)
// ---------------------------------------------------------------------------

/** "server-only" style guard for the production store assembly. */
function assertNotBrowser(): void {
  if (typeof window !== "undefined") {
    throw new Error("neonVoiceCallStore is server-only.");
  }
}

/** Production VoiceCallStore over the existing query layer + LLM seam. */
export function neonVoiceCallStore(): VoiceCallStore {
  assertNotBrowser();
  return {
    async findBusinessByPhoneKey(key) {
      const q = await import("~/db/queries");
      const b = await q.getBusinessByPhoneKey(key);
      if (!b) return null;
      return {
        id: b.id,
        name: b.name,
        phone: b.phone,
        timezone: (b as unknown as { timezone?: string }).timezone ?? null,
        settings: (b as unknown as { settings?: unknown }).settings ?? {},
      };
    },
    async listBusinessHours(businessId) {
      const q = await import("~/db/queries");
      const rows = await q.listBusinessHours(businessId);
      return rows.map((r) => ({
        dayOfWeek: r.dayOfWeek,
        isOpen: r.isOpen,
        opensAt: r.opensAt,
        closesAt: r.closesAt,
      }));
    },
    async getCallBySid(callSid) {
      const q = await import("~/db/queries");
      return q.getCallBySid(callSid);
    },
    async upsertCallBySid(args) {
      const q = await import("~/db/queries");
      return q.upsertCallBySid(args);
    },
    async writeCallTranscript(args) {
      const q = await import("~/db/queries");
      return q.writeCallTranscript(args);
    },
    async updateCall(businessId, callId, input) {
      const q = await import("~/db/queries");
      return q.updateCall(businessId, callId, input as UpdateCallInputAlias);
    },
    async captureLead(args) {
      const { captureMissedCallLead } = await import("~/lib/server/textBack");
      const { lead } = await captureMissedCallLead(args.businessId, args.businessName, args.input);
      return lead;
    },
    async notifyEmergency(args) {
      const q = await import("~/db/queries");
      await q.createNotification(args.businessId, {
        type: "new_lead",
        payload: args.payload,
      });
    },
    async meterCallHandled(businessId) {
      const { loadPlanUsageContext, anchorForBusiness, meterAction } = await import("~/lib/server/usageGate");
      const q = await import("~/db/queries");
      const business = await q.getBusiness(businessId);
      if (!business) return;
      const ctx = await loadPlanUsageContext(businessId, anchorForBusiness(business));
      // SOFT LIMIT (documented at the top of this file): gate check is
      // log-only. The increment still happens — usage stays truthful.
      const { gateAction } = await import("~/lib/server/usageGate");
      const gate = gateAction({ ctx, axis: "calls_per_month" });
      if (!gate.allowed) {
        console.log(
          "[voice] calls_per_month limit reached for business " + businessId + " — call handled anyway (log-only soft limit)",
        );
      }
      await meterAction({ businessId, ctx, axis: "calls_per_month" });
    },
    async summarizeCall(args) {
      const { isLlmConfigured, llmComplete } = await import("~/lib/server/llm");
      if (!isLlmConfigured()) return null; // honest: no summary without an LLM
      const dialogue = args.transcript
        .filter((t) => t.text.trim().length > 0)
        .map((t) => (t.role === "caller" ? "Caller: " : "AI: ") + t.text)
        .join("\n");
      if (dialogue.trim().length === 0) return null;
      const system = [
        "You summarize a plumbing company's handled phone call for the owner.",
        "Return 1-3 plain sentences: what the caller needed, urgency, and the callback number if stated.",
        "Never invent details that were not said. No prices, no bookings, no promises.",
      ].join("\n");
      const raw = await llmComplete(system, dialogue, { maxTokens: 200, timeoutMs: 15_000, temperature: 0 });
      return raw.trim().slice(0, 600) || null;
    },
  };
}

type UpdateCallInputAlias = Parameters<typeof import("~/db/queries/calls").updateCall>[2];
