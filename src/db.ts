import { neon } from "@neondatabase/serverless";
/**
 * Server-only handle to the team's database (Neon serverless Postgres over HTTP).
 * The connection string comes from `DATABASE_URL`, which the owner connects via
 * the database card and which is injected into the sandbox and passed to the live
 * host on publish. Resolved lazily (per call, not at module load) so the site
 * still builds and serves before a database is connected — the error only
 * surfaces if a query actually runs without `DATABASE_URL`.
 *
 * ROW SHAPE: Postgres column names are snake_case (`business_id`), but every
 * TS interface in `src/db/schema.ts` is camelCase (`businessId`). To keep the
 * wire shape identical to the typed interfaces, every row returned by this
 * client has its top-level keys converted snake_case → camelCase (and nested
 * jsonb objects come back exactly as the query built them — see
 * `getSessionByTokenHash`, which builds `user_data` with jsonb_build_object).
 * Queries that alias columns explicitly are unaffected: a camelCase alias
 * contains no underscore, so the conversion is a no-op for it.
 *
 * Use it only inside a `createServerFn()` handler or an `src/routes/api/*` route
 * (never client code):
 *
 *   const getPosts = createServerFn().handler(async () => {
 *     const rows = await sql()`select id, title, created_at from posts`;
 *     // rows are camelCase: r.id, r.title, r.createdAt
 *     // Coerce non-primitive columns (timestamps are JS Dates) to strings before
 *     // returning to the client, or React will refuse to render them:
 *     return rows.map((r) => ({ ...r, createdAt: String(r.createdAt) }));
 *   });
 */

/** snake_case → camelCase (only lowercase letters/digits follow an underscore). */
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Convert a single row's keys; non-plain values pass through untouched. */
function mapRow(row: unknown): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    out[snakeToCamel(key)] = value;
  }
  return out;
}

/** Map every row of a result array. */
function mapRows(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map(mapRow);
}

interface QueryableSql {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<Record<string, unknown>[]>;
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

export const sql = (): QueryableSql => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — connect a database (via the database card) before running queries."
    );
  }
  const raw = neon(url);

  const wrapped = ((strings: TemplateStringsArray, ...params: unknown[]) =>
    (raw(strings, ...params) as unknown as Promise<Record<string, unknown>[]>).then(
      mapRows
    )) as unknown as QueryableSql;

  wrapped.query = async (text: string, params?: unknown[]) => {
    const res = (await raw.query(text, params ?? [])) as unknown as Record<string, unknown>[];
    return mapRows(res) as Record<string, unknown>[];
  };

  return wrapped;
};
