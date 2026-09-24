# Business Data-Isolation Audit (P3-H part 2)

Audit date: 2026-09-24 · HEAD audited: c2c2f0a (main) + this PR's fixes.
Auditor: P3-H pt2 delegation. Verdict: **no cross-business data leakage**
after two real defects found and fixed in this PR (Section 6).

## 1. The isolation model (what is being audited)

Every business-scoped table carries `business_id NOT NULL REFERENCES
businesses(id) ON DELETE CASCADE`. Every query-module function that touches
business data takes `businessId` as a parameter and filters on it — **the WHERE
clause is the isolation boundary** (AGENTS.md, "Business isolation
(non-negotiable)").

The authority chain every request must follow:

    session cookie mca_session
      -> sha256 hash (auth.server.ts hashToken)
      -> getSessionByTokenHash(token_hash)      [the only lookup by hash]
      -> user.businessId                        [from the DB, never client input]
      -> ctx.business.id
      -> query fn(businessId, ...)              [WHERE business_id = $1]

`getSessionFromRequest()` (src/lib/server/auth.server.ts:88) additionally
nulls the session when the user is deactivated or the business is
admin-disabled (migration 014 kill switch). Guards: `requireAuth()`,
`requireRole(...)`, `requireActiveWrite(...)` (trial/subscription gate),
`requirePlatformAdmin()` (admin.ts:67). No server fn derives `businessId`
from client input.

## 2. Table inventory (22 tables, migrations 001–015)

**Business-scoped** (every row carries business_id): leads, conversations,
messages, appointments, services, service_areas, business_hours, notifications,
follow_up_tasks, usage_counters, billing_events, sms_opt_outs, calls.
**Owned by a business via users**: users (business_id NOT NULL).
**Global by design** (one row set for the whole platform): businesses (the
tenant root), sessions (keyed by token hash -> user -> business),
password_reset_tokens, email_verification_tokens, service_defaults (the shared
catalog every business copies from), stripe_events (webhook dedupe log),
admin_audit (platform operator log), schema_migrations (runner bookkeeping).

## 3. Query-layer evidence — every function, its scope, and its caller

Automated scan (method: extract every `export ... function` in
`src/db/queries/*.ts`, check signature for `businessId` and body for a
`business_id` filter; full transcript in the PR):

- **100% of business-scoped read/write functions filter on their businessId
  parameter.** Files: leads.ts (16 fns), conversations.ts (16), appointments.ts
  (11), settings.ts (13), notifications.ts (10), followUpTasks.ts (5),
  usage.ts (5), revenue.ts (5), smsComms.ts (5), stripe.ts (4 business-arg fns),
  auth.ts getBusiness().
- **The only functions WITHOUT a businessId parameter are the documented
  cross-business exceptions** (marked as such in-file):

  | Function | Why it may cross businesses | Caller |
  |---|---|---|
  | auth.ts findUserByEmail / emailExists / touchLastLogin | login is by email by definition | authFns login/reset |
  | auth.ts getSessionByTokenHash / createSession / deleteSession / deleteExpiredSessions / deleteSessionsForUser | the token hash IS the credential; session -> user -> business resolution | auth.server.ts |
  | auth.ts createPasswordResetToken / findValidPasswordResetToken / markPasswordResetTokenUsed (+ email-verification pair, invalidate*) | token-hash authority, pre-account-resolution | authFns |
  | auth.ts createBusinessWithOwner / setUserEmailVerified / updateUserPasswordHash / deleteSessionsForUser | operate on a user being created or a token-verified user | authFns signup/reset/verify |
  | auth.ts getBusinessByPhoneKey | maps an INBOUND TWILIO CALL/SMS to its business by called number | api/webhooks/twilio.ts, voiceReceptionist.ts |
  | calls.ts getCallBySid | Twilio voice webhook lookup by CallSid | api/webhooks/twilio.voice.ts |
  | calls.ts normalizeTranscript (pure, no DB) | — | — |
  | settings.ts listServiceDefaults | the shared catalog, not business data | settingsFns |
  | stripe.ts claimStripeEvent / markStripeEventProcessed | webhook dedupe log, verified-signature callers | api/webhooks/stripe.ts |
  | stripe.ts findBusinessIdByStripeCustomer / BySubscription / ByEmail | maps an incoming Stripe object to its tenant | stripeWebhook.ts (signature-verified) |
  | admin.ts * (platformOwnerEmail, platformAdminGateOpen, listAdminAccounts/Detail/audit, aggregate funnel, listRecentStripeEvents, appendAdminAudit) | platform operator views behind requirePlatformAdmin + audit log | adminFns/adminReads |

## 4. Caller inventory (server fns, SSR reads, API routes)

Grep: no `input.businessId` / `data.businessId` / `args.businessId` /
`payload.businessId` in any user-facing fn. The ONLY client-supplied
businessIds in the codebase are the admin actions (below). Guard usage per
module: appFns 17, settingsFns 16, adminReads 7, billingFns 7,
notificationFns 5, sessionFns 4, adminFns 6 (requirePlatformAdmin),
authFns 0 (pre-auth flows: signup/login/logout/reset/verify — correct, they
resolve accounts by credential, then operate via the resolved businessId).

| Path | Scoping | Evidence |
|---|---|---|
| `src/routes/api/webhooks/twilio.ts` (inbound SMS) | Twilio signature check first; business resolved from the called (To) number via getBusinessByPhoneKey; every later query passes that businessId | file comment step 4; 404 "unknown_number" when unassigned |
| `src/routes/api/webhooks/twilio.voice.ts` (voice) | Signature first; getBusinessByPhoneKey; capture writes businessId explicitly | file header |
| `src/routes/api/webhooks/stripe.ts` + stripeWebhook.ts | Signature first; business from event metadata.businessId else customer->business lookup (findBusinessIdByStripe*) | file header "metadata.businessId, else email lookup" |
| SSR route gates (`_app.tsx`, `admin.tsx`) | beforeLoad calls PLAIN sessionReads.currentSession / adminReads.adminGate during SSR (PR #27 pattern); both resolve from the request cookie | adminReads.ts:79,135,188,283,389; sessionReads.ts |
| `src/routes/api/healthz.ts` | unauthenticated, returns ok/db booleans only — no business data | code |
| Admin impersonation | `impersonateBusiness(adminUserId, businessId)` swaps the session to the target business and STASHES the admin session; exit restores it; BOTH write appendAdminAudit rows | admin.ts:175,229,262,296 (4 audited actions: disable, plan override, impersonate, exit) |
| Admin disable / plan override | requirePlatformAdmin + UUID format check + audit row + billing event | adminFns.ts:111-155 |

## 5. Findings table

| Area | Verdict | Notes |
|---|---|---|
| Schema: business_id NOT NULL on all tenant tables | **PASS** | migrations 001–015; CASCADE ownership verified live by the isolation suite cleanup |
| Query layer scoping (all 13 modules) | **PASS (after fix)** | 100% take businessId + filter; zero ad-hoc SQL outside src/db/queries |
| Session -> business resolution | **PASS** | single source (getSessionFromRequest); disabled/deactivated handled; verified live by test |
| Server fns (user-facing) | **PASS** | no client-supplied businessId anywhere (grep clean) |
| SSR loaders | **PASS** | plain-fn modules (sessionReads/adminReads), same resolver |
| Twilio webhooks (SMS + voice) | **PASS** | signature-validated; phone->business is the documented key |
| Stripe webhook | **PASS** | signature-validated; metadata/email mapping writes billing_events + audit trail |
| Admin + impersonation | **PASS** | requirePlatformAdmin + env gate + UUID checks + appendAdminAudit on all 4 privileged actions |
| Aggregates/derive correctness | **FIXED in this PR** | camelCase-alias bug class (Section 6) — isolation-level unaffected, data-correctness fixed + regression-guarded |
| Automated proof | **PASS** | scripts/test-isolation.ts: 60 checks, 0 failures (two real businesses via the real signup core; zero cross-reads/writes in either direction) |

## 6. Defects found during this audit (fixed in this PR)

**CamelCase-alias bug class.** `src/db.ts` camelCase-ifies every returned row
key (`missed_calls` -> `missedCalls`). Six read sites still accessed
snake_case keys on those rows — always `undefined`, so the value silently
became 0/NaN/empty with no error:

- `revenue.ts` leadAggregates (`total_leads`, `leads_with_value`,
  `converted_at`, `pipeline_value_cents`) — **the Revenue Recovered KPI read
  0 for every business**; missedCallRecoveryCounts (`missed_calls`);
  revenueFunnelCounts (`missed_calls`, `missed_recovered`, `appt_leads`).
- `admin.ts` adminAggregateFunnelCounts — same three fields (admin health page).
- `conversations.ts` leadIdsWithConversations (`lead_id` -> always-empty set,
  i.e. "recovered" detection dead) and conversationSummariesForLead
  (`message_count` -> NaN, `last_message_at` -> undefined).

Not an isolation leak (no cross-business exposure — the WHERE clauses were
always correct; only aggregate reads were zeroed). Fixed by reading the
camelCase keys; `scripts/test-isolation.ts` now asserts real non-zero values
from every affected function so the class cannot return silently.

## 7. The permanent proof test

`bun scripts/test-isolation.ts` (runs in CI, needs only DATABASE_URL):

1. Creates two businesses through the real signup core
   (`createBusinessWithOwner`), issues each a session exactly as
   `issueSession` does.
2. Seeds identical-shaped data in both (leads x2, conversation + message,
   appointment, service, service area, business hours, notification,
   follow-up, usage increment, billing event, won job with a distinct value).
3. Asserts, in BOTH directions: reads of the other business's rows return
   null/[]/false; writes (update/status/delete/append/read-flag) do not land;
   lists, counts, funnel and revenue aggregates contain only the caller's own
   rows (including distinct won-values proving no money cross-counts).
4. Regression guards for the Section 6 functions.
5. Cleans up both businesses (CASCADE) and asserts they are gone.

Run locally: `bun scripts/test-isolation.ts` (against Neon directly, or
`USE_LOCAL_POSTGRES=1 DATABASE_URL=postgres://... ` for a local Postgres).
