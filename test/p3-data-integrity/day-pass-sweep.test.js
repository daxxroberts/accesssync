/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: day pass expiry sweep + reconcile exemption (OB-98/101/251)  │
 * │                                                                         │
 * │  - Pass A enqueues ONE synthetic plan.cancelled per (member × plan)     │
 * │    with syntheticSource 'day-pass-sweep.expired'                        │
 * │  - Pass B deletes only expired, marker-owned links no DB row references │
 * │  - the sweep itself writes NO member_access* table (DR-023)             │
 * │  - reconcile Pass 1 promotion excludes day_pass mappings                │
 * │  - queue-worker branches to the day-pass path BEFORE resolveIdentity    │
 * │  - log-redaction covers every bearer-credential field name              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/webhook-processor', () => ({ eventQueue: { add: jest.fn() } }));
jest.mock('../../adapters/hardware-adapter', () => ({
  listGroupLinks:  jest.fn(),
  deleteGroupLink: jest.fn(),
}));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(() => 'kisi-key') }));
jest.mock('../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));

const fs   = require('fs');
const path = require('path');
const db              = require('../../db');
const { eventQueue }  = require('../../core/webhook-processor');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const { decryptApiKey } = require('../../core/crypto-utils');
const { runDayPassSweep, SYNTHETIC_SOURCE } = require('../../core/day-pass-sweep');

const ROOT = path.join(__dirname, '..', '..');
const CLIENT = 'client-hog-001';

beforeEach(() => {
  jest.resetAllMocks(); // also wipes factory implementations — re-arm the ones we rely on
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  decryptApiKey.mockReturnValue('kisi-key');
});

describe('[P3] day-pass sweep — Pass A expired rows → synthetic revoke', () => {
  test('one revoke job per (member × plan), never per group row', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [
        { id: 's1', access_id: 'ma-1', client_id: CLIENT, source_plan_id: 'plan-dp', valid_until: '2026-09-13T00:00:00Z', platform_member_id: 'wix-1', source_platform: 'wix' },
        { id: 's2', access_id: 'ma-1', client_id: CLIENT, source_plan_id: 'plan-dp', valid_until: '2026-09-13T00:00:00Z', platform_member_id: 'wix-1', source_platform: 'wix' },
        { id: 's3', access_id: 'ma-2', client_id: CLIENT, source_plan_id: 'plan-dp', valid_until: '2026-09-13T00:00:00Z', platform_member_id: 'wix-2', source_platform: 'wix' },
      ] })
      .mockResolvedValueOnce({ rows: [] }); // clients for Pass B
    eventQueue.add.mockResolvedValue({});

    const result = await runDayPassSweep({ triggerSource: 'test' });

    expect(result.expiredEnqueued).toBe(2);
    expect(eventQueue.add).toHaveBeenCalledTimes(2);
    const [name, payload, opts] = eventQueue.add.mock.calls[0];
    expect(name).toBe('revoke');
    expect(payload.tenantId).toBe(CLIENT);
    expect(payload.standardEvent).toMatchObject({
      eventType: 'plan.cancelled', platformMemberId: 'wix-1', planId: 'plan-dp',
      synthetic: true, syntheticSource: SYNTHETIC_SOURCE,
    });
    expect(payload.standardEvent.traceId).toBeTruthy();
    expect(opts.jobId).toMatch(/^daypass-expire-ma-1-/);
    expect(SYNTHETIC_SOURCE).toBe('day-pass-sweep.expired');
  });

  test('the expired-rows query is scoped to active day_pass rows past valid_until', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await runDayPassSweep({ triggerSource: 'test' });
    const sql = db.query.mock.calls[0][0];
    expect(sql).toMatch(/source_type = 'day_pass'/);
    expect(sql).toMatch(/status = 'active'/);
    expect(sql).toMatch(/valid_until <= NOW\(\)/);
  });
});

describe('[P3] day-pass sweep — Pass B orphan links', () => {
  test('deletes only expired, marker-owned links with no DB row', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })                                                   // expired rows
      .mockResolvedValueOnce({ rows: [{ client_id: CLIENT, hardware_platform: 'kisi', hardware_api_key: 'enc' }] })
      .mockResolvedValueOnce({ rows: [{ role_assignment_id: '2' }] });                        // known link ids
    hardwareAdapter.listGroupLinks.mockResolvedValue([
      { id: 1, ownerClientId: CLIENT,        validUntil: '2026-09-13T00:00:00Z' }, // expired, ours, unknown → delete
      { id: 2, ownerClientId: CLIENT,        validUntil: '2026-09-13T00:00:00Z' }, // expired, ours, known   → keep (Pass A owns it)
      { id: 3, ownerClientId: CLIENT,        validUntil: '2999-01-01T00:00:00Z' }, // still valid            → keep
      { id: 4, ownerClientId: 'client-other', validUntil: '2026-09-13T00:00:00Z' }, // another tenant         → keep
      { id: 5, ownerClientId: null,          validUntil: '2026-09-13T00:00:00Z' }, // operator's own link    → keep
    ]);
    hardwareAdapter.deleteGroupLink.mockResolvedValue(undefined);

    const result = await runDayPassSweep({ triggerSource: 'test' });

    expect(result.orphansDeleted).toBe(1);
    expect(hardwareAdapter.deleteGroupLink).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.deleteGroupLink).toHaveBeenCalledWith('kisi', 'kisi-key', 1, { clientId: CLIENT });
    // the known-ids lookup only asked about expired, owned candidates
    expect(db.query.mock.calls[2][1]).toEqual([CLIENT, ['1', '2']]);
  });

  test('a failed link listing skips the client without guessing', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ client_id: CLIENT, hardware_platform: 'kisi', hardware_api_key: 'enc' }] });
    hardwareAdapter.listGroupLinks.mockRejectedValue(Object.assign(new Error('bad page'), { code: 'KISI_PAGE_INTEGRITY' }));

    const result = await runDayPassSweep({ triggerSource: 'test' });
    expect(result.orphansDeleted).toBe(0);
    expect(hardwareAdapter.deleteGroupLink).not.toHaveBeenCalled();
  });
});

describe('[P3] day pass — static guards', () => {
  const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('day-pass-sweep.js writes no member_access* table (DR-023 — L3 owns them)', () => {
    const src = read('core/day-pass-sweep.js');
    expect(src).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+member_access/);
    expect(src).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+member_master/);
  });

  test('reconcile Pass 1 promotion UPDATE excludes day_pass mappings', () => {
    const src = read('core/reconciliation.js');
    const promotion = src.slice(src.indexOf("SET status = 'active', updated_at = NOW()"));
    expect(promotion.slice(0, 900)).toMatch(/COALESCE\(pm\.access_type, 'group'\) <> 'day_pass'/);
    expect(src).toMatch(/reconciliation\.day_pass_plan_skipped/);
  });

  test('queue-worker branches to the day-pass path before resolveIdentity on both grant paths', () => {
    const src = read('core/queue-worker.js');
    const startedBranch = src.indexOf("lastStep = 'grant.started.day_pass'");
    const startedIdent  = src.indexOf("lastStep = 'grant.started.resolve_identity'");
    const mainBranch    = src.indexOf("lastStep = 'grant.day_pass'");
    const mainIdent     = src.indexOf("lastStep = 'grant.resolve_identity'");
    expect(startedBranch).toBeGreaterThan(-1);
    expect(startedBranch).toBeLessThan(startedIdent);
    expect(mainBranch).toBeGreaterThan(-1);
    expect(mainBranch).toBeLessThan(mainIdent);
  });

  test('plan-mapping remap query excludes day_pass rows (never DELETE /role_assignments/<groupLinkId>)', () => {
    const src = read('admin/routes/operator.js');
    const remap = src.slice(src.indexOf('Fetch all member source rows for this mapping in the old groups'));
    expect(remap.slice(0, 900)).toMatch(/mas\.source_type <> 'day_pass'/);
  });

  test('log-redaction covers every bearer-credential field a group link carries', () => {
    const { SENSITIVE_FIELDS } = jest.requireActual('../../core/log-redaction');
    for (const f of ['secret', 'linkUrl', 'link', 'share_url', 'qrToken', 'quick_response_code_token', 'qrImageBase64', 'quick_response_code_image']) {
      expect(SENSITIVE_FIELDS.has(f)).toBe(true);
    }
  });
});
