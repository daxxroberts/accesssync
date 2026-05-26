/**
 * @file admin/routes/wix-admins.js
 * @layer admin/routes
 * @role wix-admin-tracking
 *
 * Surfaces wix_admin_seen for the Administrators section on /admin-panel.
 * Returns the list of Wix users who have authenticated to AccessSync per client,
 * joined to clients.notification_email for operator-readable display.
 *
 * Auth: requireAuth (admin JWT, owner-only) — mounted at /admin/wix-admins.
 */

'use strict';

const express = require('express');
const db = require('../../db');
const { log } = require('../../core/logger');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         was.client_id,
         c.name             AS client_name,
         c.notification_email,
         was.wix_uid,
         was.permissions,
         was.first_seen_at,
         was.last_seen_at,
         was.seen_count
       FROM wix_admin_seen was
       JOIN clients c ON c.id = was.client_id
       ORDER BY c.name ASC, was.last_seen_at DESC`
    );
    res.json({
      generated_at: new Date().toISOString(),
      admins: result.rows.map(r => ({
        client_id:          r.client_id,
        client_name:        r.client_name,
        notification_email: r.notification_email || null,
        wix_uid:            r.wix_uid,
        permissions:        r.permissions,
        first_seen_at:      r.first_seen_at,
        last_seen_at:       r.last_seen_at,
        seen_count:         r.seen_count,
      })),
    });
  } catch (err) {
    log.error('admin.wix_admins.list_failed', {}, err);
    res.status(500).json({ error: 'Failed to load Wix admin list' });
  }
});

module.exports = router;
