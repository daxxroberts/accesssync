/**
 * Rebuild the House of Gains QR entry guide PDF from its HTML source.
 *   node scripts/qr-guide/build.js
 * Writes admin/public/guides/house-of-gains-qr-door-code.pdf (served by the Admin
 * Hub; clients.qr_guide_url points at it).
 */
'use strict';

const path = require('path');
const { chromium } = require('playwright');

const SRC = path.join(__dirname, 'house-of-gains-qr-guide.html');
const OUT = path.join(__dirname, '..', '..', 'admin', 'public', 'guides', 'house-of-gains-qr-door-code.pdf');

(async () => {
  // CHROMIUM_PATH: point at a local Chromium when Playwright's own download is missing.
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
  await page.goto('file://' + SRC, { waitUntil: 'load' });
  await page.pdf({ path: OUT, format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
  await browser.close();
  console.log('wrote', OUT);
})();
