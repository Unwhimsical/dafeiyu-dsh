// 语音自知 + 情绪驱动语气：把当前心情写给 Breeze 代理，并让她知道自己发的是语音
import fs from 'node:fs'

const DIR = process.env.QQ_WORKDIR || 'qq'
const MOOD_FILE = DIR + '\\breeze-mood.json'

function writeJson(f, v) {
  try { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f) } catch {}
}
// 情绪单一来源：只读星图 10 维发布的体感值（globalThis.__dfyStyle.felt，0–100，已去掉 18+ 维度），不自己拉 /api/body、不存情绪
function pickMood(f) {
  if (!f) return 'calm'
  const g = (k) => Math.max(0, Math.min(100, Number(f[k]) || 0)) / 100
  const joy = g('开心'), bliss = g('满足'), sad = g('被冷落'), angry = Math.max(g('生气'), g('黑化'))
  if (angry >= 0.55) return 'angry'
  if (sad >= 0.25 && sad > joy) return 'sad'
  if (joy + bliss >= 0.9) return 'happy'
  return 'calm'
}

export default {
  id: 'voice-self',
  name: '语音自知 · 语气',
  version: '1.0.0',
  api: 1,
  description: '让她知道自己发的是语音条，并把星图 10 维情绪（只读）交给语音代理决定音色与语气',
  defaults: { enabled: true, everyMinutes: 2 },
  settings: [
    { key: 'enabled', label: '启用语音自知', type: 'boolean' },
    { key: 'everyMinutes', label: '多久同步一次心情', type: 'number', min: 1, max: 30 },
  ],
  setup(api) {
    const cfg = () => ({ ...api.settings() })

    async function pull() {
      const c = cfg()
      if (!c.enabled) return null
      const st = globalThis.__dfyStyle
      const fresh = st && st.felt && Date.now() - Number(st.at || 0) < 15 * 60_000
      const mood = pickMood(fresh ? st.felt : null)
      writeJson(MOOD_FILE, { mood, at: Date.now(), from: fresh ? 'starmap' : 'default' })
      return mood
    }

    api.every(Math.max(1, Number(cfg().everyMinutes) || 2) * 60_000, () => { pull() }, '心情同步')
    api.later(6000, () => { pull() })

    // 让她知道自己刚才用的是语音
    api.on('prompt', (content, info) => {
      const t = String((info && info.queryText) || '')
      if (!/语音|声音|说话|听听|听一下|念|嗓子/.test(t)) return content
      return [
        { type: 'text', text: '【提醒你自己】你刚才给主人发的是**语音条**（用你自己的嗓子念出来的，不是打字）。主人听到的就是你说的。别说「我发的是文字」或「我没法发语音」。' },
        ...content,
      ]
    })

    api.rule((kind) => {
      if (kind === 'system') return ''
      return '你发出去的可能是语音条：如果是语音，那就是你自己的声音，不是文字。主人问「你是不是发语音了」时，承认即可，别否认。'
    })

    api.command({
      name: '语音心情',
      aliases: ['voicemood'],
      desc: '看看语音代理现在用的心情（来自星图 10 维）和今日语音额度',
      async run() {
        const m = await pull()
        let b = {}
        try { b = JSON.parse(fs.readFileSync(DIR + '\\breeze-budget.json', 'utf8')) } catch {}
        return '现在心情：' + (m || '未知') + '｜今日语音额度：' + (b.used || 0) + '/' + (b.limit || 4000) + ' units'
      },
    })

    api.log.info('语音自知已就绪（心情文件 ' + MOOD_FILE + '）')
  },
}
