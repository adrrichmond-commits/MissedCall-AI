/**
 * P4-A prompt override service — the runtime-editable AI system prompts.
 *
 * getPromptOverride(surface) reads the active prompt_versions row (migration
 * 019) with a short in-process cache; applyPromptOverlay() appends it to the
 * code-default system prompt via the pure appendPromptOverlay helper.
 *
 * Failure contract: any DB error → null overlay → the code default is used
 * verbatim. Prompt iteration must never be able to break a conversation
 * (that includes a broken migration, a revoked table, or a typo'd version).
 */
import type { PromptSurface } from "~/db/schema";
import * as q from "~/db/queries/prompts";
import { appendPromptOverlay } from "~/lib/analytics/prompts";

const CACHE_TTL_MS = 30_000;

const cache = new Map<PromptSurface, { body: string | null; at: number }>();

export function clearPromptOverrideCache(surface?: PromptSurface): void {
  if (surface) cache.delete(surface);
  else cache.clear();
}

/**
 * The active overlay body for a surface, or null when none is active (or the
 * DB read fails). Cached briefly — prompt changes take effect within the TTL
 * (30s) even under load, and immediately for the next cache-miss.
 */
export async function getPromptOverride(surface: PromptSurface): Promise<string | null> {
  const hit = cache.get(surface);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.body;
  let body: string | null = null;
  try {
    body = await q.getActivePromptBody(surface);
  } catch (err) {
    // Honest fallback: no overlay, default prompt, conversation unaffected.
    console.log("[prompts] override read failed (code default in use): " + String(err));
    body = null;
  }
  cache.set(surface, { body, at: Date.now() });
  return body;
}

/**
 * Compose the effective system prompt: the code default (guardrails FIRST)
 * plus the admin overlay, if one is active. Used by the SMS classification
 * pipeline ('lead_capture') and the voice receptionist summary
 * ('receptionist') at the START of each conversation turn — no redeploy.
 */
export async function applyPromptOverlay(
  base: string,
  surface: PromptSurface,
): Promise<string> {
  const overlay = await getPromptOverride(surface);
  return appendPromptOverlay(base, overlay, surface);
}
