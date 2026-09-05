/**
 * Plumbing knowledge base — public surface (P3-A).
 *
 * One import point for consumers (rules text-back today, LLM bridge P3-B,
 * AI receptionist P3-E). Pure module: no runtime deps, no DB, no env, no
 * secrets. Everything is code-resident data plus typed accessors, versioned
 * by KB_VERSION.
 *
 *   SERVICES      — service catalog (slugs, aliases, urgency, value ranges,
 *                   qualifying questions, safety notes)
 *   EMERGENCIES   — emergency taxonomy with customer-safety scripts
 *   FAQ_ENTRIES   — default receptionist deflection policies
 *   resolveServiceByAlias() / resolveServiceBySlug() — catalog accessors
 *   resolveEmergency()      — highest-severity emergency for a text
 *   screenAdviceText() / screenAdviceRequest() — safe-advice guardrails
 *   buildSystemPrompt()     — deterministic guardrail policy prompt fragment
 *   getKbManifest()         — counts + version for health checks/tests
 */

import { KB_VERSION } from "./version";
import { SERVICES } from "./services";
import { EMERGENCIES } from "./emergencies";
import { FAQ_ENTRIES } from "./faq";
import type {
  KbManifest,
  KbMatch,
  ServiceKbEntry,
} from "./types";
import {
  ALLOW_RULES,
  DENY_RULES,
  buildSystemPrompt,
  normalizeKbText,
  resolveEmergency,
  screenAdviceRequest,
  screenAdviceText,
} from "./guardrails";

export {
  KB_VERSION,
  SERVICES,
  EMERGENCIES,
  FAQ_ENTRIES,
  ALLOW_RULES,
  DENY_RULES,
  resolveEmergency,
  screenAdviceText,
  screenAdviceRequest,
  buildSystemPrompt,
  normalizeKbText,
};
export type {
  ServiceKbEntry,
  EmergencyKbEntry,
  FaqEntry,
  KbMatch,
  KbManifest,
  GuardrailResult,
  AdviceDecision,
  KbUrgency,
  EmergencySeverity,
} from "./types";

// ---------------------------------------------------------------------------
// Service catalog accessors
// ---------------------------------------------------------------------------

/** Earliest index of any alias match, or MAX_SAFE_INTEGER when none match. */
function aliasIndex(entry: ServiceKbEntry, text: string): number {
  let best = Number.MAX_SAFE_INTEGER;
  for (const re of entry.aliases) {
    const m = re.exec(text);
    if (m && m.index < best) best = m.index;
  }
  return best;
}

/**
 * Resolve a service entry from free text. Scoring: most alias matches wins;
 * ties break to the earliest match position (topic-first), then to the first
 * catalog order — deterministic. Null when nothing matches.
 */
export function resolveServiceByAlias(text: string): KbMatch<ServiceKbEntry> | null {
  const t = normalizeKbText(text);
  if (t.length === 0) return null;
  let best: ServiceKbEntry | null = null;
  let bestHits = 0;
  let bestIdx = Number.MAX_SAFE_INTEGER;
  let bestOrder = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < SERVICES.length; i++) {
    const entry = SERVICES[i];
    const hits = entry.aliases.filter((re) => re.test(t)).length;
    if (hits === 0) continue;
    const idx = aliasIndex(entry, t);
    if (
      best === null ||
      hits > bestHits ||
      (hits === bestHits && idx < bestIdx) ||
      (hits === bestHits && idx === bestIdx && i < bestOrder)
    ) {
      best = entry;
      bestHits = hits;
      bestIdx = idx;
      bestOrder = i;
    }
  }
  return best ? { entry: best, kbVersion: KB_VERSION, matchedAliases: bestHits } : null;
}

/** Exact-slug lookup (canonical form). Null when unknown. */
export function resolveServiceBySlug(slug: string): ServiceKbEntry | null {
  return SERVICES.find((s) => s.slug === slug) ?? null;
}

/** All catalog entries in defined order. */
export function listServices(): readonly ServiceKbEntry[] {
  return SERVICES;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** Counts + version for health checks, logs, and tests. */
export function getKbManifest(): KbManifest {
  return {
    kbVersion: KB_VERSION,
    services: SERVICES.length,
    emergencies: EMERGENCIES.length,
    allowRules: ALLOW_RULES.length,
    denyRules: DENY_RULES.length,
    faqEntries: FAQ_ENTRIES.length,
  };
}
