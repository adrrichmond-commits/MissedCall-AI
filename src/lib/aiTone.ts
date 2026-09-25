/**
 * AI tone control (P5-3) — pure, client-safe module.
 *
 * The owner picks how the AI assistant SOUNDS to customers:
 * Professional (default) / Friendly / Casual / Direct. The choice is stored
 * FLAT on the existing businesses.settings jsonb blob (`settings.aiTone`),
 * exactly like `settings.emergencyInstructions` and the receptionist config —
 * no migration, per-business isolation inherited from the businesses row.
 *
 * CONSUMPTION: textBack.ts readAiTone() pulls the tone off the settings blob
 * and passes it into the classification pipeline, which appends the matching
 * directive to the NEXT AI turn's system prompt (classifyPipeline
 * buildClassifierSystemPrompt) — the same runtime-settings handoff the
 * emergency-instructions path uses, so a tone change takes effect on the very
 * next AI turn with no redeploy.
 *
 * GUARDRAIL CONTRACT: the tone directive is STYLE ONLY. It is appended AFTER
 * the KB safety policy and explicitly subordinates itself to it — a tone can
 * never weaken the emergency scripts, the no-prices rule, or honesty
 * guardrails. `professional` (the default) adds NO directive: the base prompt
 * is already the professional voice, so unset/garbage tone = zero change.
 */

export const AI_TONES = ["professional", "friendly", "casual", "direct"] as const;

export type AiTone = (typeof AI_TONES)[number];

export const DEFAULT_AI_TONE: AiTone = "professional";

export interface AiToneOption {
  value: AiTone;
  label: string;
  /** One-line description shown under the label in the selector UI. */
  description: string;
}

/** The selector UI (settings page + receptionist studio) renders from this. */
export const AI_TONE_OPTIONS: readonly AiToneOption[] = [
  {
    value: "professional",
    label: "Professional",
    description: "Polished and courteous — the default. Clear, complete, businesslike.",
  },
  {
    value: "friendly",
    label: "Friendly",
    description: "Warm and personable. Reassuring, uses the customer's name when known.",
  },
  {
    value: "casual",
    label: "Casual",
    description: "Relaxed and conversational — contractions, everyday words, still trustworthy.",
  },
  {
    value: "direct",
    label: "Direct",
    description: "Brief and to the point. Answer first, no pleasantries, short sentences.",
  },
];

/**
 * Tolerant read: any malformed/unknown value falls back to the default. Never
 * throws — a broken settings blob can never break the AI.
 */
export function sanitizeAiTone(raw: unknown): AiTone {
  if (typeof raw !== "string") return DEFAULT_AI_TONE;
  const normalized = raw.trim().toLowerCase();
  return (AI_TONES as readonly string[]).includes(normalized)
    ? (normalized as AiTone)
    : DEFAULT_AI_TONE;
}

/**
 * Like sanitizeAiTone, but null when the setting is absent or not a valid
 * string — the server-side settings→AI reader distinguishes "unset" (null)
 * from an explicit professional choice. The pipeline treats null exactly like
 * professional (no directive), but tests can assert the read itself.
 */
export function readAiToneValue(raw: unknown): AiTone | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  return (AI_TONES as readonly string[]).includes(normalized) ? (normalized as AiTone) : null;
}

/**
 * The exact system-prompt fragment for a tone, or null for professional
 * (no directive — the base prompt IS the professional voice).
 *
 * Every directive: states the owner chose it, keeps it style-only, and
 * explicitly subordinates it to the safety policy that precedes it.
 */
export function tonePromptDirective(tone: AiTone): string | null {
  switch (tone) {
    case "friendly":
      return [
        "TONE (owner setting: Friendly) — style only, never a reason to skip the SAFETY POLICY above:",
        "Be warm and personable. Reassure the customer, use their name when you have it, and keep the",
        "language plain and human. Warmth never replaces accuracy, required details, or the safety rules.",
      ].join(" ");
    case "casual":
      return [
        "TONE (owner setting: Casual) — style only, never a reason to skip the SAFETY POLICY above:",
        "Write relaxed and conversational — contractions and everyday words are fine, like a helpful",
        "neighbor texting. Stay clear and trustworthy; casualness never drops required details or the safety rules.",
      ].join(" ");
    case "direct":
      return [
        "TONE (owner setting: Direct) — style only, never a reason to skip the SAFETY POLICY above:",
        "Be brief and to the point: lead with the answer or the next step, skip pleasantries and filler,",
        "and keep sentences short. Brevity never omits safety steps, required details, or honesty.",
      ].join(" ");
    case "professional":
      return null;
  }
}
