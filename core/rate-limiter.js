/**
 * @file rate-limiter.js
 * @layer core/shared
 * @role rate-limiting
 * @exports RateLimiter
 *
 * Shared sliding-window rate limiter for outbound platform API clients.
 * Each outbound client constructs one instance with its platform's documented
 * req/sec cap; every call awaits acquire() before making the network request.
 *
 * Pattern mirrors adapters/kisi/kisi-connector.js (lines 16-51, pre-dates this
 * helper). The Kisi connector will migrate to this shared helper on its next touch.
 *
 * Usage:
 *   const { RateLimiter } = require('../../core/rate-limiter');
 *   const limiter = new RateLimiter({ rate: 10, windowMs: 1000, name: 'wix-members' });
 *   await limiter.acquire();
 *   // then make the network call
 *
 * Standards register: see AccessSync/STANDARDS.md → Best Practices → "Shared rate-limiter
 * helper for outbound API clients" (2026-04-17).
 */

const { log } = require('./logger');

class RateLimiter {
  /**
   * @param {Object} opts
   * @param {number} opts.rate      max requests per window
   * @param {number} [opts.windowMs=1000] window size in milliseconds (default 1 second)
   * @param {string} [opts.name='rate-limiter'] label used in debug logs — makes Railway log grep easier
   */
  constructor({ rate, windowMs = 1000, name = 'rate-limiter' } = {}) {
    if (!rate || rate < 1) {
      throw new Error(`RateLimiter requires a positive rate; got ${rate}`);
    }
    this.rate = rate;
    this.windowMs = windowMs;
    this.name = name;
    // Timestamps of recent acquisitions — pruned on every acquire() call.
    this._recent = [];
  }

  /**
   * Blocks until at most (rate - 1) requests have fired in the last windowMs,
   * then records this request and returns. Non-blocking if under cap.
   * Safe to await in tight loops — the sleep inside the blocking path prevents
   * spin-waiting from burning CPU.
   */
  async acquire() {
    // Single iteration handles the common case; loop catches the edge where
    // multiple awaiters wake up at the same time and race.
    while (true) {
      const now = Date.now();
      // Prune timestamps older than the window.
      this._recent = this._recent.filter(t => now - t < this.windowMs);

      if (this._recent.length < this.rate) {
        this._recent.push(now);
        return;
      }

      // At cap — sleep until the oldest request leaves the window.
      const oldest = this._recent[0];
      const waitMs = this.windowMs - (now - oldest);
      log.debug('rate_limiter.pause', { name: this.name, waitMs, rate: this.rate });
      // +10ms cushion so we don't wake up a tick before the oldest actually expires.
      await new Promise(resolve => setTimeout(resolve, waitMs + 10));
    }
  }

  /**
   * Current count of requests in the active window. Useful for tests.
   */
  currentCount() {
    const now = Date.now();
    this._recent = this._recent.filter(t => now - t < this.windowMs);
    return this._recent.length;
  }
}

module.exports = { RateLimiter };
