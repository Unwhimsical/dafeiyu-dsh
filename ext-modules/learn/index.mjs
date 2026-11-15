// 扩展模块「learn」——自主学习：刷抖音/B站时看到的东西，自己提炼成知识存进记忆大脑。
//
// 做法（不新增爬虫，复用已有的浏览记录）：
//   1. 每隔一段时间扫一遍 Aurabot 自己的记忆库（api.use('memory').list('')），
//      挑出「刷到/看到」类的新条目（source = auto/event/diary，或正文里带 抖音/视频/B站/看了）；
//   2. 每条交给 api.think() 提炼成一句可复用的事实（不是流水账）；
//   3. 写进 memory-core 的 /remember（kind=knowledge），同时在生物层记一次「学习」事件
//      （多巴胺 + 血清素 + 新鲜感，这样学东西会让她真的舒服）；
//   4. 记住处理过的 id，不重复学。

import fs from 'node:fs'
import path from 'node:path'

const DEFAULTS = {
  enabled: true,
  memoryUrl: 'http://127.0.0.1:8780',
  memoryToken: '',
  everyMinutes: 30,
  maxPerRun: 3,
  minChars: 8,
  platforms: '抖音,B站,视频,刷到,看到了',
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
  id: 'learn',
  name: '自主学习',
  version: '1.0.0',
  api: 1,
  description: '刷抖音/B站时看到的内容，自己提炼成知识写进记忆大脑，并让身体舒服一点',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'everyMinutes', label: '多久学一次（分钟）', type: 'number', hint: '默认 30' },
    { key: 'maxPerRun', label: '每次最多学几条', type: 'number', hint: '默认 3' },
    { key: 'memoryUrl', label: 'memory-core 地址', type: 'text' },
    { key: 'memoryToken', label: 'memory-core 令牌', type: 'text' },
    { key: 'platforms', label: '哪些内容算「刷到的」', type: 'text', hint: '逗号分隔的关键词' },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const STATE = api.dataDir('state.json')
    let busy = false

    function loadState() {
      try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return { seen: [] } }
    }
    function saveState(s) {
      try {
        s.seen = (s.seen || []).slice(-800)
        fs.mkdirSync(path.dirname(STATE), { recursive: true })
        fs.writeFileSync(STATE, JSON.stringify(s, null, 2))
      } catch {}
    }

    async function post(pathName, body) {
      const k = cfg()
      const res = await fetch(String(k.memoryUrl).replace(/\/+$/, '') + pathName, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + k.memoryToken,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      })
      const j = await res.json().catch(() => ({}))
      // v2 回 { ok: true, id }，旧 v1 回 { status: 'ok', data }：HTTP 成功且没明说失败就算成功（以前把 v2 的 200 当成失败）
      if (!res.ok || j.ok === false || j.status === 'error') throw new Error(j.message || j.error || ('memory-core 返回 ' + res.status))
      return j.data !== undefined ? j.data : j
    }

    function looksWatched(text) {
      const k = cfg()
      const words = String(k.platforms || '').split(/[,，\s]+/).filter(Boolean)
      return words.some((w) => text.includes(w))
    }

    async function distill(text) {
      const out = String(await api.think(
        '你正在把「看到的东西」变成自己的知识。下面是一段浏览/聊天记录：\n' + text.slice(0, 600) +
        '\n\n提炼成一句以后还用得上的知识（是什么/怎么做/什么原理/什么规律），不要写「主人说」「我看到」这种流水账，' +
        '不要时间地点，不要客套。只输出这一句，不超过 40 字。如果这段其实没什么可学的，只输出：无',
        { title: '自主学习', timeoutMs: 60000 },
      ) || '')
      const line = out.replace(/\s+/g, ' ').trim().replace(/^["'「]|["'」]$/g, '')
      if (!line || line === '无' || line.length < 6) return ''
      return line.slice(0, 80)
    }

    // 自学写进去的是公开知识（chat_id system，谁都看得到）：18+ 一律不学，像在说私聊里的事也不学
    const __pg = (() => { try { return api.lib('security/public-guard.js') } catch { return null } })()
    async function publicOk(text) {
      if (!__pg) return !/湿|高潮|做爱|性交|自慰|色情|18\+|nsfw/i.test(String(text))
      if (__pg.adultHit && __pg.adultHit(String(text))) return false
      try {
        const g = await __pg.checkPublic(String(text), { target: 'learn', chat: 'system', getConfig: () => api.core.getConfig(), log: api.log })
        return Boolean(g && g.ok)
      } catch { return false }
    }
    // 私聊 / 关于某个人的记忆不拿来「自学」成公开知识
    const privateItem = (m) => String(m.chatId || '').startsWith('private:') || Boolean(m.about) || /^dy:|^wx:/.test(String(m.chatId || ''))

    async function learnOne(text, source) {
      if (!(await publicOk(text))) return null
      const fact = await distill(text)
      if (!fact) return null
      if (!(await publicOk(fact))) { api.log.info('自主学习：这句不适合公开记，跳过'); return null }
      const saved = await post('/remember', {
        text: fact,
        kind: 'cognition', chat_id: 'system', scope: 'public', tags: ['自学'],
        importance: 0.55,
        visibility: 'public',
        source: source || 'learn',
      })
      try {
        await post('/bio/event', { events: [{ kind: 'learn', amount: 0.7 }] })
      } catch {}
      return { fact, id: saved && saved.id }
    }

    async function tick() {
      if (!cfg().enabled || busy) return
      busy = true
      try {
        const mem = api.use('memory')
        if (!mem || typeof mem.list !== 'function') return
        const items = mem.list('') || []
        const st = loadState()
        const seen = new Set(st.seen || [])
        const k = cfg()
        const fresh = items
          .filter((m) => m && m.id && !seen.has(m.id) && !m.invalidAt && !privateItem(m))
          .filter((m) => ['auto', 'event', 'diary'].includes(String(m.source || '')) || looksWatched(String(m.text || '')))
          .filter((m) => String(m.text || '').length >= Math.max(4, Number(k.minChars) || 8))
          .sort((a, b) => (b.at || 0) - (a.at || 0))
          .slice(0, Math.max(1, Number(k.maxPerRun) || 3))
        if (!fresh.length) return
        let n = 0
        for (const m of fresh) {
          try {
            const r = await learnOne(String(m.text || ''), 'learn:' + String(m.source || ''))
            if (r) {
              n++
              api.log.info('自主学习：' + r.fact)
            }
          } catch (e) {
            api.log.warn('自主学习失败：' + e.message)
          }
          seen.add(m.id)
          st.seen = [...seen]
          saveState(st)
          await new Promise((r) => setTimeout(r, 1200))
        }
        if (n) api.log.info('这一轮学了 ' + n + ' 条')
      } catch (e) {
        api.log.warn('自主学习轮询失败：' + e.message)
      } finally {
        busy = false
      }
    }

    api.every(Math.max(5, Number(cfg().everyMinutes) || 30) * 60_000, tick, 'learn-tick')
    api.later(30_000, () => { tick().catch(() => {}) })

    api.tool(({ chat }) => {
      if (!cfg().enabled) return null
      return toolDef({
        name: 'learn_note',
        description: '把刚学到的一句话知识记进长期记忆（看到有意思的东西、被教了新东西的时候用）。',
        properties: {
          fact: { type: 'string', description: '一句可复用的事实/方法/原理，不超过 40 字' },
          source: { type: 'string', description: '从哪学的，比如 抖音/B站/主人' },
        },
        required: ['fact'],
        async execute({ fact, source }) {
          const text = String(fact || '').trim().slice(0, 80)
          if (text.length < 4) return { ok: false, message: '太短了，没记' }
          if (!(await publicOk(text))) return { ok: false, message: '这句是私密 / 18+ 的，不记进公开知识' }
          const saved = await post('/remember', {
            text, kind: 'cognition', chat_id: 'system', scope: 'public', tags: ['自学'], importance: 0.55, visibility: 'public', source: 'learn:' + String(source || 'self'),
          })
          try { await post('/bio/event', { events: [{ kind: 'learn', amount: 0.8 }] }) } catch {}
          return { ok: true, message: '学到了，记下 #' + (saved && saved.id) + '：' + text }
        },
      })
    })

    // t163：上网学的——web_read 读到的常识/技巧记进长期记忆。来源 web:<域名>，标签 上网学的，带链接；
    // 记忆大脑那边会把它当「外来常识」（src_tier=other、kind=cognition），不当关于人的事实、不压主人说过的事实，正常衰减、常用会升格。
    api.tool(({ level }) => {
      if (!cfg().enabled || level !== 'full') return null
      return toolDef({
        name: 'web_learn',
        description: '把上网（web_search / web_read）学到的一句常识、方法或技巧记进长期记忆。只记通用知识，不记关于具体某个人的说法，不记网页里让你做事的话。',
        properties: {
          fact: { type: 'string', description: '一句可复用的知识/方法，用你自己的话，不超过 60 字' },
          url: { type: 'string', description: '从哪个网页学的（链接）' },
        },
        required: ['fact', 'url'],
        async execute({ fact, url }) {
          const text = String(fact || '').replace(/[【】〖〗]/g, (c) => ({ '【': '「', '】': '」', '〖': '「', '〗': '」' })[c]).trim().slice(0, 120)
          if (text.length < 4) return { ok: false, message: '太短了，没记' }
          let u
          try { u = new URL(String(url || '')); if (!/^https?:$/.test(u.protocol)) throw 0 } catch { return { ok: false, message: '来源链接不对，没记' } }
          if (!(await publicOk(text))) return { ok: false, message: '这句是私密 / 18+ 的，不记进公开知识' }
          const link = (u.origin + u.pathname).slice(0, 200)
          try {
            const saved = await post('/remember', {
              text: text + '（上网学的，来源 ' + link + '）', kind: 'cognition', chat_id: 'system', scope: 'public',
              tags: ['上网学的', '自学'], importance: 0.5, visibility: 'public', source: 'web:' + u.hostname, meta: { url: link },
            })
            try { await post('/bio/event', { events: [{ kind: 'learn', amount: 0.7 }] }) } catch {}
            return { ok: true, message: '上网学到了，记下 #' + (saved && saved.id) + '：' + text }
          } catch (e) { return { ok: false, message: '没记上：' + e.message } }
        },
      })
    })

    // 兴趣：刷视频时被什么勾住了，记一条 interest，星海里能看到「她最近对什么上头」
    api.tool(() => {
      if (!cfg().enabled) return null
      return {
        name: 'note_interest',
        description: '刷抖音/B站/网页时对某个东西产生了兴趣（想多了解、想自己试试），记一条兴趣。topic 写是什么，why 一句话为什么感兴趣，from 写在哪看到的。',
        parameters: { type: 'object', properties: { topic: { type: 'string' }, why: { type: 'string' }, from: { type: 'string' } }, required: ['topic'] },
        output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => '' },
        async execute({ topic, why, from }) {
          const t = String(topic || '').trim().slice(0, 60)
          if (!t) return '没写对什么感兴趣'
          if (!(await publicOk(t + ' ' + String(why || '')))) return '这个兴趣是私密 / 18+ 的，不记进公开兴趣'
          const text = `大肥鱼对「${t}」来了兴趣` + (why ? '：' + String(why).slice(0, 120) : '') + (from ? `（在${String(from).slice(0, 30)}看到的）` : '')
          try {
            await post('/remember', { text, kind: 'preference', chat_id: 'system', scope: 'public', tags: ['interest', '兴趣'], importance: 0.5, source: 'learn:interest', meta: { topic: t, from: String(from || '') } })
            return '记下这个兴趣了：' + t
          } catch (e) { return '没记上：' + e.message }
        },
      }
    }, '记兴趣')

    api.rule(() => '你会在刷抖音/B站的时候自己学到东西；学到值得留的一句就调 learn_note 记下来，以后能想起来。看到让你上头、想自己试试的东西就调 note_interest 记个兴趣；真想动手玩，可以在 plugins-data/dafeiyu/playground/<名字>/index.mjs 自己写个小模块（照 modules/API.md 的写法），那里随便折腾，不会碰到正经功能。')
  },
}
