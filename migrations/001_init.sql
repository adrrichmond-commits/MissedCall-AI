-- 001_init.sql — MissedCall AI Phase 1 normalized schema.
--
-- Conventions (enforced here and documented in AGENTS.md):
--   * UUID primary keys via gen_random_uuid() (built into Postgres 13+).
--   * Every business-scoped table carries `business_id NOT NULL REFERENCES businesses(id)`
--     so data isolation can be enforced at the query layer.
--   * Deliberate ON DELETE behavior:
--       - business ownership chains CASCADE (deleting a business deletes its data).
--       - derived records (sessions, tokens, messages) CASCADE from their parent.
--       - historical references that should survive (appointments -> lead/service,
--         conversations -> lead, services -> service_defaults) SET NULL.
--   * created_at / updated_at on every table; updated_at maintained by trigger.
--   * Indexes on business_id (and the columns Phase 1 dashboards filter/sort by).

-- ---------------------------------------------------------------------------
-- Enumerated types
-- ---------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('owner', 'manager', 'employee');
CREATE TYPE business_plan AS ENUM ('trial', 'starter', 'growth', 'pro');

CREATE TYPE lead_source AS ENUM (
  'missed_call',
  'web_form',
  'referral',
  'repeat_customer',
  'other'
);
CREATE TYPE lead_urgency AS ENUM (
  'emergency',
  'same_day',
  'within_week',
  'flexible'
);
CREATE TYPE lead_status AS ENUM (
  'new',
  'contacted',
  'qualified',
  'converted',
  'lost'
);

CREATE TYPE conversation_status AS ENUM (
  'active',
  'awaiting_customer',
  'booked',
  'closed'
);
CREATE TYPE message_direction AS ENUM ('inbound', 'outbound');
CREATE TYPE message_status AS ENUM ('queued', 'sent', 'delivered', 'read', 'failed');

CREATE TYPE appointment_status AS ENUM (
  'scheduled',
  'confirmed',
  'in_progress',
  'completed',
  'cancelled',
  'no_show'
);

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Core: businesses & users
-- ---------------------------------------------------------------------------
CREATE TABLE businesses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL,
  phone         text,
  email         text,
  website       text,
  address_line1 text,
  address_line2 text,
  city          text,
  state         text,
  postal_code   text,
  -- IANA timezone used to render hours/appointments; Phase 1 default for US plumbers.
  timezone      text        NOT NULL DEFAULT 'America/Chicago',
  plan          business_plan NOT NULL DEFAULT 'trial',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid        NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email         text        NOT NULL,
  full_name     text        NOT NULL,
  role          user_role   NOT NULL DEFAULT 'employee',
  -- Argon2id hash (Bun.password). Placeholder demo hashes are seeded by scripts/seed.ts.
  password_hash text        NOT NULL,
  is_active     boolean     NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Login identity is the lowercased email, case-insensitively unique.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_business_id_idx ON users (business_id);

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hash of the opaque session token; the raw token lives only in the cookie.
  token_hash text        NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text        NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX password_reset_tokens_token_hash_key ON password_reset_tokens (token_hash);
CREATE INDEX password_reset_tokens_user_id_idx ON password_reset_tokens (user_id);

CREATE TABLE email_verification_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX email_verification_tokens_token_hash_key ON email_verification_tokens (token_hash);
CREATE INDEX email_verification_tokens_user_id_idx ON email_verification_tokens (user_id);

-- ---------------------------------------------------------------------------
-- Leads (the missed call becomes a lead)
-- ---------------------------------------------------------------------------
CREATE TABLE leads (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          uuid         NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source               lead_source  NOT NULL DEFAULT 'missed_call',
  status               lead_status  NOT NULL DEFAULT 'new',
  service_need         text         NOT NULL,
  urgency              lead_urgency NOT NULL DEFAULT 'flexible',
  contact_name         text         NOT NULL,
  contact_phone        text         NOT NULL,
  contact_email        text,
  -- Service address for the job site (may differ from business address).
  contact_address      text,
  description          text,
  -- Rough pipeline value in cents; nullable until quoted.
  estimated_value_cents integer,
  notes                text,
  converted_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX leads_business_id_idx ON leads (business_id);
CREATE INDEX leads_business_status_idx ON leads (business_id, status);
CREATE INDEX leads_business_created_at_idx ON leads (business_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Conversations & messages (AI SMS thread per missed call)
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid                NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- Nullable: a conversation may start before its lead is created, and survives
  -- lead deletion (history is kept, link is dropped).
  lead_id        uuid REFERENCES leads(id) ON DELETE SET NULL,
  customer_phone text                NOT NULL,
  status         conversation_status NOT NULL DEFAULT 'active',
  summary        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX conversations_business_id_idx ON conversations (business_id);
CREATE INDEX conversations_business_status_idx ON conversations (business_id, status);
CREATE INDEX conversations_lead_id_idx ON conversations (lead_id);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid             NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id uuid             NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction       message_direction NOT NULL,
  body            text             NOT NULL,
  status          message_status   NOT NULL DEFAULT 'queued',
  -- Provider message id (e.g. Twilio SID) for later-phase telephony; unique when present.
  external_id     text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_business_id_idx ON messages (business_id);
CREATE INDEX messages_conversation_created_at_idx ON messages (conversation_id, created_at);
CREATE UNIQUE INDEX messages_external_id_key ON messages (external_id) WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Services: global defaults + per-business catalog
-- ---------------------------------------------------------------------------
CREATE TABLE service_defaults (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text    NOT NULL,
  description text,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX service_defaults_name_key ON service_defaults (lower(name));

CREATE TABLE services (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid    NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name              text    NOT NULL,
  description       text,
  base_price_cents  integer,
  duration_minutes  integer CHECK (duration_minutes IS NULL OR duration_minutes > 0),
  -- true when this row was instantiated from a service_defaults entry.
  is_default        boolean NOT NULL DEFAULT false,
  -- Points at the global default it came from; survives default deletion.
  default_service_id uuid REFERENCES service_defaults(id) ON DELETE SET NULL,
  is_active         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX services_business_id_idx ON services (business_id);
CREATE UNIQUE INDEX services_business_name_key ON services (business_id, lower(name));

-- ---------------------------------------------------------------------------
-- Appointments (booked jobs)
-- ---------------------------------------------------------------------------
CREATE TABLE appointments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid               NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- The prospect record; appointment survives lead deletion.
  lead_id        uuid REFERENCES leads(id) ON DELETE SET NULL,
  service_id     uuid REFERENCES services(id) ON DELETE SET NULL,
  -- Snapshot of the service name at booking time (survives service edits).
  service_summary text              NOT NULL,
  technician_name text,
  scheduled_at   timestamptz        NOT NULL,
  duration_minutes integer          NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
  status         appointment_status NOT NULL DEFAULT 'scheduled',
  address        text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX appointments_business_id_idx ON appointments (business_id);
CREATE INDEX appointments_business_scheduled_at_idx ON appointments (business_id, scheduled_at);
CREATE INDEX appointments_business_status_idx ON appointments (business_id, status);
CREATE INDEX appointments_lead_id_idx ON appointments (lead_id);

-- ---------------------------------------------------------------------------
-- Service areas & business hours
-- ---------------------------------------------------------------------------
CREATE TABLE service_areas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- 'zip' or 'city'; value holds the zip code or the city name.
  kind        text NOT NULL CHECK (kind IN ('zip', 'city')),
  value       text NOT NULL,
  state       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX service_areas_business_id_idx ON service_areas (business_id);
CREATE UNIQUE INDEX service_areas_business_kind_value_key
  ON service_areas (business_id, kind, lower(value));

CREATE TABLE business_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid     NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- 0 = Sunday ... 6 = Saturday (matches JS Date#getDay()).
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  is_open     boolean  NOT NULL DEFAULT true,
  opens_at    time,
  closes_at   time,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT business_hours_open_times_required
    CHECK (NOT is_open OR (opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at < closes_at))
);

CREATE UNIQUE INDEX business_hours_business_day_key ON business_hours (business_id, day_of_week);

-- ---------------------------------------------------------------------------
-- updated_at triggers (every table with updated_at)
-- ---------------------------------------------------------------------------
CREATE TRIGGER trg_businesses_updated_at          BEFORE UPDATE ON businesses              FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_users_updated_at               BEFORE UPDATE ON users                   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sessions_updated_at            BEFORE UPDATE ON sessions                FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_password_reset_updated_at      BEFORE UPDATE ON password_reset_tokens   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_email_verification_updated_at  BEFORE UPDATE ON email_verification_tokens FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_leads_updated_at               BEFORE UPDATE ON leads                   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_conversations_updated_at       BEFORE UPDATE ON conversations           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_messages_updated_at            BEFORE UPDATE ON messages                FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_appointments_updated_at        BEFORE UPDATE ON appointments            FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_service_defaults_updated_at    BEFORE UPDATE ON service_defaults        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_services_updated_at            BEFORE UPDATE ON services                FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_service_areas_updated_at       BEFORE UPDATE ON service_areas           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_business_hours_updated_at      BEFORE UPDATE ON business_hours          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
