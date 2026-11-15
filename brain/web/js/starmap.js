/* 记忆星图：旋臂星系 + 记忆星 + 关联线 + 召回脉冲 + 相机飞行。
 * 移植自 companion-memory/pages/atlas3d（MIT），加了：飞到某颗星、筛选、列表、/pulses 召回脉冲、工作台联动。
 * 所有可调参数在 js/config.js。 */
(function () {
  var CFG = window.BRAIN_CONFIG, GC = CFG.galaxy, SC = CFG.star, CC = CFG.camera, PC = CFG.pulse;
  // ---------- 星海生长（config.growth）：关掉时下面全部不生效，星系与旧版完全一致 ----------
  var GR = CFG.growth || {}, QS = new URLSearchParams(location.search), GROW = QS.get('growth') === '0' ? false : QS.get('growth') === '1' ? true : !!GR.enabled;
  var LOW = QS.get('lowend') === '1' ? true : QS.get('lowend') === '0' ? false : GR.lowEnd === true || (GR.lowEnd === 'auto' && (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || (navigator.hardwareConcurrency || 8) <= 4));
  var DUSTCAP = Math.max(1000, (LOW ? GR.dustMaxLow : GR.dustMax) || 80000);
  // ---------- 主题（config.theme）：'cosmos' 新版宇宙星图 | 'classic' v2 彩色星图。classic 下面所有 COS 分支都不生效 ----------
  var THEME = QS.get('theme') || (function () { try { return localStorage.getItem('brain.theme'); } catch (e) { return null; } })() || CFG.theme || 'cosmos'; if (THEME !== 'classic') THEME = 'cosmos';
  var COS = THEME === 'cosmos', KC = CFG.cosmos || {}, TC = CFG.tiers || {}, LK = KC.links || {}, LKS = LOW ? (LK.lowEndScale == null ? .4 : LK.lowEndScale) : 1, AS = COS ? (KC.armSpread || 1) : 1;
  document.body.classList.add(COS ? 'cosmos' : 'classic'); if (COS && KC.coreLabel) document.body.classList.add('cos-corelabel');
  if (COS) { CC = Object.assign({}, CC, { phi: KC.camPhi || CC.phi, distance: CC.distance * (KC.camDistance || 1) }); GC = Object.assign({}, GC, { dustSize: KC.dustSize || GC.dustSize, dustOpacity: KC.dustOpacity || GC.dustOpacity }); }
  function dustCol(col, core, b) { var S = KC.dustSaturation == null ? .14 : KC.dustSaturation, l = Math.random(); if (core) col.setHSL(.74 + .05 * b, S * .9, .2 + .28 * l); else if (b < .07) col.setHSL(.09, S * 2.2, .55 + .3 * l); else if (b < .15) col.setHSL(.6, S * 2.4, .58 + .3 * l); else col.setHSL(.69 + .07 * b, S, .42 + .45 * l); }
  function armsFor(n) { var a = GC.arms; (GR.armSteps || []).slice().sort(function (x, y) { return x.min - y.min; }).forEach(function (st) { if (n >= st.min) a = st.arms; }); return Math.max(1, Math.min(GR.maxArms || 6, a | 0)); }
  function growT(n) { var F = Math.max(1, GR.radiusFullAt || 5000), x = Math.max(0, Math.min(1, n / F)); if (GR.radiusCurve === 'linear') return x; if (GR.radiusCurve === 'sqrt') return Math.sqrt(x); var k = Math.max(1, GR.radiusLogK || 150); return Math.min(1, Math.log(1 + Math.max(0, n) / k) / Math.log(1 + F / k)); }
  function radiusFor(n) { var a = GR.radiusMin || GC.radius, b = GR.radiusMax || a; return a + (b - a) * growT(n); }
  function dustFor(n) { return Math.max(0, Math.min(DUSTCAP, Math.round((GR.dustBase || 0) + (GR.dustPerMemory || 0) * n))); }
  var GS = { n: -1, A0: GC.arms, A1: GC.arms, M: 1, R: GC.radius, tR: GC.radius, f: 0, tf: 0, c: 0, tc: 0 }, GL = null, gDustMat = null, gDust = null, hud = null, lastSig = '';
  function homeDist() { return GROW && GR.cameraFollow !== false ? CC.distance * GS.tR / GC.radius : CC.distance; }
  function maxDist() { return GROW && GR.cameraFollow !== false ? CC.maxDist * Math.max(1, GS.tR / GC.radius) : CC.maxDist; }
  var API = window.BrainAPI, U8 = API.util, esc = U8.esc;
  var $ = function (i) { return document.getElementById(i); };
  var DATA = null, stars = [], byId = {}, adj = {}, sel = null, PRIMARY = 'dafeiyu', PN = {};
  var filt = { groups: {}, personas: {}, scopes: {}, until: null, query: '', hits: null };
  var listeners = { select: [] };

  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }
  function pname(p) { return PN[p] || p || ''; }
  function kindInfo(s) { if (s.item) return CFG.itemTypes[s.type] || { label: s.type, color: '#ffffff' }; return CFG.kinds[s.kind] || { label: s.kind || '记忆', color: '#e6e0ff' }; }
  function titleOf(s) { if (s.core) return '原意识 · ' + pname(s.persona); if (s.title) return s.title; var c = String(s.content || '').trim(), m = c.match(/^【[^】]*】\s*([^\n]+)/); var t = m ? m[1] : c.split('\n')[0]; t = t.replace(/[，。！？,.!?].*$/, function (x) { return t.length > 22 ? '' : x; }) || t; return t.length > 22 ? t.slice(0, 22) + '…' : t; }
  function excerptOf(s) { var c = String(s.content || '').trim(); c = c.replace(/^【[^】]*】/, '').replace(/[*#`>_~]+/g, ' ').replace(/\s+/g, ' ').trim(); return c.length > 70 ? c.slice(0, 70) + '…' : c; }

  // ---------- three ----------
  var cv = $('gl'), R;
  try { R = new THREE.WebGLRenderer({ canvas: cv, alpha: false, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false }); }
  catch (e) { $('msg').textContent = '这台设备不支持 WebGL，星图无法显示（工作台仍可使用）。'; window.StarMap = { onSelect: function () {}, reload: function () {}, focus: function () {}, select: function () {}, ok: false }; return; }
  R.setPixelRatio(Math.min(2, devicePixelRatio || 1)); R.setClearColor(COS ? new THREE.Color(KC.background || '#030207') : 0x01030a, 1);
  var scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(CC.fov, 1, 1, 6000), G = new THREE.Group(); scene.add(G);
  var orb = { th: CC.theta, ph: CC.phi, d: CC.distance, tth: CC.theta, tph: CC.phi, td: CC.distance }, idleT = 0, lastT = performance.now();
  var focus = new THREE.Vector3(0, -20, 0), focusT = new THREE.Vector3(0, -20, 0), flying = null;
  var U = { uTime: { value: 0 }, uScale: { value: 800 }, uSel: { value: -1 }, uFar: { value: new THREE.Vector2(380, 1100) } };
  function resize() { var w = innerWidth, h = innerHeight; R.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); orb.base = w < h ? 1.25 : 1; U.uScale.value = h * R.getPixelRatio() / (2 * Math.tan(cam.fov * Math.PI / 360)); if (gDustMat) gDustMat.uniforms.uHalf.value = h * R.getPixelRatio() / 2; }
  function softTex(stops) { var c = document.createElement('canvas'); c.width = c.height = 128; var x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64); stops.forEach(function (s) { g.addColorStop(s[0], s[1]); }); x.fillStyle = g; x.fillRect(0, 0, 128, 128); var t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }
  var addB = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor };
  function glowMat(m) { m.blending = THREE.CustomBlending; m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneFactor; m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; return m; }
  // 天空渐变 + 底部青绿极光
  U.uAur = { value: GC.auroraStrength }; U.uHz = { value: KC.haze == null ? .55 : KC.haze }; U.uHc = { value: new THREE.Vector3().fromArray(KC.hazeColor || [.32, .25, .48]) };
  U.uGold = { value: new THREE.Color(KC.gold || '#f3cf8a') };
  // 宇宙主题：近黑底 + 中间一团很淡的薰衣草紫雾 + 四角压暗
  var SKY_FS_COS = 'uniform float uTime,uHz;uniform vec3 uHc;varying vec2 vU;void main(){vec2 p=vU-vec2(.5,.47);p.x*=1.7;float r=length(p);vec3 col=vec3(.008,.006,.014)+uHc*uHz*(.15*exp(-r*r*6.)+.05*exp(-r*r*1.3));col*=1.-.45*smoothstep(.35,1.,r);gl_FragColor=vec4(col,1.);}';
  var SKY = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({ uniforms: U, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vU;void main(){vU=position.xy*.5+.5;gl_Position=vec4(position.xy,.9999,1.);}',
    fragmentShader: COS ? SKY_FS_COS : 'uniform float uTime,uAur;varying vec2 vU;\n' +
      'float blob(vec2 u,vec2 c,vec2 r){vec2 d=(u-c)/r;return exp(-dot(d,d)*2.2);}\n' +
      'void main(){float y=vU.y;vec3 a=vec3(.047,.227,.251),b=vec3(.039,.169,.235),c=vec3(.027,.106,.2),d=vec3(.016,.047,.125),e=vec3(.004,.012,.039);\n' +
      'vec3 col=y<.16?mix(a,b,y/.16):y<.4?mix(b,c,(y-.16)/.24):y<.66?mix(c,d,(y-.4)/.26):mix(d,e,(y-.66)/.34);\n' +
      'float t=uTime;vec2 u=vU+vec2(.03*sin(t*.24),.01*sin(t*.17));\n' +
      'col+=uAur*(vec3(.18,.83,.6)*.22*blob(u,vec2(.22,.14),vec2(.4,.22))+vec3(.22,.76,.77)*.2*blob(u,vec2(.78,.22),vec2(.3,.18))+vec3(.36,.94,.69)*.16*blob(u,vec2(.5+.03*sin(t*.18),.04),vec2(.55,.14))+vec3(.23,.66,1.)*.1*blob(u,vec2(.85,.08),vec2(.26,.12)));\n' +
      'gl_FragColor=vec4(col,1.);}' }));
  SKY.frustumCulled = false; SKY.renderOrder = -10; scene.add(SKY);
  (function () { var N = GC.bgStars, p = new Float32Array(N * 3), c = new Float32Array(N * 3); for (var i = 0; i < N; i++) { var u = Math.random() * 2 - 1, a = Math.random() * 6.283, r = 1800 + Math.random() * 1600, s = Math.sqrt(1 - u * u); p[i * 3] = r * s * Math.cos(a); p[i * 3 + 1] = r * u; p[i * 3 + 2] = r * s * Math.sin(a); var k = .55 + Math.random() * .45, b = Math.random(); c[i * 3] = k * (COS ? .96 : b < .2 ? 1 : .8); c[i * 3 + 1] = k * (COS ? .94 : .9); c[i * 3 + 2] = k; }
    var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    scene.add(new THREE.Points(g, glowMat(new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: .75, depthWrite: false })))); })();
  var ARMS = GC.arms, RMAX = GC.radius;
  function armPos(r, arm, jit, y) { var a = arm * Math.PI * 2 / ARMS + Math.log(Math.max(r, 8) / 14) * GC.armTwist + jit; return [Math.cos(a) * r, y, Math.sin(a) * r]; }
  function gauss() { return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; }
  if (!GROW) (function () { var N = GC.dustCount, p = new Float32Array(N * 3), c = new Float32Array(N * 3), col = new THREE.Color(); for (var i = 0; i < N; i++) {
      var r, q, t, k = Math.random();
      if (k < .12) { r = Math.pow(Math.random(), 1.6) * 70 + 2; var a = Math.random() * 6.283, u = gauss(); q = [Math.cos(a) * r, u * 12 * (1 - r / 80), Math.sin(a) * r]; t = 0; }
      else { r = Math.pow(Math.random(), .6) * RMAX * 1.1 + 14; var arm = i % ARMS, sub = (k > .85 ? ((i >> 1) % 3 - 1) * .55 : 0), w = (k < .3 ? 2.2 : (k < .7 ? .5 : .2)) * AS; q = armPos(r, arm, sub + gauss() * w * (.55 + r / RMAX * .6), gauss() * (6 + 5 * (1 - r / RMAX))); q[0] += gauss() * 3; q[2] += gauss() * 3; t = Math.min(1, r / RMAX); }
      p.set(q, i * 3); var b = Math.random();
      if (COS) dustCol(col, t === 0 || r < 60, b); else if (t === 0 || r < 60) col.setHSL(.1 + .03 * b, .65, .45 + .25 * Math.random()); else if (b < .08) col.setHSL(.75, .45, .6); else if (b < .16) col.setHSL(.1, .5, .62); else col.setHSL(.57 + .06 * Math.random(), .45, .5 + .3 * Math.random());
      var dim = k >= .12 && k < .3 ? .4 : .85; c.set([col.r * dim, col.g * dim, col.b * dim], i * 3); }
    var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    G.add(new THREE.Points(g, glowMat(new THREE.PointsMaterial({ size: GC.dustSize, map: softTex([[0, 'rgba(255,255,255,1)'], [.35, 'rgba(255,255,255,.4)'], [1, 'rgba(255,255,255,0)']]), vertexColors: true, transparent: true, opacity: GC.dustOpacity, depthWrite: false })))); })();
  // 生长星尘：粒子只存「归一化半径 / 旋臂编号种子 / 抖动」，真实位置在着色器里按当前旋臂数和半径实时计算，
  // 所以旋臂数变化时可以平滑展开，半径变化时整体缓慢外扩；粒子数用 drawRange 控制，不重建缓冲区。
  var DUST_VS = 'attribute vec4 aD,aE;attribute vec3 aCol;attribute float aRank;uniform float uA0,uA1,uM,uR,uTw,uSize,uHalf,uFrac,uCoreS;varying vec3 vC;varying float vA;\n' +
    'void main(){vec3 p;if(aE.w>.5){p=position*uCoreS;}else{float r=aD.x*uR+14.,tn=r/uR;float b0=floor(aD.y*uA0)*6.2831853/uA0,b1=floor(aD.y*uA1)*6.2831853/uA1,dd=b1-b0;dd-=6.2831853*floor((dd+3.14159265)/6.2831853);' +
    'float a=b0+dd*uM+log(max(r,8.)/14.)*uTw+aD.z+aD.w*(.55+tn*.6);p=vec3(cos(a)*r+aE.y,aE.x*(6.+5.*(1.-tn)),sin(a)*r+aE.z);}' +
    'vec4 mv=modelViewMatrix*vec4(p,1.);gl_PointSize=uSize*uHalf/max(-mv.z,.001);vC=aCol;vA=1.-smoothstep(uFrac-.015,uFrac,aRank);gl_Position=projectionMatrix*mv;}';
  var DUST_FS = 'uniform sampler2D map;uniform float uOp;varying vec3 vC;varying float vA;void main(){if(vA<.004)discard;vec4 t=texture2D(map,gl_PointCoord);gl_FragColor=vec4(vC,uOp*vA)*t;\n#include <colorspace_fragment>\n}';
  if (GROW) (function () { var N = DUSTCAP, P = new Float32Array(N * 3), C = new Float32Array(N * 3), D = new Float32Array(N * 4), E = new Float32Array(N * 4), RK = new Float32Array(N), col = new THREE.Color();
    for (var i = 0; i < N; i++) { var k = Math.random(), r, isC = k < .12;
      if (isC) { r = Math.pow(Math.random(), 1.6) * 70 + 2; var a = Math.random() * 6.283, u = gauss(); P[i * 3] = Math.cos(a) * r; P[i * 3 + 1] = u * 12 * (1 - r / 80); P[i * 3 + 2] = Math.sin(a) * r; E[i * 4 + 3] = 1; }
      else { var rn = Math.pow(Math.random(), .6) * 1.1, w = (k < .3 ? 2.2 : (k < .7 ? .5 : .2)) * AS; r = rn * GC.radius + 14;
        D[i * 4] = rn; D[i * 4 + 1] = (i * 0.6180339887498949) % 1; D[i * 4 + 2] = k > .85 ? ((i >> 1) % 3 - 1) * .55 : 0; D[i * 4 + 3] = gauss() * w;
        E[i * 4] = gauss(); E[i * 4 + 1] = gauss() * 3 * AS; E[i * 4 + 2] = gauss() * 3 * AS; }
      RK[i] = (i + .5) / N; var b = Math.random();
      if (COS) dustCol(col, isC || r < 60, b); else if (isC || r < 60) col.setHSL(.1 + .03 * b, .65, .45 + .25 * Math.random()); else if (b < .08) col.setHSL(.75, .45, .6); else if (b < .16) col.setHSL(.1, .5, .62); else col.setHSL(.57 + .06 * Math.random(), .45, .5 + .3 * Math.random());
      var dim = k >= .12 && k < .3 ? .4 : .85; C[i * 3] = col.r * dim; C[i * 3 + 1] = col.g * dim; C[i * 3 + 2] = col.b * dim; }
    var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('aCol', new THREE.BufferAttribute(C, 3)); g.setAttribute('aD', new THREE.BufferAttribute(D, 4)); g.setAttribute('aE', new THREE.BufferAttribute(E, 4)); g.setAttribute('aRank', new THREE.BufferAttribute(RK, 1));
    gDustMat = glowMat(new THREE.ShaderMaterial({ uniforms: { uA0: { value: GS.A0 }, uA1: { value: GS.A1 }, uM: { value: 1 }, uR: { value: GS.R }, uTw: { value: GC.armTwist }, uSize: { value: GC.dustSize }, uHalf: { value: 400 }, uFrac: { value: 0 }, uCoreS: { value: 1 }, uOp: { value: GC.dustOpacity },
      map: { value: softTex([[0, 'rgba(255,255,255,1)'], [.35, 'rgba(255,255,255,.4)'], [1, 'rgba(255,255,255,0)']]) } }, vertexShader: DUST_VS, fragmentShader: DUST_FS, transparent: true, depthWrite: false }));
    gDust = new THREE.Points(g, gDustMat); gDust.frustumCulled = false; g.setDrawRange(0, 0); G.add(gDust);
    if (GR.hud !== false) { var sr = COS ? $('cmeta') : document.querySelector('.subrow'); if (sr) { if (COS) sr.classList.add('hashud'); hud = document.createElement('span'); hud.id = 'ghud'; hud.title = '星海生长：记忆越多，星系越大、旋臂越多'; hud.style.cssText = 'margin-left:auto;padding-left:8px;white-space:nowrap;color:#f6d38b;opacity:.8;letter-spacing:.5px'; sr.appendChild(hud); } } })();
  // 根据记忆数算出目标形态；first = 第一次加载（直接到位，不播动画）
  function growTo(n, first) {
    var A = armsFor(n), Rt = radiusFor(n), f = DUSTCAP ? dustFor(n) / DUSTCAP : 0, c = growT(n);
    if (first) { GS.A0 = GS.A1 = A; GS.M = 1; GS.R = GS.tR = Rt; GS.f = GS.tf = f; GS.c = GS.tc = c; }
    else { if (A !== GS.A1) { GS.A0 = GS.M < .5 ? GS.A0 : GS.A1; GS.A1 = A; GS.M = 0; } GS.tR = Rt; GS.tf = f; GS.tc = c; }
    GS.n = n; ARMS = A; RMAX = Rt;
    if (GR.cameraFollow !== false && !sel) { orb.td = homeDist(); if (first) orb.d = orb.td; }
    hudText();
  }
  function hudText() { if (hud) hud.textContent = '记忆 ' + GS.n + ' · 旋臂 ' + GS.A1 + (GS.M < 1 || GL || Math.abs(GS.tR - GS.R) > 2 ? ' · 生长中…' : ''); }
  function easeIO(x) { return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }
  // 每帧推进生长动画：旋臂展开、半径/星尘/核心缓动、星点滑到新位置
  function growTick(dt) {
    var T = Math.max(.3, GR.animSeconds || 4), ka = 1 - Math.pow(.015, dt / T), was = GS.M < 1 || GL;
    if (GS.M < 1) GS.M = Math.min(1, GS.M + dt / T);
    GS.R += (GS.tR - GS.R) * ka; GS.f += (GS.tf - GS.f) * ka; GS.c += (GS.tc - GS.c) * ka;
    var u = gDustMat.uniforms, m = easeIO(GS.M); u.uA0.value = GS.A0; u.uA1.value = GS.A1; u.uM.value = m; u.uR.value = GS.R; u.uFrac.value = GS.f; u.uCoreS.value = 1 + (GR.coreGrow || 0) * GS.c * .6;
    gDust.geometry.setDrawRange(0, Math.min(DUSTCAP, Math.ceil((GS.f + .02) * DUSTCAP)));
    var rr = GR.cameraFollow !== false ? GS.R / GC.radius : 1; U.uFar.value.set(380 * rr, 1100 * rr);
    if (GL) { GL.t = Math.min(1, GL.t + dt / T); var e = easeIO(GL.t); GL.list.forEach(function (x) { x[0].p.lerpVectors(x[1], x[2], e); }); GL.pl.forEach(function (x) { x.p.lerpVectors(x.from, x.to, e); }); refreshGeom(); if (GL.t >= 1) { GL = null; starGeo.computeBoundingSphere(); if (sel && !sel.core && byId[sel.id] === sel) select(sel, { keepCam: true }); } }
    if (was || Math.abs(GS.tR - GS.R) > .5) hudText();
  }
  function refreshGeom() {
    if (!starGeo) return; var P = starGeo.attributes.position.array; stars.forEach(function (s, i) { P[i * 3] = s.p.x; P[i * 3 + 1] = s.p.y; P[i * 3 + 2] = s.p.z; }); starGeo.attributes.position.needsUpdate = true;
    var LP = assoc.geometry.attributes.position.array; assoc.userData.L.forEach(function (l, i) { var a = byId[l.a].p, b = byId[l.b].p; LP[i * 6] = a.x; LP[i * 6 + 1] = a.y; LP[i * 6 + 2] = a.z; LP[i * 6 + 3] = b.x; LP[i * 6 + 4] = b.y; LP[i * 6 + 5] = b.z; }); assoc.geometry.attributes.position.needsUpdate = true;
    var LP2 = lines.geometry.attributes.position.array; (lines.userData.SEG || []).forEach(function (x, j) { var a = x[0], b = x[1]; LP2[j * 6] = a.x; LP2[j * 6 + 1] = a.y; LP2[j * 6 + 2] = a.z; LP2[j * 6 + 3] = b.x; LP2[j * 6 + 4] = b.y; LP2[j * 6 + 5] = b.z; }); lines.geometry.attributes.position.needsUpdate = true;
    if (sel && !sel.core) selRing.position.copy(sel.p);
  }
  var cc = GC.coreColor;
  var core = new THREE.Sprite(glowMat(new THREE.SpriteMaterial({ map: COS ? softTex([[0, 'rgba(255,255,255,1)'], [.1, 'rgba(242,238,255,.7)'], [.3, 'rgba(196,182,240,.2)'], [.6, 'rgba(150,130,220,.05)'], [1, 'rgba(120,100,200,0)']]) : softTex([[0, cc[0]], [.12, cc[1]], [.3, cc[2]], [.6, 'rgba(220,160,90,.12)'], [1, 'rgba(200,140,80,0)']]), depthWrite: false, transparent: true }))); core.scale.set(GC.coreSize, GC.coreSize, 1); G.add(core);
  var bulge = new THREE.Sprite(glowMat(new THREE.SpriteMaterial({ map: COS ? softTex([[0, 'rgba(232,224,255,.95)'], [.12, 'rgba(200,188,245,.5)'], [.3, 'rgba(150,135,215,.14)'], [.6, 'rgba(110,95,180,.03)'], [1, 'rgba(90,80,160,0)']]) : softTex([[0, 'rgba(255,214,150,.55)'], [.35, 'rgba(240,190,120,.16)'], [1, 'rgba(120,120,255,0)']]), depthWrite: false, transparent: true }))); bulge.scale.set(GC.bulgeSize, GC.bulgeSize, 1); G.add(bulge);
  var selRing = new THREE.Sprite(glowMat(new THREE.SpriteMaterial({ map: COS ? softTex([[0, 'rgba(255,240,205,.95)'], [.22, 'rgba(243,207,138,.38)'], [1, 'rgba(243,207,138,0)']]) : softTex([[0, 'rgba(255,245,220,.9)'], [.25, 'rgba(200,225,255,.35)'], [1, 'rgba(150,190,255,0)']]), depthWrite: false, transparent: true }))); selRing.visible = false; G.add(selRing);
  // 宇宙主题：中间两颗一直亮着的双星（原意识），互相绕转；核心光晕换成大片淡紫色
  var BULGE = COS ? GC.radius * (KC.glowSize || 2.6) : GC.bulgeSize, CORE_S = COS ? GC.coreSize * .45 : GC.coreSize, twins = [];
  if (COS) { bulge.scale.set(BULGE, BULGE, 1); bulge.material.opacity = KC.glowStrength == null ? .42 : KC.glowStrength; core.material.opacity = .5;
    var twT = softTex([[0, 'rgba(255,255,255,1)'], [.07, 'rgba(255,255,255,.96)'], [.18, 'rgba(238,234,255,.42)'], [.45, 'rgba(190,180,255,.07)'], [1, 'rgba(150,140,255,0)']]);
    for (var ti = 0; ti < 2; ti++) { var tws = new THREE.Sprite(glowMat(new THREE.SpriteMaterial({ map: twT, depthWrite: false, transparent: true }))); tws.scale.set(KC.twinSize || 58, KC.twinSize || 58, 1); G.add(tws); twins.push(tws); } }

  var STAR_VS = 'attribute vec3 aColor;attribute vec4 aChain;attribute float aSize,aBright,aPin,aItem,aMatch,aId,aPh,aFlare,aGold;uniform float uTime,uScale,uSel;uniform vec2 uFar;uniform vec3 uGold;varying vec3 vC;varying float vA,vFar,vPin,vItem;\n' +
    'void main(){vec4 mv=modelViewMatrix*vec4(position,1.);float d=-mv.z;vFar=smoothstep(uFar.x,uFar.y,d);float tw=(1.-' + SC.twinkle.toFixed(3) + ')+' + SC.twinkle.toFixed(3) + '*sin(uTime*(.6+aPh*.25)+aPh*6.28);float s=aId==uSel?1.6:1.;float hd=mod(uTime*aChain.z+aChain.w,aChain.y),dd=hd-aChain.x;float bo=(exp(-dd*dd*7.)+(dd>0.?exp(-dd*.7)*.4:0.))*step(-50.,aChain.x);s*=1.+.6*bo+aFlare*.9+.3*aGold;\n' +
    'gl_PointSize=clamp(aSize*s*uScale/d,6.,160.);vC=mix(mix(mix(aColor,vec3(.45,.55,.85),vFar*.4),vec3(1.,.96,.85),min(1.,aFlare*.5)),uGold,aGold*.85);vA=aBright*aMatch*tw*(1.-.5*vFar)*(1.+1.4*bo+aFlare*' + PC.flareGain.toFixed(2) + ')*(1.+.5*aGold);vPin=aPin+bo*1.6+aFlare*1.5;vItem=aItem;gl_Position=projectionMatrix*mv;}';
  var STAR_FS = 'varying vec3 vC;varying float vA,vFar,vPin,vItem;\n' +
    'void main(){vec2 u=gl_PointCoord*2.-1.;float r=length(u);if(r>1.)discard;\n' +
    'float hb=step(2.,vPin);float core=exp(-r*r*mix(55.,140.,hb));float glow=exp(-r*r*mix(5.,7.,hb))*mix(.75,1.1,hb)+hb*exp(-r*r*2.2)*.25;float fl=(exp(-abs(u.x)*mix(30.,55.,hb))*exp(-u.y*u.y*mix(5.,2.2,hb))+exp(-abs(u.y)*mix(30.,55.,hb))*exp(-u.x*u.x*mix(5.,2.2,hb)))*(.25+.35*min(vPin,3.));\n' +
    'float dia=vItem*(1.-smoothstep(.0,.06,abs(abs(u.x)+abs(u.y)-.42)))*.5;\n' +
    'vec3 c=vC*(glow*1.2+fl+dia)+mix(vC,vec3(1.),.7)*core*1.3;gl_FragColor=vec4(c*vA*(1.-r*r*.3),1.);}';
  var LINE_VS = 'attribute vec4 aCol;attribute vec4 aChain;uniform float uTime;uniform vec2 uFar;varying vec4 vC;varying float vT,vH,vP,vOn;void main(){vT=aChain.x;vP=aChain.w;vOn=step(-50.,aChain.x);vH=mod(uTime*aChain.z+aChain.w,max(aChain.y,.001));vec4 mv=modelViewMatrix*vec4(position,1.);float f=smoothstep(uFar.x,uFar.y,-mv.z);vC=vec4(aCol.rgb,aCol.a*(1.-.7*f));gl_Position=projectionMatrix*mv;}';
  var LINE_FS = 'uniform float uTime;varying vec4 vC;varying float vT,vH,vP,vOn;void main(){float d=vH-vT;float lit=d>=0.?exp(-d*d*28.)+exp(-d*.8)*.3:exp(-d*d*60.);float sh=.82+.18*sin(vT*5.-uTime*1.1+vP*7.);float a=vC.a*mix(1.,sh*(1.+3.2*lit),vOn);gl_FragColor=vec4(mix(vC.rgb,vec3(1.),.45*lit*vOn)*a,1.);}';
  function lineMat() { return new THREE.ShaderMaterial(Object.assign({ uniforms: U, vertexShader: LINE_VS, fragmentShader: LINE_FS }, addB)); }
  var BG = null, starGeo = null, starPts = null, assoc = null, lines = null, selLines = null, CH = [], selChains = [], PL = [];
  var beadTex = softTex([[0, 'rgba(255,255,255,1)'], [.18, 'rgba(255,255,255,.55)'], [.45, 'rgba(255,255,255,.12)'], [1, 'rgba(255,255,255,0)']]);
  var NB = 96 + PC.maxBeads, BP = new Float32Array(NB * 3), BC = new Float32Array(NB * 3), bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(BP, 3)); bg.setAttribute('color', new THREE.BufferAttribute(BC, 3));
  var beads = new THREE.Points(bg, glowMat(new THREE.PointsMaterial({ size: PC.beadSize, map: beadTex, vertexColors: true, transparent: true, depthWrite: false }))); beads.frustumCulled = false; G.add(beads);
  var flares = {}, flights = [];  // 召回脉冲：星点闪耀 + 沿线飞行的光点

  function build(d) {
    DATA = d; PRIMARY = d.primary || 'dafeiyu'; PN = {};
    var prevPos = null, prevPL = null;
    if (GROW) { lastSig = sigOf(d); var first = GS.n < 0; if (!first && stars.length) { prevPos = {}; stars.forEach(function (s) { if (s.p) prevPos[s.id] = s.p.clone(); }); prevPL = {}; PL.forEach(function (x) { prevPL[x.pid] = x.p.clone(); }); } growTo(d.stars.length, first); GL = null; }
    (d.personas || []).forEach(function (p) { if (p.name) PN[p.id] = p.name; });
    if (BG) { G.remove(BG); BG.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
    BG = new THREE.Group(); G.add(BG); byId = {}; adj = {}; CH = []; selChains = [];
    var nowT = Date.now(); d.stars.forEach(function (s) { s.type = 'memory'; if (!s.persona) s.persona = PRIMARY; });
    (d.items || []).forEach(function (it) { var t = U8.pd(it.created_at), age = t ? Math.max(0, (nowT - t) / 864e5) : 365;
      d.stars.push({ id: it.id, item: true, type: it.type, persona: it.persona || PRIMARY, kind: it.type, title: it.title, content: it.content, extra: it.extra, created_at: it.created_at, tags: [], importance: (it.type === 'novel' || it.type === 'diary' || it.type === 'dream') ? 3 : 2, recall_count: 0, pinned: false, state: 'clear', strength: .45 + .5 * Math.exp(-age / 90) }); });
    stars = d.stars; var N = stars.length;
    var score = function (a) { return (a.pinned ? 2 : 0) + a.importance * .5 + Math.log2(1 + (a.recall_count || 0)) * .7 + (a.item ? -1.5 : 0) + hash(a.id + 'h') * .3; };
    var COREs = stars.filter(function (s) { return s.persona === PRIMARY; }), OTH = stars.filter(function (s) { return s.persona !== PRIMARY; });
    var heroes = COREs.slice().sort(function (a, b) { return score(b) - score(a); }).slice(0, Math.min(GC.heroCount, N)); heroes.forEach(function (s, k) { s.hero = 1; s.hk = k; });
    var ord = COREs.filter(function (s) { return !s.hero; }).sort(function (a, b) { return hash(a.id) - hash(b.id); }); var NO = Math.max(1, ord.length);
    var GD = new Float32Array(N), CQ = new Float32Array(N * 4), P = new Float32Array(N * 3), C = new Float32Array(N * 3), S = new Float32Array(N), B = new Float32Array(N), PIN = new Float32Array(N), IT = new Float32Array(N), M = new Float32Array(N), ID = new Float32Array(N), PH = new Float32Array(N), FL = new Float32Array(N), col = new THREE.Color();
    ord.forEach(function (s, j) { var r = 34 + (RMAX - 34) * Math.pow((j + .5) / NO, .85), h1 = hash(s.id + 'a'), h2 = hash(s.id + 'b'), h3 = hash(s.id + 'c');
      var q = armPos(r, Math.floor(h1 * ARMS), ((h2 + hash(s.id + 'd') + hash(s.id + 'e')) / 3 - .5) * (1.5 + r / RMAX * .6), (h3 - .5) * (26 * (1 - r / RMAX * .55))); s.p = new THREE.Vector3(q[0], q[1], q[2]); });
    var hperm = heroes.map(function (s, k) { return k; }).sort(function (a, b) { return hash('hp' + a) - hash('hp' + b); });
    heroes.forEach(function (s, k) { var t = (hperm[k] + .5) / heroes.length, r = 70 + (RMAX - 60) * t, q = armPos(r, k % ARMS, (hash(s.id + 'j') - .5) * .5, (hash(s.id + 'y') - .5) * 14); s.p = new THREE.Vector3(q[0], q[1], q[2]); });
    if (COS) cosLayout(COREs, nowT, score);
    // 主链：英雄星最近邻串起
    var hc = heroes.length ? [heroes.slice().sort(function (a, b) { return a.p.length() - b.p.length(); })[0]] : [], rem = heroes.filter(function (x) { return x !== hc[0]; });
    while (rem.length) { var last = hc[hc.length - 1]; rem.sort(function (a, b) { return a.p.distanceTo(last.p) - b.p.distanceTo(last.p); }); hc.push(rem.shift()); }
    if (!COS && hc.length > 1) CH.push({ pts: hc.map(function (x) { return x.p; }), st: hc, x: [], n: hc.length - 1, sp: .4, ph: 0, cyc: hc.length - 1 + 5, col: new THREE.Color(.75, .86, 1), la: .2 });
    function hg(k) { return (hash(k + '1') + hash(k + '2') + hash(k + '3') - 1.5) / 1.5; }
    var arc = [0, 1, 2, 3, 4, 5].map(function (i) { var a = Math.PI * (.12 + .76 * i / 5); return [Math.cos(a) * 2, -Math.sin(a) * 1.1]; });
    var TPL = [{ p: [[0, 0], [1, .15], [2, .1], [3, .35], [3.2, 1.25], [4.3, 1.45], [4.5, .55]], path: [0, 1, 2, 3, 4, 5, 6, 3], x: [] },
      { p: [[0, 0], [2, .1], [.7, 1.2], [1, 1.3], [1.3, 1.4], [.1, 2.6], [2.1, 2.5]], path: [0, 2, 3, 4, 6], x: [[0, 1], [1, 4], [2, 5]] },
      { p: [[0, 0], [0, 1], [0, 2], [0, 3], [-1.3, 1.1], [1.3, .9]], path: [0, 1, 2, 3], x: [[4, 1], [1, 5]] },
      { p: arc, path: [0, 1, 2, 3, 4, 5], x: [] },
      { p: [[0, 0], [1, -1], [2, -.2], [3, -1.1], [4, -.1]], path: [0, 1, 2, 3, 4], x: [] },
      { p: [[.45, 1.1], [0, 0], [.5, -.8], [1.4, -.8], [.9, 0]], path: [0, 1, 2, 3, 4, 1], x: [] },
      { p: [[0, 0], [1, 1.5], [2, 0], [1, -.9]], path: [0, 1, 2, 3, 0], x: [] },
      { p: [[0, 0], [1.5, .4], [.6, 1.3]], path: [0, 1, 2, 0], x: [] },
      { p: [[0, 0], [1.4, .5]], path: [0, 1], x: [] }, { p: [[0, 0]], path: [0], x: [] }];
    var HUES = [.5, .58, .66, .74, .83, .92, .98, .04, .14, .3, .44, .54, .7, .88];
    var groups = {}; OTH.forEach(function (x) { (groups[x.persona] = groups[x.persona] || []).push(x); });
    var plist = Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length || (a < b ? -1 : 1); });
    var plab = $('plab'); plab.innerHTML = ''; PL = [];
    plist.forEach(function (pid, k) { var g = groups[pid].sort(function (a, b) { return score(b) - score(a); }), n = g.length;
      var tc = new THREE.Color().setHSL(HUES[k % HUES.length], COS ? .3 : .75, COS ? .8 : .68);
      var ang = k * 2.39996 + .6, rad = (COS ? RMAX * ((TC.grayBand || [1.12, 1.34])[1] + .18) : RMAX + 65) + hash(pid + 'r') * 140 * (RMAX / GC.radius), yy = (hash(pid + 'y') - .5) * 320;
      var ctr = new THREE.Vector3(Math.cos(ang) * rad, yy, Math.sin(ang) * rad);
      var want = Math.min(7, n), fits = TPL.filter(function (t) { return t.p.length <= want && t.p.length >= want - 1; }); if (!fits.length) fits = TPL.filter(function (t) { return t.p.length <= want; });
      var tp = fits[Math.floor(hash(pid + 't') * fits.length)], K = tp.p.length;
      var rd = new THREE.Vector3(ctr.x, 0, ctr.z).normalize(), u = new THREE.Vector3(-rd.z, 0, rd.x), tl = (hash(pid + 'l') - .5) * 1.1, v = new THREE.Vector3(0, Math.cos(tl), 0).addScaledVector(rd, Math.sin(tl)).normalize();
      var ro = (hash(pid + 'o') - .5) * 1.6, cs = Math.cos(ro), sn = Math.sin(ro), sc = 15 + 6 * Math.sqrt(K), mx = 0, my = 0; tp.p.forEach(function (q) { mx += q[0] / K; my += q[1] / K; });
      var pts = []; for (var j = 0; j < K; j++) { var x0 = tp.p[j][0] - mx, y0 = tp.p[j][1] - my, x1 = x0 * cs - y0 * sn, y1 = x0 * sn + y0 * cs; var st = g[j]; st.p = ctr.clone().addScaledVector(u, x1 * sc).addScaledVector(v, y1 * sc); st.cst = 1; st.tint = tc; pts.push(st); }
      for (j = K; j < n; j++) { var f = g[j]; f.p = ctr.clone().add(new THREE.Vector3(hg(f.id + 'x'), hg(f.id + 'y') * .8, hg(f.id + 'z')).multiplyScalar(sc * 1.15)); f.cfaint = 1; f.tint = tc; }
      if (tp.path.length > 1) CH.push({ pts: tp.path.map(function (i) { return pts[i].p; }), st: tp.path.map(function (i) { return pts[i]; }), x: tp.x.map(function (e) { return [pts[e[0]].p, pts[e[1]].p]; }), n: tp.path.length - 1, sp: .36 + hash(pid + 's') * .12, ph: hash(pid + 'p') * 30, cyc: tp.path.length - 1 + 3 + hash(pid + 'c') * 3, col: tc, la: COS ? .1 : .24 });
      var el = document.createElement('div'); el.className = 'clab'; el.textContent = '· ' + pname(pid) + ' ·'; plab.appendChild(el); var lo = 1e9; pts.forEach(function (q) { lo = Math.min(lo, q.p.y); }); PL.push({ el: el, p: new THREE.Vector3(ctr.x, lo - 12, ctr.z), pid: pid }); });
    if (prevPos) { GL = { t: 0, list: [], pl: [] }; var O0 = new THREE.Vector3(0, 0, 0); stars.forEach(function (s) { var o = prevPos[s.id] || O0; if (o.distanceToSquared(s.p) > .25) { GL.list.push([s, o.clone(), s.p.clone()]); s.p.copy(o); } });
      PL.forEach(function (x) { var o = prevPL[x.pid]; if (o && o.distanceToSquared(x.p) > .25) { x.from = o; x.to = x.p.clone(); x.p.copy(o); GL.pl.push(x); } }); if (!GL.list.length && !GL.pl.length) GL = null; }
    CH.forEach(function (ch, ci) { ch.st.forEach(function (x, k) { if (x.chI == null) { x.chI = ci; x.ck = k; } }); });
    stars.forEach(function (s, i) { byId[s.id] = s; adj[s.id] = []; s.i = i; P.set([s.p.x, s.p.y, s.p.z], i * 3);
      var hex = kindInfo(s).color; col.set(hex); var hsl = {}; col.getHSL(hsl);
      col.setHSL(hsl.h, s.hero ? Math.max(.7, hsl.s) : Math.max(.45, Math.min(.75, hsl.s * .8)), s.hero ? .64 : s.pinned ? .66 : .6); C.set([col.r, col.g, col.b], i * 3);
      var str = s.strength == null ? .6 : s.strength, rc = s.recall_count || 0;
      // 大小 = 重要度；亮度 = 清晰度
      S[i] = s.hero ? SC.heroSize + Math.min(3, Math.log2(1 + rc)) * 3 : SC.baseSize * (s.pinned ? SC.pinnedSize + Math.min(4, Math.log2(1 + rc)) * 1.2 : (s.item ? 2.6 : 2.6 + (s.importance >= 4 ? SC.importanceBoost : 0) + (s.importance || 3) * .25 + Math.min(2, Math.log2(1 + rc)) * .6));
      var cl = s.pinned ? 1 : Math.max(SC.minBright, Math.pow(s.clarity != null ? s.clarity : str, .8));
      s.br = s.hero ? .55 + .7 * cl : s.pinned ? .8 : s.item ? .6 : .25 + .75 * cl; B[i] = s.br;
      PIN[i] = s.hero ? 2.2 : s.pinned ? .6 : 0; IT[i] = s.item ? 1 : 0; M[i] = 1; ID[i] = i; PH[i] = hash(s.id + 'p');
      if (s.tint) { var hl = {}; s.tint.getHSL(hl); if (s.cst) { col.setHSL(hl.h, COS ? .3 : .8, COS ? .8 : .66); S[i] = 19 + Math.min(3, Math.log2(1 + rc)) * 2 + (s.pinned ? 4 : 0); s.br = 1.1; PIN[i] = COS ? .7 : 2.2; } else { col.setHSL(hl.h, COS ? .2 : .5, COS ? .68 : .58); S[i] = SC.baseSize * 2.4; s.br = .38; PIN[i] = 0; } C.set([col.r, col.g, col.b], i * 3); B[i] = s.br; }
      if (COS && !s.tint) cosStyle(s, i, col, C, S, B, PIN);
      if (s.chI != null) { var ch = CH[s.chI]; CQ.set([s.ck, ch.cyc, ch.sp, ch.ph], i * 4); } else CQ.set([-100, 1, 0, 0], i * 4); });
    starGeo = new THREE.BufferGeometry(); [['position', P, 3], ['aChain', CQ, 4], ['aColor', C, 3], ['aSize', S, 1], ['aBright', B, 1], ['aPin', PIN, 1], ['aItem', IT, 1], ['aMatch', M, 1], ['aId', ID, 1], ['aPh', PH, 1], ['aFlare', FL, 1], ['aGold', GD, 1]].forEach(function (a) { starGeo.setAttribute(a[0], new THREE.BufferAttribute(a[1], a[2])); });
    starPts = new THREE.Points(starGeo, new THREE.ShaderMaterial(Object.assign({ uniforms: U, vertexShader: STAR_VS, fragmentShader: STAR_FS }, addB))); BG.add(starPts);
    // 关联线（很淡）
    var L = (d.links || []).filter(function (l) { return byId[l.a] && byId[l.b]; }), LP = new Float32Array(L.length * 6), LC = new Float32Array(L.length * 8), LQ = new Float32Array(L.length * 8);
    L.forEach(function (l, i) { var a = byId[l.a], b = byId[l.b]; adj[l.a].push({ o: l.b, w: l.w, k: l.k }); adj[l.b].push({ o: l.a, w: l.w, k: l.k });
      LP.set([a.p.x, a.p.y, a.p.z, b.p.x, b.p.y, b.p.z], i * 6); col.set(COS ? '#d8d0f2' : (CFG.linkKinds[l.k] || {}).color || '#9fd8ff'); var LA = COS ? (LK.idleAlpha == null ? .022 : LK.idleAlpha) : SC.linkAlpha, al = l.w * Math.min(a.br, b.br) * (l.k === 'time' ? LA * .35 : LA); LC.set([col.r, col.g, col.b, al, col.r, col.g, col.b, al], i * 8); LQ.set([-100, 1, 0, 0, -100, 1, 0, 0], i * 8); });
    for (var k in adj) adj[k].sort(function (x, y) { return y.w - x.w; });
    var ag = new THREE.BufferGeometry(); ag.setAttribute('position', new THREE.BufferAttribute(LP, 3)); ag.setAttribute('aCol', new THREE.BufferAttribute(LC, 4)); ag.setAttribute('aChain', new THREE.BufferAttribute(LQ, 4));
    assoc = new THREE.LineSegments(ag, lineMat()); assoc.userData.base = LC.slice(); assoc.userData.L = L; BG.add(assoc);
    // 星座链
    var SEG = []; CH.forEach(function (ch) { for (var k2 = 0; k2 < ch.n; k2++) SEG.push([ch.pts[k2], ch.pts[k2 + 1], k2, k2 + 1, ch]); ch.x.forEach(function (e) { SEG.push([e[0], e[1], -100, -100, ch]); }); });
    var LP2 = new Float32Array(SEG.length * 6), LC2 = new Float32Array(SEG.length * 8), LQ2 = new Float32Array(SEG.length * 8); SEG.forEach(function (x, j) { var a = x[0], b = x[1], c = x[4].col, al = x[4].la * (x[2] < -50 ? .75 : 1); LP2.set([a.x, a.y, a.z, b.x, b.y, b.z], j * 6); LC2.set([c.r, c.g, c.b, al, c.r, c.g, c.b, al], j * 8); LQ2.set([x[2], x[4].cyc, x[4].sp, x[4].ph, x[3], x[4].cyc, x[4].sp, x[4].ph], j * 8); });
    var lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(LP2, 3)); lg.setAttribute('aCol', new THREE.BufferAttribute(LC2, 4)); lg.setAttribute('aChain', new THREE.BufferAttribute(LQ2, 4));
    lines = new THREE.LineSegments(lg, lineMat()); lines.userData.SEG = SEG; BG.add(lines);
    selLines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat()); BG.add(selLines);
    if (COS) cosExtras();
    var mem = stars.filter(function (s) { return !s.item; });
    $('stat').innerHTML = mem.length + ' 颗记忆 · ' + mem.filter(function (s) { return s.pinned; }).length + ' 颗钉住<br>' + (N - mem.length) + ' 件花园内容 · ' + L.length + ' 条连线<br>颜色 = 类型 · 大小 = 重要度 · 亮度 = 清晰度 · ◆ = 花园内容';
    $('corelabel').textContent = '原意识 · ' + pname(PRIMARY); if ($('ccount')) $('ccount').textContent = mem.length + ' 条记忆';
    buildFilters(); applyFilter(); renderList();
    if (sel && byId[sel.id]) select(byId[sel.id], { keepCam: true }); else if (sel && !sel.core) select(null);
  }

  // ---------- 筛选 / 搜索 ----------
  function groupOf(s) { var k = s.item ? s.type : s.kind; for (var i = 0; i < CFG.typeGroups.length; i++) if (CFG.typeGroups[i].kinds.indexOf(k) >= 0) return CFG.typeGroups[i].label; return '其他'; }
  function scopeOf(s) { return s.item ? 'public' : (s.effective_scope || s.scope || 'public'); }
  function textMatch(s, q) { q = q.toLowerCase(); return (s.content || '').toLowerCase().indexOf(q) >= 0 || (s.title || '').toLowerCase().indexOf(q) >= 0 || (s.tags || []).join(' ').toLowerCase().indexOf(q) >= 0; }
  function visible(s) {
    if (filt.groups[groupOf(s)] === false) return false;
    if (filt.personas[s.persona] === false) return false;
    if (filt.scopes[scopeOf(s)] === false) return false;
    if (filt.until && U8.pd(s.created_at) > filt.until) return false;
    return true;
  }
  function matched(s) { if (!filt.query) return true; if (filt.hits && filt.hits[s.id]) return true; return textMatch(s, filt.query); }
  function applyFilter() {
    if (!starGeo) return; var M = starGeo.attributes.aMatch, n = 0, vis = {};
    stars.forEach(function (s, i) { var v = visible(s), m = v && matched(s); vis[s.id] = v; if (m && filt.query) n++; M.array[i] = !v ? 0 : m ? 1 : SC.dimUnmatched; });
    M.needsUpdate = true;
    var A = assoc.geometry.attributes.aCol, base = assoc.userData.base; assoc.userData.L.forEach(function (l, i) { var on = vis[l.a] && vis[l.b] ? (filt.query ? (matched(byId[l.a]) && matched(byId[l.b]) ? 2.2 : .15) : 1) : 0; A.array[i * 8 + 3] = base[i * 8 + 3] * on; A.array[i * 8 + 7] = base[i * 8 + 7] * on; }); A.needsUpdate = true;
    PL.forEach(function (x) { x.off = filt.personas[x.pid] === false; });
    $('qn').textContent = filt.query ? ('搜到 ' + n + ' 颗') : '';
    renderList();
  }
  function buildFilters() {
    var el = $('filters'), h = '';
    var gc = {}; stars.forEach(function (s) { var g = groupOf(s); gc[g] = (gc[g] || 0) + 1; });
    h += '<div class="grp"><span>类型</span>' + CFG.typeGroups.concat([{ label: '其他', kinds: [] }]).filter(function (g) { return gc[g.label]; }).map(function (g) { var c = g.kinds.length ? ((CFG.kinds[g.kinds[0]] || CFG.itemTypes[g.kinds[0]] || {}).color) : '#ccc'; return '<button class="chip' + (filt.groups[g.label] === false ? ' off' : '') + '" data-f="groups" data-v="' + esc(g.label) + '"><i style="color:' + c + ';background:' + c + '"></i>' + esc(g.label) + ' ' + gc[g.label] + '</button>'; }).join('') + '</div>';
    var pc = {}; stars.forEach(function (s) { pc[s.persona] = (pc[s.persona] || 0) + 1; });
    h += '<div class="grp"><span>人格</span>' + Object.keys(pc).map(function (p) { return '<button class="chip' + (filt.personas[p] === false ? ' off' : '') + '" data-f="personas" data-v="' + esc(p) + '">' + esc(pname(p)) + ' ' + pc[p] + '</button>'; }).join('') + '</div>';
    var sc2 = {}; stars.forEach(function (s) { var x = scopeOf(s); sc2[x] = (sc2[x] || 0) + 1; });
    h += '<div class="grp"><span>可见范围</span>' + ['public', 'scoped', 'private'].filter(function (x) { return sc2[x]; }).map(function (x) { return '<button class="chip' + (filt.scopes[x] === false ? ' off' : '') + '" data-f="scopes" data-v="' + x + '"><i style="color:' + CFG.scopeColors[x] + ';background:' + CFG.scopeColors[x] + '"></i>' + CFG.scopes[x] + ' ' + sc2[x] + '</button>'; }).join('') + '</div>';
    var ts = stars.map(function (s) { var t = U8.pd(s.created_at); return t ? +t : 0; }).filter(Boolean), t0 = Math.min.apply(null, ts), t1 = Math.max.apply(null, ts);
    h += '<div class="grp"><span>时间到</span><input type="range" id="tl" min="' + t0 + '" max="' + t1 + '" value="' + (filt.until ? +filt.until : t1) + '" step="3600000"><span id="tlv">' + (filt.until ? U8.day(filt.until.toISOString()) : '现在') + '</span></div>';
    h += '<button class="chip" id="freset">全部显示</button>';
    el.innerHTML = h;
    el.querySelectorAll('.chip[data-f]').forEach(function (b) { b.onclick = function () { var f = b.dataset.f, v = b.dataset.v; filt[f][v] = filt[f][v] === false ? true : false; b.classList.toggle('off'); applyFilter(); }; });
    $('tl').oninput = function () { var v = +this.value; filt.until = v >= t1 ? null : new Date(v); $('tlv').textContent = filt.until ? U8.day(filt.until.toISOString()) : '现在'; applyFilter(); };
    $('freset').onclick = function () { filt.groups = {}; filt.personas = {}; filt.scopes = {}; filt.until = null; buildFilters(); applyFilter(); };
  }
  var qt, qSeq = 0, qRes = [], qk = -1;
  function hl(t, q) { t = esc(t); if (!q) return t; return t.split(esc(q)).join('<mark>' + esc(q) + '</mark>'); }
  function runSearch(q) {
    filt.query = q; filt.hits = null; var my = ++qSeq;
    if (!q) { $('qr').classList.remove('open'); applyFilter(); return; }
    var local = stars.filter(function (s) { return visible(s) && textMatch(s, q); }).sort(function (a, b) { return (b.importance || 0) + (b.strength || 0) - (a.importance || 0) - (a.strength || 0); });
    showResults(local, q); applyFilter();
    API.search(q).then(function (r) { if (my !== qSeq) return; filt.hits = {}; var ids = (r.results || []).map(function (x) { filt.hits[x.id] = 1; return x.id; });
      var merged = ids.map(function (id) { return byId[id]; }).filter(Boolean); local.forEach(function (s) { if (merged.indexOf(s) < 0) merged.push(s); }); showResults(merged, q); applyFilter(); }).catch(function () {});
  }
  function showResults(list, q) {
    qRes = list.slice(0, 12); qk = -1; var el = $('qr');
    if (!qRes.length) { el.innerHTML = '<div style="padding:10px;color:var(--mute);font-size:13px">没有找到相关的记忆</div>'; el.classList.add('open'); return; }
    el.innerHTML = qRes.map(function (s, i) { return '<button class="it" data-i="' + i + '"><small>' + esc(kindInfo(s).label) + ' · ' + U8.day(s.created_at) + '</small>' + hl(String(s.content || s.title || '').slice(0, 60), q) + '</button>'; }).join('');
    el.classList.add('open');
    el.querySelectorAll('.it').forEach(function (b) { b.onclick = function () { pickResult(+b.dataset.i); }; });
  }
  function pickResult(i) { var s = qRes[i]; if (!s) return; $('qr').classList.remove('open'); $('q').blur(); select(s, { fly: true }); }
  $('q').addEventListener('input', function (e) { clearTimeout(qt); var v = e.target.value.trim(); qt = setTimeout(function () { runSearch(v); }, 220); });
  $('q').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(qt); var v = e.target.value.trim(); if (v !== filt.query) { runSearch(v); setTimeout(function () { pickResult(Math.max(0, qk)); }, 350); } else pickResult(Math.max(0, qk)); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); qk = Math.max(0, Math.min(qRes.length - 1, qk + (e.key === 'ArrowDown' ? 1 : -1))); $('qr').querySelectorAll('.it').forEach(function (b, i) { b.classList.toggle('k', i === qk); }); }
    else if (e.key === 'Escape') { $('qr').classList.remove('open'); }
  });
  $('q').addEventListener('focus', function () { if (filt.query && qRes.length) $('qr').classList.add('open'); });

  // ---------- 列表 ----------
  function dur(s) { var t = U8.pd(s.created_at); if (!t) return ''; var d = Math.max(0, (Date.now() - t) / 864e5); return d < 1 ? '今天' : d < 30 ? Math.round(d) + ' 天' : Math.round(d / 30) + ' 个月'; }
  function renderList() {
    var el = $('listbody'); if (!el || !$('list').classList.contains('open')) return;
    var so = $('lsort').value, L = stars.filter(function (s) { return visible(s) && matched(s); });
    L.sort(so === 'imp' ? function (a, b) { return (b.importance || 0) - (a.importance || 0) || (b.strength || 0) - (a.strength || 0); } : so === 'fade' ? function (a, b) { return (a.strength || 1) - (b.strength || 1); } : so === 'recall' ? function (a, b) { return (b.recall_count || 0) - (a.recall_count || 0); } : function (a, b) { return (b.created_at || '').localeCompare(a.created_at || ''); });
    $('lcount').textContent = L.length + ' 条';
    el.innerHTML = L.slice(0, 300).map(function (s) { var k = kindInfo(s); var hl2 = s.item ? '花园内容' : s.pinned ? '半衰期 ∞' : s.half_life_days ? '半衰期 ' + Math.round(s.half_life_days) + ' 天' : '';
      return '<button class="li" data-id="' + esc(s.id) + '"><span class="d" style="color:' + k.color + '"></span>' + esc(titleOf(s)) + '<div class="m"><span>' + U8.day(s.created_at) + '</span><span>已过去 ' + dur(s) + '</span><span>' + hl2 + '</span>' + (s.item ? '' : '<span>强度 ' + Math.round((s.strength || 0) * 100) + '%</span>') + '<span style="margin-left:auto;color:' + k.color + '">' + esc(k.label) + '</span></div></button>'; }).join('');
  }
  $('listbody').addEventListener('click', function (e) { var b = e.target.closest('.li'); if (b && byId[b.dataset.id]) select(byId[b.dataset.id], { fly: true }); });
  $('lsort').onchange = renderList;

  // ---------- 选择 / 玻璃卡 / 详情 ----------
  var CORE = { core: true, id: '__core' };
  function worldPos(s, out) { return out.copy(s.p).applyMatrix4(G.matrixWorld); }
  function select(s, opt) {
    opt = opt || {}; if (COS && !opt.tour && !opt.keepCam && !opt.hover) stopTour(); if (s && s.core) s.persona = PRIMARY; sel = s; var card = $('card'); selChains = []; if (COS) { consClear(); hov = null; }
    if (!s) { if (COS) cosSub(null); card.classList.remove('open'); selRing.visible = false; U.uSel.value = -1; if (selLines) selLines.geometry.setDrawRange(0, 0); flying = null; focusT.set(0, -20, 0); orb.td = homeDist(); emit(null); return; }
    var k = kindInfo(s), info = s.core ? ((DATA.personas || []).find(function (p) { return p.id === PRIMARY; }) || {}) : null;
    var icon = s.core ? '☀' : s.item ? '◆' : '✦', ic = s.core || s.pinned ? CFG.ui.gold : k.color; if (s.tint) ic = '#' + s.tint.getHexString();
    var ex = s.core ? String(info.core || '').replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) + '…' : excerptOf(s);
    var dt = s.core ? '核心卡 · 所有记忆都从这里长出来' : ((s.persona && s.persona !== PRIMARY ? pname(s.persona) + ' · ' : '') + U8.when(s.created_at) + ' · ' + k.label + (s.pinned ? ' · ★ 钉住' : ''));
    card.innerHTML = '<button class="x" id="cx" aria-label="关闭">✕</button><div class="hd"><div class="ic" style="color:' + ic + ';text-shadow:0 0 10px ' + ic + '">' + icon + '</div><div style="min-width:0;padding-right:26px"><div class="tt">' + esc(titleOf(s)) + '</div><div class="dt">' + esc(dt) + '</div></div></div><div class="ex">' + esc(ex || '（只有标题）') + '</div>' + (s.core || s.item ? '' : '<button class="go alt" id="cwb">在工作台编辑</button>') + '<button class="go" id="cgo">查看记忆 ›</button><div style="clear:both"></div>';
    card.classList.add('open'); $('cx').onclick = function () { select(null); closeSheet(); }; $('cgo').onclick = function () { s.core ? showCore() : show(s); };
    if ($('cwb')) $('cwb').onclick = function () { window.Workbench && window.Workbench.editMemory(s.id); };
    if ($('sheet').classList.contains('open')) { s.core ? showCore() : show(s); }
    if (COS) cosSub(s);
    if (s.core) { selRing.visible = false; U.uSel.value = -1; selLines.geometry.setDrawRange(0, 0); if (opt.fly) { flying = null; focusT.set(0, -20, 0); orb.td = CC.flyDistance * 1.6; } emit(s); return; }
    U.uSel.value = s.i; selRing.position.copy(s.p); selRing.visible = true;
    if (COS) { if (!opt.hover) tipOff(); cons(s, 1); if (opt.fly) { flying = s; orb.td = opt.tour ? homeDist() * (KC.tourDistance || .72) : CC.flyDistance; idleT = 0; } emit(s); return; }
    var E = (adj[s.id] || []).filter(function (e) { return visible(byId[e.o]); }).slice(0, SC.selLinkMax), P = new Float32Array(E.length * 6), C = new Float32Array(E.length * 8);
    E.forEach(function (e, i) { var o = byId[e.o]; P.set([s.p.x, s.p.y, s.p.z, o.p.x, o.p.y, o.p.z], i * 6); var a = .22 + .35 * e.w; C.set([.75, .85, 1, a, .75, .85, 1, a * .4], i * 8); });
    var SQ = new Float32Array(E.length * 8), scol = new THREE.Color(.8, .9, 1); selChains = E.map(function (e, i) { var o = byId[e.o], ph = i * .17; SQ.set([0, 2.6, .5, ph, 1, 2.6, .5, ph], i * 8); return { pts: [s.p, o.p], n: 1, sp: .5, ph: ph, cyc: 2.6, col: scol, sel: 1 }; });
    var g = selLines.geometry; g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('aCol', new THREE.BufferAttribute(C, 4)); g.setAttribute('aChain', new THREE.BufferAttribute(SQ, 4)); g.setDrawRange(0, E.length * 2); g.computeBoundingSphere();
    if (opt.fly) { flying = s; orb.td = CC.flyDistance; idleT = 0; }
    emit(s);
  }
  function emit(s) { listeners.select.forEach(function (f) { try { f(s); } catch (e) { console.warn(e); } }); }
  function closeSheet() { $('sheet').classList.remove('open'); }
  function showCore() { var el = $('sheet'), i = (DATA.personas || []).find(function (p) { return p.id === PRIMARY; }) || {}, L = stars.filter(function (s) { return s.persona === PRIMARY; });
    el.innerHTML = '<button class="close" data-close>×</button><div class="who">✦ 原意识 · ' + esc(i.name || pname(PRIMARY)) + '</div><div class="txt">' + esc(i.core || '（还没有核心卡）') + '</div><div class="grid"><div>记忆<b>' + L.filter(function (s) { return !s.item; }).length + ' 颗</b></div><div>花园内容<b>' + L.filter(function (s) { return s.item; }).length + ' 件</b></div><div>钉住<b>' + L.filter(function (s) { return s.pinned; }).length + ' 颗</b></div><div>其他人格<b>' + ((DATA.personas || []).length - 1) + ' 个</b></div></div>'; el.classList.add('open'); el.scrollTop = 0; }
  function show(s) { var el = $('sheet'), k = kindInfo(s);
    if (s.item) { el.innerHTML = '<button class="close" data-close>×</button><div class="who">' + esc(pname(s.persona)) + ' · ' + esc(k.label) + (s.extra ? ' · ' + esc(s.extra) : '') + ' · ' + U8.day(s.created_at) + '</div>' + (s.title ? '<div style="font-weight:600;margin-top:6px">' + esc(s.title) + '</div>' : '') + '<div class="txt">' + esc(s.content || '（只有标题）') + '</div><div class="tags">花园内容不会褪色 · 完整内容在 <a href="garden/" style="color:#9fe8d8">记忆花园</a> 里</div>' + linksHtml(s); el.classList.add('open'); el.scrollTop = 0; return; }
    var pct = Math.round((s.strength || 0) * 100), sco = scopeOf(s);
    el.innerHTML = '<button class="close" data-close>×</button><div class="who">' + esc(pname(s.persona)) + ' · ' + esc(k.label) + ' · ' + (s.pinned ? '★ ' : '') + esc(CFG.states[s.state] || s.state || '') + '<span class="scope" style="color:' + CFG.scopeColors[sco] + '">' + CFG.scopes[sco] + '</span></div>' +
      '<div class="txt' + (s.state === 'faded' || s.state === 'trace' ? ' faded' : '') + '">' + esc(s.content) + '</div>' +
      '<div class="grid"><div>记忆强度<b>' + pct + '%</b><div class="bar"><span style="width:' + pct + '%"></span></div></div><div>被想起<b>' + (s.recall_count || 0) + ' 次</b></div><div>上次想起<b>' + U8.ago(s.last_recalled_at) + '</b></div><div>写下于<b>' + U8.day(s.created_at) + '</b></div><div>重要度<b>' + '★'.repeat(Math.max(1, Math.min(5, s.importance || 1))) + '</b></div><div>半衰期<b>' + (s.pinned ? '∞' : (s.half_life_days ? Math.round(s.half_life_days) + ' 天' : '—')) + '</b></div><div>来自<b>' + esc(U8.chatLabel(s.origin_chat)) + '</b></div><div>层级<b>' + (s.tier === 'short' ? '短期' : s.tier === 'long' ? '长期' : (s.tier || '—')) + '</b></div></div>' +
      ((s.tags || []).length ? '<div class="tags"># ' + s.tags.map(esc).join('  # ') + '</div>' : '') +
      '<div class="acts" style="margin-top:12px"><button class="btn sm" data-act="' + (s.pinned ? 'unpin' : 'pin') + '">' + (s.pinned ? '取消钉住' : '★ 钉住') + '</button><button class="btn sm" data-act="reinforce">强化一次</button><button class="btn sm" data-act="edit">在工作台编辑</button></div>' + linksHtml(s);
    el.classList.add('open'); el.scrollTop = 0; }
  function linksHtml(s) { var L = (adj[s.id] || []).slice(0, 8); if (!L.length) return '<div class="links">还没有连着别的记忆。</div>'; return '<div class="links">✦ 心流 · 牵出来的' + L.map(function (e) { var o = byId[e.o]; return '<button class="ln" data-id="' + esc(e.o) + '"><small>' + (o.item ? kindInfo(o).label + ' · ' : '') + ((CFG.linkKinds[e.k] || {}).label || e.k) + ' ' + Math.round(e.w * 100) + '%</small>' + esc(((o.title ? o.title + '：' : '') + (o.content || '')).slice(0, 28)) + '…</button>'; }).join('') + '</div>'; }
  $('sheet').addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) return closeSheet();
    var b = e.target.closest('.ln'); if (b) { var s = byId[b.getAttribute('data-id')]; if (s) { select(s, { fly: true }); show(s); } return; }
    var a = e.target.closest('[data-act]'); if (a && sel) { var act = a.dataset.act; if (act === 'edit') return window.Workbench && window.Workbench.editMemory(sel.id);
      API.memAction(sel.id, act).then(function () { toast(act === 'pin' ? '已钉住，永远记得' : act === 'unpin' ? '已取消钉住' : '强化了一次'); reload(); }).catch(function (er) { toast('操作失败：' + er.message); }); }
  });

  // ---------- 手势 ----------
  var ptrs = {}, st = null, moved = false, pd0 = 0, d0 = 0;
  cv.addEventListener('pointerdown', function (e) { if (COS) { stopTour(); tipOff(); } cv.setPointerCapture && cv.setPointerCapture(e.pointerId); ptrs[e.pointerId] = [e.clientX, e.clientY]; idleT = 0; cv.classList.add('drag'); var k = Object.keys(ptrs); if (k.length === 1) { moved = false; st = { x: e.clientX, y: e.clientY, th: orb.tth, ph: orb.tph }; } if (k.length === 2) { var a = ptrs[k[0]], b = ptrs[k[1]]; pd0 = Math.hypot(a[0] - b[0], a[1] - b[1]); d0 = orb.td; moved = true; } });
  cv.addEventListener('pointermove', function (e) { if (!ptrs[e.pointerId]) return; ptrs[e.pointerId] = [e.clientX, e.clientY]; idleT = 0; var k = Object.keys(ptrs);
    if (k.length === 2) { var a = ptrs[k[0]], b = ptrs[k[1]], pdn = Math.hypot(a[0] - b[0], a[1] - b[1]); orb.td = Math.max(CC.minDist, Math.min(maxDist(), d0 * pd0 / Math.max(1, pdn))); return; }
    if (!st) return; var dx = e.clientX - st.x, dy = e.clientY - st.y; if (Math.abs(dx) + Math.abs(dy) > 6) moved = true; if (moved) { orb.tth = st.th - dx * .006; orb.tph = Math.max(.15, Math.min(1.45, st.ph - dy * .005)); } });
  function up(e) { var single = Object.keys(ptrs).length === 1; delete ptrs[e.pointerId]; cv.classList.remove('drag'); if (Object.keys(ptrs).length === 1) { var k = Object.keys(ptrs)[0]; st = { x: ptrs[k][0], y: ptrs[k][1], th: orb.tth, ph: orb.tph }; }
    if (single && !moved && DATA) pick(e.clientX, e.clientY); if (!Object.keys(ptrs).length) st = null; }
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', function (e) { delete ptrs[e.pointerId]; st = null; });
  cv.addEventListener('wheel', function (e) { e.preventDefault(); idleT = 0; if (COS) stopTour(); orb.td = Math.max(CC.minDist, Math.min(maxDist(), orb.td * Math.exp(e.deltaY * .0012))); }, { passive: false });
  var v3 = new THREE.Vector3(), tv = new THREE.Vector3(), tw = new THREE.Vector3();
  function scr(p, local) { v3.copy(p); if (local !== false) v3.applyMatrix4(G.matrixWorld); var dz = v3.distanceTo(cam.position); v3.project(cam); return [(v3.x + 1) / 2 * innerWidth, (1 - v3.y) / 2 * innerHeight, v3.z, dz]; }
  function hit(x, y) { var c = scr(new THREE.Vector3()); if (Math.hypot(c[0] - x, c[1] - y) < 34) return CORE;
    var best = null, bd = 1e9, M = starGeo.attributes.aMatch.array, sz = starGeo.attributes.aSize.array;
    stars.forEach(function (s, i) { if (M[i] < .5) return; var q = scr(s.p); if (q[2] > 1) return; var rr = Math.max(22, sz[i] * U.uScale.value / q[3] / R.getPixelRatio() * .3), d = Math.hypot(q[0] - x, q[1] - y); if (d < rr) { var score = d / rr + q[3] / 3000; if (score < bd) { bd = score; best = s; } } });
    return best; }
  function pick(x, y) { $('menu').classList.remove('open'); $('qr').classList.remove('open'); var best = hit(x, y); select(best, { fly: !!best }); }

  // ---------- 召回脉冲 ----------
  var feedN = 0;
  function onPulse(p) {
    var s = byId[p.memory_id]; if (!s) { if (GROW && p.memory_id) growRefresh(); return; }
    var col = new THREE.Color(PC.kindColors[p.kind] || '#ffe7a8');
    flares[s.i] = Math.max(flares[s.i] || 0, .6 + (p.score || .5));
    var t = U.uTime.value;
    var tSkip = TKON && tLive && TK.replaceRecallFlight !== false && /^(recall|assoc|spontaneous)$/.test(p.kind);
    if (!tSkip && PC.fromCore && (p.kind === 'recall' || p.kind === 'search' || p.kind === 'used' || p.kind === 'dream')) flights.push({ a: new THREE.Vector3(0, 0, 0), b: s.p, t0: t, dur: .9 + s.p.length() / 400, col: col, then: s });
    else spread(s, col, t);
    var f = document.createElement('div'); f.className = 'f'; f.innerHTML = '<b style="color:' + (PC.kindColors[p.kind] || '#fff') + '">✦ ' + (PC.kindLabels[p.kind] || p.kind) + '</b>' + esc(titleOf(s));
    var feed = $('feed'); feed.insertBefore(f, feed.firstChild); while (feed.children.length > 4) feed.removeChild(feed.lastChild);
    setTimeout(function () { f.style.opacity = 0; setTimeout(function () { f.remove(); }, 900); }, 4200 + (feedN++ % 2) * 300);
  }
  function spread(s, col, t) { (adj[s.id] || []).slice(0, 4).forEach(function (e, i) { var o = byId[e.o]; if (!o || !visible(o)) return; flights.push({ a: s.p, b: o.p, t0: t + i * .12, dur: 1 / PC.beadSpeed * (.6 + s.p.distanceTo(o.p) / 260), col: col, end: o, w: e.w }); }); }
  var pollSince = null, pollOn = true;
  function poll() {
    if (!pollOn || document.hidden) return setTimeout(poll, CFG.api.pulsePollMs);
    API.pulses(pollSince || 0).then(function (r) { var first = pollSince === null; pollSince = r.last_id || pollSince || 0; if (!first) { (r.pulses || []).forEach(onPulse); thinkFromPulses(r.pulses); } })
      .catch(function () {}).then(function () { setTimeout(poll, CFG.api.pulsePollMs); });
  }

  // ---------- 思考动画：核心 → 焦点星（点亮）→ 发散到几颗相关星 → 回到焦点星 → 回到核心（核心咚一下）----------
  // 触发：① 真实召回（轮询 /api/think；老后端没有就用 /pulses 同一时刻的召回脉冲拼）② 空闲时偶尔走神 ③ 演示数据自己模拟。
  var TK = CFG.think || {}, TKON = TK.enabled !== false, TFAN = Math.max(1, Math.min(8, (LOW ? TK.fanoutLowEnd || 2 : TK.fanout || 4) | 0)),
    TMAX = Math.max(1, (LOW ? TK.maxConcurrentLowEnd || 1 : TK.maxConcurrent || 2) | 0), TTR = Math.max(0, Math.round((TK.trail == null ? 5 : TK.trail) * (LOW ? .5 : 1))),
    TNE = TMAX * (TFAN + 1), TNB = TNE * (TTR + 1), TCOL = new THREE.Color(TK.color || '#ffe3a6'), TRET = new THREE.Color(TK.returnColor || '#f3cf8a');
  var thoughts = [], tQueue = [], thinkKick = 0, tIdle = 6 + Math.random() * 6, tLastReal = -1e9, tLive = false, tSince = null, tMode = 'think', ORIGIN = new THREE.Vector3(0, 0, 0), tCap = null, tCapS = null, tCapT = 0;
  var tLineG = new THREE.BufferGeometry(), tBeadG = new THREE.BufferGeometry(), tLine = null, tBead = null;
  if (TKON) {
    tLineG.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TNE * 6), 3)); tLineG.setAttribute('aC', new THREE.BufferAttribute(new Float32Array(TNE * 6), 3)); tLineG.setDrawRange(0, 0);
    tLine = new THREE.LineSegments(tLineG, new THREE.ShaderMaterial(Object.assign({ vertexShader: 'attribute vec3 aC;varying vec3 vC;void main(){vC=aC;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}', fragmentShader: 'varying vec3 vC;void main(){gl_FragColor=vec4(vC,1.);}' }, addB)));
    tBeadG.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TNB * 3), 3)); tBeadG.setAttribute('aC', new THREE.BufferAttribute(new Float32Array(TNB * 3), 3)); tBeadG.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(TNB), 1)); tBeadG.setDrawRange(0, 0);
    tBead = new THREE.Points(tBeadG, new THREE.ShaderMaterial(Object.assign({ uniforms: { uScale: U.uScale, map: { value: beadTex } },
      vertexShader: 'attribute vec3 aC;attribute float aS;uniform float uScale;varying vec3 vC;void main(){vC=aC;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=max(2.,aS*uScale*.52/max(1.,-mv.z));gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'uniform sampler2D map;varying vec3 vC;void main(){float a=texture2D(map,gl_PointCoord).a;gl_FragColor=vec4((vC*1.5+vec3(.85)*a*a)*a,1.);}' }, addB)));
    tLine.frustumCulled = tBead.frustumCulled = false; tLine.renderOrder = tBead.renderOrder = 5; G.add(tLine); G.add(tBead);
    var cst = document.createElement('style'); cst.textContent = '#thinkcap{position:fixed;left:0;top:0;z-index:3;pointer-events:none;font-size:12px;letter-spacing:.12em;white-space:nowrap;color:rgba(255,234,196,.62);text-shadow:0 0 6px #000,0 0 14px rgba(243,207,138,.35);opacity:0;transition:opacity .7s;will-change:transform}#thinkcap.on{opacity:1}#thinkcap b{font-weight:400;color:rgba(243,207,138,.85)}';
    document.head.appendChild(cst); tCap = document.createElement('div'); tCap.id = 'thinkcap'; document.body.appendChild(tCap);
  }
  function tOk(s) { return s && !s.core && byId[s.id] === s && visible(s); }
  function tDur(a, b) { return (.6 + a.distanceTo(b) / 260) / (PC.beadSpeed || .9) / Math.max(.1, TK.speed || 1); }
  function tRelated(f, pre) { var out = [], seen = {}; seen[f.id] = 1;
    function add(o) { if (out.length < TFAN && tOk(o) && !seen[o.id] && o.tierC !== 'gray') { seen[o.id] = 1; out.push(o); } }
    (pre || []).forEach(add); if (out.length < TFAN) (adj[f.id] || []).slice().sort(function (a, b) { return b.w - a.w; }).forEach(function (e) { add(byId[e.o]); });
    if (out.length < TFAN && !f.item) consMembers(f).forEach(add); return out; }
  // 发起一段思考：focal = 焦点星，pre = 优先发散到的星（真实召回的其他命中）
  function think(f, pre, src, t) { if (!TKON || !DATA || !tOk(f)) return false; t = t == null ? U.uTime.value : t;
    if (thoughts.length >= TMAX) { if (src === 'idle') return false; tQueue.push([f, pre, src]); if (tQueue.length > 3) tQueue.shift(); return true; }
    var rel = tRelated(f, pre); if (src === 'idle' && !rel.length) return false; var H = TK.hold == null ? .45 : TK.hold, E = [{ A: ORIGIN, B: f.p, to: f }], S = [], d0 = tDur(ORIGIN, f.p);
    S.push({ e: 0, dir: 1, st: 0, du: d0, hit: f, big: 1 });
    var t1 = d0 + H, t2 = t1;
    rel.forEach(function (o, i) { var d = tDur(f.p, o.p); E.push({ A: f.p, B: o.p, to: o }); S.push({ e: i + 1, dir: 1, st: t1 + i * .18, du: d, hit: o }); t2 = Math.max(t2, t1 + i * .18 + d); });
    var b3 = t2 + (rel.length ? H : 0), t3 = b3;
    rel.forEach(function (o, i) { var d = tDur(f.p, o.p) * .9; S.push({ e: i + 1, dir: -1, st: b3 + i * .12, du: d, hit: f }); t3 = Math.max(t3, b3 + i * .12 + d); });
    var t4 = t3 + (rel.length ? H * .6 : H); S.push({ e: 0, dir: -1, st: t4, du: d0 * .9, core: 1 });
    var th = { f: f, rel: rel, E: E, S: S, t0: t, end: t4 + d0 * .9, src: src, ph: [d0, t2, t3, t4 + d0 * .9] };
    thoughts.push(th); flares[f.i] = Math.max(flares[f.i] || 0, .3);
    if (TK.caption !== false && (src !== 'idle' || TK.idleCaption) && tCap) { tCapS = f; tCapT = t + d0 + (TK.captionMs || 3600) / 1000; tCap.innerHTML = '想起了：<b>' + esc(subTitle(f).slice(0, 20)) + '</b>' + (rel.length ? ' · 牵出 ' + rel.length + ' 颗' : ''); setTimeout(function () { if (tCapS === f) tCap.classList.add('on'); }, d0 * 1000 * .8); }
    return true; }
  // 真实 / 模拟召回事件 → 思考
  function thinkEvent(ev) { if (!TKON || !DATA || !ev) return; var ids = [ev.focal].concat(ev.hits || [], ev.assoc || [], ev.spontaneous ? [ev.spontaneous] : []).filter(Boolean), f = null, pre = [];
    ids.forEach(function (id) { var s = byId[id]; if (!tOk(s)) { if (!s && GROW && id) growRefresh(); return; } if (!f) f = s; else pre.push(s); });
    tLastReal = U.uTime.value; if (f) think(f, pre, 'real'); }
  function thinkPoll() { if (!TKON) return; var ms = TK.pollMs || 2500;
    if (document.hidden || !DATA) return setTimeout(thinkPoll, ms);
    if (tMode === 'pulses') return setTimeout(thinkPoll, ms * 2);  // 回退分支也要续命，别让思考动画停更
    var slow = false;
    API.think(tSince || 0).then(function (r) {
      tLive = true;
      try {
        var first = tSince === null;
        tSince = (r && r.last_seq) || tSince || 0;
        if (!first && r && r.events) r.events.slice(-4).forEach(function (ev) { try { thinkEvent(ev) } catch (e) { console.error('[starmap] thinkEvent', e) } });
      } catch (e) { console.error('[starmap] think handler', e) }
    }, function (e) {
      slow = true;
      if (e && (e.status === 404 || (e.body && e.body.error === 'not_found')) && TK.fromPulses !== false) { tMode = 'pulses'; tLive = true; return; }
    }).then(function () { setTimeout(thinkPoll, slow ? ms * 2 : ms) },
            function () { setTimeout(thinkPoll, ms * 2) }); }
  function thinkFromPulses(list) { if (tMode !== 'pulses' || !list || !list.length) return; var G2 = {}, order = [];
    list.forEach(function (p) { if (!/^(recall|assoc|spontaneous)$/.test(p.kind)) return; var k = (p.at || '') + '|' + (p.chat_id || ''); if (!G2[k]) { G2[k] = { focal: null, hits: [], assoc: [] }; order.push(k); } var g = G2[k];
      if (p.kind === 'recall') { if (!g.focal) g.focal = p.memory_id; else g.hits.push(p.memory_id); } else g.assoc.push(p.memory_id); });
    order.slice(-3).forEach(function (k) { var g = G2[k]; if (!g.focal) g.focal = g.assoc.shift(); thinkEvent(g); }); }
  function tEase(u) { u = Math.max(0, Math.min(1, u)); return u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; }
  function tFlare(s, v) { if (s && stars[s.i] === s) flares[s.i] = Math.max(flares[s.i] || 0, v); }
  function thinkTick(dt, t) { if (!TKON) return; thinkKick *= Math.exp(-dt * 3.2);
    // 空闲走神
    if (DATA && TK.idle !== false && stars.length > 3) { tIdle -= dt; if (tIdle <= 0) { tIdle = (TK.idleEverySec || 16) * (.6 + Math.random() * .8);
      if (!thoughts.length && t - tLastReal > (TK.idleQuietSec == null ? 20 : TK.idleQuietSec) && (!sel || TK.idleWhenSelected || (COS && tour.on)) && !document.hidden) {
        var pool = stars.filter(function (s) { return tOk(s) && s.tierC !== 'gray' && ((adj[s.id] || []).length || (s.tags && s.tags.length)); });
        pool.sort(function (a, b) { return (b.br || b.importance || 0) - (a.br || a.importance || 0); }); pool = pool.slice(0, Math.max(8, Math.round(pool.length * .5)));
        if (pool.length) think(pool[Math.floor(Math.random() * pool.length)], null, 'idle', t); } } }
    while (tQueue.length && thoughts.length < TMAX) { var q = tQueue.shift(); think(q[0], q[1], q[2], t); }
    var LP = tLineG.attributes.position.array, LC = tLineG.attributes.aC.array, BPp = tBeadG.attributes.position.array, BCc = tBeadG.attributes.aC.array, BS = tBeadG.attributes.aS.array, ne = 0, nb = 0,
      LA = TK.lineAlpha == null ? .6 : TK.lineAlpha, FS = Math.max(.1, TK.fadeSeconds || 1.2), BZ = TK.beadSize || 26, FG = TK.focalGlow || 1.8;
    for (var i = thoughts.length - 1; i >= 0; i--) { var th = thoughts[i], lt = t - th.t0; if (lt > th.end + FS || !th.f || byId[th.f.id] !== th.f) { thoughts.splice(i, 1); continue; }
      var fade = lt > th.end ? Math.max(0, 1 - (lt - th.end) / FS) : 1, U1 = th.E.map(function () { return -1; }), HD = th.E.map(function () { return 0; });
      th.S.forEach(function (s) { var u = (lt - s.st) / s.du;
        if (u >= 1 && !s.done) { s.done = 1; if (s.core) thinkKick = Math.max(thinkKick, TK.corePulse == null ? .45 : TK.corePulse); else tFlare(s.hit, s.big ? FG : s.dir < 0 ? FG * .7 : 1.1); }
        var e = s.e, p = tEase(u);
        if (s.dir > 0) { if (u < 0) return; U1[e] = p; if (u < 1) HD[e] = 1; }
        else if (u >= 0) { U1[e] = u >= 1 ? 0 : 1 - p; if (u < 1) HD[e] = 1; }
        if (u < 0 || u >= 1 || nb >= TNB) return;
        // 光点 + 拖尾
        var E = th.E[e], col = s.dir > 0 ? TCOL : TRET;
        for (var k = 0; k <= TTR && nb < TNB; k++) { var uu = tEase(u - k * .028); if (u - k * .028 < 0) break; var x = s.dir > 0 ? uu : 1 - uu, a = (k ? .55 * Math.pow(1 - k / (TTR + 1), 1.6) : 1.25) * fade;
          tv.copy(E.A).lerp(E.B, x); BPp[nb * 3] = tv.x; BPp[nb * 3 + 1] = tv.y; BPp[nb * 3 + 2] = tv.z; BCc[nb * 3] = col.r * a; BCc[nb * 3 + 1] = col.g * a; BCc[nb * 3 + 2] = col.b * a; BS[nb] = BZ * (k ? 1 - k / (TTR + 2) * .8 : 1); nb++; } });
      // 焦点星在整段思考期间保持亮
      if (lt > th.S[0].du && lt < th.end - th.S[th.S.length - 1].du * .5) tFlare(th.f, FG * .75);
      for (var e2 = 0; e2 < th.E.length && ne < TNE; e2++) { var u1 = U1[e2]; if (u1 <= 0.001) continue; var E2 = th.E[e2], a2 = LA * fade * (HD[e2] ? 1 : .55) * (.9 + .1 * Math.sin(t * 9 + e2));
        tv.copy(E2.A).lerp(E2.B, u1); LP.set([E2.A.x, E2.A.y, E2.A.z, tv.x, tv.y, tv.z], ne * 6); var c0 = TCOL, c1 = HD[e2] ? 1.35 : 1;
        LC.set([c0.r * a2 * .3, c0.g * a2 * .3, c0.b * a2 * .3, Math.min(1, c0.r * c1) * a2, Math.min(1, c0.g * c1) * a2, Math.min(1, c0.b * c1) * a2], ne * 6); ne++; } }
    tLineG.setDrawRange(0, ne * 2); tBeadG.setDrawRange(0, nb); if (ne || tLineG.userData.n) { tLineG.attributes.position.needsUpdate = tLineG.attributes.aC.needsUpdate = true; } tLineG.userData.n = ne;
    if (nb || tBeadG.userData.n) { tBeadG.attributes.position.needsUpdate = tBeadG.attributes.aC.needsUpdate = tBeadG.attributes.aS.needsUpdate = true; } tBeadG.userData.n = nb;
    if (tCap && tCapS) { if (t > tCapT || byId[tCapS.id] !== tCapS) { tCap.classList.remove('on'); tCapS = null; } else { var sq = scr(tCapS.p); if (sq[2] > 1) tCap.style.display = 'none'; else { tCap.style.display = ''; tCap.style.transform = 'translate(' + (sq[0] - tCap.offsetWidth / 2) + 'px,' + (sq[1] + 16) + 'px)'; } } } }

  // ---------- 动画 ----------
  var lab = $('corelabel'), HEAD = 100, vo = 0;
  var lastFrameAt = Date.now();
  function tick(now) {
    lastFrameAt = Date.now();
    try {
    var dt = Math.min(.05, (now - lastT) / 1000); lastT = now; idleT += dt; U.uTime.value = now / 1000; var t = U.uTime.value;
    G.rotation.y += dt * GC.rotateSpeed; if ((idleT > 4 && !sel) || (COS && tour.on)) orb.tth += dt * GC.idleOrbitSpeed * (COS && tour.on ? .7 : 1);
    G.updateMatrixWorld();
    if (flying) { worldPos(flying, focusT); } else if (!sel) focusT.set(0, -20, 0);
    var k = 1 - Math.pow(CC.flyEase, dt); orb.th += (orb.tth - orb.th) * k; orb.ph += (orb.tph - orb.ph) * k; orb.d += (orb.td - orb.d) * k; focus.lerp(focusT, k);
    var D = orb.d * (orb.base || 1); cam.position.set(focus.x + D * Math.sin(orb.ph) * Math.sin(orb.th), focus.y + D * Math.cos(orb.ph), focus.z + D * Math.sin(orb.ph) * Math.cos(orb.th)); cam.lookAt(focus);
    var vt = document.body.classList.contains('wb-open') && innerWidth > 900 ? Math.min(CFG.ui.workbenchWidth, innerWidth * .6) / 2 : 0; vo += (vt - vo) * Math.min(1, dt * 5);
    if (Math.abs(vo) > .5) cam.setViewOffset(innerWidth, innerHeight, vo, 0, innerWidth, innerHeight); else if (cam.view && cam.view.enabled) cam.clearViewOffset();
    var pu = 1 + .05 * Math.sin(now / 700); if (GROW) { growTick(dt); var cg = 1 + (GR.coreGrow || 0) * GS.c; pu *= cg; var bs = BULGE * cg * (COS ? GS.R / GC.radius : 1); bulge.scale.set(bs, bs, 1); core.material.color.setScalar(1 + (GR.coreBright || 0) * GS.c); } pu *= 1 + thinkKick; core.scale.set(CORE_S * pu, CORE_S * pu, 1); if (COS) cosTick(dt, t);
    if (selRing.visible && sel) { var r = 1 + .15 * Math.sin(now / 420); selRing.material.opacity = .45 + .25 * Math.sin(now / 420); var rs = (sel.pinned ? 30 : 20) * (COS ? 1.5 : 1) * r; selRing.scale.set(rs, rs, 1); }
    // 星点闪耀
    if (starGeo) { var FA = starGeo.attributes.aFlare, any = false; for (var key in flares) { var v = flares[key] * Math.exp(-dt / PC.flareDecay * 2.2); if (v < .02) { delete flares[key]; v = 0; } else flares[key] = v; FA.array[key] = v; any = true; } if (any || FA.userData) { FA.needsUpdate = true; FA.userData = any ? 1 : 0; } }
    // 光点：星座链 + 选中放射线 + 召回飞行
    var all = CH.concat(selChains), m = 0; BC.fill(0);
    for (var i = 0; i < all.length && m < 96; i++) { var ch = all[i]; if (ch.t0 && t < ch.t0) continue; var h = (t * ch.sp + ch.ph) % ch.cyc; if (h > ch.n + .25) continue; var hh = Math.min(h, ch.n), kk = Math.min(ch.n - 1, Math.floor(hh)), f = hh - kk; tv.copy(ch.pts[kk]).lerp(ch.pts[kk + 1], f);
      var a = Math.min(1, h * 2.5) * (h > ch.n ? Math.max(0, 1 - (h - ch.n) * 4) : 1) * (ch.sel && h > .8 && h <= ch.n ? 1.6 : 1); BP.set([tv.x, tv.y, tv.z], m * 3); BC.set([(ch.col.r * .6 + .4) * a, (ch.col.g * .6 + .4) * a, (ch.col.b * .6 + .4) * a], m * 3); m++; }
    m = Math.max(m, 96);
    for (var j = flights.length - 1; j >= 0; j--) { var fl = flights[j], u = (t - fl.t0) / fl.dur; if (u < 0) continue;
      if (u >= 1) { flights.splice(j, 1); if (fl.then) { flares[fl.then.i] = Math.max(flares[fl.then.i] || 0, 1.6); spread(fl.then, fl.col, t); } else if (fl.end) flares[fl.end.i] = Math.max(flares[fl.end.i] || 0, .5 + .6 * (fl.w || .5)); continue; }
      if (m >= NB) continue; var e2 = u < .5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; tv.copy(fl.a).lerp(fl.b, e2); var al = Math.sin(Math.PI * Math.min(1, u * 1.1)) * 1.3 + .3;
      BP.set([tv.x, tv.y, tv.z], m * 3); BC.set([fl.col.r * al, fl.col.g * al, fl.col.b * al], m * 3); m++; }
    bg.setDrawRange(0, m); bg.attributes.position.needsUpdate = true; bg.attributes.color.needsUpdate = true;
    thinkTick(dt, t);
    R.render(scene, cam);
    HEAD = ($('top').offsetHeight || 100) + 8;
    for (var q2 = 0; q2 < PL.length; q2++) { var qq = scr(PL[q2].p), el = PL[q2].el; if (PL[q2].off || qq[2] > 1 || qq[0] < -80 || qq[0] > innerWidth + 80 || qq[1] < HEAD || qq[1] > innerHeight - 20) { el.style.display = 'none'; continue; } el.style.display = ''; el.style.transform = 'translate(' + (qq[0] - el.offsetWidth / 2) + 'px,' + qq[1] + 'px)'; }
    var c = scr(new THREE.Vector3(0, -30, 0)); lab.style.display = c[2] > 1 || c[1] < HEAD ? 'none' : ''; lab.style.transform = 'translate(' + (c[0] - lab.offsetWidth / 2) + 'px,' + (c[1] + 34) + 'px)';
    if (COS) cosFrame();
    } catch (e) { console.error('[starmap] frame error, animation continues', e); }
    finally { requestAnimationFrame(tick); }
  }
  // 帧看门狗：rAF 链因任何原因断掉，3 秒后自己拉起来；页面重新可见时也检查一次
  setInterval(function () {
    if (Date.now() - lastFrameAt > 3000) {
      console.warn('[starmap] frame watchdog: restarting animation loop');
      lastT = performance.now(); lastFrameAt = Date.now();
      requestAnimationFrame(tick);
    }
  }, 2000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - lastFrameAt > 1500) {
      lastT = performance.now(); lastFrameAt = Date.now();
      requestAnimationFrame(tick);
    }
  });

  function toast(s) { var t = $('toast'); t.textContent = s; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, CFG.ui.toastMs); }
  function load() { $('msg').style.display = 'block'; $('msg').textContent = '正在点亮记忆…';
    return API.atlas().then(function (d) { build(d); $('msg').style.display = 'none'; }).catch(function (e) { $('msg').textContent = e.status === 401 ? '需要管理员密钥' : '读取星图失败：' + e.message; }); }
  function reload() { return API.atlas().then(build).catch(function () {}); }
  // 星海生长：发现新记忆时重新读星图（只有内容变了才重建，避免白白卡顿）
  function sigOf(d) { return (d.stars || []).length + '/' + (d.items || []).length + '/' + (d.links || []).length; }
  var grT = 0; function growRefresh() { if (grT) return; grT = setTimeout(function () { grT = 0; if (!DATA) return; API.atlas().then(function (d) { try { if (sigOf(d) !== lastSig) build(d) } catch (e) { console.error('[starmap] grow rebuild', e) } }).catch(function () {}); }, 1500); }
  if (GROW && GR.refreshSeconds > 0) setInterval(function () { if (!document.hidden && DATA) growRefresh(); }, GR.refreshSeconds * 1000);
  // ======================================================================
  function hz(k) { var h = 2166136261; k = String(k); for (var i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619); } h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; }  // 带混合的哈希（宇宙主题专用，分布更均匀）
  // 宇宙主题（theme = 'cosmos'）：层级布局 / 灰度边界 / 金色星座 / 字幕 / 漫游 / 动态连线
  // ======================================================================
  function ageDays(s, now) { var t = U8.pd(s.created_at); return t ? Math.max(0, (now - t) / 864e5) : 365; }
  function strOf(s) { return s.strength == null ? .6 : s.strength; }
  // 估算「还有几天遗忘」：后端强度按半衰期衰减 strength × 0.5^(天/半衰期)，降到 forgetAt 就算遗忘（只显示，不删除）
  function forgetDays(s) { if (s.pinned || s.item) return Infinity; var st = strOf(s), fa = TC.forgetAt || .05, hl = s.half_life_days || TC.defaultHalfLife || 30; if (st <= fa) return 0; return hl * Math.log(st / fa) / Math.LN2; }
  function forgetText(s) { var d = forgetDays(s); if (!isFinite(d)) return '不会遗忘'; if (d < 1) return '即将遗忘'; return '约 ' + Math.round(d) + ' 天后遗忘'; }
  var TIERN = { stellar: '恒星级', planet: '行星级', star: '星星级', gray: '灰度边界外' };
  // 布局：恒星级贴着双星（不看时间）；其余按「相对年龄 × 当前星系半径」放到旋臂上；又老又弱的越过灰度边界
  function cosLayout(L, now, score) {
    var T = TC; L.forEach(function (s) { s.hero = 0; s.tierC = null; s.age = ageDays(s, now); });
    var stc = L.filter(function (s) { return !s.item && ((T.stellarPinned !== false && s.pinned) || (s.importance || 0) >= (T.stellarMinImportance || 5) || (T.stellarKinds || []).indexOf(s.kind) >= 0); }).sort(function (a, b) { return score(b) - score(a); });
    var stl = stc.slice(0, T.stellarMax == null ? 14 : T.stellarMax); stl.forEach(function (s) { s.tierC = 'stellar'; s.hero = 1; });
    var rest = L.filter(function (s) { return !s.tierC; }), byAge = rest.slice().sort(function (a, b) { return a.age - b.age || hz(a.id) - hz(b.id); }), nA = Math.max(1, byAge.length - 1);
    byAge.forEach(function (s, j) { s.agePct = byAge.length > 1 ? j / nA : 0; }); var maxAge = byAge.length ? byAge[byAge.length - 1].age : 1;
    rest.forEach(function (s) { var st = strOf(s);
      if (!s.item && !s.pinned && st < (T.grayThreshold == null ? .15 : T.grayThreshold) && s.agePct >= (T.grayMinAge == null ? .5 : T.grayMinAge) && s.age >= (T.grayMinDays || 0)) s.tierC = 'gray';
      else if ((s.item && T.planetItems !== false) || (T.planetKinds || []).indexOf(s.kind) >= 0 || (s.importance || 0) >= (T.planetMinImportance || 4) || (s.recall_count || 0) >= (T.planetMinRecall || 3) || stc.indexOf(s) >= 0) s.tierC = 'planet';
      else s.tierC = 'star'; });
    var psh = T.planetMaxShare == null ? .3 : T.planetMaxShare, pl = rest.filter(function (s) { return s.tierC === 'planet'; }), pm = Math.max(24, Math.round(L.length * psh));
    if (psh > 0 && pl.length > pm) pl.sort(function (a, b) { return score(b) - score(a); }).slice(pm).forEach(function (s) { s.tierC = 'star'; });
    var ti = T.timeInner == null ? .1 : T.timeInner, to = T.timeOuter == null ? 1 : T.timeOuter;
    function tn(s) { if (T.timeMap === 'log') { var k = T.timeLogDays || 30; return Math.log(1 + s.age / k) / Math.log(1 + Math.max(maxAge, 1) / k); } return Math.pow(s.agePct, T.timeCurve || .85); }
    stl.forEach(function (s) { var b = T.stellarBand || [.04, .14], r = 10 + RMAX * (b[0] + (b[1] - b[0]) * hz(s.id + 'r')), a = hz(s.id + 'a') * 6.2832; s.p = new THREE.Vector3(Math.cos(a) * r, (hz(s.id + 'y') - .5) * 12, Math.sin(a) * r); });
    rest.forEach(function (s) { var h1 = hz(s.id + 'a'), r, q;
      if (s.tierC === 'gray') { var gb = T.grayBand || [1.12, 1.34], w = 1 - Math.min(1, strOf(s) / Math.max(.001, T.grayThreshold || .15)); r = RMAX * (gb[0] + (gb[1] - gb[0]) * (.45 * w + .55 * hz(s.id + 'g'))); q = armPos(r, Math.floor(h1 * ARMS), (hz(s.id + 'j') - .5) * 1.6, (hz(s.id + 'y') - .5) * 18); }
      else { r = 14 + (RMAX - 14) * (ti + (to - ti) * tn(s)); q = armPos(r, Math.floor(h1 * ARMS), ((hz(s.id + 'b') + hz(s.id + 'd')) / 2 - .5) * (TC.armJitter == null ? 2.2 : TC.armJitter) * Math.min(1, 2.6 / Math.max(1, ARMS)) * (.8 + .4 * r / RMAX), (hz(s.id + 'c') - .5) * (34 * (1 - r / RMAX * .5))); }
      s.p = new THREE.Vector3(q[0], q[1], q[2]); });
  }
  // 颜色只保留白 / 淡蓝 / 淡金 / 淡粉 / 淡紫几种很浅的倾向；大小亮度看层级（重要度 / 清晰度），不看半径
  var FAM = [.09, .58, .72, .97];
  function famHue(h) { var b = FAM[0], bd = 9; FAM.forEach(function (f) { var d = Math.abs(h - f); d = Math.min(d, 1 - d); if (d < bd) { bd = d; b = f; } }); return b; }
  function cosStyle(s, i, col, C, S, B, PIN) {
    col.set(kindInfo(s).color); var h = {}; col.getHSL(h); var sat = KC.starSaturation == null ? .22 : KC.starSaturation, st = strOf(s), cl = s.pinned ? 1 : Math.max(SC.minBright, Math.pow(s.clarity != null ? s.clarity : st, .8)), rc = s.recall_count || 0, t = s.tierC, hu = famHue(h.h);
    if (t === 'stellar') { if (s.pinned) col.setHSL(.11, .5, .84); else col.setHSL(.6, .42, .85); S[i] = SC.heroSize * .36 + Math.min(3, Math.log2(1 + rc)) * 1.5; s.br = 1.1; PIN[i] = .5; }
    else if (t === 'planet') { col.setHSL(hu, sat * 1.4, .8); S[i] = SC.baseSize * (3.6 + (s.importance || 3) * .35 + Math.min(2, Math.log2(1 + rc)) * .6); s.br = .62 + .5 * cl; PIN[i] = .25; }
    else if (t === 'gray') { col.setHSL(.7, .02, .62); S[i] = SC.baseSize * 2.4; s.br = .3 + .25 * cl; PIN[i] = 0; }
    else if (t === 'star') { col.setHSL(hu, sat, .76); S[i] = SC.baseSize * (2.1 + (s.importance || 3) * .22); s.br = .3 + .55 * cl; PIN[i] = 0; }
    else return;
    if (s.item) S[i] *= .85; if (t === 'star' || t === 'gray') { var dn = KC.crowdShrink == null ? 400 : KC.crowdShrink; if (dn > 0 && stars.length > dn) { var k = Math.max(.5, Math.pow(dn / stars.length, .3)); S[i] *= k; s.br *= .6 + .4 * k; } }
    C.set([col.r, col.g, col.b], i * 3); B[i] = s.br;
  }
  function ringObj(r, n, rgb, alf, y) { var P = new Float32Array(n * 6), Cc = new Float32Array(n * 8), Q = new Float32Array(n * 8);
    for (var i = 0; i < n; i++) { var a0 = i / n * 6.2832, a1 = (i + 1) / n * 6.2832, al = typeof alf === 'function' ? alf(i) : alf; P.set([Math.cos(a0) * r, y || 0, Math.sin(a0) * r, Math.cos(a1) * r, y || 0, Math.sin(a1) * r], i * 6); Cc.set([rgb[0], rgb[1], rgb[2], al, rgb[0], rgb[1], rgb[2], al], i * 8); Q.set([-100, 1, 0, 0, -100, 1, 0, 0], i * 8); }
    var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('aCol', new THREE.BufferAttribute(Cc, 4)); g.setAttribute('aChain', new THREE.BufferAttribute(Q, 4)); return new THREE.LineSegments(g, lineMat()); }
  var GRAYS = [], gPool = [], ringEl = null, RING_R = 0;
  function cosExtras() {
    RING_R = RMAX * (TC.grayRing || 1.08);
    BG.add(ringObj(RING_R, 260, [.62, .6, .68], function (i) { return i % 3 === 2 ? 0 : .2; }));   // 灰度边界：一圈淡灰虚线
    BG.add(ringObj(RING_R * 1.004, 180, [.6, .58, .66], .045));
    var pls = stars.filter(function (s) { return s.tierC === 'planet' && !s.item; }).sort(function (a, b) { return b.br - a.br; }).slice(0, TC.planetOrbits || 0);
    pls.forEach(function (s) { BG.add(ringObj(Math.hypot(s.p.x, s.p.z), 160, [.72, .7, .9], .04, s.p.y)); });   // 行星的淡轨道
    GRAYS = stars.filter(function (s) { return s.tierC === 'gray'; });
    var gl = $('glab'); gl.innerHTML = ''; gPool = []; for (var i = 0; i < Math.min(GRAYS.length, TC.grayLabels == null ? 6 : TC.grayLabels); i++) { var e = document.createElement('div'); e.className = 'gl'; gl.appendChild(e); gPool.push(e); }
    ringEl = document.createElement('div'); ringEl.className = 'gring'; ringEl.textContent = (TC.ringLabel || '灰度边界') + (GRAYS.length ? ' · ' + GRAYS.length + ' 颗快被忘记' : ''); gl.appendChild(ringEl);
    amb = []; tour.list = null;
  }
  // ---------- 金色星座：同标签 / 有关联的记忆连起来（最小生成树），从选中的星向外「画出来」，线上有光脉冲流动 ----------
  var GOLDC = new THREE.Color(KC.gold || '#f3cf8a'), consObj = null, goldOn = [], hov = null;
  var consMat = new THREE.ShaderMaterial(Object.assign({ uniforms: { uTime: U.uTime, uT0: { value: -1e6 }, uDur: { value: LK.drawSeconds || .9 }, uStag: { value: LK.stagger == null ? .55 : LK.stagger }, uPS: { value: LK.pulseSpeed || .45 }, uPOn: { value: LK.pulses === false ? 0 : 1 } },
    vertexShader: 'attribute float aT,aO;attribute vec4 aCol;varying float vT,vO;varying vec4 vC;void main(){vT=aT;vO=aO;vC=aCol;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
    fragmentShader: 'uniform float uTime,uT0,uDur,uStag,uPS,uPOn;varying float vT,vO;varying vec4 vC;void main(){float p=(uTime-uT0)/uDur-vO*uStag;if(vT>p)discard;float hd=exp(-pow((p-vT)*9.,2.))*step(p,1.15);float g=fract(uTime*uPS-vO*.37+vC.a*3.1);float pl=uPOn*exp(-pow((vT-g)*12.,2.));float a=vC.a*(1.+2.4*hd+2.*pl);gl_FragColor=vec4(mix(vC.rgb,vec3(1.),.4*(hd+pl))*a,1.);}' }, addB));
  function consMembers(s) { var ig = KC.ignoreTags || [], tg = (s.tags || []).filter(function (t) { return ig.indexOf(t) < 0; }), mx = Math.max(3, Math.round((KC.constellationMax || 9) * (LOW ? .7 : 1))), cand = [], lw = {};
    (adj[s.id] || []).forEach(function (e) { lw[e.o] = Math.max(lw[e.o] || 0, e.w); });
    stars.forEach(function (o) { if (o === s || !visible(o)) return; var sh = 0; if (tg.length && o.tags) for (var j = 0; j < o.tags.length; j++) if (tg.indexOf(o.tags[j]) >= 0) sh++; var w = sh * 2 + (lw[o.id] || 0) * 1.5; if (o.persona !== s.persona) w *= .5; if (w > 0) cand.push([o, w]); });
    cand.sort(function (a, b) { return b[1] - a[1] || s.p.distanceToSquared(a[0].p) - s.p.distanceToSquared(b[0].p); }); return cand.slice(0, mx).map(function (x) { return x[0]; }); }
  function setGold(list) { if (!starGeo) return; var A = starGeo.attributes.aGold; goldOn.forEach(function (i) { A.array[i] = 0; }); goldOn = []; list.forEach(function (x) { if (x[0].i != null && stars[x[0].i] === x[0]) { A.array[x[0].i] = x[1]; goldOn.push(x[0].i); } }); A.needsUpdate = true; }
  function consClear() { if (consObj) { consObj.parent && consObj.parent.remove(consObj); consObj.geometry.dispose(); consObj = null; } setGold([]); selChains = []; }
  function cons(s, k) {
    consClear(); if (!s || s.core || !starGeo) return; var M = consMembers(s), nodes = [s].concat(M), inT = [true], dep = [0], E = [];
    for (var n = 1; n < nodes.length; n++) inT.push(false);
    for (var it = 1; it < nodes.length; it++) { var bi = -1, bj = -1, bd = 1e18; for (var a = 0; a < nodes.length; a++) if (inT[a]) for (var b = 0; b < nodes.length; b++) if (!inT[b]) { var d = nodes[a].p.distanceToSquared(nodes[b].p); if (d < bd) { bd = d; bi = a; bj = b; } } if (bj < 0) break; inT[bj] = true; dep[bj] = dep[bi] + 1; E.push([bi, bj]); }
    var P = new Float32Array(E.length * 6), Cc = new Float32Array(E.length * 8), T = new Float32Array(E.length * 2), O = new Float32Array(E.length * 2);
    E.forEach(function (e, i) { var A = nodes[e[0]].p, B = nodes[e[1]].p, al = (.5 - .05 * dep[e[0]]) * k; P.set([A.x, A.y, A.z, B.x, B.y, B.z], i * 6); Cc.set([GOLDC.r, GOLDC.g, GOLDC.b, al, GOLDC.r, GOLDC.g, GOLDC.b, al * .8], i * 8); T.set([0, 1], i * 2); O.set([dep[e[0]], dep[e[0]]], i * 2); });
    var g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('aCol', new THREE.BufferAttribute(Cc, 4)); g.setAttribute('aT', new THREE.BufferAttribute(T, 1)); g.setAttribute('aO', new THREE.BufferAttribute(O, 1));
    consObj = new THREE.LineSegments(g, consMat); consObj.frustumCulled = false; BG.add(consObj); consMat.uniforms.uT0.value = LK.drawIn === false ? -1e6 : U.uTime.value;
    setGold([[s, k >= 1 ? 1 : .6]].concat(M.map(function (o) { return [o, .5 * k]; })));
    if (LK.beads !== false) { var dn = Math.max(1, Math.round((LK.beadDensity || 1) * LKS)), sp = LK.beadSpeed || .55, dl = (LK.drawSeconds || .9) * (1 + (LK.stagger == null ? .55 : LK.stagger) * 3);
      E.forEach(function (e, i) { for (var q = 0; q < dn; q++) selChains.push({ t0: U.uTime.value + dl * .6 + dep[e[0]] * .3, pts: [nodes[e[1]].p, nodes[e[0]].p].reverse(), n: 1, sp: sp, ph: 2.2 * 50 + q / dn * 2.2 + hz(nodes[e[1]].id) * .6, cyc: 2.2, col: GOLDC, sel: k >= 1 ? 1 : 0 }); }); }
  }
  // ---------- 字幕（左下角）+ 旁白（中间） ----------
  function subTitle(s) { if (s.title) return s.title; var c = String(s.content || '').trim().replace(/^【[^】]*】\s*/, ''), t = c.split('\n')[0], m = t.match(/^[^。！？!?]{4,40}[。！？!?]/); t = m ? m[0] : t; return t.length > 34 ? t.slice(0, 34) + '…' : t; }
  function bodyOf(s) { var c = String(s.content || '').trim().replace(/^【[^】]*】\s*/, '').replace(/[*#`>_~]+/g, ' ').replace(/\s+/g, ' ').trim(); return c.length > 150 ? c.slice(0, 150) + '…' : c; }
  function cosSub(s) { var el = $('csub'); if (!el) return; document.body.classList.toggle('cos-sel', !!s); if (!s) { el.classList.remove('open'); return; }
    var h, ig = KC.ignoreTags || [];
    if (s.core) { var info = (DATA.personas || []).find(function (p) { return p.id === PRIMARY; }) || {}; h = '<div class="t"><i>✦</i>原意识 · ' + esc(info.name || pname(PRIMARY)) + '</div><div class="m"><span class="c gold">恒星级 · 本体</span><span class="c">核心卡</span></div><div class="b">' + esc(String(info.core || '').replace(/【[^】]*】/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150)) + '…</div>'; }
    else { var tags = (s.tags || []).filter(function (t) { return ig.indexOf(t) < 0; }).slice(0, 2), tr = s.tierC || (s.cst || s.cfaint ? 'persona' : '');
      h = '<div class="t"><i>+</i>' + esc(subTitle(s)) + '</div><div class="m"><span class="d">' + U8.day(s.created_at) + '</span>' + tags.map(function (t) { return '<span class="c">' + esc(t) + '</span>'; }).join('') + (s.item ? '<span class="c">' + esc(kindInfo(s).label) + '</span>' : '') +
        (TIERN[tr] ? '<span class="c t-' + tr + '">' + TIERN[tr] + '</span>' : s.persona !== PRIMARY ? '<span class="c">' + esc(pname(s.persona)) + '</span>' : '') + (tr === 'gray' ? '<span class="c t-gray">' + forgetText(s) + '</span>' : '') + '</div><div class="b">' + esc(bodyOf(s) || '（只有标题）') + '</div>'; }
    h += '<div class="a"><a data-a="open">查看全文 ›</a>' + (s.core || s.item ? '' : '<a data-a="edit">在工作台编辑</a>') + '<a data-a="close">✕ 收起</a></div>';
    el.innerHTML = h; el.classList.remove('open'); void el.offsetWidth; el.classList.add('open'); el._s = s; }
  if ($('csub')) $('csub').addEventListener('click', function (e) { var a = e.target.closest('[data-a]'), s = this._s; if (!a || !s) return; stopTour(); var k = a.dataset.a; if (k === 'open') s.core ? showCore() : show(s); else if (k === 'edit') window.Workbench && window.Workbench.editMemory(s.id); else { select(null); closeSheet(); } });
  var narT = 0; function narrate(txt, ms) { var el = $('cnarr'); if (!el || KC.narration === false) return; clearTimeout(narT); if (!txt) { el.classList.remove('on'); return; } el.textContent = txt; el.classList.remove('on'); void el.offsetWidth; el.classList.add('on'); narT = setTimeout(function () { el.classList.remove('on'); }, ms || 5200); }
  function tierLine(s) { var t = s.tierC; if (t === 'stellar') return '恒星级 · ' + (s.pinned ? '钉住的核心记忆，永远不会褪色' : '最重要的本体记忆，紧挨着原意识');
    if (t === 'planet') return '行星级 · ' + (s.item ? '整理好的' + kindInfo(s).label : s.kind === 'cognition' ? '整理出的认知' : '重要、常被想起的记忆') + ' · 写于 ' + U8.ago(s.created_at);
    if (t === 'gray') return '越过了灰度边界 · 清晰度 ' + Math.round(strOf(s) * 100) + '% · ' + forgetText(s);
    if (t === 'star') return '星星级 · 零散的碎片记忆 · ' + U8.ago(s.created_at); return s.persona !== PRIMARY ? pname(s.persona) + ' 的星座' : ''; }
  function statLine() { var o = { stellar: 0, planet: 0, star: 0, gray: 0 }; stars.forEach(function (s) { if (s.tierC) o[s.tierC]++; }); return '恒星 ' + o.stellar + ' · 行星 ' + o.planet + ' · 星星 ' + o.star + ' · 灰度边界外 ' + o.gray + '　|　越久远，离中心越远'; }
  // ---------- 自动漫游：空闲一会儿后镜头在记忆之间缓缓移动，逐条显示字幕 ----------
  var tour = { on: false, list: null, k: 0, t: 0 };
  function tourList() { var by = { stellar: [], planet: [], star: [], gray: [] }; stars.forEach(function (s) { if (s.persona === PRIMARY && by[s.tierC] && visible(s)) by[s.tierC].push(s); });
    for (var k in by) by[k].sort(function (a, b) { return (b.br + hz(b.id + 'tour') * .5) - (a.br + hz(a.id + 'tour') * .5); });
    var pat = ['stellar', 'planet', 'star', 'planet', 'gray', 'star', 'planet', 'stellar', 'star', 'gray'], out = [], ix = { stellar: 0, planet: 0, star: 0, gray: 0 };
    for (var r = 0; r < 60 && out.length < 40; r++) { var tn = pat[r % pat.length], L = by[tn]; if (L.length) { out.push(L[ix[tn] % L.length]); ix[tn]++; } } return out; }
  function startTour(manual) { if (!COS || !DATA || tour.on) return; tour.on = true; if (!tour.list) tour.list = tourList(); tour.t = manual ? 0 : .3; var b = $('cTour'); if (b) b.classList.add('on'); }
  function stopTour() { if (!tour.on) return; tour.on = false; var b = $('cTour'); if (b) b.classList.remove('on'); }
  function tourTick(dt) {
    var B = document.body.classList;
    if (!tour.on) { if (KC.tourIdle > 0 && DATA && idleT > KC.tourIdle * (sel ? 2 : 1) && !B.contains('wb-open') && !B.contains('cos-q') && !$('sheet').classList.contains('open') && !$('list').classList.contains('open') && !$('menu').classList.contains('open')) startTour(); return; }
    if (B.contains('wb-open') || $('sheet').classList.contains('open')) { stopTour(); return; }
    tour.t -= dt; if (tour.t > 0) return; var dw = KC.tourDwell || 7, k = tour.k++;
    if (k % 6 === 5 || !tour.list.length) { select(null, { tour: 1 }); orb.tph = CC.phi; narrate(statLine(), dw * 900); tour.t = dw * .8; return; }
    var s = tour.list[(k - Math.floor(k / 6)) % tour.list.length]; if (!s || byId[s.id] !== s) { tour.list = tourList(); tour.t = .1; return; }
    select(s, { fly: true, tour: true }); orb.tph = .8 + hz(s.id + 'v') * .45; narrate(tierLine(s), dw * 800); tour.t = dw; }
  // ---------- 空闲 / 漫游时偶尔闪一下两颗相关记忆之间的连线 ----------
  var amb = [], ambT = 1.5, NA = Math.max(1, LK.ambientMax || 6), ambObj = null;
  (function () { var g = new THREE.BufferGeometry(), Q = new Float32Array(NA * 8); for (var i = 0; i < NA * 2; i++) Q.set([-100, 1, 0, 0], i * 4); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NA * 6), 3)); g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(NA * 8), 4)); g.setAttribute('aChain', new THREE.BufferAttribute(Q, 4)); if (COS) { ambObj = new THREE.LineSegments(g, lineMat()); ambObj.frustumCulled = false; G.add(ambObj); } })();
  function spawnAmb(t) { var L = assoc && assoc.userData.L || [], a = null, b = null;
    for (var tries = 0; tries < 8 && !b; tries++) { if (L.length && Math.random() < .6) { var l = L[Math.floor(Math.random() * L.length)]; a = byId[l.a]; b = byId[l.b]; } else { a = stars[Math.floor(Math.random() * stars.length)]; var m = a && a.tags && a.tags.length ? consMembers(a) : []; b = m.length ? m[Math.floor(Math.random() * Math.min(4, m.length))] : null; }
      if (a && b && (!visible(a) || !visible(b) || a.tierC === 'gray' || b.tierC === 'gray' || a.p.distanceTo(b.p) > RMAX * .9)) b = null; }
    if (!b) return; var col = new THREE.Color(1, .93, .8); amb.push({ a: a.p, b: b.p, t0: t, dur: 1.8 + Math.random() * 1.2 }); flights.push({ a: a.p, b: b.p, t0: t + .2, dur: 1.3 + a.p.distanceTo(b.p) / 300, col: col, end: b, w: .25 }); flares[a.i] = Math.max(flares[a.i] || 0, .35); }
  function ambientTick(dt, t) { if (!ambObj) return; var on = LK.ambient !== false && DATA && (tour.on || (!sel && idleT > 3)), mx = Math.max(1, Math.round(NA * LKS)); ambT -= dt;
    if (on && ambT <= 0 && amb.length < mx) { ambT = (LK.ambientEvery || 2.2) * (.5 + Math.random()) / Math.max(.2, LKS); spawnAmb(t); }
    var P = ambObj.geometry.attributes.position.array, C = ambObj.geometry.attributes.aCol.array, A = LK.ambientAlpha == null ? .32 : LK.ambientAlpha;
    for (var i = amb.length - 1; i >= 0; i--) if ((t - amb[i].t0) / amb[i].dur >= 1) amb.splice(i, 1);
    for (i = 0; i < NA; i++) { var x = amb[i], al = 0; if (x) { var u = (t - x.t0) / x.dur, f = Math.sin(Math.PI * u); al = A * f * f * (.85 + .15 * Math.sin(t * 23 + i)); P.set([x.a.x, x.a.y, x.a.z, x.b.x, x.b.y, x.b.z], i * 6); } C.set([.95, .9, .82, al, .95, .9, .82, al * .5], i * 8); }
    ambObj.geometry.attributes.position.needsUpdate = true; ambObj.geometry.attributes.aCol.needsUpdate = true; }
  // ---------- 每帧：双星绕转 / 漫游 / 闪烁线；DOM：灰度标签 / 边界名 / 悬停提示 ----------
  var cfr = 0, tv2 = new THREE.Vector3();
  function cosTick(dt, t) { var a = t * 6.2832 / (KC.twinPeriod || 26), gp = (KC.twinGap || 11) * (GROW ? 1 + (GR.coreGrow || 0) * GS.c * .5 : 1) / 2, ts = (KC.twinSize || 58) * (1 + .05 * Math.sin(t * 1.3)) * (GROW ? 1 + (GR.coreGrow || 0) * GS.c * .4 : 1);
    if (twins.length) { twins[0].position.set(Math.cos(a) * gp, Math.sin(a) * gp * .55, Math.sin(a) * gp * .45); twins[1].position.copy(twins[0].position).multiplyScalar(-1); ts *= 1 + thinkKick * .6; twins[0].scale.set(ts, ts, 1); twins[1].scale.set(ts * .94, ts * .94, 1); }
    if (DATA) { tourTick(dt); ambientTick(dt, t); } }
  function cosFrame() { if (!DATA || (cfr++ % 2)) return; var W = innerWidth, H = innerHeight;
    var sc = GRAYS.map(function (s) { var q = scr(s.p); return [s, q]; }).filter(function (x) { return x[1][2] < 1 && x[1][0] > 0 && x[1][0] < W && x[1][1] > 30 && x[1][1] < H - 30 && visible(x[0]); }).sort(function (a, b) { return a[1][3] - b[1][3]; });
    gPool.forEach(function (el, i) { var x = sc[i]; if (!x) { el.style.display = 'none'; return; } el.style.display = ''; if (el._s !== x[0]) { el._s = x[0]; el.textContent = forgetText(x[0]); } el.style.transform = 'translate(' + (x[1][0] + 8) + 'px,' + (x[1][1] - 7) + 'px)'; });
    if (ringEl && RING_R) { tv2.copy(cam.position); G.worldToLocal(tv2); var an = Math.atan2(tv2.z, tv2.x), q = scr(tv2.set(Math.cos(an) * RING_R, 0, Math.sin(an) * RING_R)); if (q[2] > 1 || q[1] > H - 40 || q[1] < 20) ringEl.style.display = 'none'; else { ringEl.style.display = ''; ringEl.style.transform = 'translate(' + (q[0] - ringEl.offsetWidth / 2) + 'px,' + (q[1] + 6) + 'px)'; } }
    if (hov && hov !== CORE) { var p = scr(hov.p), tp = $('ctip'); tp.style.transform = 'translate(' + (p[0] + 12) + 'px,' + (p[1] - 30) + 'px)'; } }
  // 悬停：小提示 + 预览星座
  var hovT = 0;
  function tipOff() { var tp = $('ctip'); if (tp) tp.classList.remove('on'); if (hov && !sel) consClear(); hov = null; }
  if (COS) { cv.addEventListener('pointermove', function (e) { if (e.buttons || !DATA || Object.keys(ptrs).length) return; var now = performance.now(); if (now - hovT < 60) return; hovT = now;
      var s = hit(e.clientX, e.clientY), tp = $('ctip'); cv.style.cursor = s ? 'pointer' : '';
      if (s === hov) return; if (!s) { tipOff(); return; } hov = s;
      tp.textContent = s === CORE ? '原意识 · ' + pname(PRIMARY) : subTitle(s) + (s.tierC ? '　' + TIERN[s.tierC] : ''); tp.classList.add('on');
      if (s === CORE) { tp.style.transform = 'translate(' + (e.clientX + 12) + 'px,' + (e.clientY - 30) + 'px)'; return; }
      if (!sel && KC.hoverConstellation !== false) cons(s, .55); });
    cv.addEventListener('pointerleave', tipOff);
    document.addEventListener('keydown', function (e) { if (tour.on && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) stopTour(); }, true);
    if (KC.hint && $('chint')) $('chint').textContent = KC.hint; }
  // ---------- 搜索框：平时藏起来，按 / 或点「搜索」才出现 ----------
  function openSearch(withFilters) { if (!COS) { $('q').focus(); return; } stopTour(); document.body.classList.add('cos-q'); if (withFilters) { $('filters').classList.add('open'); $('ft').textContent = '筛选 ▴'; } setTimeout(function () { $('q').focus(); $('q').select(); }, 30); }
  function closeSearchSoon() { setTimeout(function () { if (document.activeElement !== $('q') && !$('qr').classList.contains('open') && !$('filters').classList.contains('open')) document.body.classList.remove('cos-q'); }, 260); }
  if (COS) { $('q').addEventListener('blur', closeSearchSoon); $('q').addEventListener('keydown', function (e) { if (e.key === 'Escape') { $('q').blur(); $('filters').classList.remove('open'); $('ft').textContent = '筛选 ▾'; document.body.classList.remove('cos-q'); } });
    document.addEventListener('click', function (e) { if (document.body.classList.contains('cos-q') && !e.target.closest('#top') && !e.target.closest('#cctl') && !e.target.closest('#menu')) { $('filters').classList.remove('open'); $('ft').textContent = '筛选 ▾'; closeSearchSoon(); } }); }
  // ---------- 主题切换：记在本机浏览器里，然后刷新 ----------
  function setTheme(t) { t = t === 'classic' ? 'classic' : 'cosmos'; try { localStorage.setItem('brain.theme', t); } catch (e) {} var u = new URL(location.href); u.searchParams.delete('theme'); location.href = u.toString(); }
  addEventListener('resize', resize); resize(); requestAnimationFrame(tick);

  window.StarMap = {
    ok: true, load: load, reload: reload, toast: toast,
    onSelect: function (f) { listeners.select.push(f); },
    select: function (id, opt) { if (id === '__core') return select(CORE, opt); var s = byId[id]; if (s) select(s, opt || { fly: true }); else select(null); return !!s; },
    focus: function (id) { var s = byId[id]; if (!s) return false; if (!visible(s)) { filt.groups = {}; filt.personas = {}; filt.scopes = {}; filt.until = null; buildFilters(); applyFilter(); } select(s, { fly: true }); return true; },
    show: function () { if (sel) sel.core ? showCore() : show(sel); }, closeSheet: closeSheet,
    pulse: onPulse, search: function (q) { $('q').value = q; runSearch(q); }, pickResult: pickResult,
    startPolling: function () { if (!poll._on) { poll._on = 1; poll(); if (TKON) setTimeout(thinkPoll, 600); } },
    think: function (id, rel) { var s = id ? byId[id] : null; if (!s) { var P = stars.filter(function (x) { return tOk(x) && x.tierC !== 'gray' && (adj[x.id] || []).length; }); s = P[Math.floor(Math.random() * P.length)]; } return think(s, (rel || []).map(function (x) { return byId[x]; }).filter(Boolean), 'demo') ? s.id : null; },
    thinkEvent: thinkEvent, thinking: function () { return { enabled: TKON, active: thoughts.length, queued: tQueue.length, max: TMAX, fanout: TFAN, feed: tLive ? tMode : 'off', list: thoughts.map(function (x) { return { focal: x.f.id, rel: x.rel.map(function (o) { return o.id; }), src: x.src, t: +(U.uTime.value - x.t0).toFixed(2), end: +x.end.toFixed(2), stage: (function (el) { return el < x.ph[0] ? 'out' : el < x.ph[1] ? 'fan' : el < x.ph[2] ? 'back' : el < x.ph[3] ? 'home' : 'fade'; })(U.uTime.value - x.t0) }; }) }; },
    renderList: renderList, get selected() { return sel; }, get stars() { return stars; }, byId: function (id) { return byId[id]; },
    growth: function () { return { enabled: GROW, memories: GS.n, arms: GS.A1, radius: Math.round(GS.tR), dust: Math.round(GS.tf * DUSTCAP), dustCap: DUSTCAP, lowEnd: LOW, animating: GS.M < 1 || !!GL }; },
    theme: THEME, setTheme: setTheme, tour: function (on) { if (!COS) return false; on = on == null ? !tour.on : on; on ? startTour(true) : stopTour(); return tour.on; }, get touring() { return COS && tour.on; }, openSearch: openSearch,
    tiers: function () { var o = { stellar: 0, planet: 0, star: 0, gray: 0 }; stars.forEach(function (s) { if (s.tierC) o[s.tierC]++; }); return o; },
    orbit: orb, screenOf: function (id) { var s = byId[id]; if (!s) return null; G.updateMatrixWorld(); return scr(s.p); }
  };
})();
