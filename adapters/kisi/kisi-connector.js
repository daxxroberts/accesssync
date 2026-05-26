/**
 * kisi-connector.js
 * Kisi Connector (Layer 7)
 *
 * Responsibilities:
 * - All Kisi HTTP communication
 * - Auth headers (KISI-LOGIN)
 * - Rate limiting (DR-008: 5 req/sec local enforcement)
 * - 429 backoff
 *
 * No business logic here. Business methods live in kisi-adapter.js (Layer 6).
 */

const { log } = require('../../core/logger');

class KisiConnector {
  constructor() {
    this.baseUrl = 'https://api.kisi.io';
    this.lastRequestTimes = [];
    this.rateLimit = 5;
    this.timeWindowMs = 1000;
  }

  getHeaders(apiKey) {
    return {
      'Authorization': `KISI-LOGIN ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Kisi-Integration-Identifier': 'accesssync'
    };
  }

  /**
   * Enforces the 5 req/sec rate limit locally before making network calls.
   */
  async enforceRateLimit() {
    while (true) {
      const now = Date.now();
      this.lastRequestTimes = this.lastRequestTimes.filter(t => now - t < this.timeWindowMs);

      if (this.lastRequestTimes.length >= this.rateLimit) {
        const oldestRequest = this.lastRequestTimes[0];
        const timeToWait = this.timeWindowMs - (now - oldestRequest);
        log.debug('kisi.rate_limit.pause', { waitMs: timeToWait });
        await new Promise(resolve => setTimeout(resolve, timeToWait + 10));
      } else {
        this.lastRequestTimes.push(Date.now());
        break;
      }
    }
  }

  /**
   * Makes a Kisi API request with built-in 429 backoff.
   *
   * @param {string} endpoint   e.g. '/users'
   * @param {Object} options    fetch options (method, body)
   * @param {string} apiKey
   * @param {number} attempt    internal — retry counter
   */
  async makeRequest(endpoint, options, apiKey, attempt = 1) {
    await this.enforceRateLimit();

    const url = `${this.baseUrl}${endpoint}`;
    // System boundary log — every outbound Kisi call recorded
    log.debug('kisi.request', { method: options.method || 'GET', endpoint, attempt });

    const response = await fetch(url, {
      ...options,
      headers: this.getHeaders(apiKey)
    });

    if (response.status === 429) {
      if (attempt >= 3) {
        const err = new Error('Kisi rate limit exhausted after 3 attempts');
        err.code = 'HARDWARE_API_ERROR';
        err.statusCode = 429;
        log.error('kisi.rate_limit.exhausted', { endpoint, attempt }, err);
        throw err;
      }
      const backoffMs = attempt * 1000;
      log.warn('kisi.rate_limit.backoff', { endpoint, attempt, backoffMs });
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      return this.makeRequest(endpoint, options, apiKey, attempt + 1);
    }

    if (!response.ok) {
      let errorBody = {};
      try { errorBody = await response.json(); } catch (e) {}

      const statusMap = {
        401: {
          code: 'HARDWARE_KEY_INVALID',
          userMessage: "Your API key was rejected by the door system. It may have been rotated or revoked.",
          action: 'Rotate your API key in System Config → Hardware API Key.',
          resolution: 'ROTATE_API_KEY',
        },
        403: {
          code: 'HARDWARE_KEY_PERMISSIONS',
          userMessage: "Your API key doesn't have permission to manage users. This is usually a Kisi account tier issue.",
          action: 'Check your Kisi subscription tier or re-generate your API key with the correct permissions.',
          resolution: 'CHECK_PERMISSIONS',
        },
        404: {
          code: 'HARDWARE_RESOURCE_NOT_FOUND',
          userMessage: "A door group or user referenced in this plan no longer exists in your door system.",
          action: 'Go to Plan Mapping and re-assign a valid door group to this plan.',
          resolution: 'REMAP_PLAN',
        },
        422: {
          code: 'HARDWARE_VALIDATION_ERROR',
          userMessage: "Your door system rejected the request — the data may be malformed or the user already exists.",
          action: 'Try retrying. If it keeps failing, contact AccessSync support.',
          resolution: 'RETRY',
        },
      };

      const mapped = statusMap[response.status] || {
        code: 'HARDWARE_API_ERROR',
        userMessage: `Your door system returned an unexpected error (${response.status}).`,
        action: 'AccessSync will retry automatically. If this keeps happening, contact your hardware provider.',
        resolution: 'RETRY',
      };

      // OB-153: log full error context with structured Kisi body before throwing.
      // Preserves status code + Kisi body + mapped code for downstream debugging
      // even when error propagation flattens to a string at some boundary.
      //
      // Level selection: status codes that the adapter layer is known to recover
      // from idempotently are logged at WARN instead of ERROR. The connector has
      // no upper-layer context, but these are well-defined idempotent-success
      // shapes that should not pollute error counts or trip alert paths.
      //   - 409 on POST /role_assignments → kisi-adapter.js:158 reuses existing
      //   - 404 on DELETE /role_assignments → kisi-adapter.js OB-147 treats as success
      // All other 4xx/5xx stay at ERROR (real failures the operator must see).
      const method = options.method || 'GET';
      const isLikelyRecoverable =
        (response.status === 409 && method === 'POST'   && endpoint.startsWith('/role_assignments')) ||
        (response.status === 404 && method === 'DELETE' && endpoint.startsWith('/role_assignments'));
      const logFn = isLikelyRecoverable ? log.warn : log.error;
      logFn('kisi.response.error', {
        method,
        endpoint,
        statusCode: response.status,
        kisiCode: errorBody?.code || null,
        kisiMessage: errorBody?.message || response.statusText,
        mappedCode: mapped.code,
        recoverable: isLikelyRecoverable,
      });

      const error = new Error(`Kisi ${response.status}: ${errorBody?.message || response.statusText}`);
      error.statusCode = response.status;
      error.code = mapped.code;
      error.userMessage = mapped.userMessage;
      error.action = mapped.action;
      error.resolution = mapped.resolution;
      error.body = errorBody;
      throw error;
    }

    // OB-153: log every successful response at debug level so we can confirm calls landed.
    log.debug('kisi.response.success', {
      method: options.method || 'GET',
      endpoint,
      statusCode: response.status,
    });

    if (response.status === 204) return null;

    return await response.json();
  }
}

module.exports = new KisiConnector();
