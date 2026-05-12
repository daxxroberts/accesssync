/**
 * @file hardware-health-check.js
 * @layer core/layer4
 * @role cron-6hr
 * @schedule every 6 hours via Railway Cron
 * @reads locations, clients, connector_subscriptions, plan_mappings, plan_mapping_groups
 * @writes connector_subscriptions.key_last_verified, connector_subscriptions.key_last_error, plan_mapping_groups.health_status, plan_mapping_groups.door_name, plan_mappings.door_name, plan_mappings.source_status
 * @calls hardware-adapter (getLocks, getGroups), wix-plans-api (listPricingPlans), resend (alerts)
 * @exports runHealthCheck
 * @dr DR-028, DR-037
 *
 * hardware-health-check.js
 * Core Engine (Layer 4) — Sprint 5 ticket 5.2
 *
 * Runs every 6 hours via Railway Cron: node core/hardware-health-check.js
 *
 * Responsibilities:
 * - For each active client, validate their stored hardware API key
 * - Test: call getLocks() (lightweight, read-only) — success = key valid
 * - On failure: send a specific diagnosis email (wrong key / no key / permissions)
 * - Update locations.hardware_key_last_verified + hardware_key_last_error
 *
 * Error types and messages:
 *   401 → key is wrong or expired
 *   403 → key valid but lacks required permissions (not on Pro tier)
 *   no key → key was never set
 *   network → Railway or Kisi connectivity issue (transient, not operator fault)
 */

'use strict';

const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const { decryptApiKey } = require('./crypto-utils');
const { log } = require('./logger');
const { runWith, mintTraceId } = require('./trace-context');

async function runHealthCheck() {
  const traceId = mintTraceId();
  return runWith(
    { traceId, actor: { type: 'system', id: 'hardware-health-check-cron' } },
    () => _runHealthCheckBody()
  );
}

async function _runHealthCheckBody() {
  log.info('health.check_start', {});

  // Per-location iteration: each active location gets its own key + platform check
  const locationsResult = await db.query(
    `SELECT l.id AS location_id, l.name AS location_name, l.client_id,
            cs.hardware_api_key, cs.hardware_platform, cs.id AS connector_id,
            COALESCE(l.notification_email, c.notification_email) AS notification_email,
            c.name AS client_name
     FROM locations l
     JOIN clients c ON c.id = l.client_id
     JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
     WHERE c.status = 'active' AND l.subscription_status = 'active'`
  );

  for (const loc of locationsResult.rows) {
    await _checkLocation(loc);
  }

  log.info('health.check_complete', {});
}

async function _checkLocation(loc) {
  const platform = loc.hardware_platform;

  const encKey = loc.hardware_api_key;
  if (!encKey) {
    const msg = 'No hardware API key configured. Set your API key in the AccessSync dashboard under this location.';
    log.warn('health.no_key', { clientId: loc.client_id, location: loc.location_name });
    await _notifyFailure(loc, null, 'no_key', msg);
    await _updateLocationVerification(loc.connector_id, null, msg);
    return;
  }

  let apiKey;
  try {
    apiKey = decryptApiKey(encKey);
  } catch (err) {
    log.error('health.key_decrypt_failed', { clientId: loc.client_id, location: loc.location_name }, err);
    return;
  }

  // Test: call getLocks() — lightweight read-only validation
  let error = null;
  let errorType = null;
  try {
    await hardwareAdapter.getLocks(platform, apiKey);
    log.info('health.key_valid', { clientId: loc.client_id, location: loc.location_name });
  } catch (err) {
    error = err;
    if (err.statusCode === 401) {
      errorType = 'invalid_key';
    } else if (err.statusCode === 403) {
      errorType = 'insufficient_permissions';
    } else {
      errorType = 'network_error';
    }
    log.warn('health.key_check_failed', { clientId: loc.client_id, location: loc.location_name, errorType }, err);
  }

  const errorMsg = error ? _diagnose(errorType, platform) : null;
  await _updateLocationVerification(loc.connector_id, error ? null : new Date(), errorMsg);

  // Notify only on actionable errors (skip transient network issues)
  if (errorType && errorType !== 'network_error') {
    await _notifyFailure(loc, errorType, errorType, errorMsg);
  }

  // If key check passed, reconcile mapped groups against live groups
  if (!error) {
    await _reconcileGroups(loc, platform, apiKey);
  }

  // Reconcile Wix plan statuses (independent of hardware key check)
  await _reconcileWixPlans(loc);
}

/**
 * Cross-check mapped hardware group IDs against live groups from the hardware platform.
 * K-2: Flags specific dead group rows in plan_mapping_groups — does NOT deactivate entire mappings.
 * Other groups on the same mapping keep working. Sends operator email with affected member counts.
 */
async function _reconcileGroups(loc, platform, apiKey) {
  let liveGroups;
  try {
    liveGroups = await hardwareAdapter.getGroups(platform, apiKey);
  } catch (err) {
    log.warn('health.get_groups_failed', { clientId: loc.client_id }, err);
    return;
  }

  // Guard: if empty response, skip reconciliation — prevents mass-flagging on API failure
  if (!liveGroups || liveGroups.length === 0) {
    log.info('health.groups_skipped', { clientId: loc.client_id, reason: 'empty_response' });
    return;
  }

  const liveGroupIdSet = new Set(liveGroups.map(g => String(g.id)));
  const liveGroupNameMap = new Map(liveGroups.map(g => [String(g.id), g.name]));

  // Query all mapped group IDs for this client (junction table + legacy single-group)
  const mappedResult = await db.query(
    `SELECT DISTINCT pmg.hardware_group_id, pm.id AS mapping_id, pm.plan_name,
            COALESCE(pmg.health_status, 'ok') AS current_health,
            pmg.door_name AS cached_name
     FROM plan_mapping_groups pmg
     JOIN plan_mappings pm ON pmg.mapping_id = pm.id
     WHERE pm.client_id = $1 AND pm.status = 'active'
     UNION
     SELECT DISTINCT pm.hardware_group_id, pm.id AS mapping_id, pm.plan_name,
            'legacy' AS current_health,
            pm.door_name AS cached_name
     FROM plan_mappings pm
     WHERE pm.client_id = $1 AND pm.status = 'active'
       AND pm.hardware_group_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM plan_mapping_groups pmg2 WHERE pmg2.mapping_id = pm.id)`,
    [loc.client_id]
  );

  // Detect orphans (mapped group IDs not in the live set) — skip already-flagged groups
  const orphans = mappedResult.rows.filter(r =>
    !liveGroupIdSet.has(String(r.hardware_group_id)) && r.current_health !== 'not_found'
  );

  // Detect recovered groups (previously not_found but now alive again)
  const recovered = mappedResult.rows.filter(r =>
    liveGroupIdSet.has(String(r.hardware_group_id)) && r.current_health === 'not_found'
  );

  // Sync stale group names first — runs even when no orphans or recoveries
  let namesUpdated = 0;
  for (const row of mappedResult.rows) {
    const liveName = liveGroupNameMap.get(String(row.hardware_group_id));
    if (!liveName || liveName === row.cached_name) continue;
    if (row.current_health === 'legacy') {
      await db.query(
        `UPDATE plan_mappings SET door_name = $1 WHERE id = $2 AND hardware_group_id = $3`,
        [liveName, row.mapping_id, row.hardware_group_id]
      );
    } else {
      await db.query(
        `UPDATE plan_mapping_groups SET door_name = $1 WHERE mapping_id = $2 AND hardware_group_id = $3`,
        [liveName, row.mapping_id, row.hardware_group_id]
      );
    }
    namesUpdated++;
  }
  if (namesUpdated > 0) {
    log.info('health.group_names_synced', { clientId: loc.client_id, count: namesUpdated });
  }

  if (orphans.length === 0 && recovered.length === 0) return;

  // Flag orphaned groups at the group level — mapping stays active
  for (const orphan of orphans) {
    if (orphan.current_health === 'legacy') {
      // Legacy row: create a junction row with not_found status
      await db.query(
        `INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id, health_status)
         VALUES ($1, $2, 'not_found') ON CONFLICT (mapping_id, hardware_group_id) DO UPDATE SET health_status = 'not_found'`,
        [orphan.mapping_id, orphan.hardware_group_id]
      );
    } else {
      await db.query(
        `UPDATE plan_mapping_groups SET health_status = 'not_found'
         WHERE mapping_id = $1 AND hardware_group_id = $2`,
        [orphan.mapping_id, orphan.hardware_group_id]
      );
    }

    // Distinct member count for this (mapping, hardware_group) pair, via the access JOIN.
    const memberCount = await db.query(
      `SELECT COUNT(DISTINCT ma.member_master_id) AS cnt
       FROM member_access_sources mas
       JOIN member_access ma ON ma.id = mas.access_id
       WHERE mas.mapping_id = $1 AND mas.hardware_group_id = $2`,
      [orphan.mapping_id, orphan.hardware_group_id]
    );
    orphan.affectedMembers = parseInt(memberCount.rows[0].cnt, 10);

    const err = new Error(`Group ${orphan.hardware_group_id} no longer exists in ${platform}`);
    err.code = 'HARDWARE_RESOURCE_NOT_FOUND';
    log.warn('health.group_orphaned', {
      clientId: loc.client_id,
      mappingId: orphan.mapping_id,
      hardwareGroupId: orphan.hardware_group_id,
      planName: orphan.plan_name,
      affectedMembers: orphan.affectedMembers,
    }, err);
  }

  // Recover groups that are alive again
  for (const rec of recovered) {
    await db.query(
      `UPDATE plan_mapping_groups SET health_status = 'ok'
       WHERE mapping_id = $1 AND hardware_group_id = $2`,
      [rec.mapping_id, rec.hardware_group_id]
    );
    log.info('health.group_recovered', {
      clientId: loc.client_id, mappingId: rec.mapping_id,
      hardwareGroupId: rec.hardware_group_id,
    });
  }

  if (orphans.length > 0) {
    log.info('health.groups_orphaned', { clientId: loc.client_id, count: orphans.length });
    await _notifyOrphanedGroups(loc, orphans, platform);
  }
  if (recovered.length > 0) {
    log.info('health.groups_recovered', { clientId: loc.client_id, count: recovered.length });
  }
}

async function _notifyOrphanedGroups(loc, orphans, platform) {
  const toEmail = loc.notification_email || process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
  if (!toEmail) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const groupList = orphans.map(o => {
      const memberNote = o.affectedMembers > 0
        ? ` — ${o.affectedMembers} member(s) affected`
        : ' — no members currently assigned';
      return `  - ${o.plan_name || 'Unknown plan'}: Group ${o.hardware_group_id}${memberNote}`;
    }).join('\n');

    const totalAffected = orphans.reduce((sum, o) => sum + (o.affectedMembers || 0), 0);

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'alerts@accesssync.io',
      to: toEmail,
      subject: `[AccessSync] ${orphans.length} access group(s) no longer found in ${platform}`,
      text: [
        `AccessSync Group Alert — ${new Date().toISOString()}`,
        '',
        `Client: ${loc.client_name}`,
        `Location: ${loc.location_name}`,
        '',
        `The following ${platform} group(s) are mapped in AccessSync but no longer exist in ${platform}:`,
        '',
        groupList,
        '',
        totalAffected > 0
          ? `${totalAffected} member(s) may have lost access and will need to be remapped to a new group.`
          : 'No members are currently affected.',
        '',
        'These groups have been flagged in your dashboard. Other groups on the same plan continue to work normally.',
        '',
        'To fix this: log in to AccessSync → Plan Mapping → remap or remove the affected groups.',
      ].join('\n'),
    });
    log.info('health.orphan_alert_sent', { toEmail });
  } catch (err) {
    log.error('health.orphan_alert_failed', { toEmail }, err);
  }
}

/**
 * Cross-check plan_mappings against live source platform plan statuses.
 * Detects archived plans and updates plan_mappings.source_status accordingly.
 * Informational only — archived plans still function until member subscriptions expire.
 */
async function _reconcileWixPlans(loc) {
  // Load source platform API credentials for this client
  const clientResult = await db.query(
    `SELECT source_api_key, platform_instance_id FROM clients WHERE id = $1`,
    [loc.client_id]
  );
  const client = clientResult.rows[0];
  if (!client || !client.source_api_key || !client.platform_instance_id) return;

  let wixApiKey;
  try {
    wixApiKey = decryptApiKey(client.source_api_key);
  } catch {
    return; // Can't decrypt — skip silently
  }

  const wixPlansApi = require('../adapters/wix/wix-plans-api');
  let wixPlans;
  try {
    wixPlans = await wixPlansApi.listPricingPlans(wixApiKey, client.platform_instance_id);
  } catch (err) {
    log.warn('health.wix_plans_fetch_failed', { clientId: loc.client_id }, err);
    return;
  }

  if (!wixPlans || wixPlans.length === 0) return;

  // Build lookup: planId → status
  const wixStatusMap = new Map(wixPlans.map(p => [p.id, p.status]));

  // Get all plan mappings for this client that we're tracking
  const mappingsResult = await db.query(
    `SELECT id, source_plan_id, plan_name, source_status FROM plan_mappings
     WHERE client_id = $1 AND status = 'active'`,
    [loc.client_id]
  );

  const newlyArchived = [];

  for (const mapping of mappingsResult.rows) {
    const wixStatus = wixStatusMap.get(mapping.source_plan_id);
    if (!wixStatus) continue; // Plan not found in Wix response — may be a booking service, skip

    const isArchived = wixStatus === 'archived';
    const wasArchived = mapping.source_status === 'archived';

    if (isArchived && !wasArchived) {
      // Newly archived
      await db.query(
        `UPDATE plan_mappings SET source_status = 'archived' WHERE id = $1`,
        [mapping.id]
      );
      // Affected member count — see comment above for member_role_assignments → member_access_sources migration.
      const memberCount = await db.query(
        `SELECT COUNT(DISTINCT ma.member_master_id) AS cnt
         FROM member_access_sources mas
         JOIN member_access ma ON ma.id = mas.access_id
         WHERE mas.mapping_id = $1`,
        [mapping.id]
      );
      newlyArchived.push({
        ...mapping,
        affectedMembers: parseInt(memberCount.rows[0].cnt, 10),
      });
      log.info('health.wix_plan_archived', {
        clientId: loc.client_id, mappingId: mapping.id,
        planName: mapping.plan_name, sourcePlanId: mapping.source_plan_id,
      });
    } else if (!isArchived && wasArchived) {
      // Recovered — was archived but now active again (unlikely but safe)
      await db.query(
        `UPDATE plan_mappings SET source_status = 'active' WHERE id = $1`,
        [mapping.id]
      );
      log.info('health.wix_plan_recovered', {
        clientId: loc.client_id, mappingId: mapping.id,
        planName: mapping.plan_name,
      });
    }
  }

  if (newlyArchived.length > 0) {
    log.info('health.wix_plans_archived', { clientId: loc.client_id, count: newlyArchived.length });
    await _notifyArchivedPlans(loc, newlyArchived);
  }
}

async function _notifyArchivedPlans(loc, archivedPlans) {
  const toEmail = loc.notification_email || process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
  if (!toEmail) return;

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const planList = archivedPlans.map(p => {
      const memberNote = p.affectedMembers > 0
        ? `${p.affectedMembers} member(s) still have active access`
        : 'no members currently assigned';
      return `  - ${p.plan_name || p.source_plan_id} — ${memberNote}`;
    }).join('\n');

    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'alerts@accesssync.io',
      to: toEmail,
      subject: `[AccessSync] ${archivedPlans.length} plan(s) archived on Wix`,
      text: [
        `AccessSync Plan Status Update — ${new Date().toISOString()}`,
        '',
        `Client: ${loc.client_name}`,
        `Location: ${loc.location_name}`,
        '',
        'The following Wix plan(s) have been archived:',
        '',
        planList,
        '',
        'This is informational. Members with active subscriptions keep their access until their billing cycle ends naturally. No action is needed unless you want to remap these members to a different plan.',
        '',
        'You can view affected plans in AccessSync → Plan Mapping.',
      ].join('\n'),
    });
    log.info('health.archived_plan_alert_sent', { toEmail });
  } catch (err) {
    log.error('health.archived_plan_alert_failed', { toEmail }, err);
  }
}

function _diagnose(errorType, platform) {
  switch (errorType) {
    case 'invalid_key':
      return `Your ${platform} API key was rejected (401 Unauthorized). The key may have been rotated or deleted. Generate a new key in your ${platform} account and update it in the AccessSync dashboard under Locations.`;
    case 'insufficient_permissions':
      return `Your ${platform} API key authenticated but lacks required permissions (403 Forbidden). Confirm your account is on the Pro tier — the API key must have access to locks, groups, and role assignments.`;
    case 'network_error':
      return `AccessSync could not reach the ${platform} API. This is likely a temporary connectivity issue and will resolve automatically.`;
    default:
      return `Unknown error communicating with ${platform}.`;
  }
}

async function _updateLocationVerification(connectorId, verifiedAt, errorMsg) {
  await db.query(
    `UPDATE connector_subscriptions
     SET key_last_verified = $1,
         key_last_error    = $2
     WHERE id = $3`,
    [verifiedAt, errorMsg, connectorId]
  ).catch(e => log.error('health.connector_update_failed', { connectorId }, e));
}

async function _notifyFailure(loc, locName, errorType, message) {
  const toEmail = loc.notification_email || process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
  if (!toEmail) {
    log.warn('health.no_notification_email', { clientId: loc.client_id, location: loc.location_name });
    return;
  }

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const subject = errorType === 'invalid_key'
      ? '[AccessSync] Action required: hardware API key rejected'
      : errorType === 'insufficient_permissions'
        ? '[AccessSync] Action required: API key permissions issue'
        : '[AccessSync] Hardware API key check failed';

    await resend.emails.send({
      from:    process.env.RESEND_FROM_EMAIL || 'alerts@accesssync.io',
      to:      toEmail,
      subject,
      text: [
        `AccessSync Hardware Key Alert — ${new Date().toISOString()}`,
        '',
        `Client: ${loc.client_name}`,
        `Location: ${loc.location_name}`,
        '',
        message,
        '',
        'To fix this: log in to the AccessSync dashboard → System Config → Update the API key for this location.',
        '',
        'Members will not lose existing access, but new signups will not provision until the key is corrected.',
      ].join('\n'),
    });
    log.info('health.alert_sent', { toEmail, location: loc.location_name });
  } catch (err) {
    log.error('health.alert_send_failed', { toEmail, location: loc.location_name }, err);
  }
}

// Executable entry point for Railway Cron
if (require.main === module) {
  runHealthCheck()
    .then(() => process.exit(0))
    .catch(err => { log.critical('health.fatal', {}, err); process.exit(1); });
}

module.exports = { runHealthCheck };
