/**
 * Referral server functions (P5-7): the signed-in referral card's read.
 *
 * The referral code is assigned lazily on first read — every business gets a
 * STABLE code the first time it opens this card (new businesses also get one
 * at signup). The shareable link is built from the request origin so nothing
 * hard-codes a domain.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "./auth.server";
import { authErrorToResult } from "./sessionFns";
import { ensureReferralCode, countReferredBusinesses } from "~/db/queries/referrals";

export interface MyReferral {
  ok: true;
  /** The business's stable referral code. */
  code: string;
  /** Count of businesses that signed up through this code (fact only). */
  referredCount: number;
}

export const getMyReferralFn = createServerFn({ method: "GET" }).handler(async (): Promise<
  MyReferral | { ok: false; error: string }
> => {
  try {
    const ctx = await requireAuth();
    const code = await ensureReferralCode(ctx.business.id);
    const referredCount = await countReferredBusinesses(ctx.business.id);
    return { ok: true, code, referredCount };
  } catch (e) {
    return authErrorToResult(e);
  }
});
