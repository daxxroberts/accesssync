-- Multi-Member Support Migration
-- DR-029 through DR-032: Sub-member provisioning schema
-- Run on Railway Postgres BEFORE deploying multi-member code.
--
-- Prerequisites: schema.sql tables must already exist.
-- Safe to re-run: all statements use IF NOT EXISTS or are idempotent.

-- 1. member_identity: plan_holder_id links sub-members to primary member
--    Sub-members have platform_member_id format: {wix_uuid}###as{NNN} (DR-029)
ALTER TABLE member_identity
  ADD COLUMN IF NOT EXISTS plan_holder_id UUID REFERENCES member_identity(id) ON DELETE CASCADE;

-- 2. member_identity: phone for sub-members (required field per operator input)
ALTER TABLE member_identity
  ADD COLUMN IF NOT EXISTS phone VARCHAR(50);

-- 3. member_identity: first_name and last_name for sub-members
--    Primary members get name from Wix on-demand; sub-members store it directly.
ALTER TABLE member_identity
  ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
ALTER TABLE member_identity
  ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);

-- 4. member_identity: email for sub-members
--    Primary members: email fetched from Wix on-demand (data minimization).
--    Sub-members: email entered by plan holder in widget form (FP-01 resolution).
ALTER TABLE member_identity
  ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- 5. member_identity: draft status for sub-members (DR-032 Draft→Submit workflow)
--    'draft' = not yet submitted for provisioning
--    'submitted' = submitted, pending provisioning
--    NULL = primary member (not a sub-member)
ALTER TABLE member_identity
  ADD COLUMN IF NOT EXISTS sub_member_status VARCHAR(50);

-- 6. member_access_state: plan_holder_id for cascade operations
ALTER TABLE member_access_state
  ADD COLUMN IF NOT EXISTS plan_holder_id UUID REFERENCES member_identity(id) ON DELETE CASCADE;

-- 7. plan_mappings: multi-member configuration
ALTER TABLE plan_mappings
  ADD COLUMN IF NOT EXISTS allow_multiple BOOLEAN DEFAULT false;
ALTER TABLE plan_mappings
  ADD COLUMN IF NOT EXISTS max_members INTEGER DEFAULT 1;

-- Index: fast lookup of sub-members by plan holder
CREATE INDEX IF NOT EXISTS idx_member_identity_plan_holder
  ON member_identity (plan_holder_id)
  WHERE plan_holder_id IS NOT NULL;

-- Index: fast lookup of sub-member access states by plan holder
CREATE INDEX IF NOT EXISTS idx_member_access_state_plan_holder
  ON member_access_state (plan_holder_id)
  WHERE plan_holder_id IS NOT NULL;
