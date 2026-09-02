/**
 * DEV-ONLY Postgres shim for running the app against a local Postgres.
 *
 * Production/Neon: this module is never imported — vite.config only loads it
 * when USE_LOCAL_POSTGRES=1, which the live host never sets. The owner's real
 * DATABASE_URL is a Neon connection string and goes over HTTP exactly as
 * before.
 *
 * With USE_LOCAL_POSTGRES=1, DATABASE_URL may be a plain `postgres://` URL and
 * the Neon HTTP driver cannot reach a local socket Postgres over HTTP. This
 * module rewrites neonConfig to route the Neon driver's HTTP protocol into
 * direct `pg` connections — the identical trick scripts/db.ts uses for
 * migrate/seed.
 */
import { neonConfig } from "@neondatabase/serverless";

type Rows = Record<string, unknown>[];

export async function installLocalPostgresShim(): Promise<void> {
  const pg = await import("pg");
  neonConfig.fetchEndpoint = () => "http://localhost/local-sql-proxy";
  neonConfig.fetchFunction = async (
    _url: string,
    options: { body?: string | null } & Record<string, unknown>,
  ) => {
    const body = JSON.parse(options.body ?? "{}") as {
      query?: string;
      params?: unknown[];
      queries?: { query: string; params: unknown[] }[];
    };
    const isBatch = Array.isArray(body.queries);
    const statements = body.queries ?? [
      { query: body.query ?? "", params: body.params ?? [] },
    ];
    const connectionString = (options.headers as Record<string, string>)[
      "Neon-Connection-String"
    ];
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      // One implicit transaction per batch mirrors the Neon HTTP API.
      await client.query("BEGIN");
      const results: { fields: { name: string; dataTypeID: number }[]; rows: unknown[][] }[] = [];
      try {
        for (const stmt of statements) {
          const res = await client.query(stmt.query, stmt.params);
          results.push({
            fields: res.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
            rows: res.rows.map((row) =>
              (res.fields.map((f) => f.name) as string[]).map(
                (name) => (row as Record<string, unknown>)[name],
              ),
            ),
          });
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      return {
        ok: true,
        status: 200,
        json: async () => (isBatch ? { results } : results[0]),
        text: async () => JSON.stringify(isBatch ? { results } : results[0]),
      };
    } finally {
      await client.end();
    }
  };
}

export type { Rows };
