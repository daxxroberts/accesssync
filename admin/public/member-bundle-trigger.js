/**
 * member-bundle-trigger.js
 * Self-contained helper that any UI surface (Members page row menu, member
 * drawer header, member incident drawer) can call to fetch a member bundle,
 * copy it to the clipboard, and offer the optional ✓/✗ log-stub follow-up.
 *
 * No dependencies. Browser global: window.triggerMemberBundle(memberId).
 *
 * Two-step flow:
 *   1. Fetch /admin/logs/bundle/member/<id>
 *   2. Copy bundle text to clipboard (immediate)
 *   3. Show a small modal asking "log this for the AI review team?"
 *      ✓ → copy the stub text to clipboard so Daxx can paste it into
 *           AccessSync/00_Vault_Control/bundle_gap_log.md
 *      ✗ → close, no log
 */
(function () {
  'use strict';

  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand failed'));
      } catch (e) { reject(e); }
    });
  }

  function showStubDialog(bundleResp) {
    var existing = document.getElementById('mbt-dialog');
    if (existing) existing.remove();
    var d = document.createElement('div');
    d.id = 'mbt-dialog';
    d.style.cssText = 'position:fixed;inset:0;background:rgba(15,25,35,0.45);backdrop-filter:blur(2px);z-index:9050;display:flex;align-items:center;justify-content:center;font-family:Sora,sans-serif';
    d.innerHTML = [
      '<div style="background:#fff;border:1px solid #E2E5EA;border-radius:10px;padding:18px 20px;width:480px;max-width:92vw;color:#1A2130">',
      '  <div style="font-size:14px;font-weight:600;margin-bottom:6px">Bundle copied to clipboard</div>',
      '  <div style="font-size:11.5px;color:#4A5568;margin-bottom:14px;line-height:1.5">' +
           (bundleResp.chars ? bundleResp.chars.toLocaleString() : '?') +
           ' characters · ' + (bundleResp.trace_count || 0) + ' traces · paste into Claude.ai for analysis.</div>',
      '  <div style="font-size:11px;color:#4A5568;margin-bottom:8px">Want to log this for the AI review team?</div>',
      '  <div style="display:flex;gap:8px;justify-content:flex-end">',
      '    <button id="mbt-no" style="padding:6px 12px;border-radius:6px;border:1px solid #E2E5EA;background:#fff;font:inherit;font-size:11.5px;cursor:pointer">✗ No log</button>',
      '    <button id="mbt-yes" style="padding:6px 12px;border-radius:6px;border:1px solid #4F6EF7;background:#4F6EF7;color:#fff;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer">✓ Yes — copy log stub</button>',
      '  </div>',
      '</div>',
    ].join('');
    document.body.appendChild(d);
    document.getElementById('mbt-no').onclick = function () { d.remove(); };
    document.getElementById('mbt-yes').onclick = function () {
      var btn = document.getElementById('mbt-yes');
      copy(bundleResp.stub || '')
        .then(function () {
          btn.textContent = '✓ Stub copied — paste into bundle_gap_log.md';
          setTimeout(function () { d.remove(); }, 1400);
        })
        .catch(function () {
          btn.textContent = 'Stub copy failed';
          setTimeout(function () { d.remove(); }, 1400);
        });
    };
  }

  function showError(msg) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:22px;right:22px;background:#1A2130;color:#fff;padding:10px 16px;border-radius:8px;font-size:12.5px;z-index:9100;font-family:Sora,sans-serif';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2400);
  }

  window.triggerMemberBundle = function (memberId) {
    if (!memberId) return;
    fetch('/admin/logs/bundle/member/' + encodeURIComponent(memberId), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function (j) {
        return copy(j.text).then(function () { return j; });
      })
      .then(function (j) {
        showStubDialog(j);
      })
      .catch(function () {
        showError("Couldn't build member bundle");
      });
  };
})();
