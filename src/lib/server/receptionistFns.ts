/**
 * Receptionist studio server functions (P4-O part 2).
 *
 * Patterns follow settingsFns.ts: every handler resolves businessId from the
 * authenticated session (never client input), writes go through
 * requireActiveWrite("owner","manager"), client input is validated by the
 * PURE module (validateReceptionistInput — the same rules the tests cover),
 * and failures return typed results instead of throwing.
 *
 * STORAGE: the config is a nested `receptionist` object on the business's OWN
 * businesses.settings jsonb row (same blob as notification/emergency prefs),
 * so per-business isolation is inherited from that row — there is no second
 * table to scope and no new query path (isolation suite unchanged).
 *
 * SIMULATION (test-call preview): runs ONE turn of the SAME pure flow engine
 * (stepCallFlow) with the SAME LLM seam (voiceLlmAsync) as a live call, over
 * the DRAFT config the plumber is editing. It performs ZERO writes — no lead,
 * no notification, no meter, no SMS, no call — and the client-supplied flow
 * state is re-coerced through coerceFlowState so a crafted payload can never
 * push the simulation into an impossible stage.
 */
import { createServerFn } from "@tanstack/react-start";
import type { MessageClassification } from "~/db/schema";
import { requireActiveWrite, requireAuth } from "~/lib/server/auth.server";
import { authErrorToResult } from "~/lib/server/sessionFns";
import { receptionistStudioView, type ReceptionistStudioView } from "~/lib/server/receptionistReads";
import {
  confirmPromptOverride,
  coerceFlowState,
  sanitizeReceptionistConfig,
  validateReceptionistInput,
  type ReceptionistConfig,
} from "~/lib/voice/receptionistConfig";
import { resolveTransferRules } from "~/lib/voice/transferRules";
import {
  aiLinesForAction,
  voiceLlmAsync,
} from "~/lib/server/voiceReceptionist";
import {
  initialFlowState,
  stepCallFlow,
  type CallFlowAction,
  type CallFlowState,
} from "~/lib/voice/callFlow";
import * as q from "~/db/queries";

export type ReceptionistResult<T> = { ok: true; data: T } | { ok: false; status: 400 | 401 | 403 | 404; error: string };

// ---------------------------------------------------------------------------
// Read (browser-initiated refreshes; the SSR loader path is receptionistReads)
// ---------------------------------------------------------------------------
export const getReceptionistConfigFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<ReceptionistResult<ReceptionistStudioView>> => {
    try {
      await requireAuth();
      const view = await receptionistStudioView();
      if (!view) return { ok: false, status: 401, error: "Not signed in." };
      return { ok: true, data: view };
    } catch (e) {
      return authErrorToResult(e);
    }
  },
);

// ---------------------------------------------------------------------------
// Save (owner/manager) — strict validation, merge into the business's settings
// ---------------------------------------------------------------------------
export const saveReceptionistConfigFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as Record<string, unknown>)
  .handler(async ({ data }): Promise<ReceptionistResult<{ message: string; config: ReceptionistConfig }>> => {
    try {
      const ctx = await requireActiveWrite("owner", "manager");
      const businessId = ctx.business.id;
      const validated = validateReceptionistInput(data);
      if (!validated.ok) {
        return {
          ok: false,
          status: 400,
          error: validated.issues.map((i) => i.message).join(" "),
        };
      }
      const current = await q.getBusiness(businessId);
      if (!current) return { ok: false, status: 404, error: "Business not found." };
      const settings = {
        ...((current as unknown as { settings?: Record<string, unknown> }).settings ?? {}),
        receptionist: validated.value,
        receptionistSavedAt: new Date().toISOString(),
      };
      await q.updateBusinessSettings(businessId, settings);
      return { ok: true, data: { message: "Receptionist saved.", config: validated.value } };
    } catch (e) {
      return authErrorToResult(e);
    }
  });

// ---------------------------------------------------------------------------
// Simulate one test-call turn (any signed-in role; ZERO side effects)
// ---------------------------------------------------------------------------
export interface SimulateTurnInput {
  /** The DRAFT config being previewed (tolerant-sanitized server-side). */
  config: unknown;
  /** The opaque round-trip flow state (re-coerced server-side). */
  state: unknown;
  /** What the "caller" just said ("" = silence). */
  utterance: string;
}

export interface SimulateTurnResult {
  /** The AI lines the live path would speak, in order. */
  lines: string[];
  /** The flow stage the live path would be in after this turn. */
  stage: CallFlowState["stage"];
  actionKind: CallFlowAction["kind"];
  /** True when the live path would create a lead right here. */
  leadWouldCapture: boolean;
  /** When the live path would dial: the resolved transfer target. */
  transferTarget: string | null;
  /** True when the emergency safety script is being spoken this turn. */
  emergency: boolean;
  /** The state to pass back for the next turn (see SimState). */
  state: SimState;
}

/**
 * Serializable simulation state: ONLY the fields the flow engine needs to
 * resume, stripped of the non-serializable KB/classification objects the
 * engine's real state carries (EmergencyKbEntry holds RegExp patterns — it
 * must never cross the RPC wire). The client treats this as opaque; the
 * server re-coerces it through coerceFlowState on EVERY turn, so a crafted
 * payload can never push the simulation into an impossible stage.
 */
export interface SimState {
  stage: CallFlowState["stage"];
  exchanges: number;
  silences: number;
  serviceNeed: string | null;
  urgency: MessageClassification["urgency"];
  callbackNumber: string | null;
  askedForHuman: boolean;
  emergencyScriptSpoken: boolean;
}

function simStateOf(s: CallFlowState): SimState {
  return {
    stage: s.stage,
    exchanges: s.exchanges,
    silences: s.silences,
    serviceNeed: s.serviceNeed,
    urgency: s.urgency,
    callbackNumber: s.callbackNumber,
    askedForHuman: s.askedForHuman,
    emergencyScriptSpoken: s.emergencyScriptSpoken,
  };
}

export const simulateReceptionistTurnFn = createServerFn({ method: "POST" })
  .validator((d: unknown) => d as Partial<SimulateTurnInput>)
  .handler(async ({ data }): Promise<ReceptionistResult<SimulateTurnResult>> => {
    try {
      const ctx = await requireAuth();
      const businessId = ctx.business.id;
      const draft = sanitizeReceptionistConfig(data.config);
      const state = coerceFlowState(data.state);
      const utterance = typeof data.utterance === "string" ? data.utterance.slice(0, 2000) : "";

      const business = await q.getBusiness(businessId);
      if (!business) return { ok: false, status: 404, error: "Business not found." };
      const bizSettings = (business as unknown as { settings?: Record<string, unknown> }).settings ?? {};
      const afterHoursEmergency =
        typeof bizSettings.afterHoursEmergency === "boolean" ? bizSettings.afterHoursEmergency : true;
      const hours = await q.listBusinessHours(businessId).catch(() => []);

      // The SAME context shape the live webhook driver builds (voiceReceptionist
      // step 8b), with the FAQ pairs / confirm override coming from the DRAFT.
      const { action, state: next } = await stepCallFlow(state, utterance, {
        businessName: business.name || null,
        now: new Date(),
        timezone: (business as unknown as { timezone?: string | null }).timezone ?? null,
        hours: hours.map((h) => ({
          dayOfWeek: h.dayOfWeek,
          isOpen: h.isOpen,
          opensAt: h.opensAt,
          closesAt: h.closesAt,
        })),
        llm: await voiceLlmAsync(),
        afterHoursEmergency,
        ...(draft.faqs.length > 0 ? { faqs: draft.faqs.map((f) => ({ question: f.question, answer: f.answer })) } : {}),
        ...(confirmPromptOverride(draft) ? { confirmPrompt: confirmPromptOverride(draft) as string } : {}),
      });

      const leadWouldCapture = action.kind === "speak_then_gather" && action.stage === "confirm";
      let transferTarget: string | null = null;
      if (action.kind === "transfer") {
        // Where the live path would dial — resolved through the SAME rules,
        // with the draft's transfer number taking studio precedence.
        const rules = resolveTransferRules(
          {
            settings: { ...bizSettings, receptionist: { transferNumber: draft.transferNumber } },
            businessPhone: (business as unknown as { phone?: string | null }).phone ?? null,
            afterHoursEmergency,
          },
          next.emergency ? "emergency" : "human_request",
        );
        transferTarget = rules.transferNumber;
      }

      return {
        ok: true,
        data: {
          lines: aiLinesForAction(action),
          stage: action.stage,
          actionKind: action.kind,
          leadWouldCapture,
          transferTarget,
          emergency: action.kind === "emergency",
          state: simStateOf(next),
        },
      };
    } catch (e) {
      return authErrorToResult(e);
    }
  });

/** Fresh simulation state for the client (kept here so the stages stay in sync). */
export const initialSimulationStateFn = createServerFn({ method: "GET" }).handler(
  (): { state: SimState } => ({ state: simStateOf(initialFlowState()) }),
);
