/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Scenario: Kisi API key is stored encrypted, never plaintext in DB      │
 * │                                                                         │
 * │  Business consequence: If encryption is broken, a Kisi API key stored   │
 * │  in the DB is recoverable by anyone with DB access. All client doors     │
 * │  are compromised. If decryption is broken, access provisioning fails    │
 * │  for every member at that location.                                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const crypto = require('crypto');

// Set up a valid 32-byte encryption key in the env before loading the module
process.env.KISI_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

const { encryptApiKey, decryptApiKey } = require('../../core/crypto-utils');

const REAL_KISI_KEY = 'prod-kisi-api-key-abc123def456'; // Simulate a real key format

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('[P2] Kisi API key encrypts and decrypts correctly — access provisioning depends on this', () => {

  it('encrypted value does not contain the plaintext API key', () => {
    const encrypted = encryptApiKey(REAL_KISI_KEY);
    expect(encrypted).not.toContain(REAL_KISI_KEY);
  });

  it('round-trips correctly: encrypt then decrypt returns the original key', () => {
    const encrypted = encryptApiKey(REAL_KISI_KEY);
    const decrypted = decryptApiKey(encrypted);
    expect(decrypted).toBe(REAL_KISI_KEY);
  });

  it('uses a random IV — same key encrypts to different ciphertext each time (no determinism)', () => {
    const enc1 = encryptApiKey(REAL_KISI_KEY);
    const enc2 = encryptApiKey(REAL_KISI_KEY);
    expect(enc1).not.toBe(enc2);  // Different IV → different output
  });

  it('stores in iv:tag:ciphertext format — all three parts present', () => {
    const encrypted = encryptApiKey(REAL_KISI_KEY);
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/^[0-9a-f]+$/i); // IV hex
    expect(parts[1]).toMatch(/^[0-9a-f]+$/i); // Auth tag hex
    expect(parts[2]).toMatch(/^[0-9a-f]+$/i); // Ciphertext hex
  });

});

describe('[P2] Tampered or corrupted keys are rejected — protects against DB manipulation', () => {

  it('throws when the auth tag has been tampered with (AES-GCM integrity check)', () => {
    const encrypted = encryptApiKey(REAL_KISI_KEY);
    const [iv, _tag, ciphertext] = encrypted.split(':');
    // Replace tag with garbage — simulates someone editing the DB record
    const tampered = `${iv}:ffffffffffffffffffffffffffffffff:${ciphertext}`;
    expect(() => decryptApiKey(tampered)).toThrow();
  });

  it('throws when given a malformed storage string (wrong number of segments)', () => {
    expect(() => decryptApiKey('not-a-valid-format')).toThrow();
    expect(() => decryptApiKey('only:two')).toThrow();
  });

});

describe('[P2] Encryption key misconfiguration fails loudly — prevents silent fallback to plaintext', () => {

  it('throws when KISI_ENCRYPTION_KEY env var is missing', () => {
    const savedKey = process.env.KISI_ENCRYPTION_KEY;
    delete process.env.KISI_ENCRYPTION_KEY;

    // Need fresh require since the module caches the key check
    jest.resetModules();
    const freshCrypto = require('../../core/crypto-utils');

    expect(() => freshCrypto.encryptApiKey('any-key')).toThrow('KISI_ENCRYPTION_KEY');

    // Restore
    process.env.KISI_ENCRYPTION_KEY = savedKey;
    jest.resetModules();
  });

  it('throws when KISI_ENCRYPTION_KEY is too short (not 64 hex chars)', () => {
    const savedKey = process.env.KISI_ENCRYPTION_KEY;
    process.env.KISI_ENCRYPTION_KEY = 'tooshort';

    jest.resetModules();
    const freshCrypto = require('../../core/crypto-utils');

    expect(() => freshCrypto.encryptApiKey('any-key')).toThrow('KISI_ENCRYPTION_KEY');

    process.env.KISI_ENCRYPTION_KEY = savedKey;
    jest.resetModules();
  });

});
