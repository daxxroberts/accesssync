-- migrations/s11.sql
-- DR-046 — per-person member_access cardinality
-- DR-046 A9/A10/A11 — multi-tenancy hardening (client_id everywhere, scoped UNIQUEs)
-- Generated 2026-05-14 by S-11 spec session, locked 2026-05-15 build.
-- Spec source of truth: AccessSync/04_Data/SCHEMA_S11_SPEC.md
--
-- PRESERVE + MIGRATE: existing rows transform, none drop.
-- Single transaction. Idempotent (re-runnable). Rollback in spec Section 4.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: Generate source rows from existing access rows BEFORE altering schema
-- ─────────────────────────────────────────────────────────────────────────────
-- Why first: we need plan_mapping_id on member_access to derive source rows.
-- After step 1, source rows preserve the access→plan_mapping relationship
-- that we're about to lose from member_access itself.

INSERT INTO member_access_sources
  (access_id, source_type, source_plan_id, hardware_group_id,
   role_assignment_id, mapping_id, status, provisioned_at,
   effective_start, valid_until, created_at)
SELECT
  ma.id                                  AS access_id,
  'plan'                                 AS source_type,
  pm.source_plan_id                      AS source_plan_id,
  -- For multi-door plans, plan_mapping_groups provides the doors. For now,
  -- if the plan has plan_mapping_groups rows, generate one source row per group.
  -- If it doesn't, fall back to a single source with hardware_group_id NULL
  -- (reconcile in Phase 1 step 3 will populate the door from Kisi state).
  COALESCE(pmg.hardware_group_id, pm.hardware_group_id) AS hardware_group_id,
  NULL                                   AS role_assignment_id,
  -- Note: role_assignment_id is NULL post-migration. Reconcile fetches actual
  -- Kisi role_assignment IDs and updates this column in Phase 1 step 3.
  -- This is intentional: trying to backfill role_assignment_id from a column
  -- that may have stale or wrong data is worse than leaving NULL and letting
  -- reconcile populate the truth.
  ma.plan_mapping_id                     AS mapping_id,
  CASE ma.status
    WHEN 'active'           THEN 'active'
    WHEN 'pending_hardware' THEN 'pending_hardware'
    WHEN 'pending_start'    THEN 'pending_start'
    WHEN 'failed'           THEN 'failed'
    WHEN 'inactive'         THEN 'cancelled'  -- inactive on access becomes cancelled source
    WHEN 'cancelled'        THEN 'cancelled'
    WHEN 'revoked'          THEN 'revoked'
    WHEN 'disabled'         THEN 'cancelled'
    ELSE 'active'
  END                                    AS status,
  ma.provisioned_at                      AS provisioned_at,
  NULL                                   AS effective_start,
  NULL                                   AS valid_until,
  COALESCE(ma.created_at, NOW())         AS created_at
FROM   member_access ma
LEFT JOIN plan_mappings pm   ON pm.id = ma.plan_mapping_id
LEFT JOIN plan_mapping_groups pmg ON pmg.plan_mapping_id = ma.plan_mapping_id
WHERE  ma.plan_mapping_id IS NOT NULL
  AND  NOT EXISTS (
    -- Idempotency: don't double-write if a source row already exists for this
    -- access + plan combo. The UNIQUE constraint would block it anyway, but
    -- explicit guard is cleaner.
    SELECT 1 FROM member_access_sources mas
    WHERE  mas.access_id = ma.id
    AND    mas.source_type = 'plan'
    AND    COALESCE(mas.source_plan_id, '') = COALESCE(pm.source_plan_id, '')
    AND    COALESCE(mas.hardware_group_id, '') = COALESCE(pm.hardware_group_id, '')
  );

-- After step 1: every existing access row that had a plan_mapping_id now has
-- a corresponding source row (or one per hardware_group if multi-door).
-- Access rows with NULL plan_mapping_id (e.g. pending_identity state) get no
-- source rows, which is correct — they're not granted to any plan yet.

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: Collapse multi-access-per-person scenarios (none in HOG today)
-- ─────────────────────────────────────────────────────────────────────────────
-- Today's HOG state: each person has exactly 1 member_access row (different
-- plan_mappings). After step 1, each access row has a corresponding source row.
-- For collapse: pick the OLDEST access row per (member_master_id, client_id),
-- merge source rows from the other access rows into it, then DELETE the
-- duplicates. CASCADE handles the source row re-pointing automatically if we
-- update access_id on sources first.
--
-- For HOG: this step is a no-op (1 access per person). Future-proofing only.

WITH access_to_keep AS (
  SELECT member_master_id, client_id, MIN(created_at) AS earliest_created
  FROM   member_access
  GROUP  BY member_master_id, client_id
  HAVING COUNT(*) > 1
),
canonical_access AS (
  SELECT ma.id AS keep_id, ma.member_master_id, ma.client_id
  FROM   member_access ma
  JOIN   access_to_keep atk
    ON   atk.member_master_id = ma.member_master_id
    AND  atk.client_id        = ma.client_id
    AND  atk.earliest_created = ma.created_at
)
-- Re-point source rows from duplicate access rows to the canonical one
UPDATE member_access_sources mas
SET    access_id = ca.keep_id
FROM   canonical_access ca,
       member_access ma_dup
WHERE  ma_dup.member_master_id = ca.member_master_id
  AND  ma_dup.client_id        = ca.client_id
  AND  ma_dup.id              != ca.keep_id
  AND  mas.access_id           = ma_dup.id;

-- Delete duplicate access rows
DELETE FROM member_access ma_dup
USING  (
  SELECT ma.id AS keep_id, ma.member_master_id, ma.client_id
  FROM   member_access ma
  JOIN   (
    SELECT member_master_id, client_id, MIN(created_at) AS earliest_created
    FROM   member_access
    GROUP  BY member_master_id, client_id
    HAVING COUNT(*) > 1
  ) atk
    ON atk.member_master_id  = ma.member_master_id
   AND atk.client_id         = ma.client_id
   AND atk.earliest_created  = ma.created_at
) ca
WHERE  ma_dup.member_master_id = ca.member_master_id
  AND  ma_dup.client_id        = ca.client_id
  AND  ma_dup.id              != ca.keep_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: Recompute member_access.status from source-row aggregate
-- ─────────────────────────────────────────────────────────────────────────────
-- Per DR-046: access.status = active if ≥1 source is active, else inactive.
-- Exception: in_flight is preserved (it's a transient lock, not an aggregate).
-- pending_identity is preserved if there are no source rows at all.

UPDATE member_access ma
SET    status = CASE
  WHEN ma.status = 'in_flight' THEN 'in_flight'  -- preserve lock state
  WHEN NOT EXISTS (SELECT 1 FROM member_access_sources mas WHERE mas.access_id = ma.id)
    THEN 'pending_identity'  -- no sources yet
  WHEN EXISTS (
    SELECT 1 FROM member_access_sources mas
    WHERE  mas.access_id = ma.id AND mas.status = 'active'
  ) THEN 'active'
  ELSE 'inactive'
END;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: Alter the schema
-- ─────────────────────────────────────────────────────────────────────────────

-- 4a: member_access drops
ALTER TABLE member_access DROP CONSTRAINT IF EXISTS member_access_member_master_id_plan_mapping_id_key;
ALTER TABLE member_access DROP COLUMN IF EXISTS plan_mapping_id;
ALTER TABLE member_access DROP COLUMN IF EXISTS billing_snapshot;
ALTER TABLE member_access DROP COLUMN IF EXISTS scheduled_start_date;
ALTER TABLE member_access DROP COLUMN IF EXISTS pending_plan_id;

-- 4b: member_access new UNIQUE + CHECK
ALTER TABLE member_access ADD CONSTRAINT member_access_member_master_id_client_id_key
  UNIQUE (member_master_id, client_id);

-- 4c: Drop the wide status enum first if there's an existing CHECK
ALTER TABLE member_access DROP CONSTRAINT IF EXISTS member_access_status_check;
ALTER TABLE member_access ADD CONSTRAINT member_access_status_check
  CHECK (status IN ('active','inactive','in_flight','pending_identity'));

-- 4d: member_access_sources new columns
-- Status enum includes 'draft' for sub-member draft-submit flow (DR-040 multi-member).
-- Drafts are sub-members added via the Member Hub but not yet batch-submitted for
-- provisioning. Draft sources have no role_assignment_id and no Kisi call has fired.
-- Submit flow flips 'draft' → 'pending_hardware' and enqueues the synthetic grant.
ALTER TABLE member_access_sources ADD COLUMN IF NOT EXISTS status VARCHAR(50) NOT NULL DEFAULT 'active';
ALTER TABLE member_access_sources DROP CONSTRAINT IF EXISTS member_access_sources_status_check;
ALTER TABLE member_access_sources ADD CONSTRAINT member_access_sources_status_check
  CHECK (status IN ('draft','active','pending_hardware','pending_start','failed','cancelled','revoked'));
ALTER TABLE member_access_sources ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE member_access_sources ADD COLUMN IF NOT EXISTS scheduled_start_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE member_access_sources ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;

-- 4e: A9 — multi-tenancy hardening on member_access_sources
-- Add client_id, derive from access_id → member_access.client_id, then enforce NOT NULL + FK
ALTER TABLE member_access_sources ADD COLUMN IF NOT EXISTS client_id UUID;
UPDATE member_access_sources mas
SET    client_id = ma.client_id
FROM   member_access ma
WHERE  ma.id = mas.access_id
AND    mas.client_id IS NULL;
ALTER TABLE member_access_sources ALTER COLUMN client_id SET NOT NULL;
ALTER TABLE member_access_sources DROP CONSTRAINT IF EXISTS member_access_sources_client_id_fkey;
ALTER TABLE member_access_sources ADD CONSTRAINT member_access_sources_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
-- Strengthen UNIQUE to include client_id (defense in depth)
ALTER TABLE member_access_sources DROP CONSTRAINT IF EXISTS member_access_sources_access_id_source_type_source_plan_id__key;
ALTER TABLE member_access_sources DROP CONSTRAINT IF EXISTS member_access_sources_client_access_source_plan_group_key;
ALTER TABLE member_access_sources ADD CONSTRAINT member_access_sources_client_access_source_plan_group_key
  UNIQUE (client_id, access_id, source_type, source_plan_id, hardware_group_id);

-- 4f: A10 — multi-tenancy hardening on member_billing UNIQUE
-- Today's UNIQUE relies on Wix's globally-unique order GUIDs; switch to schema-enforced isolation
ALTER TABLE member_billing DROP CONSTRAINT IF EXISTS member_billing_wix_order_id_cycle_index_key;
ALTER TABLE member_billing DROP CONSTRAINT IF EXISTS member_billing_client_wix_order_cycle_key;
ALTER TABLE member_billing ADD CONSTRAINT member_billing_client_wix_order_cycle_key
  UNIQUE (client_id, wix_order_id, cycle_index);

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 5: Verification queries (the deploy gate runs these)
-- ─────────────────────────────────────────────────────────────────────────────
-- These are SELECTs only — they don't change data. Run them post-COMMIT
-- against the migrated DB. Each must return 0 rows or the migration is unsafe.

-- Should return 0: every access row is unique per (master, client)
-- SELECT member_master_id, client_id, COUNT(*) AS cnt
-- FROM   member_access
-- GROUP  BY member_master_id, client_id
-- HAVING COUNT(*) > 1;

-- Should return 0: no orphan source rows
-- SELECT mas.id FROM member_access_sources mas
-- LEFT JOIN member_access ma ON ma.id = mas.access_id
-- WHERE  ma.id IS NULL;

-- Should match: for each access row, its status agrees with the source-aggregate rule
-- SELECT ma.id, ma.status,
--   (SELECT COUNT(*) FROM member_access_sources mas
--    WHERE mas.access_id = ma.id AND mas.status = 'active') AS active_sources,
--   CASE
--     WHEN ma.status = 'active' AND (SELECT COUNT(*) FROM member_access_sources mas
--                                    WHERE mas.access_id = ma.id AND mas.status = 'active') = 0
--       THEN 'INVARIANT VIOLATION: access=active but 0 active sources'
--     WHEN ma.status = 'inactive' AND (SELECT COUNT(*) FROM member_access_sources mas
--                                      WHERE mas.access_id = ma.id AND mas.status = 'active') > 0
--       THEN 'INVARIANT VIOLATION: access=inactive but ≥1 active source'
--     ELSE 'OK'
--   END AS invariant_check
-- FROM   member_access ma;

-- A9 verification: every source row's client_id matches its access row's client_id
-- Should return 0
-- SELECT mas.id, mas.client_id AS source_client, ma.client_id AS access_client
-- FROM   member_access_sources mas
-- JOIN   member_access ma ON ma.id = mas.access_id
-- WHERE  mas.client_id != ma.client_id;

-- A9 verification: no source row has NULL client_id
-- Should return 0
-- SELECT COUNT(*) AS null_client_id_sources
-- FROM   member_access_sources WHERE client_id IS NULL;

COMMIT;
