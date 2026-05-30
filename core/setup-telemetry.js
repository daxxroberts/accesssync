/**
 * @file setup-telemetry.js
 * @layer core
 * @role operator-setup-state-writer
 * @writes operator_setup_state
 * @exports recordSnippetTelemetry, recordTestResult
 * @ob OB-237 Phase C
 *
 * Single helper for upserting operator_setup_state rows from telemetry
 * sources (webhook version headers + iframe heartbeats + Test Connection
 * round-trips). Never throws — observability doctrine, DR-037.
 */

const db = require('../db');
const snippetRegistry = require('./snippet-registry');
const { log } = require('./logger');

/**
 * Record that a snippet was seen "live" on the Wix side.
 * Called from the Wix webhook receiver (velo_events_backend version header)
 * and from iframe heartbeat endpoints (sync_status_page / my_access_page).
 *
 * Transitions install_state to 'verified' when version_installed matches the
 * registry's current_version, 'stale' otherwise.
 */
async function recordSnippetTelemetry(clientId, snippetId, versionInstalled) {
  if (!clientId || !snippetId) return;

  const snippet = snippetRegistry.getSnippet(snippetId);
  if (!snippet) {
    log.warn('setup_telemetry.unknown_snippet_id', { clientId, snippetId });
    return;
  }

  const isCurrent = versionInstalled === snippet.current_version;
  const newState = isCurrent ? 'verified' : 'stale';

  try {
    await db.query(
      `INSERT INTO operator_setup_state
         (client_id, snippet_id, install_state, version_installed,
          last_telemetry_at, last_telemetry_version, last_verified_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), $4, $5, NOW())
       ON CONFLICT (client_id, snippet_id) DO UPDATE
         SET install_state = $3,
             version_installed = EXCLUDED.version_installed,
             last_telemetry_at = NOW(),
             last_telemetry_version = EXCLUDED.last_telemetry_version,
             last_verified_at = COALESCE($5, operator_setup_state.last_verified_at),
             updated_at = NOW()`,
      [clientId, snippetId, newState, versionInstalled, isCurrent ? new Date() : null]
    );
  } catch (err) {
    log.error('setup_telemetry.record_failed', { clientId, snippetId, versionInstalled }, err);
  }
}

/**
 * Record a Test Connection result.
 *
 * @param {string} clientId
 * @param {string} snippetId
 * @param {string} result      — result code string (e.g. 'ok', 'evidence_without_version', 'no_heartbeat')
 * @param {string} [newState]  — install_state to set ('verified', 'installed_unverified', 'stale', 'broken').
 *                                If omitted, install_state is preserved (only updates test fields).
 */
async function recordTestResult(clientId, snippetId, result, newState) {
  if (!clientId || !snippetId) return;
  try {
    if (newState) {
      // Set install_state explicitly + record test fields
      await db.query(
        `INSERT INTO operator_setup_state
           (client_id, snippet_id, install_state, last_test_at, last_test_result, updated_at)
         VALUES ($1, $2, $3, NOW(), $4, NOW())
         ON CONFLICT (client_id, snippet_id) DO UPDATE
           SET install_state = $3,
               last_test_at = NOW(),
               last_test_result = EXCLUDED.last_test_result,
               updated_at = NOW()`,
        [clientId, snippetId, newState, result]
      );
    } else {
      // Don't change install_state — only record test fields
      await db.query(
        `INSERT INTO operator_setup_state
           (client_id, snippet_id, install_state, last_test_at, last_test_result, updated_at)
         VALUES ($1, $2, 'not_installed', NOW(), $3, NOW())
         ON CONFLICT (client_id, snippet_id) DO UPDATE
           SET last_test_at = NOW(),
               last_test_result = EXCLUDED.last_test_result,
               updated_at = NOW()`,
        [clientId, snippetId, result]
      );
    }
  } catch (err) {
    log.error('setup_telemetry.test_result_failed', { clientId, snippetId, result }, err);
  }
}

module.exports = { recordSnippetTelemetry, recordTestResult };
