/**
 * Shared helpers for the server-only query modules in src/db/queries/.
 */
import { sql } from "../../db";

/**
 * Throw a clear error if a query module is somehow imported into client code.
 * The real enforcement is that these modules are only imported from
 * `createServerFn()` handlers or `src/routes/api/*`; this guard is a backstop
 * that fails loudly at request time instead of silently shipping `DATABASE_URL`
 * access to the browser.
 */
export function assertServer(): void {
  if (typeof window !== "undefined") {
    throw new Error(
      "src/db/queries/* are server-only. Call them from createServerFn() handlers or API routes, never from client components.",
    );
  }
}

/** Every business-scoped query takes the caller's businessId and filters on it. */
export type BusinessId = string;

/** Common find-options shape used by the list functions. */
export interface ListOptions {
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}

export function listClause(opts?: ListOptions): { limit: number; offset: number; order: "asc" | "desc" } {
  return {
    limit: Math.min(Math.max(opts?.limit ?? 100, 1), 500),
    offset: Math.max(opts?.offset ?? 0, 0),
    order: opts?.order ?? "desc",
    };
}

/** Coerce a Postgres count(*) (bigint/int as string) into a JS number. */
export function toNumber(value: unknown): number {
  return Number(value ?? 0);
}

export { sql };
