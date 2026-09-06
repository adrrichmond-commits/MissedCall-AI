/**
 * Call-transfer rules for the AI voice receptionist (P3-E) — PURE module.
 *
 * Where the transfer number comes from (in precedence order):
 *   1. settings.transferNumber — the business's explicit transfer target
 *      (Phase 4 receptionist studio makes this editable; accepted today so
 *      the flow is provable end-to-end).
 *   2. businesses.phone — the shop's main line, normalized.
 *   3. null — no transfer is possible; every emergency/after-hours/human
 *      path falls to the voicemail wrapup instead (honest degradation, the
 *      caller is NEVER transferred to a number we cannot verify).
 *
 * When transfer is OFFERED (the rules the brief fixes):
 *   - an EMERGENCY call: always offered (when a number exists);
 *   - an AFTER-HOURS call: offered when the business's emergency prefs say
 *     afterHoursEmergency is true;
 *   - the caller ASKS for a human: offered.
 *   Business hours otherwise: the AI qualifies and captures, then the
 *   confirm stage offers a transfer anyway (the shop may want the call).
 */

export interface TransferPrefsInput {
  /** businesses.settings jsonb blob (may carry receptionist/transfer keys). */
  settings: unknown;
  /** businesses.phone (raw string as stored). */
  businessPhone: string | null;
  /** Emergency prefs' afterHoursEmergency flag (sanitized by settingsFns). */
  afterHoursEmergency: boolean;
}

export interface TransferRules {
  /** The E.164-ish number to dial, or null when no verified target exists. */
  transferNumber: string | null;
  /** Offer a transfer to the caller (emergency / after-hours / asked). */
  offersTransfer: boolean;
}

/** Strip everything but digits and a leading +; null when undialable. */
export function normalizeTransferNumber(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const plus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 10) return null; // undialable — never guess
  if (plus || digits.length > 10) {
    // E.164 as stored, or US 11-digit with leading 1.
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (plus) return `+${digits}`;
  }
  return `+1${digits}`;
}

/**
 * Resolve the transfer rules for a business. Pure: the driver reads the
 * settings row and passes the pieces in; this module only decides.
 */
export function resolveTransferRules(
  prefs: TransferPrefsInput,
  trigger: "emergency" | "after_hours" | "human_request",
): TransferRules {
  const source =
    prefs.settings && typeof prefs.settings === "object"
      ? (prefs.settings as Record<string, unknown>)
      : {};
  const explicit =
    typeof source.transferNumber === "string" ? source.transferNumber : null;
  const transferNumber = normalizeTransferNumber(explicit) ?? normalizeTransferNumber(prefs.businessPhone);
  const offersTransfer =
    transferNumber != null &&
    (trigger === "emergency" ||
      (trigger === "after_hours" && prefs.afterHoursEmergency === true) ||
      trigger === "human_request");
  return { transferNumber, offersTransfer };
}
