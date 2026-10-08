#!/usr/bin/env bun
/**
 * provision-customer.ts — put a customer business on the phone system.
 *
 * Purpose: make per-customer phone setup consistent and sub-15-minutes.
 * Two clearly separated modes:
 *
 *   1. assign-shared  --business <businessId-or-email>
 *        Point the business account at the existing shared number
 *        +1 (385) 336-5359. This is the ONLY mode that can run against live
 *        Twilio today: the sole-prop campaign CE9Z2EM legally carries exactly
 *        this ONE number (messaging-service membership IS the number↔campaign
 *        association; TrustHub ChannelEndpointAssignment is a dead end on
 *        this account — see /home/team/shared/twilio-golive.md).
 *
 *   2. provision-dedicated --business <id> --campaign <CAMPAIGN_SID> --service <MESSAGING_SERVICE_SID>
 *        Buy a NEW local number (voice+SMS), add it to the given messaging
 *        service, wire the webhooks, then set businesses.phone. Requires the
 *        campaign to ALREADY be VERIFIED — this script NEVER creates or
 *        modifies campaigns. Until a second campaign exists, this mode is
 *        expected to run only with --dry-run.
 *
 * Guarantees:
 *   - every mode supports --dry-run (prints the planned API calls, changes
 *     nothing — no Twilio calls that mutate, no DB writes);
 *   - idempotent (re-running on a configured business is a no-op with a clear
 *     message; refusing to overwrite an existing mapping without cleanup);
 *   - never prints secrets or auth tokens (auth is built per-request from env
 *     and never rendered; account SIDs are masked in output);
 *   - reuses the repo's Twilio conventions: plain-fetch REST with Basic auth
 *     (src/lib/server/sms.ts), last-10-digit phone key matching
 *     (getBusinessByPhoneKey convention), webhook URLs as documented in
 *     twilio-golive.md.
 *
 * Usage:
 *   bun scripts/provision-customer.ts assign-shared --business <id-or-email> [--dry-run]
 *   bun scripts/provision-customer.ts provision-dedicated --business <id> \
 *       --campaign <CAMPAIGN_SID> --service <MESSAGING_SERVICE_SID> [--number <E164>] [--dry-run]
 *
 * Environment:
 *   TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN   required for live (non-dry-run) calls
 *   TWILIO_WEBHOOK_BASE_URL                  webhook base (falls back to the
 *                                            documented dev base from twilio-golive.md)
 *   DATABASE_URL                             business lookup + phone update
 */
import { normalizePhone, phoneKey } from "../src/lib/smsCommands";

// ---------------------------------------------------------------------------
// Constants (documented facts from /home/team/shared/twilio-golive.md — none
// of these are secrets; the shared number is printed on the public site)
// ---------------------------------------------------------------------------
export const SHARED_NUMBER = "+13853365359";
export const SHARED_PHONE_KEY = phoneKey(SHARED_NUMBER) ?? "";
export const SHARED_NUMBER_DISPLAY = "+1 (385) 336-5359";
/** Sole-prop campaign verified 2026-09-28 — carries exactly ONE number. */
export const SHARED_CAMPAIGN_SID = "CE9Z2EM";
export const SHARED_MESSAGING_SERVICE_SID = "MGa447d7120e415dfbb452c420e7e145dc";
/**
 * Webhook base. TWILIO_WEBHOOK_BASE_URL is the source of truth; the fallback
 * is the documented dev base (twilio-golive.md 9/28 update: webhooks point at
 * the dev env because the live env cold-starts and Twilio does not retry long).
 */
export const DEFAULT_WEBHOOK_BASE_URL = "https://7bf6fa5539975ae9640bed6e1baecb7a-dev.ctonew.app";
const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const TWILIO_MSG_BASE = "https://messaging.twilio.com/v1";
const ACCOUNT_PLACEHOLDER = "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested by scripts/test-infra.ts) — no I/O anywhere here
// ---------------------------------------------------------------------------
export interface ParsedArgs {
  mode: "assign-shared" | "provision-dedicated";
  business: string | null;
  campaign: string | null;
  service: string | null;
  /** Optional: configure an already-owned number instead of buying a new one. */
  number: string | null;
  dryRun: boolean;
}

const USAGE = `Usage:
  bun scripts/provision-customer.ts assign-shared --business <businessId-or-email> [--dry-run]
  bun scripts/provision-customer.ts provision-dedicated --business <businessId> \\
      --campaign <CAMPAIGN_SID> --service <MESSAGING_SERVICE_SID> [--number <E164>] [--dry-run]`;

export type ParseResult = { ok: true; args: ParsedArgs } | { ok: false; error: string };

export function parseArgs(argv: string[]): ParseResult {
  const [mode, ...rest] = argv;
  if (!mode || mode === "--help" || mode === "-h") {
    return { ok: false, error: mode ? "No mode given." : USAGE };
  }
  if (mode !== "assign-shared" && mode !== "provision-dedicated") {
    return { ok: false, error: `Unknown mode "${mode}". Modes: assign-shared | provision-dedicated.\n` + USAGE };
  }
  const args: ParsedArgs = { mode, business: null, campaign: null, service: null, number: null, dryRun: false };
  const flagValue = (flag: string): string | null => {
    const eq = flag.indexOf("=");
    return eq >= 0 ? flag.slice(eq + 1) : null;
  };
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (raw === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    const eqVal = flagValue(raw);
    const flag = eqVal !== null ? raw.slice(0, raw.indexOf("=")) : raw;
    const value = eqVal !== null ? eqVal : (rest[i + 1] ?? null);
    if (eqVal === null && value !== null) i++; // consumed the next token
    if (value === null || value.startsWith("--")) {
      return { ok: false, error: `Flag ${flag} needs a value.\n` + USAGE };
    }
    switch (flag) {
      case "--business":
        args.business = value.trim();
        break;
      case "--campaign":
        args.campaign = value.trim();
        break;
      case "--service":
        args.service = value.trim();
        break;
      case "--number":
        args.number = value.trim();
        break;
      default:
        return { ok: false, error: `Unknown flag "${flag}" for mode ${mode}.\n` + USAGE };
    }
  }
  if (!args.business) {
    return { ok: false, error: `--business <businessId-or-email> is required.\n` + USAGE };
  }
  if (mode === "provision-dedicated") {
    if (!args.campaign) return { ok: false, error: `provision-dedicated requires --campaign <CAMPAIGN_SID> (the script never creates campaigns).\n` + USAGE };
    if (!args.service) return { ok: false, error: `provision-dedicated requires --service <MESSAGING_SERVICE_SID>.\n` + USAGE };
    if (!/^CE[0-9A-Za-z]{3,32}$/.test(args.campaign)) {
      return { ok: false, error: `--campaign must be a Twilio campaign SID (CE...) like ${SHARED_CAMPAIGN_SID}; got "${args.campaign}".` };
    }
    if (!/^MG[0-9a-fA-F]{32}$/.test(args.service)) {
      return { ok: false, error: `--service must be a Twilio messaging service SID (MG + 32 hex), e.g. ${SHARED_MESSAGING_SERVICE_SID}.` };
    }
  }
  if (mode === "assign-shared" && (args.campaign || args.service || args.number)) {
    return { ok: false, error: `assign-shared takes only --business (+ --dry-run). It maps the business to the existing shared number ${SHARED_NUMBER_DISPLAY}; campaign/service/number flags belong to provision-dedicated.` };
  }
  return { ok: true, args };
}

/** Route --business by shape: email → owner-email lookup; uuid → direct id. */
export type BusinessRef = { kind: "email"; email: string } | { kind: "id"; id: string } | { kind: "invalid"; raw: string };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function classifyBusinessRef(ref: string): BusinessRef {
  const trimmed = ref.trim();
  if (trimmed.includes("@")) return { kind: "email", email: trimmed.toLowerCase() };
  if (UUID_RE.test(trimmed)) return { kind: "id", id: trimmed.toLowerCase() };
  return { kind: "invalid", raw: trimmed };
}

export function webhookBaseUrl(): string {
  const fromEnv = process.env.TWILIO_WEBHOOK_BASE_URL;
  return (fromEnv && fromEnv.trim()) || DEFAULT_WEBHOOK_BASE_URL;
}

export function buildWebhookUrls(base: string): { sms: string; voice: string } {
  const b = base.replace(/\/+$/, "");
  return { sms: `${b}/api/webhooks/twilio`, voice: `${b}/api/webhooks/twilio/voice` };
}

/** One planned (or taken) action — rendered for humans, safe to paste. */
export interface PlanStep {
  label: string;
  kind: "twilio" | "db" | "note";
  method?: string;
  url?: string;
  params?: Record<string, string>;
}

/** Render a plan. Never includes credentials — params only, no auth headers. */
export function renderPlan(steps: PlanStep[]): string {
  const out: string[] = [];
  for (const s of steps) {
    if (s.kind === "note") {
      out.push("  • " + s.label);
      continue;
    }
    const head = s.kind === "db" ? "[DB]   " : `[${s.method ?? "GET"}] `;
    let line = "  " + head + (s.label || s.url || "");
    if (s.params && Object.keys(s.params).length > 0) {
      line += "\n         " + Object.entries(s.params).map(([k, v]) => `${k}=${v}`).join("  ");
    }
    out.push(line);
  }
  return out.join("\n");
}

const HARD_WARNING =
  "HARD GATE: the A2P campaign must ALREADY be VERIFIED before this mode runs live.\n" +
  "  This script NEVER creates, modifies, or re-submits campaigns. A sole-prop\n" +
  "  campaign carries exactly ONE number; a new number must belong to a campaign\n" +
  "  whose messaging service it is added to here.";

export function buildAssignSharedPlan(webhookBase: string): PlanStep[] {
  const urls = buildWebhookUrls(webhookBase);
  return [
    { kind: "twilio", method: "GET", label: `${TWILIO_API_BASE}/Accounts/${ACCOUNT_PLACEHOLDER}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(SHARED_NUMBER)} — confirm the shared number is on this account (read-only)` },
    { kind: "db", label: `UPDATE businesses SET phone = '${SHARED_NUMBER}' WHERE id = <businessId> RETURNING id, name, phone` },
    { kind: "note", label: `Inbound mapping is data-driven: webhooks already point at ${urls.sms} (+ /voice), and the webhook resolves the business by last-10 digits of businesses.phone (getBusinessByPhoneKey). No Twilio change is needed for this mode.` },
  ];
}

export function buildProvisionDedicatedPlan(webhookBase: string, service: string, opts?: { number?: string | null }): PlanStep[] {
  const urls = buildWebhookUrls(webhookBase);
  const steps: PlanStep[] = [
    { kind: "twilio", method: "GET", label: `${TWILIO_MSG_BASE}/Services/${service}/Compliance/Usa2p — read campaign status; ABORT unless VERIFIED (never auto-create)` },
  ];
  if (opts?.number) {
    steps.push({ kind: "twilio", method: "GET", label: `${TWILIO_API_BASE}/Accounts/${ACCOUNT_PLACEHOLDER}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(opts.number)} — verify already owned, reuse its SID` });
  } else {
    steps.push(
      { kind: "twilio", method: "GET", label: `${TWILIO_API_BASE}/Accounts/${ACCOUNT_PLACEHOLDER}/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true — search, pick first result` },
      { kind: "twilio", method: "POST", label: `${TWILIO_API_BASE}/Accounts/${ACCOUNT_PLACEHOLDER}/IncomingPhoneNumbers.json — buy the number`, params: { PhoneNumber: "<chosen E.164>", SmsUrl: urls.sms, SmsMethod: "POST", VoiceUrl: urls.voice, VoiceMethod: "POST", StatusCallback: urls.voice } },
    );
  }
  steps.push(
    { kind: "twilio", method: "GET", label: `${TWILIO_MSG_BASE}/Services/${service}/PhoneNumbers — check existing membership (idempotent)` },
    { kind: "twilio", method: "POST", label: `${TWILIO_MSG_BASE}/Services/${service}/PhoneNumbers — add the number to the messaging service (this IS the number↔campaign association for sole-prop)`, params: { PhoneNumberSid: "<number SID>" } },
    { kind: "twilio", method: "POST", label: `${TWILIO_API_BASE}/Accounts/${ACCOUNT_PLACEHOLDER}/IncomingPhoneNumbers/<PN>.json — set/confirm webhooks on the number`, params: { SmsUrl: urls.sms, SmsMethod: "POST", VoiceUrl: urls.voice, VoiceMethod: "POST", StatusCallback: urls.voice } },
    { kind: "db", label: `UPDATE businesses SET phone = '<E.164 number>' WHERE id = <businessId> RETURNING id, name, phone` },
    { kind: "note", label: HARD_WARNING.replace(/\n/g, " ") },
  );
  return steps;
}

export function verifyChecklist(numberDisplay: string): string[] {
  return [
    `VERIFY (owner, ~3 minutes) — do not skip; this is the proof the line works:`,
    `  1. From a personal phone, text ${numberDisplay} like a customer would (e.g. "My water heater is leaking").`,
    `  2. Expect an AI conversation reply within ~1 minute (service need → urgency → contact details).`,
    `  3. Expect a new lead to appear on the dashboard (source missed_call).`,
    `  4. Expect the owner alert: a new-lead notification (and an emergency takeover prompt if classified as an emergency).`,
  ];
}

function maskAccountSid(sid: string): string {
  return sid.length > 8 ? sid.slice(0, 2) + "…" + sid.slice(-4) : "AC…";
}

// ---------------------------------------------------------------------------
// Twilio REST helpers — plain fetch + Basic auth, same pattern as
// src/lib/server/sms.ts. Credentials are read from env at call time and are
// NEVER logged, rendered, or included in any PlanStep.
// ---------------------------------------------------------------------------
function readTwilioCreds(): { accountSid: string; authToken: string } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set in this shell — live mode cannot run. Use --dry-run for a plan, or export the credentials.");
  }
  return { accountSid, authToken };
}

async function twilioRequest(method: "GET" | "POST", url: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
  const { accountSid, authToken } = readTwilioCreds();
  const auth = Buffer.from(accountSid + ":" + authToken).toString("base64");
  const init: RequestInit = { method, headers: { Authorization: "Basic " + auth } };
  if (method === "POST" && params) {
    init.headers = { ...init.headers, "Content-Type": "application/x-www-form-urlencoded" };
    init.body = new URLSearchParams(params).toString();
  }
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = payload.code ?? payload.status_code ?? response.status;
    throw new Error(`Twilio ${response.status} (code ${code}) on ${method} ${maskUrl(url)}: ${String(payload.message ?? response.statusText)}`);
  }
  return payload;
}

/** Strip the account SID out of URLs before printing (identifiers, not secrets — but nothing to gain from echoing them). */
function maskUrl(url: string): string {
  const m = url.match(/Accounts\/(AC[0-9A-Za-z]+)\/?/);
  return m ? url.replace(m[1], maskAccountSid(m[1])) : url;
}

function planToPrinted(steps: PlanStep[]): void {
  console.log(renderPlan(steps));
}

// ---------------------------------------------------------------------------
// DB helpers — loaded lazily so unit tests can import this module without the
// DB chain. Same engine as every other script (scripts/db.ts → src/db.ts).
// ---------------------------------------------------------------------------
interface BusinessRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

async function resolveBusiness(ref: string): Promise<BusinessRow | null> {
  const { getSql } = await import("./db");
  const sqlFn = await getSql();
  const parsed = classifyBusinessRef(ref);
  if (parsed.kind === "invalid") {
    throw new Error(`--business must be a business id (uuid) or an owner/manager/business email; got "${ref}"`);
  }
  if (parsed.kind === "email") {
    // Same resolution rule as the Stripe webhook's findBusinessIdByEmail:
    // the business email, or any owner/manager user's email, claims the account.
    const { findBusinessIdByEmail } = await import("../src/db/queries/stripe");
    const id = await findBusinessIdByEmail(parsed.email);
    if (!id) return null;
    const rows = await sqlFn`SELECT id, name, email, phone FROM businesses WHERE id = ${id} LIMIT 1`;
    return (rows[0] as unknown as BusinessRow) ?? null;
  }
  const rows = await sqlFn`SELECT id, name, email, phone FROM businesses WHERE id = ${parsed.id} LIMIT 1`;
  return (rows[0] as unknown as BusinessRow) ?? null;
}

async function setBusinessPhone(businessId: string, phone: string): Promise<void> {
  const { getSql } = await import("./db");
  const sqlFn = await getSql();
  await sqlFn`UPDATE businesses SET phone = ${phone} WHERE id = ${businessId}`;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------
function printHeader(args: ParsedArgs, business: BusinessRow | null): void {
  console.log(`mode:          ${args.mode}`);
  console.log(`dry-run:       ${args.dryRun ? "YES — nothing will be changed" : "no — live changes"}`);
  if (business) {
    console.log(`business:      ${business.name ?? "(unnamed)"} (${business.id})${business.email ? " <" + business.email + ">" : ""}`);
    console.log(`current phone: ${business.phone ? business.phone : "(not set)"}`);
  } else if (args.business) {
    console.log(`business:      could not resolve "${args.business}" (read-only lookup failed or not found)`);
  }
  console.log("");
}

/** Shared idempotency/refusal checks. Returns an outcome message, or null to continue. */
function assignSharedGate(business: BusinessRow): { stop: boolean; message: string } {
  const currentKey = phoneKey(business.phone ?? "");
  if (currentKey === SHARED_PHONE_KEY) {
    return { stop: true, message: `Already configured: this business is already mapped to the shared number ${SHARED_NUMBER_DISPLAY} (businesses.phone = ${business.phone}). Nothing to do — re-running is a no-op.` };
  }
  if (business.phone && business.phone.trim() !== "") {
    return {
      stop: true,
      message:
        `REFUSING to overwrite: businesses.phone is currently '${business.phone}' (a different number).\n` +
        `Overwriting could orphan an existing number↔business mapping. To re-map deliberately:\n` +
        `  1. confirm the old number is no longer needed, then clear it:\n` +
        `       UPDATE businesses SET phone = NULL WHERE id = '${business.id}';\n` +
        `  2. re-run this command.`,
    };
  }
  return { stop: false, message: "" };
}

async function runAssignShared(args: ParsedArgs): Promise<number> {
  const webhookBase = webhookBaseUrl();
  const numberDisplay = SHARED_NUMBER_DISPLAY;
  const business = await resolveBusiness(args.business ?? "").catch((err: unknown) => {
    if (args.dryRun) {
      console.log(`(dry-run note: business lookup skipped — ${String(err instanceof Error ? err.message : err)})\n`);
      return null;
    }
    throw err;
  });
  if (!business && !args.dryRun) {
    console.error(`ERROR: no business found for "${args.business}". Pass a business id (uuid) or the email of the business/its owner or manager.`);
    return 1;
  }
  printHeader(args, business);
  if (business) {
    const gate = assignSharedGate(business);
    if (gate.stop) {
      console.log(args.dryRun ? "DRY-RUN outcome: " + gate.message : gate.message);
      return args.dryRun ? 0 : (gate.message.startsWith("Already configured") ? 0 : 1);
    }
  }
  console.log(args.dryRun ? "Planned actions (nothing executed):\n" : "Actions:\n");
  planToPrinted(buildAssignSharedPlan(webhookBase));
  console.log("");
  if (args.dryRun) {
    console.log(verifyChecklist(numberDisplay).join("\n"));
    return 0;
  }
  await setBusinessPhone(business!.id, SHARED_NUMBER);
  console.log(`DONE: businesses.phone = '${SHARED_NUMBER}' for business ${business!.id}.`);
  console.log(`The shared number's webhooks (${buildWebhookUrls(webhookBase).sms} and /voice) are already live on Twilio — nothing to configure.`);
  console.log("");
  console.log(verifyChecklist(numberDisplay).join("\n"));
  return 0;
}

async function runProvisionDedicated(args: ParsedArgs): Promise<number> {
  const webhookBase = webhookBaseUrl();
  const urls = buildWebhookUrls(webhookBase);
  const numberDisplay = args.number ? (normalizePhone(args.number) ?? args.number) : "(your new dedicated number — printed here in live mode after purchase)";
  console.log("=".repeat(78));
  console.log(HARD_WARNING);
  console.log("=".repeat(78));
  console.log("");
  const business = await resolveBusiness(args.business ?? "").catch((err: unknown) => {
    if (args.dryRun) {
      console.log(`(dry-run note: business lookup skipped — ${String(err instanceof Error ? err.message : err)})\n`);
      return null;
    }
    throw err;
  });
  if (!business && !args.dryRun) {
    console.error(`ERROR: no business found for "${args.business}". Pass a business id (uuid) or the email of the business/its owner or manager.`);
    return 1;
  }
  printHeader(args, business);
  if (business && business.phone && business.phone.trim() !== "") {
    const msg = `Already configured: businesses.phone is '${business.phone}' for ${business.id}. Re-running provision-dedicated would buy/configure a duplicate number — nothing to do. To move this business to a different number, clear businesses.phone first (rollback in docs/PROVISION-CUSTOMER.md), then re-run.`;
    console.log(args.dryRun ? "DRY-RUN outcome: " + msg : msg);
    return 0;
  }
  const targetNumber = args.number ? normalizePhone(args.number) : null;
  if (args.number && !targetNumber) {
    console.error(`ERROR: --number "${args.number}" is not a dialable phone number.`);
    return 1;
  }
  console.log(args.dryRun ? "Planned actions (nothing executed):\n" : "Actions:\n");
  planToPrinted(buildProvisionDedicatedPlan(webhookBase, args.service ?? "<service>", { number: targetNumber }));
  console.log("");
  if (!args.dryRun) {
    // 1. Campaign gate — read-only, honest, aborting.
    console.log("Campaign gate (read-only):");
    const compliance = await twilioRequest("GET", `${TWILIO_MSG_BASE}/Services/${args.service}/Compliance/Usa2p`).catch((err: unknown) => {
      console.error(`ABORT: could not read campaign compliance for service ${args.service}: ${String(err instanceof Error ? err.message : err)}`);
      return null;
    });
    if (!compliance) return 1;
    const status = String(compliance.campaign_status ?? compliance.status ?? compliance.campaignStatus ?? "");
    const campaignSid = String(compliance.campaign_sid ?? compliance.campaignSid ?? "");
    console.log(`  campaign: ${campaignSid || "(unknown from response)"}  status: ${status || "(no status field in response)"}`);
    if (campaignSid && args.campaign && campaignSid !== args.campaign) {
      console.error(`ABORT: service ${args.service} is linked to campaign ${campaignSid}, but you passed --campaign ${args.campaign}. The service↔campaign pair must match.`);
      return 1;
    }
    if (status !== "VERIFIED") {
      console.error(`ABORT: campaign status is "${status || "unreadable"}", not VERIFIED. Register and verify the campaign first (docs/PROVISION-CUSTOMER.md — "when to register the next campaign"). This script never creates campaigns.`);
      return 1;
    }
    console.log("  gate passed: VERIFIED\n");
    // 2. Acquire the number (reuse via --number, or search + buy).
    const { accountSid } = readTwilioCreds();
    let numberSid: string;
    let e164: string;
    if (targetNumber) {
      const found = await twilioRequest("GET", `${TWILIO_API_BASE}/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(targetNumber)}`);
      const row = (found.incoming_phone_numbers as { sid: string; phone_number: string }[] | undefined)?.[0];
      if (!row) {
        console.error(`ABORT: --number ${targetNumber} is not owned by this Twilio account.`);
        return 1;
      }
      numberSid = row.sid;
      e164 = row.phone_number;
      console.log(`Reusing owned number ${e164} (${numberSid}).`);
    } else {
      const search = await twilioRequest("GET", `${TWILIO_API_BASE}/Accounts/${accountSid}/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true&Limit=5`);
      const available = (search.available_phone_numbers as { phone_number: string }[] | undefined) ?? [];
      if (available.length === 0) {
        console.error("ABORT: no US local numbers with SMS+Voice available right now. Retry later or widen the search.");
        return 1;
      }
      e164 = available[0].phone_number;
      console.log(`Buying ${e164} …`);
      const bought = await twilioRequest("POST", `${TWILIO_API_BASE}/Accounts/${accountSid}/IncomingPhoneNumbers.json`, {
        PhoneNumber: e164,
        SmsUrl: urls.sms,
        SmsMethod: "POST",
        VoiceUrl: urls.voice,
        VoiceMethod: "POST",
        StatusCallback: urls.voice,
      });
      numberSid = String(bought.sid);
      console.log(`Bought ${e164} (SID ${numberSid}) with webhooks pre-set.`);
    }
    // 3. Messaging service membership (idempotent: check before adding).
    const membership = await twilioRequest("GET", `${TWILIO_MSG_BASE}/Services/${args.service}/PhoneNumbers?PageSize=50`);
    const members = (membership.phone_numbers as { sid: string; phone_number: string }[] | undefined) ?? [];
    if (members.some((m) => m.sid === numberSid || m.phone_number === e164)) {
      console.log(`Membership: ${e164} is already in messaging service ${args.service} — skipping add.`);
    } else {
      await twilioRequest("POST", `${TWILIO_MSG_BASE}/Services/${args.service}/PhoneNumbers`, { PhoneNumberSid: numberSid });
      console.log(`Membership: added ${e164} to messaging service ${args.service}.`);
    }
    // 4. Ensure webhooks on the number (idempotent re-POST + read back).
    await twilioRequest("POST", `${TWILIO_API_BASE}/Accounts/${accountSid}/IncomingPhoneNumbers/${numberSid}.json`, {
      SmsUrl: urls.sms,
      SmsMethod: "POST",
      VoiceUrl: urls.voice,
      VoiceMethod: "POST",
      StatusCallback: urls.voice,
    });
    const verifyRead = await twilioRequest("GET", `${TWILIO_API_BASE}/Accounts/${accountSid}/IncomingPhoneNumbers/${numberSid}.json`);
    console.log(
      `Webhooks read back: SmsUrl=${String(verifyRead.sms_url ?? "?")} VoiceUrl=${String(verifyRead.voice_url ?? "?")} StatusCallback=${String(verifyRead.status_callback ?? "?")}`,
    );
    // 5. Map the business.
    await setBusinessPhone(business!.id, e164);
    console.log(`DONE: businesses.phone = '${e164}' for business ${business!.id}.`);
    console.log("");
  }
  console.log(verifyChecklist(numberDisplay).join("\n"));
  console.log("");
  console.log(`Reminder: keep proof that campaign ${args.campaign ?? "<campaign>"} stays VERIFIED. Sole-prop campaigns carry exactly ONE number — adding more numbers means registering another campaign (docs/PROVISION-CUSTOMER.md).`);
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
export function printUsage(): void {
  console.log(USAGE);
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  try {
    if (parsed.args.mode === "assign-shared") return await runAssignShared(parsed.args);
    return await runProvisionDedicated(parsed.args);
  } catch (err) {
    console.error("ERROR: " + String(err instanceof Error ? err.message : err));
    return 1;
  }
}

// Guarded so scripts/test-infra.ts can import the pure helpers without side effects.
if (import.meta.main) {
  process.exit(await main());
}
