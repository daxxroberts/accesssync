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

  function showToast(msg) {
    var t = document.createElement('div');
    t.style.cssText = 'position:fixed;bottom:22px;right:22px;background:#1A2130;color:#fff;padding:10px 16px;border-radius:8px;font-size:12.5px;z-index:9100;font-family:Sora,sans-serif';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2000);
  }

  window.triggerMemberBundle = function (memberId) {
    if (!memberId) return;
    fetch('/admin/logs/bundle/member/' + encodeURIComponent(memberId), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function (j) { return copy(j.text); })
      .then(function () { showToast('Member bundle copied'); })
      .catch(function () { showToast("Couldn't build member bundle"); });
  };
})();
