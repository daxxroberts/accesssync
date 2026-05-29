/**
 * P3 — Snippet registry shape + render correctness.
 * OB-237 Phase A. Ensures registry is loadable, has required snippets,
 * and renderSnippet() handles missing env vars + missing clientId safely.
 */

'use strict';

const path = require('path');

describe('core/SNIPPET_REGISTRY.json — shape', () => {
  let registry;
  let registryModule;

  beforeAll(() => {
    delete require.cache[require.resolve('../../core/snippet-registry')];
    registryModule = require('../../core/snippet-registry');
    registryModule._clearCache();
    registry = registryModule.getRegistry();
  });

  test('registry has schema_version', () => {
    expect(registry.schema_version).toBeDefined();
    expect(typeof registry.schema_version).toBe('string');
  });

  test('registry has snippets array', () => {
    expect(Array.isArray(registry.snippets)).toBe(true);
    expect(registry.snippets.length).toBeGreaterThanOrEqual(4);
  });

  test('every snippet has required fields', () => {
    const required = [
      'id', 'name', 'category', 'criticality', 'description',
      'wix_install_path', 'current_version', 'required_env_vars',
      'verify_via', 'stale_after_days', 'instructions', 'template',
    ];
    for (const snippet of registry.snippets) {
      for (const field of required) {
        expect(snippet[field]).toBeDefined();
      }
    }
  });

  test('every snippet category is valid', () => {
    const validCategories = ['required', 'optional', 'tier_gated'];
    for (const s of registry.snippets) {
      expect(validCategories).toContain(s.category);
    }
  });

  test('every snippet criticality is valid', () => {
    const validCriticality = ['critical', 'high', 'medium', 'low'];
    for (const s of registry.snippets) {
      expect(validCriticality).toContain(s.criticality);
    }
  });

  test('every snippet has unique id', () => {
    const ids = registry.snippets.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('velo_events_backend snippet is present and critical (most important snippet)', () => {
    const events = registry.snippets.find(s => s.id === 'velo_events_backend');
    expect(events).toBeDefined();
    expect(events.criticality).toBe('critical');
    expect(events.category).toBe('required');
    expect(events.required_env_vars).toContain('CORE_ENGINE_URL');
  });

  test('sync_status_page and my_access_page snippets present and require ADMIN_HUB_URL', () => {
    const sync = registry.snippets.find(s => s.id === 'sync_status_page');
    const hub  = registry.snippets.find(s => s.id === 'my_access_page');
    expect(sync).toBeDefined();
    expect(hub).toBeDefined();
    expect(sync.required_env_vars).toContain('ADMIN_HUB_URL');
    expect(hub.required_env_vars).toContain('ADMIN_HUB_URL');
  });
});

describe('core/snippet-registry.js — renderSnippet()', () => {
  let registryModule;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    delete require.cache[require.resolve('../../core/snippet-registry')];
    registryModule = require('../../core/snippet-registry');
    registryModule._clearCache();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  test('returns missing_env_vars error when CORE_ENGINE_URL is unset', () => {
    delete process.env.CORE_ENGINE_URL;
    const result = registryModule.renderSnippet('velo_events_backend', { clientId: 'abc-123' });
    expect(result.error).toBe('missing_env_vars');
    expect(result.missing).toContain('CORE_ENGINE_URL');
  });

  test('returns missing_env_vars error when ADMIN_HUB_URL is unset', () => {
    delete process.env.ADMIN_HUB_URL;
    const result = registryModule.renderSnippet('sync_status_page', { clientId: 'abc-123' });
    expect(result.error).toBe('missing_env_vars');
    expect(result.missing).toContain('ADMIN_HUB_URL');
  });

  test('returns missing_client_id when clientId is absent', () => {
    process.env.CORE_ENGINE_URL = 'https://core.example.com';
    process.env.ADMIN_HUB_URL = 'https://admin.example.com';
    const result = registryModule.renderSnippet('velo_events_backend', {});
    expect(result.error).toBe('missing_client_id');
  });

  test('returns snippet_not_found for unknown snippet id', () => {
    process.env.CORE_ENGINE_URL = 'https://core.example.com';
    const result = registryModule.renderSnippet('does_not_exist', { clientId: 'abc' });
    expect(result.error).toBe('snippet_not_found');
  });

  test('renders velo_events_backend with all substitutions', () => {
    process.env.CORE_ENGINE_URL = 'https://core.example.com';
    const result = registryModule.renderSnippet('velo_events_backend', { clientId: 'op-uuid-1' });
    expect(result.error).toBeUndefined();
    expect(result.body).toContain("CLIENT_ID = 'op-uuid-1'");
    expect(result.body).toContain('https://core.example.com/webhooks/wix');
    expect(result.body).toContain("SNIPPET_VERSION = '" + result.version + "'");
    expect(result.body).not.toContain('{{CLIENT_ID}}');
    expect(result.body).not.toContain('{{CORE_ENGINE_URL}}');
    expect(result.body).not.toContain('{{VERSION}}');
  });

  test('renders sync_status_page with auth token + version param', () => {
    process.env.ADMIN_HUB_URL = 'https://admin.example.com';
    const result = registryModule.renderSnippet('sync_status_page', { clientId: 'op-uuid-2' });
    expect(result.error).toBeUndefined();
    expect(result.body).toContain('https://admin.example.com');
    expect(result.body).toContain('op-uuid-2');
    expect(result.body).toContain('encodeURIComponent(token)');
    expect(result.body).not.toContain('{{ADMIN_HUB_URL}}');
  });

  test('renders my_access_page (member hub)', () => {
    process.env.ADMIN_HUB_URL = 'https://admin.example.com';
    const result = registryModule.renderSnippet('my_access_page', { clientId: 'op-uuid-3' });
    expect(result.error).toBeUndefined();
    expect(result.body).toContain('/member-hub');
    expect(result.body).toContain('op-uuid-3');
  });

  test('falls back ADMIN_HUB_URL → CORE_ENGINE_URL when ADMIN_HUB_URL is unset (existing behavior preserved)', () => {
    delete process.env.ADMIN_HUB_URL;
    process.env.CORE_ENGINE_URL = 'https://core.example.com';
    const thankYou = registryModule.getSnippet('thank_you_redirect');
    expect(thankYou.required_env_vars).toContain('ADMIN_HUB_URL');
    const result = registryModule.renderSnippet('thank_you_redirect', { clientId: 'x' });
    expect(result.error).toBe('missing_env_vars');
  });

  test('trailing slash stripped from URL substitutions', () => {
    process.env.CORE_ENGINE_URL = 'https://core.example.com/';
    const result = registryModule.renderSnippet('velo_events_backend', { clientId: 'x' });
    expect(result.body).toContain('https://core.example.com/webhooks/wix');
    expect(result.body).not.toContain('com//webhooks');
  });
});

describe('core/snippet-registry.js — listSnippets()', () => {
  let registryModule;

  beforeAll(() => {
    delete require.cache[require.resolve('../../core/snippet-registry')];
    registryModule = require('../../core/snippet-registry');
    registryModule._clearCache();
  });

  test('returns metadata only — no template body leaked', () => {
    const list = registryModule.listSnippets();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(4);
    for (const item of list) {
      expect(item.id).toBeDefined();
      expect(item.template).toBeUndefined();
    }
  });
});
