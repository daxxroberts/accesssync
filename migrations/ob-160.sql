-- OB-160: Add source_member_id to member_identity
-- Person-level anchor across all identity roles (holder, sub-member, direct).
-- Fixes: My Access showing empty for holders who claimed a seat.
-- Fixes: active member COUNT overcounting one human across multiple plan roles.
--
-- source_member_id = platform_member_id of the root holder identity (the Wix person).
-- For holder rows and direct plan rows: same as their own platform_member_id.
-- For sub-member rows: the holder's platform_member_id (walked via plan_holder_id).
--
-- Does NOT change any FK chains. MRA → member_identity → hardware_user_id → Kisi untouched.

-- Step 1: Add column
ALTER TABLE member_identity
  ADD COLUMN IF NOT EXISTS source_member_id VARCHAR(255);

-- Step 2: Index for My Access and COUNT(DISTINCT) queries
CREATE INDEX IF NOT EXISTS idx_member_identity_source_member_id
  ON member_identity (source_member_id)
  WHERE source_member_id IS NOT NULL;

-- Step 3: Pre-flight null check (informational — review before deploy)
-- SELECT COUNT(*) FROM member_identity WHERE platform_member_id IS NULL OR platform_member_id = '';
-- SELECT COUNT(*) FROM member_identity WHERE plan_holder_id IS NULL AND sub_member_status IS NOT NULL;

-- Step 4: Backfill holder rows and direct plan rows (source_member_id = own platform_member_id)
UPDATE member_identity
SET source_member_id = platform_member_id
WHERE plan_holder_id IS NULL
  AND source_member_id IS NULL;

-- Step 5: Backfill sub-member rows (source_member_id = holder's platform_member_id)
UPDATE member_identity sub
SET source_member_id = holder.platform_member_id
FROM member_identity holder
WHERE sub.plan_holder_id = holder.id
  AND sub.source_member_id IS NULL;
