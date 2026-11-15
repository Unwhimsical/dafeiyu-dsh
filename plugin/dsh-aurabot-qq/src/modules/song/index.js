// 内置模块：翻唱。点歌 → 网易云下载 → 分离人声 → RVC 换成她的音色 → 混音 → 发语音条。
// 换声这一步可以在「本地接口」里接你自己的推理（so-vits-svc、自己训练的 RVC……）；整个模块也可以替换掉。

import { createSongStudio, checkRoot, listDrives } from '../../song/studio.js'
import { createShortSing } from '../../song/short-sing.js'
import { defineTool, str, int } from '../../tools/tools.js'

export default {
  id: 'song',
  name: '翻唱',
  version: '1.0.0',
  description: '唱歌（合并）：翻唱整首（qq_song_cover、/sing，RVC）+ 用自己嗓子唱 4–8 行（sing_song，Breeze /sing，原「唱歌」扩展并进来）',
  tab: 'song',
  files: ['song/studio.js', 'song/short-sing.js'],
  setup(api) {
    const { hub, local, http } = api.core
    const mood = api.lazy('mood')
    const memory = api.lazy('memory')
    const song = createSongStudio({
      local,
      getConfig: api.config,
      log: api.log,
      sendVoiceFile: (chatId, file, note) => hub.sendVoiceFile(chatId, file, note),
      sendText: (chatId, text) => hub.sendText(chatId, text),
      onSung: (title, chatId) => {
        const cfg = api.config()
        mood.nudge?.(8, `唱完了「${title}」`)
        // 唱过的歌记成她的经历：私聊记到对方头上
        const uid = String(chatId).startsWith('private:') ? String(chatId).slice(8) : ''
        const who = uid === String(cfg.ownerQQ) ? cfg.ownerName || '主人' : uid ? '对方' : '群里'
        memory.addEvent?.({ text: `给${who}唱了《${title}》`, about: uid, tags: ['唱歌'], importance: 0.5 })
        api.emit('song/sung', { title, chatId })
      },
    })

    // ---- 唱一小段（原「唱歌」扩展 sing 并进来；配置 config.song.short）----
    const short = createShortSing({
      getConfig: api.config,
      log: api.log,
      sendVoiceFile: (chatId, file, note) => hub.sendVoiceFile(chatId, file, note),
      isOwner: (uid) => String(uid) === String(api.config().ownerQQ),
      handshakeOn: () => { try { const h = api.use('handshake'); return Boolean(h && h.unlocked && h.unlocked()) } catch { return false } },
    })
    api.tool(({ chat } = {}) => {
      const c = short.cfg()
      if (!c.enabled || !chat || chat.kind === 'system') return []
      if (chat.kind === 'group' && !c.allowGroups) return []
      return defineTool({
        name: 'sing_song',
        description: '用你自己的嗓子唱一小段歌，发成语音条。想唱、被点歌、想哄人时用。歌词 4–8 行（自己写或改编几句，别整首照抄有版权的歌词），每行一句用换行分开。',
        properties: {
          lyrics: { type: 'string', description: '4–8 行歌词，用换行分隔' },
          hum: { type: 'boolean', description: 'true 表示轻轻哼唱而不是正式唱' },
        },
        required: ['lyrics'],
        execute: async ({ lyrics, hum }) => short.sing(chat, lyrics, { hum: Boolean(hum) }),
      })
    })
    api.rule((kind) => {
      const c = short.cfg()
      if (!c.enabled) return '【唱歌】唱一小段现在关着：有人让你唱就老实说现在唱不了，不许用文字假装唱。'
      return '【唱歌】你会唱歌：想唱或被点歌时调用 sing_song（4–8 行歌词），每天最多几首。' +
        (kind === 'social' && !c.allowGroups ? '群里唱歌现在关着。' : '群里只唱健康内容。') +
        '工具没成功就老实说没唱成，永远不许用「[唱歌]」「[语音条]」这类文字假装唱了。'
    })
    api.command({ name: '唱歌状态', desc: '看看今天唱了几首、开关', run: async () => short.status() })
    api.route('/song/short/status', async () => ({ ok: true, text: await short.status(), count: short.readCount(), ...short.cfg() }))

    // 面板里打开了才给她（没开就别让她答应唱歌）
    api.tool(({ chat, sessionId }) => (api.config().song.enabled && chat.kind !== 'system' ? defineTool({
      name: 'qq_song_cover',
      description: '用你自己的声音翻唱一首歌，做好后自动以语音条发到当前聊天（要两三分钟，调用后先简单回一句「等我一下」就好）。song 写歌名，最好带上歌手，比如「小幸运 田馥甄」。pitch 是变调半音：你是女声，原唱是男声时一般 +12，原唱是女声时 0。',
      properties: { song: str('歌名（可以带歌手）'), pitch: int('变调半音：原唱男声 +12，女声 0') },
      required: ['song'],
      slow: '好，我这就去弄，稍等一会儿（做好了发你）。',
      execute: async ({ song: name, pitch }) => {
        if (api.config().song.ownerOnly && !hub.turnHasOwner(sessionId)) return { ok: false, message: '只有主人能点歌' }
        return song.request({ song: name, pitch, chatId: chat.chatId })
      },
    }) : []))

    api.route('/song/status', async () => ({ ok: true, ...song.status() }))
    api.route('/song/install', async () => song.install())
    api.route('/song/root/check', async (req) => ({ ok: true, ...checkRoot(http.query(req).path || '') }))
    api.route('/song/drives', async () => ({ ok: true, list: listDrives() }))
    api.route('/song/search', async (req) => {
      try { return { ok: true, list: await song.search(http.query(req).q || '') } } catch (error) { return { ok: false, message: error.message, list: [] } }
    })
    api.route('/song/account', async () => song.account())
    // 导入音色：面板把文件原样传上来（.zip / .pth / .index），文件名放在 ?name= 里
    api.route('/song/import', async (req) => {
      const name = http.query(req).name || ''
      try {
        const buf = await http.raw(req, 1024 * 1024 * 1024)
        if (!buf.length) return { ok: false, message: '文件是空的' }
        const r = song.importModels(name, buf)
        if (r.ok) api.log.info('导入音色：' + r.message)
        return r
      } catch (error) {
        return { ok: false, message: '导入失败：' + error.message }
      }
    })
    api.route('/song/voice/delete', async (req) => song.deleteVoice(String((await http.body(req)).id || '')))
    // 面板里试唱：发到主人私聊
    api.route('/song/request', async (req) => {
      const b = await http.body(req)
      return song.request({ song: b.song, songId: b.songId, pitch: b.pitch, voice: b.voice, chatId: b.chatId || `private:${api.config().ownerQQ}` })
    })
    // 给别的模块用：sing / singFromText 跟原「唱歌」扩展的导出一样（media 的 [唱歌] 走这里）
    return Object.assign(song, { sing: short.singAt, singFromText: short.singFromText, shortStatus: short.status })
  },
}
