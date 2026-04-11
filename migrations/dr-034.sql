-- DR-034: member_access_sources — Multi-source grant/revoke safety layer
-- Tracks WHY a member is in a hardware group (plan, booking, family_plan).
-- Grant adds a source row. Revoke removes a source row.
-- Kisi DELETE is only called when source row count for that member+group hits zero.
--
-- Prevents unsafe revoke: cancelling Plan A removes access even if Plan B grants same group.
-- Prevents duplicate Kisi POST: skips hardware call when member already has permanent access.
--
-- Run once on Railway Postgres BEFORE deploying the dr-034 code commit.
-- Safe to run: additive only — no existing tables or data affected.
--
-- DR-034 LOCKED 2026-04-01. Schema gap S-03 closed by this migration.

CREATE TABLE member_access_sources (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    member_id       UUID NOT NULL REFERENCES member_identity(id) ON DELETE CASCADE,
    hardware_group_id VARCHAR(255) NOT NULL,                    -- Kisi/Seam group ID
    source_type     VARCHAR(50)  NOT NULL,                      -- 'plan' | 'booking' | 'family_plan'
    source_plan_id  VARCHAR(255),                               -- NULL if booking source
    source_booking_id VARCHAR(255),                             -- NULL if plan source
    mapping_id      UUID REFERENCES plan_mappings(id) ON DELETE SET NULL, -- for traceability
    valid_until     TIMESTAMP WITH TIME ZONE,                   -- NULL = permanent access
    granted_at      TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (member_id, hardware_group_id, source_type,
            COALESCE(source_plan_id, ''), COALESCE(source_booking_id, ''))
);

-- Fast lookup: all sources for a member+group (used in revoke decision)
CREATE INDEX idx_member_access_sources_member_group
    ON member_access_sources (member_id, hardware_group_id);

-- Fast lookup: all sources for a member (used in full revoke sweep)
CREATE INDEX idx_member_access_sources_member
    ON member_access_sources (member_id);
