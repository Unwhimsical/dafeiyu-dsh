// 扩展模块「bio」——把 memory-core 的生物层接进大肥鱼的身体。
//
// 记忆大脑 v2（127.0.0.1:8780 的 /bio/state）现在只给「激素 · 身体」读数（多巴胺/催产素/皮质醇/血清素等）和味蕾记忆。
// 情绪不归这里管：以记忆星海的 10 维情绪为准（旧的「情绪五维」、内稳态、生命值都已经没有了）。
//
// 这个模块负责三件事：
//   1. 每轮把「身体状态」注入 prompt，让她说话带身体感；
//   2. 把 QQ / 抖音里的对话情绪当成事件喂回去（被夸 / 被凶 / 被逗 → 交给大脑 v2 自己算激素）；
//   3. 提供 bio_status / bio_taste / bio_taste_recall 三个工具。
//
// 所有数据都在 memory-core 的 sqlite 里，面板「生理 · 脑区」能直接看见。

const DEFAULTS = {
  enabled: true,
  memoryUrl: 'http://127.0.0.1:8780',
  memoryToken: '',
  injectEveryTurn: true,
  cacheSeconds: 60,
  reportChat: true,
}

const PRAISE = /(乖|好棒|真棒|厉害|可爱|漂亮|喜欢你|爱你|辛苦了|聪明|贴心|做得很好|真好)/

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

function fmt(n) {
  return (Math.round(Number(n || 0) * 100) / 100).toFixed(2)
}

export default {
  id: 'bio',
  name: '身体 · 情绪激素',
  version: '1.0.0',
  api: 1,
  description: '激素 · 身体（来自大脑 v2）和味蕾记忆；每轮把身体感觉喂给大肥鱼。情绪以星图 10 维为准',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'injectEveryTurn', label: '每轮注入身体状态', type: 'switch', hint: '关掉就只剩工具能查' },
    { key: 'memoryUrl', label: 'memory-core 地址', type: 'text' },
    { key: 'memoryToken', label: 'memory-core 令牌', type: 'text' },
    { key: 'cacheSeconds', label: '状态缓存秒数', type: 'number', hint: '默认 60' },
    { key: 'reportChat', label: '把聊天算成情绪事件', type: 'switch' },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    let cache = { at: 0, data: null }

    // 本机端口被占满（TIME_WAIT 太多）或大脑刚重启时，fetch 会偶发 EADDRINUSE / ECONNRESET（日志里只显示 fetch failed）：短暂错误重试两次
    const TRANSIENT = /EADDRINUSE|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT/i
    async function call(path, init) {
      const k = cfg()
      let res, lastErr
      for (let i = 0; i < 3; i++) {
        try {
          res = await fetch(String(k.memoryUrl).replace(/\/+$/, '') + path, {
            ...init,
            headers: {
              Authorization: 'Bearer ' + k.memoryToken,
              'Content-Type': 'application/json; charset=utf-8',
              ...(init && init.headers ? init.headers : {}),
            },
            signal: AbortSignal.timeout(8000),
          })
          break
        } catch (e) {
          lastErr = e
          const code = String((e && e.cause && e.cause.code) || (e && e.code) || '')
          if (!TRANSIENT.test(code) || i === 2) {
            if (code) e.message = e.message + '（' + code + '）'
            throw e
          }
          await new Promise((r) => setTimeout(r, 400 * (i + 1)))
        }
      }
      if (!res) throw lastErr || new Error('memory-core 没响应')
      const j = await res.json().catch(() => ({}))
      // v2 回 { ok: true, id }，旧 v1 回 { status: 'ok', data }：HTTP 成功且没明说失败就算成功（以前把 v2 的 200 当成失败）
      if (!res.ok || j.ok === false || j.status === 'error') throw new Error(j.message || j.error || ('memory-core 返回 ' + res.status))
      return j.data !== undefined ? j.data : j
    }

    async function status(force) {
      const k = cfg()
      if (!force && cache.data && Date.now() - cache.at < Math.max(10, Number(k.cacheSeconds) || 60) * 1000) return cache.data
      const data = await call('/bio/state')
      cache = { at: Date.now(), data }
      try { publish() } catch {}
      // 发布身体状态（只给激素数值），群聊插话按身体走（dsh-aurabot-qq chat/group-policy.readDrive）
      try {
        const h = (data && (data.hormones || data.state)) || {}
        const lv = (x) => (x && typeof x === 'object' ? (x.level ?? x.value) : x)
        globalThis.__dfyBody = { at: Date.now(), hormones: Object.fromEntries(Object.entries(h).filter(([, v]) => Number.isFinite(Number(lv(v)))).map(([n, v]) => [n, Number(lv(v))])) }
      } catch {}
      return data
    }

    let reportFails = 0
    let reportWarnAt = 0
    async function report(events) {
      try {
        await call('/bio/event', { method: 'POST', body: JSON.stringify({ events }) })
        cache.at = 0
        if (reportFails) api.log.info('身体事件又能送出去了（之前失败 ' + reportFails + ' 次）')
        reportFails = 0
      } catch (e) {
        reportFails++
        // 重试过还失败才记；10 分钟最多 warn 一次，别刷屏
        if (Date.now() - reportWarnAt > 600_000) { reportWarnAt = Date.now(); api.log.warn('身体事件没送出去（已重试，累计 ' + reportFails + ' 次）：' + e.message) }
      }
    }

    function describe(d) {
      // v2 /bio/state：{ hormones: { 名: 数 或 { level } }, line? }；旧 v1 的 emotions/homeostasis/health 已经没有了
      if (!d || typeof d !== 'object') return '说不清'
      if (d.line) return String(d.line)
      const lv = (x) => (x && typeof x === 'object' ? (x.level ?? x.value) : x)
      const h = d.hormones || d.state || {}
      const parts = Object.entries(h).filter(([, v]) => Number.isFinite(Number(lv(v)))).slice(0, 6).map(([k, v]) => k + ' ' + fmt(Number(lv(v))))
      return parts.join('，') || '说不清'
    }

    // —— 情绪事件：从话里读，不瞎猜 ——
    if (cfg().reportChat) {
      api.on('activity', (info) => {
        try {
          const text = String((info && info.text) || '')
          const g = globalThis.__DFY_ADULT_GATE__
          // 对暗号的那几句不算身体事件（不加不减）
          const mine = info && info.kind === 'in' && !(g && g.isCodeTurn && g.isCodeTurn(String(info.chatId || ''), text))
          const events = []
          if (mine && text) {
            events.push({ kind: 'chat', amount: 0.6 })
            if (PRAISE.test(text)) events.push({ kind: 'praise', amount: 0.8 })
            if (/(滚|闭嘴|烦|笨|蠢|讨厌|不许|别说话)/.test(text)) events.push({ kind: 'scold', amount: 0.7 })
            if (/(羞|脸红|可爱|抱抱|亲)/.test(text)) events.push({ kind: 'tease', amount: 0.6 })
          }
          if (events.length) report(events)
        } catch {}
      })
    }

    // —— 每轮注入身体状态 ——
    // 情绪单一来源：bio 不再自己往提示词里塞一行，只把身体读数发布出去，
    // 由心情模块（星图 10 维）合成每轮唯一的一行「说话状态 / 身体」。激素由大脑 v2 算，这里不存状态。
    function publish() {
      try {
        if (!cfg().enabled || !cfg().injectEveryTurn || !cache.data) { globalThis.__dfyBodyLine = null; return }
        globalThis.__dfyBodyLine = { line: describe(cache.data), at: Date.now() }
      } catch {}
    }
    api.on('prompt', (content) => { publish(); return content })

    // 旧的 syncMood（单维心情 → 脑内）已删，单维心情停用
    api.every(120_000, () => { status(true).catch(() => {}) }, 'bio-refresh')
    api.later(6000, () => { status(true).then((d) => api.log.info('身体状态：' + describe(d))).catch((e) => api.log.warn('身体状态读不到：' + e.message)) })

    api.tool(({ chat }) => {
      if (!cfg().enabled) return null
      return toolDef({
        name: 'bio_status',
        description: '看看自己现在的身体感觉（激素读数，来自记忆大脑）。情绪不在这里，以记忆星海的 10 维为准。',
        properties: {},
        async execute() {
          const d = await status(true)
          return { ok: true, message: '身体：' + describe(d) }
        },
      })
    })

    api.tool(({ chat }) => {
      if (!cfg().enabled || !cfg().legacyTaste) return null // v2 没有 /bio/taste，默认不挂；接了旧 v1 才开 legacyTaste
      return toolDef({
        name: 'bio_taste',
        description: '记住一种吃的味道（吃过什么、喜不喜欢）。喜欢就给 0.8~0.95，讨厌给 0.05~0.2。',
        properties: {
          food: { type: 'string', description: '吃的东西' },
          like: { type: 'number', description: '喜欢程度 0~1' },
          note: { type: 'string', description: '一句评价' },
        },
        required: ['food'],
        async execute({ food, like, note }) {
          const d = await call('/bio/taste', {
            method: 'POST',
            body: JSON.stringify({ food, like: like == null ? 0.6 : like, note: note || '' }),
          })
          cache.at = 0
          return { ok: true, message: '记住了：' + d.food + ' ' + fmt(d.like) + ' 分' }
        },
      })
    })

    api.tool(({ chat }) => {
      if (!cfg().enabled || !cfg().legacyTaste) return null // v2 没有 /bio/taste，默认不挂；接了旧 v1 才开 legacyTaste
      return toolDef({
        name: 'bio_taste_recall',
        description: '想想自己吃过的味道：可以按名字查，不传就列最喜欢的几种。',
        properties: { q: { type: 'string', description: '食物名字，可空' } },
        async execute({ q }) {
          const d = await call('/bio/taste?q=' + encodeURIComponent(String(q || '')))
          if (!d.items.length) return { ok: true, message: '还没记下什么口味' }
          return { ok: true, message: '味道：' + d.items.map((x) => x.food + ' ' + fmt(x.like) + (x.note ? '（' + x.note + '）' : '')).join('；') }
        },
      })
    })

    api.rule((kind) =>
      '拿不准自己身体感觉就调 bio_status；吃到/聊到吃的东西，值得记就用 bio_taste。'
    )
  },
}
