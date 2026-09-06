/**
 * Server-only queries: voice-call records (P3-E, migration 013).
 *
 * ISOLATION RULE: every function takes `businessId` and filters on it —
 * the WHERE clause is the isolation boundary, so no function may omit it.
 * The one deliberately cross-business helper is `getCallBySid`, which takes
 * the Twilio CallSid with no business scoping: the inbound voice webhook
 * carries no session, only the call SID (same reasoning as
 * getBusinessByPhoneKey in auth.ts). It is used exclusively by
 * src/lib/server/voiceReceptionist.ts.
 */
import type { Call, CallStatus, CallTranscript, CallTranscriptTurn } from "../schema";
import { assertServer, sql } from "./shared";

const CALL_STATUSES: readonly CallStatus[] = [
  "in_progress",
  "completed",
  "transfered",
  "voicemail",
  "no_answer",
  "failed",
];

function assertStatus(status: CallStatus): void {
  if (!CALL_STATUSES.includes(status)) throw new Error(`Unknown call status: ${String(status)}`);
}

/** Normalize a stored transcript to the document shape (defensive on read). */
export function normalizeTranscript(raw: unknown): CallTranscript {
  if (Array.isArray(raw)) return { turns: raw as CallTranscriptTurn[] };
  if (raw && typeof raw === "object") {
    const doc = raw as { turns?: unknown; flow?: Record<string, unknown> };
    return {
      turns: Array.isArray(doc.turns) ? (doc.turns as CallTranscriptTurn[]) : [],
      ...(doc.flow != null ? { flow: doc.flow } : {}),
    };
  }
  return { turns: [] };
}

/** Clean turns for writing (roles, ISO stamps). */
function cleanTurns(turns: CallTranscriptTurn[]): CallTranscriptTurn[] {
  return turns.map((t) => ({
    role: t.role === "ai" ? ("ai" as const) : ("caller" as const),
    text: typeof t.text === "string" ? t.text : "",
    at: typeof t.at === "string" ? t.at : new Date().toISOString(),
    ...(t.classification != null ? { classification: t.classification } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create the in-progress call row for a newly answered voice call — OR fetch
 * the existing one (call_sid is UNIQUE): Twilio retries webhooks, so this is
 * the idempotency gate. Returns { call, created }.
 */
export async function upsertCallBySid(args: {
  businessId: string;
  callSid: string;
  fromNumber: string | null;
  toNumber: string | null;
}): Promise<{ call: Call; created: boolean }> {
  assertServer();
  const db = sql();
  // Two-step (SELECT then INSERT) rather than a CTE so `created` is honest:
  // a Twilio retry must not re-append the greeting turn below.
  const existing = await db`SELECT * FROM calls WHERE call_sid = ${args.callSid} LIMIT 1`;
  if (existing[0]) {
    return { call: existing[0] as unknown as Call, created: false };
  }
  const rows = await db.query(
    `INSERT INTO calls (business_id, call_sid, from_number, to_number, status, transcript)
     VALUES ($1, $2, $3, $4, 'in_progress', $5::jsonb)
     ON CONFLICT (call_sid) DO NOTHING
     RETURNING *`,
    [args.businessId, args.callSid, args.fromNumber, args.toNumber, JSON.stringify({ turns: [] })],
  );
  const inserted = rows[0] as unknown as Call | undefined;
  if (inserted) return { call: inserted, created: true };
  // Lost a race with a concurrent retry — read the winner.
  const winner = await db`SELECT * FROM calls WHERE call_sid = ${args.callSid} LIMIT 1`;
  return { call: winner[0] as unknown as Call, created: false };
}

/**
 * Overwrite the transcript document (turns + flow state). The webhook handler
 * is the only writer for a given CallSid within a turn (Twilio does not send
 * the next callback until this response returns), so whole-document writes
 * are safe and keep the state machine's snapshot authoritative.
 */
export async function writeCallTranscript(args: {
  businessId: string;
  callId: string;
  transcript: CallTranscript;
}): Promise<void> {
  assertServer();
  const db = sql();
  await db.query(`UPDATE calls SET transcript = $3::jsonb WHERE business_id = $1 AND id = $2`, [
    args.businessId,
    args.callId,
    JSON.stringify({
      turns: cleanTurns(args.transcript.turns),
      ...(args.transcript.flow != null ? { flow: args.transcript.flow } : {}),
    }),
  ]);
}

export interface UpdateCallInput {
  status?: CallStatus;
  durationSec?: number | null;
  recordingUrl?: string | null;
  aiSummary?: string | null;
  leadId?: string | null;
  transferedTo?: string | null;
}

/** Patch the mutable columns of a call (status machine lives in app code). */
export async function updateCall(
  businessId: string,
  callId: string,
  input: UpdateCallInput,
): Promise<Call | null> {
  assertServer();
  if (input.status != null) assertStatus(input.status);
  const db = sql();
  const snake = (k: string): string => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const cols = Object.keys(input).filter((k) => input[k as keyof UpdateCallInput] !== undefined);
  if (cols.length === 0) return null;
  const sets = cols.map((k, i) => `${snake(k)} = $${i + 3}`).join(", ");
  const values = cols.map((k) => input[k as keyof UpdateCallInput]);
  const rows = await db.query(
    `UPDATE calls SET ${sets} WHERE business_id = $1 AND id = $2 RETURNING *`,
    [businessId, callId, ...values],
  );
  return (rows[0] as unknown as Call | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** One business's calls, newest first (dashboard/history). */
export async function listCalls(businessId: string, limit = 50): Promise<Call[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM calls WHERE business_id = ${businessId}
    ORDER BY created_at DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`;
  return rows as unknown as Call[];
}

/** One call by id, business-scoped. */
export async function getCall(businessId: string, callId: string): Promise<Call | null> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM calls WHERE business_id = ${businessId} AND id = ${callId} LIMIT 1`;
  return (rows[0] as unknown as Call | undefined) ?? null;
}

/**
 * Webhook-only lookup (deliberately cross-business — the voice webhook has
 * no session, only Twilio's CallSid). Used exclusively by
 * src/lib/server/voiceReceptionist.ts for callback-turn idempotency.
 */
export async function getCallBySid(callSid: string): Promise<Call | null> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM calls WHERE call_sid = ${callSid} LIMIT 1`;
  return (rows[0] as unknown as Call | undefined) ?? null;
}
