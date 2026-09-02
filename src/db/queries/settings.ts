/**
 * Server-only queries: settings domain — services (catalog), service areas,
 * and business hours.
 *
 * ISOLATION RULE: business-scoped functions take `businessId` and filter on it.
 * `service_defaults` is global reference data read by any business but written
 * only by seed/migrations.
 */
import type { BusinessHour, Service, ServiceArea, ServiceAreaKind, ServiceDefault } from "../schema";
import { assertServer, listClause, sql, type ListOptions } from "./shared";

// ---------------------------------------------------------------------------
// Services (per-business catalog)
// ---------------------------------------------------------------------------

export interface CreateServiceInput {
  name: string;
  description?: string | null;
  basePriceCents?: number | null;
  durationMinutes?: number | null;
  isDefault?: boolean;
  defaultServiceId?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

export interface UpdateServiceInput {
  name?: string;
  description?: string | null;
  basePriceCents?: number | null;
  durationMinutes?: number | null;
  isActive?: boolean;
  sortOrder?: number;
}

export async function listServices(businessId: string, opts?: ListOptions): Promise<Service[]> {
  assertServer();
  const { limit, offset } = listClause(opts);
  const db = sql();
  const rows = await db.query(
    `SELECT * FROM services WHERE business_id = $1 ORDER BY sort_order ASC, lower(name) ASC LIMIT ${limit} OFFSET ${offset}`,
    [businessId],
  );
  return rows as unknown as Service[];
}

export async function listActiveServices(businessId: string): Promise<Service[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM services WHERE business_id = ${businessId} AND is_active
    ORDER BY sort_order ASC, lower(name) ASC`;
  return rows as unknown as Service[];
}

export async function getService(businessId: string, serviceId: string): Promise<Service | null> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM services WHERE id = ${serviceId} AND business_id = ${businessId} LIMIT 1`;
  return (rows[0] as unknown as Service | undefined) ?? null;
}

export async function countServices(businessId: string, activeOnly = false): Promise<number> {
  assertServer();
  const db = sql();
  const rows = activeOnly
    ? await db`SELECT count(*) AS n FROM services WHERE business_id = ${businessId} AND is_active`
    : await db`SELECT count(*) AS n FROM services WHERE business_id = ${businessId}`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

export async function createService(businessId: string, input: CreateServiceInput): Promise<Service> {
  assertServer();
  const db = sql();
  const rows = await db.query(
    `INSERT INTO services (business_id, name, description, base_price_cents, duration_minutes,
       is_default, default_service_id, is_active, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      businessId,
      input.name,
      input.description ?? null,
      input.basePriceCents ?? null,
      input.durationMinutes ?? null,
      input.isDefault ?? false,
      input.defaultServiceId ?? null,
      input.isActive ?? true,
      input.sortOrder ?? 0,
    ],
  );
  return rows[0] as unknown as Service;
}

const SERVICE_PATCH_COLUMNS = [
  "name",
  "description",
  "basePriceCents",
  "durationMinutes",
  "isActive",
  "sortOrder",
] as const;

export async function updateService(
  businessId: string,
  serviceId: string,
  input: UpdateServiceInput,
): Promise<Service | null> {
  assertServer();
  const snake = (k: string): string => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const cols = Object.keys(input).filter((k) =>
    (SERVICE_PATCH_COLUMNS as readonly string[]).includes(k),
  );
  if (cols.length === 0) return getService(businessId, serviceId);
  const sets = cols.map((k, i) => `${snake(k)} = $${i + 3}`).join(", ");
  const values = cols.map((k) => input[k as keyof UpdateServiceInput]);
  const db = sql();
  const rows = await db.query(
    `UPDATE services SET ${sets} WHERE id = $1 AND business_id = $2 RETURNING *`,
    [serviceId, businessId, ...values],
  );
  return (rows[0] as unknown as Service | undefined) ?? null;
}

export async function deleteService(businessId: string, serviceId: string): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`DELETE FROM services WHERE id = ${serviceId} AND business_id = ${businessId} RETURNING id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Global service defaults (reference data)
// ---------------------------------------------------------------------------

export async function listServiceDefaults(): Promise<ServiceDefault[]> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM service_defaults WHERE is_active ORDER BY sort_order ASC`;
  return rows as unknown as ServiceDefault[];
}

// ---------------------------------------------------------------------------
// Service areas
// ---------------------------------------------------------------------------

export interface CreateServiceAreaInput {
  kind: ServiceAreaKind;
  value: string;
  state?: string | null;
}

export async function listServiceAreas(businessId: string): Promise<ServiceArea[]> {
  assertServer();
  const db = sql();
  const rows = await db`
    SELECT * FROM service_areas WHERE business_id = ${businessId}
    ORDER BY kind ASC, lower(value) ASC`;
  return rows as unknown as ServiceArea[];
}

export async function countServiceAreas(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT count(*) AS n FROM service_areas WHERE business_id = ${businessId}`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}

export async function createServiceArea(
  businessId: string,
  input: CreateServiceAreaInput,
): Promise<ServiceArea | null> {
  assertServer();
  const db = sql();
  // Unique on (business_id, kind, lower(value)) — null if it already exists.
  const rows = await db`
    INSERT INTO service_areas (business_id, kind, value, state)
    VALUES (${businessId}, ${input.kind}, ${input.value}, ${input.state ?? null})
    ON CONFLICT DO NOTHING
    RETURNING *`;
  return (rows[0] as unknown as ServiceArea | undefined) ?? null;
}

export async function deleteServiceArea(businessId: string, serviceAreaId: string): Promise<boolean> {
  assertServer();
  const db = sql();
  const rows = await db`DELETE FROM service_areas WHERE id = ${serviceAreaId} AND business_id = ${businessId} RETURNING id`;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Business hours
// ---------------------------------------------------------------------------

export interface BusinessHourInput {
  dayOfWeek: number;
  isOpen: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
}

/** One upsert per day (unique on business_id + day_of_week). */
export async function upsertBusinessHour(businessId: string, input: BusinessHourInput): Promise<void> {
  assertServer();
  const db = sql();
  await db`
    INSERT INTO business_hours (business_id, day_of_week, is_open, opens_at, closes_at)
    VALUES (${businessId}, ${input.dayOfWeek}, ${input.isOpen}, ${input.opensAt ?? null}, ${input.closesAt ?? null})
    ON CONFLICT (business_id, day_of_week) DO UPDATE
    SET is_open = excluded.is_open, opens_at = excluded.opens_at, closes_at = excluded.closes_at`;
}

export async function listBusinessHours(businessId: string): Promise<BusinessHour[]> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT * FROM business_hours WHERE business_id = ${businessId} ORDER BY day_of_week ASC`;
  return rows as unknown as BusinessHour[];
}

export async function countBusinessHours(businessId: string): Promise<number> {
  assertServer();
  const db = sql();
  const rows = await db`SELECT count(*) AS n FROM business_hours WHERE business_id = ${businessId}`;
  return Number((rows[0] as unknown as { n: unknown }).n);
}
