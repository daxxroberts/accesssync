/**
 * @file snippet-registry.js
 * @layer core
 * @role snippet-template-source
 * @reads core/SNIPPET_REGISTRY.json
 * @exports getRegistry, getSnippet, renderSnippet, listSnippets, validateEnv
 * @ob OB-237 Phase A
 *
 * Single source of truth for Wix-side snippet templates. Replaces hardcoded
 * EJS string literals previously scattered between onboard.ejs and locations.ejs.
 *
 * Templates use {{CLIENT_ID}}, {{CORE_ENGINE_URL}}, {{ADMIN_HUB_URL}}, {{VERSION}}.
 * Rendering is server-side only; client never sees the raw template.
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, 'SNIPPET_REGISTRY.json');

let _cache = null;

function getRegistry() {
  if (_cache) return _cache;
  const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  _cache = JSON.parse(raw);
  return _cache;
}

function listSnippets() {
  return getRegistry().snippets.map(s => ({
    id: s.id,
    name: s.name,
    display_group: s.display_group || s.id, // OB-238 followup — group adjacent cards
    category: s.category,
    criticality: s.criticality,
    description: s.description,
    wix_install_path: s.wix_install_path,
    current_version: s.current_version,
    required_env_vars: s.required_env_vars,
    verify_via: s.verify_via,
    stale_after_days: s.stale_after_days,
    instructions: s.instructions,
  }));
}

function getSnippet(id) {
  return getRegistry().snippets.find(s => s.id === id) || null;
}

function validateEnv(snippet) {
  const missing = [];
  for (const varName of snippet.required_env_vars || []) {
    if (!process.env[varName]) missing.push(varName);
  }
  return missing;
}

function renderSnippet(id, { clientId } = {}) {
  const snippet = getSnippet(id);
  if (!snippet) return { error: 'snippet_not_found' };

  const missing = validateEnv(snippet);
  if (missing.length) return { error: 'missing_env_vars', missing };

  if (!clientId) return { error: 'missing_client_id' };

  const coreEngineUrl = (process.env.CORE_ENGINE_URL || '').replace(/\/$/, '');
  const adminHubUrl   = (process.env.ADMIN_HUB_URL   || coreEngineUrl).replace(/\/$/, '');

  const body = snippet.template
    .replace(/\{\{CLIENT_ID\}\}/g, clientId)
    .replace(/\{\{CORE_ENGINE_URL\}\}/g, coreEngineUrl)
    .replace(/\{\{ADMIN_HUB_URL\}\}/g, adminHubUrl)
    .replace(/\{\{VERSION\}\}/g, snippet.current_version);

  return { id, name: snippet.name, version: snippet.current_version, body };
}

function _clearCache() { _cache = null; }

module.exports = {
  getRegistry,
  listSnippets,
  getSnippet,
  validateEnv,
  renderSnippet,
  _clearCache,
};
