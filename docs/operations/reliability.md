# Reliability: failure ladder & what happens when things break (P4-I)

Owner requirement 18 (reliability & failover) in one page: for each component,
what fails → what the customer experiences → what the plumber sees → what
alerts fire. Design rule throughout: **fail toward capture and honesty** —
data lands first, provider failures are recorded, and no user-facing flow
dies silently or hits a dead end.

## Alerts & observability (the spine)

- **Structured logs** — every server event is a JSON line (`src/lib/server/logger.ts`).
- **In-app error sink** — `recordSystemError()` writes to `system_errors`
  (migration 016) with source/severity/businessId/detail; the platform owner
  sees recent rows + a trailing-hour count on **/admin/health**. No external
  tool required.
- **External hook** — if `ERROR_MONITOR_DSN` is set, each recorded error is
  also POSTed there (fire-and-forget). Unset = no-op.
- **Probes** — `/api/healthz` (liveness: process + `SELECT 1`) and
  `/api/healthz/ready` (readiness: db + all critical tables + recent-error
  count). Point any external uptime monitor at both (see security-webhooks.md
  § monitoring).

## Outbound SMS (text-backs, auto-replies, STOP confirmations)

| What fails | Customer experiences | Plumber sees | Alerts |
|---|---|---|---|
| Transient Twilio error (network, 429, 5xx) | nothing — send is retried (2 retries, 400/1200 ms backoff) | nothing | nothing (normal operation) |
| Final send failure (after retries, or 4xx like opt-out/invalid number) | no text arrives | lead/conversation is still captured with an honest `failed` outcome | `system_errors` row `source=sms_delivery` + error log |
| Twilio not configured | no text arrives; lead capture unaffected | notification says `not_configured` (never a fake send) | dormancy badge on /admin/health |
| Customer opted out (STOP) | nothing sent (compliance) | `opted_out` outcome on the record | none (expected state) |

Code: `sendSms()` retry loop in `src/lib/server/sms.ts`; recording in
`src/lib/server/textBack.ts` (`captureSystemError` at every final-failure site).
**No usage is metered for a failed send.**

## Inbound SMS / AI classification

| What fails | Customer experiences | Plumber sees | Alerts |
|---|---|---|---|
| LLM tier error/timeout | reply still arrives — rules engine backstop classifies the same turn | classification stamped `tier=rules, tierReason=backstop` | log line; repeated backstops visible in logs |
| Twilio webhook unexpected throw | nothing (Twilio retries) | — | `guardApiRoute` → `system_errors` `api_route:twilio_sms` + clean 500 |
| Webhook flood | 429 after 600/min/IP — Twilio retries on its schedule | — | rate-limit warn log |

## AI voice receptionist

The call flow already degrades stepwise (src/lib/server/voiceReceptionist.ts):

| What fails | Caller experiences | Plumber sees | Alerts |
|---|---|---|---|
| Business has no transfer number, caller wants a human | honest apology + voicemail recording | call row `voicemail` + recording URL | none (documented path) |
| DB trouble mid-call (no call row) | apology → transfer if a target exists, else voicemail | — | `system_errors` `voice_call` (db_down) |
| Unexpected throw in the voice webhook | apology + voicemail — **never a dead end** | — | `system_errors` `voice_call` |
| AI/LLM unavailable during a call | rules-tier answers (KB scripts verbatim for emergencies) | transcript stamps the tier | log lines |
| Business transfer number missing AND platform fallback unset | voicemail | call row | none |

Last-resort ladder: **AI → business transfer number →
`TWILIO_VOICE_FORWARD_NUMBER` (env-gated) → voicemail**. A call is never
answered with silence, an error page, or a hang-up on failure.

## Database

| What fails | Customer experiences | Alerts |
|---|---|---|
| Brief outage | error pages surface honest generic messages; sessions survive reconnect | `system_errors` rows from whichever paths hit it; readiness probe 503s |
| Migration not applied | readiness probe 503 naming the missing table(s) | monitor alert on /api/healthz/ready |

Backups + restore runbook: docs/operations/backup-restore.md. Readiness probe
details: `runReadinessProbe()` in src/lib/server/healthProbe.ts.

## Auth

Rate limits (generous) on login/signup/password-reset per client IP; a tripped
limit returns an honest "too many attempts, retry in Ns" message. Unexpected
auth errors are recorded (`source=auth`) while the client gets the same safe
generic message — no internals leak.

## What this deliberately does NOT do

- No auto-failover to a second database (Neon handles HA; restore runbook is
  the manual path).
- No external monitoring service signup — the probes are provider-agnostic;
  any HTTP monitor the owner already uses can point at them.
