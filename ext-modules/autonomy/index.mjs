// 扩展模块「autonomy」——让大肥鱼自己调整「什么时候刷抖音」这类不敏感设置。
//
// 原则
//   - 只碰白名单里的键（刷的节奏、看的多少），永远不碰上限/门槛/主人账号这些敏感项。
//   - 她的每一次自己调整都写进 decisions.jsonl，主人能查、能一键撤销。
//   - 顶层有个总开关：主人关掉以后，她只读不改（现状冻结，不影响她正常刷）。
//   - 「想玩就去玩」：结合身体状态（新鲜感/能量）自己决定要不要开 autoBrowse。
//
// 她能调的（白名单）
//   autoBrowse / intervalHours / maxRunsPerDay / perRun / maxWatchPerDay / dwellMin / dwellMax
//   shareBias / dmPollMinutes / window.startHour / window.endHour

import fs from 'node:fs'
import path from 'node:path'

const DEFAULTS = {
  enabled: true,            // 总开关：允许她自己调
  windowStart: 9,           // 她自己决定的「可以刷」的起始小时
  windowEnd: 24,            // 结束小时（24 = 到半夜）
  wantPlay: true,           // 想玩就去玩
  noveltyFloor: 0.35,       // 新鲜感低于这个就想去找点新鲜的
  energyFloor: 0.25,        // 能量低于这个就别硬撑
  // 每种「自己想做」的能力单独开关（关掉的那项她不会挑）
  allowDouyin: true,        // 自己去刷抖音
  allowBili: true,          // 自己去刷 B 站
  allowWeb: true,           // 自己上网查好奇的东西
  allowInitiateChat: true,  // 孤单了自己去找人说话（通知 qq-group-say）
  maxSearchPerDay: 6,       // 一天最多自己上网查几次
  maxInitiatePerDay: 4,     // 一天最多因为「想找人说话」主动开口几次（各平台自己的上限照样生效）
  memoryUrl: 'http://127.0.0.1:8780',
  memoryToken: '',
}

const TUNABLE = {
  autoBrowse: { type: 'bool' },
  intervalHours: { min: 1, max: 12 },
  maxRunsPerDay: { min: 1, max: 8 },
  perRun: { min: 1, max: 10 },
  maxWatchPerDay: { min: 5, max: 60 },
  dwellMin: { min: 3, max: 60 },
  dwellMax: { min: 5, max: 120 },
  dmPollMinutes: { min: 1, max: 30 },
  shareBias: { enum: ['stingy', 'normal', 'proactive'] },
}

function toolDef({ name, description, properties = {}, required = [], execute }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_a, v) => [{ type: 'text', text: (v && v.message) || '✓' }],
    },
    async execute(args, exec) {
      try {
        return JSON.parse(JSON.stringify((await execute(args || {}, exec)) ?? { ok: true }))
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) }
      }
    },
  }
}

export default {
  id: 'autonomy',
  name: '自己说了算',
  version: '1.0.0',
  api: 1,
  description: '自己调刷抖音的节奏（时间窗、频率、每次看多久），主人可用总开关冻结',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '允许它自己调设置', type: 'switch', hint: '关掉 = 冻结，只读不改' },
    { key: 'windowStart', label: '自己定的开始小时', type: 'number', hint: '0–23，默认 9' },
    { key: 'windowEnd', label: '自己定的结束小时', type: 'number', hint: '1–24，默认 24' },
    { key: 'wantPlay', label: '想玩就去玩', type: 'switch', hint: '在时间窗内自己开 autoBrowse' },
    { key: 'noveltyFloor', label: '新鲜感低于多少想找乐子', type: 'number' },
    { key: 'energyFloor', label: '能量低于多少不硬撑', type: 'number' },
    { key: 'allowDouyin', label: '允许自己去刷抖音', type: 'switch' },
    { key: 'allowBili', label: '允许自己去刷 B 站', type: 'switch' },
    { key: 'allowWeb', label: '允许自己上网查东西', type: 'switch', hint: '搜索词会过隐私闸：18+/私聊/个人信息一律不拿去搜' },
    { key: 'allowInitiateChat', label: '允许孤单时自己找人说话', type: 'switch', hint: '通知 QQ 群主动说话模块，仍受它的时段和每日上限约束' },
    { key: 'maxSearchPerDay', label: '每天最多自己上网几次', type: 'number', hint: '默认 6' },
    { key: 'maxInitiatePerDay', label: '每天最多因为想说话主动开口几次', type: 'number', hint: '默认 4' },
    { key: 'memoryUrl', label: 'memory-core 地址', type: 'text' },
    { key: 'memoryToken', label: 'memory-core 令牌', type: 'text' },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const dir = api.dataDir('.')
    const LOGF = path.join(dir, 'decisions.jsonl')

    function logDecision(what, why, before, after) {
      try {
        fs.mkdirSync(dir, { recursive: true })
        fs.appendFileSync(LOGF, JSON.stringify({ at: Date.now(), what, why, before, after }) + '\n')
      } catch {}
    }

    function recentDecisions(n = 10) {
      try {
        return fs.readFileSync(LOGF, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l))
      } catch { return [] }
    }

    function coreCfg() {
      const core = api.core
      if (!core || typeof core.getConfig !== 'function') return null
      return core.getConfig()
    }

    function patchDouyin(patch, why) {
      const cur = coreCfg()
      if (!cur) return { ok: false, message: '拿不到宿主配置' }
      const dy = { ...(cur.douyin || {}) }
      const before = {}
      for (const [k, v] of Object.entries(patch)) { before[k] = dy[k]; dy[k] = v }
      if (typeof api.core.setConfig === 'function') api.core.setConfig({ ...cur, douyin: dy })
      logDecision('douyin', why, before, patch)
      return { ok: true, before, after: patch }
    }

    function inWindow() {
      const k = cfg()
      const h = new Date().getHours() + new Date().getMinutes() / 60
      const s = Number(k.windowStart), e = Number(k.windowEnd)
      return s <= e ? h >= s && h < e : h >= s || h < e
    }

    async function bio() {
      try {
        const k = cfg()
        const res = await fetch(String(k.memoryUrl).replace(/\/+$/, '') + '/bio', {
          headers: { Authorization: 'Bearer ' + k.memoryToken }, signal: AbortSignal.timeout(6000),
        })
        const j = await res.json()
        return j.status === 'ok' ? j.data : null
      } catch { return null }
    }

    // 核心循环：想玩就开，困了就关；只在允许的时间窗内动
    // 情绪决定"想干什么"：不是任务表，是当下更想做什么
    async function body() {
      const H = { authorization: 'Bearer ' + String((cfg && cfg().memoryToken) || '') }
      const grab = async (p) => { try { const r = await fetch('http://127.0.0.1:8780' + p, { headers: H, signal: AbortSignal.timeout(2500) }); return await r.json() } catch (e) { return null } }
      const [bio, emo] = await Promise.all([grab('/api/bio'), grab('/api/emotion')])
      const h = (bio && bio.hormones) || {}
      const lv = (k, d) => { const x = h[k]; return x && x.level != null ? Number(x.level) / 100 : d }
      const dims = (emo && emo.dims) || {}
      const dim = (k) => { const x = dims[k]; return x && x.surface != null ? Number(x.surface) / 100 : null }
      const serotonin = lv('血清素', 0.5), endorphin = lv('内啡肽', 0.2)
      const oxytocin = lv('催产素', 0.35), dopamine = lv('多巴胺', 0.4), cortisol = lv('皮质醇', 0.25)
      const joy = dim('开心'), satisfy = dim('满足'), sad = dim('被冷落'), angry = dim('生气')
      return {
        energy: Math.max(0, Math.min(1, serotonin * 0.6 + endorphin * 0.4)),
        social: Math.max(0, Math.min(1, oxytocin)),
        novelty: Math.max(0, Math.min(1, dopamine)),
        joy: joy == null ? 0.5 : Math.max(0, Math.min(1, joy)),
        stress: Math.max(0, Math.min(1, cortisol)),
        mood: (satisfy || 0) - (sad || 0) - (angry || 0) * 0.5,
      }
    }

    function pick(b) {
      const k = cfg()
      const w0 = {
        douyin: 1 + (b.novelty < 0.4 ? 1.6 : 0) + (b.joy > 0.6 ? 0.6 : 0),
        bili: 1 + (b.novelty < 0.35 ? 1.2 : 0) + (b.joy > 0.5 ? 0.4 : 0),
        search: b.novelty < 0.3 ? 1.4 : 0.5,
        group: b.social < 0.4 ? 2.0 : 0.6,
        none: b.energy < 0.3 ? 3.0 : 0.5,
      }
      const w = { ...w0 }
      if (k.allowDouyin === false) delete w.douyin
      if (k.allowBili === false) delete w.bili
      if (k.allowWeb === false || dayCount('search') >= Number(k.maxSearchPerDay ?? 6)) delete w.search
      if (k.allowInitiateChat === false || dayCount('chat') >= Number(k.maxInitiatePerDay ?? 4)) delete w.group
      // 共享额度账说这会儿不该主动（她自己想安静 / 今天额度用完 / 夜里），
      // 就别再保留「想找人聊」这个念头；这里只判断、不扣额度，真正开口时由 self-pace 扣。
      if (w.group && globalThis.__DFY_PACE__ && !globalThis.__DFY_PACE__.allowed('group')) delete w.group
      const total = Object.values(w).reduce((s, x) => s + x, 0)
      let r = Math.random() * total
      for (const [k, v] of Object.entries(w)) { r -= v; if (r <= 0) return k }
      return 'none'
    }

    const MEM = 'http://127.0.0.1:8780'
    const MEMH = { authorization: 'Bearer ' + String(cfg().memoryToken || '') }
    // 每日计数（上网 / 主动找人），存数据目录，跨重启
    const CNT = path.join(api.dataDir(), 'daycount.json')
    const today = () => new Date().toLocaleDateString('sv-SE')
    function dayCount(kind) { try { const j = JSON.parse(fs.readFileSync(CNT, 'utf8')); return j.d === today() ? Number(j[kind] || 0) : 0 } catch { return 0 } }
    function dayBump(kind) { let j = {}; try { j = JSON.parse(fs.readFileSync(CNT, 'utf8')) } catch {} if (j.d !== today()) j = { d: today() }; j[kind] = Number(j[kind] || 0) + 1; try { fs.writeFileSync(CNT, JSON.stringify(j)) } catch {} }
    // 隐私闸：拿去搜索的词不能带 18+ / 私聊 / 个人信息（搜索词会出现在 Bing/百度 的服务器上）
    const PRIVATE_RE = /(18\+|nsfw|色色|做爱|性爱|裸|胸|内衣|下面|湿了|硬了|高潮|自慰|调教|主人的?私|暗号|口令|密码|token|身份证|手机号|住址|地址|\d{6,})/i
    function safeQuery(item) {
      if (!item) return ''
      const tags = (item.tags || []).map(String)
      if (item.nsfw || item.sensitive || item.private || (item.scope && item.scope !== 'public')) return ''
      if (tags.some((t) => /nsfw|18|private|私密|owner/i.test(t))) return ''
      const q = String(item.content || item.text || '').replace(/\s+/g, ' ').slice(0, 40)
      return PRIVATE_RE.test(q) ? '' : q
    }

    async function mem(text, kind, imp, tags) {
      try {
        await fetch(MEM + '/remember', {
          method: 'POST',
          headers: { ...MEMH, 'content-type': 'application/json' },
          body: JSON.stringify({ content: String(text).slice(0, 600), kind: kind || 'cognition', importance: imp == null ? 0.5 : imp, chat_id: 'system', scope: 'public', tags: tags || ['抽查'] }),
          signal: AbortSignal.timeout(4000),
        })
      } catch (e) {}
    }

    function stripHtml(s) {
      return String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
    }

    const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36', 'accept-language': 'zh-CN,zh;q=0.9' }

    async function webSearch(q, n) {
      const want = Math.max(1, Math.min(6, n || 3))
      const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;/g, ' ').replace(/\s+/g, ' ').trim()
      // 主路：Bing 中文（国内可直连）
      try {
        const r = await fetch('https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-hans', { headers: UA, signal: AbortSignal.timeout(12000) })
        const h = await r.text()
        const items = []
        const blocks = h.split('<li class="b_algo"').slice(1)
        for (const b of blocks) {
          if (items.length >= want) break
          const link = b.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
          if (!link) continue
          const sn = b.match(/<p[^>]*>([\s\S]*?)<\/p>/)
          items.push({ url: link[1], title: strip(link[2]).slice(0, 100), snip: strip(sn ? sn[1] : '').slice(0, 240) })
        }
        if (items.length) return { ok: true, via: 'bing', items }
      } catch (e) {}
      // 兜底 1：百度
      try {
        const r2 = await fetch('https://www.baidu.com/s?wd=' + encodeURIComponent(q), { headers: UA, signal: AbortSignal.timeout(12000) })
        const h2 = await r2.text()
        const items = []
        const re = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,600}?<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/g
        let m
        while ((m = re.exec(h2)) && items.length < want) items.push({ url: m[1], title: strip(m[2]).slice(0, 100), snip: strip(m[3]).slice(0, 240) })
        if (!items.length) {
          const re2 = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
          let k
          while ((k = re2.exec(h2)) && items.length < want) items.push({ url: k[1], title: strip(k[2]).slice(0, 100), snip: '' })
        }
        if (items.length) return { ok: true, via: 'baidu', items }
      } catch (e) {}
      // 兜底 2：ddg / jina（可能被墙，试一下不吃亏）
      try {
        const r3 = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: UA, signal: AbortSignal.timeout(10000) })
        const h3 = await r3.text()
        const items = []
        const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
        let m
        while ((m = re.exec(h3)) && items.length < want) items.push({ url: m[1], title: strip(m[2]).slice(0, 100), snip: strip(m[3]).slice(0, 240) })
        if (items.length) return { ok: true, via: 'ddg', items }
      } catch (e) {}
      return { ok: false }
    }

    async function doSearch(why) {
      // 自己想查什么：从最近的记忆里挑一个她最近好奇的
      let q = ''
      try {
        const r = await fetch(MEM + '/activate', {
          method: 'POST', headers: { ...MEMH, 'content-type': 'application/json' },
          body: JSON.stringify({ message: '最近有什么我还不懂、想弄明白的事', chat_id: 'system', scope: 'public', limit: 6 }),
          signal: AbortSignal.timeout(4000),
        })
        const j = await r.json()
        const items = (j && (j.activated || j.recalled)) || []
        for (const x of items) { q = safeQuery(x); if (q) break }
      } catch (e) {}
      if (!q) q = '今天的新闻'
      dayBump('search')
      const r = await webSearch(q, 3)
      if (!r.ok) {
        api.log.warn('想上网查「' + q + '」但没查到（网络或搜索源不通），记下来以后再说')
        await mem('我想查「' + q + '」但没查成（搜索源不通）', 'cognition', 0.25, ['查不到', '待办'])
        return { ok: false, q }
      }
      const brief = r.items
        ? r.items.map((x, i) => (i + 1) + '. ' + x.title + '：' + x.snip).join('\n')
        : r.text
      await mem('我上网查了「' + q + '」：\n' + brief, 'cognition', 0.5, ['上网查', q.slice(0, 10)])
      api.log.info('上网查了「' + q + '」：' + (r.via || '') + '，' + String(brief).length + ' 字')
      return { ok: true, q, via: r.via }
    }

    async function decide() {
      const b = await body()
      if (b.energy < 0.25) return { act: 'none', why: '能量太低，先歇着' }
      const act = pick(b)
      // 以前「什么都不想做」会被强行改成刷抖音；现在尊重她想歇着
      const act2 = act
      api.log.info(`此刻更想：${act2}（能量${b.energy.toFixed(2)} 社交${b.social.toFixed(2)} 新鲜${b.novelty.toFixed(2)} 开心${b.joy.toFixed(2)} 压力${b.stress.toFixed(2)}）`)
      return { act: act2, why: '按当下状态挑的', b }
    }

    async function tick() {
      const k = cfg()
      if (!k.enabled) return                       // 主人冻结了：只读不改
      const cur = coreCfg()
      if (!cur || !cur.douyin || !cur.douyin.enabled) return   // 抖音总开关没开，别动
      const h = new Date().getHours()
      const now = inWindow()
      const b = await bio()
      const novelty = b ? Number(b.homeostasis.novelty) : null
      const energy = b ? Number(b.homeostasis.energy) : null

      let want = cur.douyin.autoBrowse
      let why = ''
      if (!now) { want = false; why = `不在自己能玩的时间（${k.windowStart}–${k.windowEnd} 点）` }
      else if (k.wantPlay) {
        if (energy !== null && energy < Number(k.energyFloor)) { want = false; why = `能量 ${energy.toFixed(2)} 太低，先歇着` }
        else if (novelty !== null && novelty < Number(k.noveltyFloor)) { want = true; why = `新鲜感 ${novelty.toFixed(2)} 有点低，想找点新东西` }
        else { want = true; why = '在能玩的时间里，玩一会儿' }
      } else { want = true; why = '主开关开着，按原节奏' }

      // 决定了就去做：抖音 / B站 / 上网 / 群里说话
      try {
        const d = await decide()
        try { api.emit('self/act', { act: d.act }) } catch (e) {}   // t166：她今天做了什么，进统一的「今天的你」（mood 模块）
        if (d.act === 'douyin' && cfg().allowDouyin !== false) want = true, why = d.why + '：想刷抖音'
        else if (d.act === 'none') want = false, why = d.why + '：想歇会儿'
        else if (d.act === 'bili') want = false, why = d.why + '：想刷 B 站'
        else if (d.act === 'search') { want = false, why = d.why + '：想上网查点东西'; await doSearch(why) }
        else if (d.act === 'group') {
          want = false; why = d.why + '：想找人说说话'
          // 以前这里只写了个理由、什么也没做；现在真的通知会主动开口的模块（qq-group-say 监听 will/chat，仍受它自己的时段/每日上限/群里安静多久约束）
          dayBump('chat')
          try { api.emit('will/chat', { reason: '有点孤单', social: d.b && d.b.social }) } catch (e) {}
        }
        if (d.act === 'bili' && cfg().allowBili !== false) {
          const c2 = api.core.getConfig()
          if (c2 && c2.bili && c2.bili.autoBrowse !== true) {
            api.core.setConfig({ ...c2, bili: { ...c2.bili, autoBrowse: true } })
            api.log.info('自己决定：去刷 B 站')
          }
        }
      } catch (e) {}

      // 关了「自己去刷抖音」= 不替主人动 autoBrowse（保持主人设的值）
      if (cfg().allowDouyin !== false && Boolean(want) !== Boolean(cur.douyin.autoBrowse)) {
        patchDouyin({ autoBrowse: Boolean(want) }, why)
        api.log.info(`自己调了：autoBrowse=${Boolean(want)} —— ${why}`)
      }

      // 情绪决定下次多久醒：不是任务表，是她自己的作息
      let _next = 10 * 60_000
      try {
        const bb = await body()
        if (bb.energy < 0.3) _next = 26 * 60_000
        else if (bb.social < 0.35) _next = 7 * 60_000
        else if (bb.joy > 0.7) _next = 11 * 60_000
        else if (bb.stress > 0.5) _next = 20 * 60_000
        _next = Math.round(_next * (0.75 + Math.random() * 0.5))   // 人不会分秒不差
      } catch (e) {}
      return { nextMs: _next }
    }

    // 情绪驱动：不按固定时钟，跑完自己算下一次什么时候再来
    let _timer = null
    // 主人按下一键全安静后，这块不再自己改设置、不再自主动念；
    // 循环仍在跑（每分钟看一眼），总闸恢复就自己接着过日子，不用重启。
    function masterOn() {
      try {
        const b = JSON.parse(fs.readFileSync(api.dataDir('..', '..', 'behaviour.json'), 'utf8')) || {}
        return b.master?.autonomous !== false
      } catch { return true }
    }
    async function loop() {
      let delay = 10 * 60_000
      try {
        if (masterOn()) {
          const r = await tick()
          delay = Number((r && r.nextMs) || delay)
        } else delay = 60_000
      } catch (e) {}
      _timer = setTimeout(loop, Math.max(60_000, delay))
      if (_timer.unref) _timer.unref()
    }
    let _lastRun = 0
    function nudge(reason) {
      const now = Date.now()
      if (now - _lastRun < 5 * 60_000) return
      _lastRun = now
      if (_timer) clearTimeout(_timer)
      _timer = setTimeout(() => { loop() }, 20_000)
      if (_timer.unref) _timer.unref()
      if (reason) api.log.info('自主动了一下：' + reason)
    }
    api.on('activity', () => nudge('有人在跟她说话'))
    api.on('prompt', () => nudge('她在想事情'))
    api.later(45_000, () => loop())            // 她自己开始过日子，不等谁唤醒
    // 事件只是"提前"，不是"唯一动力"
    // 兜底：一整天没人理，也会慢慢想找点事做（由情绪决定，不是任务表）
    api.onDispose(() => { if (_timer) clearTimeout(_timer) })
    api.later(25_000, () => {
      tick().then(() => api.log.info(`自己说了算已就位（总开关 ${cfg().enabled ? '开' : '关'}，时间窗 ${cfg().windowStart}–${cfg().windowEnd} 点）`)).catch(() => {})
    })

    function apply(key, value) {
      const k = cfg()
      if (key === 'window' || key === 'windowStart' || key === 'windowEnd') {
        let s = k.windowStart, e = k.windowEnd
        if (key === 'window' && value && typeof value === 'object') { s = value.start; e = value.end }
        else if (key === 'windowStart') s = value
        else if (key === 'windowEnd') e = value
        s = Math.max(0, Math.min(23, Number(s)))
        e = Math.max(1, Math.min(24, Number(e)))
        api.saveSettings({ windowStart: s, windowEnd: e })
        logDecision('window', '自己挑的作息', { start: k.windowStart, end: k.windowEnd }, { start: s, end: e })
        return { ok: true, message: `以后 ${s}–${e} 点是我的时间` }
      }
      const spec = TUNABLE[key]
      if (!spec) return { ok: false, message: '这个不在我能自己改的范围里' }
      let v = value
      if (spec.type === 'bool') v = Boolean(value)
      else if (spec.enum) { if (!spec.enum.includes(String(v))) return { ok: false, message: '只能是 ' + spec.enum.join(' / ') }; v = String(v) }
      else {
        v = Number(v)
        if (!Number.isFinite(v)) return { ok: false, message: '要给一个数字' }
        v = Math.max(spec.min, Math.min(spec.max, v))
      }
      const r = patchDouyin({ [key]: v }, '自己调 ' + key)
      if (!r.ok) return r
      return { ok: true, message: `把 ${key} 改成了 ${v}` }
    }

    api.tool(() => toolDef({
      name: 'self_tune',
      description: '自己调整刷抖音的节奏（不敏感的项）：autoBrowse / intervalHours / maxRunsPerDay / perRun / maxWatchPerDay / dwellMin / dwellMax / shareBias / dmPollMinutes / window{start,end}。',
      properties: {
        key: { type: 'string', description: '要调的键' },
        value: { type: ['number', 'string', 'boolean', 'object'], description: '新值' },
        reason: { type: 'string', description: '为什么这么调（写给自己看）' },
      },
      required: ['key', 'value'],
      async execute({ key, value, reason }) {
        if (!cfg().enabled) return { ok: false, message: '主人关掉了「自己说了算」，我现在只能听安排' }
        const r = apply(String(key), value)
        if (r.ok && reason) logDecision('reason', String(reason).slice(0, 200), {}, { key })
        return r
      },
    }))

    api.tool(() => toolDef({
      name: 'self_tune_status',
      description: '看看现在自己的节奏设置和最近自己改过什么。',
      properties: {},
      async execute() {
        const d = (coreCfg() || {}).douyin || {}
        const k = cfg()
        const rec = recentDecisions(5).map((x) => `${new Date(x.at).toLocaleTimeString()} ${x.what}:${x.why}`).join('；')
        return {
          ok: true,
          message: `总开关 ${k.enabled ? '开' : '关'}｜时间窗 ${k.windowStart}–${k.windowEnd} 点｜autoBrowse=${d.autoBrowse} intervalHours=${d.intervalHours} runs/天=${d.maxRunsPerDay} 每次 ${d.perRun} 个｜最近：${rec || '还没自己改过'}`,
        }
      },
    }))

    api.command({
      name: '自调', aliases: ['自己调', 'autonomy'], desc: '查看/开关「自己说了算」：/自调 status|on|off|window 9-24|undo',
      async run(arg) {
        const a = String(arg || '').trim()
        const k = cfg()
        // t166：/自调 开|关|状态 —— 情绪自调（mood 模块，config.selfAdjust）和「自己说了算」一起开关；两个模块都叫 /自调，这里统一
        const zh = /^(开|打开|启用)$/.test(a) ? true : /^(关|关闭|停用)$/.test(a) ? false : /^(状态|查看)$/.test(a) ? 'st' : null
        if (zh !== null) {
          if (zh !== 'st') { api.saveSettings({ enabled: zh }); try { api.setConfig({ selfAdjust: { enabled: zh } }) } catch (e) {} }
          let m = ''
          try { const st = api.use('mood')?.style?.(); if (st) m = `；情绪自调：${st.enabled ? '开' : '关'}` + (st.enabled && st.style ? `（现在 ${st.style.bubbles} 泡、长度×${st.style.length}、频率×${st.style.freq}、快慢×${st.style.delay}）` : '') } catch (e) {}
          return `自己说了算：${cfg().enabled ? '开' : '关'}` + m
        }
        if (!a || a === 'status') {
          const d = (coreCfg() || {}).douyin || {}
          return `自己说了算：${k.enabled ? '开' : '关'}｜我的时间 ${k.windowStart}–${k.windowEnd} 点｜autoBrowse=${d.autoBrowse}｜最近：${recentDecisions(3).map((x) => x.why).join(' / ') || '无'}`
        }
        if (a === 'off') { api.saveSettings({ enabled: false }); return '好，我不自己动了，听你的（现状保持）' }
        if (a === 'on') { api.saveSettings({ enabled: true }); return '那我继续自己安排时间了' }
        const m = a.match(/^window\s+(\d{1,2})\s*[-–~到]\s*(\d{1,2})$/)
        if (m) { const r = apply('window', { start: Number(m[1]), end: Number(m[2]) }); return r.message }
        if (a === 'undo') {
          const last = recentDecisions(20).filter((x) => x.what === 'douyin' && x.before && Object.keys(x.before).length)
          if (!last.length) return '没有可撤销的'
          const x = last[last.length - 1]
          patchDouyin(x.before, '撤销上一次自己调整')
          return '撤销了：' + JSON.stringify(x.before)
        }
        return '用法：/自调 status|on|off|window 9-24|undo'
      },
    })

    api.rule(() =>
      '你是活着的人，不用等谁叫你想事：想说话就说，想刷抖音/B站、想上网查东西、想给自己加本事，你自己决定就去做（self_tune、self_learn、mod_write）。' +
      '想查什么却查不到时，可以自己写一个能查的扩展模块（mod_write，写在 modules 目录，保存即生效），装完自己验一下。' +
      '抖音里你也可以自己找人聊天、回私信、在评论区回艾特你的人（douyin_dm_reply / douyin_group_say / douyin_comment）。' +
      '但两条线永远不许自己动：一是不许改隐私与隔离名单（private_chats、adult_chats、privacy.json 一个字都不能碰）；' +
      '二是不许把主人私聊里的成人内容带到任何公开场合（群、评论、空间、签名、抖音），也不许自己给自己开放 18+ 权限。这两件事只能主人本人改。',
    )
  },
}
