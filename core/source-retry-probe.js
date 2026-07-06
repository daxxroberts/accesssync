/**
 * @file source-retry-probe.js
 * @layer core/layer4
 * @role cron
 * @schedule scheduled via Railway Cron — recommended every 5 minutes
 * @reads member_access_sources, member_access, member_master, connector_subscriptions
 * @writes member_access_sources (status, role_assignment_id, retry_count, last_retry_at, failure_reason),
 *         member_access (status rollup — via standardAdapter.rollupAccessStatus),
 *         error_queue (on retry_count == 3)
 * @calls hardware-adapter.assignRole, standard-adapter.rollupAccessStatus, crypto-utils.decryptApiKey
 * @exports runProbe
 * @dr DR-023 (rollup routed through L3 as of 2026-07-06; former carve-out retired)
 * @ob OB-240
 *
 * source-retry-probe.js
 * Scheduled probe that picks up `member_access_sources` rows stuck in
 * `pending_hardware` or `pending_start` and re-issues the hardware grant.
 *
 * Design intent:
 *   - Source rows can land in `pending_hardware` when the hardware platform
 *     was transiently unreachable at grant time, or in `pending_start` when
 *     the plan has a future start date. The first case wants a retry; the
 *     second wants a retry the moment scheduled_start_date arrives.
 *
 * Selection rules (all required):
 *   - mas.status IN ('pending_hardware', 'pending_start')
 *   - parent member_access.status = 'active'
 *   - mas.retry_count < 3
 *   - mas.last_retry_at IS NULL OR mas.last_retry_at < NOW() - INTERVAL '15 minutes'
 *     (don't race live grants or back-to-back probe runs)
 *   - For pending_start: scheduled_start_date IS NULL OR scheduled_start_date <= NOW()
 *     (don't retry future-dated rows)
 *   - member_master.hardware_user_id IS NOT NULL
 *     (member never got a Kisi user — different recovery path; we log+skip)
 *
 * Per row:
 *   1. Decrypt connector_subscriptions.hardware_api_key.
 *   2. Call hardwareAdapter.assignRole inside try/catch.
 *   3. Success → direct UPDATE of mas (status='active', role_assignment_id,
 *      provisioned_at, retry_count++, last_retry_at, failure_reason=NULL).
 *      Then recompute parent member_access.status rollup.
 *   4. Failure → UPDATE mas (retry_count++, last_retry_at, failure_reason).
 *      If retry_count reaches 3, also set status='failed' AND INSERT an
 *      error_queue row (error_code='SOURCE_RETRY_EXHAUSTED').
 *
 *  DR-023 carve-out: this file writes DIRECTLY to member_access_sources
 *  rather than routing through standard-adapter.completeGrant. The carve-out
 *  is for recovery only — completeGrant also touches member_billing, and we
 *  do NOT want to churn billing for an already-billed retry. This mirrors
 *  OB-204's stale-lock recovery primitive precedent.
 */

'use strict';

const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const standardAdapter = require('../adapters/standard-adapter');
const { decryptApiKey } = require('./crypto-utils');
const { log } = require('./logger');
const { runWith, mintTraceId, getTraceId, getActor } = require('./trace-context');

const MAX_RETRIES = 3;
const STALENESS_INTERVAL = '15 minutes';
const FAILURE_REASON_MAX_LEN = 500;

async function runProbe() {
  const traceId = mintTraceId();
  return runWith(
    { traceId, actor: { type: 'system', id: 'source-retry-probe-cron' } },
    () => _runProbeBody()
  );
}

async function _runProbeBody() {
  log.info('source_retry.run_start', {});

  // Selection query — see file header for the four filter rules.
  // Joins:
  //   member_access (parent)  — for status='active' filter + rollup target
  //   member_master           — for hardware_user_id (skip rows where NULL)
  //   connector_subscriptions — for hardware_api_key + hardware_platform
  //   clients                 — for client_id passthrough (also confirms client exists)
  const candidatesResult = await db.query(
    `SELECT mas.id              AS source_id,
            mas.access_id,
            mas.client_id,
            mas.status          AS source_status,
            mas.hardware_group_id,
            mas.valid_until,
            mas.retry_count,
            mas.scheduled_start_date,
            ma.member_master_id,
            ma.id               AS access_row_id,
            mm.hardware_user_id,
            cs.hardware_api_key,
            cs.hardware_platform
       FROM member_access_sources mas
       JOIN member_access ma ON ma.id = mas.access_id
       JOIN member_master  mm ON mm.id = ma.member_master_id
       JOIN connector_subscriptions cs
              ON cs.client_id = mas.client_id
             AND cs.status    = 'active'
      WHERE mas.status IN ('pending_hardware', 'pending_start')
        AND ma.status = 'active'
        AND mas.retry_count < $1
        AND (mas.last_retry_at IS NULL
             OR mas.last_retry_at < NOW() - INTERVAL '${STALENESS_INTERVAL}')
        AND (mas.status <> 'pending_start'
             OR mas.scheduled_start_date IS NULL
             OR mas.scheduled_start_date <= NOW())`,
    [MAX_RETRIES]
  );

  const candidates = candidatesResult.rows || [];

  let succeeded = 0;
  let failed = 0;
  let exhausted = 0;
  let skipped = 0;

  for (const row of candidates) {
    log.info('source_retry.candidate_found', {
      sourceId: row.source_id,
      clientId: row.client_id,
      accessId: row.access_id,
      sourceStatus: row.source_status,
      hardwareGroupId: row.hardware_group_id,
      retryCount: row.retry_count,
    });

    try {
      const outcome = await _retryOne(row);
      if (outcome === 'success')   succeeded++;
      else if (outcome === 'exhausted') exhausted++;
      else if (outcome === 'failed')    failed++;
      else if (outcome === 'skipped')   skipped++;
    } catch (rowErr) {
      // Per-row try/catch — one bad row does not abort the batch.
      log.error('source_retry.row_unhandled_error', {
        sourceId: row.source_id,
        clientId: row.client_id,
      }, rowErr);
    }
  }

  log.info('source_retry.run_complete', {
    candidates: candidates.length,
    succeeded,
    failed,
    exhausted,
    skipped,
  });
}

/**
 * Retry a single source row. Returns:
 *   'success'   — assignRole succeeded, source flipped to active
 *   'failed'    — assignRole threw, retry_count bumped but still < MAX
 *   'exhausted' — retry_count hit MAX, source flipped to failed + error_queue row
 *   'skipped'   — pre-flight guard (e.g. no hardware_user_id), no assignRole call
 */
async function _retryOne(row) {
  // Skip rows where the member never got a Kisi user.
  // Different recovery path — identity resolution, not source-level retry.
  if (!row.hardware_user_id) {
    log.warn('source_retry.skipped_no_kisi_user', {
      sourceId: row.source_id,
      clientId: row.client_id,
      memberMasterId: row.member_master_id,
    });
    return 'skipped';
  }

  // Decrypt API key. If decryption itself fails, treat as a row failure.
  let apiKey;
  try {
    apiKey = decryptApiKey(row.hardware_api_key);
  } catch (decryptErr) {
    return _recordFailure(row, decryptErr);
  }

  // Attempt the hardware grant.
  try {
    const assignResult = await hardwareAdapter.assignRole(
      row.hardware_platform,
      apiKey,
      row.hardware_user_id,
      row.hardware_group_id,
      { validUntil: row.valid_until || null }
    );
    const roleAssignmentId = assignResult && assignResult.roleAssignmentId;

    await _recordSuccess(row, roleAssignmentId);
    return 'success';
  } catch (assignErr) {
    return _recordFailure(row, assignErr);
  }
}

/**
 * Direct UPDATE of mas + parent access rollup recompute.
 * DR-023 carve-out — see file header. Recovery primitive only; does not
 * touch member_billing.
 */
async function _recordSuccess(row, roleAssignmentId) {
  // OB-240 / DR-023 carve-out: writing mas directly (no completeGrant)
  // because billing has already been recorded at original grant time
  // and we don't want to churn member_billing for a retry.
  await db.query(
    `UPDATE member_access_sources
        SET status            = 'active',
            provisioned_at    = NOW(),
            role_assignment_id = $2,
            retry_count       = retry_count + 1,
            last_retry_at     = NOW(),
            failure_reason    = NULL,
            updated_at        = NOW()
      WHERE id = $1`,
    [row.source_id, roleAssignmentId || null]
  );

  // Recompute parent member_access.status rollup.
  //   active   if ≥1 source 'active'
  //   inactive otherwise
  // This mirrors the DR-046 rollup invariant (see standard-adapter
  // completeGrant / completeRevoke).
  const remainingActive = await db.query(
    `SELECT COUNT(*)::int AS n
       FROM member_access_sources
      WHERE access_id = $1 AND status = 'active'`,
    [row.access_id]
  );
  const activeCount = (remainingActive.rows[0] && remainingActive.rows[0].n) || 0;
  const newParentStatus = activeCount > 0 ? 'active' : 'inactive';

  // DR-023: the status write goes through L3's canonical rollup (the SELECT
  // above stays — it feeds the parentStatus log field). This retires the
  // former DR-023 carve-out: the primitive didn't exist when this was written.
  await standardAdapter.rollupAccessStatus(row.access_id);

  log.info('source_retry.success', {
    sourceId: row.source_id,
    clientId: row.client_id,
    accessId: row.access_id,
    hardwareGroupId: row.hardware_group_id,
    roleAssignmentId: roleAssignmentId || null,
    parentStatus: newParentStatus,
    stage: 'grant',
    result: 'success',
  });
}

/**
 * UPDATE mas with bumped retry_count + failure_reason. If retry_count reaches
 * MAX_RETRIES after the bump, also flips status to 'failed' and INSERTs an
 * error_queue row.
 */
async function _recordFailure(row, err) {
  const newRetryCount = (row.retry_count || 0) + 1;
  const exhausted = newRetryCount >= MAX_RETRIES;
  const truncatedReason = String(err && err.message ? err.message : 'unknown error')
    .slice(0, FAILURE_REASON_MAX_LEN);

  if (exhausted) {
    await db.query(
      `UPDATE member_access_sources
          SET status         = 'failed',
              retry_count    = retry_count + 1,
              last_retry_at  = NOW(),
              failure_reason = $2,
              updated_at     = NOW()
        WHERE id = $1`,
      [row.source_id, truncatedReason]
    );

    // Operator-visible incident. Mirrors retry-engine.js shape but lighter
    // — this is recovery-tier, not the original-grant dead-letter path.
    // trace_id / actor_type / actor_id pulled from ALS context (DR-037).
    const _actor = getActor() || {};
    await db.query(
      `INSERT INTO error_queue
         (client_id, member_id, event_type, payload, error_reason,
          error_code, retry_count, status, occurred_count, last_occurred_at,
          trace_id, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'failed', 1, NOW(), $8, $9, $10)`,
      [
        row.client_id,
        row.access_id,
        'source_retry_exhausted',
        JSON.stringify({
          sourceId: row.source_id,
          accessId: row.access_id,
          memberMasterId: row.member_master_id,
          hardwareGroupId: row.hardware_group_id,
          retryCount: newRetryCount,
        }),
        truncatedReason,
        'SOURCE_RETRY_EXHAUSTED',
        newRetryCount,
        getTraceId() || null,
        _actor.type   || null,
        _actor.id     || null,
      ]
    );

    log.error('source_retry.exhausted', {
      sourceId: row.source_id,
      clientId: row.client_id,
      accessId: row.access_id,
      hardwareGroupId: row.hardware_group_id,
      retryCount: newRetryCount,
      stage: 'grant',
      result: 'exhausted',
    }, err);

    return 'exhausted';
  }

  // Not yet exhausted — bump the counter and surface a warn so operator
  // dashboards can still see it.
  await db.query(
    `UPDATE member_access_sources
        SET retry_count    = retry_count + 1,
            last_retry_at  = NOW(),
            failure_reason = $2,
            updated_at     = NOW()
      WHERE id = $1`,
    [row.source_id, truncatedReason]
  );

  log.warn('source_retry.failed', {
    sourceId: row.source_id,
    clientId: row.client_id,
    accessId: row.access_id,
    hardwareGroupId: row.hardware_group_id,
    retryCount: newRetryCount,
    recoverable: true,
    stage: 'grant',
    result: 'failed',
  }, err);

  return 'failed';
}

// Executable entry point for Railway Cron.
if (require.main === module) {
  runProbe()
    .then(() => process.exit(0))
    .catch(err => { log.critical('source_retry.fatal', {}, err); process.exit(1); });
}

module.exports = { runProbe };
