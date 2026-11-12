/**
 * @file login-email-swap.js
 * @layer core/layer4
 * @role orchestrator — a changed Wix login email moves the member's door login
 * @reads clients, member_master, member_access, member_access_sources, member_access_log, connector_subscriptions, plan_mappings
 * @writes (nothing directly: member_master / member_access / member_access_sources go through standard-adapter, DR-023)
 * @calls standard-adapter (completeLoginEmailSwap, storeLoginEmail), hardware-adapter (findUserByEmail, assertUserDeletable, getUserById, createUser, assignRole, suspendAccess, deleteUser), member-mailer (sendMemberEmail)
 * @dr DR-056 (builds on DR-043, DR-045, DR-052)
 *
 * core/login-email-swap.js
 *
 * Kisi cannot edit a user's email, so when Wix says a member's login email changed we
 * SWAP the Kisi user: create the new one first, move the door groups to it, update our
 * records in one transaction, and only then delete the old one. The member is never
 * without access. Runs inside the queue worker's per-member lock (job 'email_swap').
 *
 * Matching is by Wix member ID (member_master.platform_member_id) — the email is the
 * thing that changed, so it can never be the key.
 *
 * Order of the checks (cheapest and most reversible first; nothing is changed until
 * every check has passed):
 *   email really changed → Wix says the new email is verified →
 *   not a shared Kisi login → not swapped in the last 30 days → no live day pass →
 *   new email free in Kisi → old Kisi user is ours (DR-045 B+C, read-only) →
 *   CREATE new user → ASSIGN groups → ONE DB TRANSACTION → DELETE old user → emails.
 *
 * Failure behaviour:
 *   before the transaction commits  the new Kisi user is deleted again and our records
 *                                   are untouched; the old user was never touched.
 *   old-user delete refused/failed  the member is fully moved and working, so the swap
 *                                   stands; the job is flagged on the Errors page
 *                                   (LOGIN_EMAIL_OLD_USER_NOT_REMOVED) and NO emails
 *                                   are sent (SAGE requirement 2: emails only follow a
 *                                   swap that finished cleanly).
 * Emails (access_ready to the new address, login_email_changed to the old one) are
 * fire-and-forget through the DR-052 mailer: gated by member_emails_enabled, deduped by
 * member_email_log, branded live from the clients row, and never able to fail the swap.
 *
 * No email address is ever written to a log line (DR-001).
 */

'use strict';

const db = require('../db');
const { log } = require('./logger');
const standardAdapter = require('../adapters/standard-adapter');
const hardwareAdapter = require('../adapters/hardware-adapter');
const memberMailer = require('./member-mailer');
const templates = require('./email-templates');

const RATE_LIMIT_DAYS = 30;
const MAX_DEFER_MS = 24 * 60 * 60 * 1000;
const MIN_DEFER_MS = 60 * 1000;
// Wix reports a brand-new login email as unverified for a few seconds (trace 435a2a4e): wait once before
// treating it as a real problem. The verified update arrives as its own event and stores the email; when this
// job runs again it finds nothing left to do.
const UNVERIFIED_WAIT_MS = 5 * 60 * 1000;
const SWAP_EVENT = 'login_email_swapped';

/**
 * A condition that stops the swap and needs a person. statusCode 409 makes the queue
 * worker dead-letter it on the first attempt (a retry would hit the same wall) so it
 * shows on the Errors page with the guidance in core/error-guidance.js.
 */
class SwapBlocked extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SwapBlocked';
    this.code = code;
    this.statusCode = 409;
  }
}

const norm = (email) => String(email || '').trim().toLowerCase();

async function _loadClientSettings(tenantId) {
  const r = await db.query(
    `SELECT notification_email FROM clients WHERE id = $1`,
    [tenantId]
  );
  const row = r.rows[0] || {};
  return { adminEmail: row.notification_email || null };
}

async function _findPerson(tenantId, platformMemberId) {
  const r = await db.query(
    `SELECT mm.id AS member_master_id, mm.email, mm.first_name, mm.last_name, mm.display_name,
            ma.id AS access_id, ma.hardware_user_id, ma.hardware_platform, ma.status
       FROM member_master mm
       JOIN member_access ma ON ma.member_master_id = mm.id AND ma.client_id = mm.client_id
      WHERE mm.client_id = $1 AND mm.source_platform = 'wix' AND mm.platform_member_id = $2
      LIMIT 1`,
    [tenantId, platformMemberId]
  );
  return r.rows[0] || null;
}

function _displayName(p) {
  return [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
    || (p.display_name && String(p.display_name).trim())
    || null;
}

/** One entry per door group: the permanent source wins, otherwise the latest end date. */
function _groupsToMove(sourceRows) {
  const byGroup = new Map();
  for (const s of sourceRows) {
    const g = byGroup.get(s.hardware_group_id) || { groupId: s.hardware_group_id, validUntil: undefined, sourceIds: [], mappingIds: new Set() };
    g.sourceIds.push(s.id);
    if (s.mapping_id) g.mappingIds.add(s.mapping_id);
    if (s.valid_until === null || s.valid_until === undefined) g.validUntil = null;
    else if (g.validUntil !== null) {
      const t = new Date(s.valid_until).getTime();
      if (g.validUntil === undefined || t > new Date(g.validUntil).getTime()) g.validUntil = s.valid_until;
    }
    byGroup.set(s.hardware_group_id, g);
  }
  return [...byGroup.values()].map(g => ({ ...g, validUntil: g.validUntil === undefined ? null : g.validUntil }));
}

async function _deleteNewUserQuietly(platform, apiKey, newUserId, tenantId, logger, ctx) {
  try {
    await hardwareAdapter.deleteUser(platform, apiKey, newUserId, { clientId: tenantId });
    logger.warn('login_email_swap.rolled_back', { ...ctx, newUserId, stage: 'swap', result: 'rolled_back' });
  } catch (err) {
    // The old user is untouched and still works; only a stray new user is left. Loud, not fatal.
    logger.error('login_email_swap.rollback_failed', { ...ctx, newUserId, stage: 'swap', result: 'failed' }, err);
  }
}

/**
 * @param {Object}   p
 * @param {string}   p.tenantId
 * @param {Object}   p.standardEvent   normalized member.updated event
 * @param {string}   p.eventId
 * @param {Object}   [p.logger]
 * @param {Function} p.getApiKey       async (tenantId) => decrypted hardware API key | null
 * @param {boolean}  [p.unverifiedWaited] true once this job has already waited for Wix to verify the email
 * @returns {Promise<{status: 'skipped'|'email_stored'|'deferred'|'swapped', reason?: string, delayMs?: number}>}
 * @throws {SwapBlocked} a condition a person has to look at (dead-letters, not retried)
 */
async function runLoginEmailSwap({ tenantId, standardEvent, eventId, logger = log, getApiKey, unverifiedWaited = false }) {
  const platformMemberId = standardEvent.platformMemberId;
  const ctx = { clientId: tenantId, eventId, platformMemberId };
  const skip = (reason, extra = {}) => {
    logger.info('login_email_swap.skipped', { ...ctx, reason, stage: 'swap', result: 'skipped', ...extra });
    return { status: 'skipped', reason };
  };

  // 1. Did the login email really change? Most member updates are other profile edits.
  const newEmail = norm(standardEvent.email);
  if (!newEmail) return skip('no_email');
  const person = await _findPerson(tenantId, platformMemberId);
  if (!person) return skip('unknown_member');
  if (person.email && norm(person.email) === newEmail) return skip('unchanged');

  // 3. Only a verified new email may move a door login (WARD: a taken-over Wix login
  //    must not be able to point the door login at an address nobody confirmed).
  if (standardEvent.loginEmailVerified !== true) {
    if (!unverifiedWaited) {
      logger.info('login_email_swap.deferred', { ...ctx, reason: 'email_unverified', delayMs: UNVERIFIED_WAIT_MS, stage: 'swap', result: 'retry' });
      return { status: 'deferred', reason: 'email_unverified', delayMs: UNVERIFIED_WAIT_MS };
    }
    throw new SwapBlocked('LOGIN_EMAIL_UNVERIFIED',
      'Wix has not confirmed the new login email as verified, so the door login was left on the old address');
  }

  // No Kisi user yet (day-pass-only, parked, never granted): nothing to swap. Store the
  // new address so the next grant creates the user on it.
  if (!person.hardware_user_id) {
    await standardAdapter.storeLoginEmail(person.member_master_id, tenantId, String(standardEvent.email).trim());
    logger.info('login_email_swap.email_stored', { ...ctx, stage: 'swap', result: 'success' });
    return { status: 'email_stored' };
  }
  if (person.status === 'in_flight') {
    return { status: 'deferred', reason: 'in_flight', delayMs: 5 * 60 * 1000 };
  }

  const oldUserId = String(person.hardware_user_id);
  const platform = person.hardware_platform || 'kisi';
  const apiKey = await getApiKey(tenantId);
  if (!apiKey) return skip('no_api_key');

  // 4. One Kisi login shared by several people (a sub-member added with the holder's own
  //    email): swapping would move the others' login too. v1 leaves these to a person.
  const shared = await db.query(
    `SELECT 1 FROM member_access WHERE client_id = $1 AND hardware_user_id = $2 AND id <> $3 LIMIT 1`,
    [tenantId, oldUserId, person.access_id]
  );
  if (shared.rows.length) {
    throw new SwapBlocked('LOGIN_EMAIL_SHARED_USER',
      'Other members share this member\'s Kisi login, so it was not swapped automatically');
  }

  // 5. One swap per member per 30 days.
  const recent = await db.query(
    `SELECT 1 FROM member_access_log
      WHERE member_id = $1 AND client_id = $2 AND event_type = $3
        AND created_at > NOW() - ($4 || ' days')::interval LIMIT 1`,
    [person.access_id, tenantId, SWAP_EVENT, String(RATE_LIMIT_DAYS)]
  );
  if (recent.rows.length) {
    throw new SwapBlocked('LOGIN_EMAIL_RATE_LIMITED',
      `This member's door login was already swapped in the last ${RATE_LIMIT_DAYS} days`);
  }

  // 6. A live day-pass QR belongs to the old Kisi user and would die with it: wait.
  const dayPass = await db.query(
    `SELECT valid_until FROM member_access_sources
      WHERE access_id = $1 AND client_id = $2 AND source_type = 'day_pass'
        AND status = 'active' AND (valid_until IS NULL OR valid_until > NOW())`,
    [person.access_id, tenantId]
  );
  if (dayPass.rows.length) {
    const ends = dayPass.rows.map(r => r.valid_until ? new Date(r.valid_until).getTime() : null);
    const latest = ends.includes(null) ? Date.now() + 60 * 60 * 1000 : Math.max(...ends);
    const delayMs = Math.min(Math.max(latest - Date.now() + MIN_DEFER_MS, MIN_DEFER_MS), MAX_DEFER_MS);
    logger.info('login_email_swap.deferred', { ...ctx, reason: 'live_day_pass', delayMs, stage: 'swap', result: 'retry' });
    return { status: 'deferred', reason: 'live_day_pass', delayMs };
  }

  // 7. Kisi side: the new email must be free, and the old user must be ours.
  const existingId = await hardwareAdapter.findUserByEmail(platform, apiKey, newEmail);
  if (existingId && String(existingId) === oldUserId) {
    // Kisi already shows the new email on this user: only our copy is behind.
    await standardAdapter.storeLoginEmail(person.member_master_id, tenantId, String(standardEvent.email).trim());
    logger.info('login_email_swap.email_stored', { ...ctx, stage: 'swap', result: 'success' });
    return { status: 'email_stored' };
  }
  if (existingId) {
    throw new SwapBlocked('LOGIN_EMAIL_IN_USE',
      'The new login email already belongs to a different Kisi user, so nothing was changed');
  }
  let oldUser = null;
  try {
    const checked = await hardwareAdapter.assertUserDeletable(platform, apiKey, oldUserId, { clientId: tenantId });
    oldUser = checked ? checked.user : null; // null: the old Kisi user is already gone
  } catch (err) {
    if (err && ['UNOWNED_USER', 'CLIENT_MISMATCH', 'ELEVATED_ROLE_ATTACHED'].includes(err.code)) {
      throw new SwapBlocked('LOGIN_EMAIL_USER_NOT_OURS',
        'The member\'s Kisi user was not created by AccessSync or holds an admin role, so it was not swapped');
    }
    throw err;
  }
  // Who gets the "your login was changed" notice: the address we had, else the one Kisi has.
  const priorEmail = person.email || (oldUser && oldUser.email) || null;
  if (priorEmail && norm(priorEmail) === newEmail) return skip('unchanged');

  const sourceRows = (await db.query(
    `SELECT id, hardware_group_id, role_assignment_id, valid_until, mapping_id
       FROM member_access_sources
      WHERE access_id = $1 AND client_id = $2 AND status = 'active'
        AND source_type <> 'day_pass'
        AND hardware_group_id IS NOT NULL AND role_assignment_id IS NOT NULL`,
    [person.access_id, tenantId]
  )).rows;
  const groups = _groupsToMove(sourceRows);
  const userPattern = (await db.query(
    `SELECT kisi_user_pattern FROM connector_subscriptions WHERE client_id = $1 AND status = 'active' LIMIT 1`,
    [tenantId]
  ).catch(() => ({ rows: [] }))).rows[0]?.kisi_user_pattern || 'invited';

  // ── Nothing above changed anything. From here on, every failure undoes the new user. ──
  const emailForKisi = String(standardEvent.email).trim();
  const newUserId = String(await hardwareAdapter.createUser(
    platform, apiKey, emailForKisi, _displayName(person), { userPattern, clientId: tenantId }
  ));
  logger.info('login_email_swap.user_created', { ...ctx, oldUserId, newUserId, groups: groups.length, stage: 'swap', result: 'success' });

  let newAssignments;
  try {
    newAssignments = new Map();
    for (const g of groups) {
      const raId = await hardwareAdapter.assignRole(platform, apiKey, newUserId, g.groupId, { validUntil: g.validUntil });
      newAssignments.set(g.groupId, String(raId));
    }
    // A suspended member stays suspended: the new user starts enabled.
    if (oldUser && oldUser.access_enabled === false) {
      await hardwareAdapter.suspendAccess(platform, apiKey, newUserId, 'Access suspended', { clientId: tenantId });
    }

    // Steps 7+8 as one unit (Layer 3, one transaction): the source rows, the cached user
    // id and the email change together or not at all.
    await standardAdapter.completeLoginEmailSwap({
      accessId: person.access_id, memberMasterId: person.member_master_id, tenantId,
      newEmail: emailForKisi, newHardwareUserId: newUserId, auditEventType: SWAP_EVENT,
      sourceMoves: groups.map(g => ({ sourceIds: g.sourceIds, roleAssignmentId: newAssignments.get(g.groupId) })),
    });
  } catch (err) {
    await _deleteNewUserQuietly(platform, apiKey, newUserId, tenantId, logger, ctx);
    throw err;
  }

  // Records now point at the new user. Remove the old one (guarded delete, DR-045).
  try {
    await hardwareAdapter.deleteUser(platform, apiKey, oldUserId, { clientId: tenantId });
  } catch (err) {
    logger.error('login_email_swap.old_user_delete_failed', { ...ctx, oldUserId, newUserId, stage: 'swap', result: 'failed' }, err);
    throw new SwapBlocked('LOGIN_EMAIL_OLD_USER_NOT_REMOVED',
      'The member was moved to the new Kisi login, but the old Kisi user could not be deleted');
  }
  logger.info('login_email_swap.complete', { ...ctx, oldUserId, newUserId, groups: groups.length, stage: 'swap', result: 'success' });

  // The swap is already done; a failed contact lookup must not turn it into an error.
  const { adminEmail } = await _loadClientSettings(tenantId).catch(() => ({ adminEmail: null }));
  await _sendEmails({
    tenantId, eventId, person, priorEmail, emailForKisi, newEmail, platform, groups, adminEmail, logger,
  });
  return { status: 'swapped' };
}

/** Both emails are best-effort: sendMemberEmail never throws and the swap is already done. */
async function _sendEmails({ tenantId, eventId, person, priorEmail, emailForKisi, platform, groups, adminEmail, logger }) {
  const firstName = person.first_name || null;
  if (!adminEmail) {
    // The old-address notice's "That wasn't me" button needs a contact to point at.
    logger.warn('login_email_swap.no_admin_contact', { clientId: tenantId, eventId, stage: 'email', result: 'degraded' });
  }

  const mappingIds = [...new Set(groups.flatMap(g => [...g.mappingIds]))];
  let plans = [];
  if (mappingIds.length) {
    const pm = await db.query(
      `SELECT plan_name, door_name FROM plan_mappings WHERE id = ANY($1::uuid[]) AND client_id = $2`,
      [mappingIds, tenantId]
    ).catch(() => ({ rows: [] }));
    plans = pm.rows.map(r => ({ planName: r.plan_name, doorName: r.door_name }));
  }

  await memberMailer.sendMemberEmail({
    clientId: tenantId, memberMasterId: person.member_master_id,
    emailType: 'access_ready',
    dedupKey: `${person.access_id}:swap:${eventId}`,
    recipient: emailForKisi,
    render: templates.renderAccessReady,
    renderArgs: { member: { firstName }, plans, hardwarePlatform: platform },
  });

  if (priorEmail) {
    await memberMailer.sendMemberEmail({
      clientId: tenantId, memberMasterId: person.member_master_id,
      emailType: 'login_email_changed',
      dedupKey: `${person.access_id}:${eventId}`,
      recipient: priorEmail,
      render: templates.renderLoginEmailChanged,
      renderArgs: { member: { firstName }, newEmailMasked: templates.maskEmail(emailForKisi) },
    });
  }
}

module.exports = { runLoginEmailSwap, SwapBlocked, RATE_LIMIT_DAYS, UNVERIFIED_WAIT_MS, _groupsToMove };
