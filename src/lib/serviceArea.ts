/**
 * Service-area matching (Phase 2 owner brief section 9): decide where a
 * caller's address sits relative to the business's service areas.
 *
 * Pure + client-safe: no imports, no I/O — used by the lead capture path
 * (createLead) to stamp leads.service_area_status, and safe to reuse by the
 * AI receptionist build to answer "do you service my area?".
 *
 * Matching rules (deliberately simple and documented):
 *   - ZIP: the LAST 5-digit run in the address (US addresses put the ZIP
 *     last; this avoids mistaking a 5-digit house number for a ZIP).
 *     ZIP+4 is normalized to its 5-digit base. A ZIP that exactly equals a
 *     'zip' service area is in-area; a ZIP that matches nothing is
 *     authoritative out-of-area (a ZIP is structured, so we trust it).
 *   - City: a 'city' service area value appearing as a whole word in the
 *     address (case-insensitive) is in-area.
 *   - Anything undecidable (no address, or no ZIP and no city match) is
 *     'unknown' — never guessed, never silently dropped: the lead is still
 *     captured either way.
 */

export type ServiceAreaStatus = "in_area" | "out_of_area" | "unknown";

export interface ServiceAreaRef {
  kind: "zip" | "city";
  value: string;
  state?: string | null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Last 5-digit run in the string, ZIP+4-safe: "…78702-1234" → "78702". */
export function extractZip(text: string | null | undefined): string | null {
  if (!text) return null;
  const matches = [...text.matchAll(/\b\d{5}(?:-\d{4})?\b/g)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]![0]!;
  return last.slice(0, 5);
}

export function classifyServiceArea(
  address: string | null | undefined,
  areas: readonly ServiceAreaRef[],
): ServiceAreaStatus {
  const text = (address ?? "").trim();
  if (text.length === 0 || areas.length === 0) return "unknown";
  const zip = extractZip(text);
  if (zip) {
    const zipMatch = areas.some((a) => a.kind === "zip" && a.value.trim() === zip);
    if (zipMatch) return "in_area";
  }
  const cityMatch = areas.some((a) => {
    if (a.kind !== "city") return false;
    const city = a.value.trim();
    if (city.length === 0) return false;
    return new RegExp(`\\b${escapeRegExp(city)}\\b`, "i").test(text);
  });
  if (cityMatch) return "in_area";
  // A parseable ZIP that matched nothing is authoritative out-of-area.
  // Without a ZIP we cannot be certain (e.g. "1109 Chalmers Ave, Houston, TX"
  // never names a served city) — that stays 'unknown' rather than guessed.
  return zip ? "out_of_area" : "unknown";
}
