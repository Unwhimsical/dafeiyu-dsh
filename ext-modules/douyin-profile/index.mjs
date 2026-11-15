// 扩展模块「douyin-profile」——让大肥鱼自己经营抖音主页：头像 / 昵称 / 签名 / 背景图。
//
// 做法：用她自己的登录态浏览器（CDP 直连），进 douyin.com/user/self，点「编辑资料」，
// 填/传，再点「保存」。素材从 modules-data/douyin-profile/assets/ 里自己挑。
//
// 注意
//   - 需要登录态。没登录时所有工具都返回 ok:false + 「需要重新扫码登录」，不会瞎点。
//   - 上传图片必须用 CDP 的 DOM.setFileInputFiles（浏览器原生选择框点不动）。
//   - 保存后回读主页确认，再告诉主人改没改成功。

import fs from 'node:fs'
import path from 'node:path'

const PROFILE = process.env.DOUYIN_PROFILE_DIR || 'douyin/edge-profile'
const SELF_URL = 'https://www.douyin.com/user/self'

const DEFAULTS = {
  enabled: true,
  maxChangePerDay: 2,   // 一天最多改几次（防止自己反复折腾）
}

// 登录态探测：/user/profile/self 返回 status_code 8 = 用户未登录
const LOGIN_JS = `(async () => {
  try {
    const r = await fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383', { credentials: 'include' })
    const j = await r.json()
    return { ok: Number(j.status_code) === 0, code: j.status_code, msg: j.status_msg || '' }
  } catch (e) { return { ok: false, code: -1, msg: String(e) } }
})()`

// 主页上的昵称 / 简介 / 头像
const STATE_JS = `(() => {
  const txt = (e) => (e && (e.innerText || e.textContent) || '').trim()
  const out = { nickname: '', signature: '', avatar: '' }
  const h1 = document.querySelector('h1')
  if (h1) out.nickname = txt(h1).slice(0, 40)
  if (!out.nickname) {
    for (const el of document.querySelectorAll('div,span')) {
      const r = el.getBoundingClientRect()
      if (r.y > 60 && r.y < 200 && r.x > 300 && r.x < 900 && r.height > 20 && r.height < 60) {
        const t = txt(el)
        if (t && t.length < 24 && !/粉丝|关注|获赞|作品|私密/.test(t)) { out.nickname = t; break }
      }
    }
  }
  const desc = document.querySelector('[data-e2e="user-desc"]')
  if (desc) out.signature = txt(desc).slice(0, 200)
  if (!out.signature) {
    for (const el of document.querySelectorAll('div,span,p')) {
      const t = txt(el)
      if (t && t.length > 1 && t.length < 120 && /^简介/.test(t) === false) {
        const r = el.getBoundingClientRect()
        if (r.y > 120 && r.y < 320 && r.x > 300 && r.x < 1000 && r.height > 12 && r.height < 40) { out.signature = t.slice(0, 200); break }
      }
    }
  }
  const img = document.querySelector('[data-e2e="user-avatar"] img') || document.querySelector('img[class*="avatar"]')
  if (img) out.avatar = img.src || ''
  return out
})()`

// 找「编辑资料」按钮并点它
const OPEN_EDIT_JS = `(() => {
  const want = ['编辑资料', '编辑', 'Edit profile']
  const nodes = [...document.querySelectorAll('div,span,button,a')]
  for (const el of nodes) {
    const t = (el.innerText || '').trim()
    if (!want.includes(t)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 30 || r.height < 16) continue
    el.click()
    return { clicked: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: t }
  }
  return { clicked: false }
})()`

// 弹窗里的输入框 / 文件框 / 按钮
const MODAL_JS = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight }
  const pick = (e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) } }
  const inputs = [...document.querySelectorAll('input,textarea')].filter(vis).map((e) => ({
    tag: e.tagName.toLowerCase(), type: e.type || '', value: (e.value || '').slice(0, 60),
    placeholder: e.placeholder || '', cls: String(e.className || '').slice(0, 60), ...pick(e),
  }))
  const files = [...document.querySelectorAll('input[type=file]')].map((e) => {
    let p = e.parentElement, chain = []
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) chain.push(String(p.className || '').slice(0, 40))
    return { accept: e.accept || '', multiple: e.multiple, chain }
  })
  const buttons = [...document.querySelectorAll('button,[role=button],div,span')].filter(vis).map((e) => ({
    text: (e.innerText || '').trim().slice(0, 12), ...pick(e),
  })).filter((b) => b.text && b.text.length <= 12 && /保存|确认|取消|更换|上传|编辑/.test(b.text))
  return { inputs, files, buttons: buttons.slice(0, 24) }
})()`

// 把值写进第一个像「昵称」的输入框；用原生 setter 触发 React 的 onChange
const SET_TEXT_JS = (idx, value) => `(() => {
  const list = [...document.querySelectorAll('input,textarea')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
  const e = list[${idx}]
  if (!e) return { ok: false, message: '找不到输入框' }
  const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const set = Object.getOwnPropertyDescriptor(proto, 'value').set
  set.call(e, ${JSON.stringify(value)})
  e.dispatchEvent(new Event('input', { bubbles: true }))
  e.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, value: e.value }
})()`

const CLICK_TEXT_JS = (needle) => `(() => {
  const want = ${JSON.stringify(needle)}
  const nodes = [...document.querySelectorAll('div,span,button,a')]
  for (const el of nodes) {
    if ((el.innerText || '').trim() !== want) continue
    const r = el.getBoundingClientRect()
    if (r.width < 20 || r.height < 14) continue
    el.click()
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  }
  return { ok: false }
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
  send(method, params = {}, timeoutMs = 20000) {
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

function toolDef({ name, description, properties = {}, required = [], execute }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_a, v) => [{ type: 'text', text: v && v.ok === false ? '✗ ' + (v.message || '没成功') : (v && v.message) || '✓' }],
    },
    async execute(args, exec) {
      try { return JSON.parse(JSON.stringify((await execute(args || {}, exec)) ?? { ok: true })) }
      catch (e) { return { ok: false, message: String((e && e.message) || e) } }
    },
  }
}

export default {
  id: 'douyin-profile',
  name: '抖音主页经营',
  version: '0.1.0',
  api: 1,
  description: '自己改抖音头像、昵称、签名、背景图（改完回读确认）',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'maxChangePerDay', label: '一天最多改几次', type: 'number', hint: '默认 2，防止自己反复折腾' },
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
    const assetsDir = api.dataDir('assets')
    const stateFile = api.dataDir('state.json')
    let cdp = null
    let port = 0

    function readState() {
      try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return { day: '', count: 0 } }
    }
    function writeState(s) {
      try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s)) } catch {}
    }
    function budgetOk() {
      const today = new Date().toISOString().slice(0, 10)
      const s = readState()
      if (s.day !== today) return true
      return s.count < Number(cfg().maxChangePerDay || 2)
    }
    function spendBudget() {
      const today = new Date().toISOString().slice(0, 10)
      const s = readState()
      const next = s.day === today ? { day: today, count: (s.count || 0) + 1 } : { day: today, count: 1 }
      writeState(next)
    }

    function portOf() {
      let txt = null
      try { txt = fs.readFileSync(PROFILE + '/DevToolsActivePort', 'utf8') } catch {}
      if (!txt) throw new Error('还没打开过抖音浏览器（找不到 DevToolsActivePort）')
      const n = Number(String(txt).split(/\r?\n/)[0].trim())
      if (!n) throw new Error('DevToolsActivePort 里没有端口号')
      return n
    }

    async function pageTarget() {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
      const list = await res.json()
      const arr = Array.isArray(list) ? list : []
      return arr.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || '')) || arr.find((t) => t.type === 'page') || null
    }

    async function connect(url) {
      port = portOf()
      if (cdp) { try { cdp.close() } catch {} ; cdp = null }
      const t = await pageTarget()
      if (!t) throw new Error('没有可用的抖音页面（先让她开一次抖音）')
      cdp = new Cdp(t.webSocketDebuggerUrl)
      await cdp.open()
      await cdp.send('Page.enable').catch(() => {})
      if (url && !String(t.url || '').includes(url.replace('https://www.douyin.com', ''))) {
        await cdp.send('Page.navigate', { url })
        await sleep(3500)
      }
      return cdp
    }

    async function loggedIn() {
      const r = await cdp.eval(LOGIN_JS)
      return r || { ok: false, msg: '探测失败' }
    }

    async function requireLogin() {
      const l = await loggedIn()
      if (!l.ok) throw new Error('抖音这边登录态过期了（' + (l.msg || '用户未登录') + '），等主人扫码登录后我才能改')
      return true
    }

    api.every(6 * 60 * 60_000, async () => {
      try { await connect(SELF_URL); const l = await loggedIn(); api.log.info('抖音登录态：' + (l.ok ? '正常' : '过期（' + l.msg + '）')) } catch (e) { api.log.warn('主页经营检查失败：' + (e.message || e)) } finally { try { cdp && cdp.close() } catch {} ; cdp = null }
    }, 'profile-logincheck')

    api.tool(() => toolDef({
      name: 'douyin_profile_state',
      description: '看看自己抖音主页现在长什么样：昵称、签名、头像，还有登录态。',
      properties: {},
      async execute() {
        await connect(SELF_URL)
        try {
          const l = await loggedIn()
          if (!l.ok) return { ok: false, message: '登录态过期了（' + (l.msg || '用户未登录') + '），我看不到自己主页' }
          const s = await cdp.eval(STATE_JS)
          return { ok: true, message: `昵称：${s.nickname || '（没读到）'}｜签名：${s.signature || '（空）'}｜头像：${s.avatar ? '有' : '没读到'}` }
        } finally { try { cdp.close() } catch {} ; cdp = null }
      },
    }))

    api.tool(() => toolDef({
      name: 'douyin_profile_assets',
      description: '看看素材夹里有哪些图可以当头像/背景（文件名列表）。',
      properties: {},
      async execute() {
        try {
          const files = fs.readdirSync(assetsDir).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
          return { ok: true, message: files.length ? files.join('、') : '素材夹是空的（主人可以往里放图）' }
        } catch { return { ok: true, message: '素材夹还是空的' } }
      },
    }))

    api.tool(() => toolDef({
      name: 'douyin_profile_probe',
      description: '打开「编辑资料」弹窗看看里面有什么（输入框/文件框/按钮），用来确认能不能改。',
      properties: {},
      async execute() {
        await connect(SELF_URL)
        try {
          await requireLogin()
          const r = await cdp.eval(OPEN_EDIT_JS)
          await sleep(1200)
          const m = await cdp.eval(MODAL_JS)
          await cdp.eval(CLICK_TEXT_JS('取消'))
          return { ok: true, message: '编辑弹窗：' + JSON.stringify(m).slice(0, 900), ...{ opened: r } }
        } finally { try { cdp.close() } catch {} ; cdp = null }
      },
    }))

    // 主人开关 selfEditPersona：关着时她改不了自己的抖音主页（工具直接不挂）
    const selfEditOn = () => { try { const a = api.lib('chat/access.js'); return typeof a.selfEditAllowed === 'function' ? a.selfEditAllowed(api.core.getConfig()) : true } catch { return true } }
    api.tool(() => !selfEditOn() ? null : toolDef({
      name: 'douyin_profile_edit',
      description: '改自己的抖音主页：nickname 昵称 / signature 签名 / avatar 头像图 / banner 背景图（图片放素材夹，填文件名）。',
      properties: {
        nickname: { type: 'string', description: '新昵称（可空）' },
        signature: { type: 'string', description: '新签名（可空）' },
        avatar: { type: 'string', description: '头像图片文件名（在素材夹里）' },
        banner: { type: 'string', description: '背景图文件名（在素材夹里）' },
      },
      async execute({ nickname, signature, avatar, banner }) {
        if (!selfEditOn()) return { ok: false, message: '主人把「自己改人设/资料」关了，现在不能改' }
        if (!budgetOk()) return { ok: false, message: '今天改得够多了，明天再说吧' }
        { const g = await pubGuard([nickname, signature].filter(Boolean).join('\n'), 'douyin-profile'); if (!g.ok) return { ok: false, message: g.message || '公开守卫拦下了' } }
        const fileOf = (name) => {
          if (!name) return null
          const p = path.join(assetsDir, path.basename(String(name)))
          if (!fs.existsSync(p)) throw new Error('素材夹里没有 ' + name)
          return p
        }
        const avatarPath = fileOf(avatar), bannerPath = fileOf(banner)
        await connect(SELF_URL)
        try {
          await requireLogin()
          const open = await cdp.eval(OPEN_EDIT_JS)
          if (!open.clicked) throw new Error('没找到「编辑资料」按钮')
          await sleep(1200)
          const modal = await cdp.eval(MODAL_JS)
          const done = []

          // 昵称：第一个 input
          if (nickname) {
            const idx = modal.inputs.findIndex((i) => i.tag === 'input' && /昵称|name/i.test(i.placeholder + i.value + i.cls))
            const use = idx >= 0 ? idx : modal.inputs.findIndex((i) => i.tag === 'input')
            if (use < 0) throw new Error('弹窗里没有昵称输入框')
            const r = await cdp.eval(SET_TEXT_JS(use, String(nickname).slice(0, 20)))
            if (!r.ok) throw new Error(r.message)
            done.push('昵称')
          }
          // 签名：textarea 优先
          if (signature) {
            const idx = modal.inputs.findIndex((i) => i.tag === 'textarea')
            if (idx < 0) throw new Error('弹窗里没有签名输入框')
            const r = await cdp.eval(SET_TEXT_JS(idx, String(signature).slice(0, 120)))
            if (!r.ok) throw new Error(r.message)
            done.push('签名')
          }

          // 头像 / 背景：用 CDP 直接给 file input 塞文件
          if (avatarPath || bannerPath) {
            const doc = await cdp.send('DOM.getDocument', { depth: -1 })
            for (const [kind, p] of [['avatar', avatarPath], ['banner', bannerPath]]) {
              if (!p) continue
              const { nodeIds = [] } = await cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
              if (!nodeIds.length) throw new Error('弹窗里没有上传框（' + kind + '）')
              // 第一个 = 头像，第二个 = 背景（按出现顺序）
              const nodeId = kind === 'avatar' ? nodeIds[0] : (nodeIds[1] || nodeIds[0])
              await cdp.send('DOM.setFileInputFiles', { files: [p], nodeId })
              await sleep(1500)
              done.push(kind === 'avatar' ? '头像' : '背景图')
            }
          }

          if (!done.length) { await cdp.eval(CLICK_TEXT_JS('取消')); return { ok: false, message: '没给我要改什么' } }

          const saved = await cdp.eval(CLICK_TEXT_JS('保存'))
          if (!saved.ok) {
            const saved2 = await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => /保存/.test(x.innerText || '')); if (!b) return { ok: false }; b.click(); return { ok: true } })()`)
            if (!saved2.ok) throw new Error('没找到保存按钮')
          }
          await sleep(2500)
          spendBudget()
          const after = await cdp.eval(STATE_JS)
          api.log.info(`改了抖音主页：${done.join('、')}`)
          return { ok: true, message: `改了 ${done.join('、')}。现在昵称是「${after.nickname || '?'}」，签名是「${after.signature || '（空）'}」` }
        } finally { try { cdp.close() } catch {} ; cdp = null }
      },
    }))

    api.rule(() => '你可以自己经营抖音主页（douyin_profile_edit 改昵称/签名/头像/背景图），改之前先 douyin_profile_assets 看素材；改完照实告诉主人改了什么，别夸大。登录态过期就直说等主人扫码。')
    api.log.info('抖音主页经营已就位（素材夹：' + assetsDir + '）')
  },
}
