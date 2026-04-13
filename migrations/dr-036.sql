-- DR-036: Client Subscriptions Table (Platform-Agnostic Billing Model)
-- Date: 2026-04-13
-- Author: ORION / KEEPER
-- Approved by: Daxx
--
-- PURPOSE:
--   Introduces `client_subscriptions` as the authoritative billing record per operator subscription.
--   Links locations to subscriptions via `tier_subscription_id` FK.
--   Supersedes standalone `locations.tier`, `locations.subscription_status`,
--   `locations.subscribed_at`, `locations.subscription_id`, and `plan_mappings.tier_name`.
--
-- PHASE 1 ONLY (additive — no removals):
--   This migration creates the new table and FK, then backfills existing location data.
--   Redundant columns on `locations` and `plan_mappings` are NOT dropped here.
--   Column removal happens in a future migration after Phase 2 dual-read is validated in production.
--
-- PREREQUISITES:
--   - DR-027 migration applied (locations.tier, subscription_status, subscribed_at, subscription_id exist)
--   - DR-035 migration applied (hardware_api_key column names correct)
--   - sprint-5.sql applied
--
-- RUN ON RAILWAY:
--   psql $DATABASE_PUBLIC_URL -f migrations/dr-036.sql

BEGIN;

-- ============================================================
-- STEP 1: Create client_subscriptions table
-- ============================================================

CREATE TABLE IF NOT EXISTS client_subscriptions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    subscription_source VARCHAR(50) NOT NULL,                           -- 'wix', 'squarespace', 'accesssync', etc.
    subscription_id     TEXT NOT NULL,                                  -- platform-native subscription/order reference ID
    tier                VARCHAR(50) NOT NULL,                           -- 'Base', 'Pro', 'Connect'
    status              VARCHAR(50) NOT NULL DEFAULT 'trial',           -- 'trial', 'active', 'suspended', 'cancelled'
    trial_ends_at       TIMESTAMP WITH TIME ZONE,                       -- NULL = no trial. Set = trial clock start.
    activated_at        TIMESTAMP WITH TIME ZONE,                       -- when subscription became active (billing start)
    cancelled_at        TIMESTAMP WITH TIME ZONE,                       -- when subscription was cancelled
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (subscription_source, subscription_id)                       -- idempotency: prevents duplicate billing webhook rows
);

-- ============================================================
-- STEP 2: Add tier_subscription_id FK to locations
-- ============================================================

ALTER TABLE locations
    ADD COLUMN IF NOT EXISTS tier_subscription_id UUID REFERENCES client_subscriptions(id) ON DELETE SET NULL;

-- ============================================================
-- STEP 3: Backfill — create client_subscriptions rows from existing location data
-- ============================================================
-- For every location that already has tier + subscription_status data,
-- create a client_subscriptions row and link it via tier_subscription_id.
-- Locations with no tier or a NULL subscription_id get a synthetic 'accesssync' source row
-- so they are linkable and not treated as orphans.
--
-- NOTE: locations.subscription_id may be NULL for manually-created locations.
-- In that case we generate a synthetic subscription_id from the location UUID.

WITH backfill AS (
    INSERT INTO client_subscriptions (
        client_id,
        subscription_source,
        subscription_id,
        tier,
        status,
        activated_at,
        created_at
    )
    SELECT
        l.client_id,
        CASE
            WHEN l.subscription_id IS NOT NULL AND c.platform = 'wix'  THEN 'wix'
            WHEN l.subscription_id IS NOT NULL                           THEN COALESCE(c.platform, 'accesssync')
            ELSE 'accesssync'
        END                                                     AS subscription_source,
        COALESCE(l.subscription_id, 'legacy-' || l.id::text)   AS subscription_id,
        COALESCE(l.tier, c.tier, 'Base')                        AS tier,
        CASE
            WHEN l.subscription_status = 'active'   THEN 'active'
            WHEN l.subscription_status = 'lapsed'   THEN 'suspended'
            WHEN l.subscription_status = 'inactive' THEN 'trial'
            ELSE 'trial'
        END                                                     AS status,
        l.subscribed_at                                         AS activated_at,
        l.created_at
    FROM locations l
    JOIN clients c ON l.client_id = c.id
    ON CONFLICT (subscription_source, subscription_id) DO NOTHING
    RETURNING id, subscription_id, client_id
)
UPDATE locations l
SET tier_subscription_id = backfill.id
FROM backfill
WHERE
    (COALESCE(l.subscription_id, 'legacy-' || l.id::text) = backfill.subscription_id)
    AND l.client_id = backfill.client_id;

-- ============================================================
-- STEP 4: Indexes for common query patterns
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_client_subscriptions_client_id
    ON client_subscriptions (client_id);

CREATE INDEX IF NOT EXISTS idx_client_subscriptions_status
    ON client_subscriptions (status);

CREATE INDEX IF NOT EXISTS idx_locations_tier_subscription_id
    ON locations (tier_subscription_id)
    WHERE tier_subscription_id IS NOT NULL;

-- ============================================================
-- STEP 5: Verification queries (run manually after migration to confirm)
-- ============================================================
-- Confirm client_subscriptions row count matches locations row count:
--   SELECT COUNT(*) FROM client_subscriptions;
--   SELECT COUNT(*) FROM locations;
--
-- Confirm all locations are linked:
--   SELECT COUNT(*) FROM locations WHERE tier_subscription_id IS NULL;
--   -- Should be 0 after backfill
--
-- Confirm tier values look correct:
--   SELECT cs.tier, cs.status, cs.subscription_source, l.name
--   FROM locations l
--   JOIN client_subscriptions cs ON l.tier_subscription_id = cs.id
--   ORDER BY cs.tier, l.name;
--
-- Confirm no orphan subscriptions:
--   SELECT cs.id FROM client_subscriptions cs
--   LEFT JOIN locations l ON l.tier_subscription_id = cs.id
--   WHERE l.id IS NULL;
--   -- Should return 0 rows (one subscription per location in V1)

COMMIT;

-- ============================================================
-- PHASE 2 REMINDER (run separately after code dual-read deployed):
-- ============================================================
-- Once all 7 breaking files are updated to COALESCE(cs.column, l.column),
-- run verification in production for 2–3 weeks, then proceed to removal:
--
--   ALTER TABLE locations DROP COLUMN tier;
--   ALTER TABLE locations DROP COLUMN subscription_status;
--   ALTER TABLE locations DROP COLUMN subscribed_at;
--   ALTER TABLE locations DROP COLUMN subscription_id;
--   ALTER TABLE plan_mappings DROP COLUMN tier_name;
--
-- Do NOT run the above until OB-69 (dual-read) + OB-70 (validation) are both CLOSED.
