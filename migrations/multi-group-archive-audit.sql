-- multi-group-archive-audit.sql
-- Multi-group plan mapping, client archive, admin audit, Wix API key
-- Run after: sprint-5.sql

-- 1A: Multi-group plan mapping junction table
CREATE TABLE IF NOT EXISTS plan_mapping_groups (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    mapping_id UUID NOT NULL REFERENCES plan_mappings(id) ON DELETE CASCADE,
    hardware_group_id VARCHAR(255) NOT NULL,
    door_name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (mapping_id, hardware_group_id)
);

-- 1B: Support multi-group in member_role_assignments
ALTER TABLE member_role_assignments ADD COLUMN IF NOT EXISTS hardware_group_id VARCHAR(255);

-- Drop old constraint, add new one with hardware_group_id
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'member_role_assignments_member_id_mapping_id_key'
  ) THEN
    ALTER TABLE member_role_assignments
      DROP CONSTRAINT member_role_assignments_member_id_mapping_id_key;
  END IF;
END $$;

ALTER TABLE member_role_assignments
  ADD CONSTRAINT member_role_assignments_member_mapping_group_key
  UNIQUE (member_id, mapping_id, hardware_group_id);

-- 1C: Client archive support
ALTER TABLE clients ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE;

-- 1D: Admin audit columns on adapter_admin_log
ALTER TABLE adapter_admin_log ADD COLUMN IF NOT EXISTS admin_action VARCHAR(100);
ALTER TABLE adapter_admin_log ADD COLUMN IF NOT EXISTS details JSONB;
ALTER TABLE adapter_admin_log ADD COLUMN IF NOT EXISTS target_entity VARCHAR(50);
ALTER TABLE adapter_admin_log ADD COLUMN IF NOT EXISTS target_id UUID;

-- 1E: Wix API key storage (encrypted, same pattern as hardware_api_key)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS wix_api_key VARCHAR(500);

-- 1F: Backfill existing plan_mappings into junction table
INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id, door_name)
SELECT id, hardware_group_id, door_name FROM plan_mappings
WHERE hardware_group_id IS NOT NULL AND hardware_group_id != ''
ON CONFLICT DO NOTHING;

-- 1G: Backfill member_role_assignments with hardware_group_id from plan_mappings
UPDATE member_role_assignments mra
SET hardware_group_id = pm.hardware_group_id
FROM plan_mappings pm
WHERE mra.mapping_id = pm.id AND mra.hardware_group_id IS NULL;
