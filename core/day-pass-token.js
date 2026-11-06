/**
 * @file day-pass-token.js
 * @layer core/layer4
 * @role signed-token-helper
 * @ob OB-98, OB-251
 *
 * Two kinds of short-lived signed pointer for the day-pass QR. Neither holds a credential;
 * both are HMAC-signed so a request that does not carry one gets nothing.
 *
 *   QR token    — points at one live link (client, access, link). Lives 10 minutes. Opens only
 *                 the QR image (GET /member/day-pass/qr.png).
 *   View token  — points at one buyer's pass (client, access). Lives 15 minutes. Opens the
 *                 branded day-pass page (admin GET /day-pass) and the info call behind it. It
 *                 is minted only by the HMAC-signed POST /member/day-pass, i.e. only the gym's
 *                 own Wix backend can hand one to a buyer.
 *
 * A token of one kind never verifies as the other (the view token carries k:'v' and no link id).
 */

'use strict';

const crypto = require('crypto');

const QR_TOKEN_TTL_MS   = 10 * 60 * 1000;
const VIEW_TOKEN_TTL_MS = 15 * 60 * 1000;

function _tokenSecret() {
  const key = process.env.DAY_PASS_TOKEN_SECRET || process.env.API_KEY_ENCRYPTION_KEY;
  if (!key) {
    const err = new Error('DAY_PASS_TOKEN_SECRET / API_KEY_ENCRYPTION_KEY not set — cannot sign QR URLs');
    err.code = 'DAY_PASS_TOKEN_SECRET_MISSING';
    throw err;
  }
  return key;
}

function _sign(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig = crypto.createHmac('sha256', _tokenSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Returns the parsed payload when the signature is good and the token has not expired, else null. */
function _open(token) {
  if (typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', _tokenSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!data || typeof data.e !== 'number' || Date.now() > data.e) return null;
  return data;
}

/** Signed, expiring pointer to one (client, access, link) triple. No credential inside. */
function signQrToken({ clientId, accessId, linkId, exp }) {
  return _sign({ c: clientId, a: accessId, l: String(linkId), e: exp });
}

function verifyQrToken(token) {
  const data = _open(token);
  if (!data || data.k || !data.c || !data.a || !data.l) return null;
  return { clientId: data.c, accessId: data.a, linkId: data.l, exp: data.e };
}

/** Signed, expiring pointer to one buyer's day pass (client, access). No credential inside. */
function signViewToken({ clientId, accessId, exp }) {
  return _sign({ k: 'v', c: clientId, a: accessId, e: exp });
}

function verifyViewToken(token) {
  const data = _open(token);
  if (!data || data.k !== 'v' || !data.c || !data.a) return null;
  return { clientId: data.c, accessId: data.a, exp: data.e };
}

module.exports = {
  signQrToken, verifyQrToken, signViewToken, verifyViewToken,
  QR_TOKEN_TTL_MS, VIEW_TOKEN_TTL_MS,
};
