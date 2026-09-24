#!/usr/bin/env bun
/**
 * Pre-publish deploy verification (P4-I, owner req. 1/20).
 *
 * Verifies the REAL prod build against a REAL database before the lead
 * publishes: boots scripts/prod-serve.ts (the PR #26 prod repro pattern),
 * probes liveness + readiness, then runs the full E2E smoke suite against
 * the served build. Exit 0 = safe to publish.
 *
 * Usage:
 *   bun scripts/verify-deploy.ts [port]
 * Env:
 *   DATABASE_URL          required (Neon for staging/prod parity, or the
 *                         local-pg shim with USE_LOCAL_POSTGRES=1 in CI)
 *   USE_LOCAL_POSTGRES=1  route the Neon driver over plain pg (CI)
 *   PORT                  listen port (default 3311; passed as argv[2] wins)
 *   SKIP_SMOKE=1          probe only (smoke adds ~30-60s)
 *
 * NOTE: this is the pre-publish GATE. The platform publish flow itself
 * remains the deploy mechanism (working site → live site); this script
 * proves the artifact we are about to publish serves end-to-end.
 */
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 3311);
const BASE = "http://127.0.0.1:" + String(PORT);
let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? " — " + detail : ""));
}
async function waitForServer(url: string, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url + "/api/healthz");
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
if (!process.env.DATABASE_URL) {
  console.log("FAIL DATABASE_URL is required — verify-deploy tests against a real database.");
  process.exit(1);
}
// 1. Build artifact present?
const serverPath = new URL("../dist/server/server.js", import.meta.url).pathname;
const artifact = await Bun.file(serverPath).exists();
check("prod build artifact (dist/server/server.js)", artifact, artifact ? "" : "run `bun run build` first");
if (!artifact) process.exit(1);
// 2. Boot the prod build (prod-serve patches the DB driver config first).
const proc = Bun.spawn(["bun", "scripts/prod-serve.ts", String(PORT)], {
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
try {
  const up = await waitForServer(BASE);
  check("prod server reachable on " + BASE, up);
  if (!up) throw new Error("server never came up");
  // 3. Liveness.
  const live = await fetch(BASE + "/api/healthz");
  const liveBody = (await live.json().catch(() => ({}))) as { ok?: boolean; db?: boolean };
  check("GET /api/healthz → 200 ok:true db:true", live.status === 200 && liveBody.ok === true && liveBody.db === true, "status " + live.status);
  // 4. Readiness (deep probe: db + critical tables + error count).
  const ready = await fetch(BASE + "/api/healthz/ready");
  const readyBody = (await ready.json().catch(() => ({}))) as { ok?: boolean; tables?: Record<string, boolean>; recentErrors?: number | null };
  const missingTables = Object.entries(readyBody.tables ?? {}).filter(([, ok]) => !ok).map(([t]) => t);
  check(
    "GET /api/healthz/ready → 200, all critical tables present",
    ready.status === 200 && readyBody.ok === true && missingTables.length === 0,
    ready.status + (missingTables.length ? " missing: " + missingTables.join(",") : " recentErrors=" + String(readyBody.recentErrors)),
  );
  // 5. Full smoke suite (skippable for quick probe loops).
  if (process.env.SKIP_SMOKE === "1") {
    console.log("SKIP smoke (SKIP_SMOKE=1)");
  } else {
    const smoke = Bun.spawnSync(["bun", "scripts/test-smoke.ts", BASE], { stdout: "inherit", stderr: "inherit" });
    check("smoke suite (21 checks) against prod build", smoke.exitCode === 0, "exit " + String(smoke.exitCode));
  }
} catch (err) {
  failures++;
  console.log("FAIL " + String(err));
} finally {
  proc.kill();
}
console.log(failures === 0 ? "\nVERIFY-DEPLOY: ALL PASS — artifact is publishable." : "\nVERIFY-DEPLOY: " + failures + " FAILURE(S) — do NOT publish.");
process.exit(failures === 0 ? 0 : 1);
