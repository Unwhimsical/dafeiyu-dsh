// 扩展模块「douyin-dm」——让大肥鱼能看抖音私信（不只是主人那一条），在 QQ 里问得出来。
//
// 背景：内置抖音模块只会周期性看「主人」那一条私信并回话（src/douyin/duty.js checkOwnerDms），
// 没有给模型任何读取私信的工具，所以她在 QQ 里被问「抖音私信里有什么」只能答"看不见"。
// 这个模块补上：列出私信会话 + 点开某个人读最近几条。
//
// 只读，不发消息。会话列表容器在页面左侧（x<300），消息列表是 .messageMessageListlist，
// 必须只从左侧那个容器取行，否则会把消息气泡当成会话。

import fs from 'node:fs'
import path from 'node:path'
const __neu = (s) => String(s ?? '').replace(/[【〖]/g, '「').replace(/[】〗]/g, '」') // 外来文字【】→「」，防冒充系统提示

const PROFILE = process.env.DOUYIN_PROFILE_DIR || 'douyin/edge-profile'

const DEFAULTS = {
  enabled: true,
  lines: 12,
  ownerDouyin: '', // 主人抖音 uid（在面板填写）
  selfDouyin: '', // 她自己的抖音 uid（在面板填写）
  autoReply: true,
  replyTo: '', // 逗号分隔的 uid；空 = 只回主人和家人
  pollSeconds: 90,
  replyMaxChars: 400,
  memoryUrl: 'http://127.0.0.1:8780', // 固定 8780
  memoryToken: '',
  stickerChance: 0.3,
  groupNames: '', // 逗号分隔：这些名字的会话是群，私信模块永远不碰（交给 douyin-group）
}

// 左侧会话列表：先找 x<100、宽 240~330、高>300 且子行高 45~120 的容器
const ROWS_JS = `(() => {
  let box = null
  for (const el of document.querySelectorAll('div')) {
    const r = el.getBoundingClientRect()
    if (r.x > 160 || r.width < 200 || r.width > 460 || r.height < 240) continue
    const rows = [...el.children].filter((k) => { const b = k.getBoundingClientRect(); return b.height >= 45 && b.height <= 120 && b.width > 150 })
    if (rows.length < 1) continue
    if (!box || rows.length > box.rows.length) box = { el, rows }
  }
  if (!box) return []
  return box.rows.map((k) => {
    const b = k.getBoundingClientRect()
    return {
      x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
      lines: (k.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean),
    }
  })
})()`

const FOCUS_JS = `(() => {
  const e = document.querySelector('.editor-kit-container[contenteditable="true"]') ||
    [...document.querySelectorAll('[contenteditable="true"]')].find((x) => /发送消息/.test(x.getAttribute('data-placeholder') || ''))
  if (!e) return false
  e.focus()
  const r = document.createRange()
  r.selectNodeContents(e)
  r.collapse(false)
  const s = getSelection()
  s.removeAllRanges()
  s.addRange(r)
  return document.activeElement === e
})()`

const BOX_JS = `(() => (document.querySelector('.editor-kit-container[contenteditable="true"]') || document.querySelector('[contenteditable="true"]'))?.innerText || '')()`

// 当前打开会话的标题（消息区上方那行）
const HEADER_JS = `(() => {
  let best = ''
  for (const el of document.querySelectorAll('div,span')) {
    const r = el.getBoundingClientRect()
    if (r.x < 340 || r.y < 15 || r.y > 80 || r.width < 120 || r.height < 10 || r.height > 60) continue
    const t = (el.innerText || '').trim()
    if (!t || t.length > 120) continue
    if (/^(昨天|前天|\\d+分钟前|\\d+小时前|刚刚)/.test(t)) continue
    best = t
    break
  }
  return best
})()`

// 当前会话的消息（React fiber 原始对象）
const READ_JS = `(() => {
  const out = [], seen = new Set(), names = {}
  const push = (m) => {
    const sid = String(m.serverId ?? '')
    if (!sid || seen.has(sid)) return null
    seen.add(sid)
    const p = m.parsedContent || {}
    if (Number(p.aweType) === 100140 && Array.isArray(p.passive_users)) {
      for (const u of p.passive_users) if (u && u.uid) names[String(u.uid)] = String(u.nickname || '')
    }
    const at = m.createdAt instanceof Date ? m.createdAt.getTime() : Number(m.createdAt) || 0
    return {
      id: sid, uid: String(m.sender ?? ''), awe: Number(p.aweType) || 0,
      text: String(p.text || '').slice(0, 400),
      title: String(p.title || p.content || p.desc || '').slice(0, 60),
      at: at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '',
      ts: at,
      // 抖音 IM：conversationType 1 = 单聊、2 = 群聊；单聊 id 形如 0:1:uid:uid
      conv: String(m.conversationId ?? m.conversation_id ?? ''),
      ctype: Number(m.conversationType ?? m.conversation_type ?? 0) || 0,
    }
  }
  const all = []
  for (const n of document.querySelectorAll('div')) {
    const k = Object.keys(n).find((x) => x.startsWith('__reactFiber$')); if (!k) continue
    let m = null
    for (let f = n[k], j = 0; f && j < 3 && !m; f = f.return, j++) {
      const v = f.memoizedProps && f.memoizedProps.message
      if (v && typeof v === 'object' && 'isMyMessage' in v) m = v
    }
    if (!m) continue
    const rec = push(m)
    if (rec) all.push(rec)
  }
  return { messages: all, names }
})()`

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ws.addEventListener('message', (ev) => {
      let j
      try { j = JSON.parse(ev.data) } catch { return }
      if (!j.id || !this.pending.has(j.id)) return
      const p = this.pending.get(j.id)
      this.pending.delete(j.id)
      if (j.error) p.reject(new Error(j.error.message)); else p.resolve(j.result)
    })
  }
  open() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连浏览器超时')), 8000)
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve() })
      this.ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('连浏览器失败')) })
    })
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error('浏览器没响应：' + method))
      }, timeoutMs)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本出错')
    return r.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// —— 工具定义（和 src/tools/tools.js 同形：必须带 output.schema/render，否则宿主挂不上）——
function toolDef({ name, description, properties = {}, required = [], execute, render }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: render || ((_a, v) => [{ type: 'text', text: v && v.ok === false ? '✗ ' + (v.message || '没成功') : (v && v.message) || '✓' }]),
    },
    async execute(args, exec) {
      try {
        const r = await execute(args || {}, exec)
        return JSON.parse(JSON.stringify(r ?? { ok: true }))
      } catch (e) {
        return { ok: false, message: String(e && e.message ? e.message : e) }
      }
    },
  }
}

export default {
  id: 'douyin-dm',
  name: '抖音私信',
  version: '0.2.0',
  api: 1,
  description: '让大肥鱼能看抖音私信：列会话、点开某个人读最近几条；有人发来新的私信还能自己回一句',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'lines', label: '每次最多读几条', type: 'number', hint: '默认 12' },
    { key: 'ownerDouyin', label: '主人抖音 uid', type: 'text', hint: '默认留空，在面板填写' },
    { key: 'selfDouyin', label: '她自己的抖音 uid', type: 'text', hint: '默认留空，在面板填写' },
    { key: 'autoReply', label: '私信自动回话', type: 'switch', hint: '有人（默认只主人和家人）发来私信就自己回' },
    { key: 'replyTo', label: '只回这些人（uid，逗号分隔）', type: 'text', hint: '留空 = 主人 + 家人' },
    { key: 'pollSeconds', label: '多久查一次（秒）', type: 'number', hint: '默认 90' },
    { key: 'replyMaxChars', label: '回复防刷屏上限', type: 'number', hint: '默认 400；只在超长时在句号处收尾（以前 50 字硬截断会截半句）' },
    { key: 'groupNames', label: '这些会话是群（逗号分隔）', type: 'text', hint: '私信模块不碰它们，例：家人群' },
  ],

  setup(api) {

    // 公开守卫（插件 security/public-guard.js）：18+ 一律不出主人私聊 + 私聊记忆防漏，发之前先过一遍
    const __pg = (() => { try { return api.lib('security/public-guard.js') } catch { return null } })()
    const pubGuard = async (text, target, chat) => {
      if (!__pg || typeof __pg.checkPublic !== 'function') return { ok: false, reason: 'unavailable', message: '公开守卫没加载，先不发' }
      const getConfig = () => { try { return api.core.getConfig() } catch { return {} } }
      return __pg.checkPublic(String(text || ''), { target, chat: chat || 'system', getConfig, log: api.log })
    }
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    let cdp = null
    let cdpPort = 0
    let offlineUntil = 0
    let lastOfflineWarn = 0
    const OFFLINE_COOLDOWN_MS = 10 * 60_000
    const OFFLINE_WARN_MS = 30 * 60_000
    const isBrowserDown = (msg) => /DevToolsActivePort|连浏览器|没连上|ECONNREFUSED|fetch failed|打不开|超时|浏览器没响应/.test(String(msg || ''))
    function markOffline(msg) {
      offlineUntil = Date.now() + OFFLINE_COOLDOWN_MS
      try { cdp?.close() } catch {}
      cdp = null; cdpPort = 0
      if (Date.now() - lastOfflineWarn > OFFLINE_WARN_MS) {
        lastOfflineWarn = Date.now()
        api.log.warn('抖音私信：浏览器离线，' + (OFFLINE_COOLDOWN_MS / 60000) + ' 分钟内不再轮询：' + String(msg || '').slice(0, 120))
      }
    }
    function clearOffline() { offlineUntil = 0 }

    // 和内置主人私信 / douyin-group 共用「私信页锁」（见插件 src/douyin/duty.js），别人在用就这轮跳过
    const dyLock = () => (globalThis.__aurabotDyChat ||= { holder: '', until: 0 })
    const dyLockedByOther = () => { const L = dyLock(); return Boolean(L.holder) && L.holder !== 'douyin-dm' && Date.now() < L.until }
    const dyTake = () => { const L = dyLock(); L.holder = 'douyin-dm'; L.until = Date.now() + 5 * 60_000 }
    const dyDrop = () => { const L = dyLock(); if (L.holder === 'douyin-dm') { L.holder = ''; L.until = 0 } }

    function portOf() {
      let txt = null
      try { txt = fs.readFileSync(PROFILE + '/DevToolsActivePort', 'utf8') } catch {}
      if (!txt) throw new Error('还没打开过抖音浏览器（找不到 DevToolsActivePort）')
      const n = Number(String(txt).split(/\r?\n/)[0].trim())
      if (!n) throw new Error('DevToolsActivePort 里没有端口号')
      return n
    }

    async function chatTarget(port) {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
      const list = await res.json()
      return (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && /douyin\.com\/chat/.test(t.url || '')) || null
    }

    async function connect() {
      if (cdp && cdpPort) {
        const t = await chatTarget(cdpPort).catch(() => null)
        if (t) return cdp
        cdp.close(); cdp = null
      }
      cdpPort = portOf()
      let t = await chatTarget(cdpPort)
      if (!t) {
        // 浏览器现在停在推荐流上，就自己开一个私信页
        let created = null
        for (const method of ['PUT', 'POST']) {
          try {
            const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?` + encodeURIComponent('https://www.douyin.com/chat'), { method, signal: AbortSignal.timeout(8000) })
            if (res.ok) { created = await res.json(); break }
          } catch {}
        }
        if (created && created.webSocketDebuggerUrl) return await useTarget(created)
        await sleep(1500)
        t = await chatTarget(cdpPort)
        if (!t) throw new Error('抖音私信页打不开（先让她看一次抖音，把浏览器拉到 douyin.com/chat）')
      }
      return await useTarget(t)
    }

    async function useTarget(t) {
      cdp = new Cdp(t.webSocketDebuggerUrl)
      await cdp.open()
      try { await cdp.send('Page.bringToFront') } catch {}
      clearOffline()
      return cdp
    }

    function parseRows(rows) {
      const out = []
      for (const r of rows) {
        const lines = r.lines.slice()
        if (lines.length < 2) continue
        const name = lines.shift()
        let time = ''
        let unread = 0
        const rest = []
        for (const l of lines) {
          if (!time && /(刚刚|分钟前|小时前|昨天|前天|\d{1,2}:\d{2})/.test(l) && l.length <= 12) { time = l; continue }
          if (/^\d{1,3}$/.test(l)) { unread = Number(l); continue }
          rest.push(l)
        }
        if (!name) continue
        // 群标题是「甲, 乙, 丙」这种，带逗号；私聊标题就是昵称
        const members = name.split(/[，,]/).map((x) => x.trim()).filter(Boolean)
      const isGroup = members.length >= 2 || /\(\d{1,4}\)\s*$/.test(name)
        out.push({ name, time, preview: rest.join(' ').slice(0, 60), unread, isGroup, x: r.x, y: r.y })
      }
      return out
    }

    async function listConvs() {
      const c = await connect()
      const rows = (await c.eval(ROWS_JS)) || []
      return parseRows(rows)
    }

    function headerIsGroup(head) {
      const t = String(head || '')
      if (/\(\d{1,4}\)\s*$/.test(t)) return true
      return t.split(/[，,]/).filter((x) => x.trim()).length >= 2
    }

    async function readOpen() {
      const c = await connect()
      const header = String((await c.eval(HEADER_JS)) || '')
      const raw = (await c.eval(READ_JS)) || { messages: [], names: {} }
      const k = cfg()
      const names = raw.names || {}
      const who = (uid) => {
        if (uid === String(k.selfDouyin)) return '她自己'
        if (names[uid]) return names[uid]
        if (uid === String(k.ownerDouyin)) return '主人'
        return '对方'
      }
      const shown = []
      for (const m of raw.messages || []) {
        if (m.awe === 701) continue // 系统提示（互相关注之类）
        let text = m.text
        if (!text && m.title) text = '[' + m.title + ']'
        if ((m.awe === 800 || m.awe === 801 || m.awe === 502) && !text) text = '[卡片]'
        if (!text) continue
        shown.push({ id: m.id, uid: String(m.uid), who: who(m.uid), text, at: m.at, ts: Number(m.ts) || 0 })
      }
      const n = Math.max(1, Math.min(50, Number(k.lines) || 12))
      // 会话类型：消息对象带了就用（比看名字里有没有逗号可靠）
      const typed = (raw.messages || []).find((m) => m.ctype || m.conv)
      const kind = !typed ? '' : (typed.ctype === 2 || (typed.conv && !/^0:1:/.test(typed.conv) && typed.ctype !== 1)) ? 'group' : 'private'
      return { header, kind, messages: shown.slice(-n) }
    }

    async function openConv(hit) {
      const c = await connect()
      const base = { x: hit.x, y: hit.y, button: 'left', clickCount: 1 }
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
      await sleep(2400)
    }

    async function openAndRead(query) {
      const convs = await listConvs()
      if (!convs.length) return { ok: false, message: '抖音私信列表没读出来（页面可能还没加载好）' }
      const q = String(query).trim()
      const named = convs.filter((x) => x.name.includes(q))
      // 名字里含逗号的是群；优先私聊
      const hit = named.find((x) => !x.isGroup) || named[0]
      if (!hit) {
        return { ok: false, message: `抖音私信里没有名字像「${q}」的会话。现在有：${convs.map((x) => x.name).join('、')}` }
      }
      const c = await connect()
      const cur = String((await c.eval(HEADER_JS)) || '')
      const same = cur.trim().replace(/\s+/g, "") === hit.name.trim().replace(/\s+/g, "")
      if (!same) { await openConv(hit); const after = String((await c.eval(HEADER_JS)) || ""); if (!after.trim()) api.log.warn("点了会话但没读到标题") }
      const data = await readOpen()
      if (!data.messages.length) return { ok: false, message: `「${hit.name}」的私信里没读出内容` }
      const lines = data.messages.map((m) => `${m.at} ${m.who}：${m.text}`).join('\n')
      return { ok: true, message: `抖音私信 ·「${hit.name}」最近 ${data.messages.length} 条：\n${lines}` }
    }


    // ---------- 表情：抖音私信只认 unicode，发 <face:捂脸> 这种标签会变成纯文字 ----------
    const EMOJI = {
      捂脸: '🤦', 笑哭: '😂', 大笑: '😄', 微笑: '🙂', 偷笑: '🤭', 哭泣: '😭', 大笑哭: '😆',
      害羞: '😳', 亲亲: '😘', 爱心: '❤️', 比心: '🫶', 玫瑰: '🌹', 强: '👍', 弱: '👎',
      鼓掌: '👏', 握手: '🤝', 抱抱: '🤗', 加油: '💪', 赞: '👍', 疑问: '❓',
      惊讶: '😮', 思考: '🤔', 白眼: '🙄', 困: '😪', 睡: '😴', 饿: '🍚', 吃: '🍚',
      猫: '🐱', 狗: '🐶', 鱼: '🐟', 星星: '⭐', 火: '🔥', 心: '💗',
    }

    // 把模型可能吐出来的标签翻译成抖音能显示的字符
    function cleanForDouyin(raw) {
      let t = String(raw || '')
      t = t.replace(/<voice>([\s\S]*?)<\/voice>/gi, '$1')          // 语音标签 → 纯文字
      t = t.replace(/<(?:face|emoji|emotion)\s*[:：]\s*([^<>]+)>/gi, (_m, name) => EMOJI[String(name).trim()] || '')
      t = t.replace(/<sticker\s*[:：]\s*([^<>]+)>/gi, '')             // 贴纸单独走 sendSticker
      t = t.replace(/<[^<>]{1,20}>/g, '')                              // 其它尖括号标签一律清掉
      t = t.replace(/[ \t]{2,}/g, ' ')
      // —— 补：方括号标签 / 全角方括号 / DSML 工具文本，一律清掉 ——
      t = t.replace(/<[｜|]{2}DSML[｜|]{2}[\s\S]*?<\/[｜|]{2}DSML[｜|]{2}[^>]*>/g, '')
      t = t.replace(/<\/?[｜|]{2}DSML[｜|]{2}[^>]*>/g, '')
      t = t.replace(/【[^】]{0,80}】/g, '')
      t = t.replace(/\[[^\]\n]{1,12}\]/g, '')
      t = t.replace(/[ \t]{2,}/g, ' ')
      return t.trim()
    }

    function takeSticker(raw) {
      const m = String(raw || '').match(/<sticker\s*[:：]\s*([^<>]+)>/i)
      return m ? String(m[1]).trim() : ''
    }

    async function clickRect(c, expr) {
      const r = await c.eval(`(() => { const el = ${expr}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } })()`)
      if (!r) return null
      const base = { x: r.x, y: r.y, button: 'left', clickCount: 1 }
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
      return r
    }

    const STICKERS = ['在干嘛', '笑死', '开心', '比心', '嗨', '麻了', '躺平', '续火花']

    async function sendSticker(label) {
      const c = await connect()
      const opened = await clickRect(c, "document.querySelector('svg.messageMsgInputiconAction') ? document.querySelector('svg.messageMsgInputiconAction').parentElement : null")
      if (!opened) return ''
      await sleep(1200)
      const pool = [label, ...STICKERS].filter(Boolean)
      for (const name of pool) {
        const r = await c.eval(`(() => {
          for (const el of document.querySelectorAll('div,span,p')) {
            const t = (el.innerText || '').trim()
            const b = el.getBoundingClientRect()
            if (t === ${JSON.stringify(name)} && b.y > 300 && b.y < 900 && b.width < 140) return { x: b.x + b.width / 2, y: b.y - 26 }
          }
          return null
        })()`)
        if (!r) continue
        const base = { x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
        await sleep(1500)
        return name
      }
      await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      return ''
    }

    async function sendText(text) {
      text = cleanForDouyin(text)
      if (!text) throw new Error('清洗完是空的（可能整句都是表情标签）')
      // 抖音私信：18+ 只属于 QQ 主人私聊，抖音上一律不发（本地判断，不走网络）
      if (__pg && typeof __pg.checkAdultSync === 'function') { const g = __pg.checkAdultSync(text); if (g && g.ok === false) { api.log.warn('抖音私信：18+ 内容不发'); return false } }
      else if (!__pg) { api.log.warn('抖音私信：公开守卫没加载，先不发'); return false }
      const c = await connect()

      // 0) 先把输入框清干净：上一条没发出去的残稿会把新话粘成一坨
      for (let i = 0; i < 3; i++) {
        const had = String((await c.eval(BOX_JS)) || '').replace(/\u200b/g, '').trim()
        if (!had) break
        await c.eval(`(() => { const ed = document.querySelector('.editor-kit-container[contenteditable="true"]'); if (!ed) return false; ed.focus(); document.execCommand('selectAll', false, null); return true })()`)
        await sleep(150)
        await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
        await sleep(500)
      }

      const focused = await c.eval(FOCUS_JS)
      if (!focused) throw new Error('找不到输入框（私信页可能还没切过来）')
      await c.send('Input.insertText', { text })
      await sleep(500)
      const typed = String((await c.eval(BOX_JS)) || '').replace(/\u200b/g, '').trim()
      if (!typed) throw new Error('字没打进输入框')

      // 1) 首选：点发送按钮（回车在抖音网页版偶发不生效）
      const rect = await c.eval(`(() => {
        const svg = document.querySelector('svg.messageMsgInputpublishBtn') || document.querySelector('[class*="publishBtn"]')
        if (!svg) return null
        const el = svg
        const b = el.getBoundingClientRect()
        if (b.width < 6 || b.height < 6) return null
        return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
      })()`)
      if (rect) {
        const base = { x: rect.x, y: rect.y, button: 'left', clickCount: 1 }
        await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
        await sleep(2200)
        const left = String((await c.eval(BOX_JS)) || '').replace(/\u200b/g, '').trim()
        if (!left) return true
      }

      // 2) 兜底：回车
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await sleep(2200)
      const left2 = String((await c.eval(BOX_JS)) || '').replace(/\u200b/g, '').trim()
      return !left2
    }

    async function openAndSend(query, text) {
      const convs = await listConvs()
      if (!convs.length) return { ok: false, message: '抖音私信列表没读出来' }
      const q = String(query).trim()
      const named = convs.filter((x) => x.name.includes(q))
      const hit = named.find((x) => !x.isGroup) || named[0]
      if (!hit) return { ok: false, message: '抖音私信里没有「' + q + '」这个会话' }
      const c = await connect()
      const cur = String((await c.eval(HEADER_JS)) || '')
      const same = cur.trim().replace(/\s+/g, '') === hit.name.trim().replace(/\s+/g, '')
      if (!same) await openConv(hit)
      const raw = String(text)
      let sticker = takeSticker(raw)
      const plain = cleanForDouyin(raw).slice(0, 400)
      let ok = false
      if (plain) ok = await sendText(plain)
      if (sticker) {
        const used = await sendSticker(sticker)
        if (used) ok = true
      }
      if (!ok) return { ok: false, message: '字打进去了但没发出去（回车和发送按钮都没生效）' }
      return { ok: true, message: '在抖音私信里给「' + hit.name + '」回了：' + (plain || '（表情）') + (sticker ? ' + 表情包' : '') }
    }

    // —— 一个人多个平台号：抖音 uid 也要能归到同一个「人」上 ——
    function personOfUid(uid) {
      const id = String(uid || '').trim()
      if (!id) return ''
      try {
        const ext = (api.core.getConfig() || {}).ext || {}
        const it = ext.identity || {}
        const pairs = [
          [String(it.ownerQq || ''), String(it.ownerDouyin || '')],
          [String(it.momQq || ''), String(it.momDouyin || '')],
          [String(it.selfQq || ''), String(it.selfDouyin || '')],
          [String(cfg().ownerQq || ''), String(cfg().ownerDouyin || '')],
        ]
        for (const [qq, dy] of pairs) {
          if (dy && dy === id) return qq ? 'person:qq:' + qq : 'dy:' + id
        }
        for (const line of String(cfg().isolatePeople || '').split(/[,，;；\n]+/)) {
          const m = line.trim().match(/^(\d{4,20})\s*[=:：]\s*(\d{4,25})$/)
          if (m && m[2] === id) return 'person:qq:' + m[1]
        }
        // identity 的 people 对照表（主人用 /身份 加的人）也认
        const ex = typeof api.use === 'function' ? api.use('identity') : null
        if (ex && typeof ex.people === 'function') {
          const hit = ex.people().find((p) => p.dy && p.dy === id)
          if (hit) return 'person:qq:' + hit.qq
        }
      } catch {}
      return 'dy:' + id
    }

    async function rememberDm(text, uid, name) {
      const body = String(text || '').trim()
      if (body.length < 2 || body.length > 500) return
      const c = cfg()
      let tok = String(c.memoryToken || '')
      if (!tok) {
        try { tok = String(((api.core.getConfig() || {}).ext.memcore || {}).token || '') } catch {}
      }
      if (!tok) {
        api.log.warn('抖音私信：记忆写不进去（没有 memory token）')
        return
      }
      try {
        await fetch(String(c.memoryUrl || 'http://127.0.0.1:8780').replace(/\/+$/, '') + '/remember', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
          body: JSON.stringify({
            // v1 字段（保留兼容）
            text: body,
            kind: 'episode',
            importance: 0.3,
            visibility: 'private',
            owner: personOfUid(uid),
            meta: { chatId: 'dy:' + String(uid || ''), who: name, auto: 1 },
            useBio: false,
            // v2 字段（p:/g: 归一会话 + 内容/权重口径 1..5）
            content: body,
            chat_id: 'p:' + String(personOfUid(uid)).replace(/[^0-9]/g, ''),
            importance_v2: 2.2,
            persona: 'dafeiyu',
            scope: 'inherit',
            speaker: String(name || ''),
            source: 'douyin-dm',
            tags: ['douyin', 'dm'],
          }),
          signal: AbortSignal.timeout(2500),
        })
      } catch (e) {
        api.log.warn('抖音私信：记忆没写进去（' + String((e && e.message) || e).slice(0, 80) + '）')
      }
    }

    // —— 自动回私信（内置 checkOwnerDms 没在跑，这里自己轮询）——
    const STATE = api.dataDir('state.json')
    const SEED_SKIP_MS = 15 * 60_000
    function readState() {
      try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return { seen: {} } }
    }
    function writeState(s) {
      try { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2)) } catch {}
    }
    function allowedUids() {
      const k = cfg()
      const list = String(k.replyTo || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
      const all = list.length ? list : [String(k.ownerDouyin), String(k.momDouyin || '')]
      // 单线：内置 duty 开着「回主人私信」时主人那条归内置管，这里不抢（两边一起回会互相清输入框）。要抢回来设 yieldOwnerToBuiltin:false
      try {
        const g = (api.core && typeof api.core.getConfig === 'function' && api.core.getConfig()) || {}
        if (k.yieldOwnerToBuiltin !== false && g.douyin && g.douyin.enabled && g.douyin.ownerDm) return all.filter((u) => u !== String(k.ownerDouyin))
      } catch {}
      return all
    }
    let booted = false
    let busy = false

    // 群会话判定：名字在 groupNames 里 / 之前读到过是群（记在 state.groups）/ 列表启发式
    const isGroupConv = (cv, st) => cv.isGroup || (st && st.groups && st.groups[cv.name]) ||
      String(cfg().groupNames || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean).some((g) => String(cv.name || '').includes(g))
    async function tick() {
      const k = cfg()
      if (!k.enabled || !k.autoReply || busy) return
      if (Date.now() < offlineUntil) return
      if (dyLockedByOther()) return
      busy = true
      dyTake()
      try {
        const st = readState()
        st.groups = st.groups || {}
        const convs = (await listConvs()).filter((x) => !isGroupConv(x, st))
        const allow = allowedUids()
        const cands = convs.filter((c) => c.unread > 0)
        if (!cands.length && convs.length) cands.push(convs[0])
        for (const cv of cands) {
          await openConv(cv)
          const { messages, kind } = await readOpen()
          if (kind === 'group') { st.groups[cv.name] = true; writeState(st); api.log.info('抖音私信：「' + cv.name + '」其实是群，以后私信模块不碰'); continue }
          const mine = messages.filter((m) => m.who !== '她自己')
          const last = mine[mine.length - 1]
          if (!last) continue
          const key = cv.name
          const isNew = st.seen[key] !== last.id
          if (isNew && last.who !== '她自己') rememberDm(last.text, last.uid, cv.name).catch(() => {})
          if (!isNew) continue
          if (!allow.includes(String(last.uid))) { st.seen[key] = last.id; continue }
          if (!booted) {
        // 以前这里定义了函数却没调用（ageMs 是个函数，比较永远 false）→ 启动时会去回很久以前的私信
        const ageMs = (() => { const t = Number(last && last.ts) || 0; return t ? Date.now() - t : SEED_SKIP_MS + 1 })()
        if (ageMs > SEED_SKIP_MS) { st.seen[key] = last.id; continue }   // SEED_OLD_ONLY：只跳过 15 分钟以前的历史
      }
          const recent = messages.slice(-8).map((m) => __neu(String(m.who).replace(/\s+/g, ' ')) + '：' + __neu(m.text)).join('\n')
          let reply = ''
          try {
            // 每个人一条独立后台会话（api.think 整个模块共用一条，主人和家人的私信会混在一个上下文里）
            const __hub = api.core && api.core.hub
            const __name = 'ext-douyin-dm-' + String(last.uid || cv.name).replace(/[^0-9A-Za-z]/g, '').slice(-16)
            const __think = (p, o) => (__hub && typeof __hub.runSystemTurn === 'function')
              ? __hub.runSystemTurn(__name, '抖音私信 ' + cv.name, p, o).catch((e) => {
                  if (!/context|token|上下文|413/i.test(String(e && e.message))) throw e
                  try { __hub.resetChat?.('system:' + __name) } catch {}
                  return __hub.runSystemTurn(__name, '抖音私信 ' + cv.name, p, o)
                })
              : api.think(p, o)
            reply = String(await __think(
              '【抖音私信】对方「' + __neu(String(cv.name).replace(/\s+/g, ' ')) + '」刚发来消息。最近几条：\n' + recent +
              '\n\n用她自己的口吻回，口语、别用 markdown，像平时聊天一样，一般一两句、需要就多说。只输出要发的话。',
              { title: '抖音私信', timeoutMs: 90000 },
            ) || '')
          } catch (e) {
            api.log.warn('抖音私信：想不出来（' + e.message + '）')
            continue
          }
          let sticker = takeSticker(reply)
          reply = cleanForDouyin(reply.replace(/^["'「]|["'」]$/g, '')).replace(/\s+/g, ' ').trim()
          { const cap = Math.max(100, Number(k.replyMaxChars) || 400); if (reply.length > cap) { const cut = reply.slice(0, cap); const i = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('～')); reply = i > cap * 0.5 ? cut.slice(0, i + 1) : cut } }
          const stickerChance = Number(k.stickerChance ?? 0.3)
          if (!sticker && reply && stickerChance > 0 && Math.random() < stickerChance) {
            sticker = STICKERS[Math.floor(Math.random() * STICKERS.length)]
          }
          let ok = false
          if (reply) ok = await sendText(reply)
          if (sticker || (!reply && sticker === '')) {
            const used = await sendSticker(sticker)
            if (used) { ok = true; api.log.info('抖音私信：顺手发了个表情包「' + used + '」') }
          }
          if (!reply && !sticker) continue
          st.seen[key] = last.id
          st.lastAt = Date.now()
          writeState(st)
          api.log.info('抖音私信：给「' + cv.name + '」回了 ' + (ok ? '✓ ' : '✗ ') + reply)
          await sleep(4000)
        }
        if (!booted) { booted = true; writeState(st) }
      } catch (e) {
        if (isBrowserDown(e.message)) markOffline(e.message)
        else api.log.warn('抖音私信轮询失败：' + e.message)
      } finally {
        busy = false
        dyDrop()
      }
    }

    api.every(Math.max(45, Number(cfg().pollSeconds) || 90) * 1000, tick, 'douyin-dm-tick')
    api.later(20_000, () => { tick().catch(() => {}) })

    api.tool(() => {
      if (!cfg().enabled) return null
      return toolDef({
        name: 'douyin_dm_sticker',
        description: '在抖音私信里发一个表情包（贴纸），比如 在干嘛、笑死、开心、比心、嗨、麻了、躺平。',
        properties: { name: { type: 'string', description: '表情包名字' } },
        required: [],
        async execute({ name } = {}) {
          try {
            const used = await sendSticker(name || STICKERS[0])
            return used ? { ok: true, message: '发了个表情包「' + used + '」' } : { ok: false, message: '没找到这个表情包（面板可能没打开）' }
          } catch (e) { return { ok: false, message: '发贴纸失败：' + e.message } }
        },
      })
    })

    api.tool(({ chat }) => {
      if (!cfg().enabled) return null
      return toolDef({
        name: 'douyin_dm_recent',
        description: '看抖音私信（抖音 app 里「消息-私信」那些）。不带 from 就列出所有私信会话；带 from（对方昵称的一部分，例如「不知道起什么名字」）就点开那个人读最近几条。只读，不发消息。',
        properties: {
          from: { type: 'string', description: '对方昵称的一部分；留空 = 只看会话列表' },
        },
        required: [],
        async execute({ from } = {}) {
          try {
            if (from) return await openAndRead(from)
            const convs = (await listConvs()).filter((x) => !isGroupConv(x, readState()))
            if (!convs.length) return { ok: false, message: '抖音私信列表里没读到私聊会话' }
            const lines = convs
              .map((x) => `· ${x.name}${x.unread ? `（${x.unread} 条未读）` : ''}：${x.preview || '…'}${x.time ? `　${x.time}` : ''}`)
              .join('\n')
            return { ok: true, message: `抖音私信会话（${convs.length} 个）：\n${lines}\n（想看谁说了什么，把名字告诉我）` }
          } catch (e) {
            return { ok: false, message: '读抖音私信没成：' + e.message }
          }
        },
      })
    })

    api.tool(({ chat }) => {
      if (!cfg().enabled) return null
      if (!chat || chat.kind === 'system') return null
      return toolDef({
        name: 'douyin_dm_reply',
        description: '在抖音私信里回一句话给某个人（主人明确让你去抖音私信回的时候才用）。只回指定的人，别主动给陌生人发。',
        properties: {
          to: { type: 'string', description: '对方昵称的一部分，例如「不知道起什么名字」' },
          text: { type: 'string', description: '要说的话，一两句' },
        },
        required: ['to', 'text'],
        async execute({ to, text }) {
          try {
            return await openAndSend(String(to || ''), String(text || ''))
          } catch (e) {
            return { ok: false, message: '没发出去：' + e.message }
          }
        },
      })
    })

    api.rule((kind) => (kind === 'private' || kind === 'social'
      ? '你能看抖音私信：想知道内容就调用 douyin_dm_recent（不带参数列会话，带 from 读具体那个人）；主人让你回某个人，就用 douyin_dm_reply。不要说「我看不见私信」或「我回不了」。'
      : ''))

    api.command({
      name: '私信',
      aliases: ['抖音私信', 'dm'],
      desc: '看抖音私信列表；/私信 昵称 读某个人的最近几条',
      async run(arg) {
        try {
          if (arg && arg.trim()) return (await openAndRead(arg.trim())).message
          const convs = (await listConvs()).filter((x) => !isGroupConv(x, readState()))
          if (!convs.length) return '抖音私信列表里没读到私聊会话'
          return '抖音私信：\n' + convs.map((x) => `· ${x.name}${x.unread ? `（${x.unread}）` : ''}：${x.preview || '…'}`).join('\n')
        } catch (e) {
          return '读抖音私信没成：' + e.message
        }
      },
    })

    api.later(3000, async () => {
      try {
        const convs = await listConvs()
        api.log.info(`抖音私信模块已加载：读到 ${convs.length} 个会话（私聊 ${convs.filter((x) => !x.isGroup).length} 个）`)
      } catch (e) {
        markOffline(e.message)
        api.log.info('抖音私信模块已加载（浏览器暂未就绪，稍后冷却重试）')
      }
    })
  },
}
