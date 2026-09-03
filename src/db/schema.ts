/**
 * TypeScript row types for every table in migrations/001_init.sql.
 *
 * Conventions:
 *   - `id` and every `*_id` reference is a plain `string` (Postgres uuid).
 *   - `timestamptz` columns are `Date` (the Neon driver parses them); when a
 *     query returns `::text` casts, project into a local type instead.
 *   - `time` columns (business_hours.opens_at / closes_at) are strings like
 *     "07:30:00" — the driver does not parse `time` into Date.
 *   - Enum columns are the exact unions created in 001_init.sql.
 *   - Nullable columns are `| null`; every table also exposes `CreatedAt` /
 *     `UpdatedAt` style plain Dates.
 *
 * These types describe what `sql()` returns for `SELECT *`. They are types
 * only — nothing here runs on the client, but nothing here is server-restricted
 * either, so they are safe to import from route loaders for narrowing.
 */

// ---------------------------------------------------------------------------
// Enums (mirror the CREATE TYPE statements in 001_init.sql)
// ---------------------------------------------------------------------------

export type UserRole = 'owner' | 'manager' | 'employee';
export type BusinessPlan = 'trial' | 'starter' | 'growth' | 'pro';

export type LeadSource = 'missed_call' | 'web_form' | 'referral' | 'repeat_customer' | 'other';
export type LeadUrgency = 'emergency' | 'same_day' | 'within_week' | 'flexible';
/**
 * Phase 2 lifecycle for leads (migration 005 — text + CHECK, not a PG enum,
 * so the set stays editable). Replaces the Phase 1
 * new/contacted/qualified/converted/lost lifecycle.
 */
export type LeadStatus = 'new' | 'contacted' | 'booked' | 'completed' | 'lost';
/**
 * Shop-side triage ranking (migration 005) — how the business prioritizes the
 * job. Distinct from `LeadUrgency`, which is what the caller reported.
 */
export type LeadPriority = 'emergency' | 'high' | 'normal';

export type ConversationStatus = 'active' | 'awaiting_customer' | 'booked' | 'closed';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export type ServiceAreaKind = 'zip' | 'city';

// ---------------------------------------------------------------------------
// Core: businesses, users, auth tokens
// ---------------------------------------------------------------------------

export interface Business {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** IANA timezone used to render hours/appointments. */
  timezone: string;
  /** Per-business configuration blob (notification prefs, etc). */
  settings: Record<string, unknown>;
  /** Selected tier id: 'trial' until a plan is chosen, then 'starter' | 'pro'. */
  plan: BusinessPlan;
  /** When the 14-day trial ends (null = no trial period recorded). */
  trialEndsAt: Date | null;
  /** Phase 1 placeholder state; Stripe lifecycle takes this over in Phase 2. */
  subscriptionStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  businessId: string;
  email: string;
  fullName: string;
  role: UserRole;
  /** Hashed server-side; never select into client payloads. */
  passwordHash: string;
  isActive: boolean;
  /**
   * Flipped by the email-verification token flow (migration 002). Unverified
   * users may log in; the app shows a "verify your email" banner instead.
   */
  emailVerified: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Session {
  id: string;
  userId: string;
  /** SHA-256 hash of the opaque session token; the raw token lives in the cookie. */
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailVerificationToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export interface Lead {
  id: string;
  businessId: string;
  source: LeadSource;
  status: LeadStatus;
  /** Triage ranking; drives the 🔴/🟠/🟢 badges (migration 005). */
  priority: LeadPriority;
  serviceNeed: string;
  urgency: LeadUrgency;
  contactName: string;
  contactPhone: string;
  contactEmail: string | null;
  /** Job-site address; may differ from the business address. */
  contactAddress: string | null;
  description: string | null;
  /** Rough pipeline value in cents; null until quoted. */
  estimatedValueCents: number | null;
  notes: string | null;
  convertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Conversations & messages
// ---------------------------------------------------------------------------

export interface Conversation {
  id: string;
  businessId: string;
  /** Null once the parent lead is deleted — history is kept, link is dropped. */
  leadId: string | null;
  customerPhone: string;
  status: ConversationStatus;
  summary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  businessId: string;
  conversationId: string;
  direction: MessageDirection;
  body: string;
  status: MessageStatus;
  /** Provider message id (e.g. Twilio SID); unique when present. */
  externalId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/** Global default service catalog, shared across businesses (no business_id). */
export interface ServiceDefault {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Service {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  basePriceCents: number | null;
  durationMinutes: number | null;
  /** True when instantiated from a service_defaults entry. */
  isDefault: boolean;
  /** The global default it came from; survives default deletion. */
  defaultServiceId: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Appointments, service areas, business hours
// ---------------------------------------------------------------------------

export interface Appointment {
  id: string;
  businessId: string;
  /** Survives lead deletion (SET NULL). */
  leadId: string | null;
  /** Survives service deletion (SET NULL). */
  serviceId: string | null;
  /** Snapshot of the service name at booking time. */
  serviceSummary: string;
  technicianName: string | null;
  scheduledAt: Date;
  durationMinutes: number;
  status: AppointmentStatus;
  address: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceArea {
  id: string;
  businessId: string;
  /** 'zip' or 'city'; `value` holds the zip code or the city name. */
  kind: ServiceAreaKind;
  value: string;
  state: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BusinessHour {
  id: string;
  businessId: string;
  /** 0 = Sunday … 6 = Saturday (matches JS Date#getDay()). */
  dayOfWeek: number;
  isOpen: boolean;
  /** "HH:MM:SS" strings, null when closed. opens_at < closes_at enforced by CHECK. */
  opensAt: string | null;
  closesAt: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Migration bookkeeping
// ---------------------------------------------------------------------------

export interface SchemaMigration {
  name: string;
  appliedAt: Date;
}
