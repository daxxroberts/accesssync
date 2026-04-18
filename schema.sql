-- AccessSync V1 Database Schema
-- Reconciled 2026-04-10: all migrations folded in, reflects live Railway DB state.
-- Engine: PostgreSQL
--
-- Migration history folded in:
--   ob-19.sql          — per-location subscription model + API key storage (DR-027, DR-028)
--   dr-035.sql         — platform-agnostic column renames (DR-035)
--   sprint-5.sql       — hardware health check columns + first_grant_sent (Sprint 5.2, 5.5)
--   wix-first-flow.sql — pending_hardware state + nullable hardware_group_id
--   multi-member.sql   — sub-member schema (DR-029–032, deferred post-HOG)
--   multi-group-archive-audit.sql — plan_mapping_groups, admin audit, source_api_key
--   per-location-config.sql — locations.hardware_platform + notification_email
--   wix-instance-id.sql — clients.platform_instance_id for portal auth (three-path lookup)
--   dr-036.sql         — client_subscriptions table + tier_subscription_id FK (DR-036, PENDING OB-70)

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

--------------------------------------------------------
-- 1. Clients (Tenants)
--------------------------------------------------------
CREATE TABLE clients (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name                    VARCHAR(255) NOT NULL,                   -- Company name (e.g. "House of Gains")
    platform                VARCHAR(50)  NOT NULL DEFAULT 'wix',     -- Source platform: 'wix', 'squarespace', etc.
    source_site_id          VARCHAR(255) UNIQUE,                     -- Source platform site ID — used for webhook routing + platform API calls (DR-021 pattern)
    platform_instance_id    VARCHAR(255),                            -- Platform app installation ID — used for portal auth (wix-instance.js three-path lookup)
    source_site_name        VARCHAR(255),                            -- Human-readable site name (e.g. "House of Gains - Main")
    hardware_platform       VARCHAR(50),                             -- 'kisi', 'seam' — which hardware provider this client uses
    tier                    VARCHAR(50),                             -- 'Base', 'Pro', 'Connect' — AccessSync billing tier
    status                  VARCHAR(50)  DEFAULT 'active',           -- active, cancelled, archived
    notification_email      VARCHAR(255),                            -- DR-020: operator alert destination (Resend)
    last_sync_at            TIMESTAMP WITH TIME ZONE,                -- DR-018: last member sync sweep timestamp
    source_site_url         VARCHAR(255),                            -- Operator source platform site URL (e.g. "houseofgains.com") — dashboard header
    last_webhook_at         TIMESTAMP WITH TIME ZONE,                -- Last webhook received from source platform — drives LIVE/WARN/ERROR health status
    hardware_api_key        TEXT,                                    -- DR-028/DR-035: AES-256-GCM encrypted org-level hardware API key
    source_api_key          TEXT,                                    -- AES-256-GCM encrypted source platform API key for outbound plan/bookings API calls
    archived_at             TIMESTAMP WITH TIME ZONE,                -- NULL when active; set on archive
    first_grant_sent        BOOLEAN      DEFAULT false,              -- Sprint 5.5: tracks whether first grant email has been sent
    created_at              TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Partial unique index: one platform_instance_id per client (NULL allowed for clients not yet portal-authenticated)
CREATE UNIQUE INDEX clients_platform_instance_id_idx
    ON clients (platform_instance_id)
    WHERE platform_instance_id IS NOT NULL;

--------------------------------------------------------
-- 2. Locations (Physical Sites per Client)
--------------------------------------------------------
-- One row per physical location under a client.
-- kisi_org_id intentionally excluded — G-10 open, org structure unverified. See DR-025.
CREATE TABLE locations (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id                   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name                        VARCHAR(255) NOT NULL,               -- Display name (e.g. "House of Gains - Fort Smith")
    city                        VARCHAR(100),
    state                       VARCHAR(50),
    subscription_status         VARCHAR(50)  NOT NULL DEFAULT 'inactive', -- DR-027: 'inactive', 'active', 'lapsed'
    tier                        VARCHAR(50),                         -- DR-027: AccessSync billing tier for this location
    subscribed_at               TIMESTAMP WITH TIME ZONE,            -- DR-027: when subscription was activated
    subscription_id             VARCHAR(255),                        -- DR-027: Wix/billing subscription reference ID
    hardware_platform           VARCHAR(50),                         -- per-location-config: override client hardware platform (null = use client default)
    hardware_api_key            TEXT,                                -- DR-028/DR-035: AES-256-GCM encrypted override key (null = use client default)
    hardware_key_last_verified  TIMESTAMP WITH TIME ZONE,            -- Sprint 5.2: last successful hardware key validation
    hardware_key_last_error     TEXT,                                -- Sprint 5.2: last hardware key validation error detail
    notification_email          VARCHAR(255),                        -- per-location-config: override client notification email (null = use client default)
    created_at                  TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

--------------------------------------------------------
-- 3. Plan Mappings (The Translator)
--------------------------------------------------------
CREATE TABLE plan_mappings (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    source_plan_id      VARCHAR(255) NOT NULL,           -- DR-035: was wix_plan_id; platform-agnostic plan identifier
    hardware_group_id   VARCHAR(255),                    -- nullable: Wix-first flow allows plan recognition before group is mapped
    tier_name           VARCHAR(50)  DEFAULT 'Base',     -- Base, Pro, Connect
    action              VARCHAR(50)  DEFAULT 'grant',    -- grant, revoke, temporary
    location_id         UUID REFERENCES locations(id),  -- nullable — existing rows may have no location assignment
    plan_name           VARCHAR(255),                    -- display label for the plan (operator dashboard)
    door_name           VARCHAR(255),                    -- display label for the hardware group/door
    status              VARCHAR(50)  DEFAULT 'active',   -- 'active', 'excluded' — for "Not managed" display
    source_status       VARCHAR(20)  DEFAULT 'active',   -- 'active', 'archived' — tracks source platform plan lifecycle (health check reconciliation)
    access_type         VARCHAR(50)  DEFAULT 'group',    -- Hardware access object type: 'group' (Kisi), 'zone'/'door' (future Seam)
    allow_multiple      BOOLEAN      DEFAULT false,      -- Multi-member: plan allows additional members (deferred post-HOG)
    max_members         INTEGER      DEFAULT 1,          -- Multi-member: max members per plan holder (deferred post-HOG)
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

--------------------------------------------------------
-- 3b. Plan Mapping Groups (Multi-Group Junction Table)
--------------------------------------------------------
-- One row per hardware group per plan mapping.
-- Allows one plan to grant access to multiple doors/groups.
-- Resolver JOINs this table to expand mappings. Legacy rows fall back to plan_mappings.hardware_group_id.
CREATE TABLE plan_mapping_groups (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mapping_id          UUID NOT NULL REFERENCES plan_mappings(id) ON DELETE CASCADE,
    hardware_group_id   VARCHAR(255) NOT NULL,
    door_name           VARCHAR(255),
    health_status       VARCHAR(20)  DEFAULT 'ok',        -- 'ok', 'not_found' — per-group health from hardware API reconciliation (K-2)
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (mapping_id, hardware_group_id)
);

--------------------------------------------------------
-- 4. Processed Event IDs (Idempotency / Deduplication)
--------------------------------------------------------
CREATE TABLE processed_event_ids (
    event_id        VARCHAR(255) PRIMARY KEY,           -- Wix Event ID
    client_id       UUID REFERENCES clients(id),        -- nullable: tenant not yet resolved at dedup time (S-01 known gap)
    processed_at    TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

--------------------------------------------------------
-- 5. Error Queue (Dead Letter Queue)
--------------------------------------------------------
CREATE TABLE error_queue (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id        UUID REFERENCES clients(id),
    member_id        UUID,                               -- references member_identity(id) — no FK constraint (intentional: member may not exist)
    event_type       VARCHAR(100),
    payload          JSONB,
    error_reason     TEXT,                               -- plain error message (naming: 'plain_message' in API responses)
    error_code       VARCHAR(100),                       -- structured code: HARDWARE_KEY_INVALID, PLAN_NOT_MAPPED, etc. (error-queue-v2)
    user_message     TEXT,                               -- humanized message from connector — persisted for display (error-queue-v2)
    resolution       VARCHAR(100),                       -- enum: ROTATE_API_KEY, RETRY, REMAP_PLAN, CHECK_PERMISSIONS (error-queue-v2)
    action_text      TEXT,                               -- "what to do" instruction string (error-queue-v2)
    http_status      INTEGER,                            -- HTTP status code from hardware/Wix API (error-queue-v2)
    raw_api_body     JSONB,                              -- full API response body for debugging (error-queue-v2)
    occurred_count   INTEGER      DEFAULT 1,             -- recurrence count for dedup grouping (error-queue-v2)
    last_occurred_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP, -- most recent occurrence (error-queue-v2)
    retry_count      INTEGER      DEFAULT 0,
    status           VARCHAR(50)  DEFAULT 'failed',      -- failed, resolved
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    resolved_at      TIMESTAMP WITH TIME ZONE,
    dismiss_note     TEXT,                               -- Admin Hub: operator note when dismissing
    dismissed_by     VARCHAR(255),                       -- Admin Hub: who dismissed ('admin' for now)
    location_id      UUID REFERENCES locations(id),     -- nullable — error scoping by location
    plan_name        VARCHAR(255),                       -- plan context for operator triage
    door_name        VARCHAR(255)                        -- door context for operator triage
);

CREATE INDEX IF NOT EXISTS idx_error_queue_dedup
  ON error_queue (client_id, member_id, error_code)
  WHERE status = 'failed';

CREATE INDEX IF NOT EXISTS idx_error_queue_client_code
  ON error_queue (client_id, error_code, status);

--------------------------------------------------------
-- 6. Member Identity
--------------------------------------------------------
CREATE TABLE member_identity (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    platform_member_id  VARCHAR(255) NOT NULL,          -- DR-021: was wix_member_id; platform-agnostic
    source_platform     VARCHAR(50)  NOT NULL DEFAULT 'wix', -- DR-021: 'wix', 'squarespace', etc.
    hardware_platform   VARCHAR(50)  NOT NULL,          -- 'kisi', 'seam'
    hardware_user_id    VARCHAR(255),                   -- Generated ID in Kisi/Seam
    source_tag          VARCHAR(50)  DEFAULT 'accesssync', -- DR-003: distinguishes from manual/staff users
    -- Primary members: email/name fetched from Wix on-demand (DR-001 data minimization).
    -- Sub-members: stored directly (entered by plan holder — FP-01). Different data model by design (S-07).
    plan_holder_id      UUID REFERENCES member_identity(id) ON DELETE CASCADE, -- DR-030: links sub-members to primary
    phone               VARCHAR(50),                    -- Sub-member phone (required)
    first_name          VARCHAR(255),                   -- Sub-member first name (required)
    last_name           VARCHAR(255),                   -- Sub-member last name (required)
    email               VARCHAR(255),                   -- Sub-member email (required — FP-01 resolution)
    sub_member_status   VARCHAR(50),                    -- DR-032: 'draft', 'submitted', NULL for primary members
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_id, source_platform, platform_member_id)
);

-- Fast sub-member lookup by plan holder
CREATE INDEX idx_member_identity_plan_holder
    ON member_identity (plan_holder_id)
    WHERE plan_holder_id IS NOT NULL;

--------------------------------------------------------
-- 7. Member Access State (Provisioning Status)
--------------------------------------------------------
-- Status values: pending_sync, in_flight, active, disabled, revoked, failed,
--                skipped_lockdown, pending_hardware, pending_identity
-- pending_identity (OB-89 Gate 2): grant parked — identity inputs (email, name) missing
--   and could not be recovered via Wix Members API or DB cache. Waits for next webhook
--   that carries the missing data. Not a failure; not a dead-letter.
CREATE TABLE member_access_state (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id           UUID NOT NULL REFERENCES member_identity(id) ON DELETE CASCADE,
    client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    status              VARCHAR(50) NOT NULL,
    role_assignment_id  VARCHAR(255),                   -- Legacy single role assignment ID (kept for backwards compat — S-08)
    plan_holder_id      UUID REFERENCES member_identity(id) ON DELETE CASCADE, -- DR-030: cascade operations on revoke
    pending_plan_id     VARCHAR(255),                   -- Wix-first: source plan ID stored when parked as pending_hardware
    provisioned_at      TIMESTAMP WITH TIME ZONE,
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(member_id)
);

-- Fast sub-member access state lookup by plan holder
CREATE INDEX idx_member_access_state_plan_holder
    ON member_access_state (plan_holder_id)
    WHERE plan_holder_id IS NOT NULL;

--------------------------------------------------------
-- 8. Member Role Assignments (Multi-Door Grant Storage)
--------------------------------------------------------
-- One row per hardware role assignment per member per group.
-- Replaces single role_assignment_id on member_access_state for multi-door support.
-- Standard Adapter Layer exclusively owns writes (DR-023).
-- On revoke: all rows for the member are deleted atomically in completeRevoke().
CREATE TABLE member_role_assignments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id           UUID NOT NULL REFERENCES member_identity(id) ON DELETE CASCADE,
    mapping_id          UUID NOT NULL REFERENCES plan_mappings(id)   ON DELETE CASCADE,
    role_assignment_id  VARCHAR(255) NOT NULL,
    hardware_group_id   VARCHAR(255),                   -- which specific group this assignment is for
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (member_id, mapping_id, hardware_group_id)
);

--------------------------------------------------------
-- 8b. Member Access Sources (Multi-Source Grant Safety — DR-034)
--------------------------------------------------------
-- Tracks WHY a member is in a hardware group (plan, booking, family_plan).
-- Standard Adapter exclusively owns writes (DR-023).
-- Grant: INSERT source row. Revoke: DELETE source row, then check COUNT.
-- Kisi DELETE only called when COUNT(*) for member+group = 0.
-- Prevents unsafe revoke when multiple plans grant the same group.
CREATE TABLE member_access_sources (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id         UUID NOT NULL REFERENCES member_identity(id) ON DELETE CASCADE,
    hardware_group_id VARCHAR(255) NOT NULL,                    -- Kisi/Seam group ID
    source_type       VARCHAR(50)  NOT NULL,                    -- 'plan' | 'booking' | 'family_plan'
    source_plan_id    VARCHAR(255),                             -- NULL if booking source
    source_booking_id VARCHAR(255),                             -- NULL if plan source
    mapping_id        UUID REFERENCES plan_mappings(id) ON DELETE SET NULL, -- for traceability
    valid_until       TIMESTAMP WITH TIME ZONE,                 -- NULL = permanent access
    granted_at        TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (member_id, hardware_group_id, source_type,
            COALESCE(source_plan_id, ''), COALESCE(source_booking_id, ''))
);

CREATE INDEX idx_member_access_sources_member_group
    ON member_access_sources (member_id, hardware_group_id);

CREATE INDEX idx_member_access_sources_member
    ON member_access_sources (member_id);

--------------------------------------------------------
-- 9. Member Access Log (Lifecycle Events)
--------------------------------------------------------
CREATE TABLE member_access_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id       UUID NOT NULL REFERENCES member_identity(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    event_type      VARCHAR(100) NOT NULL,              -- provisioned, disabled, restored, revoked, deleted
    credential_type VARCHAR(50),                        -- pin, qr, kisi_app
    credential_value TEXT,                              -- Encrypted PIN or QR payload
    error_code      VARCHAR(50),                        -- e.g. CRED_001
    created_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

--------------------------------------------------------
-- 10. Adapter Admin Log (Provisioning + Admin Audit Trail)
--------------------------------------------------------
-- Dual purpose (S-10 known gap — split post-V1):
--   a) Hardware provisioning audit trail
--   b) Admin actions (client_archived, api_key_rotated, etc.)
CREATE TABLE adapter_admin_log (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id           UUID NOT NULL REFERENCES clients(id),
    event_type          VARCHAR(100) NOT NULL,
    platform_member_id  VARCHAR(255),                   -- DR-021: was wix_member_id
    hardware_user_id    VARCHAR(255),
    role_assignment_id  VARCHAR(255),
    result              VARCHAR(50),                    -- success, failed
    configured_by       VARCHAR(255),                   -- DR-019: who set up the adapter
    configured_at       TIMESTAMP WITH TIME ZONE,       -- DR-019: when adapter was configured
    admin_action        VARCHAR(100),                   -- client_archived, client_deleted, api_key_rotated, etc.
    details             JSONB,                          -- snapshot of what changed
    target_entity       VARCHAR(50),                    -- 'client', 'location', 'plan_mapping'
    target_id           UUID,                           -- ID of the entity acted on
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

--------------------------------------------------------
-- 11. Config Alert Log
--------------------------------------------------------
CREATE TABLE config_alert_log (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id               UUID REFERENCES clients(id) ON DELETE CASCADE, -- nullable (S-02): malformed webhooks may not resolve tenant
    alert_type              VARCHAR(100) NOT NULL,      -- missing_door, missing_group, expired_credentials, lockdown_detected, malformed_payload
    plan_mapping_id         UUID REFERENCES plan_mappings(id),
    hardware_ref            VARCHAR(255),
    affected_member_count   INTEGER DEFAULT 0,
    resolved_at             TIMESTAMP WITH TIME ZONE,
    created_at              TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen_at            TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

--------------------------------------------------------
-- 12. Client Activity Summary (DR-024)
--------------------------------------------------------
-- Daily aggregated event counts per client. UPSERT pattern on every event.
-- Fault-tolerant writes — failures never block the grant/revoke path.
CREATE TABLE client_activity_summary (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id           UUID NOT NULL REFERENCES clients(id),
    summary_date        DATE NOT NULL,
    events_received     INTEGER DEFAULT 0,
    grants_completed    INTEGER DEFAULT 0,
    revokes_completed   INTEGER DEFAULT 0,
    errors_count        INTEGER DEFAULT 0,
    updated_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (client_id, summary_date)
);

--------------------------------------------------------
-- 13. Webhook Log (Admin Hub: Webhook Inspector)
--------------------------------------------------------
-- NOTE (S-14): No retention policy defined. High write volume + JSONB payloads.
-- Needs TTL or partition-by-date before scale.
CREATE TABLE webhook_log (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id            VARCHAR(255),
    client_id           UUID REFERENCES clients(id),
    received_at         TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    hmac_status         VARCHAR(20) NOT NULL,           -- 'accepted', 'rejected'
    dedup_status        VARCHAR(20),                    -- 'new', 'duplicate', null if rejected
    event_type          VARCHAR(100),
    raw_payload         JSONB,
    normalized_payload  JSONB,
    error_detail        TEXT
);

--------------------------------------------------------
-- 14. Client Subscriptions (DR-036 — PENDING OB-70 MIGRATION)
--------------------------------------------------------
-- Platform-agnostic billing record per operator subscription.
-- One row per subscription purchase (one per location in V1).
-- subscription_source mirrors source_platform pattern from DR-021.
-- UNIQUE(subscription_source, subscription_id) prevents duplicate billing webhook rows.
-- locations.tier_subscription_id FK links each location to its subscription.
-- Supersedes: locations.tier, locations.subscription_status, locations.subscription_id,
--             plan_mappings.tier_name (all become redundant after Phase 2 dual-read).
-- OB-65: subscription-manager.js (owns all writes to this table)
-- OB-70: Run migrations/dr-036.sql on Railway before deploying any OB-65–68 code.
--
-- NOTE: This table does NOT yet exist in the live Railway DB.
--       Run migrations/dr-036.sql (Phase 1) to create it and backfill location rows.
CREATE TABLE client_subscriptions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    subscription_source VARCHAR(50) NOT NULL,                           -- 'wix', 'squarespace', 'accesssync', etc. — DR-036
    subscription_id     TEXT NOT NULL,                                  -- platform-native subscription/order reference ID
    tier                VARCHAR(50) NOT NULL,                           -- 'Base', 'Pro', 'Connect' — source of truth for tier
    status              VARCHAR(50) NOT NULL DEFAULT 'trial',           -- 'trial', 'active', 'suspended', 'cancelled'
    trial_ends_at       TIMESTAMP WITH TIME ZONE,                       -- NULL = no trial; set = trial clock, billing starts after
    activated_at        TIMESTAMP WITH TIME ZONE,                       -- when subscription became active (billing start date)
    cancelled_at        TIMESTAMP WITH TIME ZONE,                       -- when subscription was cancelled
    created_at          TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (subscription_source, subscription_id)                       -- idempotency: prevents duplicate rows from repeated billing events
);

-- After running migrations/dr-036.sql, the following FK is added to locations:
-- ALTER TABLE locations ADD COLUMN tier_subscription_id UUID REFERENCES client_subscriptions(id) ON DELETE SET NULL;
-- (Included in dr-036.sql Phase 1 migration)

CREATE INDEX IF NOT EXISTS idx_client_subscriptions_client_id
    ON client_subscriptions (client_id);

CREATE INDEX IF NOT EXISTS idx_client_subscriptions_status
    ON client_subscriptions (status);

--------------------------------------------------------
-- Known Schema Gaps (open items, not yet implemented)
-- S-03: member_access_sources table — RESOLVED by dr-034.sql migration (2026-04-10)
-- S-07: Sub-member PII exception needs its own DR
-- S-08: Legacy role_assignment_id on member_access_state needs retirement DR
-- S-09: allow_multiple / max_members activation gate needs DR
-- S-10: adapter_admin_log dual-purpose — split into two tables post-V1
-- S-14: webhook_log retention policy needed before scale
-- S-15: locations.tier, subscription_status, subscription_id — REDUNDANT once DR-036 Phase 2 dual-read live (OB-69)
-- S-16: plan_mappings.tier_name — REDUNDANT once DR-036 Phase 6 column removal runs (OB-71)
--------------------------------------------------------
