/**
 * First-run line self-test — PURE logic (no server-only imports, no DB, no
 * network). The server-side runner lives in src/lib/server/lineTest.ts; this
 * module holds everything the mock-based unit suite (scripts/test-infra.ts)
 * can exercise without credentials.
 *
 * WHAT IT IS: when a business gets its phone number assigned, the system
 * probes its own inbound webhook with a signed, honestly-labeled SYNTHETIC
 * Twilio message (From = the business's own on-file alert number, To = the
 * business's provisioned line) and verifies the real pipeline answered: the
 * inbound message stored, the AI reply sent on that thread, the lead captured,
 * and the owner alert recorded. The result is stored on the business settings
 * blob (businesses.settings.lineTest — no migration) and rendered as a
 * "Phone line status" card on the dashboard. Every leg is honest: green only
 * from a completed run, deduped legs are labeled as such, failures carry the
 * HTTP/status evidence.
 *
 * BODY CONVENTION (pinned by tests): the probe body starts with "SYSTEM TEST"
 * (the established labeling convention from the Twilio go-live probe) and is
 * worded to classify, through the REAL rules classifier, as a routine
 * service need with a KB-FAQ pricing reply — never an emergency (an emergency
 * classification would flag the thread for human takeover and suppress the
 * very AI-reply leg the test verifies), never chit-chat (a lead is only
 * captured from a substantive service need). Verified against
 * runClassificationPipeline with llm:null: urgency same_day, priority high,
 * serviceNeed "clogged drain/fixture", replySource "kb_faq_pricing",
 * confidence 0.75, no takeover trigger fires.
 */

/** Every probe body starts with this — the established test-message label. */
export const SYSTEM_TEST_BODY_PREFIX = "SYSTEM TEST";

/** All leg keys, in pipeline order (first broken leg reporting follows this). */
export const LINE_TEST_LEG_KEYS = ["inbound", "aiReply", "lead", "ownerAlert"] as const;
export type LineTestLegKey = (typeof LINE_TEST_LEG_KEYS)[number];

export type LineTestStatus = "running" | "pass" | "partial" | "fail" | "not_configured";

/** How one leg was resolved. "deduped" = verified by the earlier SYSTEM TEST artifact (the duplicate guard correctly refused a second copy this run). */
export type LineTestLegState = "observed" | "deduped" | "missing";

export interface LineTestLeg {
  ok: boolean;
  state: LineTestLegState;
  /** Human-readable, honest detail — what was seen and when. */
  detail: string;
  /** DB id of the evidence row (message / lead / notification), when any. */
  evidenceId?: string;
}

export interface StoredLineTest {
  status: LineTestStatus;
  /** ISO instant the run started. */
  startedAt: string;
  /** ISO instant the run reached a terminal status (absent while running). */
  finishedAt?: string;
  /** What kicked the run off. */
  trigger?: "auto_first_run" | "manual";
  /** Plain-language reason for not_configured (and extra context on fails). */
  reason?: string;
  /** The probe's own numbers (both are the business's own — never a customer). */
  probeFrom?: string;
  probeTo?: string;
  /** HTTP status + response snippet from the webhook POST (failure evidence). */
  webhookHttpStatus?: number;
  webhookBodySnippet?: string;
  conversationId?: string;
  /** The fabricated Twilio message SID that uniquely marks this run's inbound row. */
  probeMessageSid?: string;
  legs?: Partial<Record<LineTestLegKey, LineTestLeg>>;
  /** Which leg broke first (pipeline order) on a fail. */
  firstBroken?: LineTestLegKey;
  /** ISO instant of the most recent PASS — kept so repeat runs that can only prove a subset still show when the full pipeline last passed. */
  lastPassAt?: string;
  /** Runner crash detail (a terminal status is always written, even on throw). */
  error?: string;
}

export interface LineTestObservations {
  /** Webhook POST result. */
  webhookHttpStatus: number | null;
  webhookBodySnippet: string;
  /** The stored inbound message row for this run's probe SID (unique marker). */
  inboundMessageId: string | null;
  conversationId: string | null;
  /** Handoff state of the probe thread (context for a suppressed reply). */
  conversationHandoff: string | null;
  /** Outbound (AI) message on the probe thread created during this run. */
  aiReplyMessageId: string | null;
  /** Lead for the probe phone created during this run. */
  leadThisRun: { id: string; createdAt: string } | null;
  /** Pre-existing lead for the probe phone (dedup guard artifact), if any. */
  priorLead: { id: string; createdAt: string; description: string | null; linkedToThread: boolean } | null;
  /** Owner-facing notification created during this run (new_lead / takeover_needed). */
  notificationThisRun: { id: string; type: string } | null;
  /** A prior notification tied to the prior lead (the earlier alert proof). */
  priorNotification: { id: string; type: string; createdAt: string } | null;
}

/**
 * The probe body. Starts with the honest "SYSTEM TEST" label, carries a
 * per-run nonce, and asks a pricing-FAQ-shaped question about a clogged
 * kitchen sink: substantive enough to capture a lead, non-emergency so the
 * thread is never flagged for takeover, and answered deterministically by the
 * KB pricing FAQ (kb_faq_pricing) on ANY tier — with or without an LLM key.
 */
export function buildLineTestBody(nonce: string): string {
  return (
    SYSTEM_TEST_BODY_PREFIX +
    " (run " +
    nonce +
    "): automated line check by MissedCall AI - no action needed. " +
    "Sample question: how much does it cost to clear a clogged kitchen sink?"
  );
}

/**
 * Fabricated Twilio-shaped inbound params. From/To/Body are the real webhook
 * contract; MessageSid is a unique marker (SM + 32 hex, Twilio-shaped) that
 * the webhook stores verbatim on the message row — the probe's unambiguous
 * "did MY message land" evidence. Exactly these params are signed and POSTed.
 */
export function buildProbeParams(args: { messageSid: string; from: string; to: string; body: string }): Record<string, string> {
  return {
    MessageSid: args.messageSid,
    From: args.from,
    To: args.to,
    Body: args.body,
  };
}

/** Twilio-shaped unique message SID ("SM" + 32 hex chars) built from randomness. */
export function buildProbeMessageSid(randomHex32: string): string {
  return "SM" + randomHex32;
}

/** The public webhook URL the probe POSTs (and signs) — base + the documented path. */
export function webhookUrlForBase(base: string): string {
  return new URL("/api/webhooks/twilio", base.endsWith("/") ? base : base + "/").toString();
}

/**
 * Evaluate the four legs and pick the overall status. All-or-nothing per leg:
 *   inbound   — HTTP 200 AND this run's message row landed (probe SID match).
 *   aiReply   — an outbound AI message on the probe thread this run (observed
 *               every run — this is the live-pipeline proof; never deduped).
 *   lead      — a lead created this run; OR the pre-existing lead for this
 *               phone is linked to the probe thread (state "deduped" — the
 *               duplicate guard correctly refused a second copy; the
 *               thread→lead linkage was still exercised this run).
 *   ownerAlert— a notification created this run; OR a prior notification tied
 *               to the deduped lead (state "deduped").
 *
 * Status:
 *   pass    — all four legs ok (observed or deduped, each labeled).
 *   partial — the pipeline ran (inbound + AI reply observed) but a later leg
 *             is missing; which one is recorded per leg.
 *   fail    — the run could not exercise the pipeline: the webhook did not
 *             answer 200, the message never landed, or no AI reply was
 *             produced (first broken leg + evidence).
 */
export function evaluateLineTest(o: LineTestObservations): {
  status: LineTestStatus;
  legs: Record<LineTestLegKey, LineTestLeg>;
  firstBroken?: LineTestLegKey;
} {
  const legs: Record<LineTestLegKey, LineTestLeg> = {
    inbound: { ok: false, state: "missing", detail: "Not verified." },
    aiReply: { ok: false, state: "missing", detail: "Not verified." },
    lead: { ok: false, state: "missing", detail: "Not verified." },
    ownerAlert: { ok: false, state: "missing", detail: "Not verified." },
  };
  let firstBroken: LineTestLegKey | undefined;

  // Leg 1: inbound webhook + stored message.
  const httpOk = o.webhookHttpStatus === 200;
  if (httpOk && o.inboundMessageId) {
    legs.inbound = {
      ok: true,
      state: "observed",
      detail: "Signed synthetic SMS accepted by the webhook and stored on the thread.",
      evidenceId: o.inboundMessageId,
    };
  } else if (httpOk) {
    legs.inbound = {
      ok: false,
      state: "missing",
      detail:
        "Webhook answered 200 but no message row with the probe SID was stored." +
        (o.webhookBodySnippet ? " Response: " + o.webhookBodySnippet : ""),
    };
    firstBroken = "inbound";
  } else {
    legs.inbound = {
      ok: false,
      state: "missing",
      detail:
        "Webhook did not accept the probe (HTTP " +
        (o.webhookHttpStatus ?? "no response") +
        ")." +
        (o.webhookBodySnippet ? " Response: " + o.webhookBodySnippet : ""),
    };
    firstBroken = "inbound";
  }

  // Leg 2: the AI reply on the probe thread THIS run — never deduped.
  if (o.aiReplyMessageId) {
    legs.aiReply = {
      ok: true,
      state: "observed",
      detail: "AI reply sent on the probe thread this run.",
      evidenceId: o.aiReplyMessageId,
    };
  } else {
    legs.aiReply = {
      ok: false,
      state: "missing",
      detail:
        "No AI reply was sent on the probe thread within the polling window." +
        (o.conversationHandoff && o.conversationHandoff !== "ai"
          ? " The thread is flagged for human takeover (handoff=" +
            o.conversationHandoff +
            ") — AI replies are suppressed there by design; release the takeover in the inbox and run the test again."
          : " Check the inbox and system errors for the classification turn."),
    };
    firstBroken = firstBroken ?? "aiReply";
  }

  // Leg 3: lead created this run, or the deduped prior lead linked to the thread.
  if (o.leadThisRun) {
    legs.lead = {
      ok: true,
      state: "observed",
      detail: "Lead captured from the probe message this run.",
      evidenceId: o.leadThisRun.id,
    };
  } else if (o.priorLead && o.priorLead.linkedToThread) {
    legs.lead = {
      ok: true,
      state: "deduped",
      detail:
        "Duplicate guard held: a lead for this number already exists (created " +
        o.priorLead.createdAt.slice(0, 10) +
        (o.priorLead.description ? ", \"" + o.priorLead.description.slice(0, 60) + "\"" : "") +
        ") and is linked to the probe thread — no second lead was invented.",
      evidenceId: o.priorLead.id,
    };
  } else {
    legs.lead = {
      ok: false,
      state: "missing",
      detail: "No lead was captured for the probe number, and none exists linked to the thread.",
    };
    firstBroken = firstBroken ?? "lead";
  }

  // Leg 4: owner alert this run, or the prior alert tied to the deduped lead.
  if (o.notificationThisRun) {
    legs.ownerAlert = {
      ok: true,
      state: "observed",
      detail: "Owner alert notification recorded this run (" + o.notificationThisRun.type + ").",
      evidenceId: o.notificationThisRun.id,
    };
  } else if (legs.lead.state === "deduped" && o.priorNotification) {
    legs.ownerAlert = {
      ok: true,
      state: "deduped",
      detail:
        "Duplicate guard held (no new lead, so no new alert is due); the earlier alert for this lead was recorded " +
        o.priorNotification.createdAt.slice(0, 10) +
        " (" +
        o.priorNotification.type +
        ").",
      evidenceId: o.priorNotification.id,
    };
  } else {
    legs.ownerAlert = {
      ok: false,
      state: "missing",
      detail:
        legs.lead.state === "deduped"
          ? "No notification exists for the linked lead — the owner alert path did not fire when it was due."
          : "No new lead was created this run, so no owner alert was due; the alert path was not exercised.",
    };
    firstBroken = firstBroken ?? "ownerAlert";
  }

  const pipelineRan = legs.inbound.ok && legs.aiReply.ok;
  const allOk = LINE_TEST_LEG_KEYS.every((k) => legs[k].ok);
  let status: LineTestStatus;
  if (allOk) status = "pass";
  else if (pipelineRan) status = "partial";
  else status = "fail";
  return { status, legs, firstBroken };
}

/**
 * Defensively normalize whatever is stored at settings.lineTest into a
 * StoredLineTest the UI can render — or null when absent/garbled. Long free
 * text is truncated; unknown statuses collapse to null so the card never
 * renders an invented state (and never a green check from garbage).
 */
export function describeStoredLineTest(raw: unknown): StoredLineTest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = r.status;
  if (status !== "running" && status !== "pass" && status !== "partial" && status !== "fail" && status !== "not_configured") {
    return null;
  }
  const str = (v: unknown, max: number): string | undefined => {
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    return t.length === 0 ? undefined : t.slice(0, max);
  };
  const iso = (v: unknown): string | undefined => {
    const s = str(v, 40);
    if (!s || Number.isNaN(Date.parse(s))) return undefined;
    return s;
  };
  const trigger = r.trigger === "manual" ? "manual" : r.trigger === "auto_first_run" ? "auto_first_run" : undefined;
  const legsRaw = (r.legs ?? null) as Record<string, unknown> | null;
  const legs: Partial<Record<LineTestLegKey, LineTestLeg>> = {};
  if (legsRaw && typeof legsRaw === "object") {
    for (const key of LINE_TEST_LEG_KEYS) {
      const leg = legsRaw[key];
      if (!leg || typeof leg !== "object") continue;
      const l = leg as Record<string, unknown>;
      const state = l.state;
      legs[key] = {
        ok: l.ok === true,
        state: state === "observed" || state === "deduped" ? state : "missing",
        detail: str(l.detail, 300) ?? "Not verified.",
        evidenceId: str(l.evidenceId, 64),
      };
    }
  }
  const out: StoredLineTest = {
    status,
    startedAt: iso(r.startedAt) ?? new Date(0).toISOString(),
    trigger,
  };
  const finishedAt = iso(r.finishedAt);
  if (finishedAt) out.finishedAt = finishedAt;
  const reason = str(r.reason, 300);
  if (reason) out.reason = reason;
  const probeFrom = str(r.probeFrom, 24);
  if (probeFrom) out.probeFrom = probeFrom;
  const probeTo = str(r.probeTo, 24);
  if (probeTo) out.probeTo = probeTo;
  if (typeof r.webhookHttpStatus === "number" && Number.isFinite(r.webhookHttpStatus)) {
    out.webhookHttpStatus = Math.trunc(r.webhookHttpStatus);
  }
  const snippet = str(r.webhookBodySnippet, 200);
  if (snippet) out.webhookBodySnippet = snippet;
  const conversationId = str(r.conversationId, 64);
  if (conversationId) out.conversationId = conversationId;
  const probeMessageSid = str(r.probeMessageSid, 64);
  if (probeMessageSid) out.probeMessageSid = probeMessageSid;
  if (LINE_TEST_LEG_KEYS.some((k) => legs[k])) out.legs = legs;
  const firstBroken = r.firstBroken;
  if (typeof firstBroken === "string" && (LINE_TEST_LEG_KEYS as readonly string[]).includes(firstBroken)) {
    out.firstBroken = firstBroken as LineTestLegKey;
  }
  const lastPassAt = iso(r.lastPassAt);
  if (lastPassAt) out.lastPassAt = lastPassAt;
  const error = str(r.error, 300);
  if (error) out.error = error;
  return out;
}

/**
 * A "running" marker older than this is stale (the runner always writes a
 * terminal status, even on crash — a stuck running state means the process
 * died mid-run). The UI renders stale runs honestly as "stale", never green.
 */
export const LINE_TEST_RUNNING_STALE_MS = 4 * 60 * 1000;
