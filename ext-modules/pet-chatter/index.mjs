// 扩展模块「pet-chatter」——让桌宠时不时自己碎碎念，顺口把余额报一下。
//
// 走桌宠插件自己的 HTTP 接口（pet/host.json 里的 baseUrl + token）：
//   POST {baseUrl}/aurabot/api/whisper   { text, reason:'api' }   ← 碎碎念（会挑碎碎念动作）
//   POST {baseUrl}/aurabot/api/bubble    { text, anim, via:'pet' } ← 指定气泡+动作
//
// 节奏：默认每 40–70 分钟随机一次，只在 9:00–23:30 之间；不想听就把「定时碎碎念」关掉。
// 余额：优先用宿主账号服务（deepseekAccount.getBalance），没有就用 DEEPSEEK_API_KEY 直连。

import fs from 'node:fs'
import path from 'node:path'

const DEFAULTS = {
  enabled: true,
  minMinutes: 40,
  maxMinutes: 70,
  startHour: 9,
  endHour: 23,
  sayBalance: true,      // 碎碎念里报余额
  sayChance: 0.3,        // 每次碎碎念里，报余额的概率（原 0.75：四次里三次都在报余额，像复读机）
  moodRate: true,        // 间隔随情绪伸缩
  quietIfBusy: true,     // 主人正在用电脑（近期有活动）就别打扰
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
    async execute(args) {
      try { return JSON.parse(JSON.stringify((await execute(args || {})) ?? { ok: true })) }
      catch (e) { return { ok: false, message: String((e && e.message) || e) } }
    },
  }
}

export default {
  id: 'pet-chatter',
  name: '桌宠碎碎念',
  version: '1.0.0',
  api: 1,
  description: '桌宠时不时冒一句碎碎念，顺口报一下余额',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '定时碎碎念', type: 'switch' },
    { key: 'moodRate', label: '间隔随情绪变', type: 'switch', hint: '开：心情好/孤单时念得勤一点，生气时少念（间隔 ×0.5–×2）' },
    { key: 'minMinutes', label: '最短间隔（分钟）', type: 'number', hint: '默认 40' },
    { key: 'maxMinutes', label: '最长间隔（分钟）', type: 'number', hint: '默认 70' },
    { key: 'startHour', label: '从几点开始', type: 'number', hint: '默认 9' },
    { key: 'endHour', label: '到几点结束', type: 'number', hint: '默认 23' },
    { key: 'sayBalance', label: '碎碎念里报余额', type: 'switch' },
    { key: 'sayChance', label: '报余额的概率', type: 'number', hint: '0–1，默认 0.3' },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const hostFile = path.join(path.dirname(api.dataDir('.')), 'pet', 'host.json')

    function host() {
      try {
        const j = JSON.parse(fs.readFileSync(hostFile, 'utf8'))
        if (!j.baseUrl || !j.token) return null
        return { base: String(j.baseUrl).replace(/\/+$/, ''), api: j.api || '/aurabot/api', token: j.token }
      } catch { return null }
    }

    async function post(pathname, body) {
      const h = host()
      if (!h) throw new Error('桌宠还没启动过（找不到 pet/host.json）')
      const r = await fetch(h.base + h.api + pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-pet-token': h.token },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.message || ('桌宠接口 ' + r.status))
      return j
    }

    // ---- 余额 ----
    async function fromAccount() {
      const account = api.dsh && typeof api.dsh.get === 'function' ? api.dsh.get('deepseekAccount', false) : null
      if (!account || typeof account.getBalance !== 'function') return null
      return await account.getBalance({
        version: '1.0', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
    }

    async function fromApiKey() {
      const creds = api.dsh && typeof api.dsh.get === 'function' ? api.dsh.get('credentials') : null
      if (!creds || typeof creds.resolve !== 'function') return null
      let key = ''
      for (const ref of ['DEEPSEEK_API_KEY', { name: 'DEEPSEEK_API_KEY' }, { kind: 'env', name: 'DEEPSEEK_API_KEY' }]) {
        try {
          const v = await creds.resolve(ref)
          key = typeof v === 'string' ? v : (v && (v.value || v.secret || v.token)) || ''
          if (key) break
        } catch {}
      }
      if (!key) return null
      const r = await fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(9000),
      })
      const j = await r.json()
      if (j && j.is_available === false) return { status: 'ready', value: [], bonusWallets: [] }
      const infos = Array.isArray(j.balance_infos) ? j.balance_infos : []
      return {
        status: 'ready',
        value: infos.map((b) => ({ currency: b.currency || 'CNY', balance: String(b.total_balance ?? '0') })),
        bonusWallets: infos.map((b) => ({ currency: b.currency || 'CNY', balance: String(b.granted_balance ?? '0') })),
      }
    }

    async function balance() {
      let snap = null
      try { snap = await fromAccount() } catch {}
      if (!snap || snap.status !== 'ready') { try { snap = await fromApiKey() } catch {} }
      if (!snap || snap.status !== 'ready') return null
      const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : null }
      let total = 0, granted = 0, cur = 'CNY', ok = false
      for (const w of Array.isArray(snap.value) ? snap.value : []) {
        const n = num(w.balance); if (n === null) continue
        total += n; cur = w.currency || cur; ok = true
      }
      for (const w of Array.isArray(snap.bonusWallets) ? snap.bonusWallets : []) {
        const n = num(w.balance); if (n === null) continue
        granted += n; ok = true
      }
      if (!ok) return null
      const sum = total + granted
      const sym = cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : cur + ' '
      return { sum, text: sym + sum.toFixed(2), granted, cur, sym }
    }

    const BALANCE_LINES = [
      (b) => `偷偷看了眼宝的余额，还剩 ${b.text} 呢，够用够用～`,
      (b) => `${b.text}…宝别乱花呀，我还想吃点好吃的。`,
      (b) => `余额 ${b.text}，我算过了，还能撑一阵子。`,
      (b) => `刚瞄了下钱包：${b.text}${b.granted > 0 ? '（里面还有赠送的）' : ''}。`,
    ]
    const IDLE_LINES = [
      '宝在忙吗…我在这儿发呆呢。',
      '地板有点凉，我挪了个位置。',
      '刚才那个视频好好笑，可惜你没看见。',
      '要不要我念点什么给你听？',
      '我数了数，今天已经翻了好几次身。',
    ]

    function inWindow() {
      const h = new Date().getHours()
      const c = cfg()
      const s = Number(c.startHour), e = Number(c.endHour)
      return s <= e ? h >= s && h < e : h >= s || h < e
    }

    async function chatter(reason) {
      const c = cfg()
      let text = ''
      if (c.sayBalance && Math.random() < Number(c.sayChance)) {
        const b = await balance()
        if (b) text = BALANCE_LINES[Math.floor(Math.random() * BALANCE_LINES.length)](b)
      }
      if (!text) text = IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)]
      const r = await post('/whisper', { text, reason: reason || 'api' })
      api.log.info(`碎了句嘴：${text}`)
      return { ok: true, message: `已碎碎念：${text}`, replied: r }
    }

    const moodFreq = () => { const s = globalThis.__dfyStyle; return s && s.on && Date.now() - s.at < 600000 ? Math.max(0.3, Math.min(2, Number(s.freq) || 1)) : 1 }
    // 随机间隔自己排下一轮
    let timer = null
    function schedule() {
      if (timer) { clearTimeout(timer); timer = null }
      const c = cfg()
      if (!c.enabled) return
      const lo = Math.max(5, Number(c.minMinutes) || 40)
      const hi = Math.max(lo + 1, Number(c.maxMinutes) || 70)
      // 情绪频率：心情好/孤单 → 间隔短一点；生气/低落 → 长一点（×0.5–×2）
      const f = c.moodRate === false ? 1 : moodFreq()
      const ms = ((lo + Math.random() * (hi - lo)) / f) * 60_000
      timer = setTimeout(async () => {
        try {
          if (cfg().enabled && inWindow()) await chatter('定时')
        } catch (e) { api.log.warn('碎碎念没发出去：' + (e.message || e)) }
        schedule()
      }, ms)
      timer.unref?.()
    }

    api.on('config', () => schedule())
    api.later(60_000, () => {
      schedule()
      api.log.info(`桌宠碎碎念排班：每 ${cfg().minMinutes}–${cfg().maxMinutes} 分钟一次，${cfg().startHour}:00–${cfg().endHour}:00 之间`)
    })

    api.tool(() => toolDef({
      name: 'pet_say',
      description: '让桌宠现在冒一句话（可以顺便报余额）。',
      properties: {
        text: { type: 'string', description: '要说的话；留空就自己挑一句（可能带余额）' },
        anim: { type: 'string', description: '可选：点播一段动作名，例如「碎碎念-对屏碎碎念」' },
      },
      async execute({ text, anim }) {
        if (text) {
          const body = anim ? { text, anim, via: 'pet' } : { text, reason: 'api' }
          await post(anim ? '/bubble' : '/whisper', body)
          return { ok: true, message: `说了：${text}` }
        }
        return await chatter('手动')
      },
    }))

    api.tool(() => toolDef({
      name: 'pet_balance',
      description: '查一下现在 DeepSeek 账户余额（桌宠碎碎念用的就是这个数）。',
      properties: {},
      async execute() {
        const b = await balance()
        return b ? { ok: true, message: `余额 ${b.text}${b.granted > 0 ? `（其中赠送 ${b.sym}${b.granted.toFixed(2)}）` : ''}` } : { ok: false, message: '这会儿查不到余额' }
      },
    }))

    api.command({
      name: '碎碎念', aliases: ['chatter'], desc: '/碎碎念 [now|off|on]',
      async run(arg) {
        const a = String(arg || '').trim()
        if (a === 'off') { api.saveSettings({ enabled: false }); schedule(); return '好，我不自己啰嗦了' }
        if (a === 'on') { api.saveSettings({ enabled: true }); schedule(); return `那我继续每 ${cfg().minMinutes}–${cfg().maxMinutes} 分钟念一句` }
        const r = await chatter('手动')
        return r.message
      },
    })
  },
}
