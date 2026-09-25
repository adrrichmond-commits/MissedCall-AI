/**
 * P5-7 acquisition suite — ROI calculator math, referral attribution at
 * signup, contact/demo honesty, and the public-page no-fabrication rules.
 *
 * Sections:
 *   1. PURE calculator math (src/lib/roiCalculator.ts): defaults, exact
 *      arithmetic, sanitizing (garbage → 0, never NaN/negative), clamps,
 *      plan prices resolved ONLY from src/lib/pricing.ts, the P5-2 ROI
 *      definition (recovered ÷ cost, 1dp), and the estimate-flag contract.
 *   2. PURE referral-code module: deterministic generation, normalization,
 *      shareable-link building.
 *   3. STATIC honesty pins (filesystem): the marketing surfaces render the
 *      calculator/contact/demo blocks, never hard-code prices, and carry no
 *      fabricated social proof (testimonials/logos/fake phone numbers).
 *   4. DB attribution (self-cleaning, baseline-delta): stable per-business
 *      codes, applyReferralAtSignup happy path + idempotency + self/unknown/
 *      malformed/disabled-referrer refusals, referrer counts, and cleanup.
 *      (signupFn calls applyReferralAtSignup after createBusinessWithOwner —
 *      the same function is exercised here directly so no HTTP harness is
 *      needed; the signup path itself is covered by the e2e journey.)
 *
 * Run: bun scripts/test-p57-acquisition.ts   (exit 0 = every check passed)
 */
import { installLocalPostgresShim } from "./local-pg-shim";
import { query } from "./db";
import { createBusinessWithOwner } from "../src/db/queries/auth";
import { hashPassword } from "../src/lib/server/password";
import { getPlan } from "../src/lib/pricing";
import {
  computeRoiCalculator,
  formatCentsAsDollars,
  ROI_CALCULATOR_ASSUMPTIONS,
  ROI_CALCULATOR_DEFAULTS,
} from "../src/lib/roiCalculator";
import {
  generateReferralCode,
  normalizeReferralCode,
  referralLink,
  REFERRAL_CODE_RE,
} from "../src/lib/referralCode";
import { applyReferralAtSignup, countReferredBusinesses, ensureReferralCode, getReferralForBusiness } from "../src/db/queries/referrals";
import { readFileSync } from "node:fs";
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
function checkEq(name: string, got: unknown, want: unknown): void {
  checkTrue(name, got === want, "got " + String(got) + ", want " + String(want));
}

// ---------------------------------------------------------------------------
// 1. Pure calculator math — conservative, pricing-config-driven, honest
// ---------------------------------------------------------------------------

// Shared-constant contract: plan prices come from pricing.ts (the exact
// import the P5-2 ROI engine uses) — never literals.
const starterPrice = getPlan("starter")!.priceCents;
const proPrice = getPlan("pro")!.priceCents;

// Defaults: 6 missed calls/week, $350 average job (illustrative, KB-derived).
const def = computeRoiCalculator({
  missedCallsPerWeek: ROI_CALCULATOR_DEFAULTS.missedCallsPerWeek,
  averageJobValueCents: ROI_CALCULATOR_DEFAULTS.averageJobValueCents,
});
const monthlyCalls = 6 * ROI_CALCULATOR_ASSUMPTIONS.weeksPerMonth; // 26.0
const leads = monthlyCalls * 0.3 * 0.7; // 5.46
const jobs = leads * 0.3; // 1.638
const revenueFloorDollars = Math.floor((jobs * 35000) / 100) * 100; // conservative: floor to whole $
checkEq(
  "calc: monthly missed calls = weekly × 52/12",
  def.monthlyMissedCalls,
  Math.round(monthlyCalls * 10) / 10,
);
checkEq("calc: estimated leads/month", def.estimatedLeadsPerMonth, Math.round(leads * 10) / 10);
checkEq("calc: estimated jobs/month", def.estimatedJobsPerMonth, Math.round(jobs * 10) / 10);
checkEq("calc: revenue floors to whole dollars (conservative)", def.estimatedRevenueCents, revenueFloorDollars);
checkTrue("calc: revenue is a non-negative integer", Number.isInteger(def.estimatedRevenueCents) && def.estimatedRevenueCents >= 0);
checkEq("calc: plan prices resolved from pricing.ts (starter)", def.plans[0].priceCents, starterPrice);
checkEq("calc: plan prices resolved from pricing.ts (pro)", def.plans[1].priceCents, proPrice);
checkEq(
  "calc: ROI multiple uses the P5-2 definition (recovered ÷ cost, 1dp)",
  def.plans[0].roiMultiple,
  Math.round((revenueFloorDollars / starterPrice) * 10) / 10,
);
checkEq(
  "calc: pro ROI multiple",
  def.plans[1].roiMultiple,
  Math.round((revenueFloorDollars / proPrice) * 10) / 10,
);
checkEq("calc: net = revenue − price (starter)", def.plans[0].netCents, revenueFloorDollars - starterPrice);
// Negative net is real (tiny inputs can't clear the plan price) — never clamped to a fake win.
const small = computeRoiCalculator({ missedCallsPerWeek: 1, averageJobValueCents: 1000 });
const expSmallJobs = 1 * ROI_CALCULATOR_ASSUMPTIONS.weeksPerMonth * 0.3 * 0.7 * 0.3;
const expSmallRevenue = Math.floor((expSmallJobs * 1000) / 100) * 100;
checkEq("calc: negative net shows the honest shortfall", small.plans[0].netCents, expSmallRevenue - starterPrice);
checkTrue("calc: tiny inputs → negative net (estimates don't flatter)", small.plans[0].netCents < 0);

// Estimate contract (mirrors the P5-2 estimateFlags that the UI must chip).
checkTrue(
  "calc: every derived figure flagged as an estimate",
  def.estimateFlags.revenue && def.estimateFlags.jobs && def.estimateFlags.leads,
);

// Sanitizers: garbage in → zeros out, never NaN/Infinity/negative/throw.
// (Same Number() coercion semantics as the P5-2 engine's sanitizers — e.g.
// a single-element array coerces to its element; real inputs are numbers.)
const garbage = [
  undefined,
  null,
  "not-a-number",
  -5,
  -0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  {},
].map((v) => computeRoiCalculator({ missedCallsPerWeek: v as number, averageJobValueCents: v as number }));
checkTrue(
  "calc: garbage inputs all sanitize to $0 recovered",
  garbage.every((g) => g.estimatedRevenueCents === 0 && g.estimatedJobsPerMonth === 0),
);
checkTrue(
  "calc: garbage inputs never produce NaN/Infinity anywhere",
  garbage.every((g) => !JSON.stringify(g).includes("NaN") && !JSON.stringify(g).includes("Infinity")),
);

// Clamps: absurd inputs cap at the documented bounds instead of lying.
const atMaxCalls = computeRoiCalculator({ missedCallsPerWeek: 99999, averageJobValueCents: 35000 });
const atFiveHundred = computeRoiCalculator({ missedCallsPerWeek: 500, averageJobValueCents: 35000 });
checkEq("calc: weekly calls clamp at 500", atMaxCalls.estimatedRevenueCents, atFiveHundred.estimatedRevenueCents);
const hugeValue = computeRoiCalculator({ missedCallsPerWeek: 1, averageJobValueCents: 999_999_999_999 });
const atMaxValue = computeRoiCalculator({ missedCallsPerWeek: 1, averageJobValueCents: 100_000_000 });
checkEq("calc: job value clamps at $1,000,000", hugeValue.estimatedRevenueCents, atMaxValue.estimatedRevenueCents);
checkEq("calc: zero input → honest $0 estimate (not hidden)", computeRoiCalculator({ missedCallsPerWeek: 0, averageJobValueCents: 35000 }).estimatedRevenueCents, 0);

// Dollar formatting (negatives are real: show them).
checkEq("fmt: $0", formatCentsAsDollars(0), "$0");
checkEq("fmt: $57,330", formatCentsAsDollars(5733000), "$57,330");
checkEq("fmt: negative net shows as -$100", formatCentsAsDollars(-10000), "-$100");

// ---------------------------------------------------------------------------
// 2. Referral-code module — pure
// ---------------------------------------------------------------------------
const deterministicBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
const code0 = generateReferralCode((len) => deterministicBytes.slice(0, len));
checkEq("code: deterministic generation maps bytes → alphabet", code0[0], "A"); // byte 0 → index 0
checkEq("code: length is fixed", generateReferralCode((len) => new Uint8Array(len).fill(30)).length, 8);
checkTrue(
  "code: 100 random codes all match the unambiguous alphabet",
  Array.from({ length: 100 }, () => generateReferralCode()).every((c) => REFERRAL_CODE_RE.test(c) && c.length === 8),
);
checkEq("code: normalize trims + uppercases", normalizeReferralCode("  ab2x9k8m "), "AB2X9K8M");
checkEq("code: malformed → null (treated as no referral)", normalizeReferralCode("AB-CD!"), null);
checkEq("code: empty → null", normalizeReferralCode("   "), null);
checkEq("code: non-string → null", normalizeReferralCode(42), null);
checkEq("code: too short → null", normalizeReferralCode("AB1"), null);
checkEq("code: too long → null", normalizeReferralCode("A".repeat(17)), null);
checkEq("link: builds origin + /signup?ref=", referralLink("ABC23456", "https://missedcall.example.com"), "https://missedcall.example.com/signup?ref=ABC23456");
checkEq("link: strips a trailing slash", referralLink("ABC23456", "https://x.io/"), "https://x.io/signup?ref=ABC23456");

// ---------------------------------------------------------------------------
// 3. Static honesty pins — the public pages, read as text
// ---------------------------------------------------------------------------
const read = (p: string) => readFileSync(p, "utf8");
const landing = read("src/routes/index.tsx");
const calc = read("src/components/marketing/RoiCalculator.tsx");
const contact = read("src/routes/contact.tsx");
const demo = read("src/routes/demo.tsx");
const contactLib = read("src/lib/contact.ts");

checkTrue("landing: renders the ROI calculator section", landing.includes("<RoiCalculator />"));
checkTrue("landing: pricing still renders from PLANS (config module)", landing.includes("PLANS.map"));
checkTrue("landing: no fabricated social proof", !/testimonial|Trusted by|logo cloud/i.test(landing));
checkTrue("landing: footer links the contact page", landing.includes('"/contact"'));
checkTrue("calc: prices imported from the pricing config", calc.includes('from "~/lib/pricing"'));
checkTrue(
  "calc: no price literals in the component",
  !calc.includes("14900") && !calc.includes("24900") && !/\b149\b/.test(calc) && !/\b249\b/.test(calc),
);
checkTrue("calc: estimate chip present on derived figures", calc.includes("Estimate"));
checkTrue("calc: CTA points at signup", calc.includes('"/signup"'));
checkTrue("calc: defaults labeled as examples, not market data", /illustrative|Example default|planning estimate/i.test(calc));
checkTrue("contact: uses the real support inbox constant", contact.includes("SUPPORT_EMAIL") && contactLib.includes("missedcall-ai-ab7414dd@ctomail.io"));
checkTrue("contact: links the legal pages", contact.includes('"/privacy"') && contact.includes('"/terms"') && contact.includes('"/sms-consent"'));
checkTrue("contact: no fabricated phone/address/team", !/tel:|1-800|office hours|meet the team/i.test(contact));
checkTrue("contact: response expectation is a plain commitment, no invented SLA stat", !/\b\d+%\b/.test(contact) && contact.includes("business day"));
checkTrue("demo: states the sample-data story plainly", demo.includes("What you") && demo.includes("fictional") && demo.includes("demo workspace"));
checkTrue("demo: keeps DEMO labeling on the hero", demo.includes("Demo — everything on this page is example content"));
checkTrue("demo: still routes sample-data exploration through the demo login", demo.includes("/login?demo=1"));

// ---------------------------------------------------------------------------
// 4. DB — stable codes + attribution at signup (self-cleaning)
// ---------------------------------------------------------------------------
const pw = await hashPassword("p57-test-password");
await query(`DELETE FROM businesses WHERE name LIKE 'P57 %'`);

async function seed(name: string): Promise<{ id: string; name: string }> {
  const { business } = await createBusinessWithOwner({
    businessName: name,
    ownerEmail: `owner-${Date.now()}-${Math.floor(Math.random() * 1e6)}@p57.test`,
    ownerFullName: "P57 Owner",
    passwordHash: pw,
  });
  return { id: business.id, name: business.name };
}

const biz: { id: string; name: string }[] = [];
try {
  const A = await seed("P57 A Referrer");
  const B = await seed("P57 B Referred");
  const C = await seed("P57 C Unrelated");
  biz.push(A, B, C);

  // Stable codes: assigned once, never rotated by reads.
  const codeA1 = await ensureReferralCode(A.id);
  const codeA2 = await ensureReferralCode(A.id);
  checkEq("db: code is stable across reads", codeA2, codeA1);
  checkTrue("db: code matches the unambiguous alphabet", REFERRAL_CODE_RE.test(codeA1));
  const codeB = await ensureReferralCode(B.id);
  checkTrue("db: codes are unique per business", codeA1 !== codeB);

  // Attribution at signup (the exact call signupFn makes after creating the
  // account): B signed up through A's link.
  checkEq("db: attribution applied", await applyReferralAtSignup({ referredBusinessId: B.id, referrerCode: codeA1 }), true);
  const row = await getReferralForBusiness(B.id);
  checkTrue("db: attribution row exists", row != null);
  checkEq("db: row points at the referrer", row?.referrerBusinessId, A.id);
  checkEq("db: row keeps the presented code", row?.referralCode, codeA1);
  checkEq("db: referred count for A", await countReferredBusinesses(A.id), 1);

  // Idempotent: a business signs up once.
  checkEq("db: re-attribution is refused (unique per business)", await applyReferralAtSignup({ referredBusinessId: B.id, referrerCode: codeA1 }), false);

  // Refusals: self, unknown, malformed — none throw, none write.
  checkEq("db: self-referral refused", await applyReferralAtSignup({ referredBusinessId: A.id, referrerCode: codeA1 }), false);
  checkEq("db: unknown code refused", await applyReferralAtSignup({ referredBusinessId: C.id, referrerCode: "ZZZZ9999" }), false);
  checkEq("db: malformed code refused", await applyReferralAtSignup({ referredBusinessId: C.id, referrerCode: "nope!" }), false);
  checkEq("db: C has no attribution row", await getReferralForBusiness(C.id), null);

  // A disabled referrer's code stops working (the lookup filters disabled_at).
  await query(`UPDATE businesses SET disabled_at = now() WHERE id = $1`, [A.id]);
  const D = await seed("P57 D After Disable");
  biz.push(D);
  checkEq("db: disabled referrer's code refused", await applyReferralAtSignup({ referredBusinessId: D.id, referrerCode: codeA1 }), false);
  await query(`UPDATE businesses SET disabled_at = NULL WHERE id = $1`, [A.id]);

  // ensureReferralCode on a missing business fails loudly (not silently).
  let threw = false;
  try {
    await ensureReferralCode("00000000-0000-0000-0000-000000000000");
  } catch {
    threw = true;
  }
  checkTrue("db: missing business → loud error", threw);

  // New signups get a code immediately (signupFn ensures it) — every seeded
  // business above got one via ensure; verify the count never leaks NaN.
  checkTrue("db: counts are plain integers", Number.isInteger(await countReferredBusinesses(A.id)));
} finally {
  for (const b of biz) {
    await query(`DELETE FROM businesses WHERE id=$1`, [b.id]);
  }
  const left = await query(`SELECT count(*)::int AS n FROM businesses WHERE name LIKE 'P57 %'`);
  checkEq("cleanup: all P5-7 test businesses removed", left[0] && (left[0] as { n: number }).n, 0);
  const orphanRefs = await query(
    `SELECT count(*)::int AS n FROM referrals r LEFT JOIN businesses b ON b.id = r.business_id WHERE b.id IS NULL`,
  );
  checkEq("cleanup: no orphaned referral rows", orphanRefs[0] && (orphanRefs[0] as { n: number }).n, 0);
}

console.log(`\np57-acquisition: ${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
