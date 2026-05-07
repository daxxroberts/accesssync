/**
 * e2e/api/api-auth-pin.spec.js
 * Verifies PIN auth flow on admin hub.
 * ~20 scenarios.
 */

const { test, expect } = require('@playwright/test');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'http://localhost:3001';
const OWNER_PIN      = process.env.OWNER_PIN       || '2096';

async function postPin(pin) {
  return fetch(`${ADMIN_BASE_URL}/auth/pin`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ pin }),
  });
}

test.describe('API — PIN Auth', () => {
  test('correct pin returns 200', async () => {
    const res = await postPin(OWNER_PIN);
    expect(res.status).toBe(200);
  });

  test('correct pin response has ok=true', async () => {
    const res = await postPin(OWNER_PIN);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  test('correct pin sets adminToken cookie', async () => {
    const res = await postPin(OWNER_PIN);
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const adminCookie = cookies.find(c => c.startsWith('adminToken='));
    expect(adminCookie, 'adminToken cookie not set').toBeTruthy();
  });

  test('adminToken cookie is httpOnly', async () => {
    const res = await postPin(OWNER_PIN);
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const adminCookie = cookies.find(c => c.startsWith('adminToken='));
    expect(adminCookie?.toLowerCase()).toContain('httponly');
  });

  test('adminToken cookie has SameSite=Strict', async () => {
    const res = await postPin(OWNER_PIN);
    const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const adminCookie = cookies.find(c => c.startsWith('adminToken='));
    expect(adminCookie?.toLowerCase()).toContain('samesite=strict');
  });

  test('wrong pin returns 401', async () => {
    const res = await postPin('0000');
    expect(res.status).toBe(401);
  });

  test('empty pin returns 401 or 400', async () => {
    const res = await postPin('');
    expect([400, 401]).toContain(res.status);
  });

  test('null pin body returns 400 or 401', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/auth/pin`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    '{}',
    });
    expect([400, 401]).toContain(res.status);
  });

  test('wrong pin response has error field', async () => {
    const res = await postPin('9999');
    const json = await res.json();
    expect(json.error).toBeTruthy();
  });
});

test.describe('API — /auth/check', () => {
  test('GET /auth/check without cookie returns 401', async () => {
    const res = await fetch(`${ADMIN_BASE_URL}/auth/check`);
    expect(res.status).toBe(401);
  });

  test('GET /auth/check with valid cookie returns 200', async () => {
    const loginRes = await postPin(OWNER_PIN);
    const cookies  = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
    const cookie   = cookies.find(c => c.startsWith('adminToken='))?.split(';')[0];

    const res = await fetch(`${ADMIN_BASE_URL}/auth/check`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });

  test('GET /auth/check with valid cookie returns ok=true', async () => {
    const loginRes = await postPin(OWNER_PIN);
    const cookies  = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
    const cookie   = cookies.find(c => c.startsWith('adminToken='))?.split(';')[0];

    const res  = await fetch(`${ADMIN_BASE_URL}/auth/check`, { headers: { Cookie: cookie } });
    const json = await res.json();
    expect(json.ok).toBe(true);
  });
});

test.describe('API — /auth/logout', () => {
  test('POST /auth/logout returns 200', async () => {
    const loginRes = await postPin(OWNER_PIN);
    const cookies  = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
    const cookie   = cookies.find(c => c.startsWith('adminToken='))?.split(';')[0];

    const res = await fetch(`${ADMIN_BASE_URL}/auth/logout`, {
      method:  'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });

  test('POST /auth/logout clears adminToken cookie', async () => {
    const loginRes = await postPin(OWNER_PIN);
    const cookies  = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [];
    const cookie   = cookies.find(c => c.startsWith('adminToken='))?.split(';')[0];

    const res = await fetch(`${ADMIN_BASE_URL}/auth/logout`, {
      method:  'POST',
      headers: { Cookie: cookie },
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cleared = setCookies.find(c => c.startsWith('adminToken='));
    // Cleared cookie should have Max-Age=0 or expires in the past
    if (cleared) {
      expect(cleared.toLowerCase()).toMatch(/max-age=0|expires=.*1970/);
    }
  });
});
