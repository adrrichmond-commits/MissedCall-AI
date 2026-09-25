#!/usr/bin/env bun
/**
 * P5-2 ROI PANEL SUITE — proves the Revenue & ROI dashboard panel computes
 * honestly, isolates per business, and labels every estimate.
 *
 * Runs against DATABASE_URL (Neon in CI — same pattern as test-e2e-journey.ts;
 * USE_LOCAL_POSTGRES=1 routes through the local-pg shim). Three seeded test
 * businesses, all CASCADE-deleted on exit:
 *
 *   B1 "full funnel"  — 4 missed-call leads + 1 web-form lead, conversations
 *                       with AI text-backs and customer replies, 2
 *                       appointments, 2 won jobs (one this month, one 40 days
 *                       ago) → every measured count, the all-time vs month
 *                       revenue split, trial billing, then the trial→starter
 *                       conversion (cost from src/lib/pricing.ts, ROI math,
 *                       trial-to-paid conversion flag).
 *   B2 "isolation"    — a different small dataset seeded AFTER B1 is asserted;
 *                       B1's numbers must not move and B2's must match only
 *                       B2's rows (zero cross-reads), plus the 0.0× month ROI.
 *   B3 "empty"        — brand-new account: all zeros, no crash, honest
 *                       hasActivity=false (the zero-data contract).
 *
 * The pure engine (src/lib/server/roi.ts) is additionally exercised DBless
 * over garbage input — sanitizers, the $0-cost ROI guard, and the estimate
 * labeling contract (estimateFlags all true — the UI renders "Estimate" chips
 * from these flags).
 *
 * Run: bun scripts/test-p52-roi.ts   (exit 0 = every check passed)
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import { createBusinessWithOwner } from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import * as q from "../src/db/queries";
import { buildRoiPanelData } from "../src/lib/server/roiPanel";
import { computeRoiPanel } from "../src/lib/server/roi";
import { getPlan } from "../src/lib/pricing";
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
function eqNum(name: string, actual: unknown, expected: number): void {
  checkTrue(name, Number(actual) === expected, `got ${String(actual)}, want ${String(expected)}`);
}

const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const createdBusinessIds: string[] = [];

async function seedBusiness(label: string): Promise<string> {
  const { business } = await createBusinessWithOwner({
    businessName: `ROI Test ${label} ${STAMP}`,
    ownerEmail: `roi-${label.toLowerCase()}+${STAMP}@roi-test.example.com`,
    ownerFullName: "ROI Tester",
    passwordHash: await hashPassword("roi-password-1234"),
  });
  createdBusinessIds.push(business.id);
  return business.id;
}

async function seedLead(
  businessId: string,
  input: { source: string; status: string; phone: string; valueCents?: number },
): Promise<string> {
  const lead = await q.createLead(businessId, {
    source: input.source as never,
    status: input.status as never,
    serviceNeed: "Kitchen sink backing up",
    contactName: "ROI Customer",
    contactPhone: input.phone,
    estimatedValueCents: input.valueCents ?? null,
  } as never);
  return lead.id;
}

async function linkConversation(businessId: string, conversationId: string, leadId: string): Promise<void> {
  await query("UPDATE conversations SET lead_id = $2 WHERE id = $1 AND business_id = $3", [
    conversationId,
    leadId,
    businessId,
  ]);
}

try {
  // =========================================================================
  // 1. PURE ENGINE — garbage input in, sane panel out (DBless)
  // =========================================================================
  const garbage = computeRoiPanel({
    measured: {
      callsReceived: Number.NaN,
      missedCalls: -5,
      autoResponded: "12" as never,
      customerReplies: Number.POSITIVE_INFINITY,
      leadsRecovered: 1.9 as never,
      appointmentsBooked: null as never,
    },
    jobsWon: -3,
    revenueRecoveredCents: Number.NaN,
    revenueRecoveredMonthCents: -100,
    planId: "trial",
    trialDaysRemaining: -1,
    hasTrialRecord: true,
  });
  eqNum("pure: NaN/negative counts sanitize to 0 (callsReceived)", garbage.measured.callsReceived, 0);
  eqNum("pure: string '12' coerces to 12 (autoResponded)", garbage.measured.autoResponded, 12);
  eqNum("pure: Infinity sanitizes to 0 (customerReplies)", garbage.measured.customerReplies, 0);
  eqNum("pure: fractional floors to 1 (leadsRecovered)", garbage.measured.leadsRecovered, 1);
  eqNum("pure: negative money sanitizes to 0 (revenue)", garbage.estimated.revenueRecoveredCents, 0);
  checkTrue(
    "pure: month revenue can never exceed all-time revenue",
    garbage.estimated.revenueRecoveredMonthCents <= garbage.estimated.revenueRecoveredCents,
  );
  checkTrue(
    "pure: $0 trial cost → ROI null (no fake ∞ or 0×)",
    garbage.estimated.roiMultiple === null,
    String(garbage.estimated.roiMultiple),
  );
  checkTrue(
    "pure: estimate-labeling contract — jobsWon flagged estimate",
    garbage.estimateFlags.jobsWon === true,
  );
  checkTrue(
    "pure: estimate-labeling contract — revenueRecovered flagged estimate",
    garbage.estimateFlags.revenueRecovered === true,
  );
  checkTrue(
    "pure: estimate-labeling contract — roiMultiple flagged estimate",
    garbage.estimateFlags.roiMultiple === true,
  );
  const zeroRoi = computeRoiPanel({
    measured: {
      callsReceived: 1,
      missedCalls: 1,
      autoResponded: 1,
      customerReplies: 1,
      leadsRecovered: 1,
      appointmentsBooked: 1,
    },
    jobsWon: 0,
    revenueRecoveredCents: 0,
    revenueRecoveredMonthCents: 0,
    planId: "starter",
    trialDaysRemaining: null,
    hasTrialRecord: false,
  });
  eqNum("pure: real cost + $0 month revenue → honest 0.0×", zeroRoi.estimated.roiMultiple ?? -1, 0);
  eqNum(
    "pure: starter plan cost resolves from pricing config (not a literal)",
    zeroRoi.billing.monthlyCostCents,
    getPlan("starter")!.priceCents,
  );
  checkTrue("pure: starter plan name from pricing config", zeroRoi.billing.planName === "Starter", zeroRoi.billing.planName);

  // =========================================================================
  // 2. B1 — FULL FUNNEL, measured counts exact
  // =========================================================================
  const b1 = await seedBusiness("A");
  const l1 = await seedLead(b1, { source: "missed_call", status: "new", phone: "+15125550111" });
  const l2 = await seedLead(b1, { source: "missed_call", status: "new", phone: "+15125550112" });
  const l3 = await seedLead(b1, { source: "missed_call", status: "won", phone: "+15125550113", valueCents: 45000 });
  const l4 = await seedLead(b1, { source: "missed_call", status: "won", phone: "+15125550114", valueCents: 20000 });
  await seedLead(b1, { source: "web_form", status: "new", phone: "+15125550115" }); // not a missed call
  // Won timestamps: l3 this month, l4 40 days ago (all-time only).
  await query("UPDATE leads SET converted_at = now() WHERE id = $1 AND business_id = $2", [l3, b1]);
  await query(
    "UPDATE leads SET converted_at = now() - interval '40 days' WHERE id = $1 AND business_id = $2",
    [l4, b1],
  );

  // Conversations: C1 (AI replied + customer replied), C2 (AI only), C3 (customer only).
  const c1 = await q.findOrCreateConversationForPhone(b1, "+15125550111");
  const c2 = await q.findOrCreateConversationForPhone(b1, "+15125550112");
  const c3 = await q.findOrCreateConversationForPhone(b1, "+15125550113");
  await linkConversation(b1, c1.id, l1);
  await linkConversation(b1, c2.id, l2);
  await linkConversation(b1, c3.id, l3);
  await query(
    `INSERT INTO messages (business_id, conversation_id, direction, body, status, classification, sent_at)
     VALUES ($1, $2, 'outbound', 'Hi! Sorry we missed your call — what do you need help with?', 'sent', '{"replySource":"llm_screened"}'::jsonb, now())`,
    [b1, c1.id],
  );
  await query(
    `INSERT INTO messages (business_id, conversation_id, direction, body, status, sent_at)
     VALUES ($1, $2, 'inbound', 'My kitchen sink is backed up, can you come today?', 'delivered', now())`,
    [b1, c1.id],
  );
  await query(
    `INSERT INTO messages (business_id, conversation_id, direction, body, status, classification, sent_at)
     VALUES ($1, $2, 'outbound', 'Hi! Sorry we missed your call — how can we help?', 'sent', '{"replySource":"kb_faq_pricing"}'::jsonb, now())`,
    [b1, c2.id],
  );
  await query(
    `INSERT INTO messages (business_id, conversation_id, direction, body, status, sent_at)
     VALUES ($1, $2, 'inbound', 'Thanks, someone already helped me.', 'delivered', now())`,
    [b1, c3.id],
  );
  // Appointments on two recovered leads.
  await query(
    `INSERT INTO appointments (business_id, lead_id, service_summary, scheduled_at, status, duration_minutes)
     VALUES ($1, $2, 'Kitchen drain clear', now() + interval '1 day', 'confirmed', 90)`,
    [b1, l1],
  );
  await query(
    `INSERT INTO appointments (business_id, lead_id, service_summary, scheduled_at, status, duration_minutes)
     VALUES ($1, $2, 'Sink consult', now() + interval '2 days', 'requested', 60)`,
    [b1, l3],
  );

  const p1 = await buildRoiPanelData(b1);
  eqNum("b1: calls received = 4 missed-call leads", p1.measured.callsReceived, 4);
  eqNum("b1: missed calls = 4", p1.measured.missedCalls, 4);
  eqNum("b1: auto-responded = 2 conversations with AI text-back", p1.measured.autoResponded, 2);
  eqNum("b1: customer replies = 2 conversations with an inbound message", p1.measured.customerReplies, 2);
  eqNum("b1: leads recovered = 3 missed-call leads with a conversation", p1.measured.leadsRecovered, 3);
  eqNum("b1: appointments booked = 2 leads with appointments", p1.measured.appointmentsBooked, 2);
  eqNum("b1: estimated jobs won = 2", p1.estimated.jobsWon, 2);
  eqNum("b1: estimated revenue recovered (all time) = 65000 cents", p1.estimated.revenueRecoveredCents, 65000);
  eqNum("b1: estimated revenue recovered (this month) = 45000 (40-day-old win excluded)", p1.estimated.revenueRecoveredMonthCents, 45000);
  checkTrue("b1: hasActivity true", p1.hasActivity === true);
  checkTrue("b1: on trial", p1.billing.onTrial === true);
  eqNum("b1: trial cost is $0", p1.billing.monthlyCostCents, 0);
  checkTrue("b1: plan name is the free trial", p1.billing.planName === "Free trial", p1.billing.planName);
  checkTrue(
    "b1: trial ROI null while cost is $0",
    p1.estimated.roiMultiple === null,
    String(p1.estimated.roiMultiple),
  );
  checkTrue(
    "b1: trial days remaining in the 13–15 window",
    (p1.billing.trialDaysRemaining ?? 0) >= 13 && (p1.billing.trialDaysRemaining ?? 0) <= 15,
    String(p1.billing.trialDaysRemaining),
  );
  checkTrue("b1: trial record exists → trial-to-paid conversion visible", p1.billing.trialToPaidApplicable === true);
  checkTrue("b1: still on trial → not converted yet", p1.billing.trialToPaidConverted === false);
  checkTrue(
    "b1: invariant — auto-responded ≤ missed calls",
    p1.measured.autoResponded <= p1.measured.missedCalls,
  );
  checkTrue(
    "b1: invariant — recovered ≤ missed calls",
    p1.measured.leadsRecovered <= p1.measured.missedCalls,
  );

  // =========================================================================
  // 3. B1 CONVERTS — trial → starter: cost from pricing config, ROI math
  // =========================================================================
  await query("UPDATE businesses SET plan = 'starter' WHERE id = $1", [b1]);
  const p1s = await buildRoiPanelData(b1);
  const starter = getPlan("starter")!;
  eqNum(
    "b1 paid: subscription cost comes from src/lib/pricing.ts (getPlan)",
    p1s.billing.monthlyCostCents,
    starter.priceCents,
  );
  checkTrue("b1 paid: plan name from pricing config", p1s.billing.planName === starter.name, p1s.billing.planName);
  checkTrue("b1 paid: no longer flagged onTrial", p1s.billing.onTrial === false);
  checkTrue(
    "b1 paid: trial-to-paid conversion RECORDED (had trial + now paid)",
    p1s.billing.trialToPaidConverted === true,
  );
  checkTrue(
    "b1 paid: ROI multiple = month revenue ÷ monthly cost (1 decimal)",
    p1s.estimated.roiMultiple === Math.round((45000 / starter.priceCents) * 10) / 10,
    `got ${String(p1s.estimated.roiMultiple)}`,
  );
  checkTrue("b1 paid: ROI > 1× this month", (p1s.estimated.roiMultiple ?? 0) > 1, String(p1s.estimated.roiMultiple));

  // =========================================================================
  // 4. B2 — ISOLATION (seeded after B1 was fully asserted) + 0.0× month
  // =========================================================================
  const b2 = await seedBusiness("B");
  const b2lead = await seedLead(b2, { source: "missed_call", status: "won", phone: "+15125550121", valueCents: 99000 });
  await query(
    "UPDATE leads SET converted_at = now() - interval '40 days' WHERE id = $1 AND business_id = $2",
    [b2lead, b2],
  );
  await query("UPDATE businesses SET plan = 'starter' WHERE id = $1", [b2]);

  const p2 = await buildRoiPanelData(b2);
  eqNum("b2: calls received = 1 (own rows only)", p2.measured.callsReceived, 1);
  eqNum("b2: auto-responded = 0 (no conversations)", p2.measured.autoResponded, 0);
  eqNum("b2: customer replies = 0", p2.measured.customerReplies, 0);
  eqNum("b2: leads recovered = 0", p2.measured.leadsRecovered, 0);
  eqNum("b2: appointments booked = 0", p2.measured.appointmentsBooked, 0);
  eqNum("b2: estimated jobs won = 1", p2.estimated.jobsWon, 1);
  eqNum("b2: estimated revenue all time = 99000 (own row only)", p2.estimated.revenueRecoveredCents, 99000);
  eqNum("b2: estimated revenue this month = 0 (win was 40 days ago)", p2.estimated.revenueRecoveredMonthCents, 0);
  eqNum(
    "b2: honest 0.0× ROI — real cost, no revenue this month",
    p2.estimated.roiMultiple ?? -1,
    0,
  );

  // Zero cross-reads: B1's panel must be EXACTLY what it was before B2 existed.
  const p1After = await buildRoiPanelData(b1);
  eqNum("isolation: b1 calls received unchanged by b2's data", p1After.measured.callsReceived, 4);
  eqNum("isolation: b1 auto-responded unchanged", p1After.measured.autoResponded, 2);
  eqNum("isolation: b1 customer replies unchanged", p1After.measured.customerReplies, 2);
  eqNum("isolation: b1 revenue unchanged", p1After.estimated.revenueRecoveredCents, 65000);
  eqNum("isolation: b1 month revenue unchanged", p1After.estimated.revenueRecoveredMonthCents, 45000);

  // =========================================================================
  // 5. B3 — EMPTY ACCOUNT (the zero-data contract)
  // =========================================================================
  const b3 = await seedBusiness("C");
  const p3 = await buildRoiPanelData(b3);
  eqNum("b3: brand-new account — calls received 0", p3.measured.callsReceived, 0);
  eqNum("b3: — customer replies 0", p3.measured.customerReplies, 0);
  eqNum("b3: — revenue recovered 0", p3.estimated.revenueRecoveredCents, 0);
  eqNum("b3: — jobs won 0", p3.estimated.jobsWon, 0);
  checkTrue("b3: ROI null on a $0-cost trial", p3.estimated.roiMultiple === null, String(p3.estimated.roiMultiple));
  checkTrue("b3: hasActivity false", p3.hasActivity === false);
  checkTrue("b3: still renders a trial window", (p3.billing.trialDaysRemaining ?? 0) >= 13, String(p3.billing.trialDaysRemaining));
  checkTrue("b3: estimate labels still contracted on an empty panel", p3.estimateFlags.roiMultiple === true);
} finally {
  // CASCADE removes the businesses' leads/conversations/messages/appointments/users.
  for (const id of createdBusinessIds) {
    await query("DELETE FROM businesses WHERE id = $1", [id]);
  }
  if (createdBusinessIds.length > 0) {
    const left = (await query(
      "SELECT count(*)::int AS n FROM businesses WHERE name LIKE 'ROI Test %'",
    )) as { n: number }[];
    checkTrue("cleanup: all ROI test businesses removed", left[0]?.n === 0, String(left[0]?.n));
  }
}

console.log(`\nP5-2 ROI ${failures === 0 ? "PASS" : "FAIL"} — ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
export {};
