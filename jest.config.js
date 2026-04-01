/**
 * jest.config.js — AccessSync Test Runner
 *
 * Concept #6: Business risk-aware test prioritization.
 * Tests run in business impact order: P1 (churn risk) → P2 → P3 → P4 → P5.
 * Failures are reported in business language, not assertion errors.
 *
 * Scripts:
 *   npm test                → full suite (all priorities)
 *   npm run test:p1         → critical path only (payment → door opens)
 *   npm run test:deploy     → P1 + P2 + P3 (deploy-blocking tiers only)
 *   npm run test:coverage   → full suite + coverage report
 */

module.exports = {
  testEnvironment: 'node',

  // Look for tests only in the test/ directory
  testMatch: ['**/test/**/*.test.js'],

  // Run P1 before P2 before P3 etc — see test/priority-sequencer.js
  testSequencer: './test/priority-sequencer.js',

  // Default reporter shows the standard Jest output.
  // Business risk reporter adds the impact summary block at the end.
  reporters: [
    'default',
    './test/reporters/business-risk-reporter.js',
  ],

  // Coverage: track the modules that matter for the critical path
  collectCoverageFrom: [
    'core/grant-revoke.js',
    'core/plan-mapping-resolver.js',
    'core/queue-worker.js',
    'core/crypto-utils.js',
    'adapters/wix/wix-adapter.js',
    'adapters/kisi/kisi-adapter.js',
    'adapters/standard-adapter.js',
  ],

  // Coverage thresholds — but note: meeting these thresholds means nothing
  // if P1 scenarios are not covered. Coverage % is a lagging indicator.
  // P1 test passage is the primary deploy gate — not this number.
  coverageThreshold: {
    global: {
      branches:   50,
      functions:  50,
      lines:      50,
      statements: 50,
    },
  },

  // Verbose by default so test names (business scenarios) are visible
  verbose: true,

  // Clear mocks between tests
  clearMocks: true,
};
