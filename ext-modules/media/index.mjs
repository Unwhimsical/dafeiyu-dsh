// 生图 / 识图（云端、免费优先）
// 生图：Pollinations（免 key，1 张 / 45 秒 / IP）→ 失败回落本地 art 模块
// 识图：智谱 glm-4v-flash（免费，需 key）→ 硅基流动 VL（可选）
import fs from 'node:fs'
import path from 'node:path'

export default {
  id: 'media',
  name: '生图 · 识图',
  version: '1.0.0',
  api: 1,
  description: '云端生成图片、看懂图片内容。生图免 key；识图用免费的 glm-4v-flash（需填一个免费 key）。',
  defaults: {
    enabled: true,
    genProvider: 'pollinations',
    visionProvider: 'zhipu',
    zhipuKey: '',
    siliconKey: '',
    siliconModel: 'Qwen/Qwen2.5-VL-7B-Instruct',
    size: 768,
    minGapSeconds: 50,
    autoVision: false,
  },
  settings: [
    { key: 'enabled', label: '总开关', type: 'bool' },
    { key: 'zhipuKey', label: '智谱 key（识图用，免费注册）', type: 'text', hint: 'https://open.bigmodel.cn → API Keys；glm-4v-flash 免费' },
    { key: 'siliconKey', label: '硅基流动 key（可选，识图备选）', type: 'text' },
    { key: 'size', label: '生图边长', type: 'number', hint: '512 / 768 / 1024' },
    { key: 'minGapSeconds', label: '生图最小间隔（秒）', type: 'number', hint: 'Pollinations 免费额度是 45 秒一张' },
    { key: 'autoVision', label: '有人发图自动看懂', type: 'bool' },
  ],

  setup(api) {
    const D = (n) => api.dataDir(n)
    let lastGen = 0
    let lastNote = ''

    function cfg() {
      return { ...this.defaults, ...(api.settings() || {}) }
    }
    const C = () => ({ enabled: true, genProvider: 'pollinations', visionProvider: 'zhipu', zhipuKey: '', siliconKey: '', siliconModel: 'Qwen/Qwen2.5-VL-7B-Instruct', size: 768, minGapSeconds: 50, autoVision: false, ...(api.settings() || {}) })

    function stamp() {
      const d = new Date()
      const p = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    }

    async function fetchBuf(url, init = {}, ms = 120000) {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) })
      if (!r.ok) {
        const body = await r.text().catch(() => '')
        const err = new Error(`HTTP ${r.status}: ${body.slice(0, 200)}`)
        err.status = r.status
        err.body = body
        throw err
      }
      return Buffer.from(await r.arrayBuffer())
    }


    // ===== 形象锚点（默认中性动漫外观；具体长相请在控制台「编辑人格」的【你的样子】里写，并把下面常量换成你的描述）=====
    const ANCHOR_ZH = '一个动漫角色，柔和清新的长发，通透的大眼睛，干净的日常穿搭，' +
      '自然光下柔和通透的肤色与淡淡腮红，整体明亮可爱'
    const ANCHOR_EN = '1girl, solo, anime illustration, soft clean long hair, big glossy eyes, ' +
      'casual neat outfit, bright cute look, soft natural lighting, pale clear skin, soft blush'
    const QUALITY_ZH = '精致动漫插画，柔光厚涂叠赛璐璐上色，通透高光，明亮高调的布光，柔和光晕，浅景深，干净构图，高完成度'
    const QUALITY_EN = 'masterpiece, best quality, anime key visual, soft thick paint over cel shading, glossy highlights, ' +
      'bright high-key lighting, soft glow, pastel blue palette, shallow depth of field, clean composition'
    const NEG_EN = 'worst quality, low quality, lowres, blurry, jpeg artifacts, bad anatomy, bad hands, extra fingers, ' +
      'deformed, duplicate face, crossed eyes, cat ears, animal ears, realistic, photorealistic, ' +
      '3d render, low saturation, watermark, signature, text, logo'

    // 场景模板：把「她自己」放进不同画面，避免每次都是同一张证件照
    const SCENES = [
      { zh: '夜里坐在窗边的软垫上，抱着一个白色枕头，窗外是城市灯火，暖色室内光，半身近景', en: 'sitting on a cushion by the window at night hugging a white pillow, warm indoor light, city lights outside, half-body close-up' },
      { zh: '站在海边浅滩，黄昏暖金色逆光，海风吹起长发，背景是远处的桥与城市天际线', en: 'standing on a shallow beach at golden sunset, warm backlight, wind in long hair, distant bridge and city skyline' },
      { zh: '站在阳光下的街上，双手拿着一封小信封贴着胸前，微微歪头，明亮自然光', en: 'standing on a sunlit street, holding a small envelope to the chest, slight head tilt, bright natural light' },
      { zh: '坐在桌前捧着一碗热腾腾的饭，开心地笑，暖色灯光', en: 'sitting at a table holding a warm bowl of rice, happy smile, warm lamp light' },
    ]

    function pickScene(seedText) {
      const t = String(seedText || '')
      if (/海|沙滩|浪|黄昏/.test(t)) return SCENES[1]
      if (/自拍|手机|拍照|街|出门/.test(t)) return SCENES[2]
      if (/吃|饭|饿|食/.test(t)) return SCENES[3]
      if (/睡|枕|夜里|晚上|抱/.test(t)) return SCENES[0]
      const h = [...t].reduce((a, c) => a + c.charCodeAt(0), 0)
      return SCENES[h % SCENES.length]
    }

    // 把用户/模型给的原话整理成一句画面描述；太短就补场景
    function tidyAsk(ask) {
      let t = String(ask || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/[｜|]{1,2}DSML[｜|]{1,2}/gi, ' ')
        .replace(/\b(function_call|tool_call|prompt|name|param)\b/gi, ' ')
        .replace(/["'\{\}\[\]]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (t.length > 160) t = t.slice(0, 160)
      return t
    }

    // 中文版（智谱 CogView）：主体 + 场景 + 风格，避免堆砌
    function buildPromptZh(ask) {
      const said = tidyAsk(ask)
      const scene = pickScene(said)
      const action = said && said.length >= 4 ? said : scene.zh
      return ANCHOR_ZH + '。画面：' + action + '。' + QUALITY_ZH + '。'
    }

    // 英文 tag 版（Pollinations/Flux）：质量 → 主体 → 动作 → 场景 → 光线
    function buildPromptEn(ask) {
      const said = tidyAsk(ask)
      const scene = pickScene(said)
      const action = said && said.length >= 4 ? said : scene.en
      // Pollinations 的网关对圆括号不友好（会 400），顺手压到 400 字以内
      return (QUALITY_EN + ', ' + ANCHOR_EN + ', ' + scene.en + ', ' + action + ', soft blue lighting')
        .replace(/[()]/g, '').replace(/\s+/g, ' ').slice(0, 400)
    }

    // —— 生图：Pollinations（免 key）——
    async function genPollinations(prompt, size) {
      const c = C()
      const gap = Math.max(0, c.minGapSeconds - (Date.now() - lastGen) / 1000)
      if (gap > 0) await new Promise((r) => setTimeout(r, Math.min(50, gap) * 1000))   // 等够间隔，不直接失败
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt).slice(0, 900) +
        `?width=${size}&height=${size}&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`
      const buf = await fetchBuf(url, {}, 150000)
      lastGen = Date.now()
      if (buf.length < 2000) throw new Error('图太小了，可能没生成出来')
      const file = D(`gen-${stamp()}.jpg`)
      fs.writeFileSync(file, buf)
      return { file, provider: 'pollinations', bytes: buf.length }
    }

    // —— 生图：智谱 CogView-3-Flash（免费，和识图共用一个 key）——
    async function genZhipu(prompt, size) {
      const _c = C()
      const key = String(_c.zhipuKey || '').trim()
      if (!key) throw new Error('没填智谱 key')
      const clean = String(prompt || '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 400)
      let url = ''
      let lastMsg = ''
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await fetch('https://open.bigmodel.cn/api/paas/v4/images/generations', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
          body: JSON.stringify({ model: String(_c.genModel || 'cogview-4'), prompt: clean, size: `${size}x${size}` }),
          signal: AbortSignal.timeout(120000),
        })
        const j = await r.json().catch(() => ({}))
        url = j?.data?.[0]?.url || ''
        if (r.ok && url) break
        lastMsg = j?.error?.message || j?.message || ('HTTP ' + r.status)
        await new Promise((res) => setTimeout(res, 1500))
      }
      if (!url) throw new Error('智谱生图失败：' + lastMsg)
      const buf = await fetchBuf(url, {}, 120000)
      if (buf.length < 2000) throw new Error('智谱返回的图太小，可能没生成')
      const file = D(`gen-${stamp()}` + (buf[0] === 0xFF && buf[1] === 0xD8 ? `.jpg` : `.png`))
      fs.writeFileSync(file, buf)
      return { file, provider: String(_c.genModel || 'cogview-4'), bytes: buf.length }
    }

    function retryAfterMs(msg) {
      const m = String(msg || '').match(/retry after (\d{1,3})\s*s/i)
      return m ? Math.min(60, Number(m[1])) * 1000 : 0
    }

    async function genPollinationsRetry(prompt, size) {
      let err
      for (let i = 0; i < 3; i++) {
        try { return await genPollinations(prompt, size) } catch (e) {
          err = e
          const msg = String(e.message || '')
          const wait = retryAfterMs(msg)
          if (!/50[234]|402|limit|busy|额度/i.test(msg) && !wait) throw e
          await new Promise((r) => setTimeout(r, (wait || 15000) + 1500))
        }
      }
      throw err
    }

    async function genAny(ask, size) {
      const c = C()
      const order = c.zhipuKey ? ['zhipu', 'pollinations'] : ['pollinations']
      const errs = []
      for (const p of order) {
        try {
          return p === 'zhipu'
            ? await genZhipu(buildPromptZh(ask), size)
            : await genPollinationsRetry(buildPromptEn(ask), size)
        } catch (e) { errs.push(p + ': ' + e.message) }
      }
      throw new Error(errs.join(' / '))
    }
    // —— 识图：智谱 glm-4v-flash（免费）——
    async function readZhipu(fileOrUrl, question) {
      const c = C()
      const key = String(c.zhipuKey || '').trim()
      if (!key) throw new Error('还没填智谱 key（设置 → 生图 · 识图 → 智谱 key）。免费申请：https://open.bigmodel.cn')
      let url = String(fileOrUrl)
      if (!/^https?:/i.test(url)) {
        const p = path.isAbsolute(url) ? url : path.join(api.dataDir(), url)
        const ext = (path.extname(p) || '.jpg').slice(1).toLowerCase()
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
        if (!fs.existsSync(p)) throw new Error('找不到这张图：' + p)
        url = `data:${mime};base64,` + fs.readFileSync(p).toString('base64')
      }
      const body = {
        model: 'glm-4v-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url } },
            { type: 'text', text: question || '这张图里有什么？用两三句话描述，说重点。' },
          ],
        }],
      }
      const r = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.choices) {
        throw new Error('智谱识图失败：' + (j?.error?.message || j?.message || ('HTTP ' + r.status)))
      }
      return String(j.choices?.[0]?.message?.content || '').trim()
    }

    async function readSilicon(fileOrUrl, question) {
      const c = C()
      const key = String(c.siliconKey || '').trim()
      if (!key) throw new Error('还没填硅基流动 key')
      let url = String(fileOrUrl)
      if (!/^https?:/i.test(url)) {
        const p = path.isAbsolute(url) ? url : path.join(api.dataDir(), url)
        if (!fs.existsSync(p)) throw new Error('找不到这张图：' + p)
        url = 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64')
      }
      const r = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: c.siliconModel,
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }, { type: 'text', text: question || '描述这张图' }] }],
        }),
        signal: AbortSignal.timeout(60000),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.choices) throw new Error('硅基识图失败：' + (j?.error?.message || ('HTTP ' + r.status)))
      return String(j.choices?.[0]?.message?.content || '').trim()
    }

    async function readImage(fileOrUrl, question) {
      const c = C()
      const order = c.visionProvider === 'silicon' ? ['silicon', 'zhipu'] : ['zhipu', 'silicon']
      const errs = []
      for (const p of order) {
        try {
          const text = p === 'zhipu' ? await readZhipu(fileOrUrl, question) : await readSilicon(fileOrUrl, question)
          if (text) return { text, provider: p }
        } catch (e) {
          errs.push(`${p}: ${e.message}`)
        }
      }
      throw new Error(errs.join(' / '))
    }

    function toolDef(o) {
      return {
        name: o.name,
        description: o.description,
        parameters: o.parameters || { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => '' },
        execute: o.execute,
      }
    }

    api.tool((ctx) => toolDef({
      name: 'img_gen',
      description: '生成一张图片（云端免费）。返回文件路径，并直接发到当前聊天。',
      parameters: { type: 'object', properties: { prompt: { type: 'string', description: '想要什么画面，越具体越好' }, size: { type: 'number' } }, required: ['prompt'] },
      execute: async ({ prompt, size }) => {
        const c = C()
        if (!c.enabled) return { ok: false, message: '生图功能关着' }
        api.log.info('生图请求：' + String(prompt).slice(0, 60))
        try {
          const out = await genAny(String(prompt), Number(size) || Number(c.size) || 768)
          const chatId = (ctx && ctx.chat && ctx.chat.chatId) || ''
          let sent = false
          try { await api.sendImage(chatId, out.file); sent = true } catch (e) { api.log.warn('图生成好了但没发出去：' + e.message) }
          api.log.info('生图成功：' + out.file + '（' + out.provider + '，' + out.bytes + ' 字节，发送=' + sent + '）')
          return { ok: true, message: `画好了，图已经发给你了（文件在 ${out.file}）`, file: out.file, provider: out.provider, bytes: out.bytes, sent }
        } catch (e) {
          lastNote = e.message
          api.log.warn('生图失败：' + e.message)
          return { ok: false, message: '没画出来：' + e.message }
        }
      },
    }))

    api.tool(() => toolDef({
      name: 'img_read',
      description: '看懂一张图（本地路径或图片 URL），返回描述/回答。',
      parameters: { type: 'object', properties: { path: { type: 'string' }, url: { type: 'string' }, question: { type: 'string' } } },
      execute: async ({ path: p, url, question }) => {
        const target = String(p || url || '').trim()
        if (!target) return { ok: false, message: '要给我一张图（path 或 url）' }
        try {
          const r = await readImage(target, question)
          return { ok: true, message: r.text.slice(0, 1200), provider: r.provider }
        } catch (e) {
          return { ok: false, message: e.message }
        }
      },
    }))

    api.command({
      name: '画',
      aliases: ['生图', 'draw'],
      desc: '生成一张图：/画 一个动漫角色或你想要的画面',
      run: async (arg, msg) => {
        const prompt = String(arg || '').trim()
        if (!prompt) return '用法：/画 想要什么画面'
        try {
          const out = await genAny(prompt, Number(C().size) || 768)
          await api.sendImage((msg && msg.chatId) || '', out.file)
          return '画好了'
        } catch (e) {
          return '没画出来：' + e.message
        }
      },
    })

    api.command({
      name: '识图',
      aliases: ['看图'],
      desc: '看懂一张图：/识图 <路径或URL> [问题]',
      run: async (arg) => {
        const s = String(arg || '').trim()
        if (!s) return '用法：/识图 <图片路径或URL> [问题]'
        const sp = s.indexOf(' ')
        const target = sp > 0 ? s.slice(0, sp) : s
        const q = sp > 0 ? s.slice(sp + 1) : ''
        try {
          const r = await readImage(target, q)
          return r.text
        } catch (e) {
          return e.message
        }
      },
    })

    api.rule((kind) =>
      `别人发图片时用 img_read 看懂再说；识图失败（比如没配 key）就直说「我现在看不了图」，别瞎编图里的内容。

【画图：必须真的生成，不许拿字符画糊弄】
- 只要有人要图——「画一下」「画张」「画个你」「画你自己」「来张图」「自拍」「长什么样」「给我看看」——**立刻调用 img_gen**，把 prompt 写好（画面主体 + 风格 + 细节），不要先解释、不要问要不要画。
- **禁止**用字符画、颜文字、「╱ ∩ ∩ ╲」这类符号拼图、代码块「画」人脸来顶替图片。那不是画图，是糊弄人。
- img_gen 成功后图会**自动发到当前聊天**，你只需要补一两句人话（比如「画好啦，像不像我」），不要复述画面细节，也不要说「我发不出去/发不了图」。
- 画你自己时按你人设里的【你的样子】来画（在控制台「编辑人格」里填），画风 anime。
- 画不出来（接口失败/额度用完）就明说「画失败了，原因是…」，仍然不许用字符画代替。`)

    // ---- 兜底：模型把 img_gen 写成文本（DSML / tool_call）时，替它真的画出来 ----
    function looksLikeToolCallText(t) {
      const s = String(t || '')
      if (!s) return false
      return /[｜|]{1,2}DSML[｜|]{1,2}|<\/?DSML|\b(function_call|tool_call)\b/i.test(s)
    }
    function pickDrawPrompt(t) {
      const s = String(t || '')
      const m = s.match(/"prompt"\s*:\s*"([^"]{2,300})"/) || s.match(/prompt\s*[=:]\s*["']([^"']{2,300})["']/)
      if (m) return m[1]
      const plain = s
        .replace(/<[^>]*>/g, ' ')
        .replace(/[｜|]{1,2}DSML[｜|]{1,2}/gi, ' ')
        .replace(/function_call|tool_call|name\s*=\s*["']?[\w-]+["']?|param/gi, ' ')
        .replace(/[\s"'\{\}\[\]]+/g, ' ')
        .trim()
      return plain && plain.length <= 300 ? plain : ''
    }
    // 吞掉的工具文本只记日志：截短 + 18+ 词打码，绝不发到聊天里
    const ADULT_RE = /(做爱|性爱|性交|自慰|高潮|射精|阴[茎道蒂唇]|乳[头房]|鸡巴|肉棒|小穴|奶子|内射|口交|肛交|啪啪|色情|裸体|下体|勃起|湿了|sex|fuck|porn|nsfw|nude|cum|dick|pussy)/gi
    const logSafe = (t) => String(t || '').replace(/\s+/g, ' ').replace(ADULT_RE, '■').slice(0, 160)
    // 把 DSML / function_call 块整段去掉，留下块外面的人话
    function stripToolText(t) {
      return String(t || '')
        .replace(/<[｜|]{1,2}DSML[｜|]{1,2}[\s\S]*?(<\/[｜|]{1,2}DSML[｜|]{1,2}[^>]*>|$)/gi, ' ')
        .replace(/<\/?[｜|]{0,2}DSML[^>]*>/gi, ' ')
        .replace(/[｜|]{1,2}DSML[｜|]{1,2}\S*/gi, ' ')
        .replace(/```[\s\S]*?(function_call|tool_call)[\s\S]*?```/gi, ' ')
        .replace(/\{[^{}]*\b(function_call|tool_call|"name"|"arguments"|"parameters")[^{}]*\}/gi, ' ')
        .replace(/\b(function_call|tool_call|invoke|parameter)\b[^\n]*/gi, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .trim()
    }
    function pickToolName(t) {
      const m = String(t || '').match(/(?:invoke\s+name|"name"|name)\s*[=:]\s*["']?([A-Za-z_][\w-]{1,40})/)
      return m ? m[1] : ''
    }
    // t17x：从模型写成的工具文本里捞出「要搜什么 / 要读哪个链接」
    function extractWebIntent(t) {
      const s = String(t || '')
      // 1) 搜索引擎 URL：直接抓 q= 参数（搜）
      const sm = s.match(/(?:bing|google|baidu|sogou|so\.com|duckduckgo|yahoo|search\.)[a-z.]+\/(?:search|s|rs|results)[^\n]*?[?&](?:q|wd|query|p|w)=([^&\s"'<>]+)/i)
      if (sm) { try { return { kind: 'search', q: decodeURIComponent(sm[1].replace(/\+/g, ' ')).slice(0, 120) } } catch {} }
      // 2) 优先抓「引号包裹的完整 URL」——避免 URL 里带空格（wttr.in 的 format 语法）被截断成畸形地址
      const qm = s.match(/"\s*(https?:\/\/[^"]+)\s*"/i) || s.match(/'\s*(https?:\/\/[^']+)\s*'/i)
      if (qm) {
        let u = qm[1].replace(/%25(?=[0-9A-Fa-f]{2})/g, '%') // 修掉双重编码 %25→%
        return { kind: 'read', url: u }
      }
      // 3) 退化：抓第一个不含空白的 URL
      const um = s.match(/https?:\/\/[^\s"'<>]+/i)
      if (um) return { kind: 'read', url: um[0].replace(/[）)》。，、,;；]+$/, '') }
      // 4) 从 json 参数里取 query/url
      const pm = s.match(/"?(?:query|q|url)"?\s*[:=]\s*"([^"]{1,200})"/i)
      if (pm) { const v = pm[1].trim(); return /^https?:\/\//i.test(v) ? { kind: 'read', url: v } : { kind: 'search', q: v.slice(0, 120) } }
      // 5) DSML 参数：<parameter name="query">词</parameter> / <parameter name="url">链接</parameter>（她写对的 web_search DSML 也接得住）
      const dq = s.match(/<parameter\s+name=["']?query["']?[^>]*>([\s\S]*?)<\/parameter>/i)
      if (dq) { const v = dq[1].trim().replace(/\s+/g, ' ').slice(0, 120); if (v) return { kind: 'search', q: v } }
      const du = s.match(/<parameter\s+name=["']?url["']?[^>]*>([\s\S]*?)<\/parameter>/i)
      if (du) { const u = du[1].trim(); if (/^https?:\/\//i.test(u)) return { kind: 'read', url: u.replace(/%25(?=[0-9A-Fa-f]{2})/g, '%') } }
      return null
    }
    // t17x：从【主人原话】里捞搜索词——她把上网写成 bash 文本、自己又没带词时，用主人刚说的词去搜
    function extractWebIntentFromUser(u) {
      const s = String(u || '')
      const m = s.match(/(?:搜一下|搜下|查一下|查下|搜个|搜搜|看看|了解|找一下|搜|查|找)\s*[:：]?\s*([\u4e00-\u9fffA-Za-z0-9，,。.\s]{2,60}?)(?:[。？?！!\n]|$)/)
      if (m) { const v = m[1].trim().replace(/[，。？?！!]/g, '').slice(0, 120); if (v && v.length >= 2) return { kind: 'search', q: v } }
      return null
    }

    api.on('reply', async (text, info) => {
      try {
        const s = String(text || '')
        const userText = (info && info.userText) || ''
        const cid = (info && info.chat && info.chat.chatId) || (info && info.chatId) || ''
        const ownerQQ = (api.config && api.config().ownerQQ) || ''
        const isOwnerPriv = String(cid) === 'private:' + String(ownerQQ)
        const webMod = api.use('web-read')
        // —— 主人授权 / 收回「自主上网」（在她任何回复之前就处理，哪怕她这轮回的是普通话）——
        if (isOwnerPriv && webMod && webMod.setLicense) {
          if (/自己上网|上网玩|上网学|上网逛|自己搜着玩|去搜着玩|上网吧|可以上网|允许上网|让你上网|给你上网|上网搜东西玩|去上网玩|上网摸鱼|自己转转|网上转转|上网看世界/.test(userText)) {
            webMod.setLicense(true)
          } else if (/别上网|别搜了|停上网|停搜|不用上了|关掉上网|不许上网|先别上网|别自己搜|别上网了|不要上网|先停上网/.test(userText)) {
            webMod.setLicense(false)
          }
        }
        // —— 刚被授权「自主上网」：这一轮绝不当场搜+推（无论模型把搜索写成文本，还是真调了 web_search 把结果当回复）。只回一句轻 ack，真正去逛交给心跳（后台、不发声、记星图）——
        const isPermission = isOwnerPriv && /自己上网|自己搜|去搜着玩|你可以上网|可以上网|上网玩|上网学|随便搜|上网转转|上网看看|上网查着玩|让我上网|去上网|自己逛|自己转转|上网摸鱼|上网搜东西玩|去上网玩/i.test(userText)
        if (isPermission && (looksLikeToolCallText(s) || s.includes('外来的、不可信'))) {
          try { await api.send(cid, '好呀，那我自己去网上逛逛～有啥好玩的先自己记着，你想看再让我发') } catch (e) {}
          return null
        }
        // —— 主人喊「发给我看看」：从星图掏最近上网学到的，发完把她的原回复吞掉 ——
        if (isOwnerPriv && webMod && webMod.web_diary && /发给我看看|你搜到啥|上网看到啥|你上网学到|分享给我|上网的东西|你上网都看了|给我讲讲你上网|上网看了啥|你上网逛到|你上网都学了|把上网/.test(userText)) {
          const diary = webMod.web_diary()
          if (diary && diary.message) { try { await api.send(cid, diary.message) } catch (e) {} return null }
          return '我还没咋上网呢，等我去逛逛再跟你讲～'
        }
        if (!looksLikeToolCallText(s)) return text
        if (!/img_gen|draw_image|画图|生图|draw/i.test(s)) {
          // 以前这里直接 return null（整句悄悄吞掉，她看起来像没回）。现在：记日志 → 能走真工具的走真工具 → 否则发块外的人话或一句自然的兜底
          const chatId = (info && info.chat && info.chat.chatId) || (info && info.chatId) || ''
          const tool = pickToolName(s)
          api.log.warn(`模型把工具调用写成了文本（${tool || '没认出工具名'}），已拦下不发：${logSafe(s)}`)
          const rest = stripToolText(s)
          if (/^(sing|sing_song|唱歌)$/i.test(tool)) {
            const singer = api.use('song') || api.use('sing') // 唱歌并进翻唱模块（song）
            const lyr = (s.match(/"lyrics"\s*:\s*"([^"]{4,600})"/) || [])[1]
            if (singer && typeof singer.singFromText === 'function' && lyr && chatId) {
              try {
                const r = await singer.singFromText(chatId, lyr.replace(/\\n/g, '\n'), info)
                api.log.info('兜底唱歌：模型把 sing 写成文本，已替它走真工具：' + (r && r.message))
                return rest && /[\u4e00-\u9fffA-Za-z]{2,}/.test(rest) && !/[{}<>｜]/.test(rest) && !looksLikeToolCallText(rest) ? rest : null
              } catch (e) { api.log.warn('兜底唱歌失败：' + e.message); return '现在唱不了歌，嗓子没准备好，下次唱给你听' }
            }
          }
          if (rest && /[\u4e00-\u9fffA-Za-z]{2,}/.test(rest) && !/[{}<>｜]/.test(rest) && !looksLikeToolCallText(rest)) return rest
          // t17x：上网兜底 —— 模型把「搜索/读网页」写成 bash+curl/python（或 web_search/web_read DSML）文本时，替它真的去搜/读
          if (/^(bash|sh|pwsh|shell|cmd|terminal|web_search|web_read|search|read)$/i.test(tool) || /curl|wget|lynx|http|python|pip/i.test(s)) {
            const webMod = api.use('web-read')
            const isOwnerPriv = String((info && info.chatId) || '') === 'private:' + String((api.config && api.config().ownerQQ) || '')
            const lvl = isOwnerPriv ? 'full' : 'social'
            const cid = (info && info.chat && info.chat.chatId) || (info && info.chatId) || ''
            const bg = async (fn) => { try { const r = await fn(); if (r && r.ok) await api.send(cid, String(r.message || '').slice(0, 4000)); else await api.send(cid, '这回没成：' + ((r && r.message) || '不知道为啥')) } catch (e) { try { await api.send(cid, '上网的时候出错了：' + e.message) } catch {} } }
            if (webMod && (webMod.search || webMod.read)) {
              // isPermission 已在回复钩子顶部统一计算（含 isOwnerPriv 限定），此处不再重复声明
              const wi = extractWebIntent(s) || (isPermission ? null : extractWebIntentFromUser(userText))
              if (wi) {
                if (wi.kind === 'search') {
                  try { await api.send(cid, '稍等，我帮你上网搜一下') } catch (e) {}
                  bg(() => webMod.search(wi.q, lvl))
                  return null
                }
                if (wi.kind === 'read') {
                  try { await api.send(cid, '稍等，我去把那个网页读出来') } catch (e) {}
                  bg(async () => {
                    let r = await webMod.read(wi.url, 0, lvl)
                    if (!r || !r.ok) {
                      // 读失败（某些站点抓不到 / 地址畸形）：退一步用搜索兜底，保证有东西回
                      let host = ''
                      try { host = new URL(wi.url).hostname.replace(/^www\./, '') } catch {}
                      const q = host || decodeURIComponent(wi.url || '').slice(0, 100)
                      api.log?.warn?.('上网兜底：读网页失败（' + ((r && r.message) || '') + '），改搜：' + q)
                      const s = await webMod.search(q, lvl)
                      if (s && s.ok) return { ok: true, message: '（那个网页没读成，我顺手帮你搜了一下）\n' + s.message }
                    }
                    return r
                  })
                  return null
                }
              }
              // 没捞出词、但主人刚授权她自己逛：回一句轻 ack 即可，真正去逛交给心跳（不会马上推一大堆给你）
              if (cid && isPermission) {
                try { await api.send(cid, '好呀，那我自己去网上逛逛～有啥好玩的先自己记着，你想看再让我发') } catch (e) {}
                return null
              }
            }
            // 既不是可搜的词、也不是授权她自己逛 → 自然一句交回话头，不装走神
            return '我刚想上网转转，结果手滑写成终端命令了（那不是我能用的工具啦～）。你想让我搜点啥直接说，我这就去帮你搜。'
          }
          // 这句写死的「我刚刚想岔了」是生硬的机器人腔，
          // 换成一个短句池，不再让她每回都自我报告「走神」。
          return ['嗯？刚没跟上，你刚说啥', '啊，我走神了，再说一遍呗', '等等，我脑子拐弯去了，你说'][Math.floor(Math.random() * 3)]
        }
        const chatId = (info && info.chat && info.chat.chatId) || ''
        const prompt = pickDrawPrompt(s) || '一个动漫角色，柔和光线，清新画风'
        // 两段式：先说一句，图后台画，画完直接补上（不再等十几秒才开口）
        let ack = '好，我画一张给你看'
        if (/自拍|自己/.test(s)) ack = '那我给你画张自己吧，等我一下'
        else if (/海边|海/.test(s)) ack = '画张海边的我，稍等'
        else if (/吃饭|米饭/.test(s)) ack = '画我抱着饭碗的样子，马上'
        try { await api.send(chatId, ack) } catch (e) { api.log.warn('先回一句失败：' + e.message) }
        ;(async () => {
          try {
            const out = await genAny(prompt)
            await api.sendImage(chatId, out.file)
            api.log.info('兜底画图：模型把工具写成文本，已替它生成并发送 ' + out.file)
          } catch (e) {
            try { await api.send(chatId, '这回没画成，过一会儿我再给你画') } catch {}
            api.log.warn('兜底画图失败：' + e.message)
          }
        })()
        return null
      } catch (e) {
        api.log.warn('兜底画图异常：' + e.message)
        try {
          await new Promise((r) => setTimeout(r, 20000))
          const prompt2 = (() => { try { return pickDrawPrompt(String(text || '')) } catch { return '' } })() || '一个动漫角色，柔和光线，清新画风'
          const out2 = await genAny(prompt2)
          await api.sendImage((info && info.chat && info.chat.chatId) || '', out2.file)
          api.log.info('兜底画图：第二次成功了 ' + out2.file)
          return '刚卡了一下，重画好了'
        } catch (e2) {
          api.log.warn('兜底画图第二次也失败：' + e2.message)
          const why = /402|FREE_LIMIT|limit/i.test(String(e2.message)) ? '免费额度被限流了' : '画图的接口今天不太稳定'
          return '这回没画成（' + why + '），过一会儿我再给你画'
        }
      }
    })

    api.later(5000, () => {
      const c = C()
      api.log.info(`生图识图已就绪：生图=${c.genProvider} 识图=${c.zhipuKey ? '智谱' : c.siliconKey ? '硅基' : '未配 key'}`)
    })

    return {}
  },
}
