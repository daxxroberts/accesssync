/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — ONBOARDING                                                │
 * │  Scenario: a day pass is a HARDWARE capability (guest QR credential)    │
 * │                                                                         │
 * │  Business consequence: an operator on a connector that cannot mint a    │
 * │  guest QR could switch a plan to "day pass", and only find out when a   │
 * │  paying guest received nothing. The capability is answered from the     │
 * │  adapter's own methods, so it cannot drift from what the adapter does.  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const hardwareAdapter = require('../../adapters/hardware-adapter');

describe('[P2] day pass capability — hardwareAdapter.supportsDayPass', () => {
  test('kisi can mint a day pass', () => {
    expect(hardwareAdapter.supportsDayPass('kisi')).toBe(true);
  });

  test('seam (stub, no group-link surface) cannot', () => {
    expect(hardwareAdapter.supportsDayPass('seam')).toBe(false);
  });

  test.each([['an unknown platform', 'brivo'], ['null', null], ['undefined', undefined], ['empty', '']])(
    '%s → false, never a throw', (_label, platform) => {
      expect(hardwareAdapter.supportsDayPass(platform)).toBe(false);
    }
  );

  test('the answer follows the adapter: createGroupLink still refuses cleanly on seam', async () => {
    await expect(
      hardwareAdapter.createGroupLink('seam', 'k', { groupId: 'g', clientId: 'c', validUntil: new Date().toISOString() })
    ).rejects.toMatchObject({ code: 'HARDWARE_UNSUPPORTED_OPERATION' });
  });
});
