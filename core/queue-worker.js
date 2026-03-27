/**
 * queue-worker.js
 * BullMQ Worker — Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Consumes jobs from the 'accesssync-events' queue
 * - Routes grant jobs to grantRevokeLogic.processGrant()
 * - Routes revoke jobs to grantRevokeLogic.processRevoke()
 * - BullMQ handles exponential backoff and retry scheduling (DR-012)
 * - On max retries exhausted, retry-engine.handleFailure() dead-letters the job
 */

const { Worker } = require('bullmq');
const grantRevokeLogic = require('./grant-revoke');
const retryEngine = require('./retry-engine');

// --- BullMQ Worker Connection ---
// Must match the connection config in webhook-processor.js
const connection = process.env.REDIS_URL
  ? { url: process.env.REDIS_URL }
  : { host: 'localhost', port: 6379 };

/**
 * Job processor function.
 * BullMQ calls this for every job dequeued. Returning normally = success.
 * Throwing = failure, triggers BullMQ retry per job options.
 */
async function processJob(job) {
  const { tenantId, standardEvent } = job.data;

  console.log(`[Queue Worker] Processing job ${job.id} (${job.name}) for tenant ${tenantId}, member ${standardEvent.platformMemberId}`);

  if (job.name === 'grant') {
    await grantRevokeLogic.processGrant(tenantId, standardEvent);

  } else if (job.name === 'revoke') {
    await grantRevokeLogic.processRevoke(tenantId, standardEvent.eventType, standardEvent);

  } else {
    console.warn(`[Queue Worker] Unknown job name: ${job.name}. Skipping.`);
  }
}

/**
 * Start the BullMQ worker.
 * Called once at server boot from server.js.
 * Returns the worker instance so the caller can gracefully shut it down.
 */
function startWorker() {
  const worker = new Worker('accesssync-events', processJob, {
    connection,
    concurrency: 5,   // Process up to 5 jobs simultaneously
                      // Kisi rate limit (5 req/sec, DR-008) is enforced inside kisi-adapter
  });

  worker.on('completed', (job) => {
    console.log(`[Queue Worker] Job ${job.id} (${job.name}) completed.`);
  });

  worker.on('failed', async (job, err) => {
    console.error(`[Queue Worker] Job ${job.id} (${job.name}) failed (attempt ${job.attemptsMade}/${job.opts.attempts}):`, err.message);

    // If BullMQ has exhausted all retries, route to dead-letter flow
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
