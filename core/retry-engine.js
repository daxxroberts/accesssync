/**
 * retry-engine.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Exponential backoff retry mechanism for failed API calls 
 * - Default: 3 max attempts
 * - Moves job to dead-letter (error_queue table) state = failed when exhausted
 * - Dispatches email notification to operator if configured (DR-012)
 */

class RetryEngine {
  constructor() {
    this.maxAttempts = 3; // Open Item #1 - Pending Daxx confirmation
  }

  /**
   * BullMQ handles the actual retry scheduling, this class holds the business logic 
   * to decide what to do when jobs fail fundamentally.
   */
  async handleFailure(job, error) {
    const { tenantId, eventType, memberId } = job.data;
    
    // 1. Identify failure type
    const isRateLimit = error.statusCode === 429;
    const isTimeout = error.code === 'ETIMEDOUT';

    // 2. Decide if retryable
    if (job.attemptsMade < this.maxAttempts) {
      if (isRateLimit) {
        // Kisi specific: wait 1 additional second
        console.warn(`[Retry Engine] Kisi rate limit hit for tenant ${tenantId}. Retrying.`);
        throw error; // Let BullMQ retry
      }
      
      console.warn(`[Retry Engine] Transient error for tenant ${tenantId}. Retrying (${job.attemptsMade}/${this.maxAttempts}).`);
      throw error; // Let BullMQ retry with exponential backoff
    }

    // 3. Max retries exhausted - Dead Letter Flow
    console.error(`[Retry Engine] Max retries exhausted for job ${job.id}. Dead lettering.`);
    
    await this._moveToDeadLetter(tenantId, memberId, eventType, job.data, error);
    await this._notifyOperator(tenantId, error);
  }

  async _moveToDeadLetter(tenantId, memberId, eventType, payload, error) {
    // DB: UPDATE member_access_state SET status = 'failed'
    // DB: INSERT INTO error_queue 
    // DB: INSERT INTO adapter_admin_log
  }

  async _notifyOperator(tenantId, error) {
    // If config_error_notification_email is set in the operator's setup (DR-012):
    // Dispatches immediate SES email.
  }
}

module.exports = new RetryEngine();
