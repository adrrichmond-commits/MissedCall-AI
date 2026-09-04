/**
 * The ONE place SMS template copy lives (Phase 2 build #4 pre-wire).
 *
 * Every outbound customer-facing text is rendered from these templates so
 * review/compliance (A2P 10DLC sample messages) always matches what ships.
 * Templates are pure data + pure render functions — client-safe.
 *
 * Compliance posture baked into the copy:
 *   - brand identification in every message ({businessName}),
 *   - STOP instructions on the first (text-back) message,
 *   - HELP reply states what we send and how to opt out,
 *   - STOP confirmation confirms opt-out; START resubscribes.
 * Never send anything not rendered from here.
 */

export interface SmsTemplates {
  /** First text after a missed call (the "text-back"). */
  textBack: string;
  /** Reply to HELP / INFO. */
  help: string;
  /** Reply confirming STOP (opt-out) took effect. */
  stopConfirm: string;
  /** Reply confirming the caller re-subscribed via START/UNSTOP. */
  startConfirm: string;
}

export const SMS_TEMPLATES: SmsTemplates = {
  textBack:
    "Hi! This is {businessName} — we missed your call. Text back what you need and we'll take care of you. Reply STOP to opt out.",
  help:
    "{businessName}: we text about your service requests and quotes. Reply STOP to opt out. Msg+data rates may apply.",
  stopConfirm:
    "You're opted out of texts from {businessName} and won't hear from us again. Reply START to resubscribe.",
  startConfirm: "You're resubscribed to texts from {businessName}. Reply STOP to opt out anytime.",
};

/** Render a template, substituting {businessName}. Never throws. */
export function renderSmsTemplate(template: string, businessName: string): string {
  const name = (businessName || "us").trim() || "us";
  return template.split("{businessName}").join(name);
}
