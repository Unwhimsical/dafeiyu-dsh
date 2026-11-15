// 每日反思（t170 · E）：她睡前回顾自己这一天，写一篇反思日记（只发给主人私聊），
//   行为层面的经验 → 记成「她自己的想法 / 反思」进记忆库 + 第二天每轮带一句短提醒；
//   代码 / 权限层面的想法 → 只列成「建议」交给主人，自己绝不改代码、配置、白名单、隔离、18+。
// 隐私：只有主人私聊里的片段会进日记原料；其它聊天只记「类型 + 次数」，不记谁说了什么。
import fs from 'node:fs'

const NEG = /(别这样|不对|错了|说错|记错|搞错|不是这样|不是我|你乱说|瞎说|冷场|无聊|好烦|闭嘴|别说了|尴尬|没意思|不好笑|听不懂|答非所问)/
const BLOCK = /(没权限|没有权限|权限不够|下载不了|下不了|下载失败|找不到(这个|那个)?群|不在白名单|做不到|没法帮|办不到|打不开|被拦)/
const NEG_DIMS = ['生气', '难过', '焦虑', '被冷落', '黑化', '委屈', '烦躁']
const DEFAULTS = { enabled: true, hour: 23, minute: 30, lessonsMax: 3 }
const BAD_LESSON = /(\d{5,}|老爹|老妈|爸爸|妈妈|18|色|涩|裸|隔离|QQ号|群号|密码|token|key)/i

export default {
  id: 'reflect',
  name: '每日反思',
  version: '1.0.0',
  api: 1,
  description: '睡前回顾自己的一天，写反思日记（只给主人看），把经验用到第二天；改代码/权限的想法只作为建议交给主人',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'boolean', hint: '也可以在私聊发 /反思 开|关' },
    { key: 'hour', label: '几点写（小时）', type: 'number', hint: '默认 23（她睡前）；0~4 点也算前一天' },
    { key: 'minute', label: '几分写', type: 'number', hint: '默认 30' },
    { key: 'lessonsMax', label: '第二天带几条提醒', type: 'number', hint: '默认 3，每条很短' },
  ],
  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const F = (n) => api.dataDir(n)
    const rd = (n, d) => { try { return JSON.parse(fs.readFileSync(F(n), 'utf8')) } catch { return d } }
    const wr = (n, v) => { try { fs.writeFileSync(F(n), JSON.stringify(v)) } catch {} }
    // 反思日：凌晨 5 点前算前一天
    const dayOf = (t = Date.now()) => new Date(t - 5 * 3600_000).toLocaleDateString('sv-SE')
    const ownerQ = () => String(api.config().ownerQQ || '')
    const ownerChat = () => 'private:' + ownerQ()
    const isOwnerPriv = (id) => !!ownerQ() && String(id) === ownerChat()
    const allowG = () => new Set((api.config().allow?.groups || []).map(String))
    const scene = (id) => { id = String(id || ''); return isOwnerPriv(id) ? 'owner' : id.startsWith('group:') ? (allowG().has(id.slice(6)) ? 'group' : 'og') : 'other' }

    let log = rd('signals.json', { day: dayOf(), sig: [], emo: [] })
    const roll = () => { if (log.day !== dayOf()) log = { day: dayOf(), sig: [], emo: [] } }
    const save = () => wr('signals.json', log)
    const lastOut = new Map() // chatId -> 她上一句（只留主人私聊的）
    function add(type, chatId, note) {
      roll()
      const sc = scene(chatId)
      // 片段只留主人私聊；其它场景只记类型，不记内容
      log.sig.push({ t: Date.now(), type, sc, note: sc === 'owner' || sc === 'self' ? String(note || '').slice(0, 60) : '' })
      while (log.sig.length > 120) log.sig.shift()
      save()
    }

    api.on('activity', (a) => {
      try {
        if (!a || !a.chatId || String(a.chatId).startsWith('system:')) return
        if (a.kind === 'out' && a.reply) {
          const r = String(a.reply)
          if (isOwnerPriv(a.chatId)) lastOut.set(a.chatId, r.slice(0, 50))
          if (BLOCK.test(r)) add('blocked', a.chatId, r.slice(0, 50))
        } else if (a.kind === 'in' && a.text && a.direct !== false && NEG.test(String(a.text))) {
          const prev = lastOut.get(a.chatId) || ''
          add(a.owner ? 'owner-correct' : 'other-negative', a.chatId, prev ? '她说「' + prev + '」后被纠正：' + String(a.text).slice(0, 30) : String(a.text).slice(0, 40))
        }
      } catch {}
    })
    // 别的模块报上来的：答应了没做到 / 想做被拦（qq-group-say 等）
    api.on('self/miss', (e) => { try { add('miss', 'self', String(e && e.what || '')) } catch {} })
    api.on('self/blocked', (e) => { try { add('blocked', 'self', String(e && e.what || '')) } catch {} })
    // 情绪：每 10 分钟从 mood 发布的 10 维里取一次负面强度
    api.every(600_000, () => {
      try {
        roll()
        const st = globalThis.__dfyStyle
        if (st && st.felt && Date.now() - (Number(st.at) || 0) < 900_000) {
          const v = {}
          for (const k of NEG_DIMS) { const x = Number(st.felt[k]); if (Number.isFinite(x)) v[k] = x > 1 ? x / 100 : x }
          log.emo.push({ t: Date.now(), v }); while (log.emo.length > 160) log.emo.shift(); save()
        }
      } catch {}
      maybeRun().catch(() => {})
    }, '每日反思')

    function emoSummary() {
      const out = []
      for (const k of NEG_DIMS) {
        const xs = log.emo.map((e) => e.v[k]).filter((x) => x != null)
        if (xs.length < 6) continue
        const high = xs.filter((x) => x >= 0.5).length
        if (high >= 12) out.push(`${k}偏高持续了大约 ${Math.round(high / 6)} 小时`)
      }
      return out
    }
    function digest() {
      roll()
      const by = (ty) => log.sig.filter((s) => s.type === ty)
      const lab = { owner: '主人私聊', group: '群里', og: '其它群', other: '别的私聊', self: '自己' }
      const cnt = (arr) => Object.entries(arr.reduce((m, s) => (m[s.sc] = (m[s.sc] || 0) + 1, m), {})).map(([k, n]) => `${lab[k] || k}×${n}`).join('、')
      const notes = (arr) => arr.map((s) => s.note).filter(Boolean).slice(-6)
      const o = by('owner-correct'), n = by('other-negative'), m = by('miss'), b = by('blocked')
      return {
        counts: { corrections: o.length, negative: n.length, misses: m.length, blocked: b.length },
        text: [
          `被主人纠正/不满：${o.length} 次` + (notes(o).length ? '；' + notes(o).join('；') : ''),
          `别人的负面反应（冷场/说不对）：${n.length} 次` + (n.length ? '（' + cnt(n) + '）' : ''),
          `自己答应了没做到/搞错：${m.length} 次` + (notes(m).length ? '；' + notes(m).join('；') : ''),
          `想做但被拦/做不到：${b.length} 次` + (b.length ? '（' + cnt(b) + '）' : '') + (notes(b).length ? '；' + notes(b).join('；') : ''),
          `情绪：` + (emoSummary().join('；') || '没有长时间的负面情绪'),
        ].join('\n'),
      }
    }

    async function reflect() {
      const d = digest()
      const sys = '你是她自己，在睡前回顾今天。只根据给你的材料写，不编造。输出 JSON：{"good":"做得好的(1-2句)","bad":"做得不好的(1-3句)","next":"明天要怎么做(1-3句)","want":["想要但现在没有的能力/权限，没有就空数组"],"lessons":["给明天自己的行为提醒，每条≤25字，最多3条，只写说话做事的方式，不写任何人名、群名、号码、聊天原话、私密或成人内容"]}'
      let j = null
      try {
        const raw = await api.ask({ system: sys, text: '今天（' + log.day + '）的材料：\n' + d.text, maxTokens: 600 })
        const m = String(raw || '').match(/\{[\s\S]*\}/); if (m) j = JSON.parse(m[0])
      } catch {}
      if (!j) j = { good: '今天平平稳稳地过了。', bad: d.counts.corrections + d.counts.misses ? '有几次没做好，被纠正了。' : '没发现明显的问题。', next: '明天说话前多想一下对方要什么。', want: [], lessons: [] }
      const lessons = (Array.isArray(j.lessons) ? j.lessons : []).map((x) => String(x).trim().slice(0, 30)).filter((x) => x && !BAD_LESSON.test(x)).slice(0, Math.max(0, Number(cfg().lessonsMax) || 3))
      const want = (Array.isArray(j.want) ? j.want : []).map((x) => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 5)
      wr('lessons.json', { day: log.day, at: Date.now(), lessons })
      // 行为经验进记忆库：她自己的想法，不是关于任何人的事实
      const mc = (() => { try { return api.use('memcore') } catch { return null } })()
      for (const l of lessons) { try { await mc?.remember?.('我反思后给自己的提醒：' + l, { kind: 'skill', importance: 0.6, visibility: 'private', meta: { chatId: 'system:reflect', tags: ['她自己的想法', '反思'] } }) } catch {} }
      const diary = [
        `📔 ${log.day} 的反思日记`,
        `做得好的：${j.good || '—'}`,
        `做得不好的：${j.bad || '—'}`,
        `下次这样做：${j.next || '—'}`,
        lessons.length ? `明天提醒自己：${lessons.join('；')}` : '',
        want.length ? `想要的能力（只是建议，等你决定，我不会自己去改）：\n- ${want.join('\n- ')}` : '',
        `（今天：被纠正 ${d.counts.corrections}、冷场/负面 ${d.counts.negative}、没做到 ${d.counts.misses}、被拦 ${d.counts.blocked}）`,
      ].filter(Boolean).join('\n')
      const hist = rd('diary.json', []); hist.push({ day: log.day, at: Date.now(), diary }); while (hist.length > 30) hist.shift(); wr('diary.json', hist)
      return diary
    }

    async function maybeRun(now = new Date()) {
      const c = cfg()
      if (!c.enabled || !ownerQ()) return false
      const h = now.getHours(), mi = now.getMinutes()
      const due = (h > c.hour || (h === c.hour && mi >= c.minute)) || h < 5
      const st = rd('state.json', {})
      if (!due || st.lastDay === dayOf(now.getTime())) return false
      wr('state.json', { lastDay: dayOf(now.getTime()), at: Date.now() }) // 先记，重启不重跑
      const diary = await reflect()
      try { if (!api.core?.mutes?.muted?.(ownerChat())) await api.send(ownerChat(), diary) } catch {}
      return true
    }

    // 第二天每轮带一句短提醒（所有聊天：只是她自己的说话方式，不含任何人和内容）
    ;(api.volatile || api.context)(() => {
      if (!cfg().enabled) return ''
      const L = rd('lessons.json', null)
      if (!L || !L.lessons?.length || Date.now() - L.at > 36 * 3600_000) return ''
      return ('（昨晚反思给自己的提醒：' + L.lessons.join('；')).slice(0, 110) + '）'
    })

    api.command({
      name: '反思', aliases: ['reflect'], desc: '每日反思：/反思 开|关|今天|状态',
      run: async (arg, msg) => {
        const a = String(arg || '').trim()
        if (!msg || msg.kind !== 'private' || !api.isOwner(msg.userId)) return '这个只在主人私聊里用～'
        if (/^(开|打开)$/.test(a)) { api.saveSettings({ enabled: true }); return '好，每晚睡前我会写反思日记给你看。' }
        if (/^(关|关闭)$/.test(a)) { api.saveSettings({ enabled: false }); return '好，先不写反思日记了。' }
        if (/^(今天|现在|写)$/.test(a)) return await reflect()
        const st = rd('state.json', {}), d = digest()
        return `每日反思：${cfg().enabled ? '开' : '关'}，每天 ${cfg().hour}:${String(cfg().minute).padStart(2, '0')} 写；上次写的是 ${st.lastDay || '还没写过'}。今天到现在：被纠正 ${d.counts.corrections}、负面 ${d.counts.negative}、没做到 ${d.counts.misses}、被拦 ${d.counts.blocked}`
      },
    })
    return { reflect, maybeRun, digest }
  },
}
