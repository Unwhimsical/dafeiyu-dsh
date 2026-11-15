/* 工作台（隐私页已并入插件「身份对照」）：记忆管理 / 上下文预览 / 情绪与 18+ 模块 / 延续性 / 任务 / 日志 / 备份 / 设置 */
(function () {
  var CFG = window.BRAIN_CONFIG, API = window.BrainAPI, U = API.util, esc = U.esc, SM = window.StarMap;
  var $ = function (i) { return document.getElementById(i); };
  var pane = function (n) { return document.querySelector('[data-pane="' + n + '"]'); };
  var loaded = {}, cur = 'mem', chats = [], personas = [];
  function toast(s) { SM.toast ? SM.toast(s) : alert(s); }
  function fail(e) { toast('出错了：' + (e && e.message || e)); console.warn(e); }
  function kindLabel(k) { return (CFG.kinds[k] || CFG.itemTypes[k] || { label: k }).label; }
  function kindColor(k) { return (CFG.kinds[k] || CFG.itemTypes[k] || { color: '#ccc' }).color; }
  function scopeTag(s) { return '<span class="scope" style="color:' + (CFG.scopeColors[s] || '#ccc') + '">' + (CFG.scopes[s] || s) + '</span>'; }
  function opt(v, l, selv) { return '<option value="' + esc(v) + '"' + (String(v) === String(selv) ? ' selected' : '') + '>' + esc(l) + '</option>'; }
  function chatOpts(selv, withAll) { return (withAll ? opt('', '全部来源', selv) : '') + chats.map(function (c) { return opt(c.chat, (c.label || c.chat) + ' · ' + c.chat, selv); }).join(''); }
  function tabs(n) { cur = n; document.querySelectorAll('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === n); }); document.querySelectorAll('.wbb section').forEach(function (s) { s.classList.toggle('on', s.dataset.pane === n); }); if (!loaded[n]) { loaded[n] = 1; R[n](); } else if (n === 'logs') R.logs(); }
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) { tabs(b.dataset.tab); history.replaceState(null, '', '#wb=' + b.dataset.tab); } });
  var R = {};
  async function loadMeta() {
    try { var p = await API.privacy(); chats = p.known_chats || []; API._chatLabels = {}; chats.forEach(function (c) { API._chatLabels[c.chat] = c.label; }); } catch (e) { chats = []; }
    try { personas = (await API.personas()).items || []; } catch (e) { personas = []; }
  }

  // ================= 记忆 =================
  var MQ = { q: '', tag: '', kind: '', persona: '', scope: '', state: '', status: 'active', origin: '', sort: 'updated', limit: 40, offset: 0 }, editing = null;
  var FOPTS = null;
  async function fopts() { if (!FOPTS) { try { FOPTS = await API.filterOptions() || {}; } catch (e) { FOPTS = {}; } } return FOPTS; }
  R.mem = async function () {
    var el = pane('mem'), st = {}, FO = await fopts();
    try { st = await API.stats(); } catch (e) {}
    var m = st.memories || {}, bs = m.by_state || {};
    el.innerHTML = '<div class="kv"><div>记忆总数<b>' + (m.total || 0) + '</b></div><div>钉住<b>' + (bs.pinned || 0) + '</b></div><div>清晰 / 模糊 / 残影<b>' + (bs.clear || 0) + ' / ' + (bs.faded || 0) + ' / ' + (bs.trace || 0) + '</b></div><div>24 小时召回<b>' + (st.pulses_24h || 0) + '</b></div></div>' +
      '<div class="fl"><input class="inp" id="mq" placeholder="搜内容或标签" style="flex:1;min-width:140px" value="' + esc(MQ.q) + '">' +
      '<select class="sel" id="mk">' + opt('', '全部类型', MQ.kind) + (FO.kinds || []).map(function (x) { return opt(x.value, kindLabel(x.value) + ' · ' + x.value + ' (' + x.count + ')', MQ.kind); }).join('') + '</select>' +
      '<select class="sel" id="mp">' + opt('', '全部人格', MQ.persona) + personas.map(function (p) { return opt(p.id, p.name, MQ.persona); }).join('') + '</select>' +
      '<select class="sel" id="msc">' + opt('', '全部范围', MQ.scope) + (FO.scopes || []).map(function (x) { return opt(x.value, (CFG.scopes[x.value] || x.value) + ' (' + x.count + ')', MQ.scope); }).join('') + '</select></div>' +
      '<div class="fl"><select class="sel" id="mtg">' + opt('', '全部标签', MQ.tag) + (FO.tags || []).map(function (x) { return opt(x.value, '#' + x.value + ' (' + x.count + ')', MQ.tag); }).join('') + '</select>' + '<select class="sel" id="mst">' + opt('', '全部状态', MQ.state) + Object.keys(CFG.states).map(function (s) { return opt(s, CFG.states[s], MQ.state); }).join('') + '</select>' +
      '<select class="sel" id="mss">' + opt('active', '在用', MQ.status) + opt('archived', '已遗忘（归档）', MQ.status) + opt('superseded', '已被替换', MQ.status) + opt('all', '全部', MQ.status) + '</select>' +
      '<select class="sel" id="mo">' + chatOpts(MQ.origin, true) + '</select>' +
      '<select class="sel" id="mso">' + opt('updated', '最近更新', MQ.sort) + opt('created', '最近写下', MQ.sort) + opt('importance', '重要度', MQ.sort) + opt('strength', '强度', MQ.sort) + opt('recall', '常想起', MQ.sort) + '</select>' +
      '<button class="btn gold" id="mnew">＋ 新记忆</button></div><div id="medit"></div><div id="mtab"></div>';
    var deb; $('mq').oninput = function () { clearTimeout(deb); var v = this.value; deb = setTimeout(function () { MQ.q = v; MQ.offset = 0; table(); }, 250); };
    [['mtg', 'tag'], ['mk', 'kind'], ['mp', 'persona'], ['msc', 'scope'], ['mst', 'state'], ['mss', 'status'], ['mo', 'origin'], ['mso', 'sort']].forEach(function (a) { $(a[0]).onchange = function () { MQ[a[1]] = this.value; MQ.offset = 0; table(); }; });
    $('mnew').onclick = function () { editor(null); };
    await table();
    if (editing) editor(editing);
  };
  async function table() {
    var el = $('mtab'); if (!el) return;
    var r; try { r = await API.memories(MQ); } catch (e) { el.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>'; return; }
    var items = r.items || [];
    el.innerHTML = '<table class="mt"><thead><tr><th>类型</th><th>内容</th><th>强度</th><th>重要</th><th>范围</th><th>来源</th><th>更新</th></tr></thead><tbody>' + items.map(function (m) { var pct = Math.round((m.strength || 0) * 100);
      return '<tr data-id="' + esc(m.id) + '"' + (editing === m.id ? ' class="on"' : '') + '><td style="white-space:nowrap"><span class="kd" style="color:' + kindColor(m.kind) + '"></span>' + esc(kindLabel(m.kind)) + (m.pinned ? ' <span style="color:var(--gold)">★</span>' : '') + '</td><td class="c">' + esc(String(m.content || '').slice(0, 80)) + ((m.tags || []).length ? '<div>' + m.tags.slice(0, 4).map(function (t) { return '<span class="tagc">#' + esc(t) + '</span>'; }).join('') + '</div>' : '') + '</td><td><span class="sb">' + pct + '%<div class="bar"><span style="width:' + pct + '%"></span></div></span></td><td style="color:var(--gold);white-space:nowrap">' + '★'.repeat(m.importance || 0) + '</td><td>' + scopeTag(m.effective_scope || m.scope) + '</td><td style="white-space:nowrap">' + esc(U.chatLabel(m.origin_chat)) + '</td><td style="white-space:nowrap;color:var(--mute)">' + U.ago(m.updated_at || m.created_at) + '</td></tr>'; }).join('') + '</tbody></table>' +
      (items.length ? '' : '<div class="empty">没有符合条件的记忆</div>') +
      '<div class="pager">共 ' + (r.total || 0) + ' 条 · 第 ' + (MQ.offset + 1) + '–' + (MQ.offset + items.length) + ' 条 <button class="btn sm" id="pp"' + (MQ.offset ? '' : ' disabled') + '>上一页</button><button class="btn sm" id="pn"' + (MQ.offset + items.length < r.total ? '' : ' disabled') + '>下一页</button></div>';
    el.querySelectorAll('tbody tr').forEach(function (tr) { tr.onclick = function () { editor(tr.dataset.id); if (SM.focus) SM.focus(tr.dataset.id); }; });
    $('pp').onclick = function () { MQ.offset = Math.max(0, MQ.offset - MQ.limit); table(); }; $('pn').onclick = function () { MQ.offset += MQ.limit; table(); };
  }
  async function editor(id) {
    var el = $('medit'); if (!el) return; editing = id;
    document.querySelectorAll('#mtab tbody tr').forEach(function (tr) { tr.classList.toggle('on', tr.dataset.id === id); });
    var d = { memory: { content: '', kind: 'event', importance: 3, scope: 'inherit', tags: [], pinned: false, persona: CFG.primary || 'dafeiyu' }, links: [], audit: [], superseded_chain: [] };
    if (id) { try { d = await API.memory(id); } catch (e) { el.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>'; return; } }
    var m = d.memory;
    el.innerHTML = '<div class="editor"><div class="fl" style="justify-content:space-between"><b style="color:var(--gold)">' + (id ? '编辑记忆 <small style="color:var(--mute);font-weight:400">' + esc(id) + ' · ' + esc(CFG.states[m.state] || m.state || '') + ' · 被想起 ' + (m.recall_count || 0) + ' 次 · 半衰期 ' + (m.pinned ? '∞' : (m.half_life_days ? Math.round(m.half_life_days) + ' 天' : '—')) + '</small>' : '写一条新记忆') + '</b><button class="btn sm" id="ex">×</button></div>' +
      '<textarea class="ta" id="ec">' + esc(m.content) + '</textarea>' +
      '<div class="row2"><label>类型<select class="sel" id="ek">' + Object.keys(CFG.kinds).map(function (k) { return opt(k, CFG.kinds[k].label + ' · ' + k, m.kind); }).join('') + '</select></label>' +
      '<label>重要度<span class="stars5" id="ei">' + [1, 2, 3, 4, 5].map(function (i) { return '<button data-v="' + i + '" class="' + (i <= m.importance ? 'on' : '') + '">★</button>'; }).join('') + '</span></label>' +
      '<label>隐私范围<select class="sel" id="es">' + ['inherit', 'private', 'scoped', 'public'].map(function (s) { return opt(s, CFG.scopes[s] + (s === 'inherit' && m.effective_scope ? '（现在＝' + CFG.scopes[m.effective_scope] + '）' : ''), m.scope || 'inherit'); }).join('') + '</select></label>' +
      '<label>人格<select class="sel" id="ep">' + (personas.length ? personas : [{ id: 'dafeiyu', name: '大肥鱼' }]).map(function (p) { return opt(p.id, p.name, m.persona); }).join('') + '</select></label></div>' +
      '<div class="row2" style="grid-template-columns:2fr 1fr 1fr"><label>标签（空格分隔）<input class="inp" id="et" value="' + esc((m.tags || []).join(' ')) + '"></label><label>来源会话<select class="sel" id="eo">' + opt('', '（无）', m.origin_chat) + chatOpts(m.origin_chat) + '</select></label><label>钉住<select class="sel" id="epin">' + opt('0', '否', m.pinned ? 1 : 0) + opt('1', '★ 永远记得', m.pinned ? 1 : 0) + '</select></label></div>' +
      '<div class="fl">' + (id ? '<button class="btn gold" id="esave">保存修改</button><button class="btn" id="esup" title="把正文框里的内容作为新版本，旧的标记为已替换">替换为新版本</button><button class="btn" id="erein">强化一次</button><button class="btn" id="econf" title="这条她记对了（可信度↑）">✔ 记对了</button><button class="btn" id="edeny" title="这条她记错了：归档不删，不再被想起">✘ 记错了</button><button class="btn" id="efly">在星图里看</button>' + (m.status === 'active' ? '<button class="btn red" id="earc">遗忘（可恢复）</button>' : '<button class="btn" id="eres">恢复</button>') + '<button class="btn red" id="edel">彻底删除</button>' : '<button class="btn gold" id="ecreate">写入记忆</button><span class="hint">私聊里写下的默认继承会话的隐私规则</span>') + '</div>' +
      (id ? '<div class="two"><div><div class="hint">✦ 心流 · 牵出来的（' + (d.links || []).length + '）</div>' + (d.links || []).slice(0, 8).map(function (l) { return '<div class="it2" style="cursor:pointer" data-fly="' + esc(l.id) + '"><span class="st">' + ((CFG.linkKinds[l.k] || {}).label || l.k) + ' ' + Math.round(l.w * 100) + '%</span><span class="b">' + esc(String(l.content || l.id).slice(0, 40)) + '</span></div>'; }).join('') + '</div><div><div class="hint">修改记录</div>' + ((d.audit || []).slice(-6).reverse().map(function (a) { return '<div class="it2"><span class="b">' + esc(a.action) + ' <span class="t">' + esc(a.detail || '') + '</span></span><span class="t">' + U.time(a.created_at) + '</span></div>'; }).join('') || '<div class="t" style="font-size:12px;color:var(--mute)">还没有改过</div>') +
        ((d.superseded_chain || []).length ? '<div class="hint" style="margin-top:8px">旧版本</div>' + d.superseded_chain.map(function (x) { return '<div class="it2"><span class="b" style="text-decoration:line-through;opacity:.6">' + esc(x.content) + '</span></div>'; }).join('') : '') + '</div></div>' : '') + '</div>';
    var imp = m.importance || 3;
    el.querySelectorAll('#ei button').forEach(function (b) { b.onclick = function () { imp = +b.dataset.v; el.querySelectorAll('#ei button').forEach(function (x) { x.classList.toggle('on', +x.dataset.v <= imp); }); }; });
    el.querySelectorAll('[data-fly]').forEach(function (x) { x.onclick = function () { SM.focus(x.dataset.fly); }; });
    function body() { return { content: $('ec').value.trim(), kind: $('ek').value, importance: imp, scope: $('es').value, persona: $('ep').value, tags: $('et').value.trim().split(/\s+/).filter(Boolean), pinned: $('epin').value === '1' }; }
    $('ex').onclick = function () { editing = null; el.innerHTML = ''; table(); };
    function done(msg) { toast(msg); table(); SM.reload().then(function () { if (editing) SM.focus(editing); }); loaded.priv = 0; }
    if (!id) { $('ecreate').onclick = function () { var b = body(); if (!b.content) return toast('先写点内容'); b.chat_id = $('eo').value || undefined; b.pin = b.pinned; API.createMemory(b).then(function (r) { editing = r.id; done('写下了，可见范围：' + (CFG.scopes[r.effective_scope] || r.effective_scope || '')); editor(r.id); }).catch(fail); }; return; }
    $('esave').onclick = function () { var b = body(); API.patchMemory(id, b).then(function () { done('已保存'); editor(id); }).catch(fail); };
    $('esup').onclick = function () { var c = $('ec').value.trim(); if (!c || c === m.content) return toast('先在正文框里改成新的内容'); API.memAction(id, 'feedback', { action: 'correct', content: c, expected_version: m.version }).then(function (r) { editing = r.new_id || r.id; done('已替换为新版本，旧的保留在历史里'); editor(editing); }).catch(fail); };
    if ($('econf')) $('econf').onclick = function () { API.memAction(id, 'feedback', { action: 'confirm', expected_version: m.version }).then(function () { done('记下了：这条是真的'); editor(id); }).catch(fail); };
    if ($('edeny')) $('edeny').onclick = function () { API.memAction(id, 'feedback', { action: 'deny', expected_version: m.version }).then(function () { done('已标为记错（归档保留原文，可恢复）'); editor(id); }).catch(fail); };
    $('erein').onclick = function () { API.memAction(id, 'reinforce').then(function () { done('强化了一次'); editor(id); }).catch(fail); };
    $('efly').onclick = function () { SM.focus(id); };
    if ($('earc')) $('earc').onclick = function () { API.memAction(id, 'archive').then(function () { done('已遗忘，可在“已遗忘”里恢复'); editor(id); }).catch(fail); };
    if ($('eres')) $('eres').onclick = function () { API.memAction(id, 'restore').then(function () { done('已恢复'); editor(id); }).catch(fail); };
    $('edel').onclick = function () { if (!confirm('彻底删除这条记忆？不能恢复。')) return; API.forget(id).then(function () { editing = null; el.innerHTML = ''; done('已彻底删除'); }).catch(fail); };
  }

  // 旧的「隐私」页（R.priv，/api/privacy 编辑）已删，身份 / 隐私只在 星图·控制台 →「身份对照」里改

  // ================= 上下文预览 =================
  R.ctx = function () {
    var el = pane('ctx');
    el.innerHTML = '<div class="hint">模拟 bot 收到一条消息时，记忆大脑会往提示词里注入什么。显示的是完整注入文本和 token 估算。</div>' +
      '<div class="fl"><select class="sel" id="cc">' + chatOpts(chats[0] ? chats[0].chat : '') + '</select><select class="sel" id="cp">' + (personas.length ? personas : [{ id: 'dafeiyu', name: '大肥鱼' }]).map(function (p) { return opt(p.id, p.name, 'dafeiyu'); }).join('') + '</select><label style="font-size:12px;color:var(--mute)"><input type="checkbox" id="cn"> 新会话（带交接）</label></div>' +
      '<div class="fl"><input class="inp" id="cm" style="flex:1" value="我上次说的复查是哪天来着？" placeholder="用户消息"><button class="btn gold" id="cb">预览注入</button></div><div id="cr"></div>';
    $('cb').onclick = run; $('cm').onkeydown = function (e) { if (e.key === 'Enter') run(); };
    function run() {
      $('cr').innerHTML = '<div class="empty">生成中…</div>';
      API.contextPreview({ chat_id: $('cc').value, persona: $('cp').value, message: $('cm').value, new_session: $('cn').checked }).then(function (r) {
        var ms = r.messages || [], tot = (r.tokens && r.tokens.total) || ms.reduce(function (s, m) { return s + (m.tokens || 0); }, 0) || 1, cols = ['#c9b6ff', '#9fd8ff', '#ffffff33', '#f6d38b', '#7fe0c8', '#ff9ec4'];
        var ch = r.chars || {};
        $('cr').innerHTML = '<div class="kv"><div>总 token<b>' + tot + '</b></div><div>记忆块 token<b>' + ((r.tokens && r.tokens.block) || '—') + '</b></div><div>记忆块字数<b>' + (ch.total || (r.block || '').length) + (ch.budget ? ' / ' + ch.budget : '') + '</b></div><div>召回<b>' + (r.recalled || []).length + ' 条</b></div></div>' +
          '<div class="tokbar">' + ms.map(function (m, i) { return '<span title="' + esc(m.label) + ' ' + m.tokens + '" style="width:' + (m.tokens / tot * 100) + '%;background:' + cols[i % cols.length] + '"></span>'; }).join('') + '</div><div class="legend">' + ms.map(function (m, i) { return '<span><i style="background:' + cols[i % cols.length] + '"></i>' + esc(m.label || m.role) + ' <b>' + (m.tokens || 0) + '</b></span>'; }).join('') + '</div>' +
          ms.map(function (m) { return '<div class="msg' + (/记忆/.test(m.label || '') ? ' blk' : '') + '"><div class="mh"><b>' + esc(m.role) + '</b>' + esc(m.label || '') + '<span class="tk">' + (m.tokens || 0) + ' tokens · ' + (m.content || '').length + ' 字</span></div>' + (m.content ? '<pre>' + esc(m.content) + '</pre>' : '') + '</div>'; }).join('') +
          ((r.recalled || []).length ? '<h3>这次召回的记忆 <small>点一下在星图里看</small></h3>' + r.recalled.map(function (x) { return '<div class="it2" style="cursor:pointer" data-fly="' + esc(x.id) + '"><span class="st">' + (x.score != null ? (+x.score).toFixed(2) : '') + '</span><span class="b">' + esc(x.content) + '</span>' + scopeTag(x.effective_scope) + '</div>'; }).join('') : '') +
          (r.debug ? '<h3>调试</h3><div class="out">' + esc(JSON.stringify(r.debug, null, 2)) + '</div>' : '');
        $('cr').querySelectorAll('[data-fly]').forEach(function (x) { x.onclick = function () { SM.focus(x.dataset.fly); }; });
      }).catch(function (e) { $('cr').innerHTML = '<div class="empty">失败：' + esc(e.message) + '</div>'; });
    }
    run();
  };

  // ================= 情绪 · 18+ =================
  var hours = 72;
  R.emo = async function () {
    var el = pane('emo'), FO = await fopts();
    el.innerHTML = '<div class="fl"><span class="hint" style="margin:0">曲线范围</span><select class="sel" id="eh">' + [24, 72, 168].map(function (h) { return opt(h, h === 168 ? '7 天' : h + ' 小时', hours); }).join('') + '</select><span id="emod" class="hint" style="margin:0 0 0 auto"></span></div>' +
      '<h3>情绪 <small id="eline"></small></h3><div class="two"><div class="box" id="ebar"></div><div class="box"><div class="t">手动调一下（测试用）</div><div class="fl" style="margin-top:6px"><select class="sel" id="ed">' + (FO.emotion_dims || []).map(function (x) { return opt(x.value, x.value); }).join('') + '</select><button class="btn sm" data-d="10">＋10</button><button class="btn sm" data-d="-10">－10</button></div><div id="eev" style="margin-top:6px"></div></div></div><div class="chartbox" id="ech"></div>' +
      '<h3>激素 <small id="bline"></small></h3><div class="two"><div class="box" id="hbar"></div><div class="chartbox" id="hch" style="margin:0"></div></div>' +
      '<h3>身体 <span class="badge18">18+</span> <small id="bodyline"></small></h3><div class="two"><div class="box adult" id="bbar"></div><div class="box adult" id="btr"></div></div><div class="chartbox adult" id="bch"></div>' +
      '<div class="fl"><span class="hint" style="margin:0">测试身体事件：</span>' + [['touch', '抚摸'], ['kiss', '亲吻'], ['bite', '咬'], ['tease', '撩拨']].map(function (x) { return '<button class="btn sm" data-be="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>' +
      '<h3>欲望 <span class="badge18">18+</span></h3><div class="chartbox adult" id="dch"></div><div id="dl"></div>' +
      '<h3>梦</h3><div id="drl"></div>';
    $('eh').onchange = function () { hours = +this.value; R.emo(); };
    var q = await Promise.all([API.emotion().catch(function () { return {}; }), API.bio().catch(function () { return {}; }), API.series(null, hours).catch(function () { return {}; }), API.body().catch(function () { return {}; }), API.desires().catch(function () { return {}; }), API.dreams().catch(function () { return {}; }), API.modules().catch(function () { return {}; }), API.emotionEvents().catch(function () { return {}; })]);
    var emo = q[0], bio = q[1], ser = q[2], body = q[3], des = q[4], dr = q[5], mods = q[6], evs = q[7];
    $('emod').textContent = '模块：' + ['emotion', 'body', 'dream', 'desire'].map(function (k) { var m = mods[k] || {}; return ({ emotion: '情绪', body: '身体', dream: '梦', desire: '欲望' })[k] + (m.enabled === false ? '关' : '开'); }).join(' · ');
    $('eline').textContent = emo.prompt_line || '';
    var dims = emo.dims || {};
    Charts.bars($('ebar'), Object.keys(dims).map(function (k) { return { name: k + (dims[k].inner ? ' ·藏' + Math.round(dims[k].inner) : ''), value: dims[k].surface || 0, color: CFG.charts.emotion[k] || '#ccc' }; }));
    $('eev').innerHTML = ((evs.events || []).slice(0, 4).map(function (e) { return '<div class="it2"><span class="b">' + esc(e.reason || e.source) + '</span><span class="t">' + U.time(e.created_at) + '</span></div>'; }).join(''));
    el.querySelectorAll('[data-d]').forEach(function (b) { b.onclick = function () { var c = {}; c[$('ed').value] = { surface: +b.dataset.d }; API.emotionApply({ changes: c, reason: '工作台手动调整' }).then(function () { toast('已调整'); R.emo(); }).catch(fail); }; });
    function ser2(arr, keyset, colors, labels) { return Object.keys(keyset).map(function (k) { return { name: labels ? labels[k] || k : k, color: colors[k] || '#ccc', points: (arr || []).map(function (p) { var v = p.values ? p.values[k] : p[k]; if (v && typeof v === 'object') v = v.surface; return [+U.pd(p.at), +v || 0]; }) }; }); }
    var lastE = (ser.emotion || [])[0]; if (lastE) Charts.line($('ech'), ser2(ser.emotion, lastE.values || {}, CFG.charts.emotion), { min: 0, max: 100, height: 180 });
    var hm = bio.hormones || {}; $('bline').textContent = bio.line || '';
    Charts.bars($('hbar'), Object.keys(hm).map(function (k) { return { name: k, value: hm[k].level, base: hm[k].base, color: CFG.charts.hormones[k] || '#ccc' }; }));
    var lastH = (ser.hormones || [])[0]; if (lastH) Charts.line($('hch'), ser2(ser.hormones, lastH.values || {}, CFG.charts.hormones), { min: 0, max: 100, height: 160 });
    var bv = body.values || {}; $('bodyline').textContent = body.text || body.values_line || '';
    Charts.bars($('bbar'), Object.keys(bv).map(function (k) { return { name: CFG.charts.bodyLabels[k] || k, value: bv[k], color: CFG.charts.body[k] || '#ff9ec4', max: k === 'edge' && body.threshold ? 100 : 100 }; }).concat(body.threshold ? [{ name: '阈值', value: body.threshold, color: '#ffffff55' }] : []));
    $('btr').innerHTML = '<div class="t">痕迹</div>' + ((body.traces || []).map(function (t) { return '<div class="it2"><span class="b">' + esc(t.part_zh || t.part) + ' · ' + esc(t.type_zh || t.type) + ' <span class="t">' + esc(t.level || '') + '</span></span><span class="t">剩 ' + Math.round(t.fade || 0) + '%</span></div>'; }).join('') || '<div class="t">没有</div>') + '<div class="t" style="margin-top:6px">今天醒来 ' + (body.wakes_today || 0) + ' 次' + (body.afterglow_until ? ' · 余韵到 ' + U.time(body.afterglow_until) : '') + '</div>';
    var lastB = (ser.body || [])[0]; if (lastB) Charts.line($('bch'), ser2(ser.body, lastB.values || {}, CFG.charts.body, CFG.charts.bodyLabels), { min: 0, max: 100, height: 170 });
    el.querySelectorAll('[data-be]').forEach(function (b) { b.onclick = function () { API.bodyEvent({ events: [{ type: b.dataset.be, part: 'neck', intensity: .6 }] }).then(function (r) { toast('身体：' + ((r.notes || []).join('，') || '已记录')); R.emo(); }).catch(fail); }; });
    var dser = (ser.desire || []).map(function (p) { return [+U.pd(p.at), +p.level || 0]; }); Charts.line($('dch'), [{ name: '欲望等级', color: '#ff6f91', points: dser, width: 2 }], { min: 0, max: 5, height: 110, area: true });
    $('dl').innerHTML = (des.items || []).map(function (d) { return '<div class="box adult"><div class="t">等级 ' + esc(d.level) + ' · ' + esc(d.status || '') + ' · ' + U.time(d.created_at) + '</div><b>' + esc(d.trigger || '') + '</b><div>' + esc(d.mood || '') + '</div>' + (d.replies || []).map(function (r) { return '<div class="t">↳ ' + esc(r.author === 'user' ? '我' : r.author) + '：' + esc(r.content) + '</div>'; }).join('') + '<div class="fl" style="margin:6px 0 0"><input class="inp" style="flex:1" placeholder="回她一句" data-dr="' + esc(d.id) + '"><button class="btn sm" data-drb="' + esc(d.id) + '">回复</button></div></div>'; }).join('') || '<div class="empty">没有</div>';
    el.querySelectorAll('[data-drb]').forEach(function (b) { b.onclick = function () { var i = el.querySelector('[data-dr="' + b.dataset.drb + '"]'); if (!i.value.trim()) return; API.desireReply(b.dataset.drb, i.value.trim()).then(function () { toast('回复了'); R.emo(); }).catch(fail); }; });
    $('drl').innerHTML = (dr.items || []).map(function (d) { return '<div class="box"><div class="t">' + esc(d.day || '') + ' · 用了 ' + (d.material || []).length + ' 条记忆 · 加固 ' + (d.consolidated || []).length + ' 条</div>' + esc(d.content) + '<div class="fl" style="margin:6px 0 0">' + (d.material || []).slice(0, 6).map(function (id) { return '<button class="btn sm" data-fly="' + esc(id) + '">✦ ' + esc(id) + '</button>'; }).join('') + '</div></div>'; }).join('') || '<div class="empty">还没有梦</div>';
    el.querySelectorAll('[data-fly]').forEach(function (x) { x.onclick = function () { SM.focus(x.dataset.fly); }; });
  };

  // ================= 延续性 =================
  R.cont = async function () {
    var el = pane('cont');
    var q = await Promise.all(['unresolved', 'notes', 'heart-traces', 'handoffs'].map(function (n) { return API.list(n, { status: 'all' }).catch(function () { return { items: [] }; }); }).concat([API.sessionStart().catch(function () { return {}; })]));
    var un = q[0].items || [], no = q[1].items || [], ht = q[2].items || [], ho = q[3].items || [], ss = q[4];
    el.innerHTML = (ss.text ? '<h3>醒来时看到的 <small>session-start</small></h3><div class="box">' + esc(ss.text) + '</div>' : '') +
      '<h3>未了的事 <small>' + un.filter(function (u) { return u.status === 'open'; }).length + ' 件没了结</small></h3>' + un.map(function (u) { return '<div class="it2"><span class="st ' + (u.status === 'open' ? 'open' : '') + '">' + (u.status === 'open' ? '未了' : '已了') + '</span><span class="b">' + esc(u.content) + (u.resolution ? '<div class="t">→ ' + esc(u.resolution) + '</div>' : '') + '<div class="t">' + esc(U.chatLabel(u.chat_id)) + ' · ' + U.ago(u.created_at) + '</div></span>' + (u.status === 'open' ? '<button class="btn sm" data-close="' + esc(u.id) + '">了结</button>' : '') + '<button class="btn sm red" data-del="unresolved:' + esc(u.id) + '">删</button></div>'; }).join('') +
      '<div class="fl" style="margin-top:6px"><input class="inp" id="nu" style="flex:1" placeholder="记一件还没了结的事"><button class="btn sm" id="nub">添加</button></div>' +
      '<h3>便条 <small>我写给大肥鱼的话，她会回</small></h3>' + no.map(function (n) { return '<div class="box"><div class="t">' + U.time(n.created_at) + ' · ' + (n.status === 'open' ? '<span style="color:#ffd9a8">待回复</span>' : '已回复') + '</div>' + esc(n.content) + (n.reply ? '<div style="color:#9fe8d8;margin-top:4px">↳ ' + esc(n.reply) + (n.reply_action ? ' <span class="t">[' + esc(n.reply_action) + ']</span>' : '') + '</div>' : '<div class="fl" style="margin:6px 0 0"><input class="inp" style="flex:1" data-nr="' + esc(n.id) + '" placeholder="替她回复（测试）"><button class="btn sm" data-nrb="' + esc(n.id) + '">回复</button></div>') + '<div style="text-align:right"><button class="btn sm red" data-del="notes:' + esc(n.id) + '">删</button></div></div>'; }).join('') +
      '<div class="fl"><input class="inp" id="nn" style="flex:1" placeholder="给大肥鱼留一张便条"><button class="btn sm" id="nnb">留下</button></div>' +
      '<h3>心痕 <small>大肥鱼心里一直放着的事</small></h3>' + ht.map(function (h) { return '<div class="it2"><span class="b"><b>' + esc(h.title || '') + '</b> ' + esc(h.content) + '<div class="t">' + U.day(h.created_at) + '</div></span><button class="btn sm red" data-del="heart-traces:' + esc(h.id) + '">删</button></div>'; }).join('') +
      '<div class="fl" style="margin-top:6px"><input class="inp" id="nht" placeholder="标题" style="width:120px"><input class="inp" id="nhc" style="flex:1" placeholder="内容"><button class="btn sm" id="nhb">添加</button></div>' +
      '<h3>交接 <small>换会话时留给下一个自己的话</small></h3><div class="fl"><select class="sel" id="hc">' + chatOpts(chats[0] ? chats[0].chat : '') + '</select><button class="btn sm" id="hg">现在生成一份</button></div>' + ho.map(function (h) { return '<div class="box"><div class="t">' + esc(U.chatLabel(h.chat_id)) + ' · ' + U.time(h.created_at) + (h.consumed ? ' · 已交接' : ' · <span style="color:#ffd9a8">待交接</span>') + (h.mood ? ' · 心情：' + esc(h.mood) : '') + '</div>' + esc(h.summary) + (h.next_time ? '<div class="t">下次：' + esc(h.next_time) + '</div>' : '') + '<div style="text-align:right"><button class="btn sm red" data-del="handoffs:' + esc(h.id) + '">删</button></div></div>'; }).join('');
    var re = function (m) { toast(m); R.cont(); };
    el.querySelectorAll('[data-close]').forEach(function (b) { b.onclick = function () { var r = prompt('怎么了结的？', '说过了'); if (r == null) return; API.closeUnresolved(b.dataset.close, r).then(function () { re('了结了'); }).catch(fail); }; });
    el.querySelectorAll('[data-del]').forEach(function (b) { b.onclick = function () { if (!confirm('删除这条？')) return; var p = b.dataset.del.split(':'); API.remove(p[0], p.slice(1).join(':')).then(function () { re('删掉了'); }).catch(fail); }; });
    el.querySelectorAll('[data-nrb]').forEach(function (b) { b.onclick = function () { var i = el.querySelector('[data-nr="' + b.dataset.nrb + '"]'); if (!i.value.trim()) return; API.replyNote(b.dataset.nrb, i.value.trim(), 'ack').then(function () { re('回复了'); }).catch(fail); }; });
    $('nub').onclick = function () { var v = $('nu').value.trim(); if (v) API.create('unresolved', { content: v, chat_id: chats[0] ? chats[0].chat : '' }).then(function () { re('记下了'); }).catch(fail); };
    $('nnb').onclick = function () { var v = $('nn').value.trim(); if (v) API.create('notes', { content: v, author: 'user' }).then(function () { re('便条留下了'); }).catch(fail); };
    $('nhb').onclick = function () { var c = $('nhc').value.trim(); if (c) API.create('heart-traces', { title: $('nht').value.trim(), content: c }).then(function () { re('心痕记下了'); }).catch(fail); };
    $('hg').onclick = function () { API.genHandoff($('hc').value).then(function () { re('生成了交接'); }).catch(fail); };
  };

  // ================= 整理 · 做梦 =================
  var JOBDESC = { consolidate: ['整理', '让记忆按半衰期自然变淡，合并重复，清晰→模糊→残影'], reflect: ['反思', '回看最近的对话，写下新的认识'], dream: ['做梦', '随机挑几段记忆织成一个梦，并加固其中几条'], review: ['周回顾', '把这一周凝成一段回顾'], links: ['连线', '重新计算记忆之间的关联'], cognition: ['凝成认知', '把反复出现的事凝成一条认知'], settle: ['情绪沉淀', '让情绪回落到基线'], verify: ['体检', '检查数据库完整性、全文索引是否同步'], spill_index: ['溢出索引', '给溢出的历史对话建索引'] };
  R.jobs = async function () {
    var el = pane('jobs'), j = {}; try { j = await API.jobs(); } catch (e) {}
    var jm = {}; (j.jobs || []).forEach(function (x) { jm[x.name] = x; });
    el.innerHTML = '<div class="hint">这些任务后台会按时自动跑；这里可以手动触发一次。触发时星图上会亮起相关的记忆。</div><div class="jobg">' + Object.keys(JOBDESC).map(function (k) { var x = jm[k] || {}; return '<div class="job"><div class="nm">' + JOBDESC[k][0] + ' <small style="color:var(--mute);font-size:11px">' + k + '</small></div><div class="ds">' + JOBDESC[k][1] + '</div><button class="btn ' + (/consolidate|reflect|dream/.test(k) ? 'gold' : '') + '" data-run="' + k + '">立即运行</button><div class="lr">' + (x.last_run ? '上次 ' + U.ago(x.last_run) : '还没跑过') + (x.every_min ? ' · 每 ' + (x.every_min >= 1440 ? x.every_min / 1440 + ' 天' : x.every_min + ' 分钟') : x.note ? ' · ' + esc(x.note) : '') + '</div></div>'; }).join('') + '</div><h3>输出</h3><div class="out" id="jo">（点上面的按钮）</div>';
    el.querySelectorAll('[data-run]').forEach(function (b) { b.onclick = function () { var k = b.dataset.run; b.disabled = true; b.textContent = '运行中…'; $('jo').textContent = '运行 ' + k + ' …';
      API.run(k).then(function (r) { $('jo').textContent = '✓ ' + k + ' 完成，用时 ' + (r.took_ms || 0) + ' ms\n' + JSON.stringify(r.result, null, 2); toast(JOBDESC[k][0] + ' 完成'); SM.reload(); loaded.emo = 0; loaded.mem = 0; setTimeout(R.jobs.bind(null, true), 50); })
        .catch(function (e) { $('jo').textContent = '✗ ' + e.message; b.disabled = false; b.textContent = '立即运行'; }); }; });
  };

  // ================= 日志 =================
  var logTimer = null;
  R.logs = async function () {
    var el = pane('logs');
    if (!$('lq')) { el.innerHTML = '<div class="fl"><input class="inp" id="lq" placeholder="过滤关键字" style="flex:1"><select class="sel" id="ll">' + opt('ALL', '全部级别') + opt('INFO', 'INFO') + opt('WARNING', 'WARNING') + opt('ERROR', 'ERROR') + '</select><label style="font-size:12px;color:var(--mute)"><input type="checkbox" id="la" checked> 自动刷新</label><button class="btn sm" id="lr">刷新</button></div><div class="logs" id="lb"></div>';
      $('lq').oninput = function () { R.logs(); }; $('ll').onchange = function () { R.logs(); }; $('lr').onclick = function () { R.logs(); };
      clearInterval(logTimer); logTimer = setInterval(function () { if (cur === 'logs' && $('la').checked && document.body.classList.contains('wb-open')) R.logs(); }, 3000); }
    try { var r = await API.logs({ q: $('lq').value, level: $('ll').value }); var lb = $('lb'), atBottom = lb.scrollTop + lb.clientHeight >= lb.scrollHeight - 30;
      lb.innerHTML = (r.lines || []).map(function (l) { return '<div class="' + esc(l.level) + '"><span class="at">' + U.time(l.at) + '</span>' + esc(l.level === 'INFO' ? '' : l.level + ' ') + esc(l.msg) + '</div>'; }).join('') || '<div class="empty">没有日志</div>'; if (atBottom) lb.scrollTop = lb.scrollHeight; } catch (e) { $('lb').textContent = '读取失败：' + e.message; }
  };

  // ================= 备份 =================
  R.bak = async function () {
    var el = pane('bak'), b = {}, v = null; try { b = await API.backups(); } catch (e) {}
    el.innerHTML = '<div class="hint">备份目录：' + esc(b.dir || '—') + '。恢复前会自动先备份当前数据库。</div><div class="fl"><button class="btn gold" id="bn">立即备份</button><button class="btn" id="bv">体检数据库</button></div><div id="bvr"></div>' +
      '<table class="mt"><thead><tr><th>文件</th><th>大小</th><th>时间</th><th></th></tr></thead><tbody>' + (b.items || []).map(function (x) { return '<tr><td>' + esc(x.name) + '</td><td>' + (x.size / 1048576).toFixed(2) + ' MB</td><td>' + U.time(x.mtime) + '</td><td style="text-align:right;white-space:nowrap"><a class="btn sm" href="' + esc(API.backupUrl(x.name)) + '" download>下载</a> <button class="btn sm red" data-rs="' + esc(x.name) + '">恢复</button></td></tr>'; }).join('') + '</tbody></table>' + ((b.items || []).length ? '' : '<div class="empty">还没有备份</div>');
    $('bn').onclick = function () { API.backupNow().then(function () { toast('备份完成'); R.bak(); }).catch(fail); };
    $('bv').onclick = function () { API.verify().then(function (r) { $('bvr').innerHTML = '<div class="box ' + (r.ok ? '' : 'adult') + '">' + (r.ok ? '<span class="ok">✓ 数据库健康</span>' : '<span class="bad">✗ 有问题</span>') + ' · 完整性 ' + esc(r.integrity) + ' · ' + r.memories + ' 条记忆 · 全文索引 ' + (r.fts_in_sync ? '同步' : '<span class="bad">不同步</span>') + ' · 孤立连线 ' + r.orphan_links + '</div>'; }).catch(fail); };
    el.querySelectorAll('[data-rs]').forEach(function (x) { x.onclick = function () { if (!confirm('用 ' + x.dataset.rs + ' 恢复数据库？当前数据库会先自动备份。')) return; API.restore(x.dataset.rs).then(function () { toast('已恢复'); SM.reload(); R.bak(); }).catch(fail); }; });
  };

  // ================= 设置 =================
  R.set = async function () {
    var el = pane('set'), s = {}; try { s = await API.settings(); } catch (e) {}
    el.innerHTML = '<h3>大脑密钥（ADMIN_KEY）</h3><div class="hint">这是记忆星海大脑的钥匙；和「模型 API 密钥」「本地接口」是三套不同的东西。</div><div class="hint">保存在本机浏览器 localStorage（' + esc(CFG.api.keyStorage) + '），每个请求都会带上 Authorization: Bearer。</div><div class="fl"><input class="inp" type="password" id="sk" style="flex:1" value="' + esc(API.getKey()) + '" placeholder="ADMIN_KEY"><button class="btn" id="sks">显示</button><button class="btn gold" id="skb">保存并测试</button></div><div id="skr" class="hint"></div>' +
      '<h3>数据源</h3><div class="box">现在：<b>' + (API.mode === 'mock' ? '演示数据（浏览器内，不会写入后端）' : '真实后端 ' + esc(API.base || location.origin)) + '</b><div class="t">' + esc(API.reason) + '</div><div class="fl" style="margin-top:8px"><a class="btn sm" href="?mock=0#wb=set">强制连后端</a><a class="btn sm" href="?mock=1#wb=set">用演示数据</a><a class="btn sm" href="./#wb=set">自动</a></div></div>' +
      '<h3>人格</h3>' + personas.map(function (p) { return '<div class="it2"><span class="b"><b>' + esc(p.name) + '</b> <span class="t">' + esc(p.id) + ' · ' + esc(p.relationship_to_user || '') + ' · ' + (p.memories || 0) + ' 条记忆</span></span></div>'; }).join('') +
      '<h3>后端配置 <small>' + esc(s.path || '') + '</small></h3><div class="hint">改端口 / 地址需要重启服务；其他项保存后立即生效。</div><textarea class="ta code" id="sj">' + esc(JSON.stringify(s.settings || {}, null, 2)) + '</textarea><div class="fl" style="margin-top:8px"><button class="btn gold" id="ss">保存配置</button><span id="ssr" class="hint" style="margin:0"></span></div>' +
      '<h3>前端外观</h3><div class="hint">颜色、星星大小、转速、相机等都在 <b>web/js/config.js</b>，改完刷新即可。详见 web/README_UI.md。</div>';
    $('sks').onclick = function () { var i = $('sk'); i.type = i.type === 'password' ? 'text' : 'password'; };
    $('skb').onclick = function () { API.checkKey($('sk').value.trim()).then(function (ok) { $('skr').innerHTML = ok ? '<span class="ok">✓ 密钥正确，已连接后端</span>' : '<span class="bad">✗ 连不上或密钥不对</span>'; if (ok) setTimeout(function () { location.reload(); }, 600); }); };
    $('ss').onclick = function () { var v; try { v = JSON.parse($('sj').value); } catch (e) { return toast('JSON 格式不对：' + e.message); } API.saveSettings(v).then(function (r) { $('ssr').innerHTML = '<span class="ok">已保存</span>' + (r.restart_required ? ' · <span class="bad">需要重启服务才能生效</span>' : ''); }).catch(fail); };
  };

  window.Workbench = {
    inited: false,
    init: async function () { if (this.inited) return; this.inited = true; await loadMeta(); },
    open: async function (tab) { await this.init(); tabs(tab && R[tab] ? tab : cur); },
    editMemory: async function (id) { editing = id; MQ.status = 'all'; window.openWorkbench(true, 'mem'); await this.init(); loaded.mem = 1; tabs('mem'); await R.mem(); },
    refresh: function (tab) { loaded[tab || cur] = 0; tabs(tab || cur); },
    tab: function (t) { tabs(t); }
  };
  SM.onSelect(function (s) { if (s && !s.item && !s.core && document.body.classList.contains('wb-open') && cur === 'mem' && $('medit') && editing !== s.id) editor(s.id); });
})();
