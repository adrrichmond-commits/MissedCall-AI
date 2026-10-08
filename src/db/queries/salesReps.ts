/**
 * salesReps.ts — Admin Sales tab reads/writes (migration 024).
 *
 * DELIBERATELY CROSS-BUSINESS (like admin.ts / opsDigest.ts): the sales tab
 * is a platform-owner surface reachable ONLY through the admin gate
 * (src/lib/server/admin.ts requirePlatformAdmin, which verifies the session
 * user's is_platform_admin flag from the DB — never from client input).
 * Business-scoped modules in src/db/queries/ keep their businessId WHERE
 * clause untouched; nothing here is re-exported through index.ts.
 *
 * Every function still takes explicit ids/params and never invents scope.
 * All money is integer cents. Nothing here derives comp — that lives in the
 * pure engine src/lib/salesComp.ts; this module only resolves the REAL data
 * the engine consumes (see its derivation notes):
 *   - firstPaidAt: earliest billing_events row with event_type
 *     'checkout_completed' AND payload->>'status' = 'active' (the webhook's
 *     activation stamp — the first successful payment, not the trial).
 *   - canceledAt: latest 'subscription_canceled' event (the accrual stop).
 *   - ledgerPlan: plan stamped on the account's latest billing event that
 *     carries one — the fallback when businesses.plan reads 'trial'
 *     (cancellation resets it) so a canceled account's plan stays known.
 */
import type { Business, SalesRep, SalesRepPayout } from "../schema";
import { assertServer, sql, toNumber } from "./shared";

// ---------------------------------------------------------------------------
// Reps
// ---------------------------------------------------------------------------

export interface SalesRepInput {
  name: string;
  contact: string | null;
  active: boolean;
  bountyStarterCents: number;
  bountyProCents: number;
  monthlyStarterCents: number;
  monthlyProCents: number;
  stepDownAfterMonths: number | null;
  stepDownMonthlyStarterCents: number | null;
  stepDownMonthlyProCents: number | null;
}

function rowToRep(r: Record<string, unknown>): SalesRep {
  return {
    id: String(r.id),
    name: String(r.name),
    contact: r.contact == null ? null : String(r.contact),
    active: r.active === true,
    bountyStarterCents: toNumber(r.bountyStarterCents),
    bountyProCents: toNumber(r.bountyProCents),
    monthlyStarterCents: toNumber(r.monthlyStarterCents),
    monthlyProCents: toNumber(r.monthlyProCents),
    stepDownAfterMonths: r.stepDownAfterMonths == null ? null : toNumber(r.stepDownAfterMonths),
    stepDownMonthlyStarterCents:
      r.stepDownMonthlyStarterCents == null ? null : toNumber(r.stepDownMonthlyStarterCents),
    stepDownMonthlyProCents:
      r.stepDownMonthlyProCents == null ? null : toNumber(r.stepDownMonthlyProCents),
    createdAt: new Date(r.createdAt as string),
    updatedAt: new Date(r.updatedAt as string),
  };
}

export async function listSalesReps(): Promise<SalesRep[]> {
  assertServer();
  const rows = await sql()`SELECT * FROM sales_reps ORDER BY created_at ASC, id ASC`;
  return rows.map((r) => rowToRep(r as unknown as Record<string, unknown>));
}

export async function getSalesRep(repId: string): Promise<SalesRep | null> {
  assertServer();
  const rows = await sql()`SELECT * FROM sales_reps WHERE id = ${repId} LIMIT 1`;
  const row = rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? rowToRep(row) : null;
}

export async function createSalesRep(input: SalesRepInput): Promise<SalesRep> {
  assertServer();
  const rows = await sql()`
    INSERT INTO sales_reps (
      name, contact, active,
      bounty_starter_cents, bounty_pro_cents,
      monthly_starter_cents, monthly_pro_cents,
      step_down_after_months, step_down_monthly_starter_cents, step_down_monthly_pro_cents
    ) VALUES (
      ${input.name}, ${input.contact}, ${input.active},
      ${input.bountyStarterCents}, ${input.bountyProCents},
      ${input.monthlyStarterCents}, ${input.monthlyProCents},
      ${input.stepDownAfterMonths}, ${input.stepDownMonthlyStarterCents}, ${input.stepDownMonthlyProCents}
    )
    RETURNING *`;
  return rowToRep(rows[0] as unknown as Record<string, unknown>);
}

/**
 * Full-row update (the edit form submits the complete schedule — no
 * field-level partial updates, so no COALESCE ambiguity about what was
 * "not provided"). The server layer normalizes contact (trim; '' → null).
 */
export async function updateSalesRep(repId: string, input: SalesRepInput): Promise<SalesRep | null> {
  assertServer();
  const rows = await sql()`
    UPDATE sales_reps SET
      name                              = ${input.name},
      contact                           = ${input.contact},
      active                            = ${input.active},
      bounty_starter_cents              = ${input.bountyStarterCents},
      bounty_pro_cents                  = ${input.bountyProCents},
      monthly_starter_cents             = ${input.monthlyStarterCents},
      monthly_pro_cents                 = ${input.monthlyProCents},
      step_down_after_months            = ${input.stepDownAfterMonths},
      step_down_monthly_starter_cents   = ${input.stepDownMonthlyStarterCents},
      step_down_monthly_pro_cents       = ${input.stepDownMonthlyProCents}
    WHERE id = ${repId}
    RETURNING *`;
  const row = rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? rowToRep(row) : null;
}

/** Deactivate/reactivate. Deactivated reps keep their history and attributions. */
export async function setSalesRepActive(repId: string, active: boolean): Promise<SalesRep | null> {
  assertServer();
  const rows = await sql()`UPDATE sales_reps SET active = ${active} WHERE id = ${repId} RETURNING *`;
  const row = rows[0] as unknown as Record<string, unknown> | undefined;
  return row ? rowToRep(row) : null;
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

export async function attributeBusiness(businessId: string, repId: string): Promise<boolean> {
  assertServer();
  const rows = await sql()`
    UPDATE businesses
    SET sales_rep_id = ${repId}, sales_rep_attributed_at = now()
    WHERE id = ${businessId}
    RETURNING id`;
  return rows.length > 0;
}

export async function unattributeBusiness(businessId: string): Promise<boolean> {
  assertServer();
  const rows = await sql()`
    UPDATE businesses
    SET sales_rep_id = NULL, sales_rep_attributed_at = NULL
    WHERE id = ${businessId}
    RETURNING id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// The page read — attributed accounts + unattributed businesses + payouts
// ---------------------------------------------------------------------------

export interface AttributedAccountRow {
  business: Pick<Business, "id" | "name" | "plan" | "subscriptionStatus">;
  salesRepId: string;
  attributedAt: Date | null;
  firstPaidAt: Date | null;
  canceledAt: Date | null;
  ledgerPlan: string | null;
}

export async function listAttributedAccounts(): Promise<AttributedAccountRow[]> {
  assertServer();
  const rows = await sql()`
    SELECT
      b.id, b.name, b.plan, b.subscription_status,
      b.sales_rep_id, b.sales_rep_attributed_at,
      (SELECT min(e.occurred_at) FROM billing_events e
        WHERE e.business_id = b.id
          AND e.event_type = 'checkout_completed'
          AND e.payload->>'status' = 'active') AS "firstPaidAt",
      (SELECT max(e.occurred_at) FROM billing_events e
        WHERE e.business_id = b.id
          AND e.event_type = 'subscription_canceled') AS "canceledAt",
      (SELECT e.payload->>'plan' FROM billing_events e
        WHERE e.business_id = b.id
          AND e.payload->>'plan' IN ('starter', 'pro')
        ORDER BY e.occurred_at DESC
        LIMIT 1) AS "ledgerPlan"
    FROM businesses b
    WHERE b.sales_rep_id IS NOT NULL
    ORDER BY b.name ASC`;
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    business: {
      id: String(r.id),
      name: String(r.name),
      plan: (r.plan == null ? null : String(r.plan)) as Pick<Business, "id" | "name" | "plan" | "subscriptionStatus">["plan"],
      subscriptionStatus: r.subscriptionStatus == null ? null : String(r.subscriptionStatus),
    } as Pick<Business, "id" | "name" | "plan" | "subscriptionStatus">,
    salesRepId: String(r.salesRepId),
    attributedAt: r.salesRepAttributedAt ? new Date(r.salesRepAttributedAt as string) : null,
    firstPaidAt: r.firstPaidAt ? new Date(r.firstPaidAt as string) : null,
    canceledAt: r.canceledAt ? new Date(r.canceledAt as string) : null,
    ledgerPlan: r.ledgerPlan == null ? null : String(r.ledgerPlan),
  }));
}

export interface UnattributedBusinessRow {
  id: string;
  name: string;
  plan: string | null;
  subscriptionStatus: string | null;
}

/** Candidates for the attribute form. Bounded so the select stays renderable. */
export async function listUnattributedBusinesses(limit = 500): Promise<UnattributedBusinessRow[]> {
  assertServer();
  const rows = await sql()`
    SELECT id, name, plan, subscription_status
    FROM businesses
    WHERE sales_rep_id IS NULL
    ORDER BY created_at DESC
    LIMIT ${limit}`;
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    name: String(r.name),
    plan: r.plan == null ? null : String(r.plan),
    subscriptionStatus: r.subscriptionStatus == null ? null : String(r.subscriptionStatus),
  }));
}

// ---------------------------------------------------------------------------
// Payouts ledger (append-only)
// ---------------------------------------------------------------------------

export interface PayoutRow {
  id: string;
  repId: string;
  repName: string;
  amountCents: number;
  note: string | null;
  paidAt: Date;
}

export async function listRepPayouts(): Promise<PayoutRow[]> {
  assertServer();
  const rows = await sql()`
    SELECT p.id, p.rep_id, r.name AS rep_name, p.amount_cents, p.note, p.paid_at
    FROM sales_rep_payouts p
    JOIN sales_reps r ON r.id = p.rep_id
    ORDER BY p.paid_at DESC, p.created_at DESC`;
  return (rows as unknown as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    repId: String(r.repId),
    repName: String(r.repName),
    amountCents: toNumber(r.amountCents),
    note: r.note == null ? null : String(r.note),
    paidAt: new Date(r.paidAt as string),
  }));
}

export async function createSalesRepPayout(input: {
  repId: string;
  amountCents: number;
  note: string | null;
}): Promise<SalesRepPayout> {
  assertServer();
  const rows = await sql()`
    INSERT INTO sales_rep_payouts (rep_id, amount_cents, note)
    VALUES (${input.repId}, ${input.amountCents}, ${input.note})
    RETURNING *`;
  const r = rows[0] as unknown as Record<string, unknown>;
  return {
    id: String(r.id),
    repId: String(r.repId),
    amountCents: toNumber(r.amountCents),
    note: r.note == null ? null : String(r.note),
    paidAt: new Date(r.paidAt as string),
    createdAt: new Date(r.createdAt as string),
    updatedAt: new Date(r.updatedAt as string),
  };
}
