'use strict';

/**
 * Gym branding for the member-facing Access Hub (GET /member-hub).
 *
 * A member lands on the hub from their gym's Wix site; the gym is the ?clientId=
 * on the link. The hub shows that gym's logo bar and a "Back to {gym}" link to
 * the gym's own site (Builder 2026-10-05). One visit is always one gym — a person
 * who belongs to two gyms reaches each gym's hub from that gym's site.
 *
 * The back link's address only ever comes from the gym's clients row, never from
 * the request (WARD 2026-10-05): https only, no user:pass@ (lookalike hosts), a
 * real dotted host, query and fragment dropped. Archived or inactive gyms get no
 * link. Colors reuse the email rules so the hub and the emails agree.
 */

const { brandingFromClientRow, linkOnWhite, textOn } = require('./email-templates');

// The gym's site address, or null when it isn't safe to link to.
function safeSiteUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try { u = new URL(raw.trim()); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname.includes('.')) return null;
  return u.origin + u.pathname;
}

/**
 * @param {Object|undefined} row clients row: name, email_logo_url, email_primary_color,
 *   email_secondary_color, source_site_url, status, archived_at
 * @returns {Object} template fields; all null when the gym is unknown (the page then
 *   shows the plain AccessSync mark, never a made-up "Your gym" band)
 */
function hubBranding(row) {
  if (!row) {
    return { gymName: null, logoUrl: null, primaryColor: null, secondaryColor: null,
             buttonColor: null, barText: null, siteUrl: null };
  }
  const b = brandingFromClientRow(row);
  const live = row.status === 'active' && !row.archived_at;
  return {
    gymName:        b.gymName,
    logoUrl:        b.logoUrl,
    primaryColor:   b.primaryColor,
    secondaryColor: b.secondaryColor,
    // Download/primary-button fill: a gym color white text reads on, never a pale accent.
    buttonColor:    linkOnWhite(b),
    // Text on the gym's bar: near-black or white, whichever reads on their primary.
    barText:        textOn(b.primaryColor),
    siteUrl:        live ? safeSiteUrl(row.source_site_url) : null,
  };
}

module.exports = { safeSiteUrl, hubBranding };
