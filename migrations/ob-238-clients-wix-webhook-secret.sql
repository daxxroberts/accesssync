-- OB-238 — Per-client wix_webhook_secret column
-- Closes the multi-tenant HMAC gap: one operator's leaked secret no longer
-- forges webhooks for all operators. Encryption pattern mirrors DR-028.

BEGIN;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS wix_webhook_secret TEXT;

COMMENT ON COLUMN clients.wix_webhook_secret IS
  'OB-238 — per-client HMAC verification secret for Velo events.js webhooks. AES-256-GCM encrypted via core/crypto-utils.encryptApiKey using API_KEY_ENCRYPTION_KEY (DR-028 pattern). NULL means client falls back to platform-wide WIX_WEBHOOK_SECRET env var (legacy transition compat). Generated at onboarding (new clients) or via /operator/:clientId/wix-webhook-secret/rotate (HOG explicit migration).';

COMMIT;
