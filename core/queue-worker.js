/**
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
const db = require('../db');
const { decryptApiKey } = require('./crypto-utils');

const connection = getRedisConnection();

/**
 * Resolves the client-level Kisi API key for a tenant.
 * Used for user resolution (findUserByEmail, createUser) and payment.recovered.
 * Falls back to KISI_API_KEY_MOCK during transition — remove fallback after OB-23 fully rolled out.
 */
async function getClientApiKey(tenantId) {
  const result = await db.query('SELECT kisi_api_key FROM clients WHERE id = $1', [tenantId]);
  const enc = result.rows[0]?.kisi_api_key;
  if (enc) return decryptApiKey(enc);
  return process.env.KISI_API_KEY_MOCK;
}

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

      // payment.recovered: user is suspended — re-enable only (no new role assignments)
      if (standardEvent.eventType === 'payment.recovered') {
        const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, null);
        if (!lockResult) {
          console.warn(`[Queue Worker] No identity for payment.recovered — member ${standardEvent.platformMemberId}. Dropping.`);
          return;
        }
        const { memberId: resolvedMemberId, hardwareUserId, hardwarePlatform } = lockResult;
        memberId = resolvedMemberId;
        const apiKey = await getClientApiKey(tenantId);
        await hardwareAdapter.enableAccess(hardwarePlatform, apiKey, hardwareUserId);
        await standardAdapter.completeRevoke(memberId, tenantId, 'active');
        return;
      }

      // Step 1: Resolve all active plan mappings for this plan (returns array)
      const mappings = await planMappingResolver.resolve(tenantId, standardEvent.planId);
      if (!mappings || mappings.length === 0) {
        console.warn(`[Queue Worker] No active plan mapping for planId ${standardEvent.planId}. Dropping job.`);
        return; // Already alerted in resolver via config_alert_log
      }

      // Step 2: Resolve identity + acquire lock (all mappings share same hardwarePlatform)
      const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, mappings[0].hardwarePlatform);
      memberId = lockResult.memberId;

      // Step 3: Resolve hardware user identity (client-level key — user ops are org-scoped)
      const apiKey = await getClientApiKey(tenantId);
      const hardwareUserId = await standardAdapter.resolveIdentity(
        memberId, standardEvent.email, standardEvent.name,
        mappings[0].hardwarePlatform, apiKey
      );

      // Step 4: Execute hardware grant across all active mappings
      const assignments = await grantRevokeLogic.processGrant(
        tenantId, memberId, hardwareUserId, mappings, standardEvent
      );

      // Step 5: Record success — writes all assignments to member_role_assignments
      await standardAdapter.completeGrant(memberId, tenantId, assignments);

    } else if (job.name === 'revoke') {
      // Step 1: Resolve identity + acquire lock (reads hardwarePlatform from existing row)
      const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, null);

      if (!lockResult) {
        console.warn(`[Queue Worker] No identity record for revoke — member ${standardEvent.platformMemberId}. Dropping job.`);
        return; // Member never existed — skip silently
      }

      const { memberId: resolvedMemberId, hardwareUserId, hardwarePlatform, roleAssignmentIds } = lockResult;
      memberId = resolvedMemberId;

      // Step 2: Execute hardware revoke across all stored role assignments → returns targetStatus
      const targetStatus = await grantRevokeLogic.processRevoke(
        tenantId, memberId, hardwareUserId, roleAssignmentIds, hardwarePlatform,
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
