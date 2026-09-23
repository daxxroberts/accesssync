-- OB-98 — the gym's "how to get in with your QR code" PDF.
-- Attached to every member email that carries a QR door code, so a forwarded
-- code travels with its instructions. Uploaded from System Config → Email
-- branding (stored in the email-assets bucket next to the logo).
-- Applied to Supabase 2026-09-22.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS qr_guide_url TEXT;
COMMENT ON COLUMN clients.qr_guide_url IS
  'OB-98: public URL of the gym''s "how to get in with your QR code" PDF. Attached to every member email that carries a QR code. NULL = no attachment.';
