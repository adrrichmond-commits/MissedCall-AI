# Webhook & endpoint security pass (P4-I)

Every public, unauthenticated endpoint is verified + rate-limited. Nothing
processes traffic it cannot authenticate, and nothing fails open.

## Inbound SMS webhook — POST /api/webhooks/twilio

1. **Honest 503 gate** — without `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` the
   route cannot verify anything: 503, nothing processed.
2. **Signature** — `X-Twilio-Signature` HMAC-SHA1 over URL + sorted params
   (`twilioSignatureIsValid`, constant-time compare). Invalid → 403, nothing
   stored.
3. **Rate limit** — 600/min per source IP (`twilio_webhook` bucket). Tripped →
   429 + `Retry-After` (Twilio honors its own retry schedule).
4. **Routing** — business resolved by the called number; unknown number → 404,
   never a guess (business isolation is the WHERE clause).
5. **Unexpected throws** — `guardApiRoute` records to `system_errors` and
   answers a clean 500 (no stack traces).

## Voice webhook — POST /api/webhooks/twilio/voice

Same 503 gate + signature validation (via `handleVoiceWebhook`). Rate limit is
TwiML too: a tripped limit answers with the fallback TwiML. Unexpected throws
answer **apology + voicemail TwiML (200)** and record `voice_call` in
`system_errors` — a live caller is never served JSON or a dead end.

## Stripe webhook — POST /api/webhooks/stripe

1. Honest 503 gate without `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`.
2. **Signature** — Stripe-Signature v1 scheme with fresh-timestamp tolerance
   and constant-time compare (`verifyStripeSignature`). Bad/stale → 403,
   event not claimed.
3. **Rate limit** — 600/min/IP (`stripe_webhook` bucket), 429 + `Retry-After`.
4. **Idempotency** — every event deduped by id (`stripe_events`,
   INSERT … ON CONFLICT DO NOTHING) so Stripe's at-least-once redelivery never
   double-applies a plan change.
5. Unexpected throws → `guardApiRoute` → `system_errors` + clean 500.

## Auth endpoints (signup / login / password reset)

In-memory fixed-window rate limit per client IP (x-forwarded-for first hop),
one config module (`src/lib/server/rateLimit.ts`):

- signup 30/min, login 60/min, password-reset 20/min (env-overridable;
  `RATE_LIMIT_DISABLED=1` for CI/tests — limits are deliberately generous so
  the smoke suite never trips them).
- Tripped limit → typed `AuthError` → the UI shows the honest "too many
  attempts, retry in Ns" message. Password verification keeps its
  constant-shape behavior (no user enumeration).
- Passwords: argon2id; sessions: hashed token cookies; business disabled
  accounts cannot log in (P3-G).

## Error hygiene on public paths

- Client-safe payloads only: no stack traces, connection strings, or driver
  messages on any response (`guardApiRoute`'s 500 says "recorded — visible in
  /admin/health").
- Error context stored in `system_errors.detail` is ids/statuses only, never
  secrets.

## Monitoring (no paid signup required)

Point any external uptime monitor at:

- `GET /api/healthz` — liveness (200 = process up + db `SELECT 1` answers).
- `GET /api/healthz/ready` — readiness (200 = db up + all critical tables +
  migrations applied; payload includes `recentErrors`, the trailing-hour count
  from the in-app error sink — alert when it spikes).

Both are unauthenticated by design and answered with `Cache-Control: no-store`.
Recommended checks: liveness every 1–5 min (page on down), readiness every
5–15 min (page when `ok:false` persists > 5 min or `recentErrors` jumps).
