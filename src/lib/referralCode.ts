/**
 * P5-7 referral foundation — code shape + shareable link, PURE module (no I/O).
 *
 * The DATABASE side lives in src/db/queries/referrals.ts (server-only); the
 * signup-time attribution happens inside authFns.signupFn. This module holds
 * only the pure, testable parts:
 *   - the referral-code alphabet/length and generator (injectable randomness
 *     so tests can pin it);
 *   - normalization/validation of a code as typed or pasted from a link;
 *   - the shareable-link builder (/signup?ref=<code>).
 *
 * HONESTY: a referral is recorded as a fact (who signed up through whose
 * link) — nothing else. No rewards, discounts, or incentives exist yet; no
 * UI may promise one until the owner decides real terms.
 */

/** Unambiguous alphabet — no I/L/O/1/0, so codes survive being read aloud. */
export const REFERRAL_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789" as const;

/** Code length. 8 chars over a 31-symbol alphabet ≈ 8.5e11 possibilities. */
export const REFERRAL_CODE_LENGTH = 8;

/**
 * Generate a referral code. `random` defaults to crypto.getRandomValues;
 * tests pass a deterministic source.
 */
export function generateReferralCode(
  random: (len: number) => Uint8Array = defaultRandom,
): string {
  const bytes = random(REFERRAL_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    out += REFERRAL_ALPHABET[bytes[i] % REFERRAL_ALPHABET.length];
  }
  return out;
}

function defaultRandom(len: number): Uint8Array {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** A code is uppercase/digit, 4–16 chars, after trimming. */
export const REFERRAL_CODE_RE = /^[A-Z0-9]{4,16}$/;

/**
 * Normalize a referral code as presented at signup (trim + uppercase) and
 * validate its shape. Returns null for anything that is not plausibly a code
 * (empty, malformed, absurd length) — the caller treats null as "no referral".
 */
export function normalizeReferralCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (!REFERRAL_CODE_RE.test(code)) return null;
  return code;
}

/** The shareable referral link for a code, on the given origin. */
export function referralLink(code: string, origin: string): string {
  return `${origin.replace(/\/+$/, "")}/signup?ref=${encodeURIComponent(code)}`;
}
