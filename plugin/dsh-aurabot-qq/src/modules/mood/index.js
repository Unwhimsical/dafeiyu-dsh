// 内置模块：心情。聊天让她开心或低落，心情影响她发表情、发语音的频率和回复快慢，也会写进她的上下文。
// 导出 createMood 的返回值：nudge(变化, 原因)、label()、state()、effects()、contextLine()、observe()、judge()。
// 新增（情绪自调）：effects() 里混进大脑情绪算出来的风格（气泡数 / 频率 / 快慢 / 语气），
// 受 config.selfAdjust 管（主人 /自调 开|关|状态）；关了就是原来的心情倍数 + 固定 3 泡。
// 另带主人命令 /改人设 开|关|状态（config.selfEditPersona.enabled：关了她不能改自己的资料 / 人设）。

import { createMood } from '../../features/companion.js'
import { createStyle, lengthHint } from '../../features/style.js'
import fs from 'node:fs'

const onOff = (s) => (/^(开|on|true|1|打开|启用)$/i.test(s) ? true : /^(关|off|false|0|关闭|停用)$/i.test(s) ? false : null)

export default {
  id: 'mood',
  name: '心情',
  version: '1.1.0',
  description: '情绪自调：按记忆星海的 10 维情绪调聊天方式（气泡 / 频率 / 快慢）。旧的单维心情（0~100）已停用（config.mood.enabled=false）',
  tab: 'mood',
  files: ['features/companion.js', 'features/style.js'],
  setup(api) {
    const mood = createMood({ getConfig: api.config, dsh: api.dsh })
    const style = createStyle({ getConfig: api.config, log: api.log })
    const refreshMs = () => Math.max(15, Number(api.config().selfAdjust?.refreshSec) || 60) * 1000
    style.refresh().catch(() => {})
    api.every(refreshMs(), () => style.refresh(), '情绪自调')
    // t166：她只有一个「自己」——起床时间 / 今天做过的事（只记她自己干了什么，不记任何人说的话）跨所有聊天共用一份，
    //   以前每个会话各自从自己的历史里猜「我刚醒 / 早醒了」，私聊和群里对不上。存 dataDir，重启不丢。
    const SELF = (() => { try { return api.dataDir('self-state.json') } catch { return '' } })()
    const dayKey = (d = new Date()) => d.toLocaleDateString('sv-SE')
    let self = (() => { try { return JSON.parse(fs.readFileSync(SELF, 'utf8')) } catch { return {} } })()
    const saveSelf = () => { try { if (SELF) fs.writeFileSync(SELF, JSON.stringify(self)) } catch {} }
    function selfMark(what) {
      const now = new Date()
      if (self.day !== dayKey(now)) self = { day: dayKey(now), wokeAt: 0, acts: [] }
      if (!self.wokeAt && now.getHours() >= 5) self.wokeAt = now.getTime()
      if (what) {
        const last = self.acts[self.acts.length - 1]
        if (last && last.w === what && now - last.t < 20 * 60_000) last.t = now.getTime()
        else self.acts.push({ t: now.getTime(), w: what })
        while (self.acts.length > 12) self.acts.shift()
      }
      saveSelf()
    }
    const ACT_LABEL = { douyin: '刷了会儿抖音', bili: '刷了会儿B站', search: '上网查了点东西', group: '想找人说说话', none: '歇了一会儿' }
    api.on('self/act', (e) => { try { const w = ACT_LABEL[String(e && e.act)] ; if (w) selfMark(w) } catch {} })
    api.on('activity', (a) => {
      try {
        if (!a || a.kind !== 'out' || !a.reply) return
        const id = String(a.chatId || '')
        if (id.startsWith('system:')) return
        selfMark(id.startsWith('group:') ? 'chat:group' : 'chat:private')
      } catch {}
    })
    const hm = (t) => { const d = new Date(t); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') }
    const ago = (t) => { const m = Math.round((Date.now() - t) / 60_000); return m < 2 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.round(m / 60) + ' 小时前' }
    function selfLine(chat) {
      if (self.day !== dayKey()) return ''
      const owner = chat.kind === 'private' && String(chat.chatId) === 'private:' + String(api.config().ownerQQ || '')
      const acts = (self.acts || []).slice(-4).map((x) => {
        let w = x.w
        if (w === 'chat:group') w = owner ? '在群里聊了几句' : '跟人聊了会儿天'
        else if (w === 'chat:private') w = '跟人聊了会儿天'
        return ago(x.t) + w
      })
      const wake = self.wokeAt ? `今天 ${hm(self.wokeAt)} 就醒了（${ago(self.wokeAt)}）` : ''
      const bits = [wake, acts.length && '最近：' + [...new Set(acts)].join('、')].filter(Boolean)
      return bits.length ? `（今天的你：${bits.join('；')}。你在哪个聊天里都是同一个人、同一个作息，说起自己的状态以这个为准；只说你自己做了什么，别透露别的聊天里谁说了什么）` : ''
    }
    // 每分钟都会变：走 volatile（进这一轮用户消息），不进运行时快照（快照一变就整段追加进历史、还打断前缀缓存）
    ;(api.volatile || api.context)(({ chat }) => {
      if (chat.kind === 'system') return ''
      // 每轮只有这一行「情绪 / 语气」：星图 10 维算出来的说话状态 + 身体感觉（bio 模块发布在 __dfyBodyLine，只读）
      const legacy = mood.contextLine() // 旧单维心情：config.mood.enabled=false 时恒为空
      const tone = style.current()?.tone || ''
      const b = globalThis.__dfyBodyLine
      const body = b && b.line && Date.now() - b.at < 30 * 60_000 ? String(b.line).slice(0, 80) : ''
      const parts = [tone && '说话状态：' + tone, body && '身体：' + body].filter(Boolean)
      const one = parts.length ? `（这会儿${parts.join('；')}。自然带出来，别念数字、别报告）` : ''
      // t166：自调开着时，每个场景都带一句长度/条数（情绪 + 精神头算的）；关着就是原来的固定规则
      const len = api.config().selfAdjust?.enabled !== false && style.current() ? lengthHint(style.current(), chat.kind === 'group' ? 'group' : 'private') : ''
      const base = legacy && !one ? legacy : one
      return [selfLine(chat), base, len && '（' + len + '）'].filter(Boolean).join('\n')
    })
    api.on('activity', (a) => {
      const cfg = api.config()
      // 对暗号的那几句不影响心情（modules/handshake 标的口令轮）
      const g = globalThis.__DFY_ADULT_GATE__
      const code = (t) => { try { return Boolean(g && g.isCodeTurn && g.isCodeTurn(String(a.chatId || ''), t)) } catch { return false } }
      if (a.kind === 'in' && a.text && code(a.text)) return
      if (a.kind === 'out' && code(a.userText)) return
      if (a.kind === 'in' && a.text) mood.observe(a.text, a.nickname, { direct: a.direct, owner: a.owner })
      // 模型判心情（开了才判）：系统提醒开头的是她自己主动找人
      if (a.kind === 'out' && a.reply && !String(a.chatId).startsWith('system:')) {
        // 只认内部标记（hub 的 speakUp），不认文字前缀
        const speakUp = a.speakUp === true
        mood.judge({ userText: a.userText, reply: a.reply, who: String(a.chatId).startsWith('group:') ? '群里的人' : String(a.chatId) === `private:${cfg.ownerQQ}` ? cfg.ownerName || '主人' : '对方', origin: speakUp ? 'speak-up' : 'user' }).catch(() => {})
      }
    })
    api.command({
      name: '自调',
      aliases: ['selfadjust'],
      desc: '情绪自调聊天方式：/自调 开|关|状态',
      run: async (arg) => {
        const v = onOff(String(arg || '').trim())
        if (v !== null) { api.setConfig({ selfAdjust: { enabled: v } }); if (v) await style.refresh() }
        const s = style.state()
        return `情绪自调：${s.enabled ? '开' : '关'}（气泡 ${s.bounds.minBubbles}–${s.bounds.maxBubbles}）` + (s.enabled && s.style ? `；现在 ${s.style.bubbles} 泡、频率×${s.style.chatty}、快慢×${s.style.delay}${s.style.tone ? '、' + s.style.tone : ''}` : '')
      },
    })
    api.command({
      name: '改人设',
      aliases: ['selfedit'],
      desc: '她能不能自己改人设 / QQ·B站·抖音资料：/改人设 开|关|状态',
      run: async (arg) => {
        const v = onOff(String(arg || '').trim())
        if (v !== null) api.setConfig({ selfEditPersona: { enabled: v } })
        const on = api.config().selfEditPersona?.enabled !== false
        return `她自己改人设 / 资料：${on ? '开（照样走自改审计留痕）' : '关（改昵称、签名、头像、抖音主页、人设文件都会被拦）'}`
      },
    })
    return { ...mood, effects: () => style.blend(mood.effects()), style: () => style.state(), bubbleCap: () => style.bubbleCap(), refreshStyle: () => style.refresh() }
  },
}
