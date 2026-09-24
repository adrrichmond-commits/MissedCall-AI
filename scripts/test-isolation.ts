#!/usr/bin/env bun
/**
 * Business data-isolation suite (P3-H part 2) — the runtime proof that backs
 * docs/security/data-isolation-audit.md.
 *
 * Creates TWO businesses through the real signup core
 * (queries/auth.createBusinessWithOwner — the exact function the signupFn RPC
 * calls), seeds identical-shaped data in both (leads, conversations +
 * messages, appointments, services, service areas, business hours,
 * notifications, follow-up tasks, usage counters, billing events, won-job
 * revenue), then asserts that NO query-layer function lets one business read
 * or mutate the other's rows. The WHERE business_id = $caller clause is the
 * isolation boundary (AGENTS.md); this suite is that sentence made executable.
 *
 * Session binding is verified too: a session token resolves to exactly one
 * business, and every call in this suite passes the businessId exactly the way
 * server fns do — resolved from the caller's session (ctx.business.id), never
 * from row IDs supplied by the other side.
 *
 * Run:
 *   bun scripts/test-isolation.ts
 * Needs DATABASE_URL pointing at any Postgres it may write to (the suite
 * deletes the two businesses it creates; ON DELETE CASCADE cleans the rest).
 * Against a plain postgres:// URL set USE_LOCAL_POSTGRES=1 so the Neon driver
 * goes over direct pg connections (scripts/local-pg-shim.ts); production Neon
 * URLs need no flag. Exit code 0 = every isolation check passed.
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import {
  createBusinessWithOwner,
  createSession,
  getBusiness,
  getSessionByTokenHash,
} from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import * as leads from "../src/db/queries/leads";
import * as conv from "../src/db/queries/conversations";
import * as appts from "../src/db/queries/appointments";
import * as settings from "../src/db/queries/settings";
import * as notif from "../src/db/queries/notifications";
import * as tasks from "../src/db/queries/followUpTasks";
import * as usage from "../src/db/queries/usage";
import * as revenue from "../src/db/queries/revenue";

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

/** Same token-hash discipline as auth.server.ts hashToken. */
async function sha256Hex(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

const RUN = Date.now().toString(36);
const A_EMAIL = "iso-a-" + RUN + "@isolation-test.invalid";
const B_EMAIL = "iso-b-" + RUN + "@isolation-test.invalid";
const PHONE_A1 = "+151200000" + RUN.slice(-2) + "1";
const PHONE_A2 = "+151200000" + RUN.slice(-2) + "2";
const PHONE_B1 = "+151200901" + RUN.slice(-2) + "1";
const PHONE_B2 = "+151200901" + RUN.slice(-2) + "2";
const ZIP_A = "500" + RUN.slice(-2);
const HOUR = 60 * 60 * 1000;
const tomorrow = new Date(Date.now() + 24 * HOUR);
/** Monday 00:00 UTC of the current week — the usage-counter period anchor. */
const monday = new Date();
monday.setUTCHours(0, 0, 0, 0);
monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));

async function createBusinessWithSession(
  name: string,
  ownerEmail: string,
  fullName: string,
): Promise<{ businessId: string; token: string }> {
  // The exact core the signupFn RPC calls (authFns -> createBusinessWithOwner).
  const passwordHash = await hashPassword("iso-test-" + RUN + "-password");
  const { business, user } = await createBusinessWithOwner({
    businessName: name,
    ownerEmail,
    ownerFullName: fullName,
    passwordHash,
  });
  // A session exactly as auth.server.ts issueSession issues it.
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await createSession(user.id, await sha256Hex(token), new Date(Date.now() + 7 * 24 * HOUR));
  return { businessId: business.id, token };
}

async function main(): Promise<void> {
  const A = await createBusinessWithSession("Isolation Test A " + RUN, A_EMAIL, "Owner A");
  const B = await createBusinessWithSession("Isolation Test B " + RUN, B_EMAIL, "Owner B");
  const a = A.businessId;
  const b = B.businessId;

  try {
    // ------------------------------------------------------------------
    // 1. Session -> business binding (the root of every scope decision)
    // ------------------------------------------------------------------
    const sessA = await getSessionByTokenHash(await sha256Hex(A.token));
    const sessB = await getSessionByTokenHash(await sha256Hex(B.token));
    if (sessA == null || sessB == null) {
      throw new Error("isolation test: seeded owner session lookup returned null");
    }
    checkTrue("A session resolves to A's business", sessA.userData.businessId === a);
    checkTrue("B session resolves to B's business", sessB.userData.businessId === b);
    checkTrue("A session never resolves into B's business", sessA.userData.businessId !== b);

    // ------------------------------------------------------------------
    // Seed both businesses with identical-shaped data
    // ------------------------------------------------------------------
    const leadA1 = await leads.createLead(a, {
      source: "missed_call", urgency: "emergency", serviceNeed: "Emergency burst pipe",
      contactName: "Alice A", contactPhone: PHONE_A1,
    });
    const leadA2 = await leads.createLead(a, {
      source: "web_form", serviceNeed: "Water heater replacement",
      contactName: "Alan A", contactPhone: PHONE_A2,
    });
    const convA = await conv.createConversation(a, { leadId: leadA1.id, customerPhone: PHONE_A1 });
    const msgA = await conv.appendMessage({ businessId: a, conversationId: convA.id, direction: "inbound", body: "A-side secret message" });
    const apptA = await appts.createAppointment(a, { serviceSummary: "A leak repair", scheduledAt: tomorrow });
    const svcA = await settings.createService(a, { name: "Iso service A", basePriceCents: 1111 });
    await settings.createServiceArea(a, { kind: "zip", value: ZIP_A });
    await settings.upsertBusinessHour(a, { dayOfWeek: 1, isOpen: true, opensAt: "08:00", closesAt: "17:00" });
    const notifA = await notif.createNotification(a, { type: "new_lead", payload: { leadId: leadA1.id } });
    const taskA = await tasks.createFollowUpTask(a, { leadId: leadA1.id, dueAt: tomorrow, createdReason: "lead_new", note: "A task" });
    await usage.incrementUsage({ businessId: a, periodStart: monday, axis: "sms_sent", delta: 3 });
    await usage.createBillingEvent({ businessId: a, type: "plan_change", source: "local", description: "A-only billing event " + RUN });
    // Won job for the revenue math — a value B must never see.
    await leads.updateLead(a, leadA2.id, { status: "won", actualWonValueCents: 123456 });

    const leadB1 = await leads.createLead(b, {
      source: "missed_call", serviceNeed: "B clogged drain",
      contactName: "Bob B", contactPhone: PHONE_B1,
    });
    const leadB2 = await leads.createLead(b, {
      source: "referral", serviceNeed: "B sewer line",
      contactName: "Bea B", contactPhone: PHONE_B2,
    });
    const convB = await conv.createConversation(b, { leadId: leadB1.id, customerPhone: PHONE_B1 });
    await conv.appendMessage({ businessId: b, conversationId: convB.id, direction: "outbound", body: "B-side message" });
    await appts.createAppointment(b, { serviceSummary: "B drain cleaning", scheduledAt: tomorrow });
    await settings.createService(b, { name: "Iso service B", basePriceCents: 222222 });
    await settings.createServiceArea(b, { kind: "city", value: "IsoCity-" + RUN });
    await settings.upsertBusinessHour(b, { dayOfWeek: 2, isOpen: false, opensAt: null, closesAt: null });
    await notif.createNotification(b, { type: "new_lead", payload: { leadId: leadB1.id } });
    await tasks.createFollowUpTask(b, { leadId: leadB1.id, dueAt: tomorrow, createdReason: "manual", note: "B task" });
    await usage.incrementUsage({ businessId: b, periodStart: monday, axis: "ai_turns", delta: 1 });
    await usage.createBillingEvent({ businessId: b, type: "plan_change", source: "local", description: "B-only billing event " + RUN });
    await leads.updateLead(b, leadB1.id, { status: "won", actualWonValueCents: 777777 });

    // ------------------------------------------------------------------
    // Leads
    // ------------------------------------------------------------------
    checkTrue("getLead(B, A's lead) -> null", (await leads.getLead(b, leadA1.id)) === null);
    checkTrue("getLead(A, B's lead) -> null", (await leads.getLead(a, leadB2.id)) === null);
    checkTrue("getLead(A, A's lead) -> row (sanity)", (await leads.getLead(a, leadA1.id)) !== null);
    const bLeadPhones = (await leads.listLeads(b)).map((l) => l.contactPhone);
    checkTrue("B listLeads never returns A's phone numbers", !bLeadPhones.includes(PHONE_A1) && !bLeadPhones.includes(PHONE_A2));
    const hacked = await leads.updateLead(b, leadA1.id, { status: "lost" });
    checkTrue("updateLead(B, A's lead) -> null", hacked === null);
    checkTrue("A's lead status untouched by B's write", (await leads.getLead(a, leadA1.id))?.status === "new");
    checkTrue("deleteLead(B, A's lead) -> false", (await leads.deleteLead(b, leadA2.id)) === false);
    checkTrue("A's lead survives B's delete attempt", (await leads.getLead(a, leadA2.id)) !== null);
    const aRecovery = await leads.missedCallRecoveryStats(a);
    checkTrue("A recovery stats count only A's missed-call leads", aRecovery.missedCalls === 1, String(aRecovery.missedCalls));

    // ------------------------------------------------------------------
    // Conversations + messages
    // ------------------------------------------------------------------
    checkTrue("getConversation(B, A's conv) -> null", (await conv.getConversation(b, convA.id)) === null);
    const bConvIds = (await conv.listConversations(b)).map((c) => c.id);
    checkTrue("B listConversations excludes A's conversation", !bConvIds.includes(convA.id));
    checkTrue("listMessages(B, A's conv) -> []", (await conv.listMessages(b, convA.id)).length === 0);
    checkTrue("getLatestMessage(B, A's conv) -> null", (await conv.getLatestMessage(b, convA.id)) === null);
    let appendRejected = false;
    try {
      await conv.appendMessage({ businessId: b, conversationId: convA.id, direction: "inbound", body: "injected by B" });
    } catch {
      appendRejected = true;
    }
    checkTrue("appendMessage(B, A's conv) rejected", appendRejected);
    checkTrue("A's message body never crossed to B", (await conv.listMessages(b, convA.id)).length === 0);
    checkTrue("updateMessageStatus(B, A's msg) -> null", (await conv.updateMessageStatus(b, msgA.id, "delivered")) === null);
    checkTrue("deleteConversation(B, A's conv) -> false", (await conv.deleteConversation(b, convA.id)) === false);
    checkTrue("A's conversation survives B's delete", (await conv.getConversation(a, convA.id)) !== null);
    checkTrue("countMessages(A) counts only A's messages", (await conv.countMessages(a)) === 1);

    // ------------------------------------------------------------------
    // Appointments
    // ------------------------------------------------------------------
    checkTrue("getAppointment(B, A's appt) -> null", (await appts.getAppointment(b, apptA.id)) === null);
    const bApptIds = (await appts.listAppointments(b)).map((x) => x.id);
    checkTrue("B listAppointments excludes A's appointment", !bApptIds.includes(apptA.id));
    checkTrue("updateAppointment(B, A's appt) -> null", (await appts.updateAppointment(b, apptA.id, { status: "completed" })) === null);
    checkTrue("setAppointmentStatus(B, A's appt) -> null", (await appts.setAppointmentStatus(b, apptA.id, "declined")) === null);
    checkTrue("A's appointment status untouched", (await appts.getAppointment(a, apptA.id))?.status === "requested");
    checkTrue("deleteAppointment(B, A's appt) -> false", (await appts.deleteAppointment(b, apptA.id)) === false);
    checkTrue("countUpcoming(B) counts only B's appointment", (await appts.countUpcoming(b)) === 1);

    // ------------------------------------------------------------------
    // Services, service areas, business hours
    // ------------------------------------------------------------------
    checkTrue("getService(B, A's service) -> null", (await settings.getService(b, svcA.id)) === null);
    checkTrue("updateService(B, A's service) -> null", (await settings.updateService(b, svcA.id, { name: "HACKED" })) === null);
    checkTrue("A's service name untouched", (await settings.getService(a, svcA.id))?.name === "Iso service A");
    checkTrue("deleteService(B, A's service) -> false", (await settings.deleteService(b, svcA.id)) === false);
    const bAreas = await settings.listServiceAreas(b);
    checkTrue("B service areas exclude A's zip", !bAreas.some((x) => x.value === ZIP_A));
    checkTrue("A service areas still intact", (await settings.listServiceAreas(a)).some((x) => x.value === ZIP_A));
    const bHours = await settings.listBusinessHours(b);
    checkTrue("B business hours exclude A's Monday row", !bHours.some((h) => h.dayOfWeek === 1));

    // ------------------------------------------------------------------
    // Notifications
    // ------------------------------------------------------------------
    const bNotifs = await notif.listNotifications(b);
    checkTrue("B notifications exclude A's notification", !bNotifs.some((n) => n.id === notifA.id));
    checkTrue("B unread count is B's own only", (await notif.countUnreadNotifications(b)) === 1);
    checkTrue("A unread count is A's own only", (await notif.countUnreadNotifications(a)) === 1);
    checkTrue("markNotificationRead(B, A's notification) -> null", (await notif.markNotificationRead(b, notifA.id)) === null);
    checkTrue("A's notification still unread", (await notif.listNotifications(a)).some((n) => n.id === notifA.id && n.readAt == null));

    // ------------------------------------------------------------------
    // Follow-up tasks
    // ------------------------------------------------------------------
    checkTrue("getFollowUpTask(B, A's task) -> null", (await tasks.getFollowUpTask(b, taskA.id)) === null);
    checkTrue("setFollowUpTaskDone(B, A's task) -> null", (await tasks.setFollowUpTaskDone(b, taskA.id, true)) === null);
    checkTrue("A's follow-up task still open", (await tasks.getFollowUpTask(a, taskA.id))?.done === false);
    const bTasks = await tasks.listFollowUpTasks(b);
    checkTrue("B follow-up tasks exclude A's task", !bTasks.some((t) => t.id === taskA.id));

    // ------------------------------------------------------------------
    // Usage counters + billing events
    // ------------------------------------------------------------------
    const bUsage = await usage.getUsageForPeriod(b, monday);
    checkTrue("B usage counter row does not see A's sms_sent", bUsage === null || Number(bUsage.smsSent) === 0);
    const aUsage = await usage.getUsageForPeriod(a, monday);
    checkTrue("A usage counter holds A's own increment", aUsage !== null && Number(aUsage.smsSent) === 3);
    const bEvents = await usage.listBillingEvents(b);
    checkTrue("B billing events exclude A's event", !bEvents.some((e) => e.description?.includes("A-only billing event")));
    checkTrue("A billing events include A's event", (await usage.listBillingEvents(a)).some((e) => e.description?.includes("A-only")));

    // ------------------------------------------------------------------
    // Revenue — the money view must only ever total the caller's business
    // ------------------------------------------------------------------
    const aRev = await revenue.revenueMetrics(a, null);
    const bRev = await revenue.revenueMetrics(b, null);
    checkTrue("A revenue allTime sees only A's won value", aRev.allTime.recoveredCents === 123456, String(aRev.allTime.recoveredCents));
    checkTrue("B revenue allTime sees only B's won value", bRev.allTime.recoveredCents === 777777, String(bRev.allTime.recoveredCents));
    const bFunnel = await revenue.revenueFunnelCounts(b);
    checkTrue("B funnel won counts only B's leads", bFunnel.won === 1, String(bFunnel.won));
    // Regression guards for the camelCase-alias bug class the isolation suite
    // exposed (snake_case reads of camelCased rows silently zeroed these):
    checkTrue("B funnel missedCallsRecovered counts B's conversation", bFunnel.missedCallsRecovered === 1, String(bFunnel.missedCallsRecovered));
    checkTrue("B revenue week sees B's own won value", bRev.month.recoveredCents === 777777 || bRev.week.recoveredCents === 777777, String(bRev.week.recoveredCents) + "/" + String(bRev.month.recoveredCents));
    checkTrue("B revenueMetrics totalLeads counts only B's leads", bRev.allTime.wonLeads === 1, String(bRev.allTime.wonLeads));
    const convSet = await conv.leadIdsWithConversations(a, [leadA1.id, leadA2.id]);
    checkTrue("leadIdsWithConversations resolves A's own lead id", convSet.has(leadA1.id) && !convSet.has(leadA2.id), [...convSet].join(","));
    const bConvSet = await conv.leadIdsWithConversations(b, [leadA1.id]);
    checkTrue("leadIdsWithConversations(B) never resolves A's lead", bConvSet.size === 0, [...bConvSet].join(","));
    const aSummaries = await conv.conversationSummariesForLead(a, leadA1.id);
    checkTrue("conversationSummaries messageCount is real (not NaN)", aSummaries.length === 1 && aSummaries[0].messageCount === 1, JSON.stringify(aSummaries.map((s) => s.messageCount)));
  } finally {
    // Cleanup: prove the CASCADE ownership chain the audit relies on.
    await query("DELETE FROM businesses WHERE id = $1", [a]);
    await query("DELETE FROM businesses WHERE id = $1", [b]);
    checkTrue("cleanup removed A (cascade)", (await getBusiness(a)) === null);
    checkTrue("cleanup removed B (cascade)", (await getBusiness(b)) === null);
  }

  console.log(String(checks) + " checks, " + String(failures) + " failures");
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error("isolation suite crashed:", e);
  process.exit(1);
});
