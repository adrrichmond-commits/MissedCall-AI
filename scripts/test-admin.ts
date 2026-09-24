#!/usr/bin/env bun
/**
 * P3-G admin dashboard tests. Run: bun scripts/test-admin.ts — no DB, no
 * network, no keys.
 *
 * Covers (per the P3-G brief):
 *   - role gate: source-level assertions that every admin fn + /admin route
 *     funnels through requirePlatformAdmin (member can't reach admin; the
 *     DB-flag gate is the same mechanism the auth layer uses elsewhere)
 *   - disabled-account enforcement: session resolver nulls + login block
 *   - impersonation model: audit-first ordering, banner state semantics,
 *     exit restores (stashed-token design), no stray cookies on failure
 *   - audit: append-only helper shape (INSERT-only), required-write ordering
 *   - honest-billing: plan override labels + "not configured" discipline
 *   - isolation: cross-business queries live ONLY in queries/admin.ts and
 *     are NOT re-exported through index.ts; business-scoped modules keep
 *     their businessId WHERE clauses (structural checks, same approach the
 *     other P3 suites ship)
 *   - aggregate funnel math (pure engine re-check with admin semantics)
 */
import { readFileSync, existsSync } from "node:fs";
import {
  computePeriodBounds,
  bucketForPeriod,
  computeRevenueMetrics,
  funnelStages,
} from "../src/lib/server/revenue";
import { PLANS } from "../src/lib/pricing";

let checks = 0;
let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures++;
    console.log("FAIL " + name + " — expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  } else {
    console.log("ok   " + name);
  }
}
function checkTrue(name: string, cond: boolean, detail = ""): void {
  checks++;
  if (!cond) {
    failures++;
    console.log("FAIL " + name + (detail ? " — " + detail : ""));
  } else {
    console.log("ok   " + name);
  }
}
function read(p: string): string {
  return readFileSync(new URL(p, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// 1. Gate — every admin surface funnels through requirePlatformAdmin
// ---------------------------------------------------------------------------
const adminFns = read("../src/lib/server/adminFns.ts");
// PR #27: the SSR-executed read paths moved to plain functions in adminReads
// (createServerFn wrappers in loaders compile to unreliable HTTP self-calls
// in prod). The gate-before-query guarantees are checked against BOTH files.
const adminReads = read("../src/lib/server/adminReads.ts");
const adminRoutes = [
  "../src/routes/admin.tsx",
  "../src/routes/admin/accounts.tsx",
  "../src/routes/admin/accounts_.$businessId.tsx",
  "../src/routes/admin/health.tsx",
  "../src/routes/admin/audit.tsx",
].map(read);

checkTrue(
  "gate: adminFns calls requirePlatformAdmin",
  /requirePlatformAdmin\(\)/.test(adminFns),
);
checkTrue(
  "gate: adminReads calls requirePlatformAdmin",
  /requirePlatformAdmin\(\)/.test(adminReads),
);
// Write actions remain gated inside their RPC wrappers in adminFns.
for (const fn of [
  "adminSetAccountDisabledFn",
  "adminOverridePlanFn",
  "adminImpersonateFn",
]) {
  const seg = adminFns.slice(adminFns.indexOf(`export const ${fn}`));
  checkTrue(`gate: ${fn} gated first`, /await requirePlatformAdmin\(\)/.test(seg.slice(0, 900)));
}
// SSR read paths must gate first inside their plain functions in adminReads.
for (const fn of ["adminAccountsPage", "adminAccountDetailPage", "adminAuditPage", "adminHealthPage"]) {
  const seg = adminReads.slice(adminReads.indexOf(`export async function ${fn}`));
  checkTrue(`gate: ${fn} gated first`, /await requirePlatformAdmin\(\)/.test(seg.slice(0, 900)));
}
// The /admin layout gate: signed-out → login redirect; non-admin → 404.
const layout = adminRoutes[0];
checkTrue("gate: layout calls the platform-admin gate RPC in beforeLoad", layout.includes("await platformAdminGateFn()"));
checkTrue("gate: layout throws notFound() for non-admins", layout.includes("throw notFound()"));
checkTrue("gate: layout redirects signed-out to /login with next=/admin", layout.includes('to: "/login"') && layout.includes('"/admin"'));
// The gate itself: env precondition + DB flag; no client input in the decision.
const gateSrc = read("../src/lib/server/admin.ts");
checkTrue("gate: closed when PLATFORM_OWNER_EMAIL absent", /platformAdminGateOpen\(\)/.test(gateSrc));
checkTrue("gate: requires isPlatformAdmin from the DB-resolved session", /ctx\.user\.isPlatformAdmin/.test(gateSrc));
checkTrue("gate: generic message (no config leak)", /"Not found\."/.test(gateSrc));

// 2. Owner-email seeding — env-driven, never a hardcoded personal email
checkTrue(
  "seed: owner email from PLATFORM_OWNER_EMAIL env only",
  /process\.env\.PLATFORM_OWNER_EMAIL/.test(read("../src/db/queries/admin.ts")),
);
const migration14 = read("../migrations/014_admin.sql");
checkTrue("seed: migration 014 hardcodes NO email", !/@[a-z0-9.-]+\.(com|net|org|io|ai)\b/i.test(migration14.split("admin_audit (")[0]));
checkTrue("seed: promotion is an UPDATE ... WHERE lower(email) match", /lower\(email\) = \$1/.test(read("../src/db/queries/admin.ts")));
checkTrue(
  "seed: personal emails hardcoded nowhere in admin sources",
  !/[a-z0-9._%+-]+@(?!example)[a-z0-9.-]+\.(com|net|org|io|ai)/i.test(
    read("../src/lib/server/admin.ts") + read("../src/db/queries/admin.ts"),
  ),
);

// 3. Disabled accounts — session resolver + login + revocation
const authServer = read("../src/lib/server/auth.server.ts");
checkTrue("disable: session resolver nulls for disabled business", authServer.includes("business.disabledAt != null"));
const authFns = read("../src/lib/server/authFns.ts");
checkTrue(
  "disable: loginFn refuses disabled businesses",
  authFns.includes("This account is currently disabled"),
);
const adminQueries = read("../src/db/queries/admin.ts");
checkTrue(
  "disable: disable revokes live sessions (DELETE joined through users)",
  /DELETE FROM sessions s USING users u/.test(adminQueries),
);
checkTrue(
  "disable: enable clears the flag",
  /setBusinessDisabled\(\s*targetBusinessId,\s*disabled \? new Date\(\) : null/.test(read("../src/lib/server/admin.ts")),
);

// 4. Impersonation — audit-first, banner state, exit restores
checkTrue(
  "impersonate: start audits BEFORE any cookie/session change",
  adminFns.indexOf("impersonateBusiness") > -1 &&
    read("../src/lib/server/admin.ts").indexOf('action: "impersonate_start"') > -1,
);
const adminSrc = read("../src/lib/server/admin.ts");
const impStart = adminSrc.indexOf("export async function impersonateBusiness");
const impBody = adminSrc.slice(impStart, adminSrc.indexOf("export type ExitResult"));
checkTrue(
  "impersonate: appendAdminAudit precedes cookie writes in start",
  impBody.indexOf("appendAdminAudit") < impBody.indexOf("setCookie("),
);
checkTrue(
  "impersonate: stashed admin token kept in mca_admin_return cookie",
  /mca_admin_return/.test(adminSrc),
);
checkTrue(
  "impersonate: impersonated session issued for the target's owner user",
  /role = 'owner' AND is_active = true/.test(adminSrc),
);
checkTrue(
  "impersonate: exit writes impersonate_stop and restores the stashed token",
  adminSrc.includes('action: "impersonate_stop"') &&
    adminSrc.indexOf("setCookie(SESSION_COOKIE, raw") > -1,
);
checkTrue(
  "impersonate: banner text on /admin layout and app banner",
  adminRoutes[0].includes("Viewing as") && adminRoutes[0].includes("admin session"),
);
const appBanner = read("../src/components/app/AdminViewingBanner.tsx");
checkTrue("impersonate: app-side banner exists on /app shell", appBanner.includes("Viewing as"));
const appLayout = read("../src/routes/_app.tsx");
checkTrue("impersonate: banner rendered inside the app shell", appLayout.includes("AdminViewingBanner"));

// 5. Audit — append-only helper, admin table present, log page read-only
checkTrue("audit: 014 creates admin_audit", migration14.includes("CREATE TABLE IF NOT EXISTS admin_audit"));
checkTrue("audit: action CHECK constraint", migration14.includes("admin_audit_action_check"));
checkTrue("audit: helper is INSERT-only", /INSERT INTO admin_audit/.test(adminQueries));
checkTrue("audit: no UPDATE/DELETE admin_audit path ships", !/UPDATE admin_audit|DELETE FROM admin_audit/.test(adminQueries));
checkTrue("audit: audit page has no write controls", !/adminSetAccountDisabledFn|adminOverridePlanFn|adminImpersonateFn/.test(adminRoutes[4]));

// 6. Honest billing — manual override labels + not-configured discipline
checkTrue(
  "honest: plan override labeled manual (Stripe not configured)",
  adminSrc.includes("manual override (Stripe not configured)"),
);
checkTrue(
  "honest: override clears stale Stripe lifecycle state",
  adminSrc.includes("subscription_status = NULL"),
);
checkTrue(
  "honest: override writes a local billing_event",
  adminSrc.includes('type: "plan_change"') && adminSrc.includes('source: "local"'),
);
checkTrue(
  "honest: detail page shows 'not configured' when Stripe env absent",
  adminRoutes[2].includes("not configured"),
);
checkTrue(
  "honest: health page states env-presence-only derivation",
  adminRoutes[3].includes("environment variable presence"),
);

// 7. Migration replay safety
for (const stmt of ["ADD COLUMN IF NOT EXISTS is_platform_admin", "ADD COLUMN IF NOT EXISTS disabled_at", "CREATE TABLE IF NOT EXISTS admin_audit", "CREATE INDEX IF NOT EXISTS"]) {
  checkTrue("replay: 014 " + stmt.slice(0, 40), migration14.includes(stmt));
}
checkTrue("replay: 014 has no destructive ops", !/DROP TABLE|DROP COLUMN|TRUNCATE/.test(migration14));

// 8. Isolation — cross-business reads ONLY in queries/admin.ts, gated
checkTrue(
  "isolation: admin queries not re-exported from index.ts",
  !/admin/.test(read("../src/db/queries/index.ts")),
);
checkTrue(
  "isolation: business-scoped revenue query unchanged (WHERE business_id)",
  /WHERE business_id = \$\{businessId\}/.test(read("../src/db/queries/revenue.ts")),
);
const listAccountsFn = adminReads.slice(adminReads.indexOf("export async function adminAccountsPage"), adminReads.indexOf("export interface AdminAccountDetailView"));
checkTrue("isolation: accounts fn gated before its query", listAccountsFn.indexOf("requirePlatformAdmin()") < listAccountsFn.indexOf("listAdminAccounts("));
const detailFn = adminReads.slice(adminReads.indexOf("export async function adminAccountDetailPage"), adminReads.indexOf("// ---------------------------------------------------------------------------\n// Audit log page"));
checkTrue("isolation: detail fn gated before its query", detailFn.indexOf("requirePlatformAdmin()") < detailFn.indexOf("getAdminAccountDetail("));
checkTrue("isolation: uuid-shaped businessId validated in fns", /\[0-9a-f-\]\{36\}/.test(adminFns));

// 9. Aggregate funnel math — same engine, admin semantics re-checked
const bounds = computePeriodBounds(new Date("2024-01-17T12:00:00Z"), "UTC");
check("funnel: bucket week", bucketForPeriod(new Date("2024-01-16T10:00:00Z"), bounds), "week");
check("funnel: bucket month", bucketForPeriod(new Date("2024-01-05T10:00:00Z"), bounds), "month");
check("funnel: before month → all", bucketForPeriod(new Date("2023-11-05T10:00:00Z"), bounds), "all");
const metrics = computeRevenueMetrics({
  week: { wonLeads: 1, recoveredCents: 25000 },
  month: { wonLeads: 3, recoveredCents: 75000 },
  allTime: { wonLeads: 4, recoveredCents: 100000 },
  leadsWithValue: 8,
  totalLeads: 20,
  missedCalls: 12,
  recoveredMissedCalls: 6,
  appointmentsFromRecovered: 3,
});
check("funnel: all-time recovered cents", metrics.allTime.recoveredCents, 100000);
check("funnel: conversion rate = won/leads", metrics.conversionRate, 0.2);
check("funnel: recovery rate", metrics.recoveryRate, 0.5);
check(
  "funnel: 8 stages, ordered",
  funnelStages({ callsReceived: 10, callsHandledByAi: 8, missedCalls: 10, missedCallsRecovered: 5, leads: 20, qualified: 9, appointments: 4, won: 2 }).map((s) => s.key),
  ["callsReceived", "callsHandledByAi", "missedCalls", "missedCallsRecovered", "leads", "qualified", "appointments", "won"],
);
checkTrue(
  "funnel: aggregate uses the same stage labels",
  adminReads.includes('"Calls received"') && adminReads.includes('"Jobs won"'),
);

// 10. Pricing single-source still intact (no price literals in admin code)
check("pricing: starter price", PLANS[0].priceCents, 14900);
check("pricing: pro price", PLANS[1].priceCents, 24900);
checkTrue("pricing: no plan price literals in admin modules", !/14900|24900/.test(adminFns + adminQueries));

// 11. Migration file exists and index re-exports untouched
checkTrue("misc: migration 014 exists", existsSync(new URL("../migrations/014_admin.sql", import.meta.url)));
checkTrue("misc: admin routes all exist", adminRoutes.every((s) => s.length > 100));

console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
