/**
 * Classification + advice pipeline (P3-B): the bridge between the rules
 * classifier, the LLM, and the plumbing knowledge base.
 *
 * THE CONTRACT (milestone M1, "AI core"):
 *
 *   Tier selection (mirrors textBack.ts history):
 *     1. LLM configured and healthy  → LLM tier      (tierReason "primary")
 *     2. LLM_API_KEY absent          → rules tier    (tierReason "default")
 *     3. LLM configured but errored  → rules tier    (tierReason "backstop")
 *   The product works fully WITHOUT LLM_API_KEY — rules + KB is the launch
 *   default, never a degraded afterthought.
 *
 *   KB enrichment (both tiers): the rules/LLM classification and the KB
 *   emergency resolver (resolveEmergency) BOTH feed the result. If either
 *   says emergency, the result is emergency — fail toward emergency.
 *
 *   Reply production (honest, KB-driven):
 *     - Emergency            → the KB customer-safety script VERBATIM
 *                              ("kb_emergency_script"); never LLM text.
 *     - Pricing question     → the KB FAQ pricing policy (quote after
 *                              diagnosis) — "kb_faq_pricing".
 *     - Advice request (LLM) → LLM answer POST-SCREENED through
 *                              screenAdviceText(); deny AND escalate results
 *                              are stripped and replaced with the honest
 *                              human-routing fallback ("human_routing").
 *                              Raw LLM output is never surfaced unreviewed.
 *     - Anything else        → no reply produced (null).
 *
 *   Stamps on every classification: `classifier` ("llm"|"rules"), `kbVersion`
 *   (KB_VERSION), `tier` + `tierReason` (why that tier ran), and for
 *   emergencies `emergencyKey` / `emergencySeverity` / `afterHoursEscalation`.
 *
 * PURE MODULE, NO I/O: no DB, no env reads, no network at import or runtime.
 * The LLM is injected as a `PipelineLlm` (production: llmComplete; tests: a
 * stub), the clock/hours/timezone as arguments — so the whole pipeline is
 * unit-testable keyless and DBless (scripts/test-pipeline.ts), exactly like
 * classify.ts before it. Callers (src/lib/server/textBack.ts) own the I/O.
 */

import type { MessageClassification } from "~/db/schema";
import { classifyInboundText } from "./classify";
import {
  KB_VERSION,
  FAQ_ENTRIES,
  SERVICES,
  resolveEmergency,
  screenAdviceRequest,
  screenAdviceText,
  buildSystemPrompt,
  normalizeKbText,
  type EmergencySeverity,
  type FaqEntry,
  type GuardrailResult,
} from "./kb";

/** Fields the LLM JSON contract expects (exported for tests + audit). */
export const LLM_JSON_FIELDS = [
  "serviceNeed",
  "urgency",
  "priority",
  "contactName",
  "contactEmail",
  "serviceAddress",
  "safetyConcern",
  "notes",
  "reply",
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Injectable LLM seam. Production passes llmComplete; tests pass stubs. */
export interface PipelineLlm {
  /** Model id stamped into `classification.model`. */
  model: string;
  complete(system: string, user: string, opts?: { maxTokens?: number; timeoutMs?: number }): Promise<string>;
}

/** Shape of the business_hours rows the pipeline needs (structural subset). */
export interface PipelineHoursRow {
  dayOfWeek: number; // 0 = Sunday … 6 = Saturday (matches Date#getDay())
  isOpen: boolean;
  opensAt: string | null; // "HH:MM:SS", null when closed
  closesAt: string | null;
}

export interface PipelineInput {
  body: string;
  /** Wall-clock "now" — injected for determinism (tests), real time in prod. */
  now: Date;
  /** Business IANA timezone (businesses.timezone); null when unreadable. */
  timezone: string | null;
  /** business_hours rows; null/empty when none configured or unreadable. */
  hours: PipelineHoursRow[] | null;
  /** null = LLM not configured (LLM_API_KEY absent) → rules are the default. */
  llm: PipelineLlm | null;
}

/** Where the produced reply text came from — stamped as `replySource`. */
export type ReplySource =
  | "kb_emergency_script" // KB customerScript, verbatim (emergency)
  | "kb_emergency_generic" // honest generic emergency routing (no KB entry matched)
  | `kb_faq_${string}` // KB FAQ deflection policy (kb_faq_pricing, kb_faq_scheduling, ...)
  | "llm_screened" // LLM text that PASSED screenAdviceText
  | "human_routing" // stripped/replaced: honest fallback routing to a human
  | null;

export interface PipelineReply {
  text: string;
  source: ReplySource;
}

export interface PipelineResult {
  classification: MessageClassification;
  tier: "llm" | "rules";
  tierReason: "primary" | "default" | "backstop";
  /** Time-fact: is `now` outside the business's configured hours? */
  afterHours: boolean;
  /** Emergency-only escalation flag: KB policy AND after-hours time-fact. */
  afterHoursEscalation: boolean;
  reply: PipelineReply | null;
  /** Screening outcome for the produced LLM reply (null when none screened). */
  screen: GuardrailResult | null;
  kbEmergencyKey: string | null;
  kbEmergencySeverity: EmergencySeverity | null;
}

/** Honest fallback when advice must not be given by the AI. */
export const HUMAN_ROUTING_REPLY =
  "Good question - that one is for our licensed technicians, so I have passed your message to the team and someone will follow up with you directly. If this ever becomes urgent (gas smell, flooding, water you cannot shut off), call 911 or your gas utility first.";

/** Honest generic emergency routing when no KB emergency entry matched. */
export const GENERIC_EMERGENCY_REPLY =
  "This sounds like it may be an emergency. If anyone is in danger or you smell gas, leave the building and call 911 first. We have been alerted and a technician will follow up as quickly as possible.";

// ---------------------------------------------------------------------------
// After-hours logic (pure)
// ---------------------------------------------------------------------------

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Local (business-timezone) wall clock: { dayOfWeek, minutesSinceMidnight }. */
export function localWallClock(now: Date, timezone: string): { dayOfWeek: number; minutes: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = fmt.formatToParts(now);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
    const day = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number]);
    const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "", 10);
    const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "", 10);
    if (day < 0 || Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { dayOfWeek: day, minutes: hour * 60 + minute };
  } catch {
    return null; // invalid/unsupported timezone
  }
}

function hhmmToMinutes(v: string | null): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(v);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Is `now` outside the business's configured opening hours?
 *
 * FAIL TOWARD ESCALATION: an unreadable timezone, missing rows, or a closed
 * day all count as AFTER hours — a missed emergency page is worse than an
 * unnecessary one. Known-true only for a matched open day whose window
 * contains the local wall-clock time.
 */
export function isAfterHours(now: Date, timezone: string | null, hours: PipelineHoursRow[] | null): boolean {
  if (!timezone || !hours || hours.length === 0) return true;
  const clock = localWallClock(now, timezone);
  if (!clock) return true;
  const row = hours.find((h) => h.dayOfWeek === clock.dayOfWeek);
  if (!row || !row.isOpen) return true;
  const opens = hhmmToMinutes(row.opensAt);
  const closes = hhmmToMinutes(row.closesAt);
  if (opens === null || closes === null) return true;
  return clock.minutes < opens || clock.minutes >= closes;
}

// ---------------------------------------------------------------------------
// KB context for the LLM prompt
// ---------------------------------------------------------------------------

/** Deterministic service-catalog context block for the LLM system prompt. */
export function buildServiceCatalogContext(): string {
  return SERVICES.map((s) => "- " + s.name + " (" + s.slug + "): " + s.description + " Default urgency: " + s.defaultUrgency + ".").join("\n");
}

/**
 * The full classifier/advice system prompt: the KB guardrail policy
 * (buildSystemPrompt) + the service catalog + the STRICT JSON task spec.
 * Exported for tests; production and tests see byte-identical prompts.
 */
export function buildClassifierSystemPrompt(): string {
  return [
    buildSystemPrompt(),
    "",
    "SERVICE CATALOG (classify serviceNeed against these; do not invent services):",
    buildServiceCatalogContext(),
    "",
    "TASK: You are the SMS intake assistant for a plumbing company. Extract the",
    "customer's need from ONE text message and, when they asked a question, draft",
    "the reply. Return STRICT JSON only, no prose outside the JSON:",
    '{"serviceNeed": string|null, "urgency": "emergency"|"same_day"|"within_week"|"flexible"|null, "priority": "emergency"|"high"|"normal"|null, "contactName": string|null, "contactEmail": string|null, "serviceAddress": string|null, "safetyConcern": boolean|null, "notes": string|null, "reply": string|null}',
    "urgency/priority: emergency = active flooding, burst pipe, sewage backup, gas smell, cannot shut off water; high = water heater failure, significant leak, no working toilet, major blockage; normal = everything else.",
    "safetyConcern = true only for gas smell, electrical hazard, or uncontrolled water.",
    "reply: ONLY when the message asks a question or requests advice - a short",
    "(under 320 characters) answer that obeys the SAFETY POLICY above. Pricing",
    "questions: explain pricing comes after diagnosis, never quote a number.",
    "Never promise a capability you do not have (no firm booking, no prices, no",
    "warranty terms). Otherwise reply = null. Omit nothing the message supports;",
    "use null for anything not stated. Never invent values.",
  ].join("\n");
}

/** Matching KB FAQ entry for a body, or null (pure helper, exported for tests). */
export function matchFaqEntry(body: string): FaqEntry | null {
  const t = normalizeKbText(body);
  if (t.length === 0) return null;
  for (const entry of FAQ_ENTRIES) {
    if (entry.patterns.some((re) => re.test(t))) return entry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM tier: classification parse
// ---------------------------------------------------------------------------

function llmUrgency(v: unknown): "emergency" | "same_day" | "within_week" | "flexible" | null {
  return v === "emergency" || v === "same_day" || v === "within_week" || v === "flexible" ? v : null;
}
function llmPriority(v: unknown): "emergency" | "high" | "normal" | null {
  return v === "emergency" || v === "high" || v === "normal" ? v : null;
}
function llmStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Ask the LLM for the classification JSON. Returns null when the model is
 * unreachable, times out, or returns anything unparseable — the caller then
 * falls back to the rules tier for THIS turn (honest degradation).
 */
async function llmClassify(llm: PipelineLlm, body: string): Promise<MessageClassification | null> {
  const raw = await llm.complete(buildClassifierSystemPrompt(), body, { maxTokens: 500, timeoutMs: 15_000 });
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const reply = llmStr(parsed.reply);
  return {
    serviceNeed: llmStr(parsed.serviceNeed),
    urgency: llmUrgency(parsed.urgency),
    priority: llmPriority(parsed.priority),
    contactName: llmStr(parsed.contactName),
    contactEmail: llmStr(parsed.contactEmail),
    serviceAddress: llmStr(parsed.serviceAddress),
    safetyConcern: typeof parsed.safetyConcern === "boolean" ? parsed.safetyConcern : null,
    notes: llmStr(parsed.notes),
    model: llm.model,
    classifier: "llm",
    reply: reply && reply.length <= 640 ? reply : null,
  };
}

// ---------------------------------------------------------------------------
// Emergency merge + stamps (both tiers)
// ---------------------------------------------------------------------------

interface EmergencyMerge {
  urgency: "emergency" | "same_day" | "within_week" | "flexible" | null;
  priority: "emergency" | "high" | "normal" | null;
  category: "emergency" | "urgent" | "routine" | "other";
  safetyConcern: boolean | null;
  serviceNeed: string | null;
  emergencyKey: string | null;
  emergencySeverity: EmergencySeverity | null;
}

/**
 * Merge a base classification with the KB emergency resolution.
 * IF EITHER SIDE SAYS EMERGENCY, THE RESULT IS EMERGENCY — fail toward
 * emergency. A KB match fills serviceNeed when the base could not extract
 * one (e.g. "gurgling" alone: rules say "other", KB says sewage_backup).
 */
function mergeEmergency(base: MessageClassification, hasKbEmergency: boolean, kbKey: string | null, kbSeverity: EmergencySeverity | null): EmergencyMerge {
  const baseEmergency = base.urgency === "emergency" || base.priority === "emergency";
  const isEmergency = baseEmergency || hasKbEmergency;
  const baseCategory = base.category ?? (base.priority === "emergency" ? "emergency" : base.priority === "high" ? "urgent" : base.priority != null ? "routine" : "other");
  return {
    urgency: isEmergency ? "emergency" : base.urgency,
    priority: isEmergency ? "emergency" : base.priority,
    category: isEmergency ? "emergency" : baseCategory,
    safetyConcern: base.safetyConcern === true || hasKbEmergency ? true : base.safetyConcern,
    serviceNeed: base.serviceNeed ?? (hasKbEmergency ? emergencyLabel(kbKey) : null),
    emergencyKey: kbKey,
    emergencySeverity: kbSeverity,
  };
}

function emergencyLabel(key: string | null): string | null {
  if (!key) return null;
  // KB emergency display names are stable; keep the label short + canonical.
  return key.replace(/_/g, " ");
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Run one classification+advice turn. NEVER throws for expected engine
 * failure: an LLM error degrades to the rules tier for this turn (logged by
 * the caller via tierReason "backstop"). Total on empty input (rules tier).
 */
export async function runClassificationPipeline(input: PipelineInput): Promise<PipelineResult> {
  const body = typeof input.body === "string" ? input.body : "";

  // ---- Tier selection -----------------------------------------------------
  let base: MessageClassification;
  let tier: "llm" | "rules";
  let tierReason: "primary" | "default" | "backstop";
  let llmReply: string | null = null;

  if (input.llm) {
    try {
      const parsed = await llmClassify(input.llm, body);
      if (parsed) {
        base = parsed;
        tier = "llm";
        tierReason = "primary";
        llmReply = parsed.reply ?? null;
      } else {
        // Model returned garbage — the rules backstop keeps this turn useful.
        base = rulesBase(body);
        tier = "rules";
        tierReason = "backstop";
      }
    } catch (err) {
      // LLM configured but errored (network/HTTP/timeout): rules for this turn.
      base = rulesBase(body);
      tier = "rules";
      tierReason = "backstop";
      console.log("[pipeline] LLM tier failed - rules backstop applied this turn: " + String(err));
    }
  } else {
    base = rulesBase(body);
    tier = "rules";
    tierReason = "default";
  }

  // ---- KB emergency resolution (both tiers) --------------------------------
  const kbEmergency = resolveEmergency(body);
  const kbKey = kbEmergency ? kbEmergency.entry.key : null;
  const kbSeverity = kbEmergency ? kbEmergency.entry.severity : null;
  const merge = mergeEmergency(base, kbEmergency != null, kbKey, kbSeverity);

  const notes = [
    base.notes ?? null,
    kbEmergency ? KB_VERSION + " emergency: " + kbEmergency.entry.key + " (" + kbEmergency.entry.severity + ")" : null,
    tierReason === "backstop" ? "tier: rules backstop (LLM error)" : null,
  ]
    .filter((v): v is string => typeof v === "string")
    .join("; ");

  // ---- After-hours facts ----------------------------------------------------
  const afterHours = isAfterHours(input.now, input.timezone, input.hours);
  // Escalation policy: the KB entry decides for known classes; an emergency
  // without a KB entry (LLM-only) fails toward escalation (true).
  const policy = kbEmergency ? kbEmergency.entry.afterHoursEscalation : true;
  const isEmergency = merge.urgency === "emergency";
  const afterHoursEscalation = isEmergency ? policy && afterHours : false;

  // ---- Reply production (honest, KB-first) ----------------------------------
  let reply: PipelineReply | null = null;
  let screen: GuardrailResult | null = null;

  if (isEmergency) {
    // The KB safety script is the response text source — VERBATIM, never
    // LLM-authored, never preceded by pricing/booking/qualification.
    reply = kbEmergency
      ? { text: kbEmergency.entry.customerScript.join(" "), source: "kb_emergency_script" }
      : { text: GENERIC_EMERGENCY_REPLY, source: "kb_emergency_generic" };
  } else {
    const faq = matchFaqEntry(body);
    const adviceIntent = screenAdviceRequest(body).decision !== "not_advice";
    if (faq) {
      // Deflection policy comes from the KB — keyless, honest, never invented
      // (pricing = quote after diagnosis; scheduling/service-area/warranty =
      // the business's default policy answers). KB policy outranks the LLM
      // draft so the answer stays identical with or without an API key.
      const source = ("kb_faq_" + faq.id) as ReplySource;
      reply = { text: faq.defaultAnswer, source };
    } else if (llmReply) {
      // POST-SCREEN the LLM draft: deny > allow > escalate. Only an explicit
      // allow-list pass survives; block AND escalate are stripped and replaced
      // with the honest human-routing fallback — raw LLM text never ships.
      screen = screenAdviceText(llmReply);
      reply =
        screen.decision === "allow"
          ? { text: llmReply, source: "llm_screened" }
          : { text: HUMAN_ROUTING_REPLY, source: "human_routing" };
    } else if (adviceIntent) {
      // Advice asked, no safe source to answer from (rules tier, or the LLM
      // declined) — honest routing to a human instead of an invented answer.
      reply = { text: HUMAN_ROUTING_REPLY, source: "human_routing" };
    }
  }

  // ---- Stamps ----------------------------------------------------------------
  const classification: MessageClassification = {
    ...base,
    reply: reply ? reply.text : null,
    serviceNeed: merge.serviceNeed,
    urgency: merge.urgency,
    priority: merge.priority,
    category: merge.category,
    safetyConcern: merge.safetyConcern,
    notes: notes.length > 0 ? notes : null,
    // Confidence: KB emergency evidence lifts a weak rules result honestly.
    confidence:
      isEmergency && kbEmergency != null && (base.confidence ?? 0) < 0.85 ? 0.85 : base.confidence,
    classifier: tier,
    kbVersion: KB_VERSION,
    tier,
    tierReason,
    emergencyKey: kbKey,
    emergencySeverity: kbSeverity,
    afterHoursEscalation,
    replySource: reply ? reply.source : null,
  };

  return {
    classification,
    tier,
    tierReason,
    afterHours,
    afterHoursEscalation,
    reply,
    screen,
    kbEmergencyKey: kbKey,
    kbEmergencySeverity: kbSeverity,
  };
}

/** Rules-tier base classification (default AND backstop path). */
function rulesBase(body: string): MessageClassification {
  return classifyInboundText(body);
}
