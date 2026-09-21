/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — ONBOARDING                                                │
 * │  Scenario: the day-pass email carries each QR code twice (OB-98)        │
 * │                                                                         │
 * │  Business consequence: the email IS the credential. Two live findings:  │
 * │    - 2026-09-18: the QR arrived as an attachment with a broken image in │
 * │      the body — the Resend API reads content_id, the 3.x SDK forwards   │
 * │      contentId untranslated.                                            │
 * │    - 2026-09-21 (Builder): a buyer of several passes hands them to      │
 * │      other people, and a mail client hides an inline image from the     │
 * │      attachment list — so each code must ALSO be an ordinary file.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const mockSend = jest.fn();
jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: mockSend } })) }));
jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/trace-context', () => ({ getTraceId: jest.fn(() => 'trace-mail-1') }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const db     = require('../../db');
const mailer = require('../../core/member-mailer');

const link = (n) => ({
  mappingId: 'map-1', hardwareGroupId: 'g-1', groupLinkId: 900 + n,
  qrImageBase64: 'QUJD', qrImageMime: 'image/png', linkUrl: 'https://kisi.example/l/' + n,
  validFrom: null, validUntil: new Date(Date.now() + 24 * 3600_000).toISOString(),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ data: { id: 'resend-1' } });
  db.query.mockImplementation(async (sql) => {
    if (/FROM member_access ma JOIN member_master/.test(sql)) return { rows: [{ member_master_id: 'mm-1', email: 'buyer@example.com', first_name: 'Daxx' }] };
    if (/FROM plan_mappings/.test(sql))  return { rows: [{ door_name: 'Entrance Door' }] };
    if (/FROM clients/.test(sql))        return { rows: [{ name: 'House of Gains', notification_email: 'gym@example.com', member_emails_enabled: false }] };
    if (/INSERT INTO member_email_log/.test(sql)) return { rows: [{ id: 'log-1' }] };
    return { rows: [], rowCount: 1 };
  });
});

const send = (links) => mailer.maybeSendDayPassEmail({
  clientId: 'client-1', accessId: 'access-1', links, recipientEmail: 'buyer@example.com',
  standardEvent: { planId: 'prod-1', planName: '1-Day Pass', wixOrderId: 'order-1' }, eventKey: 'order-1:u1',
});

describe('[P2] day-pass email — QR attachments', () => {
  test('one pass: an inline copy (content_id) AND a plain file copy', async () => {
    expect(await send([link(1)])).toMatchObject({ sent: true });
    const { attachments, html } = mockSend.mock.calls[0][0];

    const inline = attachments.filter(a => a.content_id);
    const files  = attachments.filter(a => !a.content_id && !a.contentId);
    expect(inline).toHaveLength(1);
    expect(files).toHaveLength(1);
    expect(inline[0]).toMatchObject({ content_id: 'daypassqr1', content_type: 'image/png', content: 'QUJD' });
    expect(files[0]).toMatchObject({ filename: 'Day-Pass-QR-Code.png', content: 'QUJD' });
    expect(html).toContain('cid:daypassqr1');
  });

  test('three passes: three inline + three files, each file named for its pass', async () => {
    await send([link(1), link(2), link(3)]);
    const { attachments, html } = mockSend.mock.calls[0][0];

    expect(attachments.filter(a => a.content_id).map(a => a.content_id)).toEqual(['daypassqr1', 'daypassqr2', 'daypassqr3']);
    expect(attachments.filter(a => !a.content_id).map(a => a.filename)).toEqual([
      'Day-Pass-1-of-3-QR-Code.png', 'Day-Pass-2-of-3-QR-Code.png', 'Day-Pass-3-of-3-QR-Code.png',
    ]);
    expect(html).toContain('Pass 2 of 3');
    expect(html).toContain('started when you bought them and end at the same time');
  });

  test('QR only: the Kisi access link never appears when a QR image exists', async () => {
    await send([link(1)]);
    const { html, text } = mockSend.mock.calls[0][0];
    expect(html).not.toContain('kisi.example');
    expect(text).not.toContain('kisi.example');
  });
});
