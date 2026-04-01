/**
 * priority-sequencer.js
 * Custom Jest Test Sequencer — Concept #6: Business Risk Prioritization
 *
 * Runs P1 tests before P2, P2 before P3, etc.
 * If a P1 test fails fast, you get the critical alert before wasting time on P5 UI tests.
 *
 * Jest will use this if testSequencer is set in jest.config.js.
 */

class PrioritySequencer {
  /**
   * Returns tests sorted by business priority tier.
   * P1 runs first. Unknown tests run last.
   */
  sort(tests) {
    const getPriority = (testPath) => {
      const normalised = testPath.replace(/\\/g, '/');
      if (normalised.includes('/p1-')) return 1;
      if (normalised.includes('/p2-')) return 2;
      if (normalised.includes('/p3-')) return 3;
      if (normalised.includes('/p4-')) return 4;
      if (normalised.includes('/p5-')) return 5;
      return 99; // Unknown — run last
    };

    return [...tests].sort((a, b) => getPriority(a.path) - getPriority(b.path));
  }

  // Required no-op for Jest sequencer interface
  async cacheResults() {}
}

module.exports = PrioritySequencer;
