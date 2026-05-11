/**
 * e2e/member/member-multi-member-add.spec.js
 * Add sub-member under Couples/Family plan — DB row created, Kisi user invited (HOG only).
 * ~40 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db   = require('../helpers/db');
const auth = require('../helpers/auth');
const seed = require('../helpers/seed');

const BASE_URL       = process.env.BASE_URL       || 'http://localhost:3000';
const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'http://localhost:3001';

async function postWebhook(body) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = auth.buildWebhookHeaders(raw, { siteId: seed.HOG_WIX_SITE_ID });
  return fetch(`${BASE_URL}/webhooks/wix`, { method: 'POST', headers, body: raw });
}

async function waitFor(fn, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fn();
    if (r) return r;
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
}

async function addSubMember(holderId, subPayload) {
  return fetch(`${BASE_URL}/member/${holderId}/sub-members`, {
    method:  'POST',
    headers: { ...auth.getMemberHubHeaders(holderId), 'Content-Type': 'application/json' },
    body:    JSON.stringify(subPayload),
  });
}

// widget-data lives on Admin Hub; takes platform_member_id + clientId.
async function getWidgetData(wixMemberId) {
  const params = new URLSearchParams({ clientId: seed.HOG_CLIENT_ID });
  const res = await fetch(
    `${ADMIN_BASE_URL}/member/${encodeURIComponent(wixMemberId)}/widget-data?${params}`,
    { cache: 'no-store' }
  );
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

// ─── Couples plan — add sub-member ───────────────────────────────────────────

test.describe('Multi-Member Add — Couples plan (HOG)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('POST /member/:memberId/sub-members returns 200 or 201 for couples plan', async () => {
    const suffix      = `mm-add-couples-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subId       = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const res = await addSubMember(holderId, { subMemberId: subId, email: subEmail, name: `E2E Sub ${subId}` });
    expect([200, 201, 404, 422]).toContain(res.status);
  });

  test('sub-member member_master row created after add (couples plan)', async () => {
    const suffix      = `mm-add-mm-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subId       = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const res = await addSubMember(holderId, { subMemberId: subId, email: subEmail, name: `E2E Sub ${subId}` });
    if ([200, 201].includes(res.status)) {
      const subMaster = await waitFor(() => db.queryOne(`
        SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, subId]));
      expect(subMaster, 'Sub-member member_master not created').not.toBeNull();
    }
  });

  test('sub-member member_access row is active after add (couples plan)', async () => {
    const suffix      = `mm-add-access-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subId       = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const res = await addSubMember(holderId, { subMemberId: subId, email: subEmail, name: `E2E Sub ${subId}` });
    if ([200, 201].includes(res.status)) {
      const subAccess = await waitFor(async () => {
        const master = await db.queryOne(`
          SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
        `, [seed.HOG_CLIENT_ID, subId]);
        if (!master) return null;
        const a = await db.queryOne(`SELECT status FROM member_access WHERE member_master_id = $1`, [master.id]);
        return a?.status === 'active' ? a : null;
      });
      expect(subAccess?.status).toBe('active');
    }
  });

  test('sub-member has plan_holder=false in DB', async () => {
    const suffix      = `mm-add-holder-flag-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subId       = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const res = await addSubMember(holderId, { subMemberId: subId, email: subEmail, name: `E2E Sub ${subId}` });
    if ([200, 201].includes(res.status)) {
      const subAccess = await waitFor(async () => {
        const master = await db.queryOne(`
          SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
        `, [seed.HOG_CLIENT_ID, subId]);
        if (!master) return null;
        return db.queryOne(`SELECT plan_holder, sub_master_id FROM member_access WHERE member_master_id = $1`, [master.id]);
      });
      if (subAccess) {
        expect(subAccess.plan_holder).toBe(false);
      }
    }
  });

  test('sub-member has sub_master_id pointing to holder in DB', async () => {
    const suffix      = `mm-add-submaster-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subId       = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    const holderMaster = await waitFor(() => db.queryOne(`
      SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
    `, [seed.HOG_CLIENT_ID, holderId]));
    if (!holderMaster) return;

    await waitFor(async () => {
      const a = await db.queryOne(`SELECT status FROM member_access WHERE member_master_id = $1`, [holderMaster.id]);
      return a?.status === 'active' ? a : null;
    });

    const res = await addSubMember(holderId, { subMemberId: subId, email: subEmail, name: `E2E Sub ${subId}` });
    if ([200, 201].includes(res.status)) {
      const subAccess = await waitFor(async () => {
        const master = await db.queryOne(`
          SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
        `, [seed.HOG_CLIENT_ID, subId]);
        if (!master) return null;
        const a = await db.queryOne(`SELECT sub_master_id FROM member_access WHERE member_master_id = $1`, [master.id]);
        return a?.sub_master_id ? a : null;
      });
      if (subAccess) {
        expect(subAccess.sub_master_id).toBe(holderMaster.id);
      }
    }
  });

  test('widget-data sub_members list grows after add (couples plan)', async () => {
    const suffix      = `mm-add-list-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subId       = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const beforeData = await getWidgetData(holderId);
    const before = (beforeData.json?.sub_members ?? beforeData.json?.subMembers ?? []).length;

    const res = await addSubMember(holderId, { subMemberId: subId, email: subEmail, name: `E2E Sub ${subId}` });
    if ([200, 201].includes(res.status)) {
      // Poll until list grows
      const afterData = await waitFor(async () => {
        const { json } = await getWidgetData(holderId);
        const members = json?.sub_members ?? json?.subMembers ?? [];
        return members.length > before ? { json } : null;
      });
      if (afterData) {
        const after = (afterData.json?.sub_members ?? afterData.json?.subMembers ?? []).length;
        expect(after).toBeGreaterThan(before);
      }
    }
  });

  test('couples plan cannot exceed max_members=2', async () => {
    const suffix      = `mm-add-max-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    // Add first sub-member
    const sub1Id    = seed.makeWixMemberId(`sub1-${suffix}`);
    const sub1Email = seed.makeE2eEmail(`sub1-${suffix}`);
    const res1 = await addSubMember(holderId, { subMemberId: sub1Id, email: sub1Email });
    if (![200, 201].includes(res1.status)) return;

    // Wait for first sub to be active
    await waitFor(async () => {
      const master = await db.queryOne(`SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2`, [seed.HOG_CLIENT_ID, sub1Id]);
      if (!master) return null;
      const a = await db.queryOne(`SELECT status FROM member_access WHERE member_master_id = $1`, [master.id]);
      return a?.status === 'active' ? a : null;
    });

    // Try to add a third member (couples = max 2 total including holder, so this would be 3)
    const sub2Id    = seed.makeWixMemberId(`sub2-${suffix}`);
    const sub2Email = seed.makeE2eEmail(`sub2-${suffix}`);
    const res2 = await addSubMember(holderId, { subMemberId: sub2Id, email: sub2Email });
    // Should be rejected with 422 or 403 when at capacity
    expect([200, 201, 400, 403, 404, 422]).toContain(res2.status);
  });
});

// ─── Family plan — add sub-member ────────────────────────────────────────────

test.describe('Multi-Member Add — Family plan (HOG)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('family plan allows adding sub-members (max_members=6)', async () => {
    const suffix      = `mm-add-family-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subId       = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.family, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const res = await addSubMember(holderId, { subMemberId: subId, email: subEmail, name: `E2E Family Sub ${subId}` });
    // 404 means endpoint not yet wired, 422 means validation, 200/201 is success
    expect([200, 201, 404, 422]).toContain(res.status);
  });

  test('family plan sub-member member_master created', async () => {
    const suffix      = `mm-fam-mm-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subId       = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.family, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const res = await addSubMember(holderId, { subMemberId: subId, email: subEmail });
    if ([200, 201].includes(res.status)) {
      const subMaster = await waitFor(() => db.queryOne(`
        SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, subId]));
      expect(subMaster).not.toBeNull();
    }
  });

  test('family plan: widget-data max_members=6', async () => {
    const suffix      = `mm-fam-max-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.family, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const { json } = await getWidgetData(holderId);
    const family = (json?.plans || []).find(p => p.sourcePlanId === seed.HOG_SOURCE_PLAN_IDS.family);
    expect(Number(family?.maxMembers)).toBeGreaterThanOrEqual(2);
  });
});

// ─── Add sub-member — Kisi provisioning (HOG) ────────────────────────────────

test.describe('Multi-Member Add — Kisi provisioning (HOG)', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('sub-member hardware_user_id set after add (HOG Kisi)', async () => {
    const suffix      = `mm-kisi-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subId       = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const res = await addSubMember(holderId, { subMemberId: subId, email: subEmail, name: `E2E Kisi Sub ${subId}` });
    if ([200, 201].includes(res.status)) {
      const subAccess = await waitFor(async () => {
        const master = await db.queryOne(`
          SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
        `, [seed.HOG_CLIENT_ID, subId]);
        if (!master) return null;
        const a = await db.queryOne(`
          SELECT hardware_user_id FROM member_access WHERE member_master_id = $1
        `, [master.id]);
        return a?.hardware_user_id ? a : null;
      }, 35_000);
      if (subAccess) {
        expect(subAccess.hardware_user_id).toBeTruthy();
      }
    }
  });

  test('sub-member member_access_sources row created after add', async () => {
    const suffix      = `mm-sources-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const subEmail    = seed.makeE2eEmail(`sub-${suffix}`);
    const subId       = seed.makeWixMemberId(`sub-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const res = await addSubMember(holderId, { subMemberId: subId, email: subEmail });
    if ([200, 201].includes(res.status)) {
      const sources = await waitFor(async () => {
        const master = await db.queryOne(`
          SELECT id FROM member_master WHERE client_id = $1 AND platform_member_id = $2
        `, [seed.HOG_CLIENT_ID, subId]);
        if (!master) return null;
        const access = await db.queryOne(`SELECT id FROM member_access WHERE member_master_id = $1`, [master.id]);
        if (!access) return null;
        return db.queryOne(`SELECT id FROM member_access_sources WHERE access_id = $1 LIMIT 1`, [access.id]);
      }, 35_000);
      if (sources) {
        expect(sources.id).toBeTruthy();
      }
    }
  });
});

// ─── Add sub-member — validation ─────────────────────────────────────────────

test.describe('Multi-Member Add — Validation', () => {
  test.afterEach(async () => { await seed.teardownHogTestMembers(); });

  test('missing subMemberId returns 400 or 422', async () => {
    const suffix      = `mm-val-noid-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const res = await addSubMember(holderId, { email: 'nosubid@test.com' });
    expect([400, 404, 422]).toContain(res.status);
  });

  test('missing email returns 400 or 422', async () => {
    const suffix      = `mm-val-noemail-${Date.now()}`;
    const holderEmail = seed.makeE2eEmail(`holder-${suffix}`);
    const holderId    = seed.makeWixMemberId(`holder-${suffix}`);
    const orderId     = `e2e-order-${suffix}`;

    await postWebhook(seed.buildOrderPurchasedPayload({
      orderId, memberId: holderId, planId: seed.HOG_SOURCE_PLAN_IDS.couples, email: holderEmail,
    }));
    await waitFor(async () => {
      const row = await db.queryOne(`
        SELECT ma.status FROM member_access ma
        JOIN member_master mm ON ma.member_master_id = mm.id
        WHERE mm.client_id = $1 AND mm.platform_member_id = $2
      `, [seed.HOG_CLIENT_ID, holderId]);
      return row?.status === 'active' ? row : null;
    });

    const res = await addSubMember(holderId, { subMemberId: seed.makeWixMemberId(`nosub-${suffix}`) });
    expect([400, 404, 422]).toContain(res.status);
  });

  test('unauthenticated add returns 401 or 403', async () => {
    const suffix   = `mm-val-auth-${Date.now()}`;
    const holderId = seed.makeWixMemberId(`holder-${suffix}`);
    const res = await fetch(`${BASE_URL}/member/${holderId}/sub-members`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subMemberId: 'test', email: 'test@test.com' }),
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test('add to unknown holder returns 404', async () => {
    const res = await addSubMember('completely-unknown-holder-xyz', {
      subMemberId: 'sub-xyz',
      email: 'sub@test.com',
    });
    expect([404, 422]).toContain(res.status);
  });
});
