#!/usr/bin/env bun
/**
 * Cold-SMS lead capture verification suite.
 *
 * Runs against DATABASE_URL (Neon or the local shim), same pattern as
 * test-p54-takeover.ts: real DB rows through the real query layer + the real
 * inbound webhook entry point (handleInboundSms), one test business (a second
 * for isolation), CASCADE cleanup, exit 0 only when every check passes. Adds
 * ZERO rows outside the test businesses. Provider env (Twilio/LLM/Knock) is
 * cleared so the suite is deterministic and never sends a real text, LLM
 * call, or email — exactly the honest keyless launch configuration.
 *
 * THE GAP UNDER TEST: a cold inbound SMS (a thread nobody texted first) used
 * to be stored + classified and then DROPPED — no lead was ever created, so
 * the customer never appeared in the pipeline. This suite pins the fix:
 *
 *   1. CREATE + LINK + NOTIFY — a cold SMS whose classification carries a
 *      substantive serviceNeed creates exactly one lead (source 'missed_call'
 *      — the LeadSource enum has no "sms" value), links the conversation,
 *      fires the SAME new_lead notification + 'lead_new' follow-up task chain
 *      captureMissedCallLead uses, and appends NO outbound message.
 *   2. NO LEAD FOR EMPTY NEED — a classification with serviceNeed null
 *      ("ok thanks!") creates no lead and leaves the thread unlinked.
 *   3. NO DUPLICATES — a second cold SMS from the same phone (different
 *      conversation) creates no second lead; the thread links to the
 *      existing one (the P5-1 backfill path, unchanged).
 *   4. EMERGENCY ORDERING — the lead is created BEFORE the emergency branch
 *      runs, so the EXISTING escalateEmergency re-stamps it
 *      emergency/emergency like any linked lead.
 *   5. REPLY BEHAVIOR UNCHANGED — the pure pipeline's reply gating is exactly
 *      the documented contract (routine request → no reply; pricing question
 *      → KB FAQ policy; emergency → KB safety script), and the DB threads
 *      hold zero outbound messages (lead creation sends nothing).
 *   6. ISOLATION — the same customer phone texting a different business
 *      captures that business's OWN lead (business-scoped guard), never the
 *      other business's.
 *
 * Run: bun scripts/test-sms-lead.ts
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import { createBusinessWithOwner } from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import {
  createConversation,
  getConversation,
  listMessages,
} from "../src/db/queries/conversations";
import { handleInboundSms } from "../src/lib/server/textBack";
import { runClassificationPipeline } from "../src/lib/server/classifyPipeline";
// Determinism: the keyless launch configuration — no real LLM turn, no real
// SMS send, no real email. Modules read env at call time, so clearing here is
// sufficient.
delete process.env.LLM_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_SMS_NUMBER;
delete process.env.KNOCK_API_KEY;
delete process.env.KNOCK_WORKFLOW_KEY;
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
async function leadCount(businessId: string, phone: string): Promise<number> {
  const rows = (await query(
    "SELECT count(*) AS n FROM leads WHERE business_id = $1 AND contact_phone = $2",
    [businessId, phone],
  )) as unknown as { n: string }[];
  return Number(rows[0].n);
}
const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
let businessId: string | null = null;
let businessId2: string | null = null;
try {
  // =========================================================================
  // Test businesses
  // =========================================================================
  const passwordHash = await hashPassword("sms-lead-password-1234");
  const first = await createBusinessWithOwner({
    businessName: "SMS Lead Test Plumbing " + STAMP,
    ownerEmail: `smslead+${STAMP}@sms-lead-test.example.com`,
    ownerFullName: "SMS Lead Tester",
    passwordHash,
  });
  businessId = first.business.id;
  checkTrue("db: test business created", !!businessId);
  const second = await createBusinessWithOwner({
    businessName: "SMS Lead Other Plumbing " + STAMP,
    ownerEmail: `smsleadb+${STAMP}@sms-lead-test.example.com`,
    ownerFullName: "SMS Lead Tester B",
    passwordHash,
  });
  businessId2 = second.business.id;
  checkTrue("db: isolation business created", !!businessId2);
  if (!businessId || !businessId2) throw new Error("test businesses missing");

  // =========================================================================
  // 1. CREATE + LINK + NOTIFY (the cold-SMS → lead loop)
  // =========================================================================
  const createBody = "my kitchen sink is clogged and I need it fixed this week";
  const createConv = await createConversation(businessId, { customerPhone: "+15557771001", status: "active" });
  const createTurn = await handleInboundSms({
    businessId,
    businessName: "SMS Lead Test Plumbing",
    conversationId: createConv.id,
    body: createBody,
    from: "+15557771001",
    externalId: null,
  });
  checkEq("create: turn delivered (classified)", createTurn.status, "delivered");
  const createMsgs = await listMessages(businessId, createConv.id, { order: "asc" });
  checkEq("create: exactly one message on the thread", createMsgs.length, 1);
  checkEq("create: message is the inbound text (no auto-reply appended)", createMsgs[0]?.direction, "inbound");
  const classifiedNeed = createMsgs[0]?.classification?.serviceNeed ?? null;
  checkEq("create: rules tier extracted the service need", classifiedNeed, "clogged drain/fixture");
  checkEq("create: exactly one lead for the phone", await leadCount(businessId, "+15557771001"), 1);
  const createdLead = (await query(
    "SELECT * FROM leads WHERE business_id = $1 AND contact_phone = $2 ORDER BY created_at DESC LIMIT 1",
    [businessId, "+15557771001"],
  )) as unknown as {
    id: string; source: string; status: string; serviceNeed: string; urgency: string | null;
    contactName: string; contactPhone: string; description: string | null;
  }[];
  // NOTE: the shared sql() client camelCases every row key (see src/db.ts),
  // so raw rows read `serviceNeed`, not `service_need`.
  const lead1 = createdLead[0];
  checkTrue("create: a lead row exists", !!lead1);
  if (lead1) {
    checkEq("create: source is the honest enum value 'missed_call'", lead1.source, "missed_call");
    checkEq("create: lead status is new", lead1.status, "new");
    checkEq("create: serviceNeed matches the stored classification", lead1.serviceNeed, classifiedNeed);
    checkEq("create: urgency carried from the classification", lead1.urgency, createMsgs[0]?.classification?.urgency ?? null);
    checkEq("create: description is the customer's verbatim text", lead1.description, createBody);
    checkEq("create: contact phone is the texting number", lead1.contactPhone, "+15557771001");
    checkTrue("create: contact name is an honest non-empty fallback", !!lead1.contactName && lead1.contactName.length > 0);
  }
  const linkedConv = await getConversation(businessId, createConv.id);
  checkEq("create: conversation linked to the new lead", linkedConv?.leadId, lead1?.id ?? null);
  const leadNotifs = (await query(
    "SELECT payload FROM notifications WHERE business_id = $1 AND type = 'new_lead' ORDER BY created_at DESC",
    [businessId],
  )) as unknown as { payload: Record<string, unknown> }[];
  checkTrue(
    "create: new_lead notification fired for this lead (same chain as captureMissedCallLead)",
    leadNotifs.some((n) => n.payload?.leadId === lead1?.id),
  );
  // Select the raw snake_case column — the shared client camelCases row keys
  // (an unquoted mixed-case alias would be folded to lowercase by Postgres).
  const followUps = (await query(
    "SELECT created_reason FROM follow_up_tasks WHERE business_id = $1 AND lead_id = $2",
    [businessId, lead1?.id],
  )) as unknown as { createdReason: string }[];
  checkTrue(
    "create: 'lead_new' follow-up task created for the lead",
    followUps.some((t) => t.createdReason === "lead_new"),
  );

  // =========================================================================
  // 2. NO LEAD FOR EMPTY SERVICE NEED
  // =========================================================================
  const emptyConv = await createConversation(businessId, { customerPhone: "+15557771002", status: "active" });
  const emptyTurn = await handleInboundSms({
    businessId,
    businessName: "SMS Lead Test Plumbing",
    conversationId: emptyConv.id,
    body: "ok thanks!",
    from: "+15557771002",
    externalId: null,
  });
  checkEq("empty: turn still delivered + classified", emptyTurn.status, "delivered");
  const emptyMsgs = await listMessages(businessId, emptyConv.id, { order: "asc" });
  checkEq("empty: classification stored with serviceNeed null", emptyMsgs[0]?.classification?.serviceNeed ?? null, null);
  checkEq("empty: NO lead invented for chit-chat", await leadCount(businessId, "+15557771002"), 0);
  checkEq("empty: thread left unlinked", (await getConversation(businessId, emptyConv.id))?.leadId ?? null, null);

  // =========================================================================
  // 3. NO DUPLICATES (second cold SMS from the same phone, new conversation)
  // =========================================================================
  const dupConv = await createConversation(businessId, { customerPhone: "+15557771001", status: "active" });
  await handleInboundSms({
    businessId,
    businessName: "SMS Lead Test Plumbing",
    conversationId: dupConv.id,
    body: "also the bathroom sink is dripping now",
    from: "+15557771001",
    externalId: null,
  });
  checkEq("dup: still exactly one lead for the phone", await leadCount(businessId, "+15557771001"), 1);
  checkEq("dup: second thread linked to the EXISTING lead", (await getConversation(businessId, dupConv.id))?.leadId, lead1?.id ?? null);
  const newLeadNotifCount = ((await query(
    "SELECT count(*) AS n FROM notifications WHERE business_id = $1 AND type = 'new_lead'",
    [businessId],
  )) as unknown as { n: string }[]).map((r) => Number(r.n))[0];
  checkEq("dup: no second new_lead notification (no second capture)", newLeadNotifCount, 1);

  // =========================================================================
  // 4. EMERGENCY ORDERING — creation runs BEFORE the existing escalation
  // =========================================================================
  const emgConv = await createConversation(businessId, { customerPhone: "+15557771003", status: "active" });
  await handleInboundSms({
    businessId,
    businessName: "SMS Lead Test Plumbing",
    conversationId: emgConv.id,
    body: "my basement is flooding and I can't shut off the water",
    from: "+15557771003",
    externalId: null,
  });
  checkEq("emergency: exactly one lead for the phone", await leadCount(businessId, "+15557771003"), 1);
  const emgLead = (await query(
    "SELECT id, priority, urgency FROM leads WHERE business_id = $1 AND contact_phone = $2 ORDER BY created_at DESC LIMIT 1",
    [businessId, "+15557771003"],
  )) as unknown as { id: string; priority: string; urgency: string }[];
  checkEq("emergency: lead re-stamped priority=emergency by the EXISTING escalation", emgLead[0]?.priority, "emergency");
  checkEq("emergency: lead re-stamped urgency=emergency", emgLead[0]?.urgency, "emergency");
  checkEq("emergency: thread linked to the lead", (await getConversation(businessId, emgConv.id))?.leadId, emgLead[0]?.id ?? null);
  checkEq(
    "emergency: existing takeover behavior intact (thread flagged 'needed')",
    (await getConversation(businessId, emgConv.id))?.handoffStatus,
    "needed",
  );

  // =========================================================================
  // 5. REPLY BEHAVIOR UNCHANGED (pure pipeline contract + DB evidence)
  // =========================================================================
  // The reply-gating contract is the pipeline's and is untouched by lead
  // capture: a routine request produces NO reply, a pricing question the KB
  // FAQ policy, an emergency the verbatim KB safety script.
  const routine = await runClassificationPipeline({ body: createBody, now: new Date(), timezone: null, hours: null, llm: null });
  checkEq("reply: routine service request still produces NO reply", routine.classification.replySource ?? null, null);
  checkEq("reply: routine reply field still null", routine.reply, null);
  const pricing = await runClassificationPipeline({ body: "how much does a water heater replacement cost?", now: new Date(), timezone: null, hours: null, llm: null });
  checkEq("reply: pricing question still answered from the KB FAQ policy", pricing.classification.replySource ?? null, "kb_faq_pricing");
  const emergency = await runClassificationPipeline({ body: "my basement is flooding and I can't shut off the water", now: new Date(), timezone: null, hours: null, llm: null });
  checkEq("reply: emergency still gets the verbatim KB safety script", emergency.classification.replySource ?? null, "kb_emergency_script");
  // DB evidence: lead capture added no outbound message to any thread.
  const outboundCount = ((await query(
    "SELECT count(*) AS n FROM messages m JOIN conversations c ON m.conversation_id = c.id WHERE c.business_id = $1 AND m.direction = 'outbound'",
    [businessId],
  )) as unknown as { n: string }[]).map((r) => Number(r.n))[0];
  checkEq("reply: zero outbound messages across all test threads (capture sends nothing)", outboundCount, 0);

  // =========================================================================
  // 6. ISOLATION — the same phone texting another business captures ITS lead
  // =========================================================================
  const isoConv = await createConversation(businessId2, { customerPhone: "+15557771001", status: "active" });
  await handleInboundSms({
    businessId: businessId2,
    businessName: "SMS Lead Other Plumbing",
    conversationId: isoConv.id,
    body: createBody,
    from: "+15557771001",
    externalId: null,
  });
  checkEq("isolation: other business captures exactly one lead for the same phone", await leadCount(businessId2, "+15557771001"), 1);
  checkEq("isolation: first business still holds exactly one lead", await leadCount(businessId, "+15557771001"), 1);
  const isoLead = (await query(
    "SELECT id FROM leads WHERE business_id = $1 AND contact_phone = $2 ORDER BY created_at DESC LIMIT 1",
    [businessId2, "+15557771001"],
  )) as unknown as { id: string }[];
  checkTrue("isolation: the two businesses hold DIFFERENT lead rows", isoLead[0]?.id !== lead1?.id);
  checkEq("isolation: other business's thread linked to its own lead", (await getConversation(businessId2, isoConv.id))?.leadId, isoLead[0]?.id ?? null);
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
console.log(failures === 0 ? `SMS LEAD CAPTURE PASS — ${checks} checks, 0 failures` : `SMS LEAD CAPTURE FAIL — ${failures} of ${checks} checks failed`);
process.exit(failures === 0 ? 0 : 1);
