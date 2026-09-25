/**
 * Shared time formatting for SMS workflow templates (P4-S). Pure — no DB, no
 * env — so the safeguard test battery covers it directly.
 *
 * Appointment times in customer texts render in the BUSINESS's timezone (the
 * shop's clock, which is what "Tuesday at 9am" means to a plumber), with a
 * UTC fallback when no timezone is on file.
 */
import { localHourInTz } from "~/lib/smsWorkflows";

export { localHourInTz };

/** "Tue, Mar 3 at 9:00 AM" in the business's timezone. Never throws. */
export function formatAppointmentTime(date: Date, timezone: string | null | undefined): string {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone || "UTC",
    });
    const formatted = fmt.format(date);
    return formatted.replace(",", "") + " local time";
  } catch {
    return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }
}

/** "$149.00" from cents. Never throws. */
export function formatCentsAsUsd(cents: number | null | undefined): string {
  const value = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return "$" + (value / 100).toFixed(2);
}
