-- DR-051: Durable "Leave this plan" for multi-member plans.
--
-- holder_seated records whether the plan HOLDER occupies their OWN seat on this plan.
-- It is orthogonal to member_billing.status:
--   status        answers "are you paying for this plan?"   (active | cancelled | completed)
--   holder_seated answers "are you sitting in one of its seats?" (true | false)
--
-- A holder can legitimately be status='active' AND holder_seated=false — i.e.
-- "I bought Couples and I'm still paying for it, but I gave my seat to my partner."
-- That state has no representation without this column, which is why "Leave this plan"
-- could not stick: Wix renewals (standard-adapter grant guard) and the 6-hour reconcile
-- re-added the released seat because nothing recorded the holder's intent to be unseated.
--
-- Holder-only by construction: sub-members reference the holder's billing row (DR-040) and
-- have no member_billing row of their own, so the flag never applies to them.
--
-- DEFAULT true + NOT NULL backfills every existing row to seated → ZERO behavior change on
-- deploy (everyone currently seated stays seated). The flag is carried forward across
-- renewal cycles by standard-adapter.completeGrant (a renewal INSERTs a new cycle row, so
-- the value must be copied from the prior cycle rather than relying on this DEFAULT).

ALTER TABLE member_billing
  ADD COLUMN IF NOT EXISTS holder_seated boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN member_billing.holder_seated IS
  'DR-051: does the plan holder occupy their own seat on this plan? true=seated (default), false=released via "Leave this plan". Orthogonal to status. Carried forward across renewal cycles. Holder-only (sub-members have no billing row).';
