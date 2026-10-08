# Provisioning a new customer's phone line — operator runbook

Goal: take a newly signed-up customer from "no phone mapping" to "texts to our
number reach their AI receptionist" in **under 15 minutes**, with one command,
one verification checklist, and a known rollback.

The tool: `scripts/provision-customer.ts` (repo root, run with `bun`).
It has TWO modes and every mode supports `--dry-run` (prints the planned API
calls, changes nothing). It is idempotent — re-running against a configured
business is a no-op with a clear message — and it never prints secrets.

---

## The 3-step operator flow

### Step 1 — Pick the mode and run it

**Almost always: `assign-shared`.** It points the customer's account at the
existing shared number **+1 (385) 336-5359**. This is the only mode that can
run against live Twilio today (see "Why only one number" below).

```bash
bun scripts/provision-customer.ts assign-shared --business <businessId-or-email> --dry-run   # preview first
bun scripts/provision-customer.ts assign-shared --business <businessId-or-email>             # apply
```

`--business` accepts the business's UUID **or** the email of the business
account / its owner or manager user (same resolution rule as Stripe billing).

**`provision-dedicated`** buys a NEW number for a customer who must have their
own line:

```bash
bun scripts/provision-customer.ts provision-dedicated \
    --business <businessId> \
    --campaign <CAMPAIGN_SID> \
    --service <MESSAGING_SERVICE_SID> \
    [--number <E164>]        # optional: reuse an already-owned number instead of buying
    [--dry-run]
```

> **HARD GATE:** `--campaign` and `--service` are required, and the campaign
> must **already be VERIFIED** on Twilio before this mode will run live — the
> script reads the campaign status and aborts otherwise. It **never creates,
> modifies, or re-submits campaigns**. Until a second campaign exists, expect
> to run this mode only with `--dry-run`.

### Step 2 — Verify end-to-end (do not skip)

The command prints this checklist when it succeeds; the customer's line is
NOT "done" until all four pass:

1. **Text** the number from a personal phone like a customer would
   (e.g. "My water heater is leaking").
2. **AI reply** arrives within ~1 minute (captures service need, urgency,
   contact details).
3. **Lead** appears on the dashboard (source `missed_call`).
4. **Owner alert** — a new-lead notification fires (plus an emergency takeover
   prompt if the message classified as an emergency).

### Step 3 — Record it and confirm the mapping

Note the business ↔ number mapping (it is one row: `businesses.phone`), and
tell the customer which number their calls/texts land on. If you ever need to
unmap: see Rollback below.

---

## Why only one number (today)

The A2P campaign **CE9Z2EM** (status VERIFIED, usecase SOLE_PROPRIETOR) legally
carries **exactly ONE number**: +1 (385) 336-5359. For sole-prop, the
number↔campaign association IS the number's membership in the campaign's
messaging service (`MGa447d7120e415dfbb452c420e7e145dc`). TrustHub
`ChannelEndpointAssignment` is a confirmed dead end on this account — do not
retry it. Full record: `/home/team/shared/twilio-golive.md`.

So today every pilot customer shares +1 (385) 336-5359, and inbound traffic is
separated purely by the last-10-digit match of `businesses.phone`
(`getBusinessByPhoneKey`).

### When to register the next campaign

Register a new A2P campaign (which needs its own brand registration — a
sole-prop brand is one-campaign/one-number) when any of these is true:

- a customer must have a **dedicated** line (their brand on caller ID, or
  their own compliance boundary),
- the shared number's messaging volume risks the sole-prop campaign's
  throughput/reputation,
- we scale past what one number can carry.

Then: register the brand/campaign in the Twilio console, wait for VERIFIED,
create/locate its messaging service, and run `provision-dedicated --campaign
<new CAMPAIGN_SID> --service <new MG...>` (dry-run first). The script refuses
to run live against an unverified campaign by design.

---

## Rollback

The entire mapping is one column. Clearing it unmaps the business immediately
(the webhooks are unchanged and simply stop resolving that business):

```sql
UPDATE businesses SET phone = NULL WHERE id = '<businessId>';
```

- If the business was on the **shared** number, that's all — the number stays
  live for other customers.
- If a **dedicated** number was bought and is no longer needed, release it in
  the Twilio console (or keep it if the customer may return) — releasing stops
  its charges. Removing it from the messaging service
  (`DELETE /v1/Services/{MG}/PhoneNumbers/{SID}`) also disassociates it from
  the campaign.

Re-provisioning after a rollback is just running the same command again.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `Twilio 401/invalid credentials` in live mode | `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` not exported in this shell. Dry-run works without them. |
| Verification text gets no AI reply | Check `businesses.phone` was actually set (last-10 digits match the number you texted). Then check webhook reachability: the routes answer unsigned probes with the app's own `403 invalid_signature` — anything else (502/timeout) means the environment was cold (the webhooks point at the dev base URL on purpose; see twilio-golive.md 9/28 update). |
| Twilio error "To and From cannot be the same" in owner alerts | The owner SMS fallback target equals the Twilio number; set `settings.smsWorkflows.safeguards.ownerSmsNumber` to a real owner mobile. |
| `provision-dedicated` aborts with campaign status not VERIFIED | Expected — register/verify the campaign first. The script never auto-creates campaigns. |
| Refuses to overwrite an existing `businesses.phone` | Deliberate. Confirm the old number is free, clear the column (Rollback), re-run. |
| First contact from a brand-new business produces no lead | The business row must exist before the first text — sign-up/onboarding creates it; the script refuses to run without a resolvable business. |

---

## Quick reference

```bash
# Preview every time; apply when the plan looks right
bun scripts/provision-customer.ts assign-shared --business <id-or-email> --dry-run
bun scripts/provision-customer.ts assign-shared --business <id-or-email>

# Dedicated line (requires a VERIFIED campaign + messaging service SID)
bun scripts/provision-customer.ts provision-dedicated --business <id> \
    --campaign <CAMPAIGN_SID> --service <MG...> --dry-run

bun scripts/provision-customer.ts --help
```

Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (live mode only),
`TWILIO_WEBHOOK_BASE_URL` (falls back to the documented dev base),
`DATABASE_URL`. Unit checks live in `scripts/test-infra.ts` (the
`provision:` block) and run in CI with the `infra` suite.
