/**
 * simulate.js
 * Run this with `node simulate.js` to test the integrated flow!
 */

// We mock the environment variables to simulate an active server
process.env.WIX_WEBHOOK_SECRET = 'secret123';
process.env.KISI_API_KEY_MOCK = 'live-kisi-key';
process.env.DEFAULT_TENANT_ID = 'tenant-daxx-001';

const crypto = require('crypto');
const wixAdapter = require('./adapters/wix-adapter');
const webhookProcessor = require('./core/webhook-processor');
const grantRevoke = require('./core/grant-revoke');
const kisiAdapter = require('./adapters/kisi-adapter');

// Optional: We can mock fetch natively from node v18+ to see standard stdout
global.fetch = async (url, options) => {
  console.log(`[HTTP MOCK -> Kisi API] ${options.method} ${url}`);
  if (options.body) console.log(`[HTTP MOCK BODY] ${options.body}`);
  
  // Return a mock fetch response to prevent actual network failures
  return {
    ok: true,
    status: 200,
    json: async () => {
      if (options.method === 'POST' && url.includes('role_assignments')) return { id: 'mock_role_123' };
      if (options.method === 'POST' && url.includes('users')) return { id: 'mock_kisi_user_456' };
      if (options.method === 'GET' && url.includes('users')) return { id: null }; // Force user creation routing
      return {};
    }
  };
};

async function runSimulation() {
  console.log('--- STARTING ACCESSSYNC FLOW SIMULATION ---\n');

  // Create a mock Wix Webhook Payload for Plan Purchased
  const rawPayload = JSON.stringify({
    eventType: 'plan.purchased',
    memberId: 'wix-member-daxx',
    planId: 'monthly-access-plan',
    email: 'daxx@example.com',
    name: 'Daxx R'
  });

  // Generate the valid HMAC SHA-256 signature
  const hmac = crypto.createHmac('sha256', process.env.WIX_WEBHOOK_SECRET);
  hmac.update(rawPayload, 'utf8');
  const validSignature = hmac.digest('base64');

  // Mock an Express Request
  const mockReq = {
    body: rawPayload,
    headers: {
      'x-wix-signature': validSignature,
      'x-wix-event-id': `event_${Date.now()}`
    }
  };

  // Mock an Express Response
  const mockRes = {
    status: (code) => {
       console.log(`[Wix Adapter] Handled Webhook Request -> Responded with HTTP ${code}`);
       return { send: (msg) => console.log(`[Wix Adapter] Response Body: ${msg}\n`) };
    }
  };

  // Step 1: Fire the Webhook into the Adapter (Simulate arriving from the internet)
  console.log('--- STEP 1: Wix fires webhook into /webhooks/wix ---\n');
  await wixAdapter.handleWebhook(mockReq, mockRes);

  console.log('\n--- SIMULATION COMPLETE ---');
}

runSimulation();
