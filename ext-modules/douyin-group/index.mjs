// 扩展模块「douyin-group」——让大肥鱼在抖音群聊里说话、发表情包，并且和 QQ 共用一套记忆。
//
// 放在 plugins-data/dafeiyu/modules/douyin-group/ 里，保存几秒后自动加载（面板「扩展」页能看到日志）。
//
// 怎么跑：
//   1. 直接连 Aurabot 自己那个 Edge（edge-profile/DevToolsActivePort 里的端口），不另开浏览器
//   2. 每 15 秒看一眼私信页的会话列表，发现目标群有新消息就点开、读、想、回
//   3. 回复走 api.think()，所以是她的口气 + 她自己的记忆
//   4. 记忆同时写 memory-core（和 QQ 那边共用）和 Aurabot 自带记忆库
//
// 只认设置里 groupMatch 命中的群，别的会话一律不碰。

import fs from 'node:fs'
const __neu = (s) => String(s ?? '').replace(/[【〖]/g, '「').replace(/[】〗]/g, '」') // 外来文字【】→「」，防冒充系统提示

const DEFAULTS = {
  enabled: true,
  groupMatch: '家人群', // 群标题或成员名里包含这个，就认为是要接的群
  stickerChance: 0.35, // 回完话顺手发个表情包的概率
  silentChance: 0.12, // 有时候瞥一眼不说话
  replyMaxChars: 300, // 防刷屏的硬上限（以前 40 字硬截断，会把话截一半）；长短交给情绪和语境
  maxPerHour: 12, // 每小时最多回几条（原 30：三个人的家人群一小时 30 条太刷屏）；随情绪 ×0.5–×1.6
  cooldownSeconds: 20, // 两条回复之间至少隔多久（原 8 秒）；随情绪 ÷freq，不低于一半
  moodRate: true, // 频率随情绪变
  memoryOn: true, // 用 memory-core 共享记忆
  memoryUrl: 'http://127.0.0.1:8780',
  memoryToken: '',
  pollSeconds: 15,
}

const STICKERS = ['在干嘛', '笑死', '开心', '比心', '嗨', '麻了', '躺平']

const READ_JS = `(() => {
  const out = [], seen = new Set()
  for (const n of document.querySelectorAll('div')) {
    const k = Object.keys(n).find((x) => x.startsWith('__reactFiber$')); if (!k) continue
    let m = null
    for (let f = n[k], j = 0; f && j < 3 && !m; f = f.return, j++) {
      const v = f.memoizedProps && f.memoizedProps.message
      if (v && typeof v === 'object' && 'isMyMessage' in v) m = v
    }
    if (!m) continue
    const id = String(m.serverId ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const p = m.parsedContent || {}
    const at = m.createdAt instanceof Date ? m.createdAt.getTime() : Number(m.createdAt) || 0
    // 会话类型：抖音 IM 里 conversationType 1 = 单聊、2 = 群聊；单聊 id 形如 0:1:uid:uid，群聊是纯数字
    const conv = String(m.conversationId ?? m.conversation_id ?? '')
    const ctype = Number(m.conversationType ?? m.conversation_type ?? 0) || 0
    out.push({ id, uid: String(m.sender ?? ''), aweType: Number(p.aweType) || 0, text: String(p.text || '').slice(0, 1000), at, conv, ctype })
  }
  return out.sort((a, c) => a.at - c.at)
})()`

const HEADER_JS = `(() => {
  const out = []
  for (const el of document.querySelectorAll('div,span')) {
    const r = el.getBoundingClientRect()
    if (r.x > 320 && r.y < 95 && r.width > 120 && r.height >= 10 && r.height <= 70) {
      const t = (el.innerText || '').trim()
      if (t && t.length < 200) out.push(t)
    }
  }
  return out.join(' ')
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
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 15000)
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
  id: 'douyin-group',
  name: '抖音群聊',
  version: '0.1.0',
  api: 1,
  description: '在抖音群里聊天、发表情包，记忆和 QQ 共用一套（走 memory-core）',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'groupMatch', label: '群名关键词', type: 'text', hint: '群标题或成员名里包含这个词就接这个群，比如 家人群' },
    { key: 'stickerChance', label: '发表情包的概率', type: 'number', hint: '0~1，默认 0.35' },
    { key: 'silentChance', label: '不回的概率', type: 'number', hint: '0~1，默认 0.12' },
    { key: 'replyMaxChars', label: '一句话最多几个字', type: 'number', hint: '防刷屏硬上限，默认 300（不再按字数硬截）' },
    { key: 'maxPerHour', label: '每小时最多回几条', type: 'number', hint: '默认 12（随情绪 ×0.5–×1.6）' },
    { key: 'moodRate', label: '频率随情绪变', type: 'boolean', hint: '开：冷却和每小时上限随她心情伸缩' },
    { key: 'cooldownSeconds', label: '两条之间隔几秒', type: 'number', hint: '默认 8' },
    { key: 'memoryOn', label: '和 QQ 共用记忆', type: 'switch' },
    { key: 'memoryUrl', label: 'memory-core 地址', type: 'text' },
    { key: 'memoryToken', label: 'memory-core token', type: 'text' },
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
    const store = (() => { try { return api.lib('core/store.js') || {} } catch { return {} } })()
    const memoryApi = (() => { try { return api.use('memory') } catch { return null } })()

    const statePath = () => api.dataDir('state.json')
    const load = () => {
      try { return store.readJson?.(statePath(), {}) || {} } catch { return {} }
    }
    const save = (s) => { try { store.writeJson?.(statePath(), s) } catch (e) { api.log.warn('抖音群聊：存状态失败 ' + e.message) } }

    let busy = false
    let lastReplyAt = 0
    // 找不到群时指数退避（15s→30s→…→15 分钟），30 分钟只提醒一次；以前每 15 秒刷一条，一天上千条
    let missStreak = 0, missUntil = 0, missWarnAt = 0
    const moodFreq = () => { const s = globalThis.__dfyStyle; return s && s.on && Date.now() - s.at < 600000 ? Math.max(0.3, Math.min(2, Number(s.freq) || 1)) : 1 }
    let cdp = null
    let cdpPort = 0

    // —— 离线冷却（同 douyin-dm）：浏览器没开 / 挂了时 10 分钟内不再每 15 秒刷一遍「fetch failed」，30 分钟只提醒一次 ——
    let offlineUntil = 0
    let lastOfflineWarn = 0
    const OFFLINE_COOLDOWN_MS = 10 * 60_000
    const OFFLINE_WARN_MS = 30 * 60_000
    const isBrowserDown = (msg) => /DevToolsActivePort|连浏览器|没连上|ECONNREFUSED|ECONNRESET|fetch failed|打不开|还没打开|私信页|超时|timeout|没响应|socket hang up|WebSocket/i.test(String(msg || ''))
    function markOffline(msg) {
      offlineUntil = Date.now() + OFFLINE_COOLDOWN_MS
      if (Date.now() - lastOfflineWarn > OFFLINE_WARN_MS) {
        lastOfflineWarn = Date.now()
        api.log.warn('抖音群聊：抖音浏览器不在线（' + String(msg || '').slice(0, 80) + '），10 分钟后再试，期间不再刷屏')
      }
    }
    function clearOffline() {
      if (offlineUntil) api.log.info('抖音群聊：浏览器回来了，继续看群')
      offlineUntil = 0
    }
    // 和内置主人私信 / douyin-dm 共用「私信页锁」（见插件 src/douyin/duty.js）
    const dyLock = () => (globalThis.__aurabotDyChat ||= { holder: '', until: 0 })
    const dyLockedByOther = () => { const L = dyLock(); return Boolean(L.holder) && L.holder !== 'douyin-group' && Date.now() < L.until }
    const dyTake = () => { const L = dyLock(); L.holder = 'douyin-group'; L.until = Date.now() + 5 * 60_000 }
    const dyDrop = () => { const L = dyLock(); if (L.holder === 'douyin-group') { L.holder = ''; L.until = 0 } }

    // ---------- memory-core（和 QQ 共用） ----------
    const unwrap = (j) => (j && typeof j === 'object' && 'data' in j ? j.data : j)
    async function memPost(path, body) {
      const c = cfg()
      if (!c.memoryOn) return null
      try {
        const res = await fetch(String(c.memoryUrl).replace(/\/+$/, '') + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.memoryToken },
          body: JSON.stringify(body || {}),
          signal: AbortSignal.timeout(6000),
        })
        const j = await res.json().catch(() => ({}))
        if (!res.ok || j.status === 'error') throw new Error(j.message || 'HTTP ' + res.status)
        return unwrap(j)
      } catch (e) {
        api.log.warn('抖音群聊：memory-core 没连上（' + e.message + '）')
        return null
      }
    }
    // 家人群的记忆只在这个群里看得到：v2 按 chat 分隔（g:douyin_family，scope private），不再落 legacy:unknown
    const FAMILY_CHAT = 'g:douyin_family'
    const memRecall = async (q, k = 5) => (await memPost('/recall', { query: String(q).slice(0, 400), k, chat_id: FAMILY_CHAT, platform: 'douyin', visibility: ['public', 'private', 'group'] })) || { hits: [], block: '' }
    const memRemember = async (text, importance = 0.5) => memPost('/remember', {
      text: String(text).slice(0, 1500), kind: 'episode', importance, chat_id: FAMILY_CHAT, chat_type: 'group', platform: 'douyin', scope: 'private', tags: ['抖音群'], source: 'douyin', meta: { from: 'douyin-group' },
    })

    // ---------- 浏览器 ----------
    function portOf() {
      const p = (process.env.DOUYIN_PROFILE_DIR || 'douyin/edge-profile') + '/DevToolsActivePort'
      const txt = nodeReadFile(p)
      if (!txt) throw new Error('还没打开过抖音浏览器（找不到 DevToolsActivePort）')
      const n = Number(String(txt).split('\n')[0].trim())
      if (!n) throw new Error('DevToolsActivePort 里没有端口号')
      return n
    }
    function nodeReadFile(p) {
      try { return fs.readFileSync(p, 'utf8') } catch { return null }
    }
    async function chatTarget(port) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json()
      return (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && /douyin\.com\/chat/.test(t.url || '')) || null
    }
    async function connect() {
      if (cdp && cdpPort) {
        const t = await chatTarget(cdpPort).catch(() => null)
        if (t) return { cdp, target: t }
        cdp.close(); cdp = null
      }
      cdpPort = portOf()
      let t = await chatTarget(cdpPort)
      if (!t) {
        // 私信页没开就自己开一个（不再依赖人工先点开）
        try {
          await fetch(`http://127.0.0.1:${cdpPort}/json/new?https://www.douyin.com/chat`, { method: 'PUT', signal: AbortSignal.timeout(8000) })
        } catch (e) { api.log.warn('打开抖音私信页失败：' + e.message) }
        for (let i = 0; i < 10 && !t; i++) {
          await new Promise((r) => setTimeout(r, 800))
          t = await chatTarget(cdpPort).catch(() => null)
        }
        if (t) api.log.info('抖音私信页已自动打开')
      }
      if (!t) throw new Error('抖音私信页打不开（浏览器可能已退出）')
      cdp = new Cdp(t.webSocketDebuggerUrl)
      await cdp.open()
      return { cdp, target: t }
    }
    async function withPage(fn) {
      const { cdp: c } = await connect()
      return fn(c)
    }
    async function clickRect(c, js) {
      const r = await c.eval(`(() => { const el = ${js}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`)
      if (!r) return false
      const base = { x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base })
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base })
      return true
    }

    const headerOpen = async (c, match) => String(await c.eval(HEADER_JS) || '').includes(match)

    // 打开 groupMatch 那个群：先看标题；列表里看不到就把会话列表往下滚几屏再找（以前只看第一屏 → 群被新私聊挤下去后每 15 秒报一次「会话没找到」）
    async function openGroup(c, match) {
      if (!match) return false
      if (await headerOpen(c, match)) return true
      const ROW = `[...document.querySelectorAll('div')].filter((el) => {
        const t = (el.innerText || '').replace(/\\s+/g, ' ');
        const r = el.getBoundingClientRect();
        return r.x < 330 && r.width > 180 && r.height >= 45 && r.height <= 110 && r.y > 0 && r.y < innerHeight && t.includes(${JSON.stringify(match)})
      }).sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width)[0]`
      let clicked = await clickRect(c, ROW)
      for (let i = 0; !clicked && i < 6; i++) {
        await c.eval(`(() => { const box = [...document.querySelectorAll('div')].find((el) => { const r = el.getBoundingClientRect(); return r.x < 60 && r.width > 200 && r.width < 420 && r.height > 300 && el.scrollHeight > el.clientHeight + 20 }); if (!box) return 0; box.scrollTop += box.clientHeight * 0.8; return 1 })()`)
        await sleep(700)
        clicked = await clickRect(c, ROW)
      }
      if (!clicked) {
        await c.eval(`(() => { for (const el of document.querySelectorAll('div')) { const r = el.getBoundingClientRect(); if (r.x < 60 && r.width > 200 && r.width < 420 && el.scrollHeight > el.clientHeight + 20) el.scrollTop = 0 } return 1 })()`).catch(() => 0)
        return false
      }
      for (let i = 0; i < 8; i++) {
        await sleep(600)
        if (await headerOpen(c, match)) return true
      }
      return false
    }

    const EMOJI = { 捂脸:'🤦', 笑哭:'😂', 大笑:'😄', 微笑:'🙂', 偷笑:'🤭', 哭泣:'😭', 害羞:'😳', 亲亲:'😘', 爱心:'❤️', 比心:'🫶', 玫瑰:'🌹', 强:'👍', 鼓掌:'👏', 抱抱:'🤗', 加油:'💪', 疑问:'❓', 惊讶:'😮', 思考:'🤔', 白眼:'🙄', 困:'😪', 饿:'🍚', 吃:'🍚', 星星:'⭐', 火:'🔥' }
    function cleanForDouyin(raw) {
      let t = String(raw || '')
      t = t.replace(/<voice>([\s\S]*?)<\/voice>/gi, '$1')
      t = t.replace(/<(?:face|emoji|emotion)\s*[:：]\s*([^<>]+)>/gi, (_m, n) => EMOJI[String(n).trim()] || '')
      t = t.replace(/<sticker\s*[:：]\s*([^<>]+)>/gi, '')
      t = t.replace(/<[^<>]{1,20}>/g, '')
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

    async function sendText(c, text) {
      text = cleanForDouyin(text)
      if (!text) return false
      // 抖音群：18+ 硬拦；家里群也查一下有没有把某个人私聊里的事说出来
      { const g = await pubGuard(text, 'douyin-group', FAMILY_CHAT); if (!g.ok) { api.log.warn('抖音群：公开守卫拦下一句（' + (g.reason || '?') + '）'); return false } }
      // 先确保打开的是那个群（会话行里含 groupMatch 的那条）
      try { if (!(await openGroup(c, String(cfg().groupMatch || '').trim()))) throw new Error('没切到群「' + cfg().groupMatch + '」，不发（免得发进私聊）') } catch (e) { api.log.warn('切到群失败：' + e.message); return false }
      const focused = await c.eval(FOCUS_JS)
      if (!focused) throw new Error('找不到私信输入框')
      // 用鼠标真点一下输入框再打字，比只 focus() 稳
      try { await clickRect(c, `document.querySelector('.editor-kit-container[contenteditable="true"]')`) } catch (e) {}
      await sleep(300)
      // 清掉残留草稿（不清的话旧字会和新字拼在一起，回车也不会发）
      try {
        await c.eval(`(() => { const el = document.querySelector('.editor-kit-container[contenteditable="true"]'); if (!el) return 0; el.focus(); const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); document.execCommand('delete'); return 1 })()`)
        await sleep(300)
      } catch (e) {}
      await c.send('Input.insertText', { text })
      await sleep(450)
      const box = String(await c.eval(BOX_JS) || '')
      if (!box.replace(/\u200b/g, '').trim()) throw new Error('字没打进输入框')
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await sleep(2200)
      const left = String(await c.eval(BOX_JS) || '').replace(/\u200b/g, '').trim()
      if (!left) return true
      // 回车没触发发送：点一次发送按钮（盒子还完整留着才点，避免重复）
      if (left) {
        const ok = await clickRect(c, `document.querySelector('svg.messageMsgInputpublishBtn') || document.querySelector('[class*="publishBtn"]')`)
        if (ok) {
          await sleep(2000)
          const still = String(await c.eval(BOX_JS) || '').replace(/\u200b/g, '').trim()
          if (!still) return true
          // 再试一次回车
          await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
          await sleep(1800)
          return !String(await c.eval(BOX_JS) || '').replace(/\u200b/g, '').trim()
        }
      }
      return false
    }

    async function sendSticker(c, label) {
      const opened = await clickRect(c, `document.querySelector('svg.messageMsgInputiconAction') ? document.querySelector('svg.messageMsgInputiconAction').parentElement : null`)
      if (!opened) return false
      await sleep(1200)
      const pool = [label, ...STICKERS].filter(Boolean)
      for (const name of pool) {
        const r = await c.eval(`(() => {
          for (const el of document.querySelectorAll('div,span,p')) {
            const t = (el.innerText || '').trim()
            const b = el.getBoundingClientRect()
            if (t === ${JSON.stringify(name)} && b.y > 350 && b.y < 900 && b.width < 140) return { x: b.x + b.width / 2, y: b.y - 26 }
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
      return false
    }

    // ---------- 一条消息里的「新消息」 ----------
    function pickFresh(msgs, state) {
      const selfUid = String(state.selfUid || '')
      const seen = new Set(state.seen || [])
      const since = Number(state.lastAt || 0)
      const fresh = []
      for (const m of msgs) {
        if (!m.id || seen.has(m.id)) continue
        if (m.aweType === 700 || m.aweType === 507) { seen.add(m.id); continue } // 自己发的
        if (selfUid && m.uid === selfUid) { seen.add(m.id); continue }
        if (m.aweType === 100140 || m.aweType === 501) { seen.add(m.id); continue } // 群系统消息
        if (m.at && m.at <= since) { seen.add(m.id); continue } // 老消息
        if (!m.text || !m.text.trim()) { seen.add(m.id); continue }
        fresh.push(m)
      }
      return { fresh, seen: [...seen] }
    }

    function whoOf(uid) {
      const s = load()
      const names = s.names || {}
      return names[String(uid)] || ('群友' + String(uid).slice(-4))
    }

    async function tick() {
      const c0 = cfg()
      if (!c0.enabled || busy) return
      if (Date.now() < offlineUntil) return
      if (dyLockedByOther()) return
      if (Date.now() < missUntil) return
      const f0 = c0.moodRate === false ? 1 : moodFreq()
      if (Date.now() - lastReplyAt < Math.max(Number(c0.cooldownSeconds) * 500, Number(c0.cooldownSeconds) * 1000 / f0)) return
      busy = true
      dyTake()
      try {
        await withPage(async (c) => {
          clearOffline()
          const match = String(c0.groupMatch || '').trim()
          if (!match) return
          const opened = await openGroup(c, match)
          if (!opened) {
            missStreak += 1
            missUntil = Date.now() + Math.min(15 * 60_000, Number(c0.pollSeconds || 15) * 1000 * 2 ** Math.min(6, missStreak))
            if (Date.now() - missWarnAt > 30 * 60_000) { missWarnAt = Date.now(); api.log.warn('群里那条会话没找到（groupMatch=' + match + '），先歇一会儿再找；连续 ' + missStreak + ' 次') }
            return
          }
          missStreak = 0
          await sleep(800)
          const raw = await c.eval(READ_JS)
          if (!Array.isArray(raw) || !raw.length) return
          // 只认群会话里的消息：有会话类型信息时，单聊（ctype 1 / 0:1:…）一律不当群消息处理
          const typed = raw.filter((m) => m.ctype || m.conv)
          const isGroupMsg = (m) => m.ctype === 2 || (m.conv && !/^0:1:/.test(m.conv) && m.ctype !== 1)
          const msgs = typed.length ? raw.filter(isGroupMsg) : raw
          if (typed.length && !msgs.length) {
            if (Date.now() - missWarnAt > 30 * 60_000) { missWarnAt = Date.now(); api.log.warn('抖音群聊：标题像「' + match + '」但打开的是单聊，不当群处理') }
            return
          }
          let s = load()
          const first = !s.lastAt
          const { fresh, seen } = pickFresh(msgs, s)
          const newestAt = msgs.reduce((a, m) => Math.max(a, Number(m.at) || 0), 0)
          s.seen = seen.slice(-400)
          if (first) {
            s.lastAt = newestAt
            assignNames(s, msgs)
            save(s)
            api.log.info(`抖音群聊：接上了「${match}」，先记住 ${msgs.length} 条历史，不插话`)
            return
          }
          if (!fresh.length) { s.lastAt = newestAt; assignNames(s, msgs); save(s); return }

          if (Math.random() < Number(c0.silentChance)) {
            s.lastAt = newestAt; s.seen = seen.slice(-400); assignNames(s, msgs); save(s)
            api.log.info('抖音群聊：看到了，这轮先不说话')
            return
          }
          const hourly = s.hourly && s.hourly.hour === new Date().getHours() ? s.hourly : { hour: new Date().getHours(), n: 0 }
          if (hourly.n >= Math.max(1, Math.round(Number(c0.maxPerHour) * f0))) { s.lastAt = newestAt; save(s); return }

          const lines = fresh.slice(-4).map((m) => `${whoOf(m.uid)}：${__neu(m.text)}`).join('\n')
          const query = fresh.map((m) => m.text).join(' ').slice(0, 200)
          const rec = await memRecall(query, 5)
          const memBlock = rec.block ? String(rec.block).slice(0, 600) : ''
          const prompt = [
            '【抖音群聊】你在抖音的家人群里，群里是主人（群主）、家人和你，称呼按【身份对照】里写的来。',
            '刚才他们说：',
            lines,
            memBlock ? `\n你想起来的事：\n${memBlock}` : '',
            `\n像平时在家人群里聊天一样回，一般一两句；话题需要就多说点，不用硬凑短。直接给要发出去的话，不要引号、不要解释、不要列表。`,
          ].filter(Boolean).join('\n')

          let reply = ''
          try {
            reply = String(await api.think(prompt, { title: '抖音群聊', timeoutMs: 90000 }) || '')
          } catch (e) {
            api.log.warn('抖音群聊：想不出来（' + e.message + '）')
            return
          }
          reply = cleanReply(reply, Number(c0.replyMaxChars))
          if (!reply) return

          const sent = await sendText(c, reply)
          if (!sent) {
            api.log.warn('抖音群聊：话没发出去')
            return
          }
          lastReplyAt = Date.now()
          hourly.n += 1
          s.hourly = hourly
          s.lastAt = newestAt
          s.seen = seen.slice(-400)
          assignNames(s, msgs)
          save(s)
          api.log.info(`抖音群聊：回了「${reply}」`)

          if (Math.random() < Number(c0.stickerChance)) {
            const used = await sendSticker(c, STICKERS[Math.floor(Math.random() * STICKERS.length)])
            if (used) api.log.info(`抖音群聊：发了个表情包「${used}」`)
          }

          if (c0.memoryOn) {
            const text = `抖音家人群里，${fresh.slice(-2).map((m) => `${whoOf(m.uid)}说「${m.text}」`).join('；')}，大肥鱼回了「${reply}」`
            await memRemember(text, 0.45) // 只写 v2（单线），不再同时塞内置记忆 → 免得 memcore 再镜像一份到主人私聊
          }
        })
      } catch (e) {
        if (isBrowserDown(e.message)) markOffline(e.message)
        else api.log.warn('抖音群聊这轮没跑成：' + e.message)
      } finally {
        busy = false
        dyDrop()
      }
    }

    function assignNames(s, msgs) {
      s.names = s.names || {}
      for (const m of msgs) {
        if (!m.uid) continue
        if (m.aweType === 700 || m.aweType === 507) s.selfUid = m.uid
      }
    }

    function cleanReply(text, max) {
      let t = String(text || '').trim()
      t = t.replace(/^["'「『（(]+|["'」』）)]+$/g, '').trim()
      t = t.replace(/^(回复|大肥鱼|我说)[:：]\s*/, '').trim()
      // 不再只留第一行、也不按 40 字硬截断（会把话截一半）；只在超长（防刷屏）时在句号处收尾
      t = t.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 4).join(' ')
      const cap = Math.max(Number(max) || 0, 300)
      if (t.length > cap) { const cut = t.slice(0, cap); const k = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('～')); t = k > cap * 0.5 ? cut.slice(0, k + 1) : cut }
      return t
    }

    // ---------- 命令 / 工具 ----------
    // 主人明确让「去群里说话」时，必须真的发一条；群安静时可以主动起话头
    api.rule((kind) => (kind === 'private'
      ? '主人在私聊里说「去抖音群里说话 / 去找家人聊 / 去群里玩 / 在群里说句话」时，你必须真的调用 douyin_group_say 发一条过去（只发内容本身，不要提工具名、不要说「我这就去」然后就没了）。群里安静、没有新消息时也可以主动起个话头。'
      : '在抖音那个家人群里，你可以自己挑话头（聊吃的、聊今天干嘛了），一次只说一两句，别刷屏。'))

    api.command({
      name: '抖音群聊',
      aliases: ['dy群', '群聊'],
      desc: '抖音群聊：status / on / off / say 一句话 / 表情 名字',
      async run(arg) {
        const [a, ...rest] = String(arg || '').trim().split(/\s+/)
        const c = cfg()
        if (!a || a === 'status') {
          const s = load()
          return `抖音群聊：${c.enabled ? '开着' : '关着'}｜群关键词 ${c.groupMatch}｜已记 ${(s.seen || []).length} 条｜自己 uid ${s.selfUid || '未知'}｜上一轮 ${s.lastAt ? new Date(s.lastAt).toLocaleTimeString('zh-CN') : '还没跑'}`
        }
        if (a === 'on' || a === 'off') {
          api.saveSettings?.({ enabled: a === 'on' })
          return `抖音群聊已${a === 'on' ? '打开' : '关闭'}`
        }
        if (a === 'say' && rest.length) {
          const ok = await withPage((cc) => sendText(cc, rest.join(' ')))
          return ok ? '发出去了' : '没发出去'
        }
        if (a === '表情' && rest.length) {
          const used = await withPage((cc) => sendSticker(cc, rest[0]))
          return used ? `发了表情包「${used}」` : '没找到这个表情包'
        }
        return '用法：/抖音群聊 status｜on｜off｜say 你好｜表情 在干嘛'
      },
    })

    api.tool(() => toolDef({
      name: 'douyin_group_say',
      description: '在抖音的那个家人群里说一句话（主人明确让你去抖音群里说话时才用）',
      properties: { text: { type: 'string', description: '要说的话，一两句' } },
      required: ['text'],
      async execute({ text }) {
        const t = String(text || '').trim()
        if (!t) return '要说什么？'
        const ok = await withPage((cc) => sendText(cc, t.slice(0, 200)))
        return ok ? '在抖音群里说了' : '没发出去'
      },
    }))

    api.tool(() => toolDef({
      name: 'douyin_group_sticker',
      description: '在抖音的家人群里发一个表情包（贴纸）',
      properties: { name: { type: 'string', description: '表情包名字，比如 在干嘛、笑死、开心' } },
      required: [],
      async execute({ name }) {
        const used = await withPage((cc) => sendSticker(cc, name || STICKERS[0]))
        return used ? `发了「${used}」` : '没找到这个表情包'
      },
    }))

    api.every(Number(DEFAULTS.pollSeconds) * 1000, tick, 'douyin-group-tick')
    api.later(6000, () => { api.log.info('抖音群聊已加载（每 ' + DEFAULTS.pollSeconds + ' 秒看一次私信页）') })
    api.onDispose?.(() => { try { cdp?.close() } catch {} })

    return { tick }
  },
}
