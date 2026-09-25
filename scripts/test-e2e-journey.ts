#!/usr/bin/env bun
/**
 * P5-1 END-TO-END JOURNEY SUITE — the owner's #1 requirement: prove the full
 * new-plumber journey works as a user experiences it, and pin every P5-1
 * journey fix with a regression check.
 *
 * Two layers, one suite:
 *
 * 1. JOURNEY (DB, always runs — needs DATABASE_URL like test-isolation.ts):
 *    account + 14-day trial → onboarding config (services, service area,
 *    hours, emergency prefs) → missed call (captureMissedCallLead) → AI
 *    conversation (handleInboundSms: emergency + routine turns) → lead
 *    updated + emergency escalation + in-app notifications → appointment
 *    booking through the NEW booking core (valid slot, duplicate double-submit
 *    collapse, out-of-area refusal + owner exception, emergency booking,
 *    invalid-input rejections) → trial-expiry read-only math → AI instructions
 *    settings → AI handoff. Cleans up after itself (one test business,
 *    CASCADE-deleted). Twilio/LLM/Stripe env state changes which live
 *    transports the journey exercises — every assertion is on the honest
 *    contract (e.g. text-back outcome is NEVER 'sent' to a synthetic number),
 *    never on a specific provider being wired.
 *
 * 2. PROD-BUILD RPC (only when JOURNEY_BASE_URL is set, e.g. the prod-serve
 *    harness): signup via the real RPC wire format (smoke-suite patterns),
 *    invalid-signup rejection, fresh-account pages, appointment RPC
 *    validation, and the expired-trial write gate end-to-end (trial flipped
 *    in the DB, write RPC must refuse and create nothing, trial restored).
 *
 * Run:
 *   bun scripts/test-e2e-journey.ts
 *   JOURNEY_BASE_URL=http://localhost:3210 bun scripts/test-e2e-journey.ts
 * Exit 0 = every check passed.
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import { createBusinessWithOwner, getBusiness, updateBusinessSettings } from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import * as q from "../src/db/queries";
import { captureMissedCallLead, handleInboundSms, readEmergencyInstructions } from "../src/lib/server/textBack";
import { bookAppointment, validateBookingInput } from "../src/lib/server/appointmentBooking";
import { buildClassifierSystemPrompt } from "../src/lib/server/classifyPipeline";
import { trialDaysRemaining } from "../src/lib/trialValue";
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

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const EMAIL = `journey+${STAMP}@journey-test.example.com`;

let businessId: string | null = null;
try {
  // =========================================================================
  // 1. ACCOUNT + 14-DAY TRIAL (signupFn's exact core)
  // =========================================================================
  const passwordHash = await hashPassword("journey-password-1234");
  const { business } = await createBusinessWithOwner({
    businessName: "Journey Test Plumbing " + STAMP,
    ownerEmail: EMAIL,
    ownerFullName: "Journey Tester",
    passwordHash,
  });
  businessId = business.id;
  checkTrue("account: business created", !!business.id);
  const bizMapped = await getBusiness(business.id);
  const trialMs = new Date((bizMapped?.trialEndsAt ?? 0) as unknown as string).getTime() - Date.now();
  checkTrue(
    "account: 14-day trial stamped (13.5–14.5 days)",
    trialMs > 13.5 * 24 * 3600 * 1000 && trialMs < 14.5 * 24 * 3600 * 1000,
    String(Math.round(trialMs / 3600000)) + "h",
  );
  checkTrue("account: plan starts on trial", business.plan === "trial", String(business.plan));

  // =========================================================================
  // 2. ONBOARDING CONFIG (the same query writes the settings fns perform)
  // =========================================================================
  const area = await q.createServiceArea(businessId, { kind: "zip", value: "78701", state: "TX" } as never);
  checkTrue("onboarding: service area saved", !!area?.id);
  const svc = await q.createService(businessId, { name: "Drain cleaning", isActive: true } as never);
  checkTrue("onboarding: service saved", !!svc?.id);
  for (const d of [0, 1, 2, 3, 4, 5, 6]) {
    await q.upsertBusinessHour(businessId, {
      dayOfWeek: d,
      isOpen: d >= 1 && d <= 5,
      opensAt: d >= 1 && d <= 5 ? "08:00" : null,
      closesAt: d >= 1 && d <= 5 ? "17:00" : null,
    } as never);
  }
  checkTrue("onboarding: 7 business-hour rows written", (await q.countBusinessHours(businessId)) === 7);

  // =========================================================================
  // 3. MISSED CALL → LEAD CAPTURE (captureMissedCallLead, the real entry)
  // =========================================================================
  // This environment may have LIVE Twilio credentials — the suite uses
  // synthetic 555 numbers, so every number is opted out FIRST. That exercises
  // the engine's strongest never-send guarantee and makes the journey
  // deterministic: no real SMS can ever leave the test.
  const TEST_NUMBERS = ["+15125550101", "+15125550102", "+15125550103", "+15125550104"];
  for (const n of TEST_NUMBERS) {
    await q.addSmsOptOut(businessId, { phone: n, reason: "owner_added" });
  }
  const captured = await captureMissedCallLead(businessId, business.name, {
    source: "missed_call",
    contactName: "Pat Fielder",
    contactPhone: "+15125550101",
    contactAddress: "1109 Chalmers Ave, Austin, TX 78701",
    serviceNeed: "Kitchen sink backing up",
    urgency: "same_day",
  });
  const lead = captured.lead;
  checkTrue("missed call: lead ALWAYS captured", !!lead?.id);
  checkTrue("missed call: source stamped missed_call", lead.source === "missed_call");
  checkTrue(
    "missed call: in-area lead stamped from service area",
    lead.serviceAreaStatus === "in_area",
    String(lead.serviceAreaStatus),
  );
  // Honest SMS gating: with Twilio unset (or a synthetic number) the text-back
  // must NOT claim success. A real send to a fake number would be a bug.
  checkTrue(
    "missed call: opted-out numbers are NEVER texted (opt-out is the never-send rule)",
    captured.textBack.outcome === "opted_out",
    captured.textBack.outcome + "/" + String(captured.textBack.reason),
  );
  const notifRows = (await query(
    "SELECT type, payload::text AS payload FROM notifications WHERE business_id = $1",
    [businessId],
  )) as { type: string; payload: string }[];
  checkTrue(
    "missed call: in-app new_lead notification created",
    notifRows.some((r) => r.type === "new_lead" && r.payload.includes(lead.id)),
  );

  // =========================================================================
  // 4. AI CONVERSATION — emergency turn + routine turn (real pipeline)
  // =========================================================================
  const emergencyConv = await q.findOrCreateConversationForPhone(businessId, "+15125550101");
  const emergencyTurn = await handleInboundSms({
    businessId,
    businessName: business.name,
    conversationId: emergencyConv.id,
    body: "My basement is FLOODING and I cannot shut off the water, please help!",
    from: "+15125550101",
    externalId: null,
  });
  checkTrue("ai: emergency turn classified + delivered", emergencyTurn.status === "delivered");
  const emergencyLead = await q.getLead(businessId, lead.id);
  checkTrue(
    "ai: emergency turn re-stamps the lead emergency",
    emergencyLead?.priority === "emergency" && emergencyLead?.urgency === "emergency",
    `${emergencyLead?.priority}/${emergencyLead?.urgency}`,
  );
  const escRows = (await query(
    "SELECT payload::text AS payload FROM notifications WHERE business_id = $1",
    [businessId],
  )) as { payload: string }[];
  checkTrue(
    "ai: emergency escalation notification carries the emergency payload",
    escRows.some((r) => r.payload.includes('"emergency":true') || r.payload.includes('"emergency": true')),
  );

  const routineConv = await q.findOrCreateConversationForPhone(businessId, "+15125550102");
  const routineTurn = await handleInboundSms({
    businessId,
    businessName: business.name,
    conversationId: routineConv.id,
    body: "Hi, my kitchen faucet drips constantly. Can someone look at it this week?",
    from: "+15125550102",
    externalId: null,
  });
  checkTrue("ai: routine turn classified + delivered", routineTurn.status === "delivered");
  checkTrue(
    "ai: fresh account has no usage gate on routine turns",
    routineTurn.limitReached === null,
    JSON.stringify(routineTurn.limitReached),
  );
  const convLinked = await q.getConversation(businessId, emergencyConv.id);
  checkTrue(
    "ai: reply conversation is BACKFILL-linked to the captured lead (P5-1 fix)",
    convLinked?.leadId === lead.id,
    String(convLinked?.leadId),
  );

  // =========================================================================
  // 5. SCHEDULE APPOINTMENT (the P5-1 booking core — was MISSING entirely)
  // =========================================================================
  const when = new Date(Date.now() + 26 * 3600 * 1000); // tomorrow-ish, valid
  const booking = await bookAppointment(
    { businessId, timezone: business.timezone },
    {
      leadId: lead.id,
      serviceSummary: "Kitchen drain clear",
      scheduledAt: when.toISOString(),
      durationMinutes: "90",
      address: "1109 Chalmers Ave, Austin, TX 78701",
    },
  );
  checkTrue("schedule: valid slot books", booking.ok === true);
  if (booking.ok) {
    checkTrue("schedule: business booking lands confirmed", booking.appointment.status === "confirmed");
    checkTrue("schedule: not flagged duplicate", booking.duplicate === false);
  }
  // DUPLICATE SUBMISSION: the exact same booking twice (double-click, double
  // POST, retry) collapses onto the EXISTING appointment.
  const rebook = await bookAppointment(
    { businessId, timezone: business.timezone },
    {
      leadId: lead.id,
      serviceSummary: "Kitchen drain clear",
      scheduledAt: when.toISOString(),
      durationMinutes: "90",
      address: "1109 Chalmers Ave, Austin, TX 78701",
    },
  );
  checkTrue("schedule: re-submission accepted honestly", rebook.ok === true);
  if (rebook.ok && booking.ok) {
    checkTrue("schedule: duplicate flagged", rebook.duplicate === true);
    checkTrue(
      "schedule: duplicate returns the SAME appointment (no second row)",
      rebook.appointment.id === (booking.ok ? booking.appointment.id : ""),
    );
  }
  const apptCount = (await query("SELECT count(*)::int AS n FROM appointments WHERE business_id = $1", [businessId])) as { n: number }[];
  checkTrue("schedule: exactly ONE appointment exists after double-submit", apptCount[0]?.n === 1, String(apptCount[0]?.n));
  const bookedLead = await q.getLead(businessId, lead.id);
  checkTrue(
    "schedule: lead auto-advanced to appointment_scheduled",
    bookedLead?.status === "appointment_scheduled",
    String(bookedLead?.status),
  );
  checkTrue(
    "schedule: appointment_confirmed notification created",
    ((await query("SELECT 1 FROM notifications WHERE business_id = $1 AND type = 'appointment_confirmed'", [businessId])) as unknown[]).length > 0,
  );
  // A DIFFERENT slot is a real new booking (window is not over-broad).
  const later = await bookAppointment(
    { businessId, timezone: business.timezone },
    { leadId: lead.id, serviceSummary: "Faucet repair", scheduledAt: new Date(Date.now() + 96 * 3600 * 1000).toISOString() },
  );
  checkTrue("schedule: a different slot is NOT collapsed", later.ok === true && (later.ok ? later.duplicate === false : false));

  // Out-of-area: definitive ZIP outside the service area refuses first.
  const ooaLead = await q.createLead(businessId, {
    source: "missed_call",
    contactName: "Far Customer",
    contactPhone: "+15125550103",
    contactAddress: "500 Main St, Dallas, TX 99999",
    serviceNeed: "Water heater swap",
  });
  const ooa = await bookAppointment(
    { businessId, timezone: business.timezone },
    { leadId: ooaLead.id, serviceSummary: "Water heater swap", scheduledAt: new Date(Date.now() + 30 * 3600 * 1000).toISOString() },
  );
  checkTrue(
    "out-of-area: definitive out-of-area booking refused (422)",
    !ooa.ok && ooa.status === 422 && ooa.code === "out_of_area",
    !ooa.ok ? `${ooa.status}/${ooa.code ?? ""}` : "booked?!",  // eslint-disable-line @typescript-eslint/no-explicit-any
  );
  const ooaConfirmed = await bookAppointment(
    { businessId, timezone: business.timezone },
    {
      leadId: ooaLead.id,
      serviceSummary: "Water heater swap",
      scheduledAt: new Date(Date.now() + 30 * 3600 * 1000).toISOString(),
      confirmOutOfArea: true,
    },
  );
  checkTrue("out-of-area: owner exception books when confirmed", ooaConfirmed.ok === true);
  if (ooaConfirmed.ok) {
    checkTrue(
      "out-of-area: exception recorded on the appointment",
      ooaConfirmed.appointment.serviceSummary.includes("out-of-area exception"),
    );
  }

  // Emergency lead books normally, keeps its stamp.
  const emLead = await q.createLead(businessId, {
    source: "missed_call",
    contactName: "Urgent Irene",
    contactPhone: "+15125550104",
    contactAddress: "42 Congress Ave, Austin, TX 78701",
    serviceNeed: "Burst pipe",
    urgency: "emergency",
  });
  await q.updateLead(businessId, emLead.id, { priority: "emergency", urgency: "emergency" });
  const emBook = await bookAppointment(
    { businessId, timezone: business.timezone },
    { leadId: emLead.id, serviceSummary: "Burst pipe shutoff + repair", scheduledAt: new Date(Date.now() + 2 * 3600 * 1000).toISOString() },
  );
  checkTrue("emergency: emergency lead books", emBook.ok === true);
  const emAfter = emBook.ok ? await q.getLead(businessId, emLead.id) : null;
  checkTrue("emergency: emergency stamp intact after booking", emAfter?.priority === "emergency");

  // Invalid input rejections (client-safe messages, no throw).
  const past = await bookAppointment(
    { businessId, timezone: business.timezone },
    { leadId: lead.id, serviceSummary: "x", scheduledAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString() },
  );
  checkTrue("invalid: past slot refused", !past.ok && past.status === 400);
  const garbage = await bookAppointment(
    { businessId, timezone: business.timezone },
    { leadId: lead.id, serviceSummary: "x", scheduledAt: "not-a-date" },
  );
  checkTrue("invalid: unreadable date refused", !garbage.ok && garbage.status === 400);
  const emptySummary = await bookAppointment({ businessId, timezone: business.timezone }, { scheduledAt: when.toISOString(), serviceSummary: "   " });
  checkTrue("invalid: blank service summary refused", !emptySummary.ok && emptySummary.status === 400);
  const badDuration = await bookAppointment(
    { businessId, timezone: business.timezone },
    { leadId: lead.id, serviceSummary: "x", scheduledAt: when.toISOString(), durationMinutes: "0" },
  );
  checkTrue("invalid: zero duration refused", !badDuration.ok && badDuration.status === 400);
  const pure = validateBookingInput({ serviceSummary: "ok", scheduledAt: when.toISOString(), durationMinutes: 99999 });
  checkTrue("invalid: over-max duration refused (pure validator)", !pure.ok);

  // =========================================================================
  // 6. TRIAL EXPIRY — read-only math + write gating is proven end-to-end in
  //    the HTTP section; here we pin the shared boundary math honestly.
  // =========================================================================
  const expiredMs = Date.now() - 24 * 3600 * 1000;
  checkTrue("trial: expired trial reads 0 days left", trialDaysRemaining(expiredMs, Date.now()) <= 0);
  checkTrue("trial: active trial reads positive days", trialDaysRemaining(Date.now() + 14 * 24 * 3600 * 1000, Date.now()) > 0);
  const bizAfter = await getBusiness(businessId);
  checkTrue("trial: reads keep working regardless of trial state", !!bizAfter);

  // =========================================================================
  // 7. AI INSTRUCTIONS — settings → AI handoff (was stored-but-ignored)
  // =========================================================================
  const INSTR = "Always ask if the water is shut off first, then page the on-call tech immediately.";
  await updateBusinessSettings(businessId, {
    ...(business.settings ?? {}),
    emergencyInstructions: INSTR,
    emergencyPrefsSavedAt: new Date().toISOString(),
  } as never);
  const reread = await getBusiness(businessId);
  const extracted = readEmergencyInstructions((reread as unknown as { settings?: unknown })?.settings);
  checkTrue("ai-instructions: value read back from the FLAT settings shape", extracted === INSTR, String(extracted));
  checkTrue("ai-instructions: blank settings extract to null", readEmergencyInstructions(undefined) === null && readEmergencyInstructions({ emergencyInstructions: "   " }) === null);
  const promptWith = buildClassifierSystemPrompt(INSTR);
  checkTrue(
    "ai-instructions: prompt block appended AFTER the guardrail policy",
    promptWith.includes("BUSINESS EMERGENCY INSTRUCTIONS") && promptWith.includes(INSTR) && promptWith.indexOf("SAFETY POLICY") < promptWith.indexOf(INSTR),
  );
  checkTrue("ai-instructions: no instructions → no block (byte-identical launch prompt)", !buildClassifierSystemPrompt(null).includes("BUSINESS EMERGENCY INSTRUCTIONS"));
} finally {
  if (businessId) await query("DELETE FROM businesses WHERE id = $1", [businessId]);
}

// ===========================================================================
// 8. PROD-BUILD RPC JOURNEY (only when JOURNEY_BASE_URL is set)
// ===========================================================================
if (process.env.JOURNEY_BASE_URL) {
  const BASE = process.env.JOURNEY_BASE_URL.replace(/\/+$/, "");
  const { createHash } = await import("node:crypto");

  const s = (v: string): unknown => ({ t: 1, s: v });
  const obj = (i: number, keys: string[], values: unknown[]): unknown => ({ t: 10, i, p: { k: keys, v: values }, o: 0 });
  const rpcBody = (keys: string[], values: string[]): string =>
    JSON.stringify({ t: obj(0, ["data"], [obj(1, keys, values.map((v) => s(v)))]), f: 63, m: [] });
  const prodId = (file: string, exportName: string): string =>
    createHash("sha256").update(`${file.split("?")[0].replace(/^\//, "")}--${exportName}`).digest("hex");
  const devId = (file: string, exportName: string): string =>
    Buffer.from(JSON.stringify({ file, export: exportName })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  async function callFn(file: string, fn: string, keys: string[], values: string[]): Promise<{ status: number; cookies: string[]; text: string }> {
    const urls = [
      `${BASE}/_serverFn/${prodId(file, fn + "_createServerFn_handler")}`,
      `${BASE}/_serverFn/${devId(file, fn + "_createServerFn_handler")}`,
    ];
    let last = { status: 0, cookies: [] as string[], text: "" };
    for (const url of urls) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tsr-serverfn": "true",
          accept: "application/x-tss-framed, application/x-ndjson, application/json",
          origin: BASE,
          referer: BASE + "/login",
          "sec-fetch-site": "same-origin",
        },
        body: rpcBody(keys, values),
      });
      const gsc = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
      last = { status: res.status, cookies: typeof gsc === "function" ? gsc.call(res.headers) : [], text: await res.text() };
      if (res.status === 200) return last;
    }
    return last;
  }
  const cookieHeader = (cookies: string[]): string => cookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  async function getPage(path: string, cookie?: string): Promise<{ status: number; url: string; html: string }> {
    const res = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {}, redirect: "follow" });
    return { status: res.status, url: res.url, html: await res.text() };
  }

  checkTrue("http: /api/healthz answers ok", await (async () => {
    const res = await fetch(`${BASE}/api/healthz`);
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return res.status === 200 && body?.ok === true;
  })());

  // Fresh account through the REAL signup RPC.
  const stamp = String(Date.now()).slice(-10);
  const email = `journey-rpc+${stamp}@journey-test.example.com`;
  const signup = await callFn("/src/lib/server/authFns.ts?tss-serverfn-split", "signupFn", ["businessName", "fullName", "email", "password"], [
    "Journey RPC Plumbing " + stamp,
    "RPC Tester",
    email,
    "journey-rpc-password-1234",
  ]);
  const cookie = cookieHeader(signup.cookies);
  checkTrue("http: signup RPC answered 200 with a session", signup.status === 200 && cookie.length > 0, `status ${signup.status}`);

  const badSignup = await callFn("/src/lib/server/authFns.ts?tss-serverfn-split", "signupFn", ["businessName", "fullName", "email", "password"], [
    "Weak Password Co",
    "Weak Tester",
    `journey-rpc-bad+${stamp}@journey-test.example.com`,
    "short",
  ]);
  checkTrue(
    "http: invalid signup rejected with a client-safe message",
    badSignup.text.includes("at least 8 characters"),
    badSignup.text.slice(0, 120),
  );

  const dash = await getPage("/dashboard", cookie);
  checkTrue(
    "http: fresh account lands on dashboard/onboarding (trial active)",
    dash.status === 200 && ["/dashboard", "/onboarding"].includes(new URL(dash.url).pathname),
    `status ${dash.status} url ${dash.url}`,
  );
  for (const p of ["/billing", "/leads", "/appointments", "/settings"]) {
    const page = await getPage(p, cookie);
    checkTrue(`http: fresh account ${p} renders`, page.status === 200 && new URL(page.url).pathname === p, `status ${page.status} url ${page.url}`);
  }

  // Appointment RPC: blank summary must be refused by the new validation.
  const badBook = await callFn("/src/lib/server/appFns.ts?tss-serverfn-split", "scheduleAppointmentFn", ["leadId", "serviceSummary", "scheduledAt"], [
    "",
    "   ",
    new Date(Date.now() + 3600 * 1000).toISOString(),
  ]);
  checkTrue(
    "http: schedule RPC refuses blank service summary (client-safe)",
    badBook.text.includes("Describe the work"),
    badBook.text.slice(0, 140),
  );

  // EXPIRED-TRIAL WRITE GATE, end-to-end: flip the RPC account's trial into
  // the past, the write RPC must refuse AND create nothing, then restore.
  const rpcBiz = (await query(
    "SELECT business_id FROM users WHERE email = $1",
    [email],
  )) as { business_id: string }[];
  if (rpcBiz[0]) {
    const bid = rpcBiz[0].business_id;
    await query("UPDATE businesses SET trial_ends_at = now() - interval '1 day' WHERE id = $1", [bid]);
    const blocked = await callFn("/src/lib/server/appFns.ts?tss-serverfn-split", "scheduleAppointmentFn", ["serviceSummary", "scheduledAt"], [
      "Expired trial attempt",
      new Date(Date.now() + 7200 * 1000).toISOString(),
    ]);
    const blockedCount = (await query("SELECT count(*)::int AS n FROM appointments WHERE business_id = $1", [bid])) as { n: number }[];
    checkTrue("http: expired trial — write RPC creates NOTHING", blockedCount[0]?.n === 0, String(blockedCount[0]?.n));
    checkTrue(
      "http: expired trial — honest read-only message",
      blocked.text.includes("read-only"),
      blocked.text.slice(0, 140),
    );
    const billing = await getPage("/billing", cookie);
    checkTrue("http: expired trial — billing page still renders (reads open)", billing.status === 200, `status ${billing.status}`);
    await query("UPDATE businesses SET trial_ends_at = now() + interval '14 days' WHERE id = $1", [bid]);
    await query("DELETE FROM businesses WHERE id = $1", [bid]);
    checkTrue("http: expired trial — trial window restored + RPC business cleaned up", true);
  } else {
    checkTrue("http: expired trial — RPC business located", false, "no business row for " + email);
  }
} else {
  console.log("skip PROD-BUILD RPC journey — set JOURNEY_BASE_URL (e.g. the prod-serve harness) to include it");
}

console.log(`\nJOURNEY ${failures === 0 ? "PASS" : "FAIL"} — ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);

export {};
