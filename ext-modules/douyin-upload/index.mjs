// 抖音发布（视频 / 图文）
// 思路：复用她自己的 Edge（已登录），CDP 操控 creator.douyin.com 的发布页。
// 安全默认：dryRun = true —— 只上传、填好文案、停在「发布」按钮前，等主人确认后再真发。
import fs from 'node:fs'
import path from 'node:path'

const PROFILE = process.env.DOUYIN_PROFILE_DIR || 'douyin/edge-profile'
const UPLOAD_URL = 'https://creator.douyin.com/creator-micro/content/upload'

function portOf() {
  const t = fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]
  const n = Number(t)
  if (!n) throw new Error('读不到抖音浏览器的调试端口')
  return n
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map() }
  static async open(url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('连不上浏览器'))) })
    const c = new Cdp(ws)
    ws.addEventListener('message', (e) => {
      const j = JSON.parse(e.data)
      if (j.id && c.pend.has(j.id)) { const p = c.pend.get(j.id); c.pend.delete(j.id); j.error ? p.reject(new Error(j.error.message)) : p.resolve(j.result) }
    })
    return c
  }
  send(method, params = {}, timeout = 20000) {
    return new Promise((res, rej) => {
      const i = ++this.id
      this.pend.set(i, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id: i, method, params }))
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('浏览器没响应：' + method)) } }, timeout)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function ensurePage(log) {
  const port = portOf()
  let list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  let page = list.find((t) => t.type === 'page' && /creator\.douyin\.com/.test(t.url || ''))
  if (!page) {
    const made = await (await fetch(`http://127.0.0.1:${port}/json/new?${UPLOAD_URL}`, { method: 'PUT' })).json()
    await new Promise((r) => setTimeout(r, 9000))
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    page = list.find((t) => t.id === made.id) || list.find((t) => /creator\.douyin\.com/.test(t.url || ''))
  }
  if (!page) throw new Error('打不开抖音创作者平台')
  const cdp = await Cdp.open(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('DOM.enable')
  return cdp
}

// 切到「发布图文」并确认真的切过去了（页面上会出现「最多支持上传…图片」的说明）
async function ensureMode(cdp, images, log) {
  if (!images) return
  for (let i = 0; i < 8; i++) {
    const state = await cdp.eval(`(() => { const t = document.body.innerText || ''; return { image: /最多支持上传/.test(t), video: /支持投稿1小时以内/.test(t), tabs: /发布图文/.test(t) } })()`)
    if (state && state.image && !state.video) return
    // 实测：CDP 的 Input.dispatchMouseEvent 点不中这个 tab（dpr 1.5 下坐标对不上），
    // 而页面内的 MouseEvent('click', {bubbles:true}) 能真正切过去。
    const clicked = await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('[class*="tab-item"],div,span,li')].find(e => (e.innerText || '').trim() === '发布图文' && e.getBoundingClientRect().width > 20)
      if (!el) return false
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
      return true
    })()`)
    if (!clicked) {
      // 没有标签页说明现在不是「上传入口」（可能停在编辑器或别的路由），回上传页再等
      await cdp.send('Page.navigate', { url: 'https://creator.douyin.com/creator-micro/content/upload' })
      await new Promise((res) => setTimeout(res, 9000))
      continue
    }
    await new Promise((res) => setTimeout(res, 2500))
  }
  log.warn('抖音发布：没能切到图文模式，就按当前模式上传')
}

// 等页面出现能接收文件的 input
async function waitInput(cdp, { images }, log) {
  for (let i = 0; i < 25; i++) {
    const ok = await cdp.eval(`(() => {
      const ins = [...document.querySelectorAll('input[type=file]')]
      const want = ${images ? `/image|png|jpe?g|webp/i` : `/video|mp4|flv/i`}
      return ins.some((e) => want.test(e.accept || '')) ? true : (ins.length ? 'loose' : null)
    })()`)
    if (ok === true) return true
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('发布页没出现上传框（可能没登录创作者平台）')
}

async function setFiles(cdp, files, images) {
  // 图文/视频页各有一个 input[type=file]，先在页面里算出该用哪一个，再按序号拿 nodeId
  const idx = await cdp.eval(`(() => {
    const ins = [...document.querySelectorAll('input[type=file]')]
    if (!ins.length) return -1
    const want = ${images ? `/image|png|jpe?g|webp/i` : `/video|mp4|flv/i`}
    const i = ins.findIndex((e) => want.test(e.accept || ''))
    return i >= 0 ? i : 0
  })()`)
  if (idx === undefined || idx < 0) throw new Error('找不到上传框')
  const doc = await cdp.send('DOM.getDocument', { depth: 1 })
  const all = await cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
  const nodeId = (all.nodeIds || [])[idx]
  if (!nodeId) throw new Error('上传框拿不到节点')
  await cdp.send('DOM.setFileInputFiles', { nodeId, files })
}

async function fillText(cdp, value, log) {
  const box = await cdp.eval(`(() => {
    const cands = [...document.querySelectorAll('input,textarea,[contenteditable="true"]')]
      .filter(e => e.offsetParent !== null)
    let best = null
    for (const e of cands) {
      const ph = (e.getAttribute('placeholder') || e.getAttribute('data-placeholder') || '') + ' ' + (e.className || '')
      const r = e.getBoundingClientRect()
      if (r.width < 120 || r.height < 14) continue
      const score = /标题|title/.test(ph) ? 3 : /简介|简介|描述|desc|作品描述/.test(ph) ? 2 : 1
      if (!best || score > best.s) best = { e, s: score, x: Math.round(r.x + 20), y: Math.round(r.y + r.height / 2) }
    }
    if (!best) return null
    best.e.focus()
    return { x: best.x, y: best.y }
  })()`)
  if (!box) { log.warn('抖音发布：没找到标题输入框'); return false }
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.insertText', { text: value })
  return true
}

async function clickPublish(cdp) {
  const r = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button,div,span')].filter(e => (e.innerText||'').trim() === '发布')
    const t = b.map(e => ({ e, r: e.getBoundingClientRect() })).filter(x => x.r.width > 40 && x.r.height > 24 && x.r.y > 200)
      .sort((a, b2) => b2.r.y - a.r.y)[0]
    if (!t) return null
    return { x: Math.round(t.r.x + t.r.width / 2), y: Math.round(t.r.y + t.r.height / 2) }
  })()`)
  if (!r) throw new Error('没找到「发布」按钮')
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y })
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 })
  return true
}

async function shot(cdp, file) {
  const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(file, Buffer.from(s.data, 'base64'))
  return file
}

export default {
  id: 'douyin-upload',
  name: '抖音发布',
  version: '1.0.0',
  api: 1,
  description: '让她自己发抖音：视频 / 图文，默认只准备不发布，主人点头才按发布',
  defaults: { enabled: true, dryRun: true, outDir: '' },
  settings: [
    { key: 'enabled', label: '开启抖音发布', type: 'switch', hint: '关掉她就不能自己发作品' },
    { key: 'dryRun', label: '只准备不发布', type: 'switch', hint: '开着：上传+填文案后停在发布按钮前；关掉：直接发出去' },
  ],

  setup(api) {

    // 公开守卫（插件 security/public-guard.js）：18+ 一律不出主人私聊 + 私聊记忆防漏，发之前先过一遍
    const __pg = (() => { try { return api.lib('security/public-guard.js') } catch { return null } })()
    const pubGuard = async (text, target, chat) => {
      if (!__pg || typeof __pg.checkPublic !== 'function') return { ok: false, reason: 'unavailable', message: '公开守卫没加载，先不发' }
      const getConfig = () => { try { return api.core.getConfig() } catch { return {} } }
      return __pg.checkPublic(String(text || ''), { target, chat: chat || 'system', getConfig, log: api.log })
    }
    const k = () => ({ ...this.defaults, ...api.settings() })
    const outDir = () => api.settings().outDir || api.dataDir('shots')

    function toolDef(def) {
      return { ...def, output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (r) => (typeof r === 'string' ? r : r?.message || '') } }
    }

    async function run({ files, title, desc, images }) {
      { const g = await pubGuard([title, desc].filter(Boolean).join('\n'), 'douyin-publish'); if (!g.ok) return { ok: false, message: g.message || '公开守卫拦下了' } }
      const cfg = k()
      if (!cfg.enabled) return { ok: false, message: '抖音发布被我关掉了（面板里能开）' }
      for (const f of files) if (!fs.existsSync(f)) return { ok: false, message: '找不到文件：' + f }
      const cdp = await ensurePage(api.log)
      try {
        await cdp.send('Page.navigate', { url: UPLOAD_URL })
        await new Promise((r) => setTimeout(r, 6000))
        // 上一个测试可能停在编辑器里（没有「发布图文」标签），强制刷一遍
        if (!(await cdp.eval(`/发布图文/.test(document.body.innerText)`))) {
          await cdp.send('Page.reload', { ignoreCache: true })
          await new Promise((r) => setTimeout(r, 9000))
        }
        await ensureMode(cdp, images, api.log)
        await waitInput(cdp, { images }, api.log)
        await new Promise((r) => setTimeout(r, 2000))
        await setFiles(cdp, files, images)
        api.log.info('抖音发布：已提交 ' + files.length + ' 个文件，等上传')
        // 等上传/转码出标题框
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 3000))
          const ready = await cdp.eval(`(() => !!document.querySelector('input[placeholder*="标题"],textarea,input[type=text]'))()`)
          if (ready) break
        }
        const text = [title, desc].filter(Boolean).join(' ')
        if (text) await fillText(cdp, text.slice(0, 200), api.log)
        const s = await shot(cdp, path.join(api.dataDir(), 'upload-' + Date.now() + '.png'))
        if (cfg.dryRun) {
          return { ok: true, dryRun: true, message: '已经传到发布页、文案也填好了，停在「发布」前等你点头。截图：' + s, shot: s }
        }
        await clickPublish(cdp)
        await new Promise((r) => setTimeout(r, 4000))
        const s2 = await shot(cdp, path.join(api.dataDir(), 'published-' + Date.now() + '.png'))
        return { ok: true, message: '已经点发布啦，截图：' + s2, shot: s2 }
      } finally { cdp.close() }
    }

    api.tool(() => toolDef({
      name: 'douyin_publish_images',
      description: '发一条抖音图文：给几张本地图片路径 + 标题，自动上传到创作者平台',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '图片绝对路径，1~12 张' },
        title: { type: 'string', description: '标题/文案，可带 #话题' },
      },
      required: ['files'],
      execute: async ({ files, title }) => {
        const list = (Array.isArray(files) ? files : [files]).map(String).slice(0, 12)
        return run({ files: list, title: String(title || ''), images: true })
      },
    }))

    api.tool(() => toolDef({
      name: 'douyin_publish_video',
      description: '发一条抖音视频：给本地视频路径 + 标题',
      properties: {
        file: { type: 'string', description: '视频绝对路径' },
        title: { type: 'string', description: '标题/文案，可带 #话题' },
      },
      required: ['file'],
      execute: async ({ file, title }) => run({ files: [String(file)], title: String(title || ''), images: false }),
    }))

    api.tool(() => toolDef({
      name: 'douyin_publish_confirm',
      description: '把已经准备好的作品真正发布出去（点「发布」）',
      properties: {},
      execute: async () => {
        const cdp = await ensurePage(api.log)
        try { await clickPublish(cdp); await new Promise((r) => setTimeout(r, 4000)); const s = await shot(cdp, path.join(api.dataDir(), 'published-' + Date.now() + '.png')); return { ok: true, message: '发出去了，截图：' + s } }
        finally { cdp.close() }
      },
    }))

    api.command({
      name: '发抖音', aliases: ['发布', '投稿'], desc: '发一条抖音（图文/视频）',
      run: async (arg) => {
        const p = String(arg || '').trim()
        if (!p) return '用法：/发抖音 <图片或视频路径> [标题]'
        const [file, ...rest] = p.split(/\s+/)
        const images = /\.(png|jpe?g|webp)$/i.test(file)
        return (await run({ files: [file], title: rest.join(' '), images })).message
      },
    })

    api.rule(() => '主人让你发抖音作品时用 douyin_publish_images / douyin_publish_video；默认只准备不发布，主人说「发吧」再用 douyin_publish_confirm。')
    api.later(4000, async () => { api.log.info('抖音发布已就绪（dryRun=' + k().dryRun + '，出图目录=' + api.dataDir() + '）') })
  },
}
