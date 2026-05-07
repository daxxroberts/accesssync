const { defineConfig, devices } = require('@playwright/test');

const BASE_URL       = process.env.BASE_URL       || 'https://accesssync-production.up.railway.app';
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL  || 'https://accesssync-admin.up.railway.app';

// E2E secrets — Railway test credentials (not sensitive in a private repo; tests run against Railway)
const E2E_ENV = {
  BASE_URL,
  ADMIN_BASE_URL,
  DATABASE_URL:        process.env.DATABASE_URL        || 'postgresql://postgres:uSfbDjUYlneLoTXwCEEmVuGlBtFVrgFW@gondola.proxy.rlwy.net:27298/railway',
  WIX_WEBHOOK_SECRET:  process.env.WIX_WEBHOOK_SECRET  || 'ad6d52c6bd2c2b968c4d95d820cf1198d1e25c16f39a3fa3f389fa4c7f713b44',
  OWNER_PIN:           process.env.OWNER_PIN            || '2096',
};

module.exports = defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.js',

  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: 4,

  reporter: [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]],

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'api',
      testMatch: /e2e\/(schema|logging|api)\/.+\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BASE_URL,
      },
    },
    {
      name: 'admin',
      testMatch: /e2e\/admin\/.+\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: ADMIN_BASE_URL,
      },
    },
    {
      name: 'member',
      testMatch: /e2e\/member\/.+\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: BASE_URL,
      },
    },
  ],
});
