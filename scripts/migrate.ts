#!/usr/bin/env bun
/**
 * Migration runner — `bun run db:migrate`.
 *
 * Applies pending .sql migrations from migrations/ in filename order, each in
 * its own transaction, recorded in schema_migrations. Idempotent: already
 * applied migrations are skipped, re-running does nothing.
 *
 * Requires DATABASE_URL. For local validation without Neon, also set
 * USE_LOCAL_POSTGRES=1 (see scripts/db.ts).
 */
import { join } from "node:path";
import { getSql, query, runSqlFile } from "./db";

type Applied = { name: string; applied_at: string };

async function ensureMigrationsTable(): Promise<void> {
  // Statement-by-statement (not runSqlFile) so each statement is atomic on its
  // own; the runner can safely retry a partially-created table state.
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(): Promise<string[]> {
  const dir = join(import.meta.dir, "..", "migrations");
  const entries = Array.from(new Bun.Glob("*.sql").scanSync({ cwd: dir }));
  return entries.sort();
}

async function getApplied(): Promise<Map<string, Applied>> {
  const rows = (await query(
    "SELECT name, applied_at::text AS applied_at FROM schema_migrations",
  )) as unknown as Applied[];
  return new Map(rows.map((r) => [r.name, r]));
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set — point it at your Neon database (or a local Postgres with USE_LOCAL_POSTGRES=1).",
    );
    process.exit(1);
  }

  await ensureMigrationsTable();
  const applied = await getApplied();
  const files = await listMigrationFiles();

  if (files.length === 0) {
    console.log("No migration files found in migrations/.");
    return;
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log(
      `Migrations up to date (${applied.size} applied${
        files.length !== applied.size
          ? `, ${files.length - applied.size} not yet tracked`
          : ""
      }).`,
    );
    return;
  }

  for (const file of pending) {
    const path = join(import.meta.dir, "..", "migrations", file);
    const content = await Bun.file(path).text();
    const startedAt = Date.now();
    try {
      const statementCount = await runSqlFile(content);
      await query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      console.log(
        `  applied ${file} (${statementCount} statements, ${
          Date.now() - startedAt
        }ms)`,
      );
    } catch (err) {
      console.error(`FAILED ${file}: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }
  console.log(`Done. ${pending.length} migration(s) applied.`);
}

main();
