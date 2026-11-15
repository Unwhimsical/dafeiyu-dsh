// 扩展模块「voice-tone」——让她的声音跟着情绪走，不再是一条固定的机器音。
//
// 引擎：edge-tts（微软在线朗读），已装在 C:\Users\<你>\Aurabot\pyenv，音色比 Windows 自带的自然得多。
// 这个模块不改引擎，只改「语气参数」——把 aruabot 的 voice.voice / rate / pitch 按身体状态调：
//   开心/幸福 → 语速稍快、音高略高（活泼）
//   难过/自卑 → 放慢、压低
//   累了（能量低）→ 明显放慢
//   害羞 → 音高略高、语速不变
//
// 主人随时能关：设置里「跟着情绪调语气」关掉，就固定用 baseRate / basePitch。

const DEFAULTS = {
  enabled: true,                 // 总开关：按情绪调语气
  voice: 'zh-CN-XiaoyiNeural',   // 主音色（女声、年轻、自然）
  baseRate: 6,                   // 基础语速（%）
  basePitch: 3,                  // 基础音高（Hz）
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const pct = (n) => (n >= 0 ? '+' : '') + Math.round(n) + '%'
const hz = (n) => (n >= 0 ? '+' : '') + Math.round(n) + 'Hz'

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
  id: 'voice-tone',
  name: '语气跟着情绪',
  version: '1.0.0',
  api: 1,
  description: '语音条的音色/语速/音高按星图 10 维情绪自动调（只读星图，不自己存情绪；用 edge-tts）',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '跟着情绪调语气', type: 'switch' },
    { key: 'voice', label: '音色', type: 'text', hint: '默认 zh-CN-XiaoyiNeural；也可 zh-CN-XiaoxiaoNeural' },
    { key: 'baseRate', label: '基础语速（%）', type: 'number', hint: '默认 6' },
    { key: 'basePitch', label: '基础音高（Hz）', type: 'number', hint: '默认 3' },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })

    // 情绪单一来源：不再自己去拉 /bio（旧接口已 404），只读星图 10 维发布的体感值（globalThis.__dfyStyle.felt，0–100，不含 18+ 维度）
    function felt() {
      const s = globalThis.__dfyStyle
      return s && s.felt && Date.now() - Number(s.at || 0) < 15 * 60_000 ? s.felt : null
    }

    function plan(f) {
      const k = cfg()
      let rate = Number(k.baseRate) || 0
      let pitch = Number(k.basePitch) || 0
      let why = '基础语速音高'
      if (k.enabled && f) {
        const g = (d) => Math.max(0, Math.min(100, Number(f[d]) || 0)) / 100
        const happy = Math.max(g('开心'), g('满足'))
        const cold = g('被冷落')
        const angry = Math.max(g('生气'), g('黑化'))
        const wild = g('失控')
        if (angry >= 0.55) { rate += 2; pitch -= 3; why = '在生气（星图），短促一点、压低' }
        else if (cold >= 0.55) { rate -= 6; pitch -= 4; why = '被冷落（星图），放慢压低' }
        else if (wild >= 0.6) { rate += 6; pitch += 2; why = '情绪上头（星图），快一点' }
        else if (happy >= 0.65) { rate += 4; pitch += 3; why = '开心（星图），语速快一点、声音高一点' }
        else why = '平稳（星图）'
      } else if (!k.enabled) why = '固定语气（主人关掉了情绪调节）'
      else why = '星图情绪暂时读不到，用基础语气'
      return { rate: clamp(rate, -25, 30), pitch: clamp(pitch, -12, 14), why, engine: 'edge' }
    }

    let last = null

    async function apply() {
      const core = api.core
      if (!core || typeof core.getConfig !== 'function' || typeof core.setConfig !== 'function') return
      const cur = core.getConfig()
      if (!cur || !cur.voice) return
      const p = plan(felt())
      // 不改引擎（以前这里会把 http 语音引擎改回 auto）：只调 edge 的音色 / 语速 / 音高
      const next = { ...cur, voice: { ...cur.voice, voice: cfg().voice, rate: pct(p.rate), pitch: hz(p.pitch) } }
      const changed = cur.voice.voice !== next.voice.voice || cur.voice.rate !== next.voice.rate || cur.voice.pitch !== next.voice.pitch
      if (changed) {
        core.setConfig(next)
        api.log.info(`语气：${next.voice.voice} rate=${next.voice.rate} pitch=${next.voice.pitch} —— ${p.why}`)
      }
      last = { ...p, voice: next.voice.voice, rate: next.voice.rate, pitch: next.voice.pitch, at: Date.now() }
    }

    api.every(5 * 60_000, () => { apply().catch(() => {}) }, 'voice-tone')
    api.later(8000, () => { apply().catch(() => {}) })

    api.tool(() => toolDef({
      name: 'voice_tone_status',
      description: '看看现在语音用的是什么音色、语速、音高，为什么这么调。',
      properties: {},
      async execute() {
        const cur = (api.core && api.core.getConfig && api.core.getConfig()) || {}
        const v = cur.voice || {}
        return {
          ok: true,
          message: `音色 ${v.voice || '?'}｜语速 ${v.rate || '?'}｜音高 ${v.pitch || '?'}｜引擎 ${v.engine || '?'}${last ? '｜上次判断：' + last.why : ''}`,
        }
      },
    }))

    api.command({
      name: '语气', aliases: ['声音', 'voice'], desc: '/语气 [自然|活泼|温柔|慢]',
      async run(arg) {
        const a = String(arg || '').trim()
        const presets = {
          自然: { voice: 'zh-CN-XiaoxiaoNeural', baseRate: 4, basePitch: 2 },
          活泼: { voice: 'zh-CN-XiaoyiNeural', baseRate: 10, basePitch: 5 },
          温柔: { voice: 'zh-CN-XiaoxiaoNeural', baseRate: -2, basePitch: 0 },
          慢: { voice: 'zh-CN-XiaoyiNeural', baseRate: -8, basePitch: 0 },
        }
        if (presets[a]) {
          api.saveSettings(presets[a])
          await apply()
          return `换成「${a}」了：${presets[a].voice} rate=${pct(presets[a].baseRate)} pitch=${hz(presets[a].basePitch)}`
        }
        const cur = (api.core && api.core.getConfig && api.core.getConfig()) || {}
        const v = cur.voice || {}
        return `现在：${v.voice}｜语速 ${v.rate}｜音高 ${v.pitch}${v.engine === 'windows' ? '（正在用 Windows 自带音，比较机械）' : ''}。可用：/语气 自然|活泼|温柔|慢`
      },
    })

    api.rule(() => '发语音别用播报腔。')
  },
}
