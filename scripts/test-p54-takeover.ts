/**
 * P5-4 — Human takeover / escalation verification suite.
 *
 * Runs against DATABASE_URL (Neon or the local shim), same pattern as
 * test-p53-settings.ts / test-e2e-journey.ts: real DB rows through the real
 * query layer + the real conversation flow, one test business (a second for
 * isolation), CASCADE cleanup, exit 0 only when every check passes. Adds ZERO
 * rows outside the test businesses. Provider env (Twilio/LLM) is cleared so
 * the suite is deterministic and never sends a real text or LLM call —
 * exactly the honest keyless launch configuration.
 *
 * Covered:
 *   1. PURE TRIGGER DETECTION — detectTakeoverReasons for every trigger
 *      (angry, unclear, ai_uncertainty, pricing/policy, emergency wins), the
 *      deliberate non-triggers (chit-chat, short pleasantries, routine turns),
 *      and priority ordering.
 *   2. CHANNEL WIRING — human_takeover owner workflow + takeover_needed
 *      channel event mapped through the existing notification-controls and
 *      workflow-engine gates.
 *   3. FLAG + NOTIFY — flagConversationNeedsHuman stores handoff_status
 *      'needed' + evidence, creates the takeover_needed in-app notification,
 *      is idempotent per thread, and is business-scoped (foreign flag: no-op).
 *   4. TAKEOVER / RELEASE — setConversationHandoff stamps who/when on
 *      takeover, clears on hand-back, foreign conversation id: no-op.
 *   5. END-TO-END FLOW (handleInboundSms, the real entry):
 *      angry text → thread flagged + notified; human-owned thread → inbound
 *      stored, NO classification, NO AI reply; hand back → AI resumes with
 *      full context; routine turn → no flag; emergency turn → flagged through
 *      the EXISTING emergency escalation path (reason 'emergency').
 *
 * Run: bun scripts/test-p54-takeover.ts
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import { createBusinessWithOwner } from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import {
  detectTakeoverReasons,
  topTakeoverReason,
  TAKEOVER_REASON_LABELS,
  TAKEOVER_REASON_PRIORITY,
  AI_UNCERTAIN_CONFIDENCE,
  UNCLEAR_MIN_BODY_CHARS,
} from "../src/lib/takeover";
import {
  WORKFLOW_KEYS,
  WORKFLOW_CATALOG,
  OWNER_SMS_WORKFLOW_FOR_EVENT,
  channelEventFor,
  sanitizeNotificationChannelSettings,
  smsChannelEnabled,
  emailChannelEnabled,
} from "../src/lib/smsWorkflows";
import {
  flagConversationNeedsHuman,
  evaluateTakeoverForTurn,
} from "../src/lib/server/takeover";
import {
  markConversationNeedsHuman,
  setConversationHandoff,
  countConversationsNeedingHuman,
  createConversation,
  getConversation,
  listMessages,
} from "../src/db/queries/conversations";
import { handleInboundSms } from "../src/lib/server/textBack";
import { runClassificationPipeline } from "../src/lib/server/classifyPipeline";

// Determinism: the keyless launch configuration — no real LLM turn, no real
// SMS send. Modules read env at call time, so clearing here is sufficient.
delete process.env.LLM_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_SMS_NUMBER;

if (process.env.USE_LOCAL_POSTGRES === "1") await installLocalPostgresShim();

let checks = 0;
let failures = 0;
function checkTrue(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  } else {
    console.log("ok   " + name);
  }
}
function checkEq(name: string, actual: unknown, expected: unknown): void {
  checkTrue(name, actual === expected, "got " + JSON.stringify(actual) + " want " + JSON.stringify(expected));
}

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
let businessId: string | null = null;
let businessId2: string | null = null;

try {
  // =========================================================================
  // 1. PURE TRIGGER DETECTION
  // =========================================================================
  checkEq("pure: exactly five reason keys", Object.keys(TAKEOVER_REASON_LABELS).length, 5);
  checkEq("pure: priority covers every key", TAKEOVER_REASON_PRIORITY.length, 5);
  checkEq(
    "pure: confidence threshold documented",
    AI_UNCERTAIN_CONFIDENCE,
    0.45,
  );
  checkTrue("pure: pleasantries never flag (threshold guard)", UNCLEAR_MIN_BODY_CHARS >= 10);

  checkEq(
    "pure: angry customer language → angry_customer",
    topTakeoverReason(
      detectTakeoverReasons(
        { body: "This is ridiculous, I've waited three days. I want to speak to a real manager NOW." },
      ),
    ),
    "angry_customer",
  );
  checkEq(
    "pure: legal-threat language → angry_customer",
    topTakeoverReason(detectTakeoverReasons({ body: "I will be calling my lawyer about this." })),
    "angry_customer",
  );
  checkEq(
    "pure: emergency outranks everything",
    topTakeoverReason(
      detectTakeoverReasons({ body: "totally unacceptable, I am furious", urgency: "emergency" }),
    ),
    "emergency",
  );
  checkTrue(
    "pure: emergency-only result (no other reasons run)",
    JSON.stringify(detectTakeoverReasons({ body: "furious and unacceptable", urgency: "emergency" })) === JSON.stringify(["emergency"]),
  );
  checkEq(
    "pure: guardrail-routed reply → pricing_policy",
    topTakeoverReason(
      detectTakeoverReasons({ body: "how much to replace my water heater?", replySource: "human_routing" }),
    ),
    "pricing_policy",
  );
  checkEq(
    "pure: low-confidence unknown request → unclear_request",
    topTakeoverReason(
      detectTakeoverReasons({ body: "asdf qwerty zxcv bnm mmm kkk jjj", category: "other", confidence: 0.2 }),
    ),
    "unclear_request",
  );
  checkEq(
    "pure: backstop turn → ai_uncertainty",
    topTakeoverReason(
      detectTakeoverReasons({ body: "my sink is gurgling oddly, any idea why?", tierReason: "backstop" }),
    ),
    "ai_uncertainty",
  );
  checkTrue(
    "pure: LLM-parse-came-back-empty → ai_uncertainty",
    detectTakeoverReasons({
      body: "the thing in the back room is making that noise again",
      category: "other",
      confidence: 0.9,
      tierReason: "primary",
    }).includes("ai_uncertainty"),
  );

  // Deliberate NON-triggers.
  checkTrue(
    "pure: chit-chat never flags the owner",
    detectTakeoverReasons({ body: "thanks so much, have a great day!", category: "other", confidence: 0.45 }).length === 0,
  );
  checkTrue(
    "pure: short pleasantry never flags",
    detectTakeoverReasons({ body: "ok", category: "other", confidence: 0.2 }).length === 0,
  );
  checkTrue(
    "pure: routine turn with a service need never flags",
    detectTakeoverReasons({
      body: "kitchen sink is clogged, can you help?",
      category: "urgent",
      confidence: 0.75,
      serviceNeed: "Kitchen sink clog",
    }).length === 0,
  );
  checkTrue("pure: empty body → no reasons", detectTakeoverReasons({ body: "" }).length === 0);
  checkTrue("pure: garbage input → no reasons", detectTakeoverReasons({ body: 42 as unknown as string }).length === 0);
  checkEq("pure: no reasons → top is null", topTakeoverReason([]), null);

  // =========================================================================
  // 2. CHANNEL WIRING (existing notification-controls + workflow engine)
  // =========================================================================
  checkTrue("wiring: human_takeover is a catalog workflow", WORKFLOW_KEYS.includes("human_takeover"));
  checkEq("wiring: human_takeover texts the OWNER", WORKFLOW_CATALOG.human_takeover.recipient, "owner");
  checkEq(
    "wiring: takeover_needed channel event maps to the workflow",
    OWNER_SMS_WORKFLOW_FOR_EVENT.takeover_needed,
    "human_takeover",
  );
  checkEq(
    "wiring: takeover_needed notification maps to the channel event",
    channelEventFor("takeover_needed"),
    "takeover_needed",
  );
  const channels = sanitizeNotificationChannelSettings(undefined);
  checkTrue("wiring: takeover SMS channel defaults ON", smsChannelEnabled(channels, "takeover_needed"));
  checkTrue("wiring: takeover email channel defaults ON", emailChannelEnabled(channels, "takeover_needed"));

  // =========================================================================
  // 3. TEST BUSINESSES + FLAG / NOTIFY / ISOLATION
  // =========================================================================
  const passwordHash = await hashPassword("p54-password-1234");
  const first = await createBusinessWithOwner({
    businessName: "P5-4 Takeover Test Plumbing " + STAMP,
    ownerEmail: `p54+${STAMP}@p54-test.example.com`,
    ownerFullName: "P5-4 Tester",
    passwordHash,
  });
  businessId = first.business.id;
  checkTrue("db: test business created", !!businessId);
  const second = await createBusinessWithOwner({
    businessName: "P5-4 Other Plumbing " + STAMP,
    ownerEmail: `p54b+${STAMP}@p54-test.example.com`,
    ownerFullName: "P5-4 Tester B",
    passwordHash,
  });
  businessId2 = second.business.id;
  checkTrue("db: second test business created", !!businessId2);

  const conv = await createConversation(businessId, {
    customerPhone: "+15557770101",
    status: "active",
  });
  checkTrue("db: conversation created with default handoff state", conv.handoffStatus === "ai");

  const flag1 = await flagConversationNeedsHuman(businessId, conv.id, "angry_customer", {
    reasons: ["angry_customer"],
    preview: "This is ridiculous...",
  });
  checkTrue("flag: first trigger flags the thread", flag1.flagged === true && flag1.reason === "angry_customer");
  const convAfter = await getConversation(businessId, conv.id);
  checkEq("flag: handoff_status stored as 'needed'", convAfter?.handoffStatus, "needed");
  checkEq("flag: reason stored", convAfter?.handoffReason, "angry_customer");
  checkTrue("flag: evidence detail stored", (convAfter?.handoffDetail as { preview?: string } | null)?.preview === "This is ridiculous...");
  checkTrue("flag: handoff_at stamped", convAfter?.handoffAt instanceof Date);

  const notifRows = (await query(
    "SELECT type, payload FROM notifications WHERE business_id = $1 ORDER BY created_at DESC",
    [businessId],
  )) as unknown as { type: string; payload: Record<string, unknown> }[];
  const takeoverNotifs = notifRows.filter((n) => n.type === "takeover_needed");
  checkEq("flag: exactly one takeover_needed in-app notification", takeoverNotifs.length, 1);
  checkEq(
    "flag: notification carries conversation + reason",
    (takeoverNotifs[0]?.payload as { conversationId?: string; reason?: string } | undefined)?.conversationId,
    conv.id,
  );

  const flag2 = await flagConversationNeedsHuman(businessId, conv.id, "pricing_policy", {
    reasons: ["pricing_policy"],
  });
  checkTrue("flag: repeat trigger on a flagged thread is a no-op", flag2.flagged === false);
  const convAfter2 = await getConversation(businessId, conv.id);
  checkEq("flag: original reason kept (no overwrite)", convAfter2?.handoffReason, "angry_customer");
  const notifRows2 = (await query(
    "SELECT count(*) AS n FROM notifications WHERE business_id = $1 AND type = 'takeover_needed'",
    [businessId],
  )) as unknown as { n: string }[];
  checkEq("flag: still exactly one takeover_needed notification", Number(notifRows2[0].n), 1);

  // Isolation: a foreign business cannot flag (or read) the conversation.
  const flagForeign = await flagConversationNeedsHuman(businessId2, conv.id, "ai_uncertainty", null);
  checkTrue("isolation: foreign business flag is a no-op", flagForeign.flagged === false);
  checkEq("isolation: foreign business has zero takeover notifications", (await query(
    "SELECT count(*) AS n FROM notifications WHERE business_id = $1 AND type = 'takeover_needed'",
    [businessId2],
  ) as unknown as { n: string }[]).map((r) => Number(r.n))[0], 0);
  checkEq("isolation: thread count for other business is 0", await countConversationsNeedingHuman(businessId2), 0);
  checkEq("isolation: thread count for owner business is 1", await countConversationsNeedingHuman(businessId), 1);

  // =========================================================================
  // 4. TAKEOVER / RELEASE (the query layer the inbox server fns call)
  // =========================================================================
  const takeoverAt = new Date();
  const taken = await setConversationHandoff(businessId, conv.id, "human", `owner+${STAMP}@p54-test.example.com`);
  checkEq("takeover: state is 'human'", taken?.handoffStatus, "human");
  checkEq("takeover: who took over is stamped", taken?.handoffBy, `owner+${STAMP}@p54-test.example.com`);
  checkTrue(
    "takeover: timestamp stamped",
    taken?.handoffAt instanceof Date && (taken.handoffAt as Date).getTime() >= takeoverAt.getTime() - 2000,
  );
  checkEq(
    "takeover: reason preserved while human-owned",
    taken?.handoffReason,
    "angry_customer",
  );

  const foreignTakeover = await setConversationHandoff(businessId2, conv.id, "ai", null);
  checkTrue("isolation: foreign business cannot hand back the thread", foreignTakeover === null);
  const stillHuman = await getConversation(businessId, conv.id);
  checkEq("isolation: thread still human-owned", stillHuman?.handoffStatus, "human");

  const released = await setConversationHandoff(businessId, conv.id, "ai", null);
  checkEq("release: state back to 'ai'", released?.handoffStatus, "ai");
  checkEq("release: flag evidence cleared", released?.handoffReason, null);
  checkEq("release: takeover stamp cleared", released?.handoffBy, null);
  checkEq("release: handoff_at cleared", released?.handoffAt, null);

  // =========================================================================
  // 5. END-TO-END FLOW (handleInboundSms — the real inbound webhook entry)
  // =========================================================================
  // 5a. ANGRY TURN → thread flagged + owner notified (workflow channel only
  //     actually SENDS with Twilio configured; here the honest engine records
  //     the attempt without a provider — the in-app row is the proof).
  const angryConv = await createConversation(businessId, { customerPhone: "+15557770202", status: "active" });
  const angryTurn = await handleInboundSms({
    businessId,
    businessName: "P5-4 Test Plumbing",
    conversationId: angryConv.id,
    body: "This is ridiculous, I've waited three days. I want to speak to a real manager NOW.",
    from: "+15557770202",
    externalId: null,
  });
  checkEq("e2e angry: turn delivered", angryTurn.status, "delivered");
  const angryAfter = await getConversation(businessId, angryConv.id);
  checkEq("e2e angry: thread flagged 'needed'", angryAfter?.handoffStatus, "needed");
  checkEq("e2e angry: reason is angry_customer", angryAfter?.handoffReason, "angry_customer");
  checkTrue(
    "e2e angry: owner notified",
    ((await query(
      "SELECT count(*) AS n FROM notifications WHERE business_id = $1 AND type = 'takeover_needed' AND payload->>'conversationId' = $2",
      [businessId, angryConv.id],
    )) as unknown as { n: string }[]).map((r) => Number(r.n))[0] === 1,
  );

  // 5b. HUMAN-OWNED THREAD → inbound stored, NO AI turn at all.
  await setConversationHandoff(businessId, angryConv.id, "human", `owner+${STAMP}@p54-test.example.com`);
  const humanTurn = await handleInboundSms({
    businessId,
    businessName: "P5-4 Test Plumbing",
    conversationId: angryConv.id,
    body: "my kitchen sink is clogged and I need help today",
    from: "+15557770202",
    externalId: null,
  });
  checkEq("e2e human: turn recorded honestly as unclassified", humanTurn.status, "unclassified");
  checkEq("e2e human: no limit decision", humanTurn.limitReached, null);
  const humanMessages = await listMessages(businessId, angryConv.id, { order: "asc" });
  checkEq("e2e human: inbound message stored for the plumber", humanMessages.length, 2);
  checkEq("e2e human: no AI reply appended", humanMessages[1]?.direction, "inbound");
  checkEq("e2e human: message left unclassified", humanMessages[1]?.classification, null);
  checkEq("e2e human: state stays 'human'", (await getConversation(businessId, angryConv.id))?.handoffStatus, "human");

  // 5c. HAND BACK → the AI resumes with full thread context.
  await setConversationHandoff(businessId, angryConv.id, "ai", null);
  const resumeTurn = await handleInboundSms({
    businessId,
    businessName: "P5-4 Test Plumbing",
    conversationId: angryConv.id,
    body: "actually it's the bathroom sink now, please come tomorrow",
    from: "+15557770202",
    externalId: null,
  });
  checkEq("e2e resume: AI turn delivered again", resumeTurn.status, "delivered");
  const resumedMessages = await listMessages(businessId, angryConv.id, { order: "asc" });
  checkEq("e2e resume: full thread preserved (3 messages)", resumedMessages.length, 3);
  checkTrue(
    "e2e resume: new turn classified by the AI",
    resumedMessages[2]?.classification != null,
  );

  // 5d. ROUTINE CONTROL → no flag.
  const routineConv = await createConversation(businessId, { customerPhone: "+15557770303", status: "active" });
  await handleInboundSms({
    businessId,
    businessName: "P5-4 Test Plumbing",
    conversationId: routineConv.id,
    body: "my kitchen sink is clogged",
    from: "+15557770303",
    externalId: null,
  });
  checkEq(
    "e2e control: routine service request does NOT flag the thread",
    (await getConversation(businessId, routineConv.id))?.handoffStatus,
    "ai",
  );

  // 5e. EMERGENCY → flagged through the EXISTING escalation path.
  const emergencyConv = await createConversation(businessId, { customerPhone: "+15557770404", status: "active" });
  await handleInboundSms({
    businessId,
    businessName: "P5-4 Test Plumbing",
    conversationId: emergencyConv.id,
    body: "my basement is flooding and I can't shut off the water",
    from: "+15557770404",
    externalId: null,
  });
  const emergencyAfter = await getConversation(businessId, emergencyConv.id);
  checkEq("e2e emergency: thread flagged 'needed'", emergencyAfter?.handoffStatus, "needed");
  checkEq("e2e emergency: reason is emergency", emergencyAfter?.handoffReason, "emergency");
  checkTrue(
    "e2e emergency: owner notified exactly once (existing path, no duplicate)",
    ((await query(
      "SELECT count(*) AS n FROM notifications WHERE business_id = $1 AND type = 'takeover_needed' AND payload->>'conversationId' = $2",
      [businessId, emergencyConv.id],
    )) as unknown as { n: string }[]).map((r) => Number(r.n))[0] === 1,
  );

  // 5f. Double-send race guard contract: with the thread flagged ('needed'),
  //     an in-flight AI reply must be withheld (textBack re-checks handoff
  //     state immediately before sending). The pure pipeline still produces a
  //     draft — prove the guard's decision boundary directly.
  const inFlight = await runClassificationPipeline({
    body: "kitchen sink is clogged, can you help?",
    now: new Date(),
    timezone: null,
    hours: null,
    llm: null,
  });
  checkTrue("race: pipeline still classifies normally", inFlight.classification.urgency != null || inFlight.classification.category != null);
  const midTurnFlag = await markConversationNeedsHuman(businessId, routineConv.id, "unclear_request", null);
  checkTrue(
    "race: a takeover mid-turn flips the state the send-guard reads",
    midTurnFlag !== null && midTurnFlag.handoffStatus === "needed",
  );
  const midTurnFlag2 = await markConversationNeedsHuman(businessId, routineConv.id, "angry_customer", null);
  checkTrue("race: state is single-flip (no double notification possible)", midTurnFlag2 === null);

  // =========================================================================
  // 6. evaluateTakeoverForTurn: wiring from a real PipelineResult
  // =========================================================================
  const freshConv = await createConversation(businessId, { customerPhone: "+15557770505", status: "active" });
  // An ADVICE question (not covered by a KB FAQ policy) — keyless rules tier
  // routes it to a human (replySource human_routing), which is the
  // pricing/policy takeover trigger.
  const adviceBody = "how do I fix the dripping faucet myself?";
  const routing = await runClassificationPipeline({
    body: adviceBody,
    now: new Date(),
    timezone: null,
    hours: null,
    llm: null,
  });
  checkTrue(
    "wire: keyless advice question routes to a human",
    routing.classification.replySource === "human_routing",
  );
  const wireResult = await evaluateTakeoverForTurn(businessId, freshConv.id, routing, adviceBody);
  checkTrue("wire: pricing/policy turn flags the thread", wireResult.flagged === true && wireResult.reason === "pricing_policy");
  checkEq(
    "wire: reason stored",
    (await getConversation(businessId, freshConv.id))?.handoffReason,
    "pricing_policy",
  );
} catch (err) {
  checks++;
  failures++;
  console.log("FAIL suite threw — " + String(err));
} finally {
  // Cleanup: CASCADE wipes everything the two test businesses own.
  if (businessId) {
    await query("DELETE FROM businesses WHERE id = $1", [businessId]);
  }
  if (businessId2) {
    await query("DELETE FROM businesses WHERE id = $1", [businessId2]);
  }
}

console.log(failures === 0 ? `P5-4 TAKEOVER PASS — ${checks} checks, 0 failures` : `P5-4 TAKEOVER FAIL — ${failures} of ${checks} checks failed`);
process.exit(failures === 0 ? 0 : 1);
