// 扩展模块「wallet」——让大肥鱼看得到主人的 DeepSeek 余额和峰谷时段。
// 放在 plugins-data/dafeiyu/modules/wallet/ 里，保存几秒后自动加载。
//
// 数据来源（按顺序试）：
//   1. DSH 的账号服务 ctx.get('deepseekAccount') → getBalance()   ← 你现在用的 deepseek-account 走这条
//   2. DSH 凭据里的 DEEPSEEK_API_KEY → https://api.deepseek.com/user/balance
// 两条都取不到就老实说取不到，不许瞎编数字。

const DEFAULTS = {
  enabled: true,
  showBonus: true,
  apiBase: 'https://api.deepseek.com',
}

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
  id: 'wallet',
  name: '钱包（余额）',
  version: '0.1.0',
  api: 1,
  description: '让她在 QQ 里答得出「我还有多少钱」：读 DSH 账号余额，附峰谷时段',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'showBonus', label: '把赠送额度也说出来', type: 'switch' },
    { key: 'apiBase', label: 'DeepSeek API 地址', type: 'text', hint: '仅第二条数据源用得到' },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const log = api.log

    // ---------- 峰谷时段（DeepSeek 现行定价：工作日 9-12、14-18 为高峰） ----------
    function tier(now = new Date()) {
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
        }).formatToParts(now)
        const pick = (t) => parts.find((p) => p.type === t)?.value
        const wd = pick('weekday')
        const hour = Number(pick('hour'))
        const weekend = wd === 'Sat' || wd === 'Sun'
        const peak = !weekend && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
        return { peak, label: peak ? '高峰期（按标准价）' : '低谷期（有折扣）' }
      } catch {
        return { peak: false, label: '' }
      }
    }

    const money = (v) => {
      const n = Number(v)
      if (!Number.isFinite(n)) return null
      return n
    }

    function clientMeta() {
      let version = '0.0.0'
      try { version = String(api.version || '0.0.0') } catch {}
      return {
        version,
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
    }

    // ---------- 数据源 1：DSH 账号服务 ----------
    async function fromAccount() {
      const dsh = api.dsh
      if (!dsh || typeof dsh.get !== 'function') return null
      const account = dsh.get('deepseekAccount', false)
      if (!account || typeof account.getBalance !== 'function') return null
      return account.getBalance(clientMeta())
    }

    // ---------- 数据源 2：凭据里的 API Key ----------
    async function fromApiKey() {
      const dsh = api.dsh
      let key = ''
      try {
        const cred = dsh && typeof dsh.get === 'function' ? dsh.get('credentials', false) : null
        if (cred && typeof cred.resolve === 'function') {
          for (const ref of ['DEEPSEEK_API_KEY', { ref: 'DEEPSEEK_API_KEY' }, { kind: 'env', name: 'DEEPSEEK_API_KEY' }]) {
            try {
              const r = await cred.resolve(ref)
              const v = r && (r.value || r.secret || (typeof r === 'string' ? r : ''))
              if (v) { key = String(v); break }
            } catch {}
          }
        }
      } catch {}
      if (!key) key = String(process.env.DEEPSEEK_API_KEY || '')
      if (!key) return null
      const base = String(cfg().apiBase || 'https://api.deepseek.com').replace(/\/+$/, '')
      const res = await fetch(base + '/user/balance', {
        headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error('余额接口 HTTP ' + res.status)
      const body = await res.json()
      const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []
      if (!infos.length) throw new Error('余额接口没返回 balance_infos')
      return {
        status: 'ready',
        value: infos.map((w) => ({ currency: w.currency || 'CNY', balance: w.total_balance })),
        bonusWallets: infos.map((w) => ({ currency: w.currency || 'CNY', balance: w.granted_balance || '0' })),
      }
    }

    // ---------- 汇总 ----------
    async function readBalance() {
      let snap = null
      let source = ''
      try {
        snap = await fromAccount()
        if (snap) source = '账号服务'
      } catch (error) {
        log.warn('钱包：账号服务取余额失败 ' + String(error?.message || error).slice(0, 120))
      }
      if (!snap || snap.status !== 'ready') {
        snap = await fromApiKey()
        if (snap) source = 'API Key'
      }
      if (!snap) throw new Error('拿不到余额：账号服务不在场，也没有可用的 API Key')
      if (snap.status !== 'ready') {
        const reason = snap.message || snap.error || snap.reason || '账号未登录或余额查询失败'
        throw new Error('余额暂时查不到：' + String(reason).slice(0, 120))
      }

      const wallets = Array.isArray(snap.value) ? snap.value : []
      if (!wallets.length) throw new Error('账号里没有可用的钱包')
      const bonus = new Map()
      for (const w of Array.isArray(snap.bonusWallets) ? snap.bonusWallets : []) {
        const cur = String(w?.currency || 'CNY')
        const n = money(w?.balance)
        if (n === null) continue
        bonus.set(cur, (bonus.get(cur) || 0) + n)
      }
      // value[] 只是「充值余额」，赠送额度在 bonusWallets 里，真正的余额是两者相加
      const topped = new Map()
      for (const w of wallets) {
        const cur = String(w?.currency || 'CNY')
        const n = money(w?.balance)
        if (n === null) continue
        topped.set(cur, (topped.get(cur) || 0) + n)
      }
      for (const cur of bonus.keys()) if (!topped.has(cur)) topped.set(cur, 0)
      const c = cfg()
      const out = [...topped.entries()].map(([cur, top]) => {
        const granted = bonus.get(cur) || 0
        return { currency: cur, total: top + granted, granted: c.showBonus ? granted : 0, topped: top }
      })
      if (!out.length) throw new Error('余额格式看不懂')
      return { wallets: out, tier: tier(), source }
    }

    function fmtCur(cur, n) {
      const sym = cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : cur + ' '
      return sym + Number(n).toFixed(2)
    }

    function describe(r) {
      const parts = r.wallets.map((w) => {
        const base = fmtCur(w.currency, w.total)
        return w.granted > 0 ? `${base}（其中赠送 ${fmtCur(w.currency, w.granted)}）` : base
      })
      return parts.join('、')    }

    async function answer() {
      const r = await readBalance()
      return `主人现在还有 ${describe(r)}，${r.tier.label}。`
    }

    // ---------- 每轮注入：主人问余额时，把刚查到的数字直接塞给她 ----------
    // 工具要靠会话挂载（有的会话挂不上），prompt 钩子却每轮都生效 —— 这条是保底通道。
    let cache = { text: '', at: 0 }
    async function refresh() {
      try {
        const r = await readBalance()
        cache = { text: describe(r) + '（' + r.tier.label + '）', at: Date.now() }
      } catch (error) {
        cache = { text: '', at: Date.now() }
      }
    }
    api.every(180_000, refresh, '余额缓存')
    api.later(5000, refresh)
    api.on('prompt', (content, info) => {
      try {
        const q = String((info && info.queryText) || '')
        if (!/(余额|多少钱|还剩|剩多少|钱包|钱够|还能用|额度|欠费)/.test(q)) return content
        const fresh = cache.text && Date.now() - cache.at < 400000
        const line = fresh ? cache.text : '（这会儿没查到，别报数字，就说查不到）'
        return [{ type: 'text', text: '【余额（模块实时查到的，直接用它回答，不许编）】主人 DeepSeek 账户：' + line }, ...content]
      } catch (error) { return content }
    })

    // ---------- 工具 ----------
    api.tool(({ chat }) => {
      if (!cfg().enabled) return []
      if (!chat || chat.kind === 'system') return []
      return [
        toolDef({
          name: 'my_balance',
          description: '查主人 DeepSeek 账户的余额（还有多少钱）和现在是高峰还是低谷时段。主人问「我还有多少钱 / 余额 / 还能用多久」时用它，别猜数字。',
          properties: {},
          required: [],
          execute: async () => {
            try {
              const r = await readBalance()
              return {
                ok: true,
                message: `余额 ${describe(r)}；${r.tier.label}（数据来源：${r.source}）`,
              }
            } catch (error) {
              return { ok: false, message: String(error?.message || error).slice(0, 160) }
            }
          },
        }),
      ]
    })

    // ---------- 规则 ----------
    api.rule(() => '主人问余额、还有多少钱、钱包、还能用多久的时候，用 my_balance 工具去查真实数字；查不到就直说查不到，绝不许编一个数字。')

    // ---------- /余额 命令 ----------
    api.command({
      name: '余额',
      aliases: ['钱包', 'balance', 'wallet'],
      desc: '看 DeepSeek 余额和峰谷时段',
      run: async () => {
        try {
          return await answer()
        } catch (error) {
          return '查不到：' + String(error?.message || error).slice(0, 160)
        }
      },
    })

    api.log.info('钱包模块已加载')
    try {
      const get = api.dsh && typeof api.dsh.get === 'function' ? api.dsh.get.bind(api.dsh) : null
      const acc = get ? get('deepseekAccount', false) : null
      const cred = get ? get('credentials', false) : null
      api.log.info('钱包：账号服务=' + (acc ? '有' : '无') + ' 凭据服务=' + (cred ? '有' : '无') +
        (process.env.DEEPSEEK_API_KEY ? ' 环境变量Key=有' : ''))
    } catch (error) {
      api.log.warn('钱包：服务探测失败 ' + String(error?.message || error).slice(0, 100))
    }
    // 自检：加载后自己查一次，结果写日志，方便一眼看出通不通
    api.later(4000, async () => {
      try {
        const r = await readBalance()
        api.log.info('钱包自检：' + describe(r) + ' / ' + r.tier.label + ' / 来源=' + r.source)
      } catch (error) {
        api.log.warn('钱包自检失败：' + String(error?.message || error).slice(0, 160))
      }
    })

    return { readBalance, answer }
  },
}
