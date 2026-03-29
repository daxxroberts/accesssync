/**
 * crypto-utils.js
 * Core Engine — API Key Encryption Utility (DR-028)
 *
 * AES-256-GCM authenticated encryption for Kisi API keys stored in the DB.
 * Uses Node built-in crypto — zero npm dependencies.
 *
 * Env var required: KISI_ENCRYPTION_KEY (64 hex chars = 32 bytes)
 * Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Storage format: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function _getKey() {
  const hex = process.env.KISI_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('[CryptoUtils] KISI_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext API key for DB storage.
 * @param {string} plaintext
 * @returns {string} "<iv>:<tag>:<ciphertext>" all hex
 */
function encryptApiKey(plaintext) {
  const key = _getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV — GCM standard
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16-byte auth tag
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a stored API key from the DB.
 * @param {string} stored  "<iv>:<tag>:<ciphertext>" hex string
 * @returns {string} plaintext API key
 */
function decryptApiKey(stored) {
  const key = _getKey();
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('[CryptoUtils] Invalid encrypted key format');
  const [ivHex, tagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8');
}

module.exports = { encryptApiKey, decryptApiKey };
