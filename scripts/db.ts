/**
 * SQL execution engine for the repo's db scripts (`bun run db:migrate`, `bun run db:seed`).
 *
 * All statements run through the exact same `sql()` helper the app uses
 * (src/db.ts, the Neon serverless driver), pointed at DATABASE_URL — so scripts
 * are validated against the very code path production will use.
 *
 * Local validation without a Neon connection string: export
 * USE_LOCAL_POSTGRES=1 along with DATABASE_URL (e.g.
 * postgres://missedcall:missedcall@127.0.0.1:5432/missedcall) and this module
 * installs a dev-only fetch shim that translates the Neon driver's HTTP
 * protocol into direct `pg` connections. Production never sets USE_LOCAL_POSTGRES,
 * so the shim is dead code there.
 */
import { neonConfig, type NeonQueryFunction } from "@neondatabase/serverless";
import { sql } from "../src/db";

type Rows = Record<string, unknown>[];

async function installLocalFetchShim(): Promise<void> {
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
    // The driver sends either a batch ({queries: [...]}) or a single query
    // ({query, params}); the response shapes differ accordingly.
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
      const results: { fields: { name: string; dataTypeID: number }[]; rows: unknown[][] }[] =
        [];
      try {
        for (const stmt of statements) {
          const res = await client.query(stmt.query, stmt.params);
          results.push({
            fields: res.fields.map((f) => ({
              name: f.name,
              dataTypeID: f.dataTypeID,
            })),
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
        text: async () =>
          JSON.stringify(isBatch ? { results } : results[0]),
      };
    } finally {
      await client.end();
    }
  };
}

let ready: Promise<void> | null = null;

/** sql() from src/db.ts, with the local shim armed when USE_LOCAL_POSTGRES=1. */
export async function getSql(): Promise<NeonQueryFunction<false, false>> {
  if (process.env.USE_LOCAL_POSTGRES === "1" && !ready) {
    ready = installLocalFetchShim();
  }
  if (ready) await ready;
  return sql() as unknown as NeonQueryFunction<false, false>;
}

/** Run a parameterized statement and return its rows. */
export async function query(
  text: string,
  params: unknown[] = [],
): Promise<Rows> {
  const sqlFn = await getSql();
  return sqlFn.query(text, params) as unknown as Promise<Rows>;
}

/**
 * Run a multi-statement DDL script. The Neon HTTP endpoint only accepts one
 * statement per query, so split on semicolons that are not inside quotes,
 * comments, dollar-quoted strings, or function bodies.
 */
export async function runSqlFile(content: string): Promise<number> {
  const statements = splitSqlStatements(content);
  const sqlFn = await getSql();
  for (const stmt of statements) {
    await sqlFn.query(stmt);
  }
  return statements.length;
}

export function splitSqlStatements(content: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  const isDollarTagStart = (s: string, idx: number): string | null => {
    const m = /^\$[A-Za-z_]*\$/.exec(s.slice(idx));
    return m ? m[0] : null;
  };

  while (i < content.length) {
    const rest = content.slice(i);
    const two = content.slice(i, i + 2);

    if (inLineComment) {
      current += content[i];
      if (content[i] === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      current += two;
      if (two === "*/") inBlockComment = false;
      i += 2;
      continue;
    }
    if (dollarTag) {
      const end = rest.indexOf(dollarTag);
      if (end === -1) {
        current += rest;
        i = content.length;
      } else {
        current += rest.slice(0, end + dollarTag.length);
        i += end + dollarTag.length;
        dollarTag = null;
      }
      continue;
    }
    if (!inSingle && !inDouble && two === "--") {
      inLineComment = true;
      current += two;
      i += 2;
      continue;
    }
    if (!inSingle && !inDouble && two === "/*") {
      inBlockComment = true;
      current += two;
      i += 2;
      continue;
    }
    if (!inDouble && !inLineComment && !inBlockComment && content[i] === "'") {
      inSingle = !inSingle;
      current += content[i];
      i++;
      continue;
    }
    if (!inSingle && !inLineComment && !inBlockComment && content[i] === '"') {
      inDouble = !inDouble;
      current += content[i];
      i++;
      continue;
    }
    if (!inSingle && !inDouble && !inLineComment && !inBlockComment) {
      const tag = isDollarTagStart(content, i);
      if (tag) {
        dollarTag = tag;
        current += tag;
        i += tag.length;
        continue;
      }
    }
    if (
      content[i] === ";" &&
      !inSingle &&
      !inDouble &&
      !inLineComment &&
      !inBlockComment &&
      !dollarTag
    ) {
      const trimmed = current.trim();
      if (trimmed) out.push(trimmed);
      current = "";
      i++;
      continue;
    }
    current += content[i];
    i++;
  }
  const trimmed = current.trim();
  if (trimmed) out.push(trimmed);
  return out;
}
