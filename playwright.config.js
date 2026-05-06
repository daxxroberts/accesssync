const { defineConfig, devices } = require('@playwright/test');

const BASE_URL       = process.env.BASE_URL       || 'http://localhost:3000';
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL  || 'http://localhost:3001';

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
