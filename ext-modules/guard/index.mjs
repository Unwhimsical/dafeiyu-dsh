// 出站守卫：她偶尔会把「内心提示」原文念出来（带【】的那些），这里是最后一道闸。
// 只改文字，不动语音/表情/图片。
export default {
  id: 'guard',
  name: '说话守卫',
  version: '1.0.0',
  api: 1,
  description: '把漏出来的内部提示（【…】段落、注入行）从发出去的消息里剪掉',
  defaults: { enabled: true, logStrip: true },
  settings: [
    { key: 'enabled', label: '启用', type: 'boolean', hint: '关掉就不剪了' },
    { key: 'logStrip', label: '剪掉时记一条日志', type: 'boolean' },
  ],

  setup(api) {
    const cfg = () => ({ ...(api.settings() || {}) })

    // 这些是注入块的标记，出现就说明她把自己的内部提示念出来了
    const MARK = /【[^】]{0,40}】/
    const LINES = [
      /^\s*[-•]\s*刚才在聊[:：]/,
      /^\s*[-•]\s*你突然想起[:：]/,
      /^\s*（下面是你这会儿自己想起/,
      /^\s*（内部/,
      /^\s*【你脑子里/,
    ]

    const DSML_BLOCK = /<[｜|]{2}DSML[｜|]{2}[\s\S]*<\/[｜|]{2}DSML[｜|]{2}[^>]*>/g
const DSML_TAG = /<\/?[｜|]{2}DSML[｜|]{2}[^>]*>/g
const PIPE_TAG = /<\|[^|<>]{1,40}\|>/g
const TOOL_XML = /<\/?[a-zA-Z_][\w:-]*\s*(?:\s+[\w:-]+\s*=\s*"[^"]*")*\s*\/?>/g
function stripToolNoise(text) {
  let t = String(text || '')
  // 先剥成块的 DSML，再剥散落标签；覆盖全角/半角竖线变体
  t = t.replace(DSML_BLOCK, '')
  t = t.replace(DSML_TAG, '')
  t = t.replace(/<\/?[｜|]{1,2}DSML[｜|]{1,2}[^>]*>/gi, '')
  t = t.replace(/DSML\s*(calls|invoke|parameter|parameters|function_calls?)/gi, '')
  t = t.replace(/\b(invoke|function_call|tool_call)\s+name\s*=\s*"[^"]+"/gi, '')
  t = t.replace(PIPE_TAG, '')
  // 剩下的「只有工具调用、没有人话」的段落整段丢掉
  t = t.replace(TOOL_XML, '')
  // 单独一行的 calls/invoke 残余
  t = t.split(/\r?\n/).filter((ln) => !/^\s*(calls|invoke|parameter|<\/?DSML)\b/i.test(ln)).join('\n')
  return t.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}

// —— 成人向内容只允许出现在主人私聊里 ——
const ADULT_WORDS = /(湿润|湿了|湿透|高潮|情欲|发欲|发情|做爱|操你|插进|腿间|胸部|乳头|裸|自慰|内裤|射了|呻吟|色情|黄图|上床|舔|小穴|肉棒|阴道|淫)/i
function isOwnerPrivate(info) {
  try {
    const cfgNow = api.core && api.core.getConfig ? api.core.getConfig() : {}
    const owner = String((cfgNow && cfgNow.ownerQQ) || '')
    if (!owner) return false
    const chat = (info && (info.chat || info)) || {}
    const chatId = String((info && info.chatId) || '')
    const isPrivate = chat.kind === 'private' || chat.type === 'private' || chatId.startsWith('private:')
    const uid = String(chat.userId || chat.uid || (info && info.userId) || chatId.replace(/^private:/, ''))
    return Boolean(isPrivate) && uid === owner
  } catch { return false }
}

// [sticker]/[表情]/<sticker:名> 只是占位符，不能当字发出去
const STICKER_TOKEN = /\[(?:sticker|表情|表情包|图片|语音条|语音消息|语音|voice|audio)\]|<sticker\s*[:：]\s*[^<>]{1,20}>/gi
function stripSticker(text) { return String(text || '').replace(STICKER_TOKEN, '').replace(/[ \t]{2,}/g, ' ').trim() }
const EMOJI_MAP = { 捂脸:'😅', 笑哭:'😂', 笑:'😄', 大笑:'😆', 哭:'😭', 害羞:'😳', 脸红:'😊', 爱心:'❤️', 心:'❤️', 比心:'🫰', 生气:'😤', 无语:'😑', 疑惑:'🤔', 震惊:'😲', 委屈:'🥺', 撒娇:'🥺', 困:'😪', 睡:'😴', 抱抱:'🤗', 亲亲:'😘', 加油:'💪', 赞:'👍', 鼓掌:'👏', 白眼:'🙄', 叹气:'😮‍💨', 汗:'😅', 星星:'✨', 玫瑰:'🌹', 语音条:'', 语音消息:'', 语音:'' }
function cnTags(t){ return String(t||'').replace(/\[[^\]]{1,12}\]/g, '') }
// 公开场合（说说/朋友圈/签名/群）软化成人暗示：不删内容，只把暗示词换成温和说法
const SOFT = [
  [/脸红(了|得)?(好几回|半天)?/g, '心里热了一下'],
  [/心口发烫|胸口发烫|心里发烫/g, '心里暖了一下'],
  [/心跳(漏了半拍|加快|很快)/g, '心跳快了一下'],
  [/腿软|腰软/g, '有点没力气'],
  [/发烫|滚烫/g, '暖暖的'],
  [/喘不过气|喘息/g, '呼吸乱了'],
  [/贴着我|缠着我|搂着我/g, '黏着我'],
  [/听得我耳朵发热/g, '听得我不好意思'],
]
function softenPublic(text) {
  let t = String(text || '')
  for (const [re, to] of SOFT) t = t.replace(re, to)
  return t
}

function scrub(text) {
  text = stripSticker(cnTags(stripToolNoise(text)))
      let s = String(text || '')
      if (!s) return s
      if (!MARK.test(s) && !LINES.some((re) => re.test(s))) return s
      // 整行是注入内容 → 删掉整行
      const kept = s.split(/\r?\n/).filter((ln) => !LINES.some((re) => re.test(ln)))
      s = kept.join('\n')
      // 行内还剩【…】→ 直接剪掉那一段
      s = s.replace(/【[^】]{0,80}】/g, '')
      s = s.replace(/带【】的段落[^\n]{0,60}/g, '')
      return s.replace(/\n{3,}/g, '\n\n').trim()
    }

    api.on('send', (message, info) => {
      // 原来写死主人号；改成按 config.ownerQQ 判（换号/换主人不再失效）
      const _pub = !isOwnerPrivate(info)
      try {
        if (cfg().enabled === false) return message
        if (Array.isArray(message) && !isOwnerPrivate(info)) {
          const joined = message.map((x) => (x && x.type === 'text' && x.data && x.data.text) || '').join(' ')
          if (ADULT_WORDS.test(joined)) {
            api.log.warn('说话守卫：非主人私聊出现成人向内容，已拦下（chat ' + ((info && info.chatId) || '?') + '）')
            return null
          }
        }
        if (!Array.isArray(message)) return message
        let changed = 0
        const out = []
        for (const seg of message) {
          if (seg && seg.type === 'text' && seg.data && typeof seg.data.text === 'string') {
            const before = seg.data.text
            const after = _pub ? softenPublic(scrub(before)) : scrub(before)
            if (after !== before) {
              changed += 1
              if (!after) continue
              out.push({ ...seg, data: { ...seg.data, text: after } })
              continue
            }
          }
          out.push(seg)
        }
        if (changed && cfg().logStrip !== false) {
          api.log.info(`说话守卫：剪掉了 ${changed} 段内部提示（chat ${(info && info.chatId) || '?'}）`)
        }
        if (!out.length) {
          // 整条都是工具调用噪声：不发送占位符，也不要让「…」污染聊天节奏。
          // 历史写入由 hub 侧配合（见工作副本注释）；这里明确吞掉。
          const raw = message.map((x) => (x && x.type === 'text' && x.data && x.data.text) || '').join(' ')
          if (/DSML|calls>|invoke|function_call|tool_call/i.test(raw)) {
            api.log.warn('说话守卫：整条都是工具调用噪声，已丢弃不发送（chat ' + ((info && info.chatId) || '?') + '）')
          }
          return null
        }
        return out
      } catch {
        return message
      }
    })

    api.rule(() => '带【】的段落是你脑子里的内部状态，永远不要念出来；直接说你自己的话。')
    api.rule(() => '成人向的内容（身体细节、性、湿润/欲望这类）只能在你和主人的私聊里出现；群里、别人私聊、空间、签名、抖音任何地方都不许提，一个字都不行。')

    api.log.info('说话守卫已就绪')
  },
}
