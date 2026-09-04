-- 008_sms_lifecycle.sql — Phase 2 build #4: SMS/LLM pre-wire.
--
--   1) messages.status: PG enum -> text + CHECK, adding 'unclassified'.
--      Same tradeoff 005 made for leads.status: Postgres cannot remove enum
--      values and the set must stay editable (and ALTER TYPE ... ADD VALUE
--      cannot run reliably inside the runner's statement batching). NOTE:
--      'unclassified' is ALSO added to the live message_status enum by an
--      idempotent ALTER TYPE ... ADD VALUE IF NOT EXISTS below, so a fresh
--      install and an existing install converge to the same state either way.
--      'unclassified' is the HONEST placeholder for inbound SMS stored while
--      no LLM is configured: the message is real, no AI parse exists yet, and
--      nothing is invented. When classification runs (LLM configured), the
--      row is updated to 'delivered' + a classification payload.
--   2) messages.classification jsonb — the LLM's structured parse of an
--      inbound message (service need / urgency / priority / contact / address
--      / safety flag + model used). NULL = never classified; never a guess.
--   3) sms_opt_outs — TCPA/10DLC compliance. HARD RULE documented here and in
--      src/lib/server/textBack.ts: once a phone is in this table for a
--      business, NO outbound SMS of any kind (text-back, HELP/START replies,
--      notifications) may ever be sent to that number for that business,
--      forever. A STOP reply persists here even if the caller later texts
--      something else; only an explicit START/UNSTOP reply (or the owner
--      deleting the row deliberately) removes it. Unique per (business,
--      phone): opt-outs are per-company, matching A2P campaign semantics.
-- Every statement is idempotent so a partially-applied run can re-apply.
ALTER TYPE message_status ADD VALUE IF NOT EXISTS 'unclassified';
ALTER TABLE messages ALTER COLUMN status TYPE text USING status::text;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_status_check
  CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'unclassified'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS classification jsonb;
CREATE TABLE IF NOT EXISTS sms_opt_outs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- E.164-normalized customer phone (src/lib/smsCommands.ts normalizePhone).
  phone           text NOT NULL,
  -- 'stop_reply' (customer texted STOP) | 'owner_added' (manual).
  reason          text NOT NULL DEFAULT 'stop_reply'
                  CONSTRAINT sms_opt_outs_reason_check CHECK (reason IN ('stop_reply', 'owner_added')),
  -- The inbound message SID that carried the STOP, when known.
  source_message_sid text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One row per business+phone: re-STOPing an opted-out number is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS sms_opt_outs_business_phone_key ON sms_opt_outs (business_id, phone);
CREATE INDEX IF NOT EXISTS sms_opt_outs_business_created_idx ON sms_opt_outs (business_id, created_at DESC);
DROP TRIGGER IF EXISTS set_updated_at_sms_opt_outs ON sms_opt_outs;
CREATE TRIGGER set_updated_at_sms_opt_outs
  BEFORE UPDATE ON sms_opt_outs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
