/**
 * e2e/global-setup.js
 * Runs once before all Playwright tests.
 * Seeds the Test client and writes IDs to e2e/.test-env.json for spec files.
 */

const fs   = require('fs');
const path = require('path');
const { seedTestClient } = require('./helpers/seed');
const { end }            = require('./helpers/db');

module.exports = async function globalSetup() {
  console.log('\n[E2E] Seeding test client...');
  let testEnv = null;
  try {
    testEnv = await seedTestClient();
    console.log(`[E2E] Test client seeded: ${testEnv.clientId}`);
  } catch (err) {
    // New schema tables may not exist yet (pre-S-9 migration).
    // Schema spec suite is designed to detect and report this — do not crash the runner.
    console.warn('[E2E] WARNING: seedTestClient() failed (new schema tables likely not yet migrated):', err.message);
    console.warn('[E2E] Schema spec tests will report missing tables. HOG tests continue against live data.');
    testEnv = {
      clientId:     null,
      locationId:   null,
      planMappings: { individual: null, couples: null },
      seedError:    err.message,
    };
  }

  // Write IDs to disk so spec files can read them without importing seed helpers
  const envPath = path.join(__dirname, '.test-env.json');
  fs.writeFileSync(envPath, JSON.stringify(testEnv, null, 2), 'utf8');
  console.log(`[E2E] Test env written to ${envPath}`);

  // Close the global-setup DB connection — each test worker gets its own pool
  await end();
};
