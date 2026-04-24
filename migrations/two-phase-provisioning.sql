-- Two-phase provisioning: delayed-start plan support
-- Adds scheduled_start_date to member_access_state so members parked
-- as 'pending_start' (Kisi user created, group assignment deferred)
-- can surface their scheduled access date in sync-status.ejs.
ALTER TABLE member_access_state
  ADD COLUMN IF NOT EXISTS scheduled_start_date TIMESTAMPTZ;
