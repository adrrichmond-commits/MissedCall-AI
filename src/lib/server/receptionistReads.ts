/**
 * Receptionist studio — PLAIN (non-RPC) server read, the SSR-executed loader
 * body (mirrors sessionReads.ts / adminReads.ts, PR #26/#27 postmortem): a
 * createServerFn call inside a route loader compiles to an SSR RPC stub — an
 * HTTP self-call through the hosting proxy that intermittently fails. Route
 * loaders must call PLAIN server functions during SSR; the RPC wrappers in
 * receptionistFns.ts stay for BROWSER-initiated calls.
 *
 * Import-protection: server-only. The route imports this module only inside
 * `if (import.meta.env.SSR)` branches, dead-code-eliminated from the client
 * build (verify: grep dist/client for receptionistReads = 0).
 *
 * ISOLATION: the receptionist config lives INSIDE the business's own
 * businesses.settings jsonb row (nested `receptionist` key), so per-business
 * isolation is inherited from the businesses row — the businessId always
 * comes from the authenticated session, never from client input.
 */
import { getSessionFromRequest } from "~/lib/server/auth.server";
import { isLlmConfigured } from "~/lib/server/llm";
import { isSmsConfigured } from "~/lib/server/sms";
import { receptionistConfigFromSettings, type ReceptionistConfig } from "~/lib/voice/receptionistConfig";
import { readAiToneValue } from "~/lib/aiTone";

export interface ReceptionistStudioView {
  role: "owner" | "manager" | "employee";
  canEdit: boolean;
  businessName: string;
  businessPhone: string | null;
  /** The saved studio config (tolerant read — defaults when never saved). */
  config: ReceptionistConfig;
  /** ISO timestamp of the last studio save, null when never saved. */
  savedAt: string | null;
  /**
   * P5-3: the owner's AI tone for the TEXTING assistant (settings.aiTone,
   * sanitized). Editable here so both AI surfaces are one save away; the
   * voice flow's spoken lines are scripted, so tone steers the SMS assistant.
   */
  aiTone: "professional" | "friendly" | "casual" | "direct";
  /** True once the owner saved an AI tone at least once (aiToneSavedAt). */
  aiToneSaved: boolean;
  /**
   * Honest provider status: the Twilio messaging env vars are present. Real
   * customer messaging is STILL gated on A2P campaign approval — the studio
   * says exactly that, never "live calling is available".
   */
  smsProviderConfigured: boolean;
  /** P4 audit: the LLM env is present (the preview's language tier is really live). */
  llmConfigured: boolean;
}

/** Resolve the studio view for the signed-in session (null when signed out). */
export async function receptionistStudioView(): Promise<ReceptionistStudioView | null> {
  const ctx = await getSessionFromRequest();
  if (!ctx) return null;
  const b = ctx.business as typeof ctx.business & { settings?: unknown; phone?: string | null };
  const settings = (b.settings && typeof b.settings === "object" ? b.settings : {}) as Record<string, unknown>;
  const savedAt = typeof settings.receptionistSavedAt === "string" ? settings.receptionistSavedAt : null;
  return {
    role: ctx.role,
    canEdit: ctx.role === "owner" || ctx.role === "manager",
    businessName: b.name,
    businessPhone: b.phone ?? null,
    config: receptionistConfigFromSettings(b.settings),
    savedAt,
    aiTone: readAiToneValue(settings.aiTone) ?? "professional",
    aiToneSaved: typeof settings.aiToneSavedAt === "string",
    smsProviderConfigured: isSmsConfigured(),
    llmConfigured: isLlmConfigured(),
  };
}
