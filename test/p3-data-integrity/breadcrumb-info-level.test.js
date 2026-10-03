/**
 * PRIORITY 3 — routine lifecycle breadcrumbs are INFO, not warnings.
 *
 * ~97% of House of Gains' "warnings" were deliberate lifecycle breadcrumbs logged at warn only so
 * they would reach diagnostic_log. That kept the owner panel's Diagnostics card permanently amber
 * and buried the few real warnings. They are now info, and the event registry still persists them
 * (so the trace timeline keeps them) — except the one that carries the member's email.
 */

'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
const db = require('../../db');
const { log } = require('../../core/logger');

const flush = () => new Promise(r => setImmediate(r));
const inserts = () => db.query.mock.calls.filter(c => String(c[0]).includes('INSERT INTO diagnostic_log'));

const PERSISTED_INFO = [
  'adapter.resolve_and_lock.committed', 'adapter.resolve_and_lock.post_commit_verify',
  'adapter.complete_grant.entry', 'adapter.complete_grant.lookup',
  'wix.parse.unpaid_order_dropped',
  'admin.scheduler.armed', 'admin.scheduler.reconcile_start', 'admin.scheduler.reconcile_complete',
  'admin.scheduler.day_pass_sweep_start', 'admin.scheduler.day_pass_sweep_complete', 'admin.scheduler.day_pass_sweep_armed',
];

beforeEach(() => { db.query.mockClear(); });

describe('[P3] routine breadcrumbs: info level, still persisted', () => {
  test.each(PERSISTED_INFO)('%s at info is written to diagnostic_log with level "info"', async (event) => {
    log.info(event, { clientId: 'c1', memberId: 'm1' });
    await flush();
    const rows = inserts();
    expect(rows).toHaveLength(1);
    expect(rows[0][1][2]).toBe('info');           // level column — not counted by the panel's level='warn' query
  });

  test('the member-email diagnostic (kisi.user.created.full_response) is NOT written to diagnostic_log (DR-001)', async () => {
    log.info('kisi.user.created.full_response', { clientId: 'c1', email: 'x@example.test', response: { id: 1 } });
    await flush();
    expect(inserts()).toHaveLength(0);
  });

  test('a real anomaly under the same event name still persists as a WARN', async () => {
    log.warn('adapter.resolve_and_lock.post_commit_verify', { clientId: 'c1', verifyRowCount: 0 });
    await flush();
    expect(inserts()[0][1][2]).toBe('warn');
  });

  test('the registry entries exist and the call sites no longer log these at warn', () => {
    const reg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../core/EVENT_REGISTRY.json'), 'utf8')).overrides;
    for (const e of PERSISTED_INFO) expect(reg[e]).toEqual({ persist: true });
    expect(reg['kisi.user.created.full_response']).toEqual({ persist: false });

    const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
    expect(read('adapters/standard-adapter.js')).not.toMatch(/log\.warn\('adapter\.(resolve_and_lock\.committed|complete_grant\.entry)'/);
    expect(read('admin/server.js')).not.toMatch(/log\.warn\('admin\.scheduler\.(armed|reconcile_start|reconcile_complete|day_pass_sweep_(start|complete|armed))'/);
    expect(read('adapters/kisi/kisi-adapter.js')).not.toMatch(/log\.warn\('kisi\.user\.created\.full_response'/);
    expect(read('adapters/wix/wix-adapter.js')).not.toMatch(/log\.warn\('wix\.parse\.unpaid_order_dropped'/);
  });
});
