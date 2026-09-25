/**
 * Referral queries (P5-7) — server-only.
 *
 * Deliberately cross-business functions (marked below, same convention as
 * auth.ts): resolving a signup's referral code to a referrer business. Every
 * other function is business-scoped and filters by the session-resolved
 * businessId.
 *
 * Attribution records ONLY the fact of the referral (migration 022). No
 * incentive or reward data exists — the owner has not decided real terms.
 */
import { assertServer, sql } from "./shared";
import type { Referral } from "../schema";
import { generateReferralCode, normalizeReferralCode } from "../../lib/referralCode";

/** Retries for the (vanishingly rare) unique-index collision on a new code. */
const CODE_ASSIGN_ATTEMPTS = 5;

/**
 * Return the business's referral code, assigning one if it does not exist
 * yet. STABLE by design: once assigned the app never rotates it.
 *
 * Assignment is a single conditional UPDATE (…WHERE referral_code IS NULL
 * RETURNING) so two concurrent calls cannot double-assign — the second sees
 * the first's row and reads it back. A unique-index collision between two
 * simultaneous fresh assignments is retried with a fresh random code.
 */
export async function ensureReferralCode(businessId: string): Promise<string> {
  assertServer();
  const db = sql();
  for (let attempt = 0; attempt < CODE_ASSIGN_ATTEMPTS; attempt++) {
    const assigned = await db`
      UPDATE businesses SET referral_code = ${generateReferralCode()}
      WHERE id = ${businessId} AND referral_code IS NULL
      RETURNING referral_code`;
    // Rows come back camelCase (src/db.ts maps snake_case keys).
    if (assigned.length > 0) {
      const code = (assigned[0] as { referralCode?: string }).referralCode;
      if (code) return code;
    }
    const existing = await db`
      SELECT referral_code FROM businesses WHERE id = ${businessId}`;
    if (existing.length === 0) {
      throw new Error(`ensureReferralCode: business ${businessId} not found`);
    }
    const code = (existing[0] as { referralCode?: string | null }).referralCode;
    if (code != null) return code;
    // referral_code still NULL after the UPDATE saw no row — another writer
    // rolled back between our statements; loop and try again.
  }
  throw new Error("ensureReferralCode: could not assign a unique code");
}

/**
 * Cross-business BY DESIGN (like login email lookup): a signup presents a
 * code, and the code itself is the authority for which business it belongs
 * to. Returns the referrer's business id, or null for unknown codes.
 */
export async function findReferrerBusinessIdByCode(rawCode: unknown): Promise<string | null> {
  assertServer();
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;
  const db = sql();
  const rows = await db`
    SELECT id FROM businesses
    WHERE referral_code = ${code} AND disabled_at IS NULL
    LIMIT 1`;
  if (rows.length === 0) return null;
  return String((rows[0] as { id: string }).id);
}

/**
 * Record the attribution: the referred business signed up through
 * referrerCode. Idempotent (one attribution per business, UNIQUE), refuses
 * self-referral, and NEVER throws for a bad/unknown code — a broken referral
 * link must not break a signup. Returns true only when a real attribution
 * row was written.
 */
export async function applyReferralAtSignup(input: {
  referredBusinessId: string;
  referrerCode: unknown;
}): Promise<boolean> {
  assertServer();
  const code = normalizeReferralCode(input.referrerCode);
  if (!code) return false;
  const referrerId = await findReferrerBusinessIdByCode(code);
  if (!referrerId || referrerId === input.referredBusinessId) return false;
  const db = sql();
  const rows = await db`
    INSERT INTO referrals (business_id, referrer_business_id, referral_code)
    VALUES (${input.referredBusinessId}, ${referrerId}, ${code})
    ON CONFLICT (business_id) DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** The attribution row for a referred business, if it exists. */
export async function getReferralForBusiness(businessId: string): Promise<Referral | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM referrals WHERE business_id = ${businessId} LIMIT 1`;
  return rows.length > 0 ? (rows[0] as unknown as Referral) : null;
}

/**
 * How many businesses signed up through this business's referral link —
 * business-scoped read by referrer_business_id (isolation convention).
 */
export async function countReferredBusinesses(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT count(*)::int AS n FROM referrals WHERE referrer_business_id = ${businessId}`;
  return Number((rows[0] as { n: number }).n);
}
