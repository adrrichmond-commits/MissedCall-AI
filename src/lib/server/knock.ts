/**
 * Knock notification transport (P4 — "wire Knock as the email/notification
 * transport").
 *
 * Knock is a notification-delivery service: we trigger a WORKFLOW by key over
 * its REST API, and the workflow (defined in the Knock dashboard) renders and
 * delivers the email. No SDK dependency — bare fetch with Bearer auth,
 * mirroring how email.ts talks to the Resend-style API and sms.ts talks to
 * Twilio.
 *
 * Reads configuration from the environment ONCE per call (never cached at
 * module scope so test runs and dev servers pick changes up):
 *
 *   KNOCK_API_KEY       secret API key (Bearer) — REQUIRED for this transport
 *   KNOCK_WORKFLOW_KEY  optional workflow key; default "missedcall-notify"
 *   KNOCK_API_BASE      optional; default https://api.knock.app
 *
 * The trigger payload carries an inline recipient (so per-business owner
 * emails work without pre-creating Knock users) and the rendered content in
 * `data` ({subject, body, html?}). The dashboard workflow's email template
 * references those as Knock liquid variables ({{ notification.data.subject }}
 * etc. — see docs/operations/environments.md for the owner's setup steps).
 *
 * KNOCK_SIGNING_KEY: present in the environment but deliberately NOT consumed
 * yet. It signs Knock's webhook callbacks (delivery/bounce events). When
 * inbound Knock webhooks are wired (future), verify signatures with it before
 * trusting any payload — same discipline as the Twilio webhook signature
 * check in src/routes/api/webhooks/twilio.ts.
 *
 * HONESTY RULE: if KNOCK_API_KEY is missing, isKnockConfigured() is false and
 * triggerKnockEmail() throws KnockNotConfiguredError. A Knock rejection
 * (non-2xx — e.g. 404 workflow_not_found when the owner has not published the
 * workflow yet) throws KnockSendError carrying Knock's own code. Nothing here
 * pretends a message was delivered.
 */
import "@tanstack/react-start/server-only";

const DEFAULT_KNOCK_API_BASE = "https://api.knock.app";
const DEFAULT_KNOCK_WORKFLOW_KEY = "missedcall-notify";

export interface KnockConfig {
  apiKey: string;
  workflowKey: string;
  apiBase: string;
}

/** Read + validate Knock env config. Returns null when the key is missing. */
export function readKnockConfig(): KnockConfig | null {
  const apiKey = process.env.KNOCK_API_KEY;
  if (!apiKey || apiKey.length === 0) return null;
  const workflowKey = (process.env.KNOCK_WORKFLOW_KEY ?? "").trim() || DEFAULT_KNOCK_WORKFLOW_KEY;
  const apiBase = (process.env.KNOCK_API_BASE ?? "").trim().replace(/\/+$/, "") || DEFAULT_KNOCK_API_BASE;
  return { apiKey, workflowKey, apiBase };
}

/** True only when the Knock credential is present. */
export function isKnockConfigured(): boolean {
  return readKnockConfig() !== null;
}

/** Typed error so callers can distinguish "not wired" from "provider failed". */
export class KnockNotConfiguredError extends Error {
  constructor() {
    super("Knock is not configured: set KNOCK_API_KEY.");
    this.name = "KnockNotConfiguredError";
  }
}

export class KnockSendError extends Error {
  constructor(
    message: string,
    /** Knock error code when the API returned one (e.g. "workflow_not_found"). */
    readonly providerCode: string | null,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "KnockSendError";
  }
}

export interface KnockTriggerArgs {
  /** Recipient email address (sent as an inline Knock recipient). */
  to: string;
  subject: string;
  /** Plain-text body. Always sent; the workflow template's primary content. */
  body: string;
  /** Optional HTML alternative for the workflow template to include. */
  html?: string;
}

export interface KnockTriggerResult {
  /** Workflow run id Knock assigned when it accepted the trigger. */
  id: string;
  workflowKey: string;
  to: string;
}

interface KnockTriggerResponse {
  id?: string;
  workflow_run_id?: string;
  message?: string;
  code?: string;
  name?: string;
}

/**
 * Trigger the notification workflow for one email via POST
 * {KNOCK_API_BASE}/v1/workflows/{workflowKey}/trigger. Throws
 * KnockNotConfiguredError when credentials are absent; KnockSendError when
 * Knock rejects the trigger (4xx/5xx, malformed response, network error).
 */
export async function triggerKnockEmail(args: KnockTriggerArgs): Promise<KnockTriggerResult> {
  const config = readKnockConfig();
  if (!config) throw new KnockNotConfiguredError();
  const url = config.apiBase + "/v1/workflows/" + encodeURIComponent(config.workflowKey) + "/trigger";
  const body: Record<string, unknown> = {
    recipients: [{ email: args.to }],
    data: {
      subject: args.subject,
      body: args.body,
      ...(args.html !== undefined ? { html: args.html } : {}),
    },
  };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (cause) {
    throw new KnockSendError("Network error contacting Knock: " + String(cause), null, 0);
  }
  const payload = (await response.json().catch(() => ({}))) as KnockTriggerResponse;
  if (!response.ok) {
    const code = payload.code ?? payload.name ?? null;
    throw new KnockSendError(
      "Knock rejected the trigger" +
        (code ? " (" + code + ")" : "") +
        ": " +
        (payload.message ?? payload.name ?? response.statusText),
      code,
      response.status,
    );
  }
  const runId = payload.workflow_run_id ?? payload.id;
  if (!runId) {
    throw new KnockSendError("Knock response missing workflow run id", null, response.status);
  }
  return { id: runId, workflowKey: config.workflowKey, to: args.to };
}
