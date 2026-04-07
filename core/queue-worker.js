/**
 * @file queue-worker.js
 * @layer core/layer4
 * @role queue-coordinator
 * @reads BullMQ:grant,revoke jobs
 * @calls standard-adapter, grant-revoke, retry-engine
 * @exports worker
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
const db = require('../db');
const { decryptApiKey } = require('./crypto-utils');

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

      // Step 1: Resolve all active plan mappings for this plan (returns array, null, or empty array)
      const mappings = await planMappingResolver.resolve(tenantId, standardEvent.planId);
      if (mappings === null) {
        console.warn(`[Queue Worker] Unknown plan ${standardEvent.planId}. Dropping job.`);
        return; // Already alerted in resolver via config_alert_log
      }
      if (mappings.length === 0) {
        // Plan recognized but no hardware group mapped yet (Wix-first flow) — park member
        console.log(`[Queue Worker] Plan ${standardEvent.planId} recognized but not hardware-mapped. Parking member as pending_hardware.`);
        const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, 'kisi'); // default platform
        memberId = lockResult.memberId;
        await standardAdapter.releaseLock(memberId, tenantId, 'pending_hardware', { planId: standardEvent.planId });
        return;
      }

      // Step 2: Resolve identity + acquire lock (all mappings share same hardwarePlatform)
      const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, mappings[0].hardwarePlatform);
      memberId = lockResult.memberId;

      // Step 3: Check for hardware API key — if missing, park as pending_hardware (Wix-first flow)
      const apiKey = await getClientApiKey(tenantId);
      if (!apiKey) {
        console.log(`[Queue Worker] No hardware API key for tenant ${tenantId}. Parking member ${standardEvent.platformMemberId} as pending_hardware.`);
        await standardAdapter.releaseLock(memberId, tenantId, 'pending_hardware', { planId: standardEvent.planId });
        return;
      }

      // Step 4: Resolve hardware user identity (client-level key — user ops are org-scoped)
      const hardwareUserId = await standardAdapter.resolveIdentity(
        memberId, standardEvent.email, standardEvent.name,
        mappings[0].hardwarePlatform, apiKey
      );

      // Step 5: Execute hardware grant across all active mappings
      const assignments = await grantRevokeLogic.processGrant(
        tenantId, memberId, hardwareUserId, mappings, standardEvent
      );

      // Step 6: Record success — writes all assignments to member_role_assignments
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
    concurrency: 20,  // DR-035: rate limiting is per-adapter inside each connector (e.g. kisi-connector enforces 5 req/sec).
                      // Worker concurrency is not the rate limit — it's max parallel jobs across all tenants/platforms.
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
