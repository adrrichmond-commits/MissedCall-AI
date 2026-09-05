/**
 * Default FAQ / receptionist policies (P3-A defaults; P3-E wires overrides).
 *
 * Honest deflection policies: the AI never invents prices, availability, or
 * warranty terms. It deflects to the business owner's real process — quote
 * after diagnosis, scheduling within business hours, service-area check
 * against configured areas, warranty per business policy. Per-business
 * override is explicitly OUT of scope for P3-A.
 */

import type { FaqEntry } from "./types";

export const FAQ_ENTRIES: readonly FaqEntry[] = [
  {
    id: "pricing",
    topic: "Pricing / cost questions",
    defaultAnswer:
      "I can't give exact prices over the phone — pricing depends on what we find after diagnosis. What I can do is book a diagnostic visit, and you'll get a clear quote before any work begins.",
    deferNote: "Business sets pricing policy; P3-E lets owners override this copy.",
    patterns: [
      /\b(quote|estimates?|estamate|pricing|price|prices|cost|costs?|how much|ball ?park|rates?|charge|charging|fee|fees?)\b/,
      /\b(expensive|cheaper|afford)\b/,
      /\bdo (you|yall) (take|accept) (card|credit|cash|checks?|financing|payments?)\b/,
      /\bdeposit\b/,
    ],
  },
  {
    id: "scheduling",
    topic: "Scheduling / availability",
    defaultAnswer:
      "I can get you on the calendar within our business hours — I have openings I can offer. What day and time window works best for you?",
    deferNote: "Business sets hours and slot rules; P3-E offers real windows.",
    patterns: [
      /\b(when can (you|someone|a tech|a plumber)|what times? (are|do you)|are (you|yall) (available|open)|availability|schedule|schedual|book|booking|appointment|appointments?|appts?|come out|come by)\b/,
      /\b(today|tomorrow|this week|next week|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening)\b.*\b(available|open|free|slot|opening|window)\b/,
      /\bhow soon\b/,
    ],
  },
  {
    id: "service-area",
    topic: "Service area / coverage",
    defaultAnswer:
      "Let me check whether we cover your address — what's the address or nearest cross-street?",
    deferNote: "Business configures areas; the system checks configured areas.",
    patterns: [
      /\b(do (you|yall) (serve|cover|come to|service)|are (you|yall) in)\b/,
      /\b(serve|cover|service) (the )?(area|neighborhood|city|town|zip|county)\b/,
      /\b(zip|postal) code\b/,
      /\bin (my|your) area\b/,
      /\bhow (far|close) (do|does)\b/,
    ],
  },
  {
    id: "warranty",
    topic: "Warranty / guarantee",
    defaultAnswer:
      "We stand behind our work — the exact warranty depends on the job and parts, and the technician will go over the warranty terms with your quote.",
    deferNote: "Business sets warranty terms; P3-E lets owners override this copy.",
    patterns: [
      /\b(warrant(y|ies)|guarantee(d|s)?|guaranty)\b/,
      /\bstands? behind\b/,
      /\bif it (breaks|fails|leaks) again\b/,
      /\bcome back (if|and fix)\b/,
    ],
  },
];
