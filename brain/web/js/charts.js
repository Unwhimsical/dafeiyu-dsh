/* 轻量 SVG 折线图（无依赖）。Charts.line(容器, [{name,color,points:[[时间ms,值]]}], {min,max,height,title}) */
(function () {
  var esc = window.BrainAPI.util.esc;
  function line(el, series, o) {
    o = o || {}; var W = el.clientWidth || 640, H = o.height || 170, pl = 30, pr = 8, pt = 10, pb = 20;
    var all = []; series.forEach(function (s) { s.points.forEach(function (p) { all.push(p); }); });
    if (!all.length) { el.innerHTML = '<div class="empty">暂无数据</div>'; return; }
    var t0 = Math.min.apply(null, all.map(function (p) { return p[0]; })), t1 = Math.max.apply(null, all.map(function (p) { return p[0]; })) || t0 + 1;
    var mn = o.min != null ? o.min : Math.min.apply(null, all.map(function (p) { return p[1]; })), mx = o.max != null ? o.max : Math.max.apply(null, all.map(function (p) { return p[1]; }));
    if (mx === mn) mx = mn + 1;
    var X = function (t) { return pl + (t - t0) / Math.max(1, t1 - t0) * (W - pl - pr); }, Y = function (v) { return pt + (1 - (v - mn) / (mx - mn)) * (H - pt - pb); };
    var g = '';
    for (var i = 0; i <= 4; i++) { var v = mn + (mx - mn) * i / 4, y = Y(v); g += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + y + '" y2="' + y + '" stroke="#ffffff14"/><text x="' + (pl - 4) + '" y="' + (y + 3) + '" text-anchor="end">' + Math.round(v) + '</text>'; }
    var days = {}; for (var t = t0; t <= t1; t += 36e5) { var d = new Date(t); if (d.getHours() === 0 && !days[d.toDateString()]) { days[d.toDateString()] = 1; var x = X(t); g += '<line x1="' + x + '" x2="' + x + '" y1="' + pt + '" y2="' + (H - pb) + '" stroke="#ffffff10"/><text x="' + x + '" y="' + (H - 6) + '" text-anchor="middle">' + (d.getMonth() + 1) + '/' + d.getDate() + '</text>'; } }
    var paths = series.map(function (s, k) { if (!s.points.length) return ''; var dd = s.points.map(function (p, i) { return (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join('');
      var area = o.area && k === 0 ? '<path d="' + dd + 'L' + X(s.points[s.points.length - 1][0]) + ' ' + Y(mn) + 'L' + X(s.points[0][0]) + ' ' + Y(mn) + 'Z" fill="' + s.color + '" opacity=".08"/>' : '';
      return area + '<path d="' + dd + '" fill="none" stroke="' + s.color + '" stroke-width="' + (s.width || 1.6) + '" stroke-linejoin="round" opacity="' + (s.dim ? .35 : .95) + '"' + (s.dash ? ' stroke-dasharray="4 3"' : '') + '/>'; }).join('');
    el.innerHTML = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '">' + g + paths + '<line class="cur" x1="0" x2="0" y1="' + pt + '" y2="' + (H - pb) + '" stroke="#ffffff55" style="display:none"/></svg><div class="legend">' + series.map(function (s) { var last = s.points[s.points.length - 1]; return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + (last ? ' <b>' + Math.round(last[1]) + '</b>' : '') + '</span>'; }).join('') + '</div><div class="tip"></div>';
    var svg = el.querySelector('svg'), cur = el.querySelector('.cur'), tip = el.querySelector('.tip');
    svg.addEventListener('mousemove', function (e) { var r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W, t = t0 + (x - pl) / (W - pl - pr) * (t1 - t0);
      cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.style.display = '';
      var d = new Date(t); tip.innerHTML = '<b>' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':00</b>' + series.map(function (s) { var best = null; s.points.forEach(function (p) { if (!best || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p; }); return best ? '<div><i style="background:' + s.color + '"></i>' + esc(s.name) + ' ' + Math.round(best[1]) + '</div>' : ''; }).join('');
      tip.style.display = 'block'; tip.style.left = Math.min(r.width - 140, e.clientX - r.left + 12) + 'px'; });
    svg.addEventListener('mouseleave', function () { cur.style.display = 'none'; tip.style.display = 'none'; });
  }
  function bars(el, rows) { // rows: [{name,value,base,color,max}]
    el.innerHTML = rows.map(function (r) { var mx = r.max || 100, p = Math.max(0, Math.min(100, r.value / mx * 100)), b = r.base != null ? r.base / mx * 100 : null;
      return '<div class="hb"><span class="n">' + esc(r.name) + '</span><span class="tr"><span class="fi" style="width:' + p + '%;background:' + r.color + '"></span>' + (b != null ? '<span class="bs" style="left:' + b + '%" title="基线 ' + r.base + '"></span>' : '') + '</span><span class="v">' + (Math.round(r.value * 10) / 10) + '</span></div>'; }).join('');
  }
  window.Charts = { line: line, bars: bars };
})();
