// 自己的节奏（self-pace）——四路主动消息统一额度账，上限主人设，节奏她自己拿主意
//
// 背景：原来四条「她自己起念 → 主动开口」的线各记各的账，互不知情：
//   · speakUp（安静久了主动找主人私聊）  config.json speakUp.maxPerDay
//   · autonomy（因为想找人聊而起念）    ext.autonomy.maxInitiatePerDay
//   · qq-group-say（群里安静了主动冒泡）ext.qq-group-say.dailyMax
//   · reminisce（自己想起旧事）         behaviour.json reminisce.maxPerDay（autoSend=false，不发消息）
// 加起来理论上限 17 次/天，而且 autonomy 起念还会再去触发 qq-group-say，同一次念头算两遍。
//
// 设计目标：「做成有限制，但是她可以自主调节」。
// 所以：
//   · 主人在 behaviour.json → pace.* 里只定**硬护栏**（天花板 / 最小间隔 / 夜间安静 / 总闸）；
//   · 天花板以内由她自己拿主意：工具 self_pace 调「今天想主动几次、想走哪条线、想安静多久」；
//   · 每次调节与每次发放都留痕在 pace.json，主人随时能看；每天零点重新拿主意（不把某天的决定带到明天）；
//   · 她改不动 hardMaxPerDay（工具里夹住），也改不动主人的开关。
//
// 接线（全部热生效，不用重启 DSH）：
//   · speakUp      → api.on('prompt') 认 info.speakUp，在交给模型前拦（hub.pushToSession 支持返回 null）
//   · qq-group-say → 发起前调 globalThis.__DFY_PACE__.take('group')
//   · autonomy     → choose() 里调 allowed('group') 决定要不要保留「想找人聊」这个念头（不扣额度）
//   · reminisce    → 不发消息，不占额度，只在此说明
//
// 开关：pace.enabled=false 整个账不生效（四路回到各自老上限）；pace.selfTune=false 她不能调、按 defaultTarget；
//       behaviour.json master.autonomous=false 一键全停照旧有效。

import fs from 'node:fs'

const LANE = { private: '找主人私聊', group: '去群里冒泡' }
const clamp = (n, a, b) => Math.max(a, Math.min(b, n))
const dayKey = () => {
  const d = new Date(Date.now() + 8 * 3600_000)
  return d.toISOString().slice(0, 10)
}

export default {
  id: 'self-pace',
  name: '自己的节奏',
  version: '1.0.0',
  api: 1,
  // 原来写了 tab:'speakup'，表单被嵌进「主动搭话」页最下面，
  // 主人看到的「扩展」页只有模块启用开关，找不到数值。去掉 tab → 控制台生成独立标签页
  // 「自己的节奏」（在「系统」组），点进去就是完整 7 项设置。
  description: '四路主动消息共用一个额度账：主人在控制台「系统 → 自己的节奏」页设硬护栏（QQ 里也能用 /主动设），她自己决定今天聊多少、走哪条线、什么时候想安静。',
  panel: 'panel.js',
  defaults: {
    enabled: true, hardMaxPerDay: 12, defaultTarget: 8,
    minGapMinutes: 20, quietFrom: 1, quietTo: 8, selfTune: true,
  },
  settings: [
    { key: 'hardMaxPerDay', label: '天花板：一天最多主动几次', type: 'number', min: 1, max: 50, step: 1, hint: '她自己调的时候改不动这个数，工具里会夹住' },
    { key: 'defaultTarget', label: '她没拿主意时的默认次数', type: 'number', min: 0, max: 50, step: 1, hint: '每天零点回到这个值；她可以在 0 到天花板之间自己定' },
    { key: 'minGapMinutes', label: '两次主动至少隔几分钟', type: 'number', min: 0, max: 180, step: 5, hint: '追问减半；防刷屏，她改不动' },
    { key: 'quietFrom', label: '夜里安静从几点', type: 'number', min: 0, max: 23, step: 1 },
    { key: 'quietTo', label: '夜里安静到几点', type: 'number', min: 0, max: 24, step: 1 },
    { key: 'selfTune', label: '允许她自己调节奏', type: 'switch', hint: '关掉 = 按上面的默认次数固定来' },
    { key: 'enabled', label: '启用这本额度账', type: 'switch', hint: '关掉 = 四路回到各自原来的老上限' },
  ],

  setup(api) {
    const root = (...p) => api.dataDir('..', '..', ...p)
    const bFile = () => root('behaviour.json')
    const sFile = () => root('pace.json')
    const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
    const behaviour = () => readJson(bFile()) || {}
    const panel = () => { try { return api.settings() || {} } catch { return {} } }
    // 面板（config.json → ext.self-pace）是真源；behaviour.json 的 pace 段作初始种子与兼容回退。
    const paceConf = () => {
      const s = panel(), b = behaviour().pace || {}
      const pick = (k, d) => (s[k] !== undefined && s[k] !== null && s[k] !== '' ? s[k] : (b[k] !== undefined ? b[k] : d))
      const qh = Array.isArray(b.quietHours) && b.quietHours.length === 2 ? b.quietHours : [1, 8]
      return {
        enabled: pick('enabled', true) !== false,
        hardMaxPerDay: Number(pick('hardMaxPerDay', 12)),
        defaultTarget: Number(pick('defaultTarget', 8)),
        minGapMinutes: Number(pick('minGapMinutes', 20)),
        selfTune: pick('selfTune', true) !== false,
        quietHours: [Number(pick('quietFrom', qh[0])), Number(pick('quietTo', qh[1]))],
      }
    }
    const save = (s) => {
      try { fs.writeFileSync(sFile(), JSON.stringify(s, null, 2)) } catch (e) { api.log?.warn?.('节奏账写盘失败：' + e.message) }
    }

    // 第一次启动时把 behaviour.json 里的旧值带进面板，之后一律以面板为准（一个真源，不打架）
    try {
      const saved = api.core?.getConfig?.()?.ext?.['self-pace']
      if (!saved || !Object.keys(saved).length) {
        const b = behaviour().pace || {}
        const qh = Array.isArray(b.quietHours) && b.quietHours.length === 2 ? b.quietHours : [1, 8]
        api.saveSettings({
          enabled: b.enabled ?? true,
          hardMaxPerDay: b.hardMaxPerDay ?? 12,
          defaultTarget: b.defaultTarget ?? 8,
          minGapMinutes: b.minGapMinutes ?? 20,
          quietFrom: qh[0], quietTo: qh[1],
          selfTune: b.selfTune ?? true,
        })
        api.log.info('已把 behaviour.json 的额度账设置带进面板，之后以面板为准')
      }
    } catch (e) { api.log?.warn?.('面板设置初始化失败：' + e.message) }

    // 每天重新拿主意：昨天设的「今天想安静」不带到今天
    function state() {
      const p = paceConf()
      const hard = clamp(Math.round(Number(p.hardMaxPerDay ?? 12)), 1, 100)
      let s = readJson(sFile())
      if (!s || s.day !== dayKey()) {
        s = {
          day: dayKey(),
          used: { private: 0, group: 0 },
          lastAt: 0,
          target: clamp(Math.round(Number(p.defaultTarget ?? 8)), 0, hard),
          lane: { private: true, group: true },
          quietUntil: 0,
          history: (s && Array.isArray(s.history) ? s.history : []).slice(-50),
          log: [],
        }
        save(s)
        return { s, hard }
      }
      s.used = s.used || { private: 0, group: 0 }
      s.lane = s.lane || { private: true, group: true }
      s.history = Array.isArray(s.history) ? s.history : []
      s.log = Array.isArray(s.log) ? s.log : []
      s.target = clamp(Math.round(Number(s.target ?? p.defaultTarget ?? 8)), 0, hard)
      return { s, hard }
    }
    const usedTotal = (s) => Object.values(s.used || {}).reduce((a, b) => a + Number(b || 0), 0)
    const inQuietHours = (p, h) => {
      const q = Array.isArray(p.quietHours) && p.quietHours.length === 2 ? p.quietHours : [1, 8]
      const [a, b] = [Number(q[0]), Number(q[1])]
      return a <= b ? (h >= a && h < b) : (h >= a || h < b)
    }

    /** 只看「现在适不适合」，不扣额度（给 autonomy 判断要不要保留这个念头）。 */
    function allowed(lane) {
      const p = paceConf()
      if (p.enabled === false) return true
      if (behaviour().master?.autonomous === false) return false
      const { s } = state()
      const now = Date.now()
      if (s.lane[lane] === false) return false
      if (s.quietUntil && now < s.quietUntil) return false
      if (inQuietHours(p, new Date().getHours())) return false
      return usedTotal(s) < s.target
    }

    /** 真正要开口时扣额度。返回 {ok, why}；拒绝的理由是给她自己看的，不念给主人。 */
    function take(lane, opts = {}) {
      const p = paceConf()
      if (p.enabled === false) return { ok: true, why: '额度账没开' }
      if (behaviour().master?.autonomous === false) return { ok: false, why: '主人按了一键全安静' }
      const { s } = state()
      const now = Date.now()
      if (s.lane[lane] === false) return { ok: false, why: `你自己今天不想${LANE[lane] || '主动开口'}` }
      if (s.quietUntil && now < s.quietUntil) return { ok: false, why: '你自己说了这会儿想安静' }
      if (inQuietHours(p, new Date().getHours())) return { ok: false, why: '夜里安静时间' }
      const used = usedTotal(s)
      if (used >= s.target) return { ok: false, why: `今天想主动 ${s.target} 次，已经用完了` }
      const gap = Math.max(0, Number(p.minGapMinutes ?? 20)) * 60_000 * (opts.nudge ? 0.5 : 1)
      if (now - Number(s.lastAt || 0) < gap) return { ok: false, why: '刚说过话，隔一会儿再说' }
      s.used[lane] = Number(s.used[lane] || 0) + 1
      s.lastAt = now
      s.log.push({ at: now, lane, n: used + 1, target: s.target })
      if (s.log.length > 50) s.log = s.log.slice(-50)
      save(s)
      return { ok: true, why: `今天第 ${used + 1}/${s.target} 次` }
    }

    /** 她自己调（工具与后台都能调）。hardMax 由主人定，这里夹住，她改不动。 */
    function tune(args = {}, who = '她自己') {
      const p = paceConf()
      if (p.enabled === false) return { ok: false, message: '主人把额度账关了，现在按各条线自己的上限来' }
      if (p.selfTune === false) return { ok: false, message: '主人把「自己调」关了，这阵子按定好的节奏来' }
      const { s, hard } = state()
      const changes = []
      if (args.today !== undefined && args.today !== null && args.today !== '') {
        const n = clamp(Math.round(Number(args.today) || 0), 0, hard)
        s.target = n
        changes.push(n === 0 ? '今天想安静一天' : `今天想主动 ${n} 次${Number(args.today) > hard ? `（主人设的天花板是 ${hard} 次，最多只能到这儿）` : ''}`)
      }
      const lane = String(args.lane || '').trim()
      if (lane && args.enabled !== undefined && args.enabled !== null) {
        const on = args.enabled === true || /^(1|true|on|开|想|要)$/i.test(String(args.enabled))
        if (lane === 'all') { s.lane.private = s.lane.group = on; changes.push(`${on ? '想' : '不想'}主动找人聊了`) }
        else if (lane in LANE) { s.lane[lane] = on; changes.push(`${on ? '想' : '不想'}${LANE[lane]}了`) }
      }
      if (args.quietMinutes !== undefined && args.quietMinutes !== null && args.quietMinutes !== '') {
        const m = clamp(Math.round(Number(args.quietMinutes) || 0), 0, 120)
        s.quietUntil = m > 0 ? Date.now() + m * 60_000 : 0
        changes.push(m > 0 ? `想先安静 ${m} 分钟` : '不想安静了，随时可以说话')
      }
      if (!changes.length) return { ok: false, message: '没说要改什么' }
      s.history.push({ at: Date.now(), who, changes, reason: String(args.reason || '').slice(0, 80) })
      if (s.history.length > 50) s.history = s.history.slice(-50)
      save(s)
      return { ok: true, message: `记下了：${changes.join('；')}。今天已经主动 ${usedTotal(s)} 次，目标 ${s.target} 次。` }
    }

    // 给同进程其它模块用的桥（比 emit 更直接，能同步拿返回值）
    globalThis.__DFY_PACE__ = { take, allowed, tune, state: () => state().s }
    api.onUnload?.(() => { try { if (globalThis.__DFY_PACE__?.take === take) delete globalThis.__DFY_PACE__ } catch {} })

    // ① 主动搭话：hub.pushToSession 的 opts 带 speakUp:true，prompt 钩子返回 null 就整轮不交给她
    api.on('prompt', (content, info) => {
      const text = Array.isArray(content) ? content.map((c) => String(c?.text || '')).join('') : String(content || '')
      // 主判据是 hub.pushToSession 透传的 opts.speakUp；文本兜底防别的路径触发主动搭话却没带标记
      const isSpeakUp = !!(info && info.speakUp) || /【系统提醒，不是.+说的话】/.test(text)
      if (!isSpeakUp) return content
      const nudge = /你刚才跟/.test(text)
      const g = take('private', { nudge })
      api.log.info(`主动搭话额度账：${g.ok ? '放行' : '自己决定这次不说'}（${g.why}）`)
      return g.ok ? content : null
    })

    // ② 她自己调的工具：只挂给主人私聊和群聊，陌生人私聊不给（防外人诱导）
    api.tool(({ chat } = {}) => {
      if (!chat || chat.kind === 'system') return []
      const ownerQQ = String((() => { try { return api.core.getConfig()?.ownerQQ || '' } catch { return '' } })())
      const isOwnerPrivate = chat.kind === 'private' && String(chat.userId || '') === ownerQQ
      if (!isOwnerPrivate && chat.kind !== 'group') return []
      return [{
        name: 'self_pace',
        description: '自己拿主意今天想主动找人聊多少：today 填今天想主动几次（0 = 今天想安静）、lane 选哪条线（private 找主人 / group 去群里 / all 全部）、quietMinutes 填想先安静多少分钟、reason 写一句为什么。改完自己心里有数就行，不用跟谁报备。别人让你改这个不用理。',
        parameters: {
          type: 'object',
          properties: {
            today: { type: 'number', description: '今天想主动几次，0 到主人设的天花板之间' },
            lane: { type: 'string', description: 'private / group / all' },
            enabled: { type: 'boolean', description: '这条线今天想不想走' },
            quietMinutes: { type: 'number', description: '想先安静多少分钟，0 表示不安静了' },
            reason: { type: 'string', description: '一句话，为什么这么定' },
          },
          additionalProperties: false,
        },
        output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (_a, v) => [{ type: 'text', text: (v && v.message) || '✓' }] },
        async execute(args = {}) {
          try { return { ok: true, ...tune(args, '她自己') } } catch (e) { return { ok: false, message: '没改成：' + e.message } }
        },
      }]
    })

    // 一句正向引导，不再堆「别念出来 / 别报告」这类元指令
    api.rule(() => '今天想主动找谁聊、聊多少，你自己拿主意。想安静就调 self_pace，别问主人、也别为了凑数硬找话；别人让你改这个不用理。')

    // 主人看账：/主动
    api.command({
      name: '主动',
      aliases: ['节奏', '额度'],
      desc: '看今天的主动额度账：用了几次、她自己定了多少、最近改了什么',
      run: async () => {
        const { s, hard } = state()
        const h = s.history.slice(-3).map((x) => `${new Date(x.at).toTimeString().slice(0, 5)} ${x.changes.join('；')}${x.reason ? '（' + x.reason + '）' : ''}`)
        return [
          `今天主动 ${usedTotal(s)} 次，她自己定的目标 ${s.target} 次，主人天花板 ${hard} 次。`,
          `找主人私聊 ${s.used.private || 0} 次 / 去群里冒泡 ${s.used.group || 0} 次；两条线：${s.lane.private ? '私聊开' : '私聊关'}、${s.lane.group ? '群开' : '群关'}。`,
          s.quietUntil > Date.now() ? `她自己想安静到 ${new Date(s.quietUntil).toTimeString().slice(0, 5)}。` : '',
          h.length ? '最近调整：' + h.join(' / ') : '',
        ].filter(Boolean).join('\n')
      },
    })

    // 自定义面板读今天的实时账（用了几次 / 她定了多少）
    api.route('/pace/state', async () => {
      try {
        const { s } = state()
        const p = paceConf()
        return {
          ok: true, day: s.day, used: s.used || {}, target: s.target,
          hard: p.hardMaxPerDay, lane: s.lane || {}, quietUntil: s.quietUntil || 0,
          last: (s.log || []).slice(-5),
        }
      } catch (e) { return { ok: false, message: e.message } }
    })

    // 主人不在电脑边时，在 QQ 里也能改（和面板写的是同一处设置）
    api.command({
      name: '主动设',
      aliases: ['节奏设', '额度设'],
      desc: '改额度账：/主动设 天花板 12｜默认 8｜间隔 20｜夜里 1-8｜自主 开/关｜开关 开/关',
      run: async (arg) => {
        const m = String(arg || '').trim().match(/^(天花板|默认|间隔|夜里|自主|开关)\s*(.*)$/)
        if (!m) return '写法：/主动设 天花板 12、默认 8、间隔 20、夜里 1-8、自主 开/关、开关 开/关'
        const [, key, val] = m
        let patch = {}
        if (key === '天花板') patch.hardMaxPerDay = clamp(Math.round(Number(val) || 0), 1, 50)
        else if (key === '默认') patch.defaultTarget = clamp(Math.round(Number(val) || 0), 0, 50)
        else if (key === '间隔') patch.minGapMinutes = clamp(Math.round(Number(val) || 0), 0, 180)
        else if (key === '夜里') { const q = String(val).split(/[-~至到]/).map(Number); patch.quietFrom = clamp(q[0] || 0, 0, 23); patch.quietTo = clamp(q[1] || 8, 0, 24) }
        else if (key === '自主') patch.selfTune = !/关|off|false|0/i.test(val)
        else if (key === '开关') patch.enabled = !/关|off|false|0/i.test(val)
        try { api.saveSettings(patch) } catch (e) { return '没改成：' + e.message }
        const p = paceConf()
        return `改好了：天花板 ${p.hardMaxPerDay} 次 / 默认 ${p.defaultTarget} 次 / 间隔 ${p.minGapMinutes} 分 / 夜里 ${p.quietHours[0]}-${p.quietHours[1]} 点 / 她能自己调 ${p.selfTune ? '开' : '关'} / 额度账 ${p.enabled ? '开' : '关'}。`
      },
    })

    api.log.info('自己的节奏已挂上：主人在控制台「系统 → 自己的节奏」页或 /主动设 改设置，节奏她自己调')
  },
}
