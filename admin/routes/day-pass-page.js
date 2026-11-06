/**
 * @file day-pass-page.js
 * @layer admin/routes
 * @role member-facing-page
 * @route GET /day-pass?t=<view token> · GET /day-pass/data?t=<view token>
 * @auth none — the signed view token is the only credential. It is minted by the gym's own
 *       Wix backend through core POST /member/day-pass (HMAC-signed) and lasts 15 minutes.
 * @reads clients (name, logo, colors, site url, qr_guide_url — branding only)
 * @calls core GET /member/day-pass/info
 * @ob OB-98, OB-251
 *
 * The gym's Wix Thank You page has one button that opens this page. It is branded from the
 * gym's clients row exactly like the Member Hub and the emails (core/member-hub-branding.js).
 * This app never sees the QR itself, only the core's 10-minute signed image URL.
 */

'use strict';

const express = require('express');
const db = require('../../db');
const { log } = require('../../core/logger');
const { hubBranding } = require('../../core/member-hub-branding');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TOKEN_LEN = 2000;

async function fetchPassInfo(token) {
  const coreUrl = (process.env.CORE_ENGINE_URL || 'https://accesssync-production.up.railway.app').replace(/\/$/, '');
  const upstream = await fetch(`${coreUrl}/member/day-pass/info?t=${encodeURIComponent(token)}`);
  const text = await upstream.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { status: 'none' }; }
  return { httpStatus: upstream.status, data };
}

// A timed-out link can no longer show the pass, but the gym's name and logo are public, so
// read the client id out of the (unverified) payload for branding only. Nothing about the
// pass is released on that basis.
function clientIdHint(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[0], 'base64url').toString('utf8'));
    return UUID_RE.test(payload && payload.c) ? payload.c : null;
  } catch (_) { return null; }
}

const tokenFrom = (req) => (typeof req.query.t === 'string' && req.query.t.length <= MAX_TOKEN_LEN ? req.query.t : '');

router.get('/data', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = tokenFrom(req);
  if (!token) return res.status(400).json({ status: 'none' });
  try {
    const { httpStatus, data } = await fetchPassInfo(token);
    if (httpStatus !== 200) return res.status(404).json({ status: 'none' });
    return res.json(data);
  } catch (err) {
    log.warn('admin.day_pass_proxy_failed', {}, err);
    return res.status(502).json({ status: 'none' });
  }
});

router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = tokenFrom(req);
  let boot = { status: 'none' };
  let clientId = token ? clientIdHint(token) : null;
  if (token) {
    try {
      const { httpStatus, data } = await fetchPassInfo(token);
      if (httpStatus === 200) { boot = data; clientId = data.clientId || clientId; }
    } catch (err) {
      log.warn('admin.day_pass_page_lookup_failed', {}, err);
    }
  }

  let branding = hubBranding(undefined);
  let qrGuideUrl = null;
  if (clientId) {
    try {
      const r = await db.query(
        `SELECT name, email_logo_url, email_primary_color, email_secondary_color,
                source_site_url, status, archived_at, qr_guide_url
         FROM clients WHERE id = $1`,
        [clientId]
      );
      const row = r.rows[0];
      branding = hubBranding(row);
      if (row && row.status === 'active' && !row.archived_at) qrGuideUrl = row.qr_guide_url || null;
    } catch (_) {
      // plain AccessSync mark — never block the pass on a branding lookup
    }
  }

  // clientId is for branding only; the page never needs it.
  const { clientId: _omit, ...bootForPage } = boot;
  res.render('pages/day-pass', {
    boot: bootForPage,
    token,
    qrGuideUrl,
    gymName: branding.gymName,
    gymLogoUrl: branding.logoUrl,
    gymPrimaryColor: branding.primaryColor,
    gymButtonColor: branding.buttonColor,
    gymBarText: branding.barText,
    gymSiteUrl: branding.siteUrl,
  });
});

module.exports = router;
