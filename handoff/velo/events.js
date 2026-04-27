/**
 * Velo backend code — AccessSync webhook forwarder
 *
 * Paste this into your Wix site's Velo backend as "events.js".
 * It listens for pricing plan, bookings, and member events and
 * forwards them to AccessSync so members get door access automatically.
 *
 * Setup (one-time):
 *   1. In Wix Editor, click Dev Mode in the top menu bar to enable it
 *   2. Go to Dashboard → Developer Tools → Secrets Manager and add:
 *        Name:  accesssync_webhook_secret
 *        Value: a secure random string (32+ characters)
 *      Then share this same secret with your AccessSync admin.
 *   3. In the left panel, click Backend → + New File → name it events.js
 *      (If events.js already exists, replace its contents entirely)
 *   4. Replace {{CLIENT_ID}} below with your AccessSync client ID
 *      (found in your AccessSync onboarding confirmation or dashboard)
 *   5. Save and publish
 *
 * After publishing, every plan purchase, cancellation, and member deletion
 * on your Wix site will automatically signal AccessSync within seconds.
 */

import { fetch } from 'wix-fetch';
import { getSecret } from 'wix-secrets-backend';
import { createHmac } from 'crypto';

const CORE_ENGINE_URL = 'https://accesssync-production.up.railway.app/webhooks/wix';
const CLIENT_ID = '{{CLIENT_ID}}'; // ← Replace with your AccessSync client ID

async function _send(eventType, data) {
  try {
    const secret = await getSecret('accesssync_webhook_secret');
    const payload = { eventType, data };
    const body = JSON.stringify(payload);
    const sig = createHmac('sha256', secret).update(body).digest('base64');
    await fetch(CORE_ENGINE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-wix-signature': sig,
        'x-accesssync-client-id': CLIENT_ID,
      },
      body,
    });
  } catch (e) { console.error('AccessSync webhook error:', e); }
}

// Pricing Plans — grant and revoke triggers
export function wixPricingPlans_onOrderPurchased(event)        { return _send('wixPricingPlans.orderPurchased', event); }
export function wixPricingPlans_onOrderStarted(event)          { return _send('wixPricingPlans.orderStarted', event); }
export function wixPricingPlans_onOrderCanceled(event)         { return _send('wixPricingPlans.orderCanceled', event); }
export function wixPricingPlans_onOrderAutoRenewCanceled(event){ return _send('wixPricingPlans.orderAutoRenewCanceled', event); }
export function wixPricingPlans_onOrderEnded(event)            { return _send('wixPricingPlans.orderEnded', event); }
export function wixPricingPlans_onOrderUpdated(event)          { return _send('wixPricingPlans.orderUpdated', event); }

// Bookings — confirmation and cancellation
export function wixBookings_onBookingConfirmed(event)          { return _send('wixBookings.bookingConfirmed', event); }
export function wixBookings_onBookingCanceled(event)           { return _send('wixBookings.bookingCanceled', event); }

// Members — clean up access on account deletion
export function wixMembers_onMemberDeleted(event)              { return _send('wixMembers.memberDeleted', event); }
