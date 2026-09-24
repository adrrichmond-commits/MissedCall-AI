# Backup & Restore Runbook — Neon Postgres (MissedCall AI)

Operational runbook for the production database. Production runs on Neon
(serverless Postgres); the app connects with `DATABASE_URL` (read at runtime
from the environment — never baked into the build, so a swap needs no rebuild).

## 1. How Neon protects this project's data

- **Storage-level history (built in):** Neon keeps a versioned history of every
  page of your data. Any point in time inside the project's **history retention
  window** can be restored instantly by creating a copy-on-write branch that
  starts at that timestamp. Retention length depends on the project's plan —
  check it in Console → Project → Settings (free plans keep only hours; paid
  plans keep days or more). **Check the window before you rely on it.**
- **There is no nightly snapshot file to download.** "Backup" in Neon *is* the
  history + branching. An independent, off-Neon backup requires `pg_dump`
  (see "Not covered" below).
- **Branch restore is non-destructive by construction:** a restore branch
  shares nothing with production until you point production at it. You can
  inspect and verify a restore candidate while the live site keeps serving.

## 2. Recovery concepts (honest terms)

| Term | What it means here |
|---|---|
| **RPO** (how much data can be lost) | Only data outside the retention window is unrecoverable. Inside the window, restore points are effectively continuous (WAL-based). If the incident is noticed within the retention window, expect to lose nothing except whatever the bad write destroyed. |
| **RTO** (how long until service is back) | Branch creation is seconds-to-minutes (copy-on-write, no data copy). The rest is verification + swapping `DATABASE_URL` + compute cold-start. Plan for **15–60 minutes** end to end the first time you do it; minutes once practiced. |
| **Not recoverable by PITR** | Things that are not in this Postgres: Stripe customer/subscription state, Twilio message logs, the owner's env/secrets, anything outside the history window, and a fully **deleted Neon project** (deleting the project deletes its history). |

## 3. Restore procedure (point-in-time, non-destructive)

Who does what: **the owner** (or anyone with Neon console access / a Neon API
key) performs 3.1–3.4; the team can execute 3.5–3.7 once given the new URL.

### 3.1 Create a restore branch at the target timestamp

Console (no CLI needed): Project → **Branches** → **Create branch** → choose
**from a past time**, pick the timestamp just *before* the incident, name it
`restore-<date>`.

API equivalent (owner runs with their Neon API key; base URL
`https://console.neon.tech/api/v2`):

    curl -sS -X POST "https://console.neon.tech/api/v2/projects/$NEON_PROJECT_ID/branches" \
      -H "Authorization: Bearer $NEON_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{"branch": {"name": "restore-2026-09-24", "parent_id": "'"$PARENT_BRANCH_ID"'", "point_in_time": "2026-09-24T14:00:00Z"}}'

(`point_in_time` is an RFC 3339 UTC timestamp inside the retention window;
`parent_id` is the id of the branch to branch *from* — for this project that is
the `main` production branch. Project id, branch ids and endpoint/hosts are
visible in Console or `GET /projects/{project_id}/branches`.)

CLI equivalent if `neonctl` is installed: `neonctl branches create --name
restore-<date> --project-id <id> --parent <parent-id> --timestamp <RFC3339>` —
confirm the exact flag spelling with `neonctl branches create --help` for your
neonctl version before relying on it (the Console and API paths above are the
canonical surface).

### 3.2 Verify the restore branch BEFORE promoting it

Connect to the branch's connection string (Console shows it on the branch
page) and check the data is the state you expect:

    # Row counts on the key tables (compare against the numbers below /
    # last known good):
    SELECT 'businesses' t, count(*) FROM businesses
    UNION ALL SELECT 'users', count(*) FROM users
    UNION ALL SELECT 'leads', count(*) FROM leads
    UNION ALL SELECT 'conversations', count(*) FROM conversations
    UNION ALL SELECT 'messages', count(*) FROM messages
    UNION ALL SELECT 'appointments', count(*) FROM appointments
    UNION ALL SELECT 'notifications', count(*) FROM notifications
    UNION ALL SELECT 'usage_counters', count(*) FROM usage_counters
    UNION ALL SELECT 'billing_events', count(*) FROM billing_events;

    # The damaged rows are gone / the deleted rows are back:
    SELECT id, name, created_at FROM businesses ORDER BY created_at DESC LIMIT 5;

Migrations state check (schema should match production exactly — PITR restores
data AND schema):

    SELECT id, applied_at FROM schema_migrations ORDER BY id;

### 3.3 Promote: point the app at the restore branch

The app has no state outside `DATABASE_URL`, so promotion = swapping the
connection string:

1. Copy the restore branch's pooled connection string from Console (branch
   page → Connection Details; pick the **pooled** connection string).
2. Update `DATABASE_URL` in the platform's Settings → Secrets for both
   environments (the live site restarts with the new value within seconds —
   no publish needed).
3. Verify: `GET /api/healthz` returns `{"ok":true,"db":true,...}` and log in
   with a real account (or run `bun scripts/test-smoke.ts https://<live-url>`).

The old (damaged) production branch stays untouched — keep it around (rename
`damaged-<date>`, do NOT delete yet) until you are confident, then delete it.

### 3.4 If the damage was an accidental DELETE/UPDATE of rows

PITR gives you the whole branch at the earlier time; recovering *some* rows
into the *current* database (rather than rewinding everything) is done by
copying across connections (e.g. export the missing rows from the restore
branch and re-INSERT them). Rewinding the whole DB loses every good write made
after the incident — prefer row-level recovery when both datasets matter.

## 4. What is NOT covered — and what to do about it

| Not covered | Consequence | Mitigation |
|---|---|---|
| History older than the retention window | Not restorable at all | For plan-critical data: scheduled `pg_dump` (Neon documents an automation recipe; owner decision, Phase 4 candidate) |
| Deleting the whole Neon project | All history gone | Never delete the project; disable/delete individual branches instead |
| Non-Postgres systems (Stripe, Twilio, email provider) | Their data/log lives with them | Export from those dashboards when needed |
| Platform secrets/env | Not in the database | They live in the platform's Secrets settings |
| Branches themselves | Deleting a branch deletes it permanently | Only ever delete restore branches after promotion is verified |

## 5. Verification status (honest)

- **What was verified from here:** nothing could be exercised against the real
  project — PITR/branch creation requires owner credentials (Neon Console
  access or a `NEON_API_KEY`), which the team does not have by design. The
  command surface above was checked against Neon's public docs (branching /
  instant-restore / API reference) rather than invented.
- **What the owner should run once** (cheap, non-destructive): create a
  `restore-drill-<date>` branch from a timestamp an hour ago, run the section
  3.2 queries against it, delete it. Ten minutes, zero production impact —
  and it proves the runbook end-to-end.

## 6. Contacts / ownership

- Owner: Neon project + secrets + `DATABASE_URL` swap (Sections 3.1–3.4).
- Team engineer: migrations re-check (`schema_migrations`), app-level
  verification (`bun scripts/test-smoke.ts https://<live-url>`), and
  post-restore data sanity for the affected tables.
