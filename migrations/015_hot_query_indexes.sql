-- 015_hot_query_indexes.sql — Phase 3 reliability pass: hot-query index review.
--
-- Audit scope: the hottest read paths were profiled with EXPLAIN (ANALYZE,
-- BUFFERS) against the live Neon schema — leads list/search/count, the inbox
-- conversation list, the revenue funnel/recovery aggregates, call history,
-- and the admin accounts/audit search+pagination queries.
--
-- Policy (deliberate, matching the brief):
--   * ADDITIVE ONLY — CREATE INDEX IF NOT EXISTS; no column changes, no
--     backfills, no data changes, replay-safe.
--   * Only indexes with a clear per-query justification land here. ILIKE
--     lead search deliberately gets NO pg_trgm index: the search runs
--     inside one business's rows (hundreds, not millions), where the
--     business_id index + heap scan is already sub-millisecond, and a
--     trigram GIN index would tax every lead write for no user-visible gain.
--   * Several of these cover aggregates that run on EVERY dashboard,
--     analytics, and admin-health load, so each avoids per-request heap
--     scans / sorts as data grows.

-- ---------------------------------------------------------------------------
-- 1. Missed-call recovery aggregates (dashboard + analytics + admin detail).
--    Query shape (src/db/queries/leads.ts missedCallRecoveryStats,
--    src/db/queries/revenue.ts missedCallRecoveryCounts):
--      SELECT DISTINCT lead_id FROM conversations
--      WHERE lead_id IS NOT NULL AND business_id = $1
--    Business-scoped + lead-linked, in one partial composite: index-only
--    scan, pre-ordered for the DISTINCT (no sort, no heap fetch).
CREATE INDEX IF NOT EXISTS idx_conversations_business_lead
  ON conversations (business_id, lead_id) WHERE lead_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Inbox newest-first (the hottest app page).
--    Query shape (src/db/queries/conversations.ts listConversations):
--      SELECT * FROM conversations WHERE business_id = $1
--      ORDER BY updated_at DESC LIMIT .. OFFSET ..
--    Existing (business_id) and (business_id, status) cannot serve the
--    recency sort; this turns page 1 of the inbox into a straight
--    index scan with no sort step.
CREATE INDEX IF NOT EXISTS idx_conversations_business_updated
  ON conversations (business_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Pipeline-stage filtered leads list.
--    Query shape (src/db/queries/leads.ts listLeads with a status filter —
--    the default CRM view for each pipeline column):
--      SELECT * FROM leads WHERE business_id = $1 AND status = $2
--      ORDER BY created_at DESC LIMIT 50
--    (business_id, status) filters then sorts; the created_at tail makes
--    the top-50 a direct index read. The unfiltered list is already
--    covered by leads_business_created_at_idx.
CREATE INDEX IF NOT EXISTS idx_leads_business_status_created
  ON leads (business_id, status, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Funnel "appointments" stage (dashboard + analytics + admin health).
--    Query shape (src/db/queries/revenue.ts revenueFunnelCounts):
--      SELECT count(DISTINCT lead_id) FROM appointments
--      WHERE business_id = $1 AND lead_id IS NOT NULL
--    Partial composite → index-only distinct count per business; the
--    existing appointments_lead_id_idx only serves the join probes.
CREATE INDEX IF NOT EXISTS idx_appointments_business_lead
  ON appointments (business_id, lead_id) WHERE lead_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Admin audit log, action-filtered page + count.
--    Query shape (src/db/queries/admin.ts listAdminAudit/countAdminAudit):
--      SELECT * FROM admin_audit WHERE action = $1
--      ORDER BY created_at DESC LIMIT 50 OFFSET ..
--    idx_admin_audit_created (created_at DESC) only covers the unfiltered
--    page; action-filtered reads seq-scanned. (action, created_at DESC)
--    serves both filter+order in one index.
CREATE INDEX IF NOT EXISTS idx_admin_audit_action_created
  ON admin_audit (action, created_at DESC);
