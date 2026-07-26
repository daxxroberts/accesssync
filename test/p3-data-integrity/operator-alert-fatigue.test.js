/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                             │
 * │  Hardware-key alert fatigue — escalate-then-cool-down                   │
 * │                                                                          │
 * │  The 6-hourly health-check cron had NO send suppression: a key that      │
 * │  stayed broken re-emailed the operator on every run — 4x/day for as long │
 * │  as it stayed broken. Builder complaint 2026-07-25 ("I'm receiving       │
 * │  emails every day... I have no idea what to do with them").              │
 * │                                                                          │
 * │  Builder ruling: escalate then cool down. Alert on every run for the     │
 * │  first 24h of a failure (a broken key blocks new signups, so early       │
 * │  urgency is warranted), then at most once a day while it stays broken.   │
 * │                                                                          │
 * │  What CANNOT regress:                                                    │
 * │    1. A brand-new failure always alerts                                  │
 * │    2. Every run inside the first 24h alerts (escalation)                 │
 * │    3. Past 24h, at most one alert per 24h (cool-down)                    │
 * │    4. A recovered key clears the tracking so the next failure escalates  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() };
jest.mock('../../core/logger', () => ({ log: mockLog, withTrace: jest.fn(() => mockLog) }));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 't'), getActor: jest.fn(() => ({ type: 'system', id: 'test' })),
  runWith: jest.fn((ctx, fn) => fn()), mintTraceId: jest.fn(() => 't'), setTraceContext: jest.fn(),
}));
jest.mock('../../adapters/hardware-adapter', () => ({ getLocks: jest.fn(), getGroups: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(k => `plain-${k}`) }));
jest.mock('../../adapters/wix/wix-plans-api', () => ({ listPricingPlans: jest.fn() }));

const { _shouldSendKeyAlert } = require('../../core/hardware-health-check');

const HOUR = 60 * 60 * 1000;
const NOW  = new Date('2026-07-25T12:00:00Z').getTime();
const ago  = hours => new Date(NOW - hours * HOUR);

describe('[P3] hardware key alert — escalate then cool down', () => {
  test('a brand-new failure alerts', () => {
    expect(_shouldSendKeyAlert({ key_first_failed_at: null, key_last_alerted_at: null }, NOW)).toBe(true);
  });

  test.each([1, 6, 12, 18, 23])(
    'still escalating at %ih — alerts even though it alerted an hour ago',
    (hoursBroken) => {
      const should = _shouldSendKeyAlert({
        key_first_failed_at: ago(hoursBroken),
        key_last_alerted_at: ago(1),
      }, NOW);
      expect(should).toBe(true);
    }
  );

  test('past 24h, suppresses a repeat within the same day', () => {
    expect(_shouldSendKeyAlert({
      key_first_failed_at: ago(72),
      key_last_alerted_at: ago(6),
    }, NOW)).toBe(false);
  });

  test('past 24h, alerts again once a full day has passed', () => {
    expect(_shouldSendKeyAlert({
      key_first_failed_at: ago(72),
      key_last_alerted_at: ago(25),
    }, NOW)).toBe(true);
  });

  test('past 24h with no alert on record, alerts', () => {
    expect(_shouldSendKeyAlert({
      key_first_failed_at: ago(48),
      key_last_alerted_at: null,
    }, NOW)).toBe(true);
  });

  test('a week-long outage sends 4 alerts in the first day, then 1 per day', () => {
    // Simulate the real cron cadence against the real state machine.
    const brokenSince = new Date(NOW);
    let lastAlerted = null;
    let sends = 0;
    let sendsInFirstDay = 0;

    for (let run = 0; run < 7 * 4; run++) {          // 7 days x 4 runs/day
      const t = NOW + run * 6 * HOUR;
      if (_shouldSendKeyAlert({ key_first_failed_at: brokenSince, key_last_alerted_at: lastAlerted }, t)) {
        sends++;
        if (t - NOW < 24 * HOUR) sendsInFirstDay++;
        lastAlerted = new Date(t);
      }
    }

    expect(sendsInFirstDay).toBe(4);   // escalation: every run on day one
    expect(sends).toBeLessThanOrEqual(11);
    // Old behavior sent one per run for the whole week.
    expect(sends).toBeLessThan(28);
  });

  test('a recovered key clears tracking, so the next failure escalates again', () => {
    // _updateLocationVerification NULLs both fields on success; that state must alert.
    expect(_shouldSendKeyAlert({ key_first_failed_at: null, key_last_alerted_at: null }, NOW)).toBe(true);
  });
});
