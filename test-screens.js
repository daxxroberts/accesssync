const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TEST_IMAGES_DIR = '.test-images';

(async () => {
  // Clear test images directory before each run
  if (fs.existsSync(TEST_IMAGES_DIR)) {
    fs.rmSync(TEST_IMAGES_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_IMAGES_DIR, { recursive: true });
  console.log(`🧹 Cleared ${TEST_IMAGES_DIR}/\n`);

  const browser = await chromium.launch();

  const pages = [
    { name: 'dashboard', url: 'https://accesssync-admin.up.railway.app/dashboard' },
    { name: 'members', url: 'https://accesssync-admin.up.railway.app/members' },
    { name: 'plan-mapping', url: 'https://accesssync-admin.up.railway.app/plan-mapping' },
    { name: 'access', url: 'https://accesssync-admin.up.railway.app/access' },
    { name: 'locations', url: 'https://accesssync-admin.up.railway.app/locations' },
    { name: 'admin-panel', url: 'https://accesssync-admin.up.railway.app/admin-panel' }
  ];

  for (const page_info of pages) {
    const page = await browser.newPage();
    const logs = [];
    const errors = [];

    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => errors.push(err.message));

    console.log(`\n=== Testing ${page_info.name} ===`);

    try {
      await page.goto(page_info.url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Screenshot
      const screenshotPath = path.join(TEST_IMAGES_DIR, `${page_info.name}.png`);
      await page.screenshot({ path: screenshotPath });
      console.log(`✓ Screenshot: ${screenshotPath}`);

      // Page title
      const title = await page.title();
      console.log(`Title: ${title}`);

      // Check DOM for data
      const bodyText = await page.textContent('body');
      const hasData = bodyText.length > 500 ? '✓ Content loaded' : '⚠ Limited content';
      console.log(`${hasData} (${bodyText.length} chars)`);

      // Report logs
      if (logs.length > 0) {
        console.log(`Logs:\n  ${logs.join('\n  ')}`);
      }

      // Report errors
      if (errors.length > 0) {
        console.log(`Errors:\n  ${errors.join('\n  ')}`);
      }

    } catch (e) {
      console.error(`✗ Failed: ${e.message}`);
    }

    await page.close();
  }

  await browser.close();
  console.log('\n✓ Done.');
})();
