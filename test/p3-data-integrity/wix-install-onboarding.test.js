/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: AccessSync is installed on a new customer's Wix site        │
 * │  ("918 Fitness") and their owner opens it from the Wix dashboard.       │
 * │                                                                         │
 * │  The install is the invitation. Wix signs the instance (WIX_APP_SECRET)│
 * │  so the first open creates the client from that verified identity and  │
 * │  lands in setup — no link, no PIN. Real middleware + real portal router │
 * │  + real session JWT; only the database is faked (stateful).             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';
process.env.WIX_APP_SECRET   = 'test-wix-app-secret';

const crypto       = require('crypto');
const express      = require('express');
const cookieParser = require('cookie-parser');
const request      = require('supertest');
const jwt          = require('jsonwebtoken');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() } }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: v => v, encryptApiKey: v => `enc-${v}` }));

const db = require('../../db');
const { log } = require('../../core/logger');

const HOG = '11111111-1111-4111-8111-111111111111';

/** Stateful fake of just the SQL the Wix entry path issues. */
let clients;
let seq;
let failNextInsertWithRace;
function installFakeDb() {
  db.query.mockImplementation(async (sql, params = []) => {
    if (/FROM clients WHERE platform_instance_id = \$1/.test(sql)) {
      return { rows: clients.filter(c => c.platform_instance_id === params[0]).map(c => ({ id: c.id, source_site_id: c.source_site_id })) };
    }
    if (/FROM clients\s+WHERE source_site_id = \$1/.test(sql)) {
      return { rows: clients.filter(c => c.source_site_id === params[0] && !c.platform_instance_id).map(c => ({ id: c.id, source_site_id: c.source_site_id })) };
    }
    if (/^\s*INSERT INTO clients/.test(sql)) {
      if (failNextInsertWithRace) {
        failNextInsertWithRace = false;
        // another tab won the race: its row now exists, ours hits the unique index
        clients.push({ id: `winner-${params[1]}`, name: params[0], platform_instance_id: params[1], source_site_id: null, wix_webhook_secret: null });
        const e = new Error('duplicate key'); e.code = '23505'; throw e;
      }
      if (clients.some(c => c.platform_instance_id === params[1])) { const e = new Error('duplicate key'); e.code = '23505'; throw e; }
      const row = { id: `new-${++seq}`, name: params[0], platform_instance_id: params[1], source_site_id: null, wix_webhook_secret: null };
      clients.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (/UPDATE clients SET wix_webhook_secret/.test(sql)) {
      const c = clients.find(x => x.id === params[1]);
      if (c && c.wix_webhook_secret === null) { c.wix_webhook_secret = params[0]; return { rows: [{ id: c.id }] }; }
      return { rows: [] };
    }
    if (/UPDATE clients SET platform_instance_id/.test(sql)) {
      const c = clients.find(x => x.id === params[1] && !x.platform_instance_id);
      if (c) { c.platform_instance_id = params[0]; return { rows: [{ id: c.id }] }; }
      return { rows: [] };
    }
    if (/FROM connector_subscriptions/.test(sql)) return { rows: [] };          // no Kisi key yet
    if (/COUNT\(\*\)::int AS count FROM locations/.test(sql)) return { rows: [{ count: 0 }] };
    if (/INSERT INTO wix_admin_seen/.test(sql)) return { rows: [] };
    throw new Error(`unexpected SQL in test: ${sql}`);
  });
}

function signedInstance(payload, secret = process.env.WIX_APP_SECRET) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${crypto.createHmac('sha256', secret).update(data).digest('base64url')}.${data}`;
}
const OWNER = (instanceId, extra = {}) => signedInstance({ instanceId, uid: 'u-owner', siteOwnerId: 'u-owner', ...extra });

let app;
beforeAll(() => {
  app = express();
  app.use(cookieParser());
  app.use('/operator-portal', require('../../admin/routes/portal'));
});
beforeEach(() => {
  seq = 0;
  failNextInsertWithRace = false;
  clients = [{ id: HOG, name: 'House of Gains', platform_instance_id: 'inst-hog', source_site_id: 'site-hog', wix_webhook_secret: 'enc-hog' }];
  db.query.mockReset();
  installFakeDb();
  Object.values(log).forEach(f => f.mockClear());
});

const sessionOf = (res) => {
  const c = (res.headers['set-cookie'] || []).find(x => x.startsWith('operatorToken='));
  return c ? jwt.verify(c.split(';')[0].split('=')[1], process.env.ADMIN_JWT_SECRET) : null;
};
const open = (instance, extraQuery = '') => request(app).get(`/operator-portal?instance=${encodeURIComponent(instance)}${extraQuery}`);

describe('[P3] first open after install — the install is the invitation', () => {
  test('a new customer\'s owner gets a client, a session scoped to it, and lands in setup', async () => {
    const res = await open(OWNER('inst-918'));
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/operator-portal/setup');
    const s = sessionOf(res);
    expect(s).toMatchObject({ role: 'operator', clientId: 'new-1', instanceId: 'inst-918' });
    expect(s.clientId).not.toBe(HOG);
    expect(clients).toHaveLength(2);
    expect(clients[1]).toMatchObject({ platform_instance_id: 'inst-918', source_site_id: null, name: 'New Wix site' });
  });

  test('the new client gets its own webhook secret immediately (nothing for the gym to invent)', async () => {
    await open(OWNER('inst-918'));
    expect(clients[1].wix_webhook_secret).toMatch(/^enc-/);
    expect(clients[0].wix_webhook_secret).toBe('enc-hog');   // HOG's untouched
  });

  test('opening it again — or a second tab — reuses the same client (no duplicates)', async () => {
    const first = sessionOf(await open(OWNER('inst-918')));
    const second = sessionOf(await open(OWNER('inst-918')));
    expect(second.clientId).toBe(first.clientId);
    expect(clients).toHaveLength(2);
  });

  test('two tabs racing on the unique index end on the same client', async () => {
    failNextInsertWithRace = true;
    const res = await open(OWNER('inst-race'));
    expect(res.status).toBe(302);
    expect(sessionOf(res).clientId).toBe('winner-inst-race');
    expect(clients.filter(c => c.platform_instance_id === 'inst-race')).toHaveLength(1);
  });

  test('only the verified instanceId is used — a forged siteId / clientId in the URL changes nothing', async () => {
    const forged = Buffer.from(JSON.stringify({ data: JSON.stringify({ decodedToken: { siteId: 'site-hog' } }) })).toString('base64url');
    const res = await open(OWNER('inst-918'), `&authorizationCode=x.${forged}.y&clientId=${HOG}&siteId=site-hog`);
    const s = sessionOf(res);
    expect(s.clientId).toBe('new-1');
    expect(clients[0]).toMatchObject({ platform_instance_id: 'inst-hog', source_site_id: 'site-hog' });   // HOG not re-pointed
    expect(clients[1].source_site_id).toBeNull();                                                         // forged site id not stored
  });
});

describe('[P3] who can open it is unchanged', () => {
  test('HOG\'s owner still goes straight in on their own client (Path A)', async () => {
    const res = await open(OWNER('inst-hog'));
    expect(sessionOf(res)).toMatchObject({ clientId: HOG, instanceId: 'inst-hog' });
    expect(clients).toHaveLength(1);                         // nothing created
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO clients/.test(sql))).toBe(false);
  });

  test('an unsigned or wrongly signed instance creates nothing and issues no session', async () => {
    const forged = signedInstance({ instanceId: 'inst-evil', uid: 'u', siteOwnerId: 'u' }, 'not-the-app-secret');
    const res = await open(forged);
    expect(res.status).toBe(401);
    expect(sessionOf(res)).toBeNull();
    expect(clients).toHaveLength(1);
  });

  test('anonymous visitors and non-owners (staff) are still refused and create nothing', async () => {
    const anon = await open(signedInstance({ instanceId: 'inst-x', aid: 'anon-1' }));
    const staff = await open(signedInstance({ instanceId: 'inst-x', uid: 'u-staff', siteOwnerId: 'u-owner' }));
    expect(anon.status).toBe(401);
    expect(staff.status).toBe(401);
    expect(clients).toHaveLength(1);
  });

  test('no instance token at all → 401, nothing created', async () => {
    const res = await request(app).get('/operator-portal');
    expect(res.status).toBe(401);
    expect(clients).toHaveLength(1);
  });

  test('a database failure creating the client is a refusal, never a session for someone else', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/INSERT INTO clients/.test(sql)) throw new Error('db down');
      return { rows: [] };
    });
    const res = await open(OWNER('inst-918'));
    expect(res.status).toBe(401);
    expect(sessionOf(res)).toBeNull();
  });
});

describe('[P3] two new customers stay apart', () => {
  test('918 Fitness and another new gym get different clients and sessions that cannot cross', async () => {
    const a = sessionOf(await open(OWNER('inst-918')));
    const b = sessionOf(await open(OWNER('inst-other', { uid: 'u2', siteOwnerId: 'u2' })));
    expect(a.clientId).not.toBe(b.clientId);
    expect([a.clientId, b.clientId]).not.toContain(HOG);
  });
});
