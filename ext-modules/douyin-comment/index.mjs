import fs from 'node:fs'
import path from 'node:path'

const PROFILE = process.env.DOUYIN_PROFILE_DIR || 'douyin/edge-profile'

function toolDef(d) {
  return {
    name: d.name,
    description: d.description,
    parameters: { type: 'object', properties: d.properties || {}, required: d.required || [], additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (r) => [{ type: 'text', text: typeof r === 'string' ? r : (r && r.message) || JSON.stringify(r) }],
    },
    execute: d.execute,
  }
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map() }
  static async attach() {
    const raw = fs.readFileSync(path.join(PROFILE, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)
    const port = Number(raw[0])
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const pages = list.filter((t) => t.type === 'page' && /douyin\.com/.test(t.url || ''))
    const page = pages.find((t) => /\/video\//.test(t.url || '')) || pages[0]
    if (!page) throw new Error('没找到抖音页面')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    const c = new Cdp(ws)
    ws.addEventListener('message', (e) => {
      const j = JSON.parse(e.data)
      if (j.id && c.pend.has(j.id)) { const p = c.pend.get(j.id); c.pend.delete(j.id); j.error ? p.reject(new Error(j.error.message)) : p.resolve(j.result) }
    })
    await c.send('Page.enable')
    return c
  }
  send(method, params = {}, ms = 20000) {
    return new Promise((res, rej) => {
      const i = ++this.id
      this.pend.set(i, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify({ id: i, method, params }))
      setTimeout(() => { if (this.pend.has(i)) { this.pend.delete(i); rej(new Error('超时 ' + method)) } }, ms)
    })
  }
  async ev(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r.result?.value
  }
  async click(x, y) {
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }
  close() { try { this.ws.close() } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 用 React fiber 里的 commentInfo.cid 精确定位评论节点；找不到就滚评论容器
const FIND_CID_JS = (cid) => `(() => {
  const CID = ${JSON.stringify(String(cid))}
  const pick = (n) => {
    const k = Object.keys(n).find(x => x.startsWith('__reactFiber$'))
    if (!k) return null
    let f = n[k]
    for (let i = 0; i < 8 && f; i++, f = f.return) {
      const pr = f.memoizedProps
      if (!pr || typeof pr !== 'object') continue
      for (const key of Object.keys(pr)) {
        const v = pr[key]
        if (!v || typeof v !== 'object') continue
        const c = v.cid || v.comment_id || (v.comment && v.comment.cid)
        if (c && String(c) === CID) return n
      }
    }
    return null
  }
  for (const n of document.querySelectorAll('div')) {
    const hit = pick(n)
    if (hit) {
      hit.scrollIntoView({ block: 'center' })
      const r = hit.getBoundingClientRect()
      const exp = [...hit.querySelectorAll('div,span')].filter(x => /^展开\\d+条回复$/.test((x.innerText || '').trim()))[0]
      let epos = null
      if (exp) { const b = exp.getBoundingClientRect(); epos = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } }
      const rep = [...hit.querySelectorAll('div,span')].filter(x => (x.innerText || '').trim() === '回复').pop()
      let rpos = null
      if (rep) { const b = rep.getBoundingClientRect(); rpos = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } }
      return JSON.stringify({ found: true, y: Math.round(r.y + r.height / 2), expand: epos, reply: rpos, txt: (hit.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) })
    }
  }
  const boxes = [...document.querySelectorAll('div')]
    .filter(e => e.scrollHeight > e.clientHeight + 80 && e.clientHeight > 260 && /全部评论|评论/.test(e.innerText || ''))
    .sort((a, b) => b.clientHeight - a.clientHeight)
  if (boxes[0]) boxes[0].scrollBy(0, 800)
  else window.scrollBy(0, 800)
  return 'SCROLL'
})()`

const EDITOR_JS = `(() => {
  const list = []
  document.querySelectorAll('[contenteditable="true"],textarea').forEach(el => {
    const r = el.getBoundingClientRect()
    if (r.width > 80 && r.height > 8) list.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), ph: (el.getAttribute('placeholder') || el.innerText || '').slice(0, 30) })
  })
  return JSON.stringify(list)
})()`

const ROW_BY_TEXT_JS = (needle) => `(() => {
  const rows = [...document.querySelectorAll('div')].filter(el => {
    const t = el.innerText || ''
    return t.includes(${JSON.stringify(needle)}) && t.includes('回复') && t.length < 260
  }).sort((a, b) => a.innerText.length - b.innerText.length)
  const row = rows[0]
  if (!row) return 'NOROW'
  row.scrollIntoView({ block: 'center' })
  const r = row.getBoundingClientRect()
  let dot = null
  for (const x of row.querySelectorAll('div,span,svg')) {
    const b = x.getBoundingClientRect()
    if (b.width > 0 && b.width <= 40 && b.height > 0 && b.x > r.x + r.width * 0.55) {
      const t = (x.textContent || '').trim()
      if (t === '' || t === '...' || t === '⋯' || t === '•••') { dot = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; break }
    }
  }
  return JSON.stringify({ dot, x: Math.round(r.x + r.width - 22), y: Math.round(r.y + 22), x2: Math.round(r.x + r.width) })
})()`

const MENU_JS = `(() => {
  const cands = [...document.querySelectorAll('div,span,li')].filter(x => {
    const t = (x.textContent || '').trim()
    if (t !== '删除评论' && t !== '删除') return false
    const r = x.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  if (!cands.length) return 'NOMENU'
  const el = cands[cands.length - 1]
  const r = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), t: (el.textContent || '').trim() })
})()`

const CONFIRM_JS = `(() => {
  const c = [...document.querySelectorAll('div,span,button')].filter(x => {
    if (x.children.length) return false
    const t = (x.textContent || '').trim()
    return (t === '确定' || t === '删除' || t === '确认') && x.getBoundingClientRect().width > 0
  })
  if (!c.length) return 'NONE'
  const el = c[c.length - 1]
  const r = el.getBoundingClientRect()
  return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), t: (el.textContent || '').trim() })
})()`

export default {
  id: 'douyin-comment',
  name: '抖音评论 · 楼中楼',
  version: '1.2.0',
  api: 1,
  description: '按评论 cid 精确定位：发一级评论、回复指定评论（楼中楼）、删自己的评论。',
  defaults: { enabled: true, waitLoadMs: 900, maxScrolls: 16 },
  settings: [
    { key: 'enabled', label: '启用', type: 'boolean' },
    { key: 'maxScrolls', label: '最多滚动次数', type: 'number', hint: '按 cid 找评论时最多滚几次，默认 16' },
  ],
  setup(api) {

    // 公开守卫（插件 security/public-guard.js）：18+ 一律不出主人私聊 + 私聊记忆防漏，发之前先过一遍
    const __pg = (() => { try { return api.lib('security/public-guard.js') } catch { return null } })()
    const pubGuard = async (text, target, chat) => {
      if (!__pg || typeof __pg.checkPublic !== 'function') return { ok: false, reason: 'unavailable', message: '公开守卫没加载，先不发' }
      const getConfig = () => { try { return api.core.getConfig() } catch { return {} } }
      return __pg.checkPublic(String(text || ''), { target, chat: chat || 'system', getConfig, log: api.log })
    }
    const cfg = () => api.settings()

    async function openVideo(awemeId) {
      const c = await Cdp.attach()
      await c.send('Page.bringToFront')
      const url = String(await c.ev('location.href'))
      if (String(awemeId) && !url.includes(String(awemeId))) {
        await c.send('Page.navigate', { url: 'https://www.douyin.com/video/' + awemeId })
        await sleep(5500)
      }
      return c
    }

    async function locateByCid(c, cid) {
      const max = Number(cfg().maxScrolls) || 16
      for (let i = 0; i < max; i++) {
        const r = await c.ev(FIND_CID_JS(cid))
        if (r && r !== 'SCROLL') return JSON.parse(r)
        await sleep(Number(cfg().waitLoadMs) || 900)
      }
      return null
    }

    async function typeAndSend(c, text) {
      const eds = JSON.parse((await c.ev(EDITOR_JS)) || '[]')
      if (!eds.length) return false
      const e = eds[eds.length - 1]
      await c.click(e.x, e.y)
      await sleep(400)
      await c.send('Input.insertText', { text })
      await sleep(600)
      await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' })
      await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      return true
    }

    const tools = [
      toolDef({
        name: 'douyin_thread_comment',
        description: '在抖音视频下发评论。带 reply_cid（要回复的那条评论 id）时，回复成楼中楼；如果它是二级回复，再给 parent_cid 先展开父评论。',
        properties: {
          aweme_id: { type: 'string', description: '作品 id 或链接' },
          content: { type: 'string', description: '评论内容' },
          reply_cid: { type: 'string', description: '可选：要回复的评论 cid' },
          parent_cid: { type: 'string', description: '可选：当 reply_cid 是二级回复时，其一级父评论 cid' },
          reply_needle: { type: 'string', description: '可选：那条回复里的文字片段，cid 定位不到时兜底' },
        },
        required: ['aweme_id', 'content'],
        execute: async ({ aweme_id, content, reply_cid, parent_cid, reply_needle }) => {
          if (!cfg().enabled) return { ok: false, message: '模块已关' }
          { const g = await pubGuard(content, 'douyin-comment'); if (!g.ok) return { ok: false, message: g.message || '公开守卫拦下了' } }
          let c
          try {
            c = await openVideo(aweme_id)
            if (reply_cid) {
              // 二级回复：先按父 cid 找到父评论并展开
              if (parent_cid) {
                const par = await locateByCid(c, parent_cid)
                if (!par) return { ok: false, message: '没找到父评论 cid=' + parent_cid }
                if (par.expand) {
                  await c.click(par.expand.x, par.expand.y)
                  await sleep(2600)
                }
              }
              let clicked = false
              const tgt = await locateByCid(c, reply_cid)
              if (tgt && tgt.reply) {
                await c.click(tgt.reply.x, tgt.reply.y)
                await sleep(2200)
                clicked = true
              }
              if (!clicked) {
                // 二级回复的 cid 不在 DOM 的 props 上：退回「父评论子树里按文字找」
                const needle = String(reply_needle || '').trim()
                if (!parent_cid || !needle) return { ok: false, message: '没找到要回复的评论 cid=' + reply_cid + '（也没给 reply_needle 兜底）' }
                const inParent = (pc, nd) => `(() => {
                  const CID = ${JSON.stringify(String(pc))}
                  const pick = (n) => {
                    const k = Object.keys(n).find(x => x.startsWith('__reactFiber$'))
                    if (!k) return null
                    let f = n[k]
                    for (let i = 0; i < 8 && f; i++, f = f.return) {
                      const pr = f.memoizedProps
                      if (!pr || typeof pr !== 'object') continue
                      for (const key of Object.keys(pr)) {
                        const v = pr[key]
                        if (!v || typeof v !== 'object') continue
                        const cc = v.cid || v.comment_id || (v.comment && v.comment.cid)
                        if (cc && String(cc) === CID) return n
                      }
                    }
                    return null
                  }
                  let parent = null
                  for (const n of document.querySelectorAll('div')) { if (pick(n)) { parent = n; break } }
                  if (!parent) return 'NOPARENT'
                  parent.scrollIntoView({ block: 'center' })
                  const rows = [...parent.querySelectorAll('div')].filter(el => {
                    const t = el.innerText || ''
                    return t.includes(${JSON.stringify(nd)}) && t.includes('回复') && t.length < 260
                  }).sort((a, b) => a.innerText.length - b.innerText.length)
                  const row = rows[0]
                  if (!row) return 'NOROW'
                  const btn = [...row.querySelectorAll('div,span')].filter(x => (x.innerText || '').trim() === '回复').pop()
                  if (!btn) return 'NOBTN'
                  const b = btn.getBoundingClientRect()
                  return JSON.stringify({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), txt: (row.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) })
                })()`
                let pos = await c.ev(inParent(parent_cid, needle))
                if (pos === 'NOROW' || pos === 'NOPARENT' || pos === 'NOBTN') {
                  const par = await locateByCid(c, parent_cid)
                  if (par && par.expand) { await c.click(par.expand.x, par.expand.y); await sleep(2600) }
                  pos = await c.ev(inParent(parent_cid, needle))
                }
                if (pos === 'NOROW' || pos === 'NOPARENT' || pos === 'NOBTN') return { ok: false, message: '父评论下没找到那条回复（' + pos + '）' }
                const q = JSON.parse(pos)
                await c.click(q.x, q.y)
                await sleep(2200)
              }
            } else {
              const ph = await c.ev(`(() => { const e = [...document.querySelectorAll('div,span,p')].find(x => (x.innerText || '').trim() === '留下你的精彩评论吧'); if (!e) return ''; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) })()`)
              if (!ph) return { ok: false, message: '没找到评论输入框' }
              const q = JSON.parse(ph)
              await sleep(600)
              await c.click(q.x, q.y)
              await sleep(1800)
            }
            const typed = await typeAndSend(c, content)
            if (!typed) return { ok: false, message: '输入框没出现，未发送' }
            await sleep(4200)
            const risky = await c.ev(`/接收短信验证码|安全验证/.test(document.body.innerText)`)
            const shown = await c.ev(`document.body.innerText.split(${JSON.stringify(content.trim().slice(0, 12))}).length - 1`)
            try {
              const s = await c.send('Page.captureScreenshot', { format: 'png' })
              fs.writeFileSync(path.join(api.dataDir(), 'comment-' + Date.now() + '.png'), Buffer.from(s.data, 'base64'))
            } catch {}
            // 回车之后绝不重发（借鉴 douyin-hot-reply：点了发送就不重试，免得发两遍）；页面上找不到就报「不确定」
            const seen = Number(shown) > 0
            return {
              ok: seen && !risky,
              uncertain: !seen,
              message: (seen ? (reply_cid ? '已回复到指定评论下' : '已发一级评论') : '已回车发送，但页面上没看到这条（可能被审核/折叠），不要重发，稍后用 douyin_notices_now 或打开视频核对') + (risky ? '，但抖音弹了短信验证，需要人工输码' : '') + '（页面命中 ' + shown + ' 次）',
              needsVerify: !!risky || !seen,
            }
          } catch (e) {
            return { ok: false, message: '出错了：' + e.message }
          } finally { if (c) c.close() }
        },
      }),
      toolDef({
        name: 'douyin_comment_delete',
        description: '删除自己在这条视频下的一条评论（按评论文字定位）。',
        properties: {
          aweme_id: { type: 'string', description: '作品 id 或链接' },
          content: { type: 'string', description: '要删的评论文字（片段即可）' },
        },
        required: ['aweme_id', 'content'],
        execute: async ({ aweme_id, content }) => {
          let c
          try {
            c = await openVideo(aweme_id)
            let row = null
            for (let i = 0; i < (Number(cfg().maxScrolls) || 16); i++) {
              const r = await c.ev(ROW_BY_TEXT_JS(content))
              if (r && r !== 'NOROW') { row = JSON.parse(r); break }
              await sleep(Number(cfg().waitLoadMs) || 900)
            }
            if (!row) return { ok: false, message: '评论区里没找到这条评论' }
            await sleep(500)
            const hoverPts = row.dot ? [row.dot, { x: row.dot.x, y: row.dot.y }] : [{ x: row.x, y: row.y }, { x: row.x2 - 40, y: row.y }]
            for (const p of hoverPts) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(450) }
            let menu = await c.ev(MENU_JS)
            if (menu === 'NOMENU' && row.dot) { await c.click(row.dot.x, row.dot.y); await sleep(900); menu = await c.ev(MENU_JS) }
            if (menu === 'NOMENU') return { ok: false, message: '悬停后没出现「删除评论」（这条可能不是自己发的）' }
            const m = JSON.parse(menu)
            await c.click(m.x, m.y)
            await sleep(1500)
            const confRaw = await c.ev(CONFIRM_JS)
            if (confRaw !== 'NONE') { const q = JSON.parse(confRaw); await c.click(q.x, q.y); await sleep(3500) }
            else await sleep(2500)
            const gone = !(await c.ev(`document.body.innerText.includes(${JSON.stringify(content)})`))
            return { ok: gone, message: gone ? '已删除（点了「' + m.t + '」）' : '点了「' + m.t + '」但评论还在' }
          } catch (e) {
            return { ok: false, message: '出错了：' + e.message }
          } finally { if (c) c.close() }
        },
      }),
    ]

    for (const t of tools) api.tool(() => t)

    api.command({
      name: '评论',
      aliases: ['删除评论'],
      desc: '在抖音视频下发评论 / 删评论 / 用 cid 回复某条评论',
      run: (arg) => (arg ? '发评论用 douyin_thread_comment（要 aweme_id；回复某条加 reply_cid）' : '用法：/评论 <videoId> <内容>'),
    })

    api.rule((kind) => (kind === 'private' ? '回抖音评论用 douyin_thread_comment；要回复某条评论必须带 reply_cid，二级回复再带 parent_cid，别再发到一级评论。' : ''))

    api.later(5000, () => api.log.info('抖音评论模块就绪（cid 精确定位 + 楼中楼 + 删除）'))
  },
}
