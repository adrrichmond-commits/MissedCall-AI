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
 * Phase 3 build P3-C lifecycle for leads (migration 011 — text + CHECK, not a
 * PG enum, so the set stays editable). Extends the Phase 2 set to the full
 * lead-to-job pipeline; transitions are enforced in
 * src/lib/server/leadLifecycle.ts. Pre-011 rows ('booked'/'completed') are
 * backfilled by the migration; LEGACY_STATUS_MAP in leadLifecycle.ts maps any
 * stragglers for reads.
 */
export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'qualified'
  | 'follow_up_needed'
  | 'appointment_scheduled'
  | 'won'
  | 'lost';
/**
 * Shop-side triage ranking (migration 005) — how the business prioritizes the
 * job. Distinct from `LeadUrgency`, which is what the caller reported.
 */
export type LeadPriority = 'emergency' | 'high' | 'normal';

export type ConversationStatus = 'active' | 'awaiting_customer' | 'booked' | 'closed';
export type MessageDirection = 'inbound' | 'outbound';
/**
 * Phase 2 build #4 (migration 008): 'unclassified' is the honest placeholder
 * for an inbound SMS stored while no LLM is configured — the message is real,
 * no AI parse exists yet, nothing is invented. Classification flips the row
 * to 'delivered' and stamps the classification payload.
 */
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'unclassified';

/**
 * Phase 2 request-driven lifecycle (migration 006 — text + CHECK, not a PG
 * enum, so the set stays editable). AI/customer-initiated bookings are
 * REQUESTS the business confirms; the old scheduled/in_progress/cancelled/
 * no_show states are absorbed (scheduled->requested, in_progress->confirmed,
 * cancelled/no_show->declined).
 */
export type AppointmentStatus =
  | 'requested'
  | 'confirmed'
  | 'declined'
  | 'completed';

export type ServiceAreaKind = 'zip' | 'city';

/**
 * Phase 2 build #3 (migration 007): where the caller sits relative to the
 * business's service areas, captured at lead capture time. 'unknown' means
 * the address carried no decidable ZIP/city — never a guess.
 */
export type ServiceAreaStatus = 'in_area' | 'out_of_area' | 'unknown';

/**
 * In-app notification center feed (migration 007). `type` is constrained by
 * notifications_type_check; `payload` holds display/link fields.
 */
export type NotificationType =
  | 'new_lead'
  | 'lead_booked'
  | 'appointment_requested'
  | 'appointment_confirmed'
  | 'appointment_declined'
  /**
   * Phase 2 build #5 (migration 009): invoice.payment_failed creates this
   * in-app notification — the honest channel that exists without any
   * provider keys (email/SMS delivery remains provider-gated).
   */
  | 'payment_failed';

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
  /**
   * Phase 2 build #5 (migration 009): Stripe identity + lifecycle, written
   * only by the webhook path. subscription_status is CHECK-constrained to
   * 'active' | 'trialing' | 'past_due' | 'canceled' | NULL.
   */
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
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
  /**
   * P3-C (migration 011): KB-seeded typical job value range, stamped when a
   * lead's service need resolves to a KB service. The shop's quote
   * (estimatedValueCents) outranks it; both feed pipeline_value_cents.
   */
  estimatedJobValueLowCents: number | null;
  estimatedJobValueHighCents: number | null;
  /** P3-C: the actual invoice amount entered when the lead is marked Won. */
  actualWonValueCents: number | null;
  /**
   * P3-C: the single "what is this lead worth" number P3-D Revenue Recovered
   * sums. Maintained by the query layer (computePipelineValueCents):
   * won → actual ?? quote ?? est-high; lost → NULL;
   * open → max(quote, est-high) (either may be null).
   */
  pipelineValueCents: number | null;
  notes: string | null;
  convertedAt: Date | null;
  /** Migration 007: captured-at-time service-area verdict for the job address. */
  serviceAreaStatus: ServiceAreaStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * P3-C (migration 011): one row per promised callback. Auto-created on lead
 * capture ('lead_new', due next business day 9 AM business time) and when a
 * lead is flagged follow_up_needed ('status_follow_up', carrying the note);
 * the business can also add 'manual' tasks. The dashboard list of open tasks
 * IS the scheduler surface — no cron, no reminders worker.
 */
export interface FollowUpTask {
  id: string;
  businessId: string;
  /** CASCADEs with the lead: a task for a deleted lead is not actionable. */
  leadId: string;
  dueAt: Date;
  done: boolean;
  doneAt: Date | null;
  /** 'lead_new' | 'status_follow_up' | 'manual' (CHECK-constrained). */
  createdReason: 'lead_new' | 'status_follow_up' | 'manual';
  note: string | null;
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
  /** Migration 008: LLM parse of an inbound message; NULL = never classified. */
  classification: MessageClassification | null;
  sentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Coarse lead temperature bucket (build #7): rule engine always sets it; LLM path may. */
export type MessageClassificationCategory = 'emergency' | 'urgent' | 'routine' | 'other';

/** What the customer wants to happen next (build #7). */
export type MessageClassificationIntent = 'quote' | 'book' | 'question';

/**
 * Structured parse of one inbound SMS (migration 008 jsonb). Every field is
 * optional: the engine (LLM or rules — see `classifier`) reports what it could
 * extract, and the DB stores the raw payload verbatim — nothing is inferred
 * outside the engine call.
 *
 * Build #7 additions (rule engine, src/lib/server/classify.ts) — all optional
 * so pre-#7 LLM rows stay valid:
 *   classifier        "rules" | "llm" — which engine produced this parse.
 *                       ABSENT on rows written before build #7.
 *   confidence        0..1, self-reported strength. NOT a probability.
 *   category          coarse bucket (rules always set it; LLM may).
 *   intent            quote | book | question | null.
 *   preferredTimeHint verbatim time phrase extracted from the text.
 *   matchedRules      rule keys that fired (rule engine only).
 */
export interface MessageClassification {
  serviceNeed: string | null;
  urgency: 'emergency' | 'same_day' | 'within_week' | 'flexible' | null;
  priority: 'emergency' | 'high' | 'normal' | null;
  contactName: string | null;
  contactEmail: string | null;
  serviceAddress: string | null;
  safetyConcern: boolean | null;
  notes: string | null;
  /** Model + base URL (LLM) or rules version (rule engine) — for auditability. */
  model: string;
  /** Which engine produced this parse; absent on pre-build-#7 rows. */
  classifier?: 'rules' | 'llm';
  /** Self-reported match strength in [0,1]; an ordering signal, not a probability. */
  confidence?: number;
  /** Coarse bucket. The rule engine always sets it; the LLM path may. */
  category?: MessageClassificationCategory;
  /** What the customer wants next: quote, booking, or question. */
  intent?: MessageClassificationIntent | null;
  /** Verbatim time phrase from the text ("tonight", "tomorrow morning", ...). */
  preferredTimeHint?: string | null;
  /** Keys of the domain rules that fired (rule engine only). */
  matchedRules?: string[];
  /**
   * P3-B: draft reply text produced this turn by the classification pipeline
   * (src/lib/server/classifyPipeline.ts). Only text that passed the KB
   * screening contract gets here — emergencies carry the KB safety script,
   * screened LLM answers carry their approved text, and replaced advice
   * carries the honest human-routing fallback. Null when no reply was due.
   */
  reply?: string | null;
  /**
   * P3-B pipeline stamps (all optional — jsonb only, no migration; rows
   * written before P3-B are unaffected). See src/lib/server/classifyPipeline.ts.
   *
   *   kbVersion            KB revision that fed this parse ("kb-v1") — the
   *                        knowledge-base counterpart of `model`/`classifier`.
   *   tier                 which tier produced the result: "llm" | "rules".
   *                        Same value as `classifier`; kept explicit so the
   *                        tier selection is auditable even on legacy shapes.
   *   tierReason           why that tier ran: "primary" (LLM configured and
   *                        succeeded), "default" (no LLM_API_KEY — rules are
   *                        the launch default), "backstop" (LLM configured
   *                        but errored/returned nothing this turn).
   *   emergencyKey         matched KB emergency class key (kb emergencies.ts),
   *                        null when no KB emergency matched. An LLM-only
   *                        emergency (no KB entry) stays null here but still
   *                        forces urgency/priority emergency downstream.
   *   emergencySeverity    matched KB emergency severity (critical > severe >
   *                        elevated), null when emergencyKey is null.
   *   afterHoursEscalation emergency detected outside the business's configured
   *                        hours (KB afterHoursEscalation policy AND the time
   *                        fact). True also when hours could not be read
   *                        (fail toward escalation). Only set on emergencies.
   *   replySource          where the auto-reply text came from, when one was
   *                        produced: kb_emergency_script | kb_emergency_generic
   *                        | kb_faq_pricing | llm_screened | human_routing.
   *                        Never the raw LLM text without a screening pass.
   */
  kbVersion?: string;
  tier?: 'llm' | 'rules';
  tierReason?: 'primary' | 'default' | 'backstop';
  emergencyKey?: string | null;
  emergencySeverity?: 'critical' | 'severe' | 'elevated' | null;
  afterHoursEscalation?: boolean;
  replySource?: string | null;
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

// ---------------------------------------------------------------------------
// SMS opt-outs (migration 008 — TCPA/10DLC compliance)
// ---------------------------------------------------------------------------

/**
 * A phone that must NEVER receive outbound SMS from this business again
 * (customer texted STOP, or the owner added it manually). Enforced in the
 * send path (src/lib/server/textBack.ts) — the whole table is the compliance
 * boundary, not just the text-back flow.
 */
export interface SmsOptOut {
  id: string;
  businessId: string;
  /** E.164-normalized customer phone. */
  phone: string;
  /** 'stop_reply' (customer texted STOP) | 'owner_added' (manual). */
  reason: 'stop_reply' | 'owner_added';
  /** The inbound message SID that carried the STOP, when known. */
  sourceMessageSid: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Notifications (migration 007 — in-app notification center)
// ---------------------------------------------------------------------------

export interface Notification {
  id: string;
  businessId: string;
  type: NotificationType;
  /** Event details (lead/appointment ids + display fields). */
  payload: Record<string, unknown>;
  /** Null while unread; stamped by mark-as-read. */
  readAt: Date | null;
  /**
   * Phase 2 build #6 (migration 010): stamped ONLY after the email provider
   * accepted a send for this notification. NULL = email not sent (unconfigured
   * provider, non-deliverable type, or a failed attempt) — the double-send
   * guard the delivery hook checks before sending.
   */
  emailSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
