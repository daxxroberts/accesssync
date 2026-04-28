/**
 * business-risk-reporter.js
 * Custom Jest Reporter — Concept #6: AI That Understands Business Risk
 *
 * Translates test failures from:
 *   "AssertionError: Expected 'success' but received 'error' at line 47"
 * Into:
 *   "❌ CRITICAL BUSINESS FAILURE [P1] — CHURN RISK
 *    Scenario: Member purchases Wix plan → access provisioned in hardware
 *    A paying gym member cannot get through the door."
 *
 * Business impact is determined by test file path (p1-* = P1, p2-* = P2, etc.)
 * P1 failures print a deploy block warning. P5 failures print advisory only.
 */

const path = require('path');
const priorities = require('../business-priorities.json');

// Build a lookup: path pattern → tier config
const TIER_MAP = Object.entries(priorities.tiers).map(([key, tier]) => ({
  key,
  pattern: tier.testPathPattern,
  ...tier,
}));

function getTierForPath(testFilePath) {
  const normalised = testFilePath.replace(/\\/g, '/');
  return TIER_MAP.find(t => normalised.includes(t.pattern)) || null;
}

function formatDivider(char = '═', len = 70) {
  return char.repeat(len);
}

class BusinessRiskReporter {
  constructor(globalConfig, options) {
    this._globalConfig = globalConfig;
    this._options = options || {};
    this._failuresByTier = {};
    this._passesByTier = {};
  }

  // Called after each test file completes
  onTestResult(test, testResult) {
    const filePath = testResult.testFilePath;
    const tier = getTierForPath(filePath);

    const failures = testResult.testResults.filter(r => r.status === 'failed');
    const passes  = testResult.testResults.filter(r => r.status === 'passed');

    if (tier) {
      const key = tier.key;
      this._failuresByTier[key] = (this._failuresByTier[key] || []).concat(
        failures.map(f => ({ ...f, filePath, tier }))
      );
      this._passesByTier[key] = (this._passesByTier[key] || 0) + passes.length;
    }
  }

  // Called once when all tests are done
  onRunComplete(testContexts, results) {
    const allFailures = Object.values(this._failuresByTier).flat();
    const hasBlockingFailure = allFailures.some(f => f.tier.deployBlock);

    // Detect suites that FAILED TO LOAD (e.g. worker crash, syntax error,
    // require() throw). These never trigger onTestResult, so allFailures
    // can be empty even when Jest itself is reporting failure. Without
    // this check the reporter prints DEPLOY SAFE while CI exits with code 1.
    const suiteLoadFailures = (results.numFailedTestSuites || 0) - (results.testResults || [])
      .filter(r => (r.testResults || []).some(t => t.status === 'failed')).length;

    if (suiteLoadFailures > 0) {
      this._printSuiteLoadFailures(results, suiteLoadFailures);
      return;
    }

    // Only print the business risk section if there are failures
    if (allFailures.length === 0) {
      this._printAllClear();
      return;
    }

    console.log('');
    console.log(formatDivider());
    console.log('  ACCESSSYNC — BUSINESS RISK FAILURE REPORT');
    console.log(formatDivider());
    console.log('');

    // Print failures grouped by tier, highest priority first
    for (const [key, tier] of Object.entries(priorities.tiers)) {
      const tierFailures = this._failuresByTier[key] || [];
      if (tierFailures.length === 0) continue;

      console.log(`${tier.emoji}  [${key.toUpperCase()}] ${tier.label}`);
      console.log(`   Impact: ${tier.businessConsequence}`);
      if (tier.deployBlock) {
        console.log(`   ⛔ DEPLOY BLOCKED — this tier must be green before any deploy`);
      }
      console.log('');

      for (const failure of tierFailures) {
        const relativePath = path.relative(process.cwd(), failure.filePath);
        console.log(`   ❌ SCENARIO FAILED: "${failure.fullName}"`);
        console.log(`      File: ${relativePath}`);

        // Print the first failure message, cleaned up (no stack noise for now)
        if (failure.failureMessages && failure.failureMessages.length > 0) {
          const firstMsg = failure.failureMessages[0]
            .split('\n')
            .filter(l => !l.trim().startsWith('at '))  // strip stack frames
            .slice(0, 5)
            .join('\n      ');
          console.log(`      Error: ${firstMsg}`);
        }
        console.log('');
      }
    }

    // Final verdict
    console.log(formatDivider('─'));
    if (hasBlockingFailure) {
      const blockingCount = allFailures.filter(f => f.tier.deployBlock).length;
      console.log(`⛔  DO NOT DEPLOY — ${blockingCount} business-critical scenario(s) failing`);
      console.log(`    Critical path: ${priorities.tiers.p1.criticalPath}`);
    } else {
      console.log(`⚠️   Deploy unblocked (no P1/P2/P3 failures) but review warnings above`);
    }
    console.log(formatDivider());
    console.log('');
  }

  _printSuiteLoadFailures(results, count) {
    console.log('');
    console.log(formatDivider());
    console.log('  ACCESSSYNC — TEST SUITE LOAD FAILURE');
    console.log(formatDivider());
    console.log('');
    console.log(`⛔  DO NOT DEPLOY — ${count} test suite(s) failed to load`);
    console.log('   Suite-load failures usually mean a worker crash, syntax error,');
    console.log('   or a fire-and-forget side effect calling process.exit during teardown.');
    console.log('   No tests in the failing suite(s) ran. Inspect output above.');
    console.log('');
    // Surface which suites failed
    const failedFiles = (results.testResults || [])
      .filter(r => r.failureMessage && (!r.testResults || r.testResults.length === 0))
      .map(r => path.relative(process.cwd(), r.testFilePath));
    if (failedFiles.length > 0) {
      console.log('   Failed to load:');
      failedFiles.forEach(f => console.log(`     • ${f}`));
      console.log('');
    }
    console.log(formatDivider());
    console.log('');
  }

  _printAllClear() {
    const p1Passes = this._passesByTier['p1'] || 0;
    const p2Passes = this._passesByTier['p2'] || 0;
    const p3Passes = this._passesByTier['p3'] || 0;

    if (p1Passes > 0 || p2Passes > 0 || p3Passes > 0) {
      console.log('');
      console.log(formatDivider('─'));
      console.log(`✅  DEPLOY SAFE — All business-critical scenarios passing`);
      if (p1Passes > 0) console.log(`   🚨 P1 Critical Path:   ${p1Passes} scenario(s) green`);
      if (p2Passes > 0) console.log(`   🔴 P2 Onboarding:      ${p2Passes} scenario(s) green`);
      if (p3Passes > 0) console.log(`   🔴 P3 Data Integrity:  ${p3Passes} scenario(s) green`);
      console.log(`   Critical path: ${priorities.tiers.p1.criticalPath}`);
      console.log(formatDivider('─'));
      console.log('');
    }
  }
}

module.exports = BusinessRiskReporter;
