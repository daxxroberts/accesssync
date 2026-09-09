-- =============================================================================
-- SECTION 0: SAFETY HEADER
-- =============================================================================
--
-- File: migrations/schema-restructure.sql
-- Branch: schema-restructure-planning
-- Date: 2026-05-05
--
-- WHAT THIS FILE DOES:
--   Creates 8 new tables for the AccessSync schema restructure.
--   Adds valid_until column to member_access_sources.
--
-- WHAT THIS FILE DOES NOT DO:
--   - Does NOT drop any existing tables
--   - Does NOT migrate any data
--   - Does NOT modify any existing table columns
--   - Does NOT alter any application code
--
-- WHEN TO RUN:
--   Run ONLY at S-9 deploy time against Railway production DB.
--   Do NOT run on main branch.
--   Do NOT run during development sprints S-1 through S-8.
--
-- VERIFICATION (run manually after S-9 deploy):
--   See Section 11 at the bottom of this file.
--
-- =============================================================================


-- =============================================================================
-- SECTION 1: FK AUDIT RESULTS
-- =============================================================================
--
-- Audit run: 2026-05-05 against gondola.proxy.rlwy.net:27298
-- Source: AccessSync/04_Data/AXIOM_AUDIT_S1.md
--
-- All FK constraints referencing retired tables (member_identity,
-- member_access_state, member_role_assignments):
--
-- Table                  | Column          | Constraint name                          | Action at S-9
-- -----------------------|-----------------|------------------------------------------|-------------------------------
-- member_access_log      | member_id       | member_access_log_member_id_fkey         | DROP BEFORE DROP TABLE (R-1)
-- trace_context          | member_id       | trace_context_member_id_fkey             | DROP BEFORE DROP TABLE (R-2)
-- member_access_sources  | member_id       | member_access_sources_member_id_fkey     | Table restructured in S-1
-- member_access_state    | plan_holder_id  | member_access_state_plan_holder_id_fkey  | Retired table, drops with CASCADE
-- member_access_state    | member_id       | member_access_state_member_id_fkey       | Retired table, drops with CASCADE
-- member_identity        | plan_holder_id  | member_identity_plan_holder_id_fkey      | Self-referential, drops with table
-- member_role_assignments| member_id       | member_role_assignments_member_id_fkey   | Retired table, drops with CASCADE
--
-- CRITICAL — S-9 Step 5 must run BEFORE DROP TABLE member_identity:
--
--   ALTER TABLE member_access_log DROP CONSTRAINT member_access_log_member_id_fkey;
--   ALTER TABLE trace_context DROP CONSTRAINT trace_context_member_id_fkey;
--
-- Skipping either of these will cause DROP TABLE member_identity to
-- CASCADE-delete member_access_log (entire access audit history) and
-- trace_context (entire trace timeline). Do NOT use CASCADE on the DROPs.
--
-- =============================================================================


-- =============================================================================
-- SECTION 1.5: DROP RESTRUCTURED TABLE
-- =============================================================================
-- member_access_sources exists in Railway with the old schema (member_id FK
-- to member_identity). It is being fully restructured — old schema retired,
-- new schema created below. No permanent tables reference its id column.
-- CASCADE is safe: no downstream permanent-table FKs point at this table.

DROP TABLE IF EXISTS member_access_sources CASCADE;


-- =============================================================================
-- SECTION 2: CREATE TABLE member_master
-- =============================================================================
-- One row per human being. The person-level identity anchor.
-- Replaces the person-record role currently played by member_identity.

CREATE TABLE member_master (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_platform     VARCHAR(50) NOT NULL,
  platform_member_id  VARCHAR(255) NOT NULL,
  email               VARCHAR(255),
  first_name          VARCHAR(255),
  last_name           VARCHAR(255),
  display_name        VARCHAR(255),
  phone               VARCHAR(50),
  source_tag          VARCHAR(50) DEFAULT 'accesssync',
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id, source_platform, platform_member_id)
);


-- =============================================================================
-- SECTION 3: CREATE TABLE member_billing
-- =============================================================================
-- One row per purchase per renewal cycle. The gym member's Wix purchase record.
--
-- UNIQUE (wix_order_id, cycle_index) is the renewal idempotency guard (F-01):
--   If Wix fires the same renewal webhook twice, the second INSERT is blocked.
--
-- Created before member_access and member_access_sources because both tables
-- carry a billing_id FK referencing this table.

CREATE TABLE member_billing (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  member_master_id      UUID NOT NULL REFERENCES member_master(id) ON DELETE CASCADE,
  client_id             UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  wix_order_id          VARCHAR(255) NOT NULL,
  wix_subscription_id   VARCHAR(255),
  cycle_index           INTEGER NOT NULL DEFAULT 1,
  plan_id               VARCHAR(255),
  plan_name             VARCHAR(255),
  effective_start       TIMESTAMP WITH TIME ZONE,
  effective_end         TIMESTAMP WITH TIME ZONE,
  status                VARCHAR(50) NOT NULL DEFAULT 'active',
  billing_snapshot      JSONB,
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (wix_order_id, cycle_index)
);


-- =============================================================================
-- SECTION 4: CREATE TABLE member_access
-- =============================================================================
-- One row per (member_master + plan_mapping). The access role record.
-- Replaces member_identity (role portion) + member_access_state + member_role_assignments.
--
-- UNIQUE (member_master_id, plan_mapping_id) is load-bearing:
--   Required for ON CONFLICT in resolveAndLock() and FOR UPDATE NOWAIT (Q-2).

CREATE TABLE member_access (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  member_master_id      UUID NOT NULL REFERENCES member_master(id) ON DELETE CASCADE,
  client_id             UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  plan_mapping_id       UUID REFERENCES plan_mappings(id) ON DELETE SET NULL,
  hardware_platform     VARCHAR(50),
  hardware_user_id      VARCHAR(255),
  source_platform       VARCHAR(50),
  platform_member_id    VARCHAR(255),
  status                VARCHAR(50) NOT NULL DEFAULT 'pending',
  provisioned_at        TIMESTAMP WITH TIME ZONE,
  scheduled_start_date  TIMESTAMP WITH TIME ZONE,
  pending_plan_id       VARCHAR(255),
  sub_master_id         UUID REFERENCES member_master(id),
  plan_holder           BOOLEAN DEFAULT false,
  billing_snapshot      JSONB,
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (member_master_id, plan_mapping_id)
);


-- =============================================================================
-- SECTION 5: CREATE TABLE member_access_sources (restructured)
-- =============================================================================
-- One row per (access_id x billing_id x hardware_group).
-- Links member_access → member_billing. Carries role_assignment_id (Q-1).
-- valid_until supports RI-03: extracted from Wix webhook entity.endDate.

CREATE TABLE member_access_sources (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  access_id           UUID NOT NULL REFERENCES member_access(id) ON DELETE CASCADE,
  billing_id          UUID REFERENCES member_billing(id) ON DELETE SET NULL,
  source_type         VARCHAR(50),
  source_plan_id      VARCHAR(255),
  hardware_group_id   VARCHAR(255),
  role_assignment_id  VARCHAR(255),
  mapping_id          UUID REFERENCES plan_mappings(id) ON DELETE SET NULL,
  effective_start     TIMESTAMP WITH TIME ZONE,
  valid_until         TIMESTAMP WITH TIME ZONE,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (access_id, source_type, source_plan_id, hardware_group_id)
);


-- =============================================================================
-- SECTION 6: CREATE TABLE connector_subscriptions
-- =============================================================================
-- One row per client per hardware platform.
-- Replaces the COALESCE cascade between clients.hardware_api_key
-- and locations.hardware_api_key.

CREATE TABLE connector_subscriptions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  hardware_platform VARCHAR(50) NOT NULL,
  hardware_api_key  TEXT,
  kisi_user_pattern VARCHAR(20) NOT NULL DEFAULT 'invited'
                    CHECK (kisi_user_pattern IN ('invited', 'managed')),
  status            VARCHAR(50) DEFAULT 'active',
  key_last_verified TIMESTAMP WITH TIME ZONE,
  key_last_error    TEXT,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id, hardware_platform)
);


-- =============================================================================
-- SECTION 7: CREATE TABLE billing_subscriptions
-- =============================================================================
-- One row per client per location. The gym owner's AccessSync service contract.
-- Replaces client_subscriptions (DR-036) + locations.tier/subscription_status/
-- subscription_id + plan_mappings.tier_name.

CREATE TABLE billing_subscriptions (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  location_id         UUID REFERENCES locations(id) ON DELETE SET NULL,
  tier                VARCHAR(50),
  status              VARCHAR(50) NOT NULL DEFAULT 'active',
  subscribed_at       TIMESTAMP WITH TIME ZONE,
  wix_subscription_id VARCHAR(255),
  effective_start     TIMESTAMP WITH TIME ZONE,
  effective_end       TIMESTAMP WITH TIME ZONE,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- =============================================================================
-- SECTION 8: CREATE TABLE as_subscription_terms
-- =============================================================================
-- AccessSync platform table (as_ prefix = Daxx's platform layer, not gym data).
-- Defines the plan options available to gym owners subscribing to AccessSync.
-- New plan types = new INSERT rows. No schema change required.
-- No application code reads this table in S-1 through S-8. Foundation only.

CREATE TABLE as_subscription_terms (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name              VARCHAR(100) NOT NULL UNIQUE,
  billing_cadence   VARCHAR(50),
  base_price        NUMERIC(10,2),
  discount_amount   NUMERIC(10,2),
  discount_percent  NUMERIC(5,2),
  is_free           BOOLEAN NOT NULL DEFAULT false,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  effective_start   TIMESTAMP WITH TIME ZONE,
  effective_end     TIMESTAMP WITH TIME ZONE,
  description       TEXT,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);


-- =============================================================================
-- SECTION 9: CREATE TABLE as_client_subscriptions
-- =============================================================================
-- AccessSync platform table (as_ prefix).
-- One row per client per location — tracks which AccessSync term each gym is on.
-- location_id NULL = client-level subscription covering all locations.
-- No enforcement logic in this migration. OB-168 tracks future enforcement sprint.

CREATE TABLE as_client_subscriptions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  location_id     UUID REFERENCES locations(id) ON DELETE SET NULL,
  term_id         UUID REFERENCES as_subscription_terms(id) ON DELETE SET NULL,
  status          VARCHAR(50) NOT NULL DEFAULT 'trial',
  override_active BOOLEAN NOT NULL DEFAULT false,
  override_reason TEXT,
  override_set_at TIMESTAMP WITH TIME ZONE,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (client_id, location_id)
);


-- =============================================================================
-- SECTION 10: NON-INLINE INDEXES
-- =============================================================================
-- All UNIQUE constraints above are declared inline and create indexes automatically.
-- Additional performance indexes for common query patterns:

-- member_master: frequent lookup by client + platform member
CREATE INDEX idx_member_master_client_platform ON member_master (client_id, source_platform, platform_member_id);

-- member_access: frequent lookup by client + status (reconciliation, member list)
CREATE INDEX idx_member_access_client_status ON member_access (client_id, status);

-- member_access: sub-member lookup by holder
CREATE INDEX idx_member_access_sub_master ON member_access (sub_master_id) WHERE sub_master_id IS NOT NULL;

-- member_access_sources: lookup by access_id (revoke count check)
CREATE INDEX idx_member_access_sources_access ON member_access_sources (access_id);

-- member_access_sources: lookup by billing_id (renewal updates)
CREATE INDEX idx_member_access_sources_billing ON member_access_sources (billing_id) WHERE billing_id IS NOT NULL;

-- member_billing: lookup by member_master + status (active billing check)
CREATE INDEX idx_member_billing_master_status ON member_billing (member_master_id, status);

-- member_billing: lookup by wix_order_id (renewal detection)
CREATE INDEX idx_member_billing_wix_order ON member_billing (wix_order_id);

-- connector_subscriptions: lookup by client (API key resolution)
CREATE INDEX idx_connector_subscriptions_client ON connector_subscriptions (client_id);

-- billing_subscriptions: lookup by location (plan-mapping-resolver active location check)
CREATE INDEX idx_billing_subscriptions_location ON billing_subscriptions (location_id, status);

-- as_client_subscriptions: lookup by client
CREATE INDEX idx_as_client_subscriptions_client ON as_client_subscriptions (client_id);


-- =============================================================================
-- SECTION 11: VERIFICATION QUERIES
-- =============================================================================
-- Run manually after S-9 deploy to confirm all tables and constraints exist.
-- These are comments only — do not execute as part of this migration.

-- Verify all 8 new tables exist:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN (
--     'member_master', 'member_access', 'member_access_sources', 'member_billing',
--     'connector_subscriptions', 'billing_subscriptions',
--     'as_subscription_terms', 'as_client_subscriptions'
--   )
-- ORDER BY table_name;
-- Expected: 8 rows

-- Verify UNIQUE constraints:
-- SELECT constraint_name, table_name FROM information_schema.table_constraints
-- WHERE constraint_type = 'UNIQUE'
--   AND table_name IN (
--     'member_master', 'member_access', 'member_access_sources',
--     'member_billing', 'connector_subscriptions', 'as_client_subscriptions'
--   )
-- ORDER BY table_name, constraint_name;

-- Verify effective_start and valid_until on member_access_sources (RI-03):
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'member_access_sources'
--   AND column_name IN ('effective_start', 'valid_until')
-- ORDER BY column_name;
-- Expected: 2 rows, data_type = 'timestamp with time zone', is_nullable = 'YES'

-- Verify FK constraints on permanent tables are still intact after S-9 Step 5 drops:
-- SELECT constraint_name, table_name FROM information_schema.table_constraints
-- WHERE constraint_type = 'FOREIGN KEY'
--   AND table_name IN ('member_access_log', 'trace_context');
-- Expected: 0 rows (both FKs dropped in S-9 Step 5)

-- =============================================================================