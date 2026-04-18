/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: Shared rate limiter math                                     │
 * │                                                                         │
 * │  Business consequence: OB-89 Gate 2 calls Wix Members API once per      │
 * │  orphan during reconciliation. Without rate limiting, a sweep that      │
 * │  finds 500 orphans would fire 500 requests in ~1 second — Wix would     │
 * │  return 429s, reconciliation would abort, members would stay unprovis-  │
 * │  ioned. The rate limiter is the mechanical bound that keeps recovery    │
 * │  safe at scale.                                                         │
 * │                                                                         │
 * │  Standards register entry: AccessSync/STANDARDS.md → Best Practices →   │
 * │  "Shared rate-limiter helper for outbound API clients" (2026-04-17).    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const { RateLimiter } = require('../../core/rate-limiter');

describe('[P3] Rate limiter enforces sliding-window cap', () => {

  test('construction validates the rate argument', () => {
    expect(() => new RateLimiter({ rate: 0 })).toThrow(/positive rate/);
    expect(() => new RateLimiter({ rate: -1 })).toThrow(/positive rate/);
    expect(() => new RateLimiter({})).toThrow(/positive rate/);
  });

  test('acquire() is non-blocking when under the cap', async () => {
    const limiter = new RateLimiter({ rate: 10, windowMs: 1000, name: 'test-underflow' });
    const start = Date.now();
    for (let i = 0; i < 5; i++) await limiter.acquire();
    const elapsed = Date.now() - start;
    // Five acquires under the 10-per-sec cap should complete nearly instantly.
    expect(elapsed).toBeLessThan(100);
    expect(limiter.currentCount()).toBe(5);
  });

  test('acquire() blocks when at cap — 50 calls at rate=10 take at least ~4 seconds', async () => {
    const limiter = new RateLimiter({ rate: 10, windowMs: 1000, name: 'test-throttle' });
    const start = Date.now();
    for (let i = 0; i < 50; i++) await limiter.acquire();
    const elapsed = Date.now() - start;
    // 50 at 10/sec → needs (50-10)/10 = 4 seconds minimum for the back 40 requests.
    // 3800ms allows test-runner noise while still reliably catching a broken limiter
    // (which would complete in ~0ms).
    expect(elapsed).toBeGreaterThanOrEqual(3800);
  }, 10000);

  test('currentCount() prunes old entries outside the window', async () => {
    const limiter = new RateLimiter({ rate: 5, windowMs: 100, name: 'test-prune' });
    for (let i = 0; i < 3; i++) await limiter.acquire();
    expect(limiter.currentCount()).toBe(3);
    // Wait for the window to expire.
    await new Promise(r => setTimeout(r, 150));
    expect(limiter.currentCount()).toBe(0);
  });
});
