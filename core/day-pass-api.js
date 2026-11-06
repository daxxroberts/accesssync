/**
 * @file day-pass-api.js
 * @layer core/layer4
 * @role member-facing-api
 * @route POST /member/day-pass · GET /member/day-pass/info · GET /member/day-pass/qr.png
 * @auth POST: HMAC-SHA256 over the raw body with the client's Wix webhook secret
 *       (x-wix-signature + x-accesssync-client-id) — the same trust as /webhooks/wix.
 *       Called from a Velo BACKEND module that takes the member id from
 *       wix-members-backend, never from the browser.
 *       GET info: 15-minute signed view token minted by the POST.
 *       GET qr.png: 10-minute signed QR token minted by the POST / info call.
 * @reads member_master, member_access, member_access_sources, plan_mappings, connector_subscriptions
 * @writes (none)
 * @calls hardware-adapter (getGroupLink), wix-connector (verifySignedRequest)
 * @exports handleLookup, handleInfo, handleQrImage, signQrToken, verifyQrToken, signViewToken, verifyViewToken
 * @ob OB-98, OB-251
 *
 * Why not the Member Hub's unauthenticated /member/... pattern: those endpoints return
 * status text keyed on a Wix member id in the URL. A day pass is a bearer credential —
 * the QR opens the door for anyone holding it — so it is only released to a request
 * that proves it came from the gym's own Wix backend. The QR image itself is served
 * from a short-lived signed URL because Velo Image elements cannot render data URIs.
 * Nothing here is persisted, and no link URL or image is ever logged.
 */

'use strict';

const db = require('../db');
const { log } = require('./logger');
const hardwareAdapter = require('../adapters/hardware-adapter');
const wixConnector = require('../adapters/wix/wix-connector');
const { decryptApiKey } = require('./crypto-utils');
const {
  signQrToken, verifyQrToken, signViewToken, verifyViewToken,
  QR_TOKEN_TTL_MS, VIEW_TOKEN_TTL_MS,
} = require('./day-pass-token');

async function _clientHardware(clientId) {
  const r = await db.query(
    `SELECT hardware_platform, hardware_api_key FROM connector_subscriptions
      WHERE client_id = $1 AND status = 'active' LIMIT 1`,
    [clientId]
  );
  const row = r.rows[0];
  if (!row || !row.hardware_api_key) return null;
  return { platform: row.hardware_platform || 'kisi', apiKey: decryptApiKey(row.hardware_api_key) };
}

function _baseUrl(req) {
  const env = (process.env.CORE_ENGINE_URL || '').replace(/\/$/, '');
  if (env) return env;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}

// One day-pass row, newest live one first. `where` picks the buyer: by Wix member id
// (the Velo lookup) or by access id (the branded page, from its signed view token).
function _passQuery(where) {
  return `SELECT ma.id AS access_id, mas.role_assignment_id, mas.status AS source_status,
                 mas.effective_start, mas.valid_until, pm.plan_name, pm.door_name, mm.email
          FROM member_master mm
          JOIN member_access ma ON ma.member_master_id = mm.id
          JOIN member_access_sources mas ON mas.access_id = ma.id
          LEFT JOIN plan_mappings pm ON pm.id = mas.mapping_id
          WHERE ${where}
            AND mas.source_type = 'day_pass'
            AND mas.status IN ('active', 'pending_hardware')
          ORDER BY (mas.status = 'active') DESC, mas.valid_until DESC NULLS LAST, mas.created_at DESC
          LIMIT 1`;
}

/**
 * The shared answer for one day-pass row: pending / expired / ready (+ a signed QR URL).
 * Both the Velo lookup and the branded page's info call use it, so the two always agree.
 */
async function _passResponse(req, clientId, platformMemberId, row) {
  const base = {
    planName:   row.plan_name || null,
    doorName:   row.door_name || null,
    validFrom:  row.effective_start || null,
    validUntil: row.valid_until || null,
    // Where the day_pass_ready email goes (the buyer's Wix email), so the page can say
    // so. Only released behind a signed request or token; never logged. null when it
    // isn't cached.
    email:      row.email || null,
  };
  if (row.source_status !== 'active' || !row.role_assignment_id) {
    return { status: 'pending', ...base };
  }
  if (row.valid_until && Date.parse(row.valid_until) <= Date.now()) {
    return { status: 'expired', ...base };
  }

  const hw = await _clientHardware(clientId);
  let link = null;
  if (hw) {
    try {
      link = await hardwareAdapter.getGroupLink(hw.platform, hw.apiKey, row.role_assignment_id);
    } catch (err) {
      log.warn('member.day_pass.link_fetch_failed', {
        clientId, accessId: row.access_id, code: err.code || null, statusCode: err.statusCode || null,
      });
    }
  }
  const qrAvailable = !!(link && (link.qrImageBase64 || link.qrImageUrl));
  const qrUrl = qrAvailable
    ? `${_baseUrl(req)}/member/day-pass/qr.png?t=${encodeURIComponent(signQrToken({
        clientId, accessId: row.access_id, linkId: row.role_assignment_id, exp: Date.now() + QR_TOKEN_TTL_MS,
      }))}`
    : null;

  log.info('member.day_pass.ready', {
    clientId, platformMemberId, accessId: row.access_id, qrAvailable, hasLink: !!(link && link.linkUrl),
  });
  return {
    status: 'ready', ...base,
    // QR only — the access link unlocks from anywhere, so it is never put on a web page.
    unlockUrl: null,
    qrUrl,
    qrAvailable,
  };
}

/**
 * POST /member/day-pass  body: { platformMemberId }
 * → { status: 'none' | 'pending' | 'expired' | 'ready', planName, doorName, validFrom,
 *     validUntil, email, unlockUrl, qrUrl, qrAvailable, pageToken }
 * 'pending' = the purchase landed but the Kisi link is still being created (claim row);
 * the page keeps polling. 'none' = no day pass for this member — not a day-pass purchase.
 * pageToken (pending / ready only) opens the gym-branded day-pass page on the admin app
 * for 15 minutes; the Wix button links there instead of showing the QR on a Wix page.
 */
async function handleLookup(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const clientId  = req.headers['x-accesssync-client-id'] || null;
    const signature = req.headers['x-wix-signature'];
    const rawBody   = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));

    if (!clientId || !(await wixConnector.verifySignedRequest(rawBody, signature, clientId))) {
      log.warn('member.day_pass.rejected', { clientId, reason: 'hmac' });
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const platformMemberId = req.body && req.body.platformMemberId;
    if (!platformMemberId || typeof platformMemberId !== 'string') {
      return res.status(400).json({ error: 'platformMemberId is required' });
    }

    const row = (await db.query(
      _passQuery(`mm.platform_member_id = $1 AND mm.source_platform = 'wix' AND ma.client_id = $2`),
      [platformMemberId, clientId]
    )).rows[0];

    log.info('member.day_pass.lookup', {
      clientId, platformMemberId, found: !!row, sourceStatus: row ? row.source_status : null,
    });
    if (!row) return res.json({ status: 'none' });

    const out = await _passResponse(req, clientId, platformMemberId, row);
    if (out.status === 'pending' || out.status === 'ready') {
      out.pageToken = signViewToken({ clientId, accessId: row.access_id, exp: Date.now() + VIEW_TOKEN_TTL_MS });
    }
    return res.json(out);
  } catch (err) {
    log.error('member.day_pass.error', {}, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /member/day-pass/info?t=<view token>
 * What the branded day-pass page shows. Same answer as the lookup, minus the token mint,
 * plus the clientId so the admin app can load the gym's branding. The token is the only
 * credential: it comes from the HMAC-signed POST above and lives 15 minutes.
 */
async function handleInfo(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const tok = verifyViewToken(req.query && req.query.t);
    if (!tok) return res.status(401).json({ error: 'Unauthorized' });

    const row = (await db.query(
      _passQuery(`ma.id = $1 AND ma.client_id = $2`),
      [tok.accessId, tok.clientId]
    )).rows[0];
    if (!row) return res.status(404).json({ status: 'none', clientId: tok.clientId });

    const out = await _passResponse(req, tok.clientId, null, row);
    return res.json({ ...out, clientId: tok.clientId });
  } catch (err) {
    log.error('member.day_pass.info_error', {}, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /member/day-pass/qr.png?t=<token>
 * Streams the Kisi QR image for the pass the token names. The token is re-checked
 * against the live row so it outlives neither the pass nor a revoke.
 */
async function handleQrImage(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    const tok = verifyQrToken(req.query && req.query.t);
    if (!tok) return res.status(401).send('Unauthorized');

    const row = (await db.query(
      `SELECT 1 FROM member_access_sources
        WHERE access_id = $1 AND client_id = $2 AND source_type = 'day_pass'
          AND role_assignment_id = $3 AND status = 'active'
          AND (valid_until IS NULL OR valid_until > NOW())
        LIMIT 1`,
      [tok.accessId, tok.clientId, tok.linkId]
    )).rows[0];
    if (!row) return res.status(404).send('Not found');

    const hw = await _clientHardware(tok.clientId);
    if (!hw) return res.status(404).send('Not found');
    const link = await hardwareAdapter.getGroupLink(hw.platform, hw.apiKey, tok.linkId);
    if (!link) return res.status(404).send('Not found');

    if (link.qrImageBase64) {
      log.info('member.day_pass.qr_served', { clientId: tok.clientId, accessId: tok.accessId });
      res.type(link.qrImageMime || 'image/png');
      return res.send(Buffer.from(link.qrImageBase64, 'base64'));
    }
    if (link.qrImageUrl) return res.redirect(302, link.qrImageUrl);
    return res.status(404).send('Not found');
  } catch (err) {
    log.error('member.day_pass.qr_error', {}, err);
    return res.status(500).send('Internal server error');
  }
}

module.exports = {
  handleLookup, handleInfo, handleQrImage,
  signQrToken, verifyQrToken, signViewToken, verifyViewToken,
  QR_TOKEN_TTL_MS, VIEW_TOKEN_TTL_MS,
};
