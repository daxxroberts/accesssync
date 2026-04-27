-- DR-037: Per-plan sub-member assignment
-- Adds plan_mapping_id to member_identity so sub-members belong to a specific
-- plan rather than floating under a holder with no plan reference.
-- This enables a holder to have separate sub-member pools per plan
-- (e.g. "Business" plan → 5 members, "Family" plan → 3 members).
--
-- Safe to run on live DB — no existing sub-members as of 2026-04-26.
-- ON DELETE SET NULL: if a plan mapping is removed, sub-member records survive.

ALTER TABLE member_identity
  ADD COLUMN plan_mapping_id UUID REFERENCES plan_mappings(id) ON DELETE SET NULL;

CREATE INDEX idx_member_identity_plan_mapping
  ON member_identity (plan_mapping_id)
  WHERE plan_mapping_id IS NOT NULL;
