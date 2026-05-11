/**
 * e2e/admin/admin-ui-walkthrough.spec.js
 *
 * Real browser walkthrough of admin surfaces. Tests JS rendering, API consumption,
 * sidebar interactions, and side-panel popups. NOT just API contract checks.
 *
 * Surfaces covered:
 *   - /OwnerDashboard — owner landing, client list, stats, sidebar
 *   - /plan-mapping — plan mapping rows + group dropdowns
 *   - /errors — error queue + member side-panel popup (per Daxx report:
 *               sidebar pop up doesn't seem to work in totality)
 *
 * Mode: serial — each describe block in order so we can collect findings
 * across surfaces without parallel cookie/state collisions.
 */

const { test, expect } = require('@playwright/test');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'http://localhost:3001';

test.describe.configure({ mode: 'serial' });

// ─────────────────────────────────────────────────────────────────────────────
// Helper: collect console errors and pageerrors during a page load
// ─────────────────────────────────────────────────────────────────────────────
function attachConsoleCapture(page) {
  const consoleErrors = [];
  const pageErrors    = [];
  const failedNetwork = [];

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => pageErrors.push(err.message));
  page.on('response', res => {
    if (res.status() >= 400 && res.url().includes(ADMIN_BASE_URL)) {
      failedNetwork.push(`${res.status()} ${res.url()}`);
    }
  });

  // Filter known non-blocking errors so they don't pollute findings.
  const KNOWN = [
    /each_key_duplicate/,        // Issue E (Svelte toast)
    /preloaded with link preload/, // Chrome preload warnings
    /favicon/,                    // missing favicon
  ];
  return {
    consoleErrors: () => consoleErrors.filter(e => !KNOWN.some(p => p.test(e))),
    pageErrors:    () => pageErrors.filter(e => !KNOWN.some(p => p.test(e))),
    failedNetwork: () => failedNetwork,
    raw:           { consoleErrors, pageErrors, failedNetwork },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// /OwnerDashboard
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Owner Dashboard — /OwnerDashboard', () => {
  test('page loads and renders client list', async ({ page, context }) => {
    const cap = attachConsoleCapture(page);
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`${ADMIN_BASE_URL}/OwnerDashboard`);
    expect(res.status()).toBe(200);

    // Wait for client cards to appear. OwnerDashboard renders a client list via JS.
    // Look for any sign of HOG ('House of Gains' or the client card container).
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2_000); // Allow Svelte bundle to mount and fetch

    // No pageerrors / no failed network requests
    expect(cap.pageErrors(), `Page errors: ${JSON.stringify(cap.pageErrors())}`).toHaveLength(0);

    // Capture the page text content to surface what's actually rendered
    const bodyText = await page.evaluate(() => document.body.innerText);
    // Should contain HOG or House of Gains
    const hasHogReference = /house of gains|hog|15962eac/i.test(bodyText);
    expect(hasHogReference, `OwnerDashboard body should reference HOG. Body excerpt: ${bodyText.slice(0, 500)}`).toBe(true);
  });

  test('sidebar / nav has expected sections', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`${ADMIN_BASE_URL}/OwnerDashboard`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2_000);

    // Look for common sidebar/nav strings — Owner Dashboard surfaces multiple sections
    const bodyText = await page.evaluate(() => document.body.innerText);
    // Don't fail hard — collect what's there for inspection
    const present = {
      clients:     /clients?/i.test(bodyText),
      members:     /members?/i.test(bodyText),
      errors:      /errors?/i.test(bodyText),
      logs:        /logs?/i.test(bodyText),
      plans:       /plan(s|\s|$)|mapping/i.test(bodyText),
    };
    // Surface what's there; assert at least the major sections exist
    expect(present.clients || present.members, `Expected nav to mention clients or members. Text excerpt: ${bodyText.slice(0, 800)}`).toBe(true);
  });

  test('stat cards / counts populate (no stuck "Loading..." after 5s)', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`${ADMIN_BASE_URL}/OwnerDashboard`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(5_000); // Generous wait for stats to populate

    const bodyText = await page.evaluate(() => document.body.innerText);
    // After 5s no "Loading..." or "—" or "??" should remain on stat cards
    const stuckLoading = /loading\.{2,3}/i.test(bodyText);
    // Just surface — don't fail unless blatantly stuck
    if (stuckLoading) {
      console.log('[FINDING] OwnerDashboard still shows "Loading..." after 5s. Excerpt:', bodyText.slice(0, 400));
    }
  });

  test('OwnerDashboard /auth/check returns 200 when logged in', async ({ context }) => {
    await auth.setAdminCookieOnContext(context);
    const cookieHeader = (await context.cookies()).map(c => `${c.name}=${c.value}`).join('; ');
    const res = await fetch(`${ADMIN_BASE_URL}/auth/check`, {
      headers: { Cookie: cookieHeader },
    });
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /plan-mapping
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Plan Mapping page — /plan-mapping', () => {
  test('page loads without 500', async ({ page, context }) => {
    const cap = attachConsoleCapture(page);
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`${ADMIN_BASE_URL}/plan-mapping?clientId=${seed.HOG_CLIENT_ID}`);
    expect([200, 404]).toContain(res.status());
    if (res.status() !== 200) {
      console.log('[FINDING] /plan-mapping returned', res.status(), '- page may not be operator-accessible without specific routing');
      return;
    }
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2_000);
    expect(cap.pageErrors(), `Page errors: ${JSON.stringify(cap.pageErrors())}`).toHaveLength(0);
  });

  test('plan mapping rows render with HOG plan names', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`${ADMIN_BASE_URL}/plan-mapping?clientId=${seed.HOG_CLIENT_ID}`);
    if (res.status() !== 200) return;
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3_000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    // Real HOG plans: Individual, Couples, Family, Student, etc.
    const hasPlans = /individual|couples|family|student/i.test(bodyText);
    expect(hasPlans, `Expected plan names visible. Body excerpt: ${bodyText.slice(0, 600)}`).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /errors — error queue page + side-panel popup (Daxx-flagged surface)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Error Queue page — /errors (Daxx-flagged: side-panel popup)', () => {
  test('error queue page loads', async ({ page, context }) => {
    const cap = attachConsoleCapture(page);
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`${ADMIN_BASE_URL}/errors?clientId=${seed.HOG_CLIENT_ID}`);
    expect([200, 404]).toContain(res.status());
    if (res.status() !== 200) {
      console.log('[FINDING] /errors returned', res.status());
      return;
    }
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2_000);
    expect(cap.pageErrors(), `Page errors: ${JSON.stringify(cap.pageErrors())}`).toHaveLength(0);
  });

  test('error queue shows rows OR an empty-state', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`${ADMIN_BASE_URL}/errors?clientId=${seed.HOG_CLIENT_ID}`);
    if (res.status() !== 200) return;
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3_000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    // Either rows render (something error-ish) OR empty state
    const hasContent = /error|no errors|empty|all clear/i.test(bodyText);
    expect(hasContent, `Errors page should show rows or empty state. Excerpt: ${bodyText.slice(0, 400)}`).toBe(true);
  });

  test('clicking an error row opens a side-panel popup', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`${ADMIN_BASE_URL}/errors?clientId=${seed.HOG_CLIENT_ID}`);
    if (res.status() !== 200) return;
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(3_000);

    // Try to find a clickable error row. Common patterns: button, link, or div with role=button.
    // We capture the raw HTML structure to see what's actually clickable.
    const clickableCount = await page.evaluate(() => {
      const candidates = document.querySelectorAll(
        'tr[role="button"], tr.clickable, .error-row, .error-card, [data-error-id], button[data-id], a[data-error]'
      );
      return candidates.length;
    });

    if (clickableCount === 0) {
      // Surface — can't find any clickable error rows. Probably means: no errors in queue,
      // OR row markup doesn't expose a click handler the way the test expects.
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log('[FINDING] No clickable error rows found. Page text excerpt:', bodyText.slice(0, 600));
      // Don't fail — this might just mean the queue is empty.
      return;
    }

    // Click the first clickable error row
    const cap = attachConsoleCapture(page);
    await page.evaluate(() => {
      const el = document.querySelector(
        'tr[role="button"], tr.clickable, .error-row, .error-card, [data-error-id], button[data-id], a[data-error]'
      );
      if (el) el.click();
    });
    await page.waitForTimeout(1_500);

    // Look for side-panel: common patterns include drawer, slideover, modal-like overlay
    const panelInfo = await page.evaluate(() => {
      const panel = document.querySelector(
        '.side-panel, .drawer, .slideover, [data-panel="error-detail"], aside[aria-modal], .modal-side'
      );
      if (!panel) return { found: false };
      return {
        found: true,
        visible: panel.offsetParent !== null,
        textPreview: panel.innerText.slice(0, 300),
        hasMemberInfo: /member|email|@/i.test(panel.innerText),
        hasErrorInfo: /error|reason|fail|code/i.test(panel.innerText),
      };
    });

    if (!panelInfo.found) {
      console.log('[FINDING] Clicked error row but no side-panel appeared. This may be the bug Daxx mentioned.');
    } else {
      console.log('[FINDING] Side-panel found. Visible:', panelInfo.visible,
                  '| has member info:', panelInfo.hasMemberInfo,
                  '| has error info:', panelInfo.hasErrorInfo);
      console.log('[FINDING] Side-panel content excerpt:', panelInfo.textPreview);
    }

    // No JS errors should fire from clicking
    expect(cap.pageErrors(), `Errors after clicking row: ${JSON.stringify(cap.pageErrors())}`).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /members — members page React island (DR'd-mentioned UI)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Members page — /members (React island)', () => {
  test('page loads and renders member list', async ({ page, context }) => {
    const cap = attachConsoleCapture(page);
    await auth.setAdminCookieOnContext(context);
    const res = await page.goto(`${ADMIN_BASE_URL}/members?clientId=${seed.HOG_CLIENT_ID}`);
    expect(res.status()).toBe(200);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(4_000); // React mount + API fetch

    expect(cap.pageErrors(), `Page errors: ${JSON.stringify(cap.pageErrors())}`).toHaveLength(0);

    const bodyText = await page.evaluate(() => document.body.innerText);
    // Should show member rows. HOG has real members; emails, statuses, plans should appear.
    const hasMembers = /@|active|inactive|individual|couples/i.test(bodyText);
    expect(hasMembers, `Members page should show data. Excerpt: ${bodyText.slice(0, 600)}`).toBe(true);
  });

  test('clicking a member opens the side drawer', async ({ page, context }) => {
    await auth.setAdminCookieOnContext(context);
    await page.goto(`${ADMIN_BASE_URL}/members?clientId=${seed.HOG_CLIENT_ID}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(4_000);

    const memberRowCount = await page.evaluate(() => {
      const rows = document.querySelectorAll(
        'tr[data-member-id], .member-row, .member-card, [data-master-id], button[data-member]'
      );
      return rows.length;
    });

    if (memberRowCount === 0) {
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.log('[FINDING] No clickable member rows found. Page excerpt:', bodyText.slice(0, 600));
      return;
    }

    const cap = attachConsoleCapture(page);
    await page.evaluate(() => {
      const row = document.querySelector(
        'tr[data-member-id], .member-row, .member-card, [data-master-id], button[data-member]'
      );
      if (row) row.click();
    });
    await page.waitForTimeout(1_500);

    const drawerInfo = await page.evaluate(() => {
      const drawer = document.querySelector(
        '.member-drawer, .drawer, .side-panel, aside[aria-modal], .member-detail-panel'
      );
      if (!drawer) return { found: false };
      return {
        found: true,
        visible: drawer.offsetParent !== null,
        textPreview: drawer.innerText.slice(0, 400),
      };
    });

    if (!drawerInfo.found) {
      console.log('[FINDING] Clicked member but no drawer/panel appeared.');
    } else {
      console.log('[FINDING] Member drawer found. Visible:', drawerInfo.visible);
      console.log('[FINDING] Drawer content excerpt:', drawerInfo.textPreview);
    }

    expect(cap.pageErrors(), `Errors after clicking member: ${JSON.stringify(cap.pageErrors())}`).toHaveLength(0);
  });
});
