/**
 * @file queue-worker.js
 * @layer core/layer4
 * @role queue-coordinator
 * @reads BullMQ:grant,revoke jobs
 * @calls standard-adapter, grant-revoke, retry-engine
 * @exports startWorker, processJob
 * @dr DR-022, DR-023, DR-026
 *
 * queue-worker.js
 * BullMQ Worker — Core Engine (Layer 4) — Layer Coordinator
 *
 * Orchestration sequence per job type:
 *
 * GRANT:
 *   1. planMappingResolver.resolve() → mappings[] (all active mappings for this plan)
 *   2. standardAdapter.resolveAndLock(tenantId, event, hardwarePlatform) → { memberId }
 *   3. standardAdapter.resolveIdentity(memberId, email, name, platform, apiKey) → hardwareUserId
 *   4. grantRevokeLogic.processGrant(tenantId, memberId, hardwareUserId, mappings, event) → assignments[]
 *   5. standardAdapter.completeGrant(memberId, tenantId, assignments)
 *
 * REVOKE:
 *   1. standardAdapter.resolveAndLock(tenantId, event, null) → { memberId, hardwareUserId, hardwarePlatform, roleAssignmentIds[] }
 *   2. grantRevokeLogic.processRevoke(tenantId, memberId, hardwareUserId, roleAssignmentIds, hardwarePlatform, eventType, event) → targetStatus
 *   3. standardAdapter.completeRevoke(memberId, tenantId, targetStatus)
 *
 * CATCH:
 *   standardAdapter.releaseLock(memberId, tenantId, 'failed')
 *   throw error — BullMQ retries (BUG-01 fix preserved)
 */

const { Worker, UnrecoverableError } = require('bullmq');
const grantRevokeLogic = require('./grant-revoke');
const retryEngine = require('./retry-engine');
const standardAdapter = require('../adapters/standard-adapter');
const hardwareAdapter = require('../adapters/hardware-adapter');
const planMappingResolver = require('./plan-mapping-resolver');
const { getRedisConnection } = require('./redis-utils');
const { eventQueue } = require('./webhook-processor');
const db = require('../db');
const { decryptApiKey } = require('./crypto-utils');
const { log, withTrace } = require('./logger');

const connection = getRedisConnection();

/**
 * Resolves the client-level hardware API key for a tenant.
 * Used for user resolution (findUserByEmail, createUser) and payment.recovered.
 * DR-028: KISI_API_KEY_MOCK fallback removed — set key via Admin Hub.
 * DR-035: Column renamed kisi_api_key → hardware_api_key.
 */
async function getClientApiKey(tenantId) {
  const result = await db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [tenantId]);
  const enc = result.rows[0]?.hardware_api_key;
  if (enc) return decryptApiKey(enc);
  return null;
}

/**
 * Job processor function.
 * BullMQ calls this for every job dequeued. Returning normally = success. Throwing = retry.
 */
async function processJob(job) {
  const { tenantId, standardEvent } = job.data;
  const traceId  = standardEvent.traceId  || null;
  const clientId = tenantId;               // canonical field name — tenantId kept internally
  const eventId  = standardEvent.eventId  || null;
  const logger   = traceId ? withTrace(traceId) : log;
  const jobStart = Date.now();

  logger.info('queue.job.start', {
    traceId, clientId, eventId,
    jobId: job.id, jobName: job.name,
    attempt: (job.attemptsMade || 0) + 1,
    platformMemberId: standardEvent.platformMemberId,
    eventType: standardEvent.eventType,
    planId: standardEvent.planId,
    stage: 'queue', result: 'start',
  });

  let memberId = null;
  let lastStep = 'entry';

  try {
    if (job.name === 'grant') {

      // payment.recovered: user is suspended — re-enable only (no new role assignments)
      if (standardEvent.eventType === 'payment.recovered') {
        lastStep = 'grant.recovered.resolve_lock';
        const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, null);
        if (!lockResult) {
          logger.warn('queue.grant.recovered.no_identity', {
            clientId, eventId,
            platformMemberId: standardEvent.platformMemberId,
            stage: 'grant', result: 'skipped',
          });
          return;
        }
        const { memberId: resolvedMemberId, hardwareUserId, hardwarePlatform } = lockResult;
        memberId = resolvedMemberId;
        lastStep = 'grant.recovered.enable_access';
        const apiKey = await getClientApiKey(tenantId);
        await hardwareAdapter.enableAccess(hardwarePlatform, apiKey, hardwareUserId);
        lastStep = 'grant.recovered.complete_revoke';
        await standardAdapter.completeRevoke(memberId, tenantId, 'active');
        logger.info('queue.grant.recovered.complete', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          durationMs: Date.now() - jobStart,
          stage: 'grant', result: 'success',
        });
        return;
      }

      // Step 1: Resolve all active plan mappings for this plan (returns array, null, or empty array)
      lastStep = 'grant.resolve_mappings';
      const mappings = await planMappingResolver.resolve(tenantId, standardEvent.planId);
      logger.info('queue.grant.mappings_resolved', {
        clientId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        planId: standardEvent.planId,
        mappingCount: mappings === null ? null : mappings.length,
        hardwareGroupIds: Array.isArray(mappings) ? mappings.map(m => m.hardwareGroupId) : [],
        stage: 'grant', result: 'success',
      });
      if (mappings === null) {
        // W-1: Unknown plan — write to error_queue + notify operator immediately
        logger.warn('queue.grant.plan_unknown', {
          clientId, eventId,
          planId: standardEvent.planId,
          platformMemberId: standardEvent.platformMemberId,
          stage: 'grant', result: 'failed',
        });
        const unmappedErr = new Error(`No mapping for plan ${standardEvent.planId}`);
        unmappedErr.code = 'PLAN_NOT_MAPPED';
        unmappedErr.userMessage = "A member just signed up for a plan that hasn't been connected to any access group yet. They won't be able to get in until the plan is mapped.";
        unmappedErr.action = 'Open Plan Mapping in your AccessSync dashboard and connect this plan to an access group.';
        await retryEngine.handleFailure({ id: job.id, data: job.data }, unmappedErr);
        return;
      }
      if (mappings.length === 0) {
        // Plan recognized but no hardware group mapped yet (Wix-first flow) — park member
        const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, 'kisi');
        memberId = lockResult.memberId;
        await standardAdapter.releaseLock(memberId, tenantId, 'pending_hardware', { planId: standardEvent.planId });
        logger.info('queue.grant.parked.no_mapping', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          planId: standardEvent.planId,
          stage: 'grant', result: 'skipped',
        });
        return;
      }

      // Step 2: Resolve identity + acquire lock (all mappings share same hardwarePlatform)
      lastStep = 'grant.resolve_and_lock';
      const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, mappings[0].hardwarePlatform);
      memberId = lockResult.memberId;
      logger.info('queue.grant.lock_acquired', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        hardwarePlatform: mappings[0].hardwarePlatform,
        email: standardEvent.email || null,
        stage: 'grant', result: 'start',
      });

      // Step 3: Check for hardware API key — if missing, park as pending_hardware (Wix-first flow)
      lastStep = 'grant.get_api_key';
      const apiKey = await getClientApiKey(tenantId);
      if (!apiKey) {
        await standardAdapter.releaseLock(memberId, tenantId, 'pending_hardware', { planId: standardEvent.planId });
        logger.info('queue.grant.parked.no_api_key', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          planId: standardEvent.planId,
          stage: 'grant', result: 'skipped',
        });
        return;
      }

      // Step 4: Resolve hardware user identity (client-level key — user ops are org-scoped)
      // OB-89 Gate 2: pass tenantId + platformMemberId so standardAdapter can recover
      // missing email via Wix Members API. If ladder exhausts, resolveIdentity returns
      // null and the member is parked as pending_identity — we exit cleanly (not a failure).
      lastStep = 'grant.resolve_identity';
      const hardwareUserId = await standardAdapter.resolveIdentity(
        memberId, standardEvent.email, standardEvent.name,
        mappings[0].hardwarePlatform, apiKey,
        { tenantId, platformMemberId: standardEvent.platformMemberId }
      );
      if (hardwareUserId === null) {
        logger.warn('queue.grant.parked.pending_identity', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          planId: standardEvent.planId,
          stage: 'identity', result: 'skipped',
        });
        return;
      }
      logger.info('queue.grant.identity_resolved', {
        clientId, memberId, eventId, hardwareUserId,
        platformMemberId: standardEvent.platformMemberId,
        stage: 'identity', result: 'success',
      });
      // Step 5: Execute hardware grant across all active mappings
      lastStep = 'grant.process_grant';
      const assignments = await grantRevokeLogic.processGrant(
        tenantId, memberId, hardwareUserId, mappings, standardEvent
      );
      logger.info('queue.grant.hardware_calls_complete', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        assignments: assignments.length,
        roleAssignmentIds: assignments.map(a => a.roleAssignmentId),
        durationMs: Date.now() - jobStart,
        stage: 'grant', result: 'success',
      });

      // Step 6: Record success — writes all assignments to member_role_assignments
      lastStep = 'grant.complete_grant';
      await standardAdapter.completeGrant(memberId, tenantId, assignments);
      logger.info('queue.grant.complete', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        assignments: assignments.length,
        durationMs: Date.now() - jobStart,
        stage: 'grant', result: 'success',
      });

    } else if (job.name === 'revoke') {
      // Step 1: Resolve identity + acquire lock (reads hardwarePlatform from existing row)
      lastStep = 'revoke.resolve_and_lock';
      const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, null);

      if (!lockResult) {
        logger.warn('queue.revoke.no_identity', {
          clientId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          eventType: standardEvent.eventType,
          stage: 'revoke', result: 'skipped',
        });
        return; // Member never existed — skip silently
      }

      const { memberId: resolvedMemberId, hardwareUserId, hardwarePlatform, roleAssignmentIds } = lockResult;
      memberId = resolvedMemberId;
      logger.info('queue.revoke.lock_acquired', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        hardwarePlatform,
        roleAssignmentCount: roleAssignmentIds?.length || 0,
        stage: 'revoke', result: 'start',
      });

      // Step 2: Execute hardware revoke across all stored role assignments → returns targetStatus
      lastStep = 'revoke.process_revoke';
      const targetStatus = await grantRevokeLogic.processRevoke(
        tenantId, memberId, hardwareUserId, roleAssignmentIds, hardwarePlatform,
        standardEvent.eventType, standardEvent
      );
      logger.info('queue.revoke.hardware_calls_complete', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        targetStatus,
        durationMs: Date.now() - jobStart,
        stage: 'revoke', result: 'success',
      });

      // Step 3: Record success
      lastStep = 'revoke.complete_revoke';
      await standardAdapter.completeRevoke(memberId, tenantId, targetStatus);
      logger.info('queue.revoke.complete', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        targetStatus,
        durationMs: Date.now() - jobStart,
        stage: 'revoke', result: 'success',
      });

    } else {
      logger.warn('queue.job.unknown_name', { jobId: job.id, jobName: job.name, clientId, eventId });
    }

  } catch (error) {
    logger.error('queue.job.failed', {
      jobId: job.id, jobName: job.name,
      clientId, memberId, eventId,
      attempt: job.attemptsMade,
      lastStep,
      platformMemberId: standardEvent?.platformMemberId || null,
      planId: standardEvent?.planId || null,
      eventType: standardEvent?.eventType || null,
      emailPresent: !!(standardEvent?.email),
      namePresent: !!(standardEvent?.name),
      durationMs: Date.now() - jobStart,
      stage: lastStep.split('.')[0], result: 'failed',
    }, error);

    // Release in_flight lock before BullMQ retries
    if (memberId) {
      await standardAdapter.releaseLock(memberId, tenantId, 'failed');
    }

    // 4xx errors (except 429) are non-retryable — bad config, not transient failures.
    // Throw UnrecoverableError so BullMQ dead-letters immediately without exhausting retries.
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) {
      throw new UnrecoverableError(`Non-retryable hardware error (${error.statusCode}): ${error.message}`);
    }

    // BUG-01 fix: throw so BullMQ retries. Dead-letter via worker.on('failed') → retryEngine.
    throw error;
  }
}

/**
 * Start the BullMQ worker.
 * Called once at server boot from server.js.
 * Returns the worker instance for graceful shutdown.
 */
function startWorker() {
  const worker = new Worker('accesssync-events', processJob, {
    connection,
    concurrency: 20,  // DR-035: rate limiting is per-adapter inside each connector (e.g. kisi-connector enforces 5 req/sec).
                      // Worker concurrency is not the rate limit — it's max parallel jobs across all tenants/platforms.
  });

  worker.on('completed', (job) => {
    const traceId = job.data?.standardEvent?.traceId || null;
    const logger = traceId ? withTrace(traceId) : log;
    logger.info('queue.job.completed', {
      jobId: job.id, jobName: job.name,
      clientId: job.data?.tenantId || null,
      eventId: job.data?.standardEvent?.eventId || null,
      platformMemberId: job.data?.standardEvent?.platformMemberId || null,
      stage: 'queue', result: 'success',
    });
  });

  worker.on('failed', async (job, err) => {
    const traceId = job.data?.standardEvent?.traceId || null;
    const logger = traceId ? withTrace(traceId) : log;
    logger.error('queue.job.exhausted', {
      jobId: job.id, jobName: job.name,
      clientId: job.data?.tenantId || null,
      eventId: job.data?.standardEvent?.eventId || null,
      platformMemberId: job.data?.standardEvent?.platformMemberId || null,
      attempt: job.attemptsMade, maxAttempts: job.opts.attempts,
      stage: 'queue', result: 'failed',
    }, err);

    if (job.attemptsMade >= job.opts.attempts) {
      await retryEngine.handleFailure(job, err);
    }
  });

  worker.on('error', (err) => {
    log.critical('queue.worker.error', {}, err);
  });

  // DR-023: BullMQ stall events bypass the catch block in processJob — the lock
  // is never released via the normal path when a worker process is killed mid-job.
  // This handler recovers the job data and calls releaseLock() so the member is
  // never permanently stuck at in_flight.
  worker.on('stalled', async (jobId) => {
    try {
      const job = await eventQueue.getJob(jobId);
      if (!job) {
        log.warn('queue.job.stalled.no_job', { jobId });
        return;
      }
      const { tenantId, standardEvent } = job.data || {};
      const platformMemberId = standardEvent?.platformMemberId || null;
      log.warn('queue.job.stalled', {
        jobId, jobName: job.name,
        clientId: tenantId || null,
        platformMemberId,
        stage: 'queue', result: 'stalled',
      });
      // Recover member_id from DB so we can release the lock
      if (tenantId && platformMemberId) {
        const result = await db.query(
          `SELECT mi.id FROM member_identity mi
           JOIN member_access_state mas ON mas.member_id = mi.id
           WHERE mi.client_id = $1 AND mi.platform_member_id = $2 AND mas.status = 'in_flight'`,
          [tenantId, platformMemberId]
        );
        if (result.rows.length) {
          const memberId = result.rows[0].id;
          await standardAdapter.releaseLock(memberId, tenantId, 'failed');
          log.info('queue.job.stalled.lock_released', { jobId, memberId, clientId: tenantId });
        } else {
          log.info('queue.job.stalled.no_lock', { jobId, clientId: tenantId, platformMemberId });
        }
      }
    } catch (err) {
      log.error('queue.job.stalled.release_failed', { jobId }, err);
    }
  });

  log.info('queue.worker.started', { queue: 'accesssync-events', concurrency: 20 });
  return worker;
}

module.exports = { startWorker, processJob };
