# Environments & deploy path (P4-I)

MissedCall AI deploys **through the platform's publish flow**. There is one
codebase and one build; environments differ only by **environment variables**
(set in the platform's Secrets) — never by diverging code or branches.

## The three environments

| | Local dev | Working site (preview) | Live site (production) |
|---|---|---|---|
| URL | localhost dev server | the `…-dev.ctonew.app` working-site URL | the public `…ctonew.app` URL |
| Who uses it | the engineer | the team: review before publish | real customers |
| `DATABASE_URL` | local Postgres (CI: service container via `USE_LOCAL_POSTGRES=1`) | Neon branch/db from Secrets | Neon prod db from Secrets |
| Twilio / Stripe / LLM / email keys | unset → integrations dormant | unset or staging values | owner's production values from Secrets |
| Rate limits | `RATE_LIMIT_DISABLED=1` allowed for tests | defaults (generous) | defaults (generous) |
| Publishes | never | receives `publish_site` output after the gate passes | the lead swaps the live copy |

**Isolation rule:** separation comes from Secrets, not code. Never branch on
an environment by URL string; read `process.env` and degrade honestly when a
key is absent (every integration already does — see the dormancy notes in
`/admin/health`).

## Deploy path

```
feature branch → PR → CI green (build + typecheck + 13 suites +
                        smoke & isolation on a Postgres service container
                        + launch-checklist warn-only)
              → lead merges to main (squash)
              → scripts/verify-deploy.ts against the built artifact
                (liveness + readiness + full smoke on the prod build)
              → lead runs publish_site (working → live)
```

The pre-publish gate is `bun scripts/verify-deploy.ts` — it boots the REAL
prod build (via `scripts/prod-serve.ts`) against a real database and runs the
full smoke suite. Exit 0 = publishable. `bun scripts/launch-checklist.ts
--serve --smoke` prints the full readiness table (including routes rendering)
and is what CI summarizes in warn-only mode.

## Environment variables (the contract)

Required everywhere: `DATABASE_URL`.

Integration keys are **env-gated and dormant until set** (no paid service is
required to run the product):

| Variable | Gates | When unset |
|---|---|---|
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_SMS_NUMBER` | outbound SMS + webhook/voice signature verification | sends fail fast & honestly; webhooks answer 503 |
| `TWILIO_VOICE_FORWARD_NUMBER` | last-resort voice transfer target | voice falls back to voicemail |
| `LLM_API_KEY` | LLM classification tier | rules engine classifies (keyless launch default) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | checkout + subscription webhooks | billing pages render dormant; webhooks 503 |
| `STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` | maps Stripe price IDs to plan tiers (`price_…`, live mode, from the dedicated MissedCall AI Stripe account) | checkout resolves prices by `lookup_key` (`starter` / `pro`) on the account's provisioned catalog instead |
| `EMAIL_PROVIDER_KEY` (or equivalent per email.ts) | outbound owner emails | in-app notifications still work |
| `PLATFORM_OWNER_EMAIL` | opens `/admin` for that account | admin surface 404s for everyone |
| `ERROR_MONITOR_DSN` | optional external error-monitor POST | no-op (errors still land in `system_errors`) |
| `LOG_LEVEL` | log verbosity | `info` |
| `RATE_LIMIT_*_PER_MIN`, `RATE_LIMIT_DISABLED` | rate-limit tuning / kill switch | generous defaults, limiter ON |

Never commit `.env`; values live in platform Secrets. A build-time-baked
value (`import.meta.env`, `VITE_*`) only changes on the next publish — prefer
server-side `process.env` reads, which pick up Secret changes on restart.

## Stripe account (live billing)
Billing runs against a **dedicated MissedCall AI Stripe account** (restricted
key + webhook signing secret live in Secrets as `STRIPE_SECRET_KEY` /
`STRIPE_WEBHOOK_SECRET`) — not any platform-connected account. The catalog is
provisioned there: products `MissedCall AI — Starter` and `MissedCall AI — Pro`,
each with one recurring monthly USD price at the locked amounts from
`src/lib/pricing.ts` and `lookup_key`s `starter` / `pro`. Checkout resolves
`STRIPE_PRICE_STARTER` / `STRIPE_PRICE_PRO` first, then those lookup keys.

Account facts that code depends on:
- **Managed Payments** is enabled by default on the account, so every product
  MUST carry a `tax_code` (ours: `txcd_10000000`, general services) or
  Checkout Session creation is refused with `invalid_request_error`.
- The webhook endpoint targets `/api/webhooks/stripe` with events
  `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`,
  `invoice.payment_failed`. `customer.subscription.updated` is REQUIRED — it
  is the activation/status-sync path (trial→active, dunning recovery).
- Plan state is written ONLY by the webhook; the app never flips
  `businesses.plan` directly (single-writer rule).

## Rate limits (the one config module)

`src/lib/server/rateLimit.ts` — in-memory fixed-window counters, per client
IP, defaults generous so the smoke suite and normal humans never trip them:

| Bucket | Default | Override env |
|---|---|---|
| login | 60/min/IP | `RATE_LIMIT_LOGIN_PER_MIN` |
| signup | 30/min/IP | `RATE_LIMIT_SIGNUP_PER_MIN` |
| password reset | 20/min/IP | `RATE_LIMIT_PWRESET_PER_MIN` |
| twilio webhook | 600/min/IP | `RATE_LIMIT_TWILIO_PER_MIN` |
| stripe webhook | 600/min/IP | `RATE_LIMIT_STRIPE_PER_MIN` |

`RATE_LIMIT_DISABLED=1` turns the layer off entirely (CI/tests). If the app
ever runs multi-instance, swap the counter store for Postgres/Redis behind
the same `checkRateLimit` signature.

## Backups & restore (Neon)

The production database is Neon, which keeps **point-in-time restore (PITR)**
history on every branch by default — no backup job of ours runs or needs to
run. What this buys, and how to use it:

- **What is covered:** every table (`businesses`, `leads`, `conversations`,
  `messages`, `appointments`, `subscriptions`/usage, `system_errors`, …) on the
  branch `DATABASE_URL` points at. Restore history length follows the Neon
  plan's retention window (check the Neon console → Branch → Restore for the
  current window; the free/launch plan is typically several days).
- **Point-in-time restore (the main tool):** in the Neon console, select the
  production branch → **Restore** → pick a timestamp before the incident →
  restore. Neon offers (a) a **temporary branch** restored to that moment —
  the safe default: inspect/extract the lost rows, then copy them back with
  SQL — or (b) restoring the branch itself, which rewinds it and **discards
  every write after the chosen timestamp**. Prefer (a) unless the whole
  database is known-bad; the temporary branch touches nothing live.
- **Recovering rows (typical incident):** restore a temp branch to just before
  the bad write, then `INSERT INTO … SELECT` the affected rows from the temp
  branch into production via a second connection string (or export with
  `pg_dump` and re-import). Never point the app's `DATABASE_URL` at the temp
  branch except as a full deliberate cutover.
- **Full cutover (last resort):** restore the branch in place, then rotate the
  `DATABASE_URL` value in platform Secrets only if Neon issued a new
  connection string — the app picks it up on restart; no rebuild needed.
- **Schema after restore:** migrations are recorded in `schema_migrations` and
  are part of the data, so a restored database carries its matching schema. If
  the restore point predates a migration, re-run `bun run db:migrate` pointed
  at the restored database to bring it forward.
- **Extra safety for big changes:** before destructive maintenance (bulk
  deletes, schema surgery outside the migration runner), note the exact UTC
  timestamp in the PR/ticket first — it is the restore target if it goes wrong.

## Knock email transport (P4)
**Precedence rule (wired in `src/lib/server/email.ts`):** when `KNOCK_API_KEY`
is set, **Knock is the PRIMARY email transport** and every notification email
(new lead / appointment request / payment failure) triggers a Knock workflow.
The Resend-style path (`EMAIL_API_KEY` + `EMAIL_FROM`) stays intact as the
**fallback** when only `EMAIL_*` is set. Neither set → email is honestly
"not configured" and sends fail fast. `logEmailStatus()` states which transport
is active. In-app notifications are DB-native and independent of all of this.

| Var | Meaning |
|---|---|
| `KNOCK_API_KEY` | Knock **secret** key (`sk_…`) — Bearer auth for the trigger API |
| `KNOCK_WORKFLOW_KEY` | optional; default `missedcall-notify` |
| `KNOCK_API_BASE` | optional; default `https://api.knock.app` |
| `KNOCK_SIGNING_KEY` | **not consumed yet** — reserved for verifying Knock webhook callbacks (delivery/bounce events) when webhooks are wired |

Trigger shape: `POST {KNOCK_API_BASE}/v1/workflows/{KNOCK_WORKFLOW_KEY}/trigger`
with `{"recipients":[{"email":"<owner email>"}],"data":{"subject","body","html?"}}`.
The workflow's email template renders `data` via Knock liquid
(`{{ notification.data.subject }}` etc.).

**Owner setup steps (Knock dashboard — workflow content is dashboard-only):**
1. dashboard.knock.app → **Developers → API Keys**: copy the **Secret key**
   (`sk_…`) and save it as `KNOCK_API_KEY` in Secrets.
2. **Workflows → Create workflow**, key it `missedcall-notify` (or save a
   different key and set `KNOCK_WORKFLOW_KEY`).
3. In the workflow: add an **Email channel step**; set the From address/sender;
   in the template use `{{ notification.data.subject }}` as the subject and
   `{{ notification.data.body }}` as the body (optional "include if present"
   block for `{{ notification.data.html }}`).
4. **Commit/publish** the workflow (draft workflows never deliver).

**2026-09 verification (real API, no spam sends):** the saved `KNOCK_API_KEY`
returns `401 incorrect_token_type` ("You cannot call this endpoint with this
token") on the trigger endpoint — the saved value is **not a secret key**.
Save the `sk_…` secret key from Developers → API Keys; with it, the same call
proves auth (a nonexistent workflow then answers `404 workflow_not_found`, as
the unit tests cover). Until then notification emails **fail loudly-honestly**
(`outcome: "failed"`, detail carries Knock's message) and email_sent_at is
never stamped.
