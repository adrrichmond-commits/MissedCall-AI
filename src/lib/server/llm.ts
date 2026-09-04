/**
 * LLM service (Phase 2 build #4 pre-wire) — OpenAI-compatible chat API over
 * plain fetch, no SDK dependency. Configuration from the environment:
 *
 *   LLM_API_KEY    required for any call to succeed
 *   LLM_BASE_URL   optional, default https://api.openai.com/v1
 *   LLM_MODEL      optional, default a cheap fast model (gpt-4o-mini)
 *
 * HONESTY RULE: without LLM_API_KEY, isLlmConfigured() is false and
 * llmComplete() throws LlmNotConfiguredError. Downstream features (AI
 * classification, receptionist) must degrade to an explicit "unclassified"
 * state — never to an invented answer.
 */
import "@tanstack/react-start/server-only";

const DEFAULT_LLM_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_LLM_MODEL = "gpt-4o-mini";

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export function readLlmConfig(): LlmConfig | null {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey || apiKey.length === 0) return null;
  const baseUrl = (process.env.LLM_BASE_URL ?? "").trim() || DEFAULT_LLM_BASE_URL;
  const model = (process.env.LLM_MODEL ?? "").trim() || DEFAULT_LLM_MODEL;
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, ""), model };
}

export function isLlmConfigured(): boolean {
  return readLlmConfig() !== null;
}

export function logLlmStatus(): void {
  if (isLlmConfigured()) {
    const cfg = readLlmConfig();
    console.log("[llm] configured - model " + (cfg ? cfg.model : "?") + " via " + (cfg ? cfg.baseUrl : "?"));
  } else {
    console.log("[llm] not configured (LLM_API_KEY missing) - AI classification disabled, inbound messages stored as unclassified");
  }
}

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("LLM is not configured: set LLM_API_KEY (optionally LLM_BASE_URL, LLM_MODEL).");
    this.name = "LlmNotConfiguredError";
  }
}

export class LlmError extends Error {
  constructor(message: string, readonly httpStatus: number) {
    super(message);
    this.name = "LlmError";
  }
}

export interface LlmOptions {
  /** Per-call override; defaults to config model. */
  model?: string;
  temperature?: number;
  /** Max response tokens (cheap, bounded defaults for classification). */
  maxTokens?: number;
  /** Abort timeout in ms (default 20s). */
  timeoutMs?: number;
}

interface ChatResponseShape {
  choices?: { message?: { content?: string | null } }[];
  error?: { message?: string };
}

/**
 * One chat completion: system + user message -> assistant text. Bounded by an
 * AbortController timeout; network/HTTP failures become LlmError. Never
 * retries internally — callers decide retry policy.
 */
export async function llmComplete(system: string, user: string, opts?: LlmOptions): Promise<string> {
  const config = readLlmConfig();
  if (!config) throw new LlmNotConfiguredError();
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(config.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: opts?.model ?? config.model,
        temperature: opts?.temperature ?? 0,
        max_tokens: opts?.maxTokens ?? 300,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as ChatResponseShape;
    if (!response.ok) {
      throw new LlmError(
        "LLM API error " + response.status + ": " + (payload.error?.message ?? response.statusText),
        response.status,
      );
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new LlmError("LLM response missing content", response.status);
    }
    return content;
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new LlmError("LLM request timed out after " + timeoutMs + "ms", 0);
    }
    throw new LlmError("LLM network error: " + String(err), 0);
  } finally {
    clearTimeout(timer);
  }
}
