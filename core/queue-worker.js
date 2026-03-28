/**
 * queue-worker.js
 * BullMQ Worker — Core Engine (Layer 4) — Layer Coordinator
 *
 * Orchestration sequence per job type:
 *
 * GRANT:
 *   1. planMappingResolver.resolve() → mapping (includes hardwarePlatform)
 *   2. standardAdapter.resolveAndLock(tenantId, event, hardwarePlatform) → { memberId }
 *   3. standardAdapter.resolveIdentity(memberId, email, name, platform, apiKey) → hardwareUserId
 *   4. grantRevokeLogic.processGrant(tenantId, memberId, hardwareUserId, mapping, event) → roleId
 *   5. standardAdapter.completeGrant(memberId, tenantId, roleId)
 *
 * REVOKE:
 *   1. standardAdapter.resolveAndLock(tenantId, event, null) → { memberId, hardwareUserId, hardwarePlatform, roleAssignmentId }
 *   2. grantRevokeLogic.processRevoke(tenantId, memberId, hardwareUserId, roleAssignmentId, hardwarePlatform, eventType, event) → targetStatus
 *   3. standardAdapter.completeRevoke(memberId, tenantId, targetStatus)
 *
 * CATCH:
 *   standardAdapter.releaseLock(memberId, tenantId, 'failed')
 *   throw error — BullMQ retries (BUG-01 fix preserved)
 */

const { Worker } = require('bullmq');
const grantRevokeLogic = require('./grant-revoke');
const retryEngine = require('./retry-engine');
const standardAdapter = require('../adapters/standard-adapter');
const planMappingResolver = require('./plan-mapping-resolver');
const { getRedisConnection } = require('./redis-utils');

const connection = getRedisConnection();

/**
 * Job processor function.
 * BullMQ calls this for every job dequeued. Returning normally = success. Throwing = retry.
 */
async function processJob(job) {
  const { tenantId, standardEvent } = job.data;

  console.log(`[Queue Worker] Processing job ${job.id} (${job.name}) for tenant ${tenantId}, member ${standardEvent.platformMemberId}`);

  let memberId = null;

  try {
    if (job.name === 'grant') {
      // Step 1: Resolve plan mapping (includes hardwarePlatform)
      const mapping = await planMappingResolver.resolve(tenantId, standardEvent.planId);
      if (!mapping) {
        console.warn(`[Queue Worker] No plan mapping for planId ${standardEvent.planId}. Dropping job.`);
        return; // Already alerted in resolver via config_alert_log
      }

      // Step 2: Resolve identity + acquire lock
      const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, mapping.hardwarePlatform);
      memberId = lockResult.memberId;

      // Step 3: Resolve hardware user identity
      const apiKey = process.env.KISI_API_KEY_MOCK;
      const hardwareUserId = await standardAdapter.resolveIdentity(
        memberId, standardEvent.email, standardEvent.name,
        mapping.hardwarePlatform, apiKey
      );

      // Step 4: Execute hardware grant
      const roleId = await grantRevokeLogic.processGrant(
        tenantId, memberId, hardwareUserId, mapping, standardEvent
      );

      // Step 5: Record success
      await standardAdapter.completeGrant(memberId, tenantId, roleId);

    } else if (job.name === 'revoke') {
      // Step 1: Resolve identity + acquire lock (reads hardwarePlatform from existing row)
      const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, null);

      if (!lockResult) {
        console.warn(`[Queue Worker] No identity record for revoke — member ${standardEvent.platformMemberId}. Dropping job.`);
        return; // Member never existed — skip silently
      }

      const { memberId: resolvedMemberId, hardwareUserId, hardwarePlatform, roleAssignmentId } = lockResult;
      memberId = resolvedMemberId;

      // Step 2: Execute hardware revoke — returns targetStatus
      const targetStatus = await grantRevokeLogic.processRevoke(
        tenantId, memberId, hardwareUserId, roleAssignmentId, hardwarePlatform,
        standardEvent.eventType, standardEvent
      );

      // Step 3: Record success
      await standardAdapter.completeRevoke(memberId, tenantId, targetStatus);

    } else {
      console.warn(`[Queue Worker] Unknown job name: ${job.name}. Skipping.`);
    }

  } catch (error) {
    console.error(`[Queue Worker] Job ${job.id} (${job.name}) failed:`, error.message);

    // Release in_flight lock before BullMQ retries
    if (memberId) {
      await standardAdapter.releaseLock(memberId, tenantId, 'failed');
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
    concurrency: 5,   // Kisi rate limit (5 req/sec, DR-008) enforced inside kisi-connector
  });

  worker.on('completed', (job) => {
    console.log(`[Queue Worker] Job ${job.id} (${job.name}) completed.`);
  });

  worker.on('failed', async (job, err) => {
    console.error(`[Queue Worker] Job ${job.id} (${job.name}) failed (attempt ${job.attemptsMade}/${job.opts.attempts}):`, err.message);

    if (job.attemptsMade >= job.opts.attempts) {
      await retryEngine.handleFailure(job, err);
    }
  });

  worker.on('error', (err) => {
    console.error('[Queue Worker] Worker error:', err.message);
  });

  console.log('[Queue Worker] BullMQ worker started. Listening on accesssync-events queue.');
  return worker;
}

module.exports = { startWorker };
