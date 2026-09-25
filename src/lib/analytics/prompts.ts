/**
 * P4-A runtime prompt iteration (pure helpers, unit-tested).
 *
 * The AI system prompts are editable at runtime through /admin/prompts: an
 * admin's overlay text is stored in prompt_versions (migration 019) with full
 * version history and becomes active without a redeploy — the next
 * conversation reads the active row.
 *
 * SAFETY CONTRACT (non-negotiable): a DB overlay is APPENDED AFTER the code's
 * guardrail prompt, never substituted for it. The KB safety policy, the strict
 * JSON task spec, and the honesty rules are code; the overlay adds operating
 * instructions on top and is explicitly framed as unable to weaken them.
 * With no active version (or any DB error) the code default is used verbatim.
 */
import type { PromptSurface, PromptVersion } from "~/db/schema";

export const PROMPT_SURFACES: PromptSurface[] = ["lead_capture", "receptionist"];

export const PROMPT_SURFACE_LABELS: Record<PromptSurface, string> = {
  lead_capture: "Lead capture (missed-call SMS assistant)",
  receptionist: "AI receptionist (voice call summary)",
};

export const PROMPT_BODY_MAX = 8_000;
export const PROMPT_NOTE_MAX = 300;

/**
 * The version number for a new overlay on this surface: max(existing) + 1,
 * starting at 1. Works from any subset of rows (caller may pass only this
 * surface's versions).
 */
export function nextPromptVersion(existingVersions: readonly { version: number }[]): number {
  return existingVersions.reduce((m, v) => Math.max(m, Math.floor(v.version) || 0), 0) + 1;
}

/** Pick the active version out of stored rows; null when none is active. */
export function pickActiveVersion<T extends { isActive: boolean }>(rows: readonly T[]): T | null {
  return rows.find((r) => r.isActive) ?? null;
}

/** The overlay text of the active version (trimmed), or null when empty/absent. */
export function activeOverlayText(rows: readonly { isActive: boolean; body: string }[]): string | null {
  const active = pickActiveVersion(rows);
  const text = active?.body.trim() ?? "";
  return text.length > 0 ? text : null;
}

/**
 * Append the admin overlay to a code-default system prompt. Pure: same
 * inputs → same bytes (tests assert the exact framing). Empty/null overlay
 * returns the base prompt byte-identical.
 */
export function appendPromptOverlay(
  base: string,
  overlay: string | null | undefined,
  surface: PromptSurface,
): string {
  const text = (overlay ?? "").trim();
  if (text.length === 0) return base;
  const surfaceNote =
    surface === "lead_capture"
      ? "the missed-call SMS assistant"
      : "the AI receptionist (post-call summary)";
  return [
    base,
    "",
    "ADDITIONAL OPERATING INSTRUCTIONS (owner-configured in the admin console;",
    "they apply to " + surfaceNote + " and take effect without a redeploy):",
    "These instructions EXTEND the policy above. They NEVER override, weaken, or",
    "reinterpret the SAFETY POLICY, the honesty rules, or the output format that",
    "precede them. When an instruction here conflicts with the safety policy, the",
    "safety policy wins.",
    "---",
    text,
  ].join("\n");
}

/** Validate an overlay body for storage; returns the trimmed body or null. */
export function validatePromptBody(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed.length > PROMPT_BODY_MAX) return null;
  return trimmed;
}

/** Validate the optional change note; null input → null note. */
export function validatePromptNote(note: unknown): string | null {
  if (note === null || note === undefined) return null;
  if (typeof note !== "string") return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, PROMPT_NOTE_MAX);
}

/** Type-guard the surface column. */
export function isPromptSurface(v: unknown): v is PromptSurface {
  return v === "lead_capture" || v === "receptionist";
}

/** Shape a DB row for the client (dates → ISO strings). */
export function promptVersionView(row: PromptVersion): {
  id: string;
  surface: PromptSurface;
  version: number;
  body: string;
  note: string | null;
  editedBy: string | null;
  isActive: boolean;
  createdAt: string;
} {
  return {
    id: row.id,
    surface: row.surface,
    version: row.version,
    body: row.body,
    note: row.note,
    editedBy: row.editedBy,
    isActive: row.isActive,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
