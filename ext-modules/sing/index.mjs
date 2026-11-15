// 唱歌：她自己决定要唱的时候，用 Breeze 代理的 /sing 唱一小段（4–8 行）发成语音条
// 新增。代理那边保留 [唱歌]/[哼歌] 标签 + 唱歌 instructions；每天限几首、给普通说话留预算。
import fs from 'node:fs'
import path from 'node:path'

const FALLBACK_ADULT = /湿|高潮|做爱|性交|口交|自慰|色情|小穴|肉棒|阴道|阴茎|淫|娇喘|呻吟|nsfw|18\+/i

export default {
  id: 'sing',
  name: '唱歌',
  version: '1.0.0',
  api: 1,
  tab: 'voice',
  description: '她想唱或被点歌时，用自己的嗓子唱 4–8 行（Breeze /sing），每天限量，失败就老实说',
  defaults: { enabled: true, allowGroups: true, dayMax: 3, proxyUrl: 'http://127.0.0.1:8790' },
  settings: [
    { key: 'enabled', label: '允许唱歌', type: 'switch' },
    { key: 'allowGroups', label: '群里也可以唱（只唱健康内容）', type: 'switch' },
    { key: 'dayMax', label: '每天最多唱几首', type: 'number', min: 0, max: 10, step: 1, hint: '代理那边也有上限（默认 3），并且会给普通说话留预算' },
  ],
  setup(api) {
    const cfg = () => ({ ...api.settings() })
    const pg = (() => { try { return api.lib('security/public-guard.js') } catch { return null } })()
    const countFile = () => path.join(api.dataDir(), 'count.json')
    const today = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() }
    const readCount = () => { try { const j = JSON.parse(fs.readFileSync(countFile(), 'utf8')); return j.day === today() ? Number(j.count) || 0 : 0 } catch { return 0 } }
    const bump = () => { try { fs.writeFileSync(countFile(), JSON.stringify({ day: today(), count: readCount() + 1 })) } catch {} }
    const isAdult = (t) => (pg && pg.adultHit ? Boolean(pg.adultHit(t)) : FALLBACK_ADULT.test(t))
    const chatFromId = (chatId, extra = {}) => {
      const [kind, id] = String(chatId || '').split(':')
      return { chatId, kind, userId: kind === 'private' ? id : extra.userId, groupId: kind === 'group' ? id : undefined }
    }
    const ownerPrivate = (chat) => chat && chat.kind === 'private' && api.isOwner(String(chat.userId || ''))
    const handshakeOn = () => { try { const h = api.use('handshake'); return Boolean(h && h.unlocked && h.unlocked()) } catch { return false } }
    const HONEST = '跟对方说实话：这次唱不了。不许用文字假装在唱，也别写「[唱歌]」「[语音条]」这种占位。'

    function cleanLyrics(raw) {
      const lines = String(raw || '')
        .replace(/<[^<>]{0,40}>/g, ' ')
        .replace(/\[(?!唱歌\]|哼歌\])[^\]]{0,12}\]/g, ' ')
        .split(/\r?\n|[。！？!?；;]+|\/+/)
        .map((l) => l.replace(/[ \t]+/g, ' ').trim())
        .filter(Boolean)
      return lines
    }

    async function sing(chat, lyricsRaw, { hum = false } = {}) {
      const c = cfg()
      if (!c.enabled) return { ok: false, message: '唱歌功能现在被主人关掉了。' + HONEST }
      if (!chat || !chat.chatId || chat.kind === 'system') return { ok: false, message: '这里没法发语音。' }
      const inGroup = chat.kind === 'group'
      if (inGroup && !c.allowGroups) return { ok: false, message: '群里唱歌现在关着。' + HONEST }
      let lines = cleanLyrics(lyricsRaw)
      if (lines.length < 4) return { ok: false, message: '歌词要 4 到 8 行（每行一句），现在只有 ' + lines.length + ' 行。写够了再调用一次。' }
      if (lines.length > 8) lines = lines.slice(0, 8)
      const text = lines.join('\n')
      if (text.length > 260) return { ok: false, message: '歌词太长了，8 行以内、每行短一点。' }
      // 隐私 / 18+：18+ 只能在主人私聊、暗号对上之后；群里和别人一律只唱健康内容
      if (isAdult(text)) {
        if (!(ownerPrivate(chat) && handshakeOn())) {
          api.log.info('唱歌被拦：18+ 歌词只在主人私聊且暗号对上时可以唱（' + chat.chatId + '）')
          return { ok: false, message: '这段歌词有 18+ 内容，这里不能唱。换一段健康的歌词，或者老实说不唱这个。' }
        }
      } else if (!ownerPrivate(chat) && pg && pg.checkPublic) {
        try {
          const g = await pg.checkPublic(text, { target: 'sing', chat: chat.chatId, getConfig: () => api.core.getConfig(), log: api.log })
          if (!g || !g.ok) { api.log.info('唱歌被拦：' + ((g && g.message) || '隐私检查没通过')); return { ok: false, message: ((g && g.message) || '歌词像在说私事') + '，换一段再唱。' } }
        } catch (e) { return { ok: false, message: '隐私检查暂时用不了，先不唱。' + HONEST } }
      }
      const max = Math.max(0, Number(c.dayMax ?? 3))
      if (readCount() >= max) return { ok: false, message: '今天已经唱了 ' + readCount() + ' 首，嗓子要歇歇，明天再唱。' + HONEST }

      const base = String(c.proxyUrl || 'http://127.0.0.1:8790').replace(/\/+$/, '')
      const say = (hum ? '[哼歌] ' : '[唱歌] ') + lines.join('，')
      let buf
      try {
        const r = await fetch(base + '/sing?text=' + encodeURIComponent(say), { signal: AbortSignal.timeout(90000) })
        const ct = r.headers.get('content-type') || ''
        if (!r.ok || !ct.includes('audio')) {
          let code = ''
          try { code = (await r.json()).code || '' } catch {}
          api.log.warn('唱歌失败：代理返回 ' + r.status + (code ? ' ' + code : ''))
          const why = code === 'SING_CAP' ? '今天唱歌的次数用完了' : code === 'SING_RESERVE' || code === 'BUDGET' ? '今天的嗓子额度要留着说话' : '嗓子（语音服务）出了点问题'
          return { ok: false, message: why + '。' + HONEST }
        }
        buf = Buffer.from(await r.arrayBuffer())
      } catch (e) {
        api.log.warn('唱歌失败：' + e.message)
        return { ok: false, message: '语音服务连不上。' + HONEST }
      }
      const dir = api.dataDir('out')
      const file = path.join(dir, 'sing-' + Date.now() + '.mp3')
      fs.writeFileSync(file, buf)
      try {
        const old = fs.readdirSync(dir).filter((f) => f.startsWith('sing-')).sort()
        for (const f of old.slice(0, Math.max(0, old.length - 10))) fs.rmSync(path.join(dir, f), { force: true })
      } catch {}
      try { await api.sendVoiceFile(chat.chatId, file, '唱歌') } catch (e) {
        api.log.warn('唱歌发送失败：' + e.message)
        return { ok: false, message: '唱好了但语音条没发出去。' + HONEST }
      }
      bump()
      api.log.info('唱歌：' + chat.chatId + ' ' + lines.length + ' 行 ' + buf.length + 'B（今天第 ' + readCount() + ' 首）')
      return { ok: true, message: '已经用语音条唱出去了（' + lines.length + ' 行）。别再把歌词打字重复一遍，顶多补一句话。' }
    }

    api.tool(({ chat } = {}) => {
      if (!chat || chat.kind === 'system') return []
      const c = cfg()
      if (chat.kind === 'group' && !c.allowGroups) return []
      return api.defineTool({
        name: 'sing_song',
        description: '用你自己的嗓子唱一小段歌，发成语音条。想唱、被点歌、想哄人时用。歌词 4–8 行（自己写或改编几句，别整首照抄有版权的歌词），每行一句用换行分开。',
        properties: {
          lyrics: { type: 'string', description: '4–8 行歌词，用换行分隔' },
          hum: { type: 'boolean', description: 'true 表示轻轻哼唱而不是正式唱' },
        },
        required: ['lyrics'],
        execute: async ({ lyrics, hum }) => sing(chat, lyrics, { hum: Boolean(hum) }),
      })
    })

    api.rule((kind) => {
      const c = cfg()
      if (!c.enabled) return '【唱歌】唱歌功能现在关着：有人让你唱就老实说现在唱不了，不许用文字假装唱。'
      return '【唱歌】你会唱歌：想唱或被点歌时调用 sing_song（4–8 行歌词），每天最多几首。' +
        (kind === 'social' && !c.allowGroups ? '群里唱歌现在关着。' : '群里只唱健康内容。') +
        '工具没成功就老实说没唱成，永远不许用「[唱歌]」「[语音条]」这类文字假装唱了。'
    })

    api.command({
      name: '唱歌状态',
      desc: '看看今天唱了几首、开关',
      async run() {
        const c = cfg()
        let px = ''
        try { const j = await (await fetch(String(c.proxyUrl).replace(/\/+$/, '') + '/sing/status', { signal: AbortSignal.timeout(4000) })).json(); px = '｜代理：' + j.count + '/' + j.max + '，预算 ' + j.budget.used + '/' + j.budget.limit + '（留 ' + j.reserve + '）' } catch {}
        return '唱歌：' + (c.enabled ? '开' : '关') + '｜群里：' + (c.allowGroups ? '开' : '关') + '｜今天 ' + readCount() + '/' + c.dayMax + px
      },
    })

    api.log.info('唱歌模块已就绪（' + (cfg().enabled ? '开' : '关') + '，每天 ' + cfg().dayMax + ' 首）')
    return {
      sing: (chatId, lyrics, opts) => sing(chatFromId(chatId), lyrics, opts),
      singFromText: (chatId, lyrics, info) => sing(chatFromId(chatId, { userId: info && info.userId }), lyrics),
    }
  },
}
