#!/usr/bin/env bun
/**
 * Fixture tests for the P3-E AI voice receptionist.
 * Run: bun scripts/test-voice.ts — no DB, no network, no keys.
 *
 * Two layers, mirroring test-sms/test-stripe/test-pipeline conventions:
 *   1. PURE units — TwiML builders (well-formedness + content), call-flow
 *      engine (extraction, stages, emergency VERBATIM rule, caps), transfer
 *      rules.
 *   2. WEBHOOK FIXTURES — recorded Twilio form-encoded bodies with VALID
 *      X-Twilio-Signature headers (HMAC-SHA1 computed with the test auth
 *      token) driven through handleVoiceWebhook against an in-memory
 *      VoiceCallStore (the same seam production wires to Neon):
 *        happy-path qualify call, emergency call (script verbatim + transfer
 *        offered), transfer path, voicemail wrapup, invalid signature 403,
 *        unknown business, usage increment (calls_handled), lead creation +
 *        notification fired, retry idempotency, recording callback.
 */
import { twiml, esc, say, gather, dial, record, goodbyeDocument, apologyDocument, DEFAULT_GREETING } from "../src/lib/voice/twiml";
import {
  stepCallFlow,
  initialFlowState,
  extractCallbackNumber,
  asksForHuman,
  MAX_EXCHANGES} from "../src/lib/voice/callFlow";
import { resolveTransferRules, normalizeTransferNumber } from "../src/lib/voice/transferRules";
import {
  receptionistConfigFromSettings,
  resolveReceptionistGreeting,
  confirmPromptOverride,
  matchFaq,
  policyNotesForLead,
  sanitizeReceptionistConfig,
  validateReceptionistInput,
  coerceFlowState,
  NEUTRAL_CONFIRM_PROMPT,
  type ReceptionistConfig,
} from "../src/lib/voice/receptionistConfig";
import {
  handleVoiceWebhook,
  parseVoiceParams,
  type VoiceCallStore,
} from "../src/lib/server/voiceReceptionist";
import { EMERGENCIES } from "../src/lib/server/kb";
import type { Call, Lead } from "../src/db/schema";

let failures = 0;
let checks = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log("FAIL " + name + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  } else {
    console.log("ok   " + name);
  }
}
function checkTrue(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  } else {
    console.log("ok   " + name);
  }
}

// ---------------------------------------------------------------------------
// 1. TwiML builders — well-formedness (structural asserts) + content
// ---------------------------------------------------------------------------

/** Minimal well-formedness checker: single root, balanced tags, quoted attrs. */
function assertWellFormedTwiML(name: string, xml: string): void {
  checkTrue(name + ": declaration", xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  checkTrue(name + ": single Response root", /^<\?xml[^>]*\?><Response>.*<\/Response>$/.test(xml) || /^<\?xml[^>]*\?><Response\/>$/.test(xml));
  const body = xml.replace(/^<\?xml[^>]*\?>/, "").replace(/^<Response>/, "").replace(/<\/Response>$/, "");
  const tagRe = /<\/?([A-Za-z][A-Za-z0-9]*)((?:\s+[a-zA-Z]+="[^"]*")*)\s*(\/?)>|([^<]+)/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  let ok = true;
  let rawAmp = false;
  while ((m = tagRe.exec(body)) !== null) {
    if (m[1]) {
      const selfClosing = m[3] === "/";
      if (selfClosing) continue;
      if (m[0].startsWith("</")) {
        const top = stack.pop();
        if (top !== m[1]) {
          ok = false;
          break;
        }
      } else {
        stack.push(m[1]);
      }
    } else {
      const text = m[4];
      if (/&(?!(amp|lt|gt|quot|apos);)/.test(text)) rawAmp = true;
    }
  }
  checkTrue(name + ": tags balanced", ok && stack.length === 0, JSON.stringify(stack));
  checkTrue(name + ": no raw ampersands", !rawAmp);
}

{
  const g = DEFAULT_GREETING("Rapid Rooter");
  // P4-O parity: an empty studio config resolves to byte-identical defaults.
  const EMPTY: ReceptionistConfig = sanitizeReceptionistConfig(undefined);
  check("greeting parity (named business)", resolveReceptionistGreeting(EMPTY, "Rapid Rooter"), g);
  check("greeting parity (null business)", resolveReceptionistGreeting(EMPTY, null), DEFAULT_GREETING(null));
  check("greeting persona in default", resolveReceptionistGreeting(sanitizeReceptionistConfig({ name: "Sally" }), "Rapid Rooter").includes("This is Sally."), true);
  check("greeting custom verbatim", resolveReceptionistGreeting(sanitizeReceptionistConfig({ greeting: "You reached Dave." }), "Rapid Rooter"), "You reached Dave.");
  check("greeting includes business name", g.includes("Rapid Rooter"), true);
  check("greeting null-name fallback", !DEFAULT_GREETING(null).includes("null"), true);

  const doc = twiml(gather({ actionUrl: "https://x.test/v?attempt=1", prompt: "How can we help?" }));
  assertWellFormedTwiML("gather doc", doc);
  checkTrue("gather has speech input", doc.includes('input="speech"'));
  checkTrue("gather action attr", doc.includes('action="https://x.test/v?attempt=1"'));
  checkTrue("gather prompt escaped + present", doc.includes("How can we help?"));
  checkTrue("gather auto speech timeout", doc.includes('speechTimeout="auto"'));
  checkTrue("gather actionOnEmptyResult", doc.includes('actionOnEmptyResult="true"'));

  const escDoc = twiml(say('A & B < "C" > D\'s leak'));
  assertWellFormedTwiML("escape doc", escDoc);
  check("esc() output", esc('A & B < "C" > D\'s'), "A &amp; B &lt; &quot;C&quot; &gt; D&apos;s");

  const dialDoc = twiml(say("Transferring."), dial("+15125550100"));
  assertWellFormedTwiML("dial doc", dialDoc);
  checkTrue("dial contains number", dialDoc.includes("+15125550100"));

  const recDoc = twiml(record({ actionUrl: "https://x.test/rec" }));
  assertWellFormedTwiML("record doc", recDoc);
  checkTrue("record transcribe", recDoc.includes('transcribe="true"'));
  checkTrue("record action", recDoc.includes('action="https://x.test/rec"'));

  assertWellFormedTwiML("goodbye doc", goodbyeDocument("Goodbye!"));
  assertWellFormedTwiML("apology w/ transfer", apologyDocument("Sorry.", "+15125550100", "https://x.test/v"));
  assertWellFormedTwiML("apology w/o transfer", apologyDocument("Sorry.", null, "https://x.test/v"));
  checkTrue("apology transfers when number given", apologyDocument("Sorry.", "+15125550100", "https://x.test/v").includes("+15125550100"));
  checkTrue("apology records when no number", apologyDocument("Sorry.", null, "https://x.test/v").includes("<Record"));
}

// ---------------------------------------------------------------------------
// 2. Call-flow engine (pure)
// ---------------------------------------------------------------------------

const CTX = {
  businessName: "Rapid Rooter Plumbing",
  now: new Date("2026-01-15T14:00:00Z"),
  timezone: "America/Chicago",
  hours: [
    { dayOfWeek: 0, isOpen: false, opensAt: null, closesAt: null },
    { dayOfWeek: 1, isOpen: true, opensAt: "08:00", closesAt: "17:00" },
    { dayOfWeek: 2, isOpen: true, opensAt: "08:00", closesAt: "17:00" },
    { dayOfWeek: 3, isOpen: true, opensAt: "08:00", closesAt: "17:00" },
    { dayOfWeek: 4, isOpen: true, opensAt: "08:00", closesAt: "17:00" },
    { dayOfWeek: 5, isOpen: true, opensAt: "08:00", closesAt: "17:00" },
    { dayOfWeek: 6, isOpen: false, opensAt: null, closesAt: null },
  ],
  llm: null,
  afterHoursEmergency: true,
};

{
  check("extract 10-digit", extractCallbackNumber("my number is 512-555-0134"), "+15125550134");
  check("extract 11-digit", extractCallbackNumber("1 512 555 0134"), "+15125550134");
  check("extract spoken digits", extractCallbackNumber("five one two five five five zero one three four"), null);
  check("extract garbage", extractCallbackNumber("it is urgent"), null);
  check("human request yes", asksForHuman("let me talk to a real person"), true);
  check("human request no", asksForHuman("my sink is leaking"), false);

  // Happy path: need → number → confirm → goodbye.
  (async () => {
    let s = initialFlowState();
    let r = await stepCallFlow(s, "my kitchen sink is leaking", CTX);
    check("turn1 advances to callback_number", r.action.stage, "callback_number");
    check("turn1 captured serviceNeed", r.state.serviceNeed != null, true);
    check("turn1 exchanges 1", r.state.exchanges, 1);
    s = r.state;
    r = await stepCallFlow(s, "5125550134", CTX);
    check("turn2 advances to confirm", r.action.stage, "confirm");
    check("turn2 captured callback", r.state.callbackNumber, "+15125550134");
    checkTrue("turn2 confirm prompt offers transfer", r.action.kind === "speak_then_gather" && r.action.prompt.includes("transfer"));
    s = r.state;
    r = await stepCallFlow(s, "no thanks", CTX);
    check("turn3 goodbye", r.action.kind, "goodbye");

    // Emergency: script VERBATIM, transfer offered, never qualification first.
    s = initialFlowState();
    r = await stepCallFlow(s, "there is a gas smell in my house", CTX);
    check("emergency action kind", r.action.kind, "emergency");
    check("emergency key", r.state.emergency?.key, "gas_odor");
    const gasEntry = EMERGENCIES.find((e) => e.key === "gas_odor");
    check("emergency script VERBATIM", r.action.kind === "emergency" && r.action.scriptLines.join("\n"), gasEntry?.customerScript.join("\n"));
    checkTrue("emergency stage never goes to confirm", r.action.kind === "emergency" && r.action.stage === "need");
    // Declining the transfer → emergency voicemail (no re-qualification).
    s = r.state;
    r = await stepCallFlow(s, "no just send someone", CTX);
    check("emergency decline → voicemail", r.action.kind, "voicemail");

    // Flooding emergency (different entry).
    s = initialFlowState();
    r = await stepCallFlow(s, "my basement is flooding and the water will not shut off", CTX);
    check("flooding emergency", r.state.emergency?.key, "active_flooding");

    // Silence handling: one nudge then voicemail.
    s = initialFlowState();
    r = await stepCallFlow(s, "   ", CTX);
    check("silence nudge", r.action.kind, "gather");
    r = await stepCallFlow(r.state, "", CTX);
    check("second silence → voicemail", r.action.kind, "voicemail");

    // Exchange cap.
    s = initialFlowState();
    s.exchanges = MAX_EXCHANGES;
    r = await stepCallFlow(s, "i still need something", CTX);
    check("cap → voicemail", r.action.kind, "voicemail");

    // Transfer request mid-flow.
    s = initialFlowState();
    r = await stepCallFlow(s, "transfer me to someone", CTX);
    check("human request → transfer", r.action.kind, "transfer");

    // After-hours: same-day urgency stamped by the pipeline (fail toward
    // escalation on unreadable hours) — just assert the pipeline ran stamps.
    s = initialFlowState();
    r = await stepCallFlow(s, "my kitchen sink is leaking", { ...CTX, timezone: null, hours: null });
    check("afterHours classification stamp", r.state.classification?.tier, "rules");
  })();
}

// ---------------------------------------------------------------------------
// 3. Transfer rules (pure)
// ---------------------------------------------------------------------------

{
  check("explicit E164 wins", resolveTransferRules({ settings: { transferNumber: "+15125550199" }, businessPhone: "+15125550100", afterHoursEmergency: true }, "emergency").transferNumber, "+15125550199");
  check("business phone fallback", resolveTransferRules({ settings: {}, businessPhone: "(512) 555-0100", afterHoursEmergency: true }, "emergency").transferNumber, "+15125550100");
  check("no target", resolveTransferRules({ settings: {}, businessPhone: null, afterHoursEmergency: true }, "emergency").transferNumber, null);
  check("emergency always offered", resolveTransferRules({ settings: {}, businessPhone: "+15125550100", afterHoursEmergency: false }, "emergency").offersTransfer, true);
  check("after-hours gated on pref", resolveTransferRules({ settings: {}, businessPhone: "+15125550100", afterHoursEmergency: false }, "after_hours").offersTransfer, false);
  check("after-hours allowed with pref", resolveTransferRules({ settings: {}, businessPhone: "+15125550100", afterHoursEmergency: true }, "after_hours").offersTransfer, true);
  check("human request offered", resolveTransferRules({ settings: {}, businessPhone: "+15125550100", afterHoursEmergency: false }, "human_request").offersTransfer, true);
  check("undialable short number rejected", normalizeTransferNumber("512"), null);
  // P4-O precedence: studio key > legacy top-level key > business phone.
  check("studio wins over legacy", resolveTransferRules({ settings: { transferNumber: "+15125550188", receptionist: { transferNumber: "+15125550199" } }, businessPhone: "+15125550100", afterHoursEmergency: true }, "emergency").transferNumber, "+15125550199");
  check("legacy fallback", resolveTransferRules({ settings: { transferNumber: "+15125550188" }, businessPhone: "+15125550100", afterHoursEmergency: true }, "emergency").transferNumber, "+15125550188");
  check("empty studio falls through to legacy", resolveTransferRules({ settings: { transferNumber: "+15125550188", receptionist: { transferNumber: "" } }, businessPhone: "+15125550100", afterHoursEmergency: true }, "emergency").transferNumber, "+15125550188");
}

// ---------------------------------------------------------------------------
// 4. Webhook fixtures (in-memory store, real signature math)
// ---------------------------------------------------------------------------

const AUTH_TOKEN = "test-auth-token";
const WEBHOOK_URL = "https://missedcall.test/api/webhooks/twilio/voice";

async function signParams(url: string, params: Record<string, string>, token = AUTH_TOKEN): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

function encodeForm(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function makeStore(opts?: {
  failDb?: boolean;
  failWrites?: boolean;
  transferNumber?: string | null;
  /** P4-O: the businesses.settings jsonb blob (studio config rides here). */
  settings?: Record<string, unknown>;
}): VoiceCallStore & {
  calls: Map<string, Call>;
  leads: Lead[];
  notifications: { businessId: string; payload: Record<string, unknown> }[];
  usage: number;
  summarizeInstructions: (string | undefined)[];
} {
  const calls = new Map<string, Call>();
  const leads: Lead[] = [];
  const notifications: { businessId: string; payload: Record<string, unknown> }[] = [];
  let usage = 0;
  let callSeq = 0;
  let leadSeq = 0;
  const biz = {
    id: "biz-1",
    name: "Rapid Rooter Plumbing",
    phone: opts?.transferNumber === undefined ? "+15125550100" : opts.transferNumber,
    timezone: "America/Chicago",
    settings: opts?.settings ?? {},
  };
  const fail = opts?.failDb === true;
  const failWrites = opts?.failWrites === true;
  return {
    calls,
    leads,
    notifications,
    summarizeInstructions: [] as (string | undefined)[],
    get usage() { return usage; },
    async findBusinessByPhoneKey(key) {
      if (fail) throw new Error("db down");
      return key === "5125550100" ? biz : null;
    },
    async listBusinessHours() {
      if (fail) throw new Error("db down");
      return CTX.hours;
    },
    async getCallBySid(callSid) {
      if (fail) throw new Error("db down");
      return calls.get(callSid) ?? null;
    },
    async upsertCallBySid(args) {
      if (fail || failWrites) throw new Error("db down");
      const existing = calls.get(args.callSid);
      if (existing) return { call: existing, created: false };
      callSeq += 1;
      const row: Call = {
        id: "call-" + callSeq,
        businessId: args.businessId,
        callSid: args.callSid,
        fromNumber: args.fromNumber,
        toNumber: args.toNumber,
        status: "in_progress",
        durationSec: null,
        recordingUrl: null,
        transcript: { turns: [] },
        aiSummary: null,
        leadId: null,
        transferedTo: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      calls.set(args.callSid, row);
      return { call: row, created: true };
    },
    async writeCallTranscript(args) {
      if (fail) throw new Error("db down");
      for (const row of calls.values()) {
        if (row.id === args.callId && row.businessId === args.businessId) {
          row.transcript = args.transcript;
        }
      }
    },
    async updateCall(businessId, callId, input) {
      if (fail) throw new Error("db down");
      for (const row of calls.values()) {
        if (row.id === callId && row.businessId === businessId) {
          Object.assign(row, input as Partial<Call>);
          return row;
        }
      }
      return null;
    },
    async captureLead(args) {
      if (fail) throw new Error("db down");
      leadSeq += 1;
      const lead: Lead = {
        id: "lead-" + leadSeq,
        businessId: args.businessId,
        source: args.input.source ?? "missed_call",
        status: "new",
        priority: "normal",
        serviceNeed: args.input.serviceNeed,
        urgency: args.input.urgency ?? "flexible",
        contactName: args.input.contactName,
        contactPhone: args.input.contactPhone,
        contactEmail: null,
        contactAddress: null,
        description: args.input.description ?? null,
        estimatedValueCents: null,
        estimatedJobValueLowCents: null,
        estimatedJobValueHighCents: null,
        actualWonValueCents: null,
        pipelineValueCents: null,
        notes: args.input.notes ?? null,
        convertedAt: null,
        serviceAreaStatus: "unknown",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      leads.push(lead);
      notifications.push({ businessId: args.businessId, payload: { leadId: lead.id, channel: "voice" } });
      return lead;
    },
    async notifyEmergency(args) {
      notifications.push({ businessId: args.businessId, payload: args.payload });
    },
    async meterCallHandled() {
      if (fail) throw new Error("db down");
      usage += 1;
    },
    async summarizeCall(args) {
      // P4-O: capture what the driver passed so tests can assert the studio
      // instructions reach the summary prompt.
      (this as unknown as { summarizeInstructions: (string | undefined)[] }).summarizeInstructions.push(args.instructions);
      const spoken = args.transcript.filter((t) => t.text.trim().length > 0).length;
      if (spoken === 0) return null;
      return `Voice call handled: ${spoken} turns exchanged.`;
    },
  };
}

async function postVoice(
  store: ReturnType<typeof makeStore>,
  fields: Record<string, string>,
  opts?: { token?: string | null; signature?: string; url?: string },
): Promise<{ status: number; xml: string | null }> {
  const url = opts?.url ?? WEBHOOK_URL;
  const signature = opts?.signature !== undefined ? opts.signature : await signParams(url, fields, opts?.token ?? AUTH_TOKEN);
  return handleVoiceWebhook({
    params: parseVoiceParams(encodeForm(fields)).typed,
    allParams: parseVoiceParams(encodeForm(fields)).all,
    url,
    signature,
    authToken: opts?.token ?? AUTH_TOKEN,
    store,
  });
}

const CALL_BASE = {
  CallSid: "CA-fixture-1",
  From: "+15125550134",
  To: "+15125550100",
};

(async () => {
  // ---- Happy path: qualify call ------------------------------------------
  {
    const store = makeStore();
    // Turn 0: inbound call (no speech) → greeting + gather.
    let res = await postVoice(store, { ...CALL_BASE });
    check("happy t0 status", res.status, 200);
    checkTrue("happy t0 greeting", res.xml?.includes("Rapid Rooter Plumbing") ?? false);
    checkTrue("happy t0 gather", res.xml?.includes("<Gather") ?? false);
    check("happy t0 call row created", store.calls.size, 1);
    check("happy t0 usage incremented", store.usage, 1);

    // Turn 1: need.
    res = await postVoice(store, { ...CALL_BASE, SpeechResult: "my kitchen sink is leaking badly" });
    check("happy t1 status", res.status, 200);
    checkTrue("happy t1 ack + number prompt", res.xml?.includes("best callback number") ?? false);

    // Turn 2: number → confirm + transfer offer.
    res = await postVoice(store, { ...CALL_BASE, SpeechResult: "512 555 0134" });
    checkTrue("happy t2 confirm", res.xml?.includes("transfer you") ?? false);

    // Turn 3: decline → goodbye; lead exists, notification fired.
    res = await postVoice(store, { ...CALL_BASE, SpeechResult: "no that's all" });
    checkTrue("happy t3 goodbye", res.xml?.includes("Goodbye") ?? false);
    check("happy leads created", store.leads.length, 1);
    const lead = store.leads[0];
    check("happy lead source", lead.source, "missed_call");
    check("happy lead urgency", lead.urgency, "same_day");
    checkTrue("happy lead callback number", lead.contactPhone === "+15125550134" || lead.contactPhone.includes("5125550134"));
    check("happy notifications", store.notifications.length, 1);
    check("happy usage still 1 (metered once)", store.usage, 1);
    const row = store.calls.get("CA-fixture-1");
    checkTrue("happy call row completed", row?.status === "completed");
    checkTrue("happy ai summary stored", (row?.aiSummary ?? "").length > 0);
    checkTrue("happy transcript has turns", (row?.transcript.turns.length ?? 0) >= 6);
  }

  // ---- Retry idempotency ---------------------------------------------------
  {
    const store = makeStore();
    await postVoice(store, { ...CALL_BASE });
    await postVoice(store, { ...CALL_BASE, SpeechResult: "my kitchen sink is leaking" });
    // Twilio retries the same Gather POST: state replays harmlessly (same
    // utterance appended again is the one honest duplication a retry can
    // cause — the lead/usage/notification paths stay single-shot).
    await postVoice(store, { ...CALL_BASE, SpeechResult: "my kitchen sink is leaking" });
    check("retry usage still 1", store.usage, 1);
  }

  // ---- Emergency call -------------------------------------------------------
  {
    const store = makeStore({ transferNumber: "+15125550999" });
    await postVoice(store, { ...CALL_BASE });
    const res = await postVoice(store, { ...CALL_BASE, SpeechResult: "there is a gas smell in my house" });
    check("emergency status", res.status, 200);
    const gas = EMERGENCIES.find((e) => e.key === "gas_odor");
    // VERBATIM: every script line appears escaped in the TwiML.
    for (const line of gas?.customerScript ?? []) {
      checkTrue("emergency script line verbatim: " + line.slice(0, 24), res.xml?.includes(esc(line)) ?? false);
    }
    checkTrue("emergency transfer offered", res.xml?.includes("Say yes, or stay on the line") ?? false);
    checkTrue("emergency asks no qualification first", !(res.xml?.includes("What's the best callback number") ?? true));
    check("emergency lead created immediately", store.leads.length, 1);
    check("emergency lead urgency", store.leads[0]?.urgency, "emergency");
    checkTrue("emergency notification fired", store.notifications.length >= 1);
    checkTrue("emergency transcript holds script", JSON.stringify(store.calls.get("CA-fixture-1")?.transcript.turns.map((t) => t.text)).includes("leave the building"));

    // Caller accepts the transfer → Dial to the number.
    const res2 = await postVoice(store, { ...CALL_BASE, SpeechResult: "yes please" });
    checkTrue("emergency accept → Dial", res2.xml?.includes("<Dial>+15125550999</Dial>") ?? false);
    const row = store.calls.get("CA-fixture-1");
    check("emergency transfered_to", row?.transferedTo, "+15125550999");
    check("emergency call status", row?.status, "transfered");
  }

  // ---- Emergency without a transfer number → voicemail wrapup ---------------
  {
    const store = makeStore({ transferNumber: null });
    await postVoice(store, { ...CALL_BASE });
    await postVoice(store, { ...CALL_BASE, SpeechResult: "my basement is flooding" });
    const res = await postVoice(store, { ...CALL_BASE, SpeechResult: "no" });
    checkTrue("emergency no-target → Record voicemail", res.xml?.includes("<Record") ?? false);
    checkTrue("emergency no-target → no Dial", !(res.xml?.includes("<Dial>") ?? true));
  }

  // ---- Transfer path (non-emergency, caller asks) ---------------------------
  {
    const store = makeStore({ transferNumber: "+15125550999" });
    await postVoice(store, { ...CALL_BASE });
    const res = await postVoice(store, { ...CALL_BASE, SpeechResult: "transfer me to a person" });
    checkTrue("transfer request → Dial", res.xml?.includes("<Dial>+15125550999</Dial>") ?? false);
    check("transfer status", store.calls.get("CA-fixture-1")?.status, "transfered");
  }

  // ---- Voicemail wrapup (silence → cap) --------------------------------------
  {
    const store = makeStore();
    await postVoice(store, { ...CALL_BASE });
    await postVoice(store, { ...CALL_BASE, SpeechResult: "" });
    const res = await postVoice(store, { ...CALL_BASE, SpeechResult: "" });
    checkTrue("silence cap → voicemail Record", res.xml?.includes("<Record") ?? false);
    check("voicemail status", store.calls.get("CA-fixture-1")?.status, "voicemail");

    // Recording callback stores the URL + duration.
    const res2 = await postVoice(store, {
      ...CALL_BASE,
      RecordingUrl: "https://api.twilio.com/Recordings/RE123",
      RecordingDuration: "27",
    });
    const row = store.calls.get("CA-fixture-1");
    check("recording url stored", row?.recordingUrl, "https://api.twilio.com/Recordings/RE123");
    check("recording duration stored", row?.durationSec, 27);
    checkTrue("recording callback says thanks", res2.xml?.includes("Goodbye") ?? false);
  }

  // ---- Invalid signature → 403 -----------------------------------------------
  {
    const store = makeStore();
    const res = await postVoice(store, { ...CALL_BASE }, { signature: "bogussignature==" });
    check("invalid signature status", res.status, 403);
    check("invalid signature no xml", res.xml, null);
    check("invalid signature: no call row", store.calls.size, 0);
  }

  // ---- Unknown business → polite default, no business writes -----------------
  {
    const store = makeStore();
    const res = await postVoice(store, { ...CALL_BASE, To: "+18005559999" });
    check("unknown business status", res.status, 200);
    checkTrue("unknown business polite voicemail", res.xml?.includes("leave a message") ?? false);
    check("unknown business: no call rows", store.calls.size, 0);
    check("unknown business: no usage", store.usage, 0);
  }

  // ---- DB down → apology TwiML, never an error page --------------------------
  {
    // Full outage at lookup time: honest unknown-business fallback — polite,
    // voicemail, no writes, still 200.
    const storeDown = makeStore({ failDb: true });
    const res0 = await postVoice(storeDown, { ...CALL_BASE });
    check("db down (full) status", res0.status, 200);
    checkTrue("db down (full) polite voicemail", res0.xml?.includes("leave a message") ?? false);
    check("db down (full) no rows", storeDown.calls.size, 0);

    // Mid-call outage (reads fine, writes fail): apologize + transfer to the
    // shop line — Twilio never sees an error page on a live call.
    const store = makeStore({ failWrites: true });
    const res = await postVoice(store, { ...CALL_BASE });
    check("db down (writes) status", res.status, 200);
    checkTrue("db down (writes) apology", res.xml?.includes("technical trouble") ?? false);
    checkTrue("db down (writes) transfers to shop line", res.xml?.includes("<Dial>+15125550100</Dial>") ?? false);
  }

  // ---- Signature verified against the exact URL (query strings count) --------
  {
    const store = makeStore();
    const urlWithQuery = WEBHOOK_URL + "?attempt=2";
    const fields = { ...CALL_BASE, SpeechResult: "my sink is leaking" };
    const sig = await signParams(urlWithQuery, fields);
    const res = await postVoice(store, fields, { url: urlWithQuery, signature: sig });
    check("signed-with-query accepted", res.status, 200);
    const badSig = await signParams(WEBHOOK_URL, fields); // signed the wrong URL
    const res2 = await postVoice(store, fields, { url: urlWithQuery, signature: badSig });
    check("wrong-URL signature rejected", res2.status, 403);
  }

  // ---- Wrong auth token rejected ---------------------------------------------
  {
    const store = makeStore();
    const fields = { ...CALL_BASE };
    // Signed with the WRONG token, validated against the real one → 403.
    const wrongSig = await signParams(WEBHOOK_URL, fields, "other-token");
    const res = await postVoice(store, fields, { signature: wrongSig });
    check("wrong token rejected", res.status, 403);
  }
  // ---- P4-O receptionist studio: handler consumption --------------------------
  {
    // Custom greeting spoken VERBATIM on first touch.
    const store = makeStore({ settings: { receptionist: { greeting: "Thanks for calling Rapid Rooter, you reached Dave!" } } });
    const res = await postVoice(store, { ...CALL_BASE });
    checkTrue("studio greeting verbatim", res.xml?.includes("Thanks for calling Rapid Rooter, you reached Dave!") ?? false);
    checkTrue("studio greeting replaces default", !(res.xml?.includes("Thank you for calling Rapid Rooter Plumbing. This is the office assistant.") ?? true));
  }
  {
    // Persona name rides the default greeting.
    const store = makeStore({ settings: { receptionist: { name: "Sally" } } });
    const res = await postVoice(store, { ...CALL_BASE });
    checkTrue("studio persona in default greeting", res.xml?.includes("This is Sally.") ?? false);
  }
  {
    // neverPromise: the default confirm line is a promise — it must be replaced.
    const store = makeStore({ settings: { receptionist: { neverPromise: "Never quote prices." } } });
    let res = await postVoice(store, { ...CALL_BASE });
    res = await postVoice(store, { ...CALL_BASE, SpeechResult: "my kitchen sink is leaking" });
    res = await postVoice(store, { ...CALL_BASE, SpeechResult: "512 555 0134" });
    checkTrue("neverPromise confirm override spoken", res.xml?.includes("So I have that down. Would you like me to transfer you to someone right now, or stay on the line to leave a message?") ?? false);
    checkTrue("neverPromise default promise line dropped", !(res.xml?.includes("will reach out shortly") ?? true));
    // The policy rides the captured lead's notes.
    checkTrue("neverPromise on lead notes", (store.leads[0]?.notes ?? "").includes("Owner policy — the AI must never promise: Never quote prices."));
  }
  {
    // Emergency policies reach the emergency lead notes AND the notification.
    const store = makeStore({ settings: { receptionist: { emergencyHandling: "Ask for the address first.", escalationNotes: "Commercial jobs go to Mike." } } });
    let res = await postVoice(store, { ...CALL_BASE });
    res = await postVoice(store, { ...CALL_BASE, SpeechResult: "there is a gas smell in my house" });
    checkTrue("emergency policies on lead notes", (store.leads[0]?.notes ?? "").includes("Owner emergency handling: Ask for the address first.") && (store.leads[0]?.notes ?? "").includes("Owner escalation rules: Commercial jobs go to Mike."));
    const emergencyNote = store.notifications.find((n) => n.payload.emergencyHandling !== undefined);
    checkTrue("emergencyHandling in notification payload", emergencyNote?.payload.emergencyHandling === "Ask for the address first.");
    checkTrue("escalationNotes in notification payload", emergencyNote?.payload.escalationNotes === "Commercial jobs go to Mike.");
    check("emergency still captured", store.leads.length, 1);
  }
  {
    // Studio transferNumber wins over the legacy top-level key.
    const store = makeStore({ settings: { transferNumber: "+15125550188", receptionist: { transferNumber: "+15125550199" } } });
    let res = await postVoice(store, { ...CALL_BASE });
    res = await postVoice(store, { ...CALL_BASE, SpeechResult: "transfer me to someone" });
    checkTrue("studio transfer target dialed", res.xml?.includes("<Dial>+15125550199</Dial>") ?? false);
  }
  {
    // FAQ: utterances that match a configured FAQ get the answer spoken (pure
    // flow level — the rules tier must not extract a need from the question).
    const faqs = [{ id: "f1", question: "What are your business hours?", answer: "We are open seven days a week from eight to six." }];
    const r = await stepCallFlow(initialFlowState(), "what are your business hours", { ...CTX, faqs });
    checkTrue("faq answer spoken in need stage", r.action.kind === "speak_then_gather" && r.action.preamble[0] === faqs[0].answer);
    checkTrue("faq flow resumes at need", r.action.kind === "speak_then_gather" && r.action.stage === "need");
    // And in the callback_number stage a non-number answer re-asks.
    const s2 = { ...initialFlowState(), stage: "callback_number" as const, serviceNeed: "leak" };
    const r2 = await stepCallFlow(s2, "what are your business hours", { ...CTX, faqs });
    checkTrue("faq answer in callback_number stage", r2.action.kind === "speak_then_gather" && r2.action.preamble[0] === faqs[0].answer);
    checkTrue("faq keeps asking for the number", r2.action.kind === "speak_then_gather" && r2.action.stage === "callback_number");
    // Without FAQs in context, identical input behaves exactly as pre-studio.
    const r3 = await stepCallFlow(initialFlowState(), "what are your business hours", CTX);
    checkTrue("no faqs in ctx → unchanged behavior", r3.action.kind, "gather");
  }
  {
    // Company instructions reach the post-call summary prompt.
    const store = makeStore({ settings: { receptionist: { instructions: "Flag renters differently." } } });
    let res = await postVoice(store, { ...CALL_BASE });
    res = await postVoice(store, { ...CALL_BASE, SpeechResult: "my kitchen sink is leaking" });
    res = await postVoice(store, { ...CALL_BASE, SpeechResult: "512 555 0134" });
    res = await postVoice(store, { ...CALL_BASE, SpeechResult: "no that's all" });
    checkTrue("summary goodbye", res.xml?.includes("Goodbye") ?? false);
    check("instructions reached summarizeCall", store.summarizeInstructions[store.summarizeInstructions.length - 1], "Flag renters differently.");
  }
})().then(() => {
  console.log("");
  console.log(checks + " checks, " + failures + " failures");
  process.exit(failures === 0 ? 0 : 1);
});
