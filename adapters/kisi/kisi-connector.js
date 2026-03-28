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
        console.log(`[Kisi Rate Limiter] Pausing for ${timeToWait}ms`);
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

    const response = await fetch(url, {
      ...options,
      headers: this.getHeaders(apiKey)
    });

    if (response.status === 429) {
      if (attempt >= 3) throw new Error(`Kisi 429 Rate Limit Exhausted for ${url}`);
      const backoffMs = attempt * 1000;
      console.warn(`[Kisi Connector] 429 Rate Limit hit. Backing off ${backoffMs}ms`);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
      return this.makeRequest(endpoint, options, apiKey, attempt + 1);
    }

    if (!response.ok) {
      let errorBody = {};
      try { errorBody = await response.json(); } catch (e) {}
      const error = new Error(`Kisi API Error: ${response.status} ${response.statusText}`);
      error.statusCode = response.status;
      error.body = errorBody;
      throw error;
    }

    if (response.status === 204) return null;

    return await response.json();
  }
}

module.exports = new KisiConnector();
