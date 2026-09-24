/**
 * Prod-build test server (PR #26 pattern, repo-committed for CI in P3-H pt2):
 * serves the REAL prod build from dist/ so prod-only failures reproduce
 * locally and in CI without touching the platform dev server on :3000 or the
 * published site. CI (see .github/workflows/ci.yml) uses this to host the
 * built app against a Postgres service container before running
 * scripts/test-smoke.ts.
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun scripts/prod-serve.ts [port]
 * Env:
 *   PORT            listen port (default 3210)
 *   USE_LOCAL_POSTGRES=1  route the Neon driver through the local-pg shim
 *                   (scripts/local-pg-shim.ts) so a plain postgres:// URL to
 *                   a local/socket Postgres works. CI sets this; production
 *                   never does.
 *
 * The database driver config MUST be patched BEFORE the built handler is
 * imported: dist chunks externalize @neondatabase/serverless, so this process
 * and the bundle share the neonConfig singleton, and src/db.ts resolves
 * `neon(url)` lazily per query — installing the shim first makes every query
 * in the served build go over direct pg connections.
 *
 * Cache headers mirror serve.ts exactly (immutable /assets, no-store HTML and
 * RPC) so header behavior is testable against the prod build.
 */
import { installLocalPostgresShim } from "./local-pg-shim";

if (process.env.USE_LOCAL_POSTGRES === "1") {
  await installLocalPostgresShim();
}

// Non-literal path on purpose: dist/ is build output outside tsconfig, so a
// static import specifier would fail typecheck; resolving at runtime is fine.
const serverPath = "./dist/server/server.js";
const { default: handler } = (await import(serverPath)) as { default: unknown };
const PORT = Number(process.env.PORT ?? 3210);
const HOST = "127.0.0.1";
const CLIENT_DIR = new URL("./dist/client", import.meta.url).pathname;

function cacheHeadersFor(pathname: string): string {
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "no-store";
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname !== "/") {
      const file = Bun.file(CLIENT_DIR + pathname);
      if (await file.exists()) {
        return new Response(file, {
          headers: {
            "Content-Type": file.type || "application/octet-stream",
            "Cache-Control": cacheHeadersFor(pathname),
          },
        });
      }
    }
    const res = await (handler as { fetch: (r: Request) => Response | Promise<Response> }).fetch(req);
    const headers = new Headers(res.headers);
    const isHtml = (headers.get("content-type") ?? "").includes("text/html");
    headers.set("Cache-Control", isHtml ? "no-store, must-revalidate" : "no-store");
    return new Response(res.body, { status: res.status, headers });
  },
});
console.log(`prod-build test server on http://${HOST}:${String(PORT)}`);
