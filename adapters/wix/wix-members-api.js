/**
 * wix-members-api.js
 * Outbound Wix Members API client — resolves a Wix member by platformMemberId.
 * Used by Layer 3 Gate 2 (OB-89) when a grant job arrives with null email.
 *
 * Requires: Wix API key stored encrypted in clients.source_api_key
 * Docs: https://dev.wix.com/docs/rest/api-reference/members
 *
 * On errors: throws so the caller can distinguish real failures from missing data.
 * Caller is responsible for choosing between retry, park, or dead-letter.
 */

const { log } = require('../../core/logger');
const { RateLimiter } = require('../../core/rate-limiter');

const WIX_API_BASE = 'https://www.wixapis.com';

// Shared limiter for this file. Wix documents a 10 req/sec REST cap.
// Module-scoped so every caller of getMemberById contends against the same bucket —
// critical for reconciliation runs that touch many orphans in rapid succession.
const limiter = new RateLimiter({ rate: 10, windowMs: 1000, name: 'wix-members' });

/**
 * Authenticated Wix REST request. Mirrors the pattern in wix-plans-api.js so the two
 * files stay independent — no cross-import surface expansion for what's a 5-line helper.
 * Awaits the shared rate limiter before every call.
 */
async function wixFetch(path, apiKey, siteId, options = {}) {
  await limiter.acquire();
  const url = `${WIX_API_BASE}${path}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
      'wix-site-id': siteId,
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Wix Members API ${res.status}: ${text.slice(0, 200)}`);
    err.statusCode = res.status;
    err.code = res.status === 404 ? 'WIX_MEMBER_NOT_FOUND'
             : res.status === 401 ? 'WIX_KEY_INVALID'
             : res.status === 403 ? 'WIX_KEY_PERMISSIONS'
             : 'WIX_API_ERROR';
    throw err;
  }
  return res.json();
}

/**
 * Get a single member by their Wix member ID.
 *
 * Response shape (verified against Wix docs 2026-04-17):
 *   {
 *     member: {
 *       id: '...',
 *       loginEmail: 'user@example.com',
 *       contact: { firstName, lastName, emails: [...] },
 *       status: 'ACTIVE' | 'PENDING' | 'BLOCKED' | 'OFFLINE',
 *       ...
 *     }
 *   }
 *
 * Returns a normalized object: { memberId, email, firstName, lastName, name, status }
 * or throws on API failure. Returns null only if the API returns 200 but the member
 * object is unexpectedly empty (shouldn't happen — but safe guard).
 *
 * Synthetic email handling (Builder decision 2026-04-17): Wix issues placeholder
 * `<uuid>@users.wix.com` emails for members who signed up via social login. These
 * are Wix-internal addresses the member cannot receive mail at — Kisi onboarding
 * invites sent to them would never be read. We treat them as equivalent to null so
 * Gate 2 falls through to tier 2 (DB cache) and ultimately parks as pending_identity
 * if no real address is found. The member waits for a future event that carries a
 * real email rather than getting access with an unreachable inbox.
 */
function _isSyntheticEmail(email) {
  if (!email) return false;
  return /@users\.wix\.com$/i.test(email);
}

/**
 * Collect all email candidates from a Contacts API contact object.
 * Returns [] if none present. Filtering of synthetic addresses happens at the caller.
 */
function _collectContactEmails(contact) {
  const primary = contact?.primaryInfo?.email || null;
  const items   = (contact?.info?.emails?.items || [])
    .map(item => item?.email)
    .filter(Boolean);
  // De-dupe while preserving order (primary first if present).
  const seen = new Set();
  const out  = [];
  for (const candidate of [primary, ...items]) {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Extract first/last name from a Contacts API contact object.
 * Falls back through: info.name, extendedFields displayByFirstName, profile nickname.
 */
function _extractName(contact, memberProfile) {
  const first = contact?.info?.name?.first || null;
  const last  = contact?.info?.name?.last  || null;
  if (first || last) {
    return {
      firstName: first,
      lastName:  last,
      name:      [first, last].filter(Boolean).join(' ').trim() || null,
    };
  }
  // Fallback: Contacts extendedFields
  const displayFirst = contact?.info?.extendedFields?.items?.['contacts.displayByFirstName'] || null;
  if (displayFirst) {
    const parts = displayFirst.trim().split(/\s+/);
    return {
      firstName: parts[0] || null,
      lastName:  parts.slice(1).join(' ') || null,
      name:      displayFirst,
    };
  }
  // Fallback: Members profile nickname (e.g. Google OAuth passes full name here)
  const nickname = memberProfile?.nickname || null;
  if (nickname) {
    const parts = nickname.trim().split(/\s+/);
    return {
      firstName: parts[0] || null,
      lastName:  parts.slice(1).join(' ') || null,
      name:      nickname,
    };
  }
  return { firstName: null, lastName: null, name: null };
}

/**
 * Fetch the Wix Contact record keyed by contactId.
 * Separate call because Wix's data model separates Members (membership/login state)
 * from Contacts (CRM/identity — email, phone, name, addresses). A single memberId
 * always points to exactly one contactId; the contact carries the deliverable fields.
 * Returns the contact object or null on 404. Throws on other errors.
 */
async function _getContactById(apiKey, siteId, contactId) {
  try {
    const data = await wixFetch(`/contacts/v4/contacts/${contactId}`, apiKey, siteId);
    return data.contact || null;
  } catch (err) {
    if (err.statusCode === 404) {
      log.warn('wix.contact.not_found', { contactId });
      return null;
    }
    throw err;
  }
}

async function getMemberById(apiKey, siteId, platformMemberId) {
  try {
    const memberData = await wixFetch(`/members/v1/members/${platformMemberId}`, apiKey, siteId);
    const m = memberData.member;
    if (!m) {
      log.warn('wix.member.empty_response', { platformMemberId });
      return null;
    }

    // Step 2 — follow the contactId pointer. Wix's Members API returns an
    // identity stub (id, status, contactId, profile.nickname). The deliverable
    // fields (email, phone, first/last name) live on the Contacts record.
    // Confirmed empirically 2026-04-18 against HOG member — Members response
    // had no email/name/contact fields at all; Contacts response had everything.
    let contact = null;
    if (m.contactId) {
      try {
        contact = await _getContactById(apiKey, siteId, m.contactId);
      } catch (err) {
        // Contact-fetch failure is recoverable — we can still return what the
        // Members API gave us (id, status, nickname). Caller decides.
        log.warn('wix.contact.fetch_failed', {
          platformMemberId,
          contactId: m.contactId,
          httpStatus: err.statusCode,
          code: err.code,
        });
      }
    }

    // Step 3 — collect email candidates from the Contacts record, then filter
    // synthetic @users.wix.com addresses. Order: Contacts primaryInfo.email,
    // then Contacts info.emails.items[]. Members API loginEmail field is
    // absent in the current response shape but kept here as a last-resort
    // candidate in case a future Wix response includes it.
    const contactEmails = _collectContactEmails(contact);
    const allCandidates = [...(m.loginEmail ? [m.loginEmail] : []), ...contactEmails];
    const realCandidates = allCandidates.filter(e => !_isSyntheticEmail(e));
    const email          = realCandidates[0] || null;
    const rejectedCount  = allCandidates.length - realCandidates.length;
    if (rejectedCount > 0) {
      log.warn('wix.member.synthetic_email_rejected', {
        platformMemberId,
        rejectedCount,
        rejectedDomains: allCandidates
          .filter(e => _isSyntheticEmail(e))
          .map(e => e.split('@')[1] || null),
        realFallbackUsed: !!email,
      });
    }

    // Step 4 — resolve name from Contacts, with fallbacks.
    const { firstName, lastName, name } = _extractName(contact, m.profile);

    const result = {
      memberId:  m.id || platformMemberId,
      contactId: m.contactId || null,
      email,
      firstName,
      lastName,
      name,
      phone:     contact?.primaryInfo?.phone || contact?.info?.phones?.items?.[0]?.phone || null,
      status:    m.status || null,
    };

    log.info('wix.member.resolved', {
      platformMemberId,
      contactId: result.contactId,
      emailPresent: !!result.email,
      namePresent:  !!result.name,
      phonePresent: !!result.phone,
      status:       result.status,
    });

    return result;
  } catch (err) {
    // Don't swallow — caller distinguishes "genuinely not found" (err.code === 'WIX_MEMBER_NOT_FOUND')
    // from transient API failure. Layer 3 Gate 2 decides whether to retry, fall back, or park.
    log.error('wix.member.lookup_failed', { platformMemberId, httpStatus: err.statusCode }, err);
    throw err;
  }
}

module.exports = { getMemberById };
