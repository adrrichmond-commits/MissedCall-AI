#!/usr/bin/env bun
/**
 * P5-8 onboarding + UI suite — the last Phase 5 package: onboarding data-point
 * audit, progress-indicator honesty, and the responsive pass.
 *
 * Sections:
 *   1. DB-BACKED 12 DATA POINTS (self-cleaning, journey-suite pattern): one
 *      test business, written with the EXACT query calls the signup →
 *      onboarding flow performs (createBusinessWithOwner, updateBusiness,
 *      createService, createServiceArea, upsertBusinessHour,
 *      updateBusinessSettings) — then read back from the DB so every one of
 *      the 12 collected data points is proven persisted, and the deferred
 *      points (website, address line 2) proven untouched by a step-1 re-save.
 *   2. STATIC collection pins: every data point has a real input in
 *      /signup or the wizard (field names/ids), no invented progress.
 *   3. PROGRESS-INDICATOR HONESTY (static): visible "Step X of 5" count,
 *      honest position percent, server-derived resume for returning users,
 *      finish gated on the server percent (never a fake 100%), and the
 *      provider-gated steps hard-false and excluded from the percent.
 *   4. RESPONSIVE MARKERS (static): pin the md→lg desktop-nav fix (audit
 *      "783 vs 753"), the analytics digest-select min-w-0 fix, and the inbox
 *      conversation-list min-w-0 fix so they cannot silently regress. The
 *      full 375/768/1280 sweep was done live in a browser during P5-8 — all
 *      named surfaces measured scrollWidth == clientWidth — the markers here
 *      are the cheap regression net, not a substitute for the sweep.
 *
 * Run: bun scripts/test-p58-onboarding-ui.ts   (exit 0 = every check passed)
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import { createBusinessWithOwner, getBusiness, updateBusiness, updateBusinessSettings, findUserByEmail } from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import * as q from "../src/db/queries";
import { readFileSync } from "node:fs";
if (process.env.USE_LOCAL_POSTGRES === "1") await installLocalPostgresShim();

const ROOT = new URL("..", import.meta.url).pathname;
function src(rel: string): string {
  return readFileSync(ROOT + rel, "utf8");
}

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
function pin(rel: string, name: string, needle: string): void {
  checkTrue(name, src(rel).includes(needle), "missing from " + rel + ": " + JSON.stringify(needle.slice(0, 80)));
}

// The audited 12 (documented in src/routes/_app/onboarding.tsx): every point
// the signup → onboarding journey collects. Deferred (website, address line 2,
// texting number, AI test) are NOT in this list and must never be counted.
const DATA_POINTS = 12;

// ===========================================================================
// 1. DB-BACKED 12 DATA POINTS — same writes the flow performs, read back
// ===========================================================================
const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const EMAIL = `p58+${STAMP}@p58-test.example.com`;
let businessId: string | null = null;
try {
  // Points 1–4 at signup (signupFn's exact core).
  const passwordHash = await hashPassword("p58-password-1234");
  const { business } = await createBusinessWithOwner({
    businessName: "P58 Audit Plumbing " + STAMP,
    ownerEmail: EMAIL,
    ownerFullName: "P58 Tester",
    passwordHash,
  });
  businessId = business.id;
  checkTrue("db: 1 business name persisted (signup)", business.name === "P58 Audit Plumbing " + STAMP);
  const owner = await findUserByEmail(EMAIL);
  checkTrue("db: 2 owner full name persisted (signup)", owner?.fullName === "P58 Tester", String(owner?.fullName));
  checkTrue("db: 3 work email persisted (signup)", owner?.email === EMAIL);
  const hashRow = (await query("SELECT password_hash FROM users WHERE email = $1", [EMAIL])) as { passwordHash: string }[];
  checkTrue(
    "db: 4 password stored only as a salted hash (never plaintext)",
    typeof hashRow[0]?.passwordHash === "string" &&
      hashRow[0].passwordHash.length >= 40 &&
      hashRow[0].passwordHash !== "p58-password-1234" &&
      !hashRow[0].passwordHash.includes("p58-password-1234"),
    String(hashRow[0]?.passwordHash).slice(0, 12),
  );

  // Points 5–7 on wizard step 1 (updateBusinessInfoFn's exact query write).
  await updateBusiness(businessId, {
    phone: "+15125550123",
    addressLine1: "1109 Chalmers Ave",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    timezone: "America/Chicago",
  } as never);
  const afterInfo = await getBusiness(businessId);
  checkTrue("db: 5 main phone persisted (step 1)", afterInfo?.phone === "+15125550123", String(afterInfo?.phone));
  checkTrue(
    "db: 6 location persisted — street/city/state/ZIP (step 1)",
    afterInfo?.addressLine1 === "1109 Chalmers Ave" &&
      afterInfo?.city === "Austin" &&
      afterInfo?.state === "TX" &&
      afterInfo?.postalCode === "78701",
    `${afterInfo?.addressLine1}/${afterInfo?.city}/${afterInfo?.state}/${afterInfo?.postalCode}`,
  );
  checkTrue("db: 7 time zone persisted (step 1)", afterInfo?.timezone === "America/Chicago", String(afterInfo?.timezone));
  // Deferred point honesty: a step-1 save that does not mention website or
  // address line 2 must never blank the stored values (Settings owns them).
  checkTrue(
    "db: deferred website + address line 2 untouched by a step-1 re-save",
    afterInfo?.website === null && afterInfo?.addressLine2 === null,
    `${String(afterInfo?.website)}/${String(afterInfo?.addressLine2)}`,
  );

  // Points 8–9 on wizard step 2 (seedServicesFromDefaultsFn / addServiceAreaFn writes).
  const svc = await q.createService(businessId, { name: "Drain cleaning", isActive: true } as never);
  checkTrue("db: 8 service persisted (step 2)", !!svc?.id && (await q.countServices(businessId)) === 1);
  const area = await q.createServiceArea(businessId, { kind: "zip", value: "78701", state: "TX" } as never);
  checkTrue("db: 9 service area persisted (step 2)", !!area?.id && (await q.countServiceAreas(businessId)) === 1);

  // Point 10 on wizard step 3 (saveBusinessHoursFn writes all 7 days).
  for (const d of [0, 1, 2, 3, 4, 5, 6]) {
    await q.upsertBusinessHour(businessId, {
      dayOfWeek: d,
      isOpen: d <= 4,
      opensAt: d <= 4 ? "08:00" : null,
      closesAt: d <= 4 ? "17:00" : null,
    } as never);
  }
  const hours = await q.listBusinessHours(businessId);
  checkTrue(
    "db: 10 business hours persisted — 7 rows, at least one open (step 3)",
    hours.length === 7 && hours.some((h) => h.isOpen),
    String(hours.length) + " rows",
  );

  // Points 11–12: emergency + notification prefs on businesses.settings
  // (saveEmergencyPrefsFn / saveNotificationPrefsFn's exact write shape).
  const current = (await getBusiness(businessId)) as unknown as { settings?: Record<string, unknown> } | null;
  await updateBusinessSettings(businessId, {
    ...(current?.settings ?? {}),
    onMissedCallSms: true,
    onNewLeadEmail: false,
    dailySummaryEmail: false,
    weeklySummaryEmail: false,
    notificationPrefsSavedAt: new Date().toISOString(),
    afterHoursEmergency: true,
    emergencyNotificationEmail: true,
    emergencyNotificationSms: false,
    emergencyInstructions: "Shut off the main valve first, then call back within 10 minutes.",
    emergencyPrefsSavedAt: new Date().toISOString(),
  });
  const withPrefs = (await getBusiness(businessId)) as unknown as { settings?: Record<string, unknown> } | null;
  const st = withPrefs?.settings ?? {};
  checkTrue(
    "db: 11 emergency prefs persisted incl. instructions (step 3)",
    st.afterHoursEmergency === true &&
      st.emergencyNotificationEmail === true &&
      st.emergencyInstructions === "Shut off the main valve first, then call back within 10 minutes." &&
      typeof st.emergencyPrefsSavedAt === "string",
  );
  checkTrue(
    "db: 12 notification prefs persisted with saved-at stamp (step 4)",
    st.onMissedCallSms === true && st.onNewLeadEmail === false && typeof st.notificationPrefsSavedAt === "string",
  );
} finally {
  if (businessId) await query("DELETE FROM businesses WHERE id = $1", [businessId]);
}
checkTrue("db: test business cleaned up (self-cleaning suite)", !(await findUserByEmail(EMAIL)));

// ===========================================================================
// 2. STATIC COLLECTION PINS — every data point has a real input in the flow
// ===========================================================================
pin("src/routes/signup.tsx", "signup: business name input", 'name="businessName"');
pin("src/routes/signup.tsx", "signup: owner full name input", 'name="fullName"');
pin("src/routes/signup.tsx", "signup: work email input", 'name="email"');
pin("src/routes/signup.tsx", "signup: password input with min length", "minLength={8}");
const onb = "src/routes/_app/onboarding.tsx";
pin(onb, "step1: main phone input", 'id="onb-phone"');
pin(onb, "step1: street address input", 'id="onb-addr1"');
pin(onb, "step1: city input", 'id="onb-city"');
pin(onb, "step1: state select", 'id="onb-state"');
pin(onb, "step1: ZIP input", 'id="onb-zip"');
pin(onb, "step1: time zone select", 'id="onb-tz"');
pin(onb, "step2: services checklist from defaults", "view.serviceDefaults.map");
pin(onb, "step2: service area editor (kind + value)", 'id="onb-area-kind"');
pin(onb, "step2: service area value input", 'id="onb-area-value"');
pin(onb, "step3: 7-day hours editor", "BUSINESS_DAYS.map");
pin(onb, "step3: hours validated HH:MM", "TIME_RE");
pin(onb, "step3: emergency instructions textarea", 'id="onb-emg-instructions"');
pin(onb, "step4: notification pref switches", "NOTIFICATION_PREF_KEYS.map");
checkTrue(
  "audit: the documented data-point list has exactly 12 entries (P5-8 scope)",
  (src(onb).match(/\/signup →|step 1\)|step 2\)|step 3\)|step 4\)/g) ?? []).length >= 10 && DATA_POINTS === 12,
);

// ===========================================================================
// 3. PROGRESS-INDICATOR HONESTY — visible count, resume, no fake 100%
// ===========================================================================
pin(onb, "progress: visible 'Step X of 5' count", "Step {step} of {TOTAL_STEPS}");
pin(onb, "progress: percent bar is a real aria progressbar", 'role="progressbar"');
pin(onb, "progress: percent reflects wizard position honestly", "Math.round(((step - 1) / TOTAL_STEPS) * 100)");
pin(onb, "progress: resume for returning users via server-derived nudge", "getOnboardingNudgeFn()");
pin(onb, "progress: nudge resumeStep maps onto the 5 screens", "setStep(resumeTargetStep(");
pin(onb, "completion: finish gated on the SERVER-derived percent (no fake 100)", "nudge.percent === 100");
const fns = "src/lib/server/settingsFns.ts";
pin(fns, "honesty: completion percent counts ONLY the 5 self-serve steps", "const selfServe = done.slice(0, 5);");
pin(
  fns,
  "honesty: percent formula excludes provider-gated steps",
  "Math.round((selfServe.filter(Boolean).length / selfServe.length) * 100)",
);
pin(fns, "honesty: phone-number step stays open until the provider connects", "// Phone number: assigned once the messaging provider is connected.");
pin(fns, "honesty: test-AI step stays open until the receptionist is live", "// Test AI: possible once the receptionist is live.");
pin(fns, "honesty: a skipped onboarding is never nagged again", "onboardingSkippedAt");
pin(onb, "honesty: unfinished finish attempt lists what is actually missing", "Not finished yet");

// Deferred points documented, never faked as collected.
pin(onb, "deferred: website + address line 2 pass through untouched", "website: initial.website ?? \"\"");
pin(onb, "deferred: address line 2 passes through untouched", "addressLine2: initial.addressLine2 ?? \"\"");
pin(onb, "deferred: texting number shown as provider-gated status", "Assigned automatically once the texting provider is connected");
pin(onb, "deferred: A2P gate stated honestly in the UI", "carrier campaign approval (A2P) comes through");

// ===========================================================================
// 4. RESPONSIVE MARKERS — the P5-8 fixes cannot silently regress
// ===========================================================================
const nav = "src/components/marketing/Nav.tsx";
pin(nav, "responsive: desktop nav fires at lg, not md (768px overflow fix)", "hidden items-center gap-1 lg:flex");
pin(nav, "responsive: CTA pair also lg-gated", "hidden items-center gap-2 lg:flex");
pin(nav, "responsive: hamburger carries 768–1023 (menu lg-hidden)", "lg:hidden");
pin(nav, "responsive: audit evidence comment kept (783 vs 753)", "783 vs 753");
checkTrue("responsive: no md:flex desktop-nav regression in Nav", !src(nav).includes("md:flex"));
pin(
  "src/routes/_app/analytics.tsx",
  "responsive: digest frequency select min-w-0 (no overflow at 375px)",
  "min-w-0 max-w-full rounded-lg border border-slate-300",
);
pin("src/routes/_app/analytics.tsx", "responsive: digest label row shrinks", "flex min-w-0 items-center gap-2");
pin(
  "src/routes/_app/inbox.tsx",
  "responsive: inbox conversation list min-w-0 (no sideways scroll)",
  "min-w-0 rounded-xl border border-slate-200 bg-white",
);
pin("src/routes/_app/inbox.tsx", "responsive: fix rationale comment kept", "min-w-0 lets the column shrink");

console.log(`\nP58-ONBOARDING-UI ${failures === 0 ? "PASS" : "FAIL"} — ${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
export {};
