-- DR-043: Per-tenant Kisi user pattern
-- Determines whether new Kisi users receive an invitation email and can use the Kisi app.
--
-- 'invited'  (default) — send_emails: true  → user receives Kisi invitation email, can download app
-- 'managed'            — send_emails: false → white-label/managed user, cannot use Kisi app
--
-- DR-007 still governs the 'managed' pattern.
-- DR-017 (HOG uses Regular users) is superseded by this column being set to 'invited' for HOG.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS kisi_user_pattern VARCHAR(20)
    NOT NULL DEFAULT 'invited'
    CHECK (kisi_user_pattern IN ('invited', 'managed'));
