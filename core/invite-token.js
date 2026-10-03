/**
 * core/invite-token.js — owner-issued onboarding invite (tenant isolation).
 *
 * A signed, expiring pointer to ONE client. It is a bearer link: whoever holds it
 * can redeem it (POST /onboard/redeem) for an operator session scoped to that
 * client, and to nothing else. It replaces the old platform-wide
 * OPERATOR_INVITE_TOKEN, which was written into the public /onboard page.
 *
 * Why stateless (no table): an invite must keep working when the email scanner
 * opens it first, when the response is lost, when the owner opens it on a second
 * device, and when delivery fails and the owner re-sends. A burn-on-first-use
 * token breaks all four. The compensating controls are: owner-only issuance,
 * short expiry, client binding, archive-the-client revocation, and an audit row
 * on every issue and redeem. A DB-backed single-use variant is a v2 that needs a
 * migration — see handoff/ONBOARDING_INVITES.md.
 *
 * Format:  base64url(JSON{p,c,e,n}) + '.' + base64url(HMAC-SHA256)
 *   p  purpose, pinned so a QR token or session JWT can never be replayed here
 *   c  client UUID the invite is bound to
 *   e  expiry (epoch ms)
 *   n  random nonce (keeps two invites for one client distinct)
 */

'use strict';

const crypto = require('crypto');

const PURPOSE = 'onboard-invite-v1';
const KEY_LABEL = 'accesssync/invite-signing/v1';
const MAX_TOKEN_LENGTH = 600;
const DEFAULT_TTL_HOURS = 72;
const MIN_TTL_HOURS = 1;
const MAX_TTL_HOURS = 168;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Signing key. INVITE_SIGNING_SECRET if set, otherwise derived from
 * ADMIN_JWT_SECRET (required at boot) — HMAC-ed with a purpose label so the
 * derived key can never double as the session-JWT key. Throws, never defaults.
 */
function _key() {
  const base = process.env.INVITE_SIGNING_SECRET || process.env.ADMIN_JWT_SECRET;
  if (!base) {
    const err = new Error('INVITE_SIGNING_SECRET or ADMIN_JWT_SECRET must be set to sign invites');
    err.code = 'INVITE_SECRET_MISSING';
    throw err;
  }
  return crypto.createHmac('sha256', base).update(KEY_LABEL).digest();
}

function ttlMs() {
  const raw = parseInt(process.env.INVITE_TTL_HOURS, 10);
  const hours = Number.isFinite(raw) ? Math.min(MAX_TTL_HOURS, Math.max(MIN_TTL_HOURS, raw)) : DEFAULT_TTL_HOURS;
  return hours * 3_600_000;
}

function _sign(payloadB64) {
  return crypto.createHmac('sha256', _key()).update(payloadB64).digest('base64url');
}

/**
 * @param {{ clientId: string, now?: number, ttlMs?: number }} p
 * @returns {{ token: string, expiresAt: number }}
 */
function signInvite({ clientId, now = Date.now(), ttlMs: ttl }) {
  if (typeof clientId !== 'string' || !UUID_RE.test(clientId)) {
    const err = new Error('signInvite requires a client UUID');
    err.code = 'INVITE_BAD_CLIENT';
    throw err;
  }
  const expiresAt = now + (ttl || ttlMs());
  const payload = Buffer.from(JSON.stringify({
    p: PURPOSE, c: clientId, e: expiresAt, n: crypto.randomBytes(8).toString('base64url'),
  })).toString('base64url');
  return { token: `${payload}.${_sign(payload)}`, expiresAt };
}

/**
 * @param {*} token
 * @param {{ now?: number }} [opts]
 * @returns {{ ok: true, clientId: string, expiresAt: number }
 *         | { ok: false, reason: 'malformed' | 'bad_signature' | 'expired' }}
 *   Signature is checked BEFORE expiry so an unsigned token learns nothing.
 *   Throws only INVITE_SECRET_MISSING (a deployment fault, not a bad token).
 */
function verifyInvite(token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [payloadB64, sig] = parts;

  const expected = Buffer.from(_sign(payloadB64));
  const actual = Buffer.from(sig);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let data;
  try { data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')); }
  catch (_) { return { ok: false, reason: 'malformed' }; }

  if (!data || data.p !== PURPOSE || typeof data.c !== 'string' || !UUID_RE.test(data.c) || typeof data.e !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (now > data.e) return { ok: false, reason: 'expired' };
  return { ok: true, clientId: data.c, expiresAt: data.e };
}

module.exports = { signInvite, verifyInvite, ttlMs, PURPOSE, MAX_TTL_HOURS, DEFAULT_TTL_HOURS };
