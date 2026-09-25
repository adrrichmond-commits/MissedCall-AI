/**
 * Server-only queries: P4-A runtime-editable AI prompt versions (migration 019).
 *
 * One row per version per surface; exactly one active row per surface
 * (partial unique index). Writing a new version deactivates the previous one
 * in the same transaction; "revert" flips the active pointer to an existing
 * version (no rows are ever deleted — full history survives).
 *
 * These are PLATFORM-level settings (not business-scoped): the admin console
 * tunes the shared AI system prompts. `editedBy` records the admin email.
 * The code-default prompts remain the fallback whenever no row is active —
 * and on ANY error reading this table (getActivePromptBody returns null), so
 * a broken migration can never break a conversation.
 */
import type { PromptSurface, PromptVersion } from "../schema";
import { assertServer, sql } from "./shared";

/** All versions for a surface, newest first. */
export async function listPromptVersions(surface: PromptSurface): Promise<PromptVersion[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM prompt_versions
    WHERE surface = ${surface}
    ORDER BY version DESC`;
  return rows as unknown as PromptVersion[];
}

/** The currently active version for a surface, or null when none. */
export async function getActivePromptVersion(surface: PromptSurface): Promise<PromptVersion | null> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM prompt_versions
    WHERE surface = ${surface} AND is_active = true
    LIMIT 1`;
  return (rows[0] as unknown as PromptVersion | undefined) ?? null;
}

/** The active overlay body only (what gets appended to the code prompt). */
export async function getActivePromptBody(surface: PromptSurface): Promise<string | null> {
  const active = await getActivePromptVersion(surface);
  const body = active?.body.trim() ?? "";
  return body.length > 0 ? body : null;
}

/**
 * Save a new overlay version and make it active. Assigns version = max+1,
 * deactivates the previous active row in the same transaction.
 */
export async function insertPromptVersion(
  surface: PromptSurface,
  body: string,
  opts: { note?: string | null; editedBy?: string | null } = {},
): Promise<PromptVersion> {
  assertServer();
  const db = sql();
  const next = await db.query(
    `WITH next AS (
       SELECT COALESCE(MAX(version), 0) + 1 AS v FROM prompt_versions WHERE surface = $1
     ), upd AS (
       UPDATE prompt_versions SET is_active = false
       WHERE surface = $1 AND is_active = true
       RETURNING 1
     )
     INSERT INTO prompt_versions (surface, version, body, note, edited_by, is_active)
     SELECT $1, next.v, $2, $3, $4, true FROM next
     RETURNING *`,
    [surface, body, opts.note ?? null, opts.editedBy ?? null],
  );
  return next[0] as unknown as PromptVersion;
}

/**
 * Revert to a prior version by flipping the active pointer (the version's
 * row is untouched — history is preserved and re-reverting is possible).
 * Returns the now-active row, or null when the version does not exist.
 */
export async function activatePromptVersion(surface: PromptSurface, version: number): Promise<PromptVersion | null> {
  assertServer();
  const db = sql();
  // Single statement: only deactivate the current active row when the target
  // version exists — a typo'd version can never leave the surface with no
  // active overlay.
  const rows = await db.query(
    `WITH target AS (
       SELECT id FROM prompt_versions WHERE surface = $1 AND version = $2
     ), upd AS (
       UPDATE prompt_versions SET is_active = false
       WHERE surface = $1 AND is_active = true
         AND id NOT IN (SELECT id FROM target)
       RETURNING 1
     )
     SELECT * FROM prompt_versions WHERE surface = $1 AND version = $2`,
    [surface, version],
  );
  return (rows[0] as unknown as PromptVersion | undefined) ?? null;
}
