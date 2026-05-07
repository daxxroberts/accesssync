/**
 * e2e/helpers/auth.js
 * Auth helpers for E2E tests.
 *
 * Admin hub:   PIN auth → httpOnly adminToken cookie
 * Member hub:  x-internal-proxy: 1 header bypass
 * Webhooks:    HMAC-SHA256 over rawBody → x-wix-signature header
 */

const crypto = require('crypto');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://accesssync-admin.up.railway.app';
const OWNER_PIN      = process.env.OWNER_PIN       || '2096';
// Read lazily so env vars set after module load (e.g. dotenv in global-setup) are picked up
function getWixWebhookSecret() {
  return process.env.WIX_WEBHOOK_SECRET || 'ad6d52c6bd2c2b968c4d95d820cf1198d1e25c16f39a3fa3f389fa4c7f713b44';
}

// Cached cookie string per process — valid 24h so one mint per test run is fine
let _adminCookieCache = null;

/**
 * Mint an admin session cookie via PIN auth.
 * Returns a cookie string suitable for use in `fetch` or Playwright page.setExtraHTTPHeaders().
 * Use setAdminCookieOnPage() for Playwright browser contexts instead.
 */
async function getAdminCookie() {
  if (_adminCookieCache) return _adminCookieCache;

  const res = await fetch(`${ADMIN_BASE_URL}/auth/pin`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ pin: OWNER_PIN }),
  });

  if (!res.ok) {
    throw new Error(`PIN auth failed: ${res.status} ${await res.text()}`);
  }

  // Extract Set-Cookie header value (may be multiple; find adminToken)
  const rawCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const adminCookieHeader = rawCookies.find(c => c.startsWith('adminToken='));
  if (!adminCookieHeader) {
    throw new Error('PIN auth: adminToken cookie not returned');
  }

  // Pull just the value portion (everything before first semicolon)
  _adminCookieCache = adminCookieHeader.split(';')[0]; // "adminToken=<jwt>"
  return _adminCookieCache;
}

/**
 * Set the admin cookie on a Playwright BrowserContext so all subsequent
 * page navigations in that context are authenticated.
 */
async function setAdminCookieOnContext(context, adminBaseUrl) {
  const cookieStr = await getAdminCookie();
  const [name, value] = cookieStr.split('=');
  const url = adminBaseUrl || ADMIN_BASE_URL;
  const { hostname } = new URL(url);
  await context.addCookies([{
    name,
    value,
    domain: hostname,
    path:   '/',
    httpOnly: true,
    secure:   url.startsWith('https'),
  }]);
}

/**
 * Headers for member hub API bypass.
 * The member hub checks for x-internal-proxy: 1 to skip Wix JWT verification.
 */
function getMemberHubHeaders(wixMemberId) {
  const headers = { 'x-internal-proxy': '1' };
  if (wixMemberId) headers['x-wix-member-id'] = wixMemberId;
  return headers;
}

/**
 * Build x-wix-signature header for a webhook body.
 * HMAC-SHA256 over rawBody string, digest as base64.
 * Mirrors wix-connector.js _verifySignature().
 */
function buildWebhookSignature(rawBody, secret) {
  const s = secret || getWixWebhookSecret();
  if (!s) throw new Error('WIX_WEBHOOK_SECRET not set — cannot build webhook signature');
  const hmac = crypto.createHmac('sha256', s);
  hmac.update(rawBody, 'utf8');
  return hmac.digest('base64');
}

/**
 * Build complete headers for a Wix webhook POST.
 * Returns headers object ready to spread into fetch options.
 */
function buildWebhookHeaders(body, opts = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = buildWebhookSignature(rawBody, opts.secret);
  return {
    'Content-Type':      'application/json',
    'x-wix-signature':   signature,
    'x-wix-site-id':     opts.siteId || 'test-site-id',
  };
}

/**
 * POST a webhook to the core engine and return the response.
 */
async function postWebhook(body, opts = {}) {
  const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = buildWebhookHeaders(rawBody, opts);
  const res = await fetch(`${BASE_URL}/webhooks/wix`, {
    method:  'POST',
    headers,
    body:    rawBody,
  });
  return res;
}

module.exports = {
  getAdminCookie,
  setAdminCookieOnContext,
  getMemberHubHeaders,
  buildWebhookSignature,
  buildWebhookHeaders,
  postWebhook,
};
