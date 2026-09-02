# AGENTS.md — MissedCall AI site repo

Full-stack TanStack Start app (React 19 + Vite + Tailwind v4) plus a Postgres
data foundation. The site is both the public marketing site and (over time) the
product app.

## Repo structure

```
migrations/           Plain SQL migrations, applied in filename order by scripts/migrate.ts
scripts/
  db.ts               SQL engine for scripts: wraps src/db.ts sql() with a local-pg fetch shim (USE_LOCAL_POSTGRES=1)
  migrate.ts          Migration runner (bun run db:migrate)
  seed.ts             Idempotent demo seed (bun run db:seed)
src/
  db.ts               The one sql() handle (Neon serverless driver over DATABASE_URL) — server-only
  db/
    schema.ts         TypeScript row types for every table (types only, no runtime code)
    queries/          Server-only query layer (see rules below)
      shared.ts       assertServer(), listClause(), toNumber(), re-exports sql
      auth.ts         businesses, users, sessions, password-reset & email-verification tokens
      leads.ts        leads CRUD + pipeline aggregates
      conversations.ts conversations & messages (AI SMS threads)
      appointments.ts appointments CRUD + upcoming/status counts
      settings.ts     services, service_defaults, service areas, business hours
  routes/             TanStack Start file-based routes (client + server fns)
  components/         UI components (ui/ primitives, marketing/ landing sections)
  styles/app.css      Tailwind v4 entry; brand palette tokens (brand-*, aqua-*)
```

## Database commands

```bash
# Local validation without Neon: point DATABASE_URL at any Postgres you control
# and set the shim flag. The team's shared local instance:
export USE_LOCAL_POSTGRES=1 DATABASE_URL="postgres://missedcall:missedcall@127.0.0.1:5432/missedcall"

bun run db:migrate   # apply pending migrations/ *.sql (idempotent, one tx per migration)
bun run db:seed      # re-create the demo business + demo data (idempotent, CASCADE-wipes only the demo business)
```

Seed creates: 1 business (Rapid Rooter Plumbing), 3 users
(owner/manager/employee, argon2id hashes of `demo-password-1234`), 25 leads
across all statuses, 14 SMS conversations with messages, 10 appointments,
11 services (8 defaults + 3 custom), 9 service areas, 7 business-hours rows.
Demo credentials are placeholders for the auth phase — never real logins.

## Rules

### Business isolation (non-negotiable)

Every business-scoped table carries `business_id NOT NULL`. Every query-module
function that touches business data **takes `businessId` as a parameter and
filters on it** — the WHERE clause is the isolation boundary. Never derive
`businessId` from client input alone; resolve it from the authenticated session
in the caller (server fn / API route) and pass it down. The few deliberately
cross-business functions (login email lookup, session/token lookup by hash) are
marked in `src/db/queries/auth.ts` and used only by the auth layer.

### Server-side queries only

`src/db.ts sql()` and everything in `src/db/queries/` are **server-only**.
Call them exclusively from `createServerFn()` handlers or `src/routes/api/*`
route handlers — never from client components, loaders that run on the client,
or shared components. The query modules call `assertServer()` as a runtime
backstop. When returning rows to the client, coerce non-primitive columns
(`Date` objects) to strings first or React will refuse to render them.

### Schema & migrations

- Schema lives in SQL migrations, never ad-hoc `CREATE TABLE` in code.
- New migration = new `migrations/NNN_description.sql`; the runner applies
  pending files in order, each in its own transaction, recorded in
  `schema_migrations`.
- `src/db/schema.ts` row types must mirror the SQL. If a migration changes a
  table, update the matching type in the same PR.
- Every business-scoped table: `business_id NOT NULL REFERENCES businesses(id)
  ON DELETE CASCADE`, `created_at`/`updated_at` (trigger-maintained), indexes
  on `business_id` + dashboard filter/sort columns.

### Deliberate ON DELETE design

- Ownership chains CASCADE (deleting a business removes all of its data;
  messages cascade from conversations).
- History survives: appointments → lead/service and conversations → lead are
  `ON DELETE SET NULL`; services → service_defaults likewise.

### Conventions

- TypeScript strict; query results are cast through the `src/db/schema.ts`
  types (`as unknown as T[]` — the Neon driver is untyped at runtime).
- Dynamic column names in UPDATE helpers go through `snake_case` conversion and
  are interpolated via `sql.raw` / `$n` placeholders with values parameterized.
- Never commit `.env` or secrets; config comes from `process.env` (`DATABASE_URL`).
- `bun run build` must pass before pushing; the lead merges PRs squash-by-default.
