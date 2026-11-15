/* 页面胶水：数据源徽章、密钥门、菜单、工作台开关、快捷键。 */
(function () {
  var $ = function (i) { return document.getElementById(i); }, API = window.BrainAPI, SM = window.StarMap;
  var UI = window.BRAIN_CONFIG.ui, ds = document.documentElement.style; ds.setProperty('--wbw', UI.workbenchWidth + 'px'); ds.setProperty('--cardw', UI.cardWidth + 'px'); ds.setProperty('--sheetw', UI.sheetWidth + 'px');
  function badge() { var m = $('mode'); m.className = API.mode; m.textContent = API.mode === 'mock' ? '演示数据' : API.mode === 'real' ? (API.reason === 'need-key' ? '需要密钥' : '已连接后端') : '连接中…'; m.title = (API.reason || '') + '\n点击切换数据源'; if ($('wbmode')) $('wbmode').textContent = m.textContent; }
  function cbadge() { var c = $('cmode'), m = $('mode'); if (!c) return; c.textContent = API.mode === 'mock' ? '示例数据' : m.textContent; c.title = m.title; c.className = API.mode; }
  API.onMode(badge); API.onMode(cbadge); badge(); cbadge();
  $('mode').onclick = function () { var u = new URL(location.href); u.searchParams.set('mock', API.mode === 'mock' ? '0' : '1'); location.href = u.toString(); };
  function gate() { $('gate').classList.add('open'); $('gk').focus(); }
  $('gb').onclick = function () { var v = $('gk').value.trim(); if (!v) return; API.checkKey(v).then(function (ok) { if (!ok) { $('gerr').textContent = '密钥不对'; return; } $('gate').classList.remove('open'); start(); }); };
  $('gk').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('gb').click(); });
  $('gm').onclick = function () { API.useMock(); $('gate').classList.remove('open'); start(); };
  function start() { SM.load().then(function () { SM.startPolling(); window.Workbench && window.Workbench.init(); if (/wb/.test(location.hash)) openWb(true, (location.hash.match(/wb[=:]?(\w+)/) || [])[1]); var st = new URLSearchParams(location.search).get('star'); if (st) SM.focus(st); }); }
  API.ready().then(function () { if (API.mode === 'real' && API.reason === 'need-key') gate(); else start(); });

  $('mb').onclick = function (e) { e.stopPropagation(); $('menu').classList.toggle('open'); };
  // 宇宙主题（v3）：右下角小按钮 / 左上角模式字样 / 主题切换
  if ($('cMenu')) $('cMenu').onclick = function (e) { e.stopPropagation(); $('menu').classList.toggle('open'); };
  if ($('cmode')) $('cmode').onclick = function () { $('mode').onclick(); };
  if ($('cTour')) $('cTour').onclick = function () { SM.tour(); };
  if ($('cSearch')) $('cSearch').onclick = function (e) { e.stopPropagation(); document.body.classList.contains('cos-q') ? (document.body.classList.remove('cos-q'), $('q').blur()) : SM.openSearch(); };
  if ($('cWb')) $('cWb').onclick = function () { openWb(); };
  if ($('cTheme')) $('cTheme').onclick = function () { SM.setTheme(SM.theme === 'cosmos' ? 'classic' : 'cosmos'); };
  if ($('mTheme')) { $('mTheme').textContent = SM.theme === 'cosmos' ? '◐ 切换到经典彩色星图' : '◑ 切换到宇宙星图（v3）'; $('mTheme').onclick = function () { SM.setTheme(SM.theme === 'cosmos' ? 'classic' : 'cosmos'); }; }
  if ($('mFind')) $('mFind').onclick = function (e) { e.stopPropagation(); $('menu').classList.remove('open'); SM.openSearch(true); };
  document.addEventListener('click', function (e) { if (!e.target.closest('#menu') && !e.target.closest('#mb') && !e.target.closest('#cMenu')) $('menu').classList.remove('open'); if (!e.target.closest('.sw')) $('qr').classList.remove('open'); });
  function openList(on) { var l = $('list'); on = on == null ? !l.classList.contains('open') : on; l.classList.toggle('open', on); if (on) { SM.closeSheet(); SM.renderList(); } $('lt').classList.toggle('on', on); }
  $('lt').onclick = function () { openList(); }; $('mList').onclick = function () { openList(true); $('menu').classList.remove('open'); }; $('lclose').onclick = function () { openList(false); };
  $('ft').onclick = function () { var f = $('filters'); f.classList.toggle('open'); this.textContent = f.classList.contains('open') ? '筛选 ▴' : '筛选 ▾'; };
  function openWb(on, tab) { on = on == null ? !document.body.classList.contains('wb-open') : on; document.body.classList.toggle('wb-open', on); $('wb').setAttribute('aria-hidden', !on); $('wbBtn').classList.toggle('on', on); if ($('cWb')) $('cWb').classList.toggle('on', on); if (on && SM.tour) SM.tour(false); if (on && window.Workbench) window.Workbench.open(tab); }
  window.openWorkbench = openWb;
  $('wbBtn').onclick = function () { openWb(); }; $('mWb').onclick = function () { openWb(true); $('menu').classList.remove('open'); }; $('wbClose').onclick = function () { openWb(false); };
  if ($('mThink')) $('mThink').onclick = function () { $('menu').classList.remove('open'); var go = function () { if (!SM.think()) SM.toast('现在没有能连出去的星'); }; if (API.mode === 'mock') go(); else API.demoThink(4).then(function () { SM.toast('已让大脑想一次（等下一次轮询）'); }, go); };
  $('mPulse').onclick = function () { API.demoPulse(3).catch(function () {}); $('menu').classList.remove('open'); SM.toast('发出 3 次召回脉冲'); };
  $('mHome').onclick = function () { SM.select(null); SM.closeSheet(); $('menu').classList.remove('open'); };
  document.addEventListener('keydown', function (e) { if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return; if (e.key === 'w' || e.key === 'W') openWb(); if (e.key === '/') { e.preventDefault(); SM.openSearch ? SM.openSearch() : $('q').focus(); } if (e.key === 'Escape') { SM.select(null); SM.closeSheet(); openList(false); } });
  SM.onSelect(function (s) { if (s && !s.core) $('list').classList.remove('open'); });
})();
