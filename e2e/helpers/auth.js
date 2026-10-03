/**
 * e2e/helpers/auth.js
 * Auth helpers for E2E tests.
 *
 * Admin hub:   PIN auth → httpOnly adminToken cookie
 * Member hub:  x-internal-proxy: 1 header bypass
 * Webhooks:    HMAC-SHA256 over rawBody → x-wix-signature (platform secret + site id, or a
 *              client's own secret + x-accesssync-client-id)
 */

const crypto = require('crypto');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://accesssync-admin.up.railway.app';

// No credential literals in the repo. These come from the environment of whoever runs the
// suite:
//   OWNER_PIN            the owner PIN for /auth/pin
//   E2E_WEBHOOK_SECRET   the secret the specs sign webhooks with. Defaults to WIX_WEBHOOK_SECRET
//                        (the Wix developer-dashboard secret): the specs post with the HOG site
//                        id and no client id, which is verified with that platform secret and
//                        routed by site id. Set it to HOG's per-client secret together with
//                        E2E_CLIENT_ID to exercise the per-client path instead.
//   E2E_CLIENT_ID        optional; when set, webhooks also send x-accesssync-client-id
function _required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set — see e2e/helpers/auth.js for what each variable is.`);
  return v;
}
function getOwnerPin() { return _required('OWNER_PIN'); }
function getWixWebhookSecret() {
  const v = process.env.E2E_WEBHOOK_SECRET || process.env.WIX_WEBHOOK_SECRET;
  if (!v) throw new Error('E2E_WEBHOOK_SECRET (or WIX_WEBHOOK_SECRET) is not set — see e2e/helpers/auth.js.');
  return v;
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
    body:    JSON.stringify({ pin: getOwnerPin() }),
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
  const headers = {
    'Content-Type':      'application/json',
    'x-wix-signature':   signature,
    'x-wix-site-id':     opts.siteId || 'test-site-id',
  };
  // Only when asked: naming a client makes the server verify with THAT client's own secret.
  const clientId = opts.clientId || process.env.E2E_CLIENT_ID;
  if (clientId) headers['x-accesssync-client-id'] = clientId;
  return headers;
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
