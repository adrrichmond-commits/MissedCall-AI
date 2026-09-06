/**
 * Pure TwiML builders for the AI voice receptionist (P3-E).
 *
 * NO I/O, NO DB, NO env reads — string-in, string-out, unit-testable like
 * classifyPipeline.ts. Every function returns a complete XML document
 * starting with the Twilio-required `<?xml?>` declaration and a <Response>
 * root, so a caller can hand the string straight to a Response with
 * content-type application/xml (or compose children via `twiml`).
 *
 * Well-formedness: elements escape text and attribute values; children nest
 * through the same tiny element builder, so the output is well-formed by
 * construction — and the test suite asserts it structurally (balanced tags,
 * single root, declaration, escaping round-trip).
 *
 * Verbs used (Twilio TwiML reference):
 *   <Say>   — TTS speech (voice="Polly.Joanna" if available; default voice
 *             is fine, we never depend on a premium voice).
 *   <Gather input="speech"> — collect one caller utterance; speechTimeout
 *             keeps it snappy (auto end-of-speech), language en-US,
 *             action → our webhook with SpeechResult.
 *   <Dial>  — warm transfer to the business's transfer number.
 *   <Record — voicemail capture with a transcription + recording callback.
 *   <Pause>, <Redirect>, <Hangup>.
 */

/** Escape XML special characters for element text and attribute values. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export type TwiMLElement =
  | string
  | { tag: string; attrs?: Record<string, string>; children?: TwiMLElement[] };

/** Render one element (or text) — exported for tests. */
export function renderElement(el: TwiMLElement): string {
  if (typeof el === "string") return esc(el);
  const attrs = Object.entries(el.attrs ?? {})
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
  const children = el.children ?? [];
  if (children.length === 0) return `<${el.tag}${attrs}/>`;
  const inner = children.map(renderElement).join("");
  return `<${el.tag}${attrs}>${inner}</${el.tag}>`;
}

/** Wrap children in a Twilio <Response> XML document. */
export function twiml(...children: TwiMLElement[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${children
    .map(renderElement)
    .join("")}</Response>`;
}

/** One spoken sentence group — Twilio pauses briefly between <Say> elements. */
export function say(text: string): TwiMLElement {
  return { tag: "Say", children: [text] };
}

/** Explicit pause between speech groups (seconds). */
export function pause(seconds: number): TwiMLElement {
  return { tag: "Pause", attrs: { length: String(Math.max(0, Math.min(seconds, 30))) } };
}

export interface GatherOptions {
  /** Absolute URL the result POSTs back to (our voice webhook). */
  actionUrl: string;
  /** What to play while/after prompting. */
  prompt: string | TwiMLElement[];
  /** Max speech length in seconds (Twilio default 5 — too short for addresses). */
  maxSpeechSec?: number;
  /** Say this when no speech is detected (then submit with empty result). */
  noInputPrompt?: string;
  /** Method override for the action POST (POST is the default). */
  method?: "POST" | "GET";
}

/**
 * Collect one caller utterance via speech recognition. Twilio POSTs
 * SpeechResult (and Confidence) to actionUrl; an empty result means the
 * caller said nothing in the window.
 */
export function gather(opts: GatherOptions): TwiMLElement {
  const children: TwiMLElement[] = Array.isArray(opts.prompt)
    ? opts.prompt
    : [say(opts.prompt)];
  // speechTimeout: "auto" = end-of-speech detection; a number = hard cap on
  // speech length. One or the other — Twilio takes a single value.
  const speechTimeout = opts.maxSpeechSec ? String(Math.max(1, opts.maxSpeechSec)) : "auto";
  return {
    tag: "Gather",
    attrs: {
      input: "speech",
      action: opts.actionUrl,
      method: opts.method ?? "POST",
      language: "en-US",
      speechTimeout,
      // Empty results still POST — the flow loop decides to re-prompt,
      // so a silent caller gets nudged instead of dead air.
      actionOnEmptyResult: "true",
    },
    children,
  };
}

/**
 * Transfer the caller to the business's transfer number. The <Dial> number
 * is E.164 or raw digits passed through as-is — Twilio rejects malformed
 * numbers and the call record then carries the honest failure.
 */
export function dial(toNumber: string, opts?: { hangupOnStar?: boolean }): TwiMLElement {
  return {
    tag: "Dial",
    attrs: opts?.hangupOnStar ? { hangupOnStar: "true" } : undefined,
    children: [toNumber],
  };
}

/** Speak the KB safety script VERBATIM, one <Say> per script line. */
export function sayScript(scriptLines: readonly string[]): TwiMLElement[] {
  return scriptLines.map((line) => say(line));
}

export interface RecordOptions {
  /** Absolute URL receiving the recording/transcription result callback. */
  actionUrl: string;
  /** Play before recording starts. */
  prompt?: string;
  /** Hard cap on the recording length (seconds). */
  maxLengthSec?: number;
  /** Ask Twilio to transcribe the voicemail. */
  transcribe?: boolean;
}

/** Capture a voicemail: play the wrapup, then record with transcription. */
export function record(opts: RecordOptions): TwiMLElement {
  return {
    tag: "Record",
    attrs: {
      action: opts.actionUrl,
      method: "POST",
      maxLength: String(Math.max(10, Math.min(opts.maxLengthSec ?? 120, 600))),
      playBeep: "true",
      ...(opts.transcribe === false ? {} : { transcribe: "true", transcribeCallback: opts.actionUrl }),
    },
    children: opts.prompt ? [say(opts.prompt)] : [],
  };
}

/** Redirect control to another URL (fresh request; used for loop cap/edge). */
export function redirect(url: string): TwiMLElement {
  return { tag: "Redirect", attrs: { method: "POST" }, children: [url] };
}

/** Politely end the call. */
export function hangup(): TwiMLElement {
  return { tag: "Hangup" };
}

// ---------------------------------------------------------------------------
// Composed, product-voiced documents
// ---------------------------------------------------------------------------

/** Default receptionist greeting when the business has no configured one. */
export const DEFAULT_GREETING = (businessName: string | null): string =>
  businessName
    ? `Thank you for calling ${businessName}. This is the office assistant. How can I help you today?`
    : "Thank you for calling. This is the office assistant. How can I help you today?";

/** Greeting + first Gather — the entry TwiML for a known business. */
export function greetingDocument(businessName: string | null, actionUrl: string): string {
  return twiml(gather({ actionUrl, prompt: DEFAULT_GREETING(businessName) }));
}

/** After-hours / unhandled edge: honest, polite, then hang up. */
export function goodbyeDocument(text: string): string {
  return twiml(say(text), pause(1), hangup());
}

/**
 * Degraded-mode document: the AI could not look anything up (unknown number,
 * DB down) — apologize honestly and transfer to the given number when one
 * exists, otherwise take a voicemail. Twilio NEVER receives an error page.
 */
export function apologyDocument(text: string, transferTo: string | null, actionUrl: string): string {
  if (transferTo) {
    return twiml(say(text), pause(1), dial(transferTo));
  }
  return twiml(say(text), pause(1), record({ actionUrl, prompt: "Please leave a message after the beep." }));
}
