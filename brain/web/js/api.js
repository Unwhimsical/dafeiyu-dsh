/* 统一数据层：真实后端（fetch）与演示数据（BrainMock）之间切换只在这一个文件里。
 *  - BRAIN_CONFIG.api.mode = 'auto' | 'real' | 'mock'
 *  - 也可用网址参数 ?mock=1 / ?mock=0 临时切换
 *  - 管理员密钥存在 localStorage[BRAIN_CONFIG.api.keyStorage]，请求头 Authorization: Bearer <key>
 */
(function () {
  var C = window.BRAIN_CONFIG.api;
  var qs = new URLSearchParams(location.search);
  var forced = qs.get('mock') === '1' || (qs.get('mockcount') && qs.get('mock') !== '0') ? 'mock' : qs.get('mock') === '0' ? 'real' : null;
  var listeners = [];
  var API = {
    mode: forced || (C.mode === 'mock' ? 'mock' : location.protocol === 'file:' && !C.base && C.mode === 'auto' ? 'mock' : 'pending'),
    reason: '',
    base: C.base || '',
    getKey: function () { try { return localStorage.getItem(C.keyStorage) || ''; } catch (e) { return ''; } },
  // 支持用 ?key=xxx 直接带密钥打开（方便从别的页面/侧栏 iframe 进来）
  _bootKey: (function () { try { var q = new URLSearchParams(location.search).get('key'); if (q) { localStorage.setItem(C.keyStorage, q); } return q || ''; } catch (e) { return ''; } })(),
    setKey: function (k) { try { localStorage.setItem(C.keyStorage, k || ''); } catch (e) {} },
    onMode: function (fn) { listeners.push(fn); },
    setMode: function (m, why) { API.mode = m; API.reason = why || ''; listeners.forEach(function (f) { try { f(m, why); } catch (e) {} }); }
  };

  function timeout(ms) { var c = new AbortController(); setTimeout(function () { c.abort(); }, ms); return c.signal; }
  async function realFetch(method, path, body, raw) {
    var headers = { Authorization: 'Bearer ' + API.getKey() };
    var opts = { method: method, headers: headers, cache: 'no-store', signal: timeout(C.timeoutMs) };
    if (body !== undefined && body !== null) {
      if (body instanceof FormData) opts.body = body; else { headers['Content-Type'] = 'application/json'; opts.body = typeof body === 'string' ? body : JSON.stringify(body); }
    }
    var res = await fetch(API.base + path, opts);
    if (raw) return res;
    var ct = res.headers.get('content-type') || '';
    var data = ct.indexOf('json') >= 0 ? await res.json() : await res.text();
    if (!res.ok) { var e = new Error((data && (data.message || data.error)) || ('请求失败 ' + res.status)); e.status = res.status; e.body = data; throw e; }
    return data;
  }
  async function mockFetch(method, path, body) {
    await new Promise(function (r) { setTimeout(r, 30 + Math.random() * 60); });
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    return JSON.parse(JSON.stringify(window.BrainMock.route(method, path, body)));
  }

  var ready = null;
  API.ready = function () {
    if (ready) return ready;
    ready = (async function () {
      if (API.mode === 'mock') { API.setMode('mock', forced ? '网址参数 mock=1' : location.protocol === 'file:' ? '直接打开了本地文件' : '配置为演示模式'); return API.mode; }
      try {
        await realFetch('GET', '/api/auth/check');
        API.setMode('real', '已连接后端');
      } catch (e) {
        if (e.status === 401) API.setMode('real', 'need-key');
        else if (forced === 'real' || C.mode === 'real') API.setMode('real', '后端连不上：' + (e.message || e));
        else API.setMode('mock', '后端连不上，已切到演示数据');
      }
      return API.mode;
    })();
    return ready;
  };
  API.checkKey = async function (k) { API.setKey(k); try { await realFetch('GET', '/api/auth/check'); API.setMode('real', '已连接后端'); return true; } catch (e) { return false; } };
  API.useMock = function () { API.setMode('mock', '手动切换到演示数据'); };

  API.request = async function (method, path, body) {
    await API.ready();
    if (API.mode === 'mock') return mockFetch(method, path, body);
    return realFetch(method, path, body);
  };
  API.raw = async function (path, opts) { await API.ready(); // 给花园页用：返回类似 Response 的对象
    opts = opts || {};
    if (API.mode === 'real') return realFetch(opts.method || 'GET', path, opts.body, true);
    return API.request(opts.method || 'GET', path, opts.body).then(function (j) { return { ok: true, status: 200, headers: { get: function () { return 'application/json'; } }, json: function () { return Promise.resolve(j); } }; },
      function (e) { var b = e.body || { message: e.message }; return { ok: false, status: e.status || 500, headers: { get: function () { return 'application/json'; } }, json: function () { return Promise.resolve(b); } }; });
  };
  var get = function (p) { return API.request('GET', p); }, post = function (p, b) { return API.request('POST', p, b || {}); };
  var enc = encodeURIComponent;
  function qstr(o) { var s = []; Object.keys(o || {}).forEach(function (k) { if (o[k] !== undefined && o[k] !== null && o[k] !== '') s.push(enc(k) + '=' + enc(o[k])); }); return s.length ? '?' + s.join('&') : ''; }

  // ---- 业务方法（与 API_CONTRACT.md 一一对应） ----
  Object.assign(API, {
    atlas: function (o) { return get('/api/atlas' + qstr(o)); },
    pulses: function (since) { return get('/pulses' + qstr({ since: since || 0, limit: 50 })); },
    demoPulse: function (n) { return post('/api/pulses/demo', { count: n || 3 }); },
    think: function (since) { return get('/api/think' + qstr({ since: since || 0, limit: 20 })); },
    demoThink: function (n) { return post('/api/think/demo', { count: n || 4 }); },
    search: function (q, o) { return get('/api/search' + qstr(Object.assign({ q: q, limit: 20 }, o))); },
    memories: function (o) { return get('/api/memories' + qstr(o)); },
    filterOptions: function () { return get('/api/filter-options'); },
    memory: function (id) { return get('/api/memories/' + enc(id)); },
    createMemory: function (b) { return post('/api/memories', b); },
    patchMemory: function (id, b) { return API.request('PATCH', '/api/memories/' + enc(id), b); },
    memAction: function (id, act, b) { return post('/api/memories/' + enc(id) + '/' + act, b); },
    forget: function (id) { return API.request('DELETE', '/api/memories/' + enc(id)); },
    bulk: function (ids, action, value) { return post('/api/memories/bulk', { ids: ids, action: action, value: value }); },
    privacy: function () { return get('/api/privacy'); },
    savePrivacy: function (p) { return API.request('PUT', '/api/privacy', p); },
    privacyCheck: function (chat, text) { return post('/api/privacy/check', { chat: chat, text: text }); },
    contextPreview: function (b) { return post('/api/context/preview', b); },
    emotion: function (p) { return get('/api/emotion' + qstr({ persona: p })); },
    emotionApply: function (b) { return post('/api/emotion/apply', b); },
    emotionEvents: function (p) { return get('/api/emotion/events' + qstr({ persona: p, limit: 30 })); },
    bio: function (p) { return get('/api/bio' + qstr({ persona: p })); },
    series: function (p, hours) { return get('/api/state/series' + qstr({ persona: p, hours: hours || 72 })); },
    body: function (p) { return get('/api/body' + qstr({ persona: p })); },
    bodyEvent: function (b) { return post('/api/body/events', b); },
    bodyLog: function (p) { return get('/api/body/log' + qstr({ persona: p, limit: 50 })); },
    desires: function (p) { return get('/api/desires' + qstr({ persona: p })); },
    desireReply: function (id, content) { return post('/api/desires/' + enc(id) + '/replies', { content: content, author: 'user' }); },
    dreams: function (p) { return get('/api/dreams' + qstr({ persona: p, limit: 20 })); },
    modules: function () { return get('/api/modules'); },
    list: function (name, o) { return get('/api/' + name + qstr(o)); },          // unresolved / notes / heart-traces / handoffs / reviews
    create: function (name, b) { return post('/api/' + name, b); },
    remove: function (name, id) { return API.request('DELETE', '/api/' + name + '/' + enc(id)); },
    closeUnresolved: function (id, resolution) { return post('/api/unresolved/' + enc(id) + '/close', { resolution: resolution }); },
    replyNote: function (id, reply, action) { return post('/api/notes/' + enc(id) + '/reply', { reply: reply, action: action }); },
    genHandoff: function (chat) { return post('/api/handoffs/generate', { chat_id: chat }); },
    sessionStart: function (p) { return get('/api/session-start' + qstr({ persona: p })); },
    run: function (job, b) { return post('/api/run/' + job, b || {}); },
    jobs: function () { return get('/api/jobs'); },
    logs: function (o) { return get('/api/logs' + qstr(Object.assign({ limit: 200 }, o))); },
    backups: function () { return get('/api/backups'); },
    backupNow: function () { return post('/api/backups'); },
    restore: function (name) { return post('/api/backups/restore', { name: name }); },
    backupUrl: function (name) { return API.base + '/api/backups/' + enc(name) + '/download?key=' + enc(API.getKey()); },
    verify: function () { return get('/api/verify'); },
    settings: function () { return get('/api/settings'); },
    saveSettings: function (s) { return API.request('PUT', '/api/settings', { settings: s }); },
    stats: function () { return get('/api/stats'); },
    personas: function () { return get('/api/personas'); }
  });

  // ---- 通用工具 ----
  API.util = {
    esc: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },
    pd: function (s) { if (!s) return null; s = String(s); if (/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(s)) s = s.replace(' ', 'T') + 'Z'; var t = new Date(s); return isNaN(t) ? null : t; },
    ago: function (s) { var t = API.util.pd(s); if (!t) return '—'; var d = (Date.now() - t) / 864e5; if (d < 1 / 24) return '刚刚'; if (d < 1) return Math.round(d * 24) + ' 小时前'; if (d < 60) return Math.round(d) + ' 天前'; return Math.round(d / 30) + ' 个月前'; },
    day: function (s) { var t = API.util.pd(s); return t ? t.getFullYear() + '.' + String(t.getMonth() + 1).padStart(2, '0') + '.' + String(t.getDate()).padStart(2, '0') : '—'; },
    when: function (s) { var t = API.util.pd(s); if (!t) return '—'; var h = t.getHours(), w = h < 5 ? '凌晨' : h < 8 ? '早上' : h < 11 ? '上午' : h < 13 ? '中午' : h < 17 ? '下午' : h < 19 ? '傍晚' : '晚上'; return API.util.day(s) + ' · ' + w + ' ' + String(h).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0'); },
    time: function (s) { var t = API.util.pd(s); return t ? String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') : '—'; },
    chatLabel: function (c) { if (API._chatLabels && API._chatLabels[c]) return API._chatLabels[c]; return c || '—'; }
  };
  window.BrainAPI = API;
})();
