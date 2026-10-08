/**
 * salesAdmin.ts — the admin Sales tab's plain server module (the gated read
 * the route loader calls during SSR, plus the privileged write actions the
 * RPC wrappers delegate to). Mirrors the adminReads.ts / adminFns.ts split:
 * plain functions here (one source of truth), createServerFn wrappers in
 * salesAdminFns.ts for browser-initiated calls.
 *
 * EVERY function funnels through requirePlatformAdmin() first — the single
 * platform-admin authorization point (env gate + session + users
 * is_platform_admin, fresh from the DB). No client input participates in the
 * authorization decision; client input is only validated payload.
 *
 * Money is integer cents end-to-end. Comp is computed ONLY by the pure
 * engine (src/lib/salesComp.ts) from real rows; the payouts ledger is
 * append-only and never edits accrual; every owner action is audited via
 * appendAdminAudit.
 */
import "@tanstack/react-start/server-only";
import { adminErrorToResult, type AdminResult } from "./adminReads";
import { requirePlatformAdmin } from "./admin";
import { appendAdminAudit } from "~/db/queries/admin";
import {
  attributeBusiness,
  createSalesRep,
  createSalesRepPayout,
  getSalesRep,
  listAttributedAccounts,
  listRepPayouts,
  listSalesReps,
  listUnattributedBusinesses,
  setSalesRepActive,
  unattributeBusiness,
  updateSalesRep,
} from "~/db/queries/salesReps";
import {
  accrueAccount,
  computeTotalsBand,
  describeSchedule,
  summarizeRep,
  type SalesCompAccountInput,
  type SalesCompAccountView,
  type SalesCompPlan,
  type SalesCompSchedule,
  type SalesCompSubStatus,
  type SalesTotalsBand,
} from "~/lib/salesComp";
import { PLANS } from "~/lib/pricing";

// ---------------------------------------------------------------------------
// View shapes (client-safe — every Date is already an ISO string here)
// ---------------------------------------------------------------------------

export interface SalesTabRepView {
  id: string;
  name: string;
  contact: string | null;
  active: boolean;
  schedule: SalesCompSchedule;
  scheduleLabel: string;
  summary: {
    accountsBrought: number;
    activeAccounts: number;
    accruedThisMonthCents: number;
    lifetimeAccruedCents: number;
    paidToDateCents: number;
    owedNowCents: number;
    hasSchedule: boolean;
  };
}

export interface SalesTabAccountView extends SalesCompAccountView {
  repId: string;
  repName: string;
  repActive: boolean;
  attributedAt: string | null;
}

export interface SalesTabView {
  reps: SalesTabRepView[];
  accounts: SalesTabAccountView[];
  unattributed: { id: string; name: string; plan: string | null; subscriptionStatus: string | null }[];
  payouts: { id: string; repId: string; repName: string; amountCents: number; note: string | null; paidAt: string }[];
  totals: SalesTotalsBand;
  planPrices: { starterCents: number; proCents: number };
  generatedAt: string;
}

function scheduleOf(rep: {
  bountyStarterCents: number;
  bountyProCents: number;
  monthlyStarterCents: number;
  monthlyProCents: number;
  stepDownAfterMonths: number | null;
  stepDownMonthlyStarterCents: number | null;
  stepDownMonthlyProCents: number | null;
}): SalesCompSchedule {
  return {
    bountyStarterCents: rep.bountyStarterCents,
    bountyProCents: rep.bountyProCents,
    monthlyStarterCents: rep.monthlyStarterCents,
    monthlyProCents: rep.monthlyProCents,
    stepDownAfterMonths: rep.stepDownAfterMonths,
    stepDownMonthlyStarterCents: rep.stepDownMonthlyStarterCents,
    stepDownMonthlyProCents: rep.stepDownMonthlyProCents,
  };
}

// ---------------------------------------------------------------------------
// The gated page read
// ---------------------------------------------------------------------------

export async function salesTabPage(): Promise<AdminResult<SalesTabView>> {
  try {
    await requirePlatformAdmin();
    const asOfIso = new Date().toISOString();
    const [reps, attributedRows, unattributed, payouts] = await Promise.all([
      listSalesReps(),
      listAttributedAccounts(),
      listUnattributedBusinesses(),
      listRepPayouts(),
    ]);
    const repById = new Map(reps.map((r) => [r.id, r]));
    // Engine inputs from REAL rows (see salesComp.ts derivation notes).
    const byRep = new Map<string, SalesCompAccountInput[]>();
    const accounts: SalesTabAccountView[] = [];
    for (const row of attributedRows) {
      const rep = repById.get(row.salesRepId);
      if (!rep) continue; // attribution to a deleted rep cannot exist (FK SET NULL)
      const input: SalesCompAccountInput = {
        businessId: row.business.id,
        businessName: row.business.name,
        plan: (row.business.plan ?? null) as SalesCompPlan | null,
        subscriptionStatus: (row.business.subscriptionStatus ?? null) as SalesCompSubStatus | null,
        firstPaidAt: row.firstPaidAt ? row.firstPaidAt.toISOString() : null,
        canceledAt: row.canceledAt ? row.canceledAt.toISOString() : null,
        ledgerPlan: (row.ledgerPlan ?? null) as SalesCompPlan | null,
        attributedAt: row.attributedAt ? row.attributedAt.toISOString() : null,
      };
      let repAccounts = byRep.get(row.salesRepId);
      if (!repAccounts) {
        repAccounts = [];
        byRep.set(row.salesRepId, repAccounts);
      }
      repAccounts.push(input);
      accounts.push({
        ...accrueAccount(scheduleOf(rep), input, asOfIso),
        repId: rep.id,
        repName: rep.name,
        repActive: rep.active,
        attributedAt: input.attributedAt,
      });
    }
    const repViews: SalesTabRepView[] = reps.map((rep) => {
      const schedule = scheduleOf(rep);
      const repPayouts = payouts
        .filter((p) => p.repId === rep.id)
        .map((p) => ({ amountCents: p.amountCents, note: p.note, paidAt: p.paidAt.toISOString() }));
      return {
        id: rep.id,
        name: rep.name,
        contact: rep.contact,
        active: rep.active,
        schedule,
        scheduleLabel: describeSchedule(schedule),
        summary: summarizeRep(schedule, byRep.get(rep.id) ?? [], repPayouts, asOfIso),
      };
    });
    const totals = computeTotalsBand(accounts, {
      starter: PLANS.find((p) => p.id === "starter")?.priceCents ?? 0,
      pro: PLANS.find((p) => p.id === "pro")?.priceCents ?? 0,
    });
    return {
      ok: true,
      data: {
        reps: repViews,
        accounts,
        unattributed,
        payouts: payouts.map((p) => ({
          id: p.id,
          repId: p.repId,
          repName: p.repName,
          amountCents: p.amountCents,
          note: p.note,
          paidAt: p.paidAt.toISOString(),
        })),
        totals,
        planPrices: {
          starterCents: PLANS.find((p) => p.id === "starter")?.priceCents ?? 0,
          proCents: PLANS.find((p) => p.id === "pro")?.priceCents ?? 0,
        },
        generatedAt: asOfIso,
      },
    };
  } catch (e) {
    return adminErrorToResult(e);
  }
}

// ---------------------------------------------------------------------------
// Validated write actions (all audited)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f-]{36}$/i;
/** Sanity bound: $10,000 per field — the deal never needs more; typos stay visible. */
const MAX_CENTS = 1_000_000;

function isCents(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_CENTS;
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, max) : null;
}

export interface SalesRepPayload {
  name?: unknown;
  contact?: unknown;
  bountyStarterCents?: unknown;
  bountyProCents?: unknown;
  monthlyStarterCents?: unknown;
  monthlyProCents?: unknown;
  stepDownAfterMonths?: unknown;
  stepDownMonthlyStarterCents?: unknown;
  stepDownMonthlyProCents?: unknown;
}

function normalizeRepInput(d: SalesRepPayload): { ok: true; value: Parameters<typeof createSalesRep>[0] } | { ok: false; error: string } {
  const name = cleanText(d.name, 120);
  if (!name) return { ok: false, error: "Rep name is required." };
  const contact = cleanText(d.contact, 200);
  const bountyStarterCents = Number(d.bountyStarterCents ?? 0);
  const bountyProCents = Number(d.bountyProCents ?? 0);
  const monthlyStarterCents = Number(d.monthlyStarterCents ?? 0);
  const monthlyProCents = Number(d.monthlyProCents ?? 0);
  if (![bountyStarterCents, bountyProCents, monthlyStarterCents, monthlyProCents].every(isCents)) {
    return { ok: false, error: "Comp amounts must be non-negative dollar amounts." };
  }
  const hasStep = d.stepDownAfterMonths != null && d.stepDownAfterMonths !== "";
  let stepDownAfterMonths: number | null = null;
  let stepDownMonthlyStarterCents: number | null = null;
  let stepDownMonthlyProCents: number | null = null;
  if (hasStep) {
    const n = Number(d.stepDownAfterMonths);
    if (!Number.isInteger(n) || n < 1 || n > 600) {
      return { ok: false, error: "Step-down month threshold must be a whole number of months (1–600)." };
    }
    stepDownAfterMonths = n;
    stepDownMonthlyStarterCents = Number(d.stepDownMonthlyStarterCents ?? NaN);
    stepDownMonthlyProCents = Number(d.stepDownMonthlyProCents ?? NaN);
    if (!isCents(stepDownMonthlyStarterCents) || !isCents(stepDownMonthlyProCents)) {
      return { ok: false, error: "Step-down rates are required (non-negative dollar amounts) when a step-down is set." };
    }
  }
  return {
    ok: true,
    value: {
      name,
      contact,
      active: true,
      bountyStarterCents,
      bountyProCents,
      monthlyStarterCents,
      monthlyProCents,
      stepDownAfterMonths,
      stepDownMonthlyStarterCents,
      stepDownMonthlyProCents,
    },
  };
}

export async function salesAddRep(d: SalesRepPayload): Promise<AdminResult<{ repId: string }>> {
  try {
    const admin = await requirePlatformAdmin();
    const input = normalizeRepInput(d);
    if (!input.ok) return { ok: false, status: 400, error: input.error };
    const rep = await createSalesRep(input.value);
    await appendAdminAudit({
      adminUserId: admin.user.id,
      action: "sales_rep_created",
      detail: { repId: rep.id, name: rep.name, scheduleLabel: describeSchedule(scheduleOf(rep)) },
    });
    return { ok: true, data: { repId: rep.id } };
  } catch (e) {
    return adminErrorToResult(e);
  }
}

export async function salesUpdateRep(
  repId: string,
  d: SalesRepPayload,
): Promise<AdminResult<{ ok: true }>> {
  try {
    const admin = await requirePlatformAdmin();
    if (!UUID_RE.test(repId)) return { ok: false, status: 400, error: "Unknown rep." };
    const input = normalizeRepInput(d);
    if (!input.ok) return { ok: false, status: 400, error: input.error };
    const existing = await getSalesRep(repId);
    if (!existing) return { ok: false, status: 404, error: "Unknown rep." };
    const updated = await updateSalesRep(repId, { ...input.value, active: existing.active });
    if (!updated) return { ok: false, status: 404, error: "Unknown rep." };
    await appendAdminAudit({
      adminUserId: admin.user.id,
      action: "sales_rep_updated",
      detail: { repId, name: updated.name, scheduleLabel: describeSchedule(scheduleOf(updated)) },
    });
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return adminErrorToResult(e);
  }
}

export async function salesSetRepActive(repId: string, active: boolean): Promise<AdminResult<{ ok: true }>> {
  try {
    const admin = await requirePlatformAdmin();
    if (!UUID_RE.test(repId)) return { ok: false, status: 400, error: "Unknown rep." };
    const updated = await setSalesRepActive(repId, active === true);
    if (!updated) return { ok: false, status: 404, error: "Unknown rep." };
    await appendAdminAudit({
      adminUserId: admin.user.id,
      action: "sales_rep_active_set",
      detail: { repId, name: updated.name, active: updated.active },
    });
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return adminErrorToResult(e);
  }
}

export async function salesAttribute(businessId: string, repId: string): Promise<AdminResult<{ ok: true }>> {
  try {
    const admin = await requirePlatformAdmin();
    if (!UUID_RE.test(businessId) || !UUID_RE.test(repId)) {
      return { ok: false, status: 400, error: "Pick a business and a rep." };
    }
    const rep = await getSalesRep(repId);
    if (!rep) return { ok: false, status: 404, error: "Unknown rep." };
    if (!rep.active) return { ok: false, status: 400, error: "That rep is deactivated — reactivate before attributing." };
    const done = await attributeBusiness(businessId, repId);
    if (!done) return { ok: false, status: 404, error: "Unknown business." };
    await appendAdminAudit({
      adminUserId: admin.user.id,
      action: "sales_attribution_set",
      targetBusinessId: businessId,
      detail: { repId, repName: rep.name },
    });
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return adminErrorToResult(e);
  }
}

export async function salesUnattribute(businessId: string): Promise<AdminResult<{ ok: true }>> {
  try {
    const admin = await requirePlatformAdmin();
    if (!UUID_RE.test(businessId)) return { ok: false, status: 400, error: "Unknown business." };
    const done = await unattributeBusiness(businessId);
    if (!done) return { ok: false, status: 404, error: "Unknown business." };
    await appendAdminAudit({
      adminUserId: admin.user.id,
      action: "sales_attribution_cleared",
      targetBusinessId: businessId,
      detail: {},
    });
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return adminErrorToResult(e);
  }
}

export async function salesRecordPayout(
  repId: string,
  d: { amountCents?: unknown; note?: unknown },
): Promise<AdminResult<{ ok: true }>> {
  try {
    const admin = await requirePlatformAdmin();
    if (!UUID_RE.test(repId)) return { ok: false, status: 400, error: "Unknown rep." };
    const amountCents = Number(d.amountCents);
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 100_000_000) {
      return { ok: false, status: 400, error: "Payout amount must be a positive dollar amount." };
    }
    const note = cleanText(d.note, 300);
    const rep = await getSalesRep(repId);
    if (!rep) return { ok: false, status: 404, error: "Unknown rep." };
    await createSalesRepPayout({ repId, amountCents, note });
    await appendAdminAudit({
      adminUserId: admin.user.id,
      action: "sales_payout_recorded",
      detail: { repId, repName: rep.name, amountCents, note },
    });
    return { ok: true, data: { ok: true } };
  } catch (e) {
    return adminErrorToResult(e);
  }
}
