/**
 * fixtures.js
 * Test fixtures for AccessSync business scenario tests.
 *
 * Fixtures are named after business scenarios, not data structures.
 * Read these like a business spec: "a member who just paid for the Connect plan at HOG".
 */

// ─── Tenant / Client ────────────────────────────────────────────────────────

const HOG_CLIENT_ID = 'client-hog-001';
const HOG_LOCATION_ID = 'location-hog-main-001';

// ─── Wix Plan IDs ───────────────────────────────────────────────────────────

const CONNECT_PLAN_ID = 'wix-plan-connect-001';
const PRO_PLAN_ID     = 'wix-plan-pro-001';

// ─── Kisi ───────────────────────────────────────────────────────────────────

const KISI_GROUP_ID          = 'kisi-group-all-doors';
const KISI_API_KEY_PLAINTEXT = 'test-kisi-api-key-do-not-use-in-prod';
const KISI_HARDWARE_USER_ID  = 'kisi-user-456';
const KISI_ROLE_ASSIGNMENT_ID = 'kisi-role-assignment-001';

// ─── Member identities ──────────────────────────────────────────────────────

const MEMBER_INTERNAL_ID  = 'member-internal-uuid-001';  // member_identity.id (our DB)
const WIX_MEMBER_ID       = 'wix-member-external-abc';   // platformMemberId from Wix

// ─── Wix Webhook Payloads ───────────────────────────────────────────────────
// These match the structure that wix-adapter.parseEvent() reads.
// See adapters/wix/wix-adapter.js for full resolution chain (P6 fix applied).

const wixPlanPurchasedPayload = {
  data: {
    order: {
      buyer: {
        memberId: WIX_MEMBER_ID,
        email:    'chad@houseofgains.com',
        fullName: 'Chad Member',
      },
      planId: CONNECT_PLAN_ID,
    }
  }
};

const wixPlanCancelledPayload = {
  data: {
    order: {
      buyer: { memberId: WIX_MEMBER_ID },
      planId: CONNECT_PLAN_ID,
    }
  }
};

const wixPaymentFailedPayload = {
  data: {
    order: {
      buyer: { memberId: WIX_MEMBER_ID },
      planId: CONNECT_PLAN_ID,
    }
  }
};

const wixMemberDeletedPayload = {
  data: {
    member: { _id: WIX_MEMBER_ID }
  }
};

// ─── Standard Events (post wix-adapter.parseEvent()) ────────────────────────
// These are what queue-worker receives after wix-connector → wix-adapter transforms the webhook.

const planPurchasedEvent = {
  eventType:        'plan.purchased',
  wixSiteId:        'wix-site-hog-001',
  sourcePlatform:   'wix',
  platformMemberId: WIX_MEMBER_ID,
  planId:           CONNECT_PLAN_ID,
  email:            'chad@houseofgains.com',
  name:             'Chad Member',
  timestamp:        '2026-04-01T10:00:00.000Z',
  rawPayload:       wixPlanPurchasedPayload,
};

const planCancelledEvent = {
  eventType:        'plan.cancelled',
  wixSiteId:        'wix-site-hog-001',
  sourcePlatform:   'wix',
  platformMemberId: WIX_MEMBER_ID,
  planId:           CONNECT_PLAN_ID,
  email:            'chad@houseofgains.com',
  name:             'Chad Member',
  timestamp:        '2026-04-01T11:00:00.000Z',
  rawPayload:       wixPlanCancelledPayload,
};

const paymentFailedEvent = {
  eventType:        'payment.failed',
  wixSiteId:        'wix-site-hog-001',
  sourcePlatform:   'wix',
  platformMemberId: WIX_MEMBER_ID,
  planId:           CONNECT_PLAN_ID,
  timestamp:        '2026-04-01T12:00:00.000Z',
  rawPayload:       wixPaymentFailedPayload,
};

const paymentRecoveredEvent = {
  eventType:        'payment.recovered',
  wixSiteId:        'wix-site-hog-001',
  sourcePlatform:   'wix',
  platformMemberId: WIX_MEMBER_ID,
  planId:           CONNECT_PLAN_ID,
  timestamp:        '2026-04-01T13:00:00.000Z',
  rawPayload:       wixPaymentFailedPayload,
};

// ─── Plan Mappings (returned by plan-mapping-resolver.resolve()) ─────────────
// These are the RESOLVED mappings — apiKey is already decrypted plaintext.

const activeMappings = [
  {
    mappingId:       'plan-mapping-connect-doors',
    hardwareGroupId: KISI_GROUP_ID,
    hardwarePlatform:'kisi',
    tierName:        'Connect',
    accessType:      'group',
    apiKey:          KISI_API_KEY_PLAINTEXT,  // Already decrypted (done by resolver)
  }
];

const activeMappingsMultiDoor = [
  {
    mappingId:       'plan-mapping-connect-front',
    hardwareGroupId: 'kisi-group-front-door',
    hardwarePlatform:'kisi',
    tierName:        'Connect',
    accessType:      'group',
    apiKey:          KISI_API_KEY_PLAINTEXT,
  },
  {
    mappingId:       'plan-mapping-connect-gym',
    hardwareGroupId: 'kisi-group-gym-floor',
    hardwarePlatform:'kisi',
    tierName:        'Connect',
    accessType:      'group',
    apiKey:          KISI_API_KEY_PLAINTEXT,
  }
];

// ─── DB row: encrypted API key (stored in clients.hardware_api_key, DR-035) ──
// The actual encrypted format is iv:tag:ciphertext but in tests we mock decryptApiKey,
// so this value just needs to be non-null to pass the "key exists" check.
const ENCRYPTED_API_KEY_DB_VALUE = 'aabbcc:ddeeff:112233';

module.exports = {
  HOG_CLIENT_ID,
  HOG_LOCATION_ID,
  CONNECT_PLAN_ID,
  PRO_PLAN_ID,
  KISI_GROUP_ID,
  KISI_API_KEY_PLAINTEXT,
  KISI_HARDWARE_USER_ID,
  KISI_ROLE_ASSIGNMENT_ID,
  MEMBER_INTERNAL_ID,
  WIX_MEMBER_ID,
  ENCRYPTED_API_KEY_DB_VALUE,

  // Payloads
  wixPlanPurchasedPayload,
  wixPlanCancelledPayload,
  wixPaymentFailedPayload,
  wixMemberDeletedPayload,

  // Standard events (post-adapter)
  planPurchasedEvent,
  planCancelledEvent,
  paymentFailedEvent,
  paymentRecoveredEvent,

  // Mappings
  activeMappings,
  activeMappingsMultiDoor,
};
