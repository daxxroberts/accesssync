/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: Redaction edge cases and boundary conditions                 │
 * │                                                                         │
 * │  Business consequence: A single leak of hardware_api_key or PII in    │
 * │  Railway logs means credentials are queryable by anyone with log       │
 * │  access. The redaction system must hold under every object shape.      │
 * │                                                                         │
 * │  Governed by: DR-039 (Redaction Allowlist)                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const {
  redact,
  REDACTED,
  REDACTED_RUNTIME,
  registerSecretField,
  SENSITIVE_FIELDS,
  SECRET_PATTERNS,
} = require('../../core/log-redaction');

// ── Layer 1: allowlist edge cases ─────────────────────────────────────────────

describe('[P3] redaction: Layer 1 allowlist edge cases (DR-039)', () => {

  test('top-level sensitive key is redacted', () => {
    const result = redact({ hardware_api_key: 'real-key-abc' });
    expect(result.hardware_api_key).toBe(REDACTED);
  });

  test('deeply nested sensitive key is redacted (3 levels)', () => {
    const result = redact({ a: { b: { api_key: 'deep-secret' } } });
    expect(result.a.b.api_key).toBe(REDACTED);
  });

  test('non-sensitive sibling fields are preserved', () => {
    const result = redact({ memberId: 'abc', hardware_api_key: 'secret', planId: 'plan-1' });
    expect(result.memberId).toBe('abc');
    expect(result.planId).toBe('plan-1');
    expect(result.hardware_api_key).toBe(REDACTED);
  });

  test('email field is redacted per DR-001 PII policy', () => {
    const result = redact({ event: 'grant.start', email: 'chad@houseofgains.com' });
    expect(result.email).toBe(REDACTED);
    expect(result.event).toBe('grant.start');
  });

  test('name field is redacted per DR-001 PII policy', () => {
    const result = redact({ event: 'grant.start', name: 'Chad Member' });
    expect(result.name).toBe(REDACTED);
  });

  test('phone field is redacted', () => {
    const result = redact({ phone: '+1-555-123-4567' });
    expect(result.phone).toBe(REDACTED);
  });

  test('password field is redacted', () => {
    const result = redact({ password: 'hunter2' });
    expect(result.password).toBe(REDACTED);
  });

  test('token field is redacted', () => {
    const result = redact({ token: 'abc123xyz' });
    expect(result.token).toBe(REDACTED);
  });

  test('access_token is redacted', () => {
    const result = redact({ access_token: 'access-abc-123' });
    expect(result.access_token).toBe(REDACTED);
  });

  test('sensitive key inside an array of objects is redacted', () => {
    const result = redact({ items: [{ id: 1, api_key: 'k1' }, { id: 2, api_key: 'k2' }] });
    expect(result.items[0].api_key).toBe(REDACTED);
    expect(result.items[1].api_key).toBe(REDACTED);
    expect(result.items[0].id).toBe(1);
  });

  test('redact does not mutate the original object', () => {
    const original = { hardware_api_key: 'real-key', memberId: 'abc' };
    redact(original);
    expect(original.hardware_api_key).toBe('real-key');
  });

  test('null entry returns null without throwing', () => {
    expect(redact(null)).toBeNull();
  });

  test('non-object entry (string) returns value unchanged', () => {
    expect(redact('plain string')).toBe('plain string');
  });

  test('empty object returns empty object', () => {
    expect(redact({})).toEqual({});
  });

  test('numeric values on non-sensitive keys pass through unchanged', () => {
    const result = redact({ memberId: 'abc', count: 42, active: true });
    expect(result.count).toBe(42);
    expect(result.active).toBe(true);
  });

  test('registerSecretField adds new field to allowlist at runtime', () => {
    registerSecretField('my_custom_secret');
    const result = redact({ my_custom_secret: 'sensitive-value', other: 'safe' });
    expect(result.my_custom_secret).toBe(REDACTED);
    expect(result.other).toBe('safe');
    // cleanup
    SENSITIVE_FIELDS.delete('my_custom_secret');
  });

  test('undefined value on sensitive key returns REDACTED not undefined', () => {
    const result = redact({ api_key: undefined });
    expect(result.api_key).toBe(REDACTED);
  });

  test('null value on sensitive key returns REDACTED', () => {
    const result = redact({ hardware_api_key: null });
    expect(result.hardware_api_key).toBe(REDACTED);
  });

  test('nested object with mixed sensitive and safe fields preserves structure', () => {
    const result = redact({
      config: {
        platform: 'kisi',
        hardware_api_key: 'secret',
        groupId: 'g-123',
      }
    });
    expect(result.config.platform).toBe('kisi');
    expect(result.config.hardware_api_key).toBe(REDACTED);
    expect(result.config.groupId).toBe('g-123');
  });

});

// ── Layer 2: regex backstop edge cases ───────────────────────────────────────

describe('[P3] redaction: Layer 2 regex backstop edge cases (DR-039)', () => {

  test('Resend API key in a string value is scrubbed', () => {
    const result = redact({ message: 're_test_abcdefghijklmnopqrstuvwxyz123456' });
    expect(result.message).toContain(REDACTED_RUNTIME);
    expect(result.message).not.toContain('re_test_');
  });

  test('JWT shape in a string value is scrubbed', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkNoYWQgTWVtYmVyIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redact({ debugToken: jwt });
    expect(result.debugToken).toContain(REDACTED_RUNTIME);
    expect(result.debugToken).not.toContain('eyJhbGci');
  });

  test('Bearer token in a string value is scrubbed', () => {
    const result = redact({ authHeader: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abc123def456ghi' });
    expect(result.authHeader).toContain(REDACTED_RUNTIME);
  });

  test('safe string with no secret pattern passes through unchanged', () => {
    const result = redact({ reason: 'Plan not mapped for tenant' });
    expect(result.reason).toBe('Plan not mapped for tenant');
  });

  test('UUIDs are NOT treated as secrets by regex backstop', () => {
    const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const result = redact({ traceId: uuid });
    expect(result.traceId).toBe(uuid);
  });

  test('multiple secrets in the same string are all scrubbed', () => {
    const result = redact({
      debug: 're_test_aaaabbbbccccddddeeeeffffgggg and also re_test_hhhhiiiijjjjkkkkllllmmmm',
    });
    expect(result.debug).not.toContain('re_test_');
  });

  test('regex patterns do not have statefulness issues (lastIndex reset)', () => {
    // Run redact twice with the same pattern-matching string — must produce same result
    const input = { key: 're_test_abcdefghijklmnopqrstuvwxyz00001' };
    const first  = redact(input);
    const second = redact(input);
    expect(first.key).toBe(second.key);
    expect(first.key).toContain(REDACTED_RUNTIME);
  });

});
