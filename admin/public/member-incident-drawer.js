/**
 * member-incident-drawer.js
 * Vanilla JS modal drawer that unifies the diagnose verdict + retry/dismiss
 * actions + trace event chain + payload for one member's incident. Designed
 * for the Errors page "Details" button; reusable from anywhere that has a
 * memberId + (optional) errorId + (optional) traceId.
 *
 * Depends on /humanize.js (loaded as a global window.AccessSyncHumanize).
 *
 * Usage:
 *   window.MemberIncidentDrawer.open({
 *     memberId:  '<uuid>',
 *     clientId:  '<uuid>',          // null → owner endpoints, else operator-scoped
 *     errorId:   '<uuid>',          // optional — enables Retry/Dismiss buttons
 *     traceId:   '<uuid>',          // optional — focuses trace chain on this trace
 *     onActionDone: () => { ... },  // callback after retry/dismiss; e.g. reload list
 *   });
 *
 * The drawer shows a Plain/Technical voice toggle. Plain is default.
 * On owner contexts, an "Open in Trace Timeline →" deep-link surfaces in the
 * footer when traceId is known. Operators never see this link.
 */
(function () {
  'use strict';

  var H = window.AccessSyncHumanize || {};
  var humanize     = H.humanize || function (ev) { return ev.event || ''; };
  var severityOf   = H.severityOf || function () { return 'info'; };
  var SOURCE_LABELS = H.SOURCE_LABELS || {};

  var STYLE_ID = 'mid-styles';
  var ROOT_ID  = 'member-incident-drawer';
  var VOICE_COOKIE = 'as_drawer_voice';

  function fmtClock(iso) {
    var d = new Date(iso);
    return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2) + ':' + ('0' + d.getUTCSeconds()).slice(-2);
  }
  function fmtRel(iso) {
    var dt = (Date.now() - new Date(iso).getTime()) / 1000;
    if (dt < 60)    return Math.max(0, Math.round(dt)) + 's ago';
    if (dt < 3600)  return Math.round(dt/60) + 'm ago';
    if (dt < 86400) return Math.round(dt/3600) + 'h ago';
    return Math.round(dt/86400) + 'd ago';
  }
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }
  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, val) {
    document.cookie = name + '=' + encodeURIComponent(val) + '; Path=/; Max-Age=31536000; SameSite=Lax';
  }

  // Translate the legacy timeline format (from /diagnose's getTimeline) into
  // the v_trace_timeline shape humanize() expects.
  function normalizeTimelineRow(row, member) {
    return {
      ts:           row.created_at,
      source:       row.source === 'access_log'      ? 'member_access'
                   : row.source === 'adapter_log'    ? 'admin_audit'
                   : row.source === 'diagnostic_log' ? 'diagnostic'
                   : row.source === 'webhook_log'    ? 'webhook'
                   : row.source === 'error_queue'    ? 'error_queue'
                   : row.source,
      event:        row.event_type || row.error_code || '',
      result:       row.error_code || row.detail || '',
      detail:       row.context || null,
      trace_id:     row.trace_id || null,
      member_name:  member && (member.display_name || (member.first_name || '') + ' ' + (member.last_name || '')),
      member_email: member && member.email,
      client_name:  member && member.client_name,
    };
  }

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.mid-overlay{position:fixed;inset:0;background:rgba(15,25,35,0.45);backdrop-filter:blur(2px);z-index:9000;opacity:0;transition:opacity .15s;display:none}',
      '.mid-overlay.open{opacity:1;display:block}',
      '.mid-panel{position:fixed;top:0;right:0;bottom:0;width:560px;max-width:100vw;background:var(--card,#fff);box-shadow:-12px 0 40px rgba(0,0,0,0.18);z-index:9001;transform:translateX(100%);transition:transform .2s cubic-bezier(.2,.7,.3,1);display:flex;flex-direction:column;font-family:Sora,ui-sans-serif,system-ui,sans-serif;color:var(--text,#1A2130)}',
      '.mid-panel.open{transform:translateX(0)}',
      '.mid-head{display:flex;align-items:flex-start;gap:12px;padding:18px 20px 14px;border-bottom:1px solid var(--border,#E2E5EA)}',
      '.mid-head h2{font-size:16px;font-weight:600;margin:0 0 4px;letter-spacing:-0.2px}',
      '.mid-head .sub{font-size:12.5px;color:var(--text2,#4A5568)}',
      '.mid-x{margin-left:auto;background:transparent;border:1px solid var(--border,#E2E5EA);border-radius:6px;padding:4px 9px;font-size:13px;color:var(--text2);cursor:pointer}',
      '.mid-x:hover{background:var(--surface,#F9FAFB)}',
      '.mid-toggle{display:inline-flex;background:var(--surface,#F9FAFB);border:1px solid var(--border,#E2E5EA);border-radius:7px;padding:0 2px;height:26px;align-items:center}',
      '.mid-toggle button{background:transparent;border:none;padding:0 10px;height:22px;border-radius:4px;font-size:11.5px;font-weight:500;color:var(--text2,#4A5568);cursor:pointer;font-family:inherit}',
      '.mid-toggle button.on{background:var(--card,#fff);color:var(--text,#1A2130);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,0.06)}',
      '.mid-body{flex:1;overflow-y:auto;padding:0}',
      '.mid-section{padding:14px 20px;border-bottom:1px solid var(--border,#E2E5EA)}',
      '.mid-section:last-child{border-bottom:none}',
      '.mid-section h3{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--muted,#8896A8);margin:0 0 9px}',
      '.mid-verdict{padding:13px 14px;border-radius:9px;display:flex;gap:10px;align-items:flex-start}',
      '.mid-verdict.healthy{background:rgba(74,222,128,0.08);border:1px solid rgba(74,222,128,0.30)}',
      '.mid-verdict.warning{background:rgba(245,166,35,0.08);border:1px solid rgba(245,166,35,0.30)}',
      '.mid-verdict.failed,.mid-verdict.error{background:rgba(255,77,106,0.08);border:1px solid rgba(255,77,106,0.30)}',
      '.mid-verdict-icon{font-size:18px;flex-shrink:0;line-height:1}',
      '.mid-verdict-body{flex:1;min-width:0}',
      '.mid-verdict-title{font-size:13.5px;font-weight:600;margin-bottom:3px;color:var(--text,#1A2130)}',
      '.mid-verdict-detail{font-size:12px;color:var(--text2,#4A5568);line-height:1.5}',
      '.mid-findings{margin-top:9px;display:flex;flex-direction:column;gap:5px}',
      '.mid-finding{font-size:11.5px;color:var(--text2,#4A5568);padding-left:10px;border-left:2px solid var(--border2,#D0D5DD);line-height:1.45}',
      '.mid-actions{display:flex;gap:8px;flex-wrap:wrap}',
      '.mid-btn{padding:6px 13px;border-radius:7px;border:1px solid var(--border,#E2E5EA);background:var(--card,#fff);color:var(--text,#1A2130);font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:5px}',
      '.mid-btn:hover:not(:disabled){background:var(--surface,#F9FAFB)}',
      '.mid-btn:disabled{opacity:.45;cursor:default}',
      '.mid-btn.primary{background:#4F6EF7;color:#fff;border-color:#4F6EF7}',
      '.mid-btn.primary:hover:not(:disabled){background:#3D5BD4}',
      '.mid-btn.danger{color:#FF4D6A;border-color:rgba(255,77,106,0.35)}',
      '.mid-event{display:flex;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid var(--border,#E2E5EA);cursor:default;font-size:12px}',
      '.mid-event:last-child{border-bottom:none}',
      '.mid-event-time{font-family:JetBrains Mono,ui-monospace,monospace;font-size:10.5px;color:var(--muted,#8896A8);width:62px;flex-shrink:0;font-variant-numeric:tabular-nums}',
      '.mid-event-src{font-size:10.5px;font-weight:500;padding:1px 6px;border-radius:4px;border:1px solid currentColor;flex-shrink:0}',
      '.mid-event-text{flex:1;min-width:0;color:var(--text,#1A2130);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mid-event-tech{font-family:JetBrains Mono,ui-monospace,monospace;font-size:11px}',
      '.mid-sev-error{width:7px;height:7px;border-radius:50%;background:#FF4D6A;flex-shrink:0}',
      '.mid-sev-warn{width:7px;height:7px;border-radius:50%;background:#F5A623;flex-shrink:0}',
      '.mid-sev-info{width:5px;height:5px;border-radius:50%;background:var(--border2,#D0D5DD);flex-shrink:0}',
      '.mid-payload{margin:0;padding:11px 13px;background:var(--bg,#F2F4F7);border:1px solid var(--border,#E2E5EA);border-radius:7px;font-family:JetBrains Mono,ui-monospace,monospace;font-size:11px;color:var(--text2,#4A5568);line-height:1.55;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto}',
      '.mid-empty{color:var(--muted,#8896A8);font-size:12.5px;padding:20px;text-align:center}',
      '.mid-loading{color:var(--muted,#8896A8);font-size:12.5px;padding:20px;text-align:center}',
      '.mid-foot{padding:11px 20px;border-top:1px solid var(--border,#E2E5EA);background:var(--surface,#F9FAFB);display:flex;align-items:center;gap:10px;font-size:11.5px}',
      '.mid-foot a{color:#4F6EF7;text-decoration:none;font-weight:500}',
      '.mid-foot a:hover{text-decoration:underline}',
      '.mid-toast{position:fixed;bottom:22px;right:22px;background:var(--text,#1A2130);color:#fff;padding:10px 16px;border-radius:8px;font-size:12.5px;z-index:9100;opacity:0;transform:translateY(8px);transition:opacity .15s,transform .15s}',
      '.mid-toast.show{opacity:1;transform:translateY(0)}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function injectMarkup() {
    if (document.getElementById(ROOT_ID)) return;
    var wrap = document.createElement('div');
    wrap.id = ROOT_ID;
    wrap.innerHTML = [
      '<div class="mid-overlay" id="mid-overlay"></div>',
      '<aside class="mid-panel" id="mid-panel" role="dialog" aria-modal="true" aria-labelledby="mid-title">',
      '  <div class="mid-head">',
      '    <div style="flex:1;min-width:0">',
      '      <h2 id="mid-title">Member Incident</h2>',
      '      <div class="sub" id="mid-subtitle"></div>',
      '    </div>',
      '    <div class="mid-toggle" role="radiogroup" aria-label="Voice">',
      '      <button id="mid-voice-plain" class="on" type="button">✨ Plain</button>',
      '      <button id="mid-voice-tech"  type="button">Technical</button>',
      '    </div>',
      '    <button class="mid-x" id="mid-bundle" type="button" title="Copy member bundle for AI analysis" style="font-size:11px;padding:4px 8px">⧉ Bundle</button>',
      '    <button class="mid-x" id="mid-close" type="button" aria-label="Close">✕</button>',
      '  </div>',
      '  <div class="mid-body" id="mid-body"></div>',
      '  <div class="mid-foot" id="mid-foot" style="display:none"></div>',
      '</aside>',
    ].join('');
    document.body.appendChild(wrap);
  }

  function showToast(msg) {
    var t = document.createElement('div');
    t.className = 'mid-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.remove(); }, 200);
    }, 2200);
  }

  // Pull session role from cookie/document — owner sees the deep-link, operator does not.
  function isOwner() {
    return document.body && document.body.dataset && document.body.dataset.sessionRole !== 'operator';
  }

  var state = {
    memberId: null, clientId: null, errorId: null, traceId: null,
    onActionDone: null,
    voice: getCookie(VOICE_COOKIE) || 'plain',
    diagnose: null, timeline: null, member: null,
    // pre-fix errors: trace_id NULL → fall back to member-scoped 7-day window
    fellBackToMemberTimeline: false,
  };

  function open(opts) {
    injectStyles();
    injectMarkup();

    state.memberId = opts.memberId || null;
    state.clientId = opts.clientId || null;
    state.errorId  = opts.errorId  || null;
    state.traceId  = opts.traceId  || null;
    state.onActionDone = typeof opts.onActionDone === 'function' ? opts.onActionDone : null;
    state.diagnose = null; state.timeline = null; state.member = null;
    state.fellBackToMemberTimeline = false;

    document.getElementById('mid-overlay').classList.add('open');
    var panel = document.getElementById('mid-panel');
    panel.classList.add('open');

    document.getElementById('mid-overlay').onclick = close;
    document.getElementById('mid-close').onclick = close;
    var bundleBtn = document.getElementById('mid-bundle');
    if (bundleBtn) bundleBtn.onclick = onBundleClick;
    document.getElementById('mid-voice-plain').onclick = function () { setVoice('plain'); };
    document.getElementById('mid-voice-tech').onclick  = function () { setVoice('technical'); };
    document.addEventListener('keydown', escListener);

    setVoice(state.voice, true);
    render();
    fetchAll();
  }

  function close() {
    document.getElementById('mid-overlay') && document.getElementById('mid-overlay').classList.remove('open');
    document.getElementById('mid-panel')   && document.getElementById('mid-panel').classList.remove('open');
    document.removeEventListener('keydown', escListener);
  }

  function escListener(e) { if (e.key === 'Escape') close(); }

  function setVoice(v, skipRender) {
    state.voice = v;
    setCookie(VOICE_COOKIE, v);
    var p = document.getElementById('mid-voice-plain');
    var t = document.getElementById('mid-voice-tech');
    if (p && t) {
      p.classList.toggle('on', v === 'plain');
      t.classList.toggle('on', v === 'technical');
    }
    if (!skipRender) render();
  }

  function endpointBase() {
    return state.clientId
      ? '/operator/' + encodeURIComponent(state.clientId) + '/members/' + encodeURIComponent(state.memberId)
      : '/admin/members/' + encodeURIComponent(state.memberId);
  }

  function fetchAll() {
    // If memberId is missing (e.g. error_queue.member_id was null because retry-engine
    // couldn't resolve it before its own fix landed), skip the per-member endpoints —
    // they would hit /members/null/diagnose and 500. Use the trace-only path if available.
    var hasMember = !!state.memberId;
    var timelineUrl;

    if (state.traceId) {
      timelineUrl = '/admin/logs/trace/' + encodeURIComponent(state.traceId);
    } else if (hasMember) {
      timelineUrl = endpointBase() + '/timeline';
      state.fellBackToMemberTimeline = true;
    } else {
      timelineUrl = null;
    }

    if (hasMember) {
      var diagnoseUrl = endpointBase() + '/diagnose';
      fetch(diagnoseUrl, { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { state.diagnose = j; render(); })
        .catch(function () { state.diagnose = { _error: true }; render(); });
    } else {
      // No member context — surface a sensible empty state rather than spinning forever.
      state.diagnose = { _error: true, _reason: 'no_member_id' };
      render();
    }

    if (!timelineUrl) {
      state.timeline = { _error: true, _reason: 'no_member_id_or_trace_id' };
      render();
      return;
    }

    fetch(timelineUrl, { credentials: 'include' })
      .then(function (r) {
        if (r.status === 404 && state.traceId && hasMember) {
          // Trace not found (e.g. cross-tenant or NULL trace_id). Fall back to member timeline.
          state.fellBackToMemberTimeline = true;
          return fetch(endpointBase() + '/timeline', { credentials: 'include' })
            .then(function (r2) { return r2.ok ? r2.json() : null; });
        }
        return r.ok ? r.json() : null;
      })
      .then(function (j) { state.timeline = j; render(); })
      .catch(function () { state.timeline = { _error: true }; render(); });
  }

  function render() {
    var body = document.getElementById('mid-body');
    if (!body) return;
    var foot = document.getElementById('mid-foot');
    var subtitle = document.getElementById('mid-subtitle');
    var title = document.getElementById('mid-title');
    var plain = state.voice === 'plain';

    var html = '';

    // 1. Verdict panel
    if (state.diagnose === null) {
      html += '<div class="mid-section"><div class="mid-loading">Loading diagnosis…</div></div>';
    } else if (state.diagnose && state.diagnose._error) {
      html += '<div class="mid-section"><div class="mid-empty">Couldn\'t load diagnosis.</div></div>';
    } else if (state.diagnose) {
      var d = state.diagnose;
      var member = d.member || {};
      state.member = member;
      var memberName = esc(member.display_name || ((member.first_name || '') + ' ' + (member.last_name || '')).trim() || member.email || '(unknown member)');
      title.textContent = memberName;
      subtitle.innerHTML = (member.email ? esc(member.email) : '') +
        (member.client_name ? ' · ' + esc(member.client_name) : '');

      var verdict = (d.verdict || 'healthy').toLowerCase();
      var icon = verdict === 'healthy' ? '✓' : verdict === 'warning' ? '⚠' : '✕';
      var verdictTitle =
        verdict === 'healthy' ? (plain ? 'Looks healthy' : 'verdict: healthy') :
        verdict === 'warning' ? (plain ? 'Some attention needed' : 'verdict: warning') :
        (plain ? 'Access is broken' : 'verdict: failed');

      var findingsHtml = '';
      if (d.findings && d.findings.length) {
        findingsHtml = '<div class="mid-findings">' +
          d.findings.map(function (f) {
            var msg = plain ? (f.detail || f.message || f.code || '') : (f.code || f.message || JSON.stringify(f));
            return '<div class="mid-finding">' + esc(msg) + '</div>';
          }).join('') +
          '</div>';
      } else if (verdict === 'healthy') {
        findingsHtml = '<div class="mid-finding">' + (plain ? 'No drift between AccessSync, Wix, and the hardware.' : 'no findings') + '</div>';
      }

      html += '<div class="mid-section">' +
        '<h3>Verdict</h3>' +
        '<div class="mid-verdict ' + verdict + '">' +
          '<div class="mid-verdict-icon">' + icon + '</div>' +
          '<div class="mid-verdict-body">' +
            '<div class="mid-verdict-title">' + esc(verdictTitle) + '</div>' +
            findingsHtml +
          '</div>' +
        '</div>' +
      '</div>';
    }

    // 2. Actions
    var actionsHtml = '<div class="mid-actions">';
    if (state.errorId && state.clientId) {
      actionsHtml += '<button class="mid-btn primary" id="mid-retry" type="button">↻ ' + (plain ? 'Retry now' : 'Retry job') + '</button>';
      actionsHtml += '<button class="mid-btn" id="mid-dismiss" type="button">' + (plain ? 'Dismiss' : 'Mark resolved') + '</button>';
    }
    if (state.memberId && state.clientId) {
      actionsHtml += '<button class="mid-btn" id="mid-reconcile" type="button">' + (plain ? 'Re-check this member' : 'Reconcile') + '</button>';
    }
    actionsHtml += '</div>';
    html += '<div class="mid-section"><h3>Actions</h3>' + actionsHtml + '</div>';

    // 3. Trace events
    html += '<div class="mid-section"><h3>' +
      (state.traceId && !state.fellBackToMemberTimeline
        ? (plain ? 'What happened in this incident' : 'Trace events')
        : (plain ? 'Recent activity for this member' : 'Member timeline'))
      + '</h3>';
    if (state.timeline === null) {
      html += '<div class="mid-loading">Loading…</div>';
    } else if (state.timeline && state.timeline._error) {
      html += '<div class="mid-empty">Couldn\'t load timeline.</div>';
    } else {
      var rows;
      if (state.timeline && state.timeline.events) {
        // /admin/logs/trace/:id shape
        rows = state.timeline.events;
      } else if (state.timeline && state.timeline.timeline) {
        // /diagnose's getTimeline shape — normalize each row
        rows = state.timeline.timeline.map(function (r) { return normalizeTimelineRow(r, state.member); });
      } else {
        rows = [];
      }
      // Cap to last 20 for compactness; full history available in Trace Timeline
      var display = rows.slice(0, 20);
      if (display.length === 0) {
        html += '<div class="mid-empty">' + (plain ? 'No events yet.' : 'no rows') + '</div>';
      } else {
        var first = display[display.length - 1]; // events come in chronological order from trace endpoint, reverse-chronological from getTimeline
        html += display.map(function (e) {
          var sev = severityOf(e);
          var sevDot = sev === 'error' ? '<span class="mid-sev-error" title="error"></span>' :
                       sev === 'warn'  ? '<span class="mid-sev-warn"  title="warn"></span>'  :
                                         '<span class="mid-sev-info"  title="info"></span>';
          var src = SOURCE_LABELS[e.source] || { short: e.source, plain: e.source, color: '#8896A8' };
          var label = plain ? src.plain : src.short;
          var text  = plain ? humanize(e) : (e.event || '');
          return '<div class="mid-event">' +
            '<span class="mid-event-time">' + esc(fmtClock(e.ts)) + '</span>' +
            '<span class="mid-event-src" style="color:' + esc(src.color) + '">' + esc(label) + '</span>' +
            sevDot +
            '<span class="mid-event-text' + (plain ? '' : ' mid-event-tech') + '">' + esc(text) + '</span>' +
          '</div>';
        }).join('');
        if (rows.length > 20) {
          html += '<div class="mid-finding" style="margin-top:8px">+' + (rows.length - 20) + ' more events — view full chain in Trace Timeline.</div>';
        }
      }
    }
    html += '</div>';

    // 4. Payload (collapsed by default)
    var payloadObj = null;
    if (state.timeline && state.timeline.events && state.timeline.events.length) {
      // Pick the most relevant event's detail — first error, else first event.
      var withErr = state.timeline.events.find(function (e) { return severityOf(e) === 'error' && e.detail; });
      payloadObj = withErr ? withErr.detail : (state.timeline.events[0] && state.timeline.events[0].detail);
    }
    if (payloadObj) {
      html += '<div class="mid-section"><h3>Payload</h3>' +
        '<pre class="mid-payload">' + esc(JSON.stringify(payloadObj, null, 2)) + '</pre></div>';
    }

    body.innerHTML = html;

    // Wire action buttons
    var retryBtn   = document.getElementById('mid-retry');
    var dismissBtn = document.getElementById('mid-dismiss');
    var reconBtn   = document.getElementById('mid-reconcile');
    if (retryBtn)   retryBtn.onclick   = onRetry;
    if (dismissBtn) dismissBtn.onclick = onDismiss;
    if (reconBtn)   reconBtn.onclick   = onReconcile;

    // Footer — deep-link to Trace Timeline.
    //
    // DR-054: was owner-only, which was inconsistent — operators already reach the
    // Trace Timeline through the Logs tab (operator-nav.js renders it for every role).
    // Hiding only the shortcut meant an operator staring at an error had to go find
    // its trace by hand. Safe to show: admin/routes/logs.js scopedClientId() pins any
    // operator request to their own client_id server-side and ignores a supplied one,
    // so an operator following this link sees their own gym's trace or nothing.
    //
    // Owners keep /OwnerDashboard (cross-client view); operators go to /logs, which
    // is the route their nav already points at. Both read the same ?openTrace= param.
    if (foot) {
      if (state.traceId) {
        var owner    = isOwner();
        var traceUrl = (owner ? '/OwnerDashboard' : '/logs') +
                       '?openTrace=' + encodeURIComponent(state.traceId);
        foot.style.display = 'flex';
        foot.innerHTML =
          (owner ? '<span style="color:var(--muted,#8896A8)">Owner only:</span> ' : '') +
          '<a href="' + traceUrl + '" target="_blank" rel="noopener">Open in Trace Timeline →</a>';
      } else {
        foot.style.display = 'none';
        foot.innerHTML = '';
      }
    }
  }

  // ── Action handlers ────────────────────────────────────────────────
  function onRetry() {
    if (!state.errorId || !state.clientId) return;
    var btn = document.getElementById('mid-retry');
    if (btn) { btn.disabled = true; btn.textContent = 'Retrying…'; }
    fetch('/operator/' + encodeURIComponent(state.clientId) + '/errors/' + encodeURIComponent(state.errorId) + '/retry',
          { method: 'POST', credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function () {
        showToast('Requeued — AccessSync will retry provisioning');
        if (state.onActionDone) state.onActionDone('retry');
        // Refresh the verdict + timeline after a short pause
        setTimeout(fetchAll, 600);
      })
      .catch(function () {
        showToast('Retry failed — try again or check the queue');
        if (btn) { btn.disabled = false; btn.textContent = '↻ Retry now'; }
      });
  }
  function onDismiss() {
    if (!state.errorId || !state.clientId) return;
    var btn = document.getElementById('mid-dismiss');
    if (btn) { btn.disabled = true; btn.textContent = 'Dismissing…'; }
    fetch('/operator/' + encodeURIComponent(state.clientId) + '/errors/' + encodeURIComponent(state.errorId) + '/dismiss',
          { method: 'POST', credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function () {
        showToast('Dismissed');
        if (state.onActionDone) state.onActionDone('dismiss');
        close();
      })
      .catch(function () {
        showToast('Dismiss failed');
        if (btn) { btn.disabled = false; btn.textContent = 'Dismiss'; }
      });
  }
  function onReconcile() {
    if (!state.memberId || !state.clientId) return;
    var btn = document.getElementById('mid-reconcile');
    if (btn) { btn.disabled = true; btn.textContent = 'Re-checking…'; }
    fetch('/operator/' + encodeURIComponent(state.clientId) + '/members/' + encodeURIComponent(state.memberId) + '/sync',
          { method: 'POST', credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function () {
        showToast('Re-checked — refreshing diagnosis…');
        setTimeout(fetchAll, 600);
        if (btn) { btn.disabled = false; btn.textContent = 'Re-check this member'; }
      })
      .catch(function () {
        showToast('Reconcile failed');
        if (btn) { btn.disabled = false; btn.textContent = 'Re-check this member'; }
      });
  }

  function onBundleClick() {
    if (!state.memberId) return;
    var btn = document.getElementById('mid-bundle');
    if (btn) { btn.disabled = true; btn.textContent = 'Building…'; }

    fetch('/admin/logs/bundle/member/' + encodeURIComponent(state.memberId), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r); })
      .then(function (j) { return navigator.clipboard.writeText(j.text); })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = '⧉ Bundle'; }
        showToast('Member bundle copied');
      })
      .catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Bundle failed'; setTimeout(function(){ btn.textContent = '⧉ Bundle'; }, 1500); }
      });
  }

  window.MemberIncidentDrawer = { open: open, close: close };
})();
