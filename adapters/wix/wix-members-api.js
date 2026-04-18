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

const WIX_API_BASE = 'https://www.wixapis.com';

/**
 * Authenticated Wix REST request. Mirrors the pattern in wix-plans-api.js so the two
 * files stay independent — no cross-import surface expansion for what's a 5-line helper.
 */
async function wixFetch(path, apiKey, siteId, options = {}) {
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
 * Note on synthetic emails: Wix sometimes issues placeholder `<uuid>@users.wix.com`
 * emails for members who signed up via social login. These are technically valid and
 * unique — caller decides whether to treat them as recoverable identity or reject.
 */
async function getMemberById(apiKey, siteId, platformMemberId) {
  try {
    const data = await wixFetch(`/members/v1/members/${platformMemberId}`, apiKey, siteId);
    const m = data.member;
    if (!m) {
      log.warn('wix.member.empty_response', { platformMemberId });
      return null;
    }

    const firstName = m.contact?.firstName || null;
    const lastName  = m.contact?.lastName  || null;
    const composed  = [firstName, lastName].filter(Boolean).join(' ').trim() || null;

    const result = {
      memberId:  m.id || platformMemberId,
      email:     m.loginEmail || m.contact?.emails?.[0] || null,
      firstName,
      lastName,
      name:      composed,
      status:    m.status || null,
    };

    log.info('wix.member.resolved', {
      platformMemberId,
      emailPresent: !!result.email,
      namePresent:  !!result.name,
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
