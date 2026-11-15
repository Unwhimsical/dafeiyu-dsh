// QQ 里的主人命令：/silent /active 之类，直接在 QQ 上管她。只认主人；在总开关关着时也能用（所以 /on 才有用）。

import { dataDir, readJson, writeJson } from '../core/store.js'

/**
 * 解析命令：「/silent 30」→ { name: 'silent', arg: '30' }。不是命令返回 null。支持全角斜杠和中文别名。
 * extra：扩展模块加的命令 [{ name, aliases, desc, run }]，命中时返回 { name, arg, ext }；和内置同名时扩展的优先。
 */
export function parseCommand(text, extra = []) {
  const m = String(text || '').trim().match(/^[/／]\s*([A-Za-z0-9一-龥_-]+)\s*([\s\S]*)$/)
  if (!m) return null
  const word = m[1].toLowerCase()
  for (const c of extra) {
    const names = [c.name, ...(c.aliases || [])].map((x) => String(x).toLowerCase())
    if (names.includes(word)) return { name: c.name, arg: m[2].trim(), ext: c }
    // 中文命令后面直接跟内容：「/天气北京」
    const pre = names.filter((k) => /[一-龥]/.test(k) && word.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    if (pre) return { name: c.name, arg: (m[1].slice(pre.length) + ' ' + m[2]).trim(), ext: c }
  }
  const name = ALIASES[word] || word
  if (COMMANDS[name]) return { name, arg: m[2].trim() }
  // 中文命令后面不加空格直接跟内容：「/记住我不吃香菜」
  const pre = Object.keys(ALIASES).filter((k) => /[一-龥]/.test(k) && word.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  return pre ? { name: ALIASES[pre], arg: (m[1].slice(pre.length) + ' ' + m[2]).trim() } : null
}

const ALIASES = {
  闭嘴: 'silent', 安静: 'silent', 静音: 'silent', shutup: 'silent', mute: 'silent',
  群静音: 'gmute', 群禁言: 'gmute', 群闭嘴: 'gmute', 群解除静音: 'gunmute', 群说话: 'gunmute', 群静音列表: 'gmutes',
  说话: 'active', 醒醒: 'active', 解除静音: 'active', unmute: 'active',
  少说: 'quiet', 话少: 'quiet',
  多说: 'chatty', 话多: 'chatty',
  正常: 'normal',
  模型: 'model', 换模型: 'model',
  唱: 'sing', 点歌: 'sing', 翻唱: 'sing',
  状态: 'status', 心情: 'mood', 日记: 'diary', 记住: 'remember', 记一下: 'remember',
  重开: 'reset', 开机: 'on', 关机: 'off', 帮助: 'help', 命令: 'help', h: 'help',
}

const COMMANDS = {
  help: '看这份命令列表',
  gmute: '让某个群闭嘴（只主人）：/群静音 [群号|群名|all] [分钟，0=一直]；不带群号 = 在群里就是这个群，私聊里就是全部白名单群',
  gunmute: '解除群静音（只主人）：/群解除静音 [群号|群名|all]',
  gmutes: '看哪些群在静音',
  silent: '在这里闭嘴（可带分钟数，如 /silent 30；不带就一直到 /active）',
  active: '解除闭嘴；在群里还会接着参与话题一会儿',
  quiet: '这个群里只在被叫到时说话，不插话',
  chatty: '这个群里话多一点，更爱插话',
  normal: '这个群恢复默认的插话频率',
  model: '看或换她用的模型：/model 看列表，/model 2 或 /model 名字 换，/model 默认 跟随 DSH',
  sing: '让她翻唱一首：/sing 小幸运 田馥甄；后面加 +12 / -3 之类可以变调（原唱是男声一般 +12）',
  status: '看她现在的状态',
  mood: '看她现在的心情',
  diary: '马上写一篇空间日记',
  remember: '让她记住一件事，如 /remember 我不吃香菜',
  reset: '这个聊天重新开始（旧的对话在 DSH 侧栏里还能找回）',
  on: '打开总开关',
  off: '关掉总开关（之后除了命令什么都不回）',
}

export const commandList = (extra = []) => [
  ...Object.entries(COMMANDS).map(([name, desc]) => ({ name, desc, aliases: Object.keys(ALIASES).filter((k) => ALIASES[k] === name && /[一-龥]/.test(k)) })),
  ...extra.map((c) => ({ name: c.name, desc: c.desc || '', aliases: c.aliases || [], module: c.module || '' })),
]

export function helpText(extra = []) {
  return '主人命令（也可以用中文，如 /闭嘴 /说话）：\n' + Object.entries(COMMANDS).map(([k, v]) => `/${k}  ${v}`).join('\n')
    + (extra.length ? '\n扩展模块加的：\n' + extra.map((c) => `/${c.name}  ${c.desc || ''}`).join('\n') : '')
}

/** 每个聊天的闭嘴状态：chatId → 到什么时候（毫秒，Infinity 写成 0 表示一直）。 */
export function createMutes() {
  const file = () => dataDir('mutes.json')
  const load = () => readJson(file(), {})
  return {
    muted(chatId, now = Date.now()) {
      const m = load()
      if (!(chatId in m)) return false
      if (m[chatId] === 0 || m[chatId] > now) return true
      delete m[chatId]
      writeJson(file(), m)
      return false
    },
    set(chatId, minutes) {
      const m = load()
      m[chatId] = minutes > 0 ? Date.now() + minutes * 60_000 : 0
      writeJson(file(), m)
    },
    clear(chatId) {
      const m = load()
      delete m[chatId]
      writeJson(file(), m)
    },
    until: (chatId) => load()[chatId],
  }
}


/** 群静音：解析「[群号|群名|all] [分钟]」→ 目标群号列表 + 分钟。群名按 get_group_list 模糊匹配（只在白名单群里找）。 */
async function resolveGroups(arg, msg, deps) {
  const cfg = deps.getConfig()
  const allowed = (cfg.allow?.groups || []).map(String)
  const words = String(arg || '').trim().split(/\s+/).filter(Boolean)
  let minutes = null
  const rest = []
  for (const w of words) {
    if (/^\d{1,5}$/.test(w) && minutes === null) minutes = Number(w)
    else rest.push(w)
  }
  const key = rest.join(' ')
  if (!key) return { gids: msg.kind === 'group' ? [String(msg.groupId)] : allowed, minutes }
  if (/^(all|全部|所有)$/i.test(key)) return { gids: allowed, minutes }
  const nums = key.match(/\d{5,}/g)
  if (nums) return { gids: nums, minutes }
  try {
    const list = (await deps.onebot?.call?.('get_group_list', {})) || []
    const arr = Array.isArray(list) ? list : list.data || []
    const hit = arr.filter((g) => allowed.includes(String(g.group_id)) && String(g.group_name || '').includes(key.replace(/群$/, '')))
    if (hit.length) return { gids: hit.map((g) => String(g.group_id)), minutes }
  } catch {}
  return { gids: [], minutes, miss: key }
}
const untilText = (u) => { if (u === 0) return '一直（等主人解除）'; const d = new Date(u); const p = (n) => String(n).padStart(2, '0'); return `到 ${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}` }
/** 当前静音中的群（给提示词/跨会话用）：[{ gid, until }] */
export function mutedGroups(mutes) {
  const out = []
  try {
    const m = readJson(dataDir('mutes.json'), {})
    for (const k of Object.keys(m)) if (k.startsWith('group:') && mutes.muted(k)) out.push({ gid: k.slice(6), until: m[k] })
  } catch {}
  return out
}
export function mutedGroupsLine(mutes) {
  const list = mutedGroups(mutes)
  if (!list.length) return ''
  return '【群静音（主人设的）】' + list.map((x) => `群${x.gid} ${untilText(x.until)}`).join('；')
    + '。这些群里你现在发不出任何消息（系统在最底层拦了），也不会主动去说。别人或主人问起来，就照实说「主人让我在那个群先别说话」，不要说自己没被静音、也不要说「我没说」。'
}


const FAREWELLS = ['我先去忙会儿啦，回头见～', '有点事先撤啦，你们聊～', '我去吃点东西，先溜了', '困了困了，先去歇会儿，拜拜～', '先下线一会儿，晚点见']
/** t166：主人让她在群里别说话时的道别句：模型想一句自然的由头（不提主人、不提静音），想不出来就用兜底句。 */
async function farewellLine(deps) {
  try {
    if (typeof deps.ask === 'function') {
      const h = new Date().getHours()
      const t = await Promise.race([
        deps.ask({ system: '你是大肥鱼，一个说话自然、口语化的女孩子，正在一个 QQ 群里。', text: `现在 ${h} 点。你要先离开这个群一阵子：用一句自然的口语找个由头跟大家道别（比如要去忙、去吃饭、困了、要出门），15 个字左右。不要提有人让你别说话，不要提静音、命令、机器人、AI。只输出这一句。`, maxTokens: 800, temperature: 0.8 }),
        new Promise((r) => setTimeout(() => r(''), 12000)),
      ])
      const line = String(t || '').replace(/^["「『]|["」』]$/g, '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
      if (line && line.length <= 40 && !/(静音|命令|闭嘴|主人|机器人|AI)/i.test(line)) return line
    }
  } catch {}
  return FAREWELLS[Math.floor(Math.random() * FAREWELLS.length)]
}

/**
 * 执行命令，返回要回给主人的话。
 * @param {object} deps { getConfig, setConfig, mutes, hub, mood, memory, qzone, onebot }
 */
export async function runCommand(cmd, msg, deps) {
  const { getConfig, setConfig, mutes, hub, mood, memory, qzone } = deps
  const cfg = getConfig()
  const inGroup = msg.kind === 'group'
  const here = inGroup ? '这个群' : '这里'
  const setGroup = (patch) => {
    const overrides = { ...(cfg.group.overrides || {}) }
    if (patch === null) delete overrides[msg.groupId]
    else overrides[msg.groupId] = { ...(overrides[msg.groupId] || {}), ...patch }
    setConfig({ ...cfg, group: { ...cfg.group, overrides } })
  }
  switch (cmd.name) {
    case 'help':
      return helpText(deps.extraCommands || [])
    case 'gmute': {
      if (msg.delegate) return '/群静音 只有主人能用'
      const { gids, minutes, miss } = await resolveGroups(cmd.arg, msg, deps)
      if (!gids.length) return miss ? `没找到叫「${miss}」的白名单群` : '没有可静音的群'
      const min = Math.max(0, Math.min(30 * 24 * 60, minutes ?? Number(cfg.group?.muteDefaultMin ?? 60)))
      // t166：先在群里找个由头道别（一句，像人一样），再静音；静音后所有模块的发送都在最底层被拦（hub.sendSegments / deliver）
      const names = []
      let farewellHere = ''
      for (const g of gids) {
        const already = mutes.muted('group:' + g)
        let nm = ''
        try { nm = (await hub.groupName?.(g)) || '' } catch {}
        names.push(nm ? '「' + nm + '」' : '那个群')
        if (!already && gids.length <= 3) {
          const bye = await farewellLine(deps)
          if (inGroup && String(msg.groupId) === String(g)) farewellHere = bye // 群里 @ 她：道别就是这条命令的回执（force 发，不会被刚设的静音拦）
          else { try { await hub.sendText?.('group:' + g, bye) } catch {} }
        }
        mutes.set('group:' + g, min); hub.leaveTopic?.(g)
      }
      mood?.nudge?.(-4, '主人让她在群里别说话')
      if (farewellHere) return farewellHere
      return `好，在${names.join('、')}道过别了，先不说话` + (min ? ` ${min} 分钟` : '，等你解除') 
    }
    case 'gunmute': {
      if (msg.delegate) return '/群解除静音 只有主人能用'
      const { gids, miss } = await resolveGroups(cmd.arg, msg, deps)
      if (!gids.length) return miss ? `没找到叫「${miss}」的白名单群` : '没有静音中的群'
      for (const g of gids) mutes.clear('group:' + g)
      return `好，${gids.map((g) => '群' + g).join('、')} 可以说话了`
    }
    case 'gmutes': {
      const list = mutedGroups(mutes)
      return list.length ? '静音中的群：\n' + list.map((x) => `群${x.gid}：${untilText(x.until)}`).join('\n') : '没有群在静音'
    }
    case 'silent': {
      const min = Math.max(0, Math.min(7 * 24 * 60, Number.parseInt(cmd.arg, 10) || 0))
      mutes.set(msg.chatId, min)
      mood?.nudge?.(-6, '主人让她闭嘴') // 有点委屈
      if (inGroup) hub.leaveTopic?.(msg.groupId)
      return min ? `好，我在${here}安静 ${min} 分钟` : `好，我在${here}先不说话了，想我了发 /active`
    }
    case 'active':
      mutes.clear(msg.chatId)
      mood?.nudge?.(4, '主人让她回来说话')
      if (inGroup) hub.joinTopic?.(msg.groupId)
      return inGroup ? '我回来啦' : '在呢'
    case 'quiet':
      if (!inGroup) return '这个命令要在群里用'
      setGroup({ interjectChance: 0 })
      return '好，这个群里没人叫我我就不插话'
    case 'chatty':
      if (!inGroup) return '这个命令要在群里用'
      setGroup({ interjectChance: 0.4, minRelevance: 0.1 })
      return '好耶，那我在这个群多说两句'
    case 'normal':
      if (!inGroup) return '这个命令要在群里用'
      setGroup(null)
      return '好，按平常的样子来'
    case 'status': {
      const st = hub.stats()
      const mu = mutes.until(msg.chatId)
      const lines = [
        `总开关：${cfg.enabled ? '开' : '关'}${cfg.dryRun ? '（试运行，不真发）' : ''}`,
        ...(mood && cfg.mood?.enabled !== false ? [`心情：${mood.label()}`] : []), // 单维心情停用：关着就不报
        `今天：收到 ${st.received} 条，发出 ${st.sent} 条`,
        `${here}：${mu === undefined ? '正常说话' : mu === 0 ? '闭嘴中' : '闭嘴到 ' + new Date(mu).toLocaleTimeString().slice(0, 5)}`,
      ]
      if (inGroup) {
        const o = (cfg.group.overrides || {})[msg.groupId] || {}
        lines.push(`插话：${o.interjectChance === 0 ? '不插话' : o.interjectChance >= 0.4 ? '话多' : '默认'}`)
      }
      return lines.join('\n')
    }
    case 'model': {
      const list = deps.listModels ? await deps.listModels() : []
      const cur = cfg.model.provider && cfg.model.model ? cfg.model : null
      const label = (m) => (m.name && m.name !== m.model ? `${m.name}（${m.model}）` : m.model)
      if (!cmd.arg) {
        const def = deps.defaultModel?.()
        const head = cur ? `现在用的：${cur.model}` : `现在跟随 DSH 默认${def ? '：' + def.model : ''}`
        if (!list.length) return head + '\n（拿不到模型列表）'
        return head + '\n' + list.slice(0, 20).map((m, i) => `${i + 1}. ${label(m)}${cur && m.provider === cur.provider && m.model === cur.model ? '  ← 当前' : ''}`).join('\n') + '\n发 /model 序号 换，/model 默认 跟随 DSH'
      }
      if (/^(默认|default|auto|跟随)$/i.test(cmd.arg)) {
        setConfig({ ...cfg, model: { ...cfg.model, provider: '', model: '' } })
        return '好，换回跟随 DSH 的默认模型，下一句起生效'
      }
      const n = Number.parseInt(cmd.arg, 10)
      const q = cmd.arg.toLowerCase()
      const hit = String(n) === cmd.arg ? list[n - 1]
        : list.find((m) => m.model.toLowerCase() === q || String(m.name).toLowerCase() === q) || list.find((m) => m.model.toLowerCase().includes(q) || String(m.name).toLowerCase().includes(q))
      if (!hit) return `没找到「${cmd.arg}」这个模型，发 /model 看列表`
      setConfig({ ...cfg, model: { ...cfg.model, provider: hit.provider, model: hit.model } })
      return `好，换成 ${label(hit)} 了，下一句起生效`
    }
    case 'sing': {
      if (!deps.song) return '翻唱功能不可用'
      // 末尾的 +12 / -3 是变调
      const m = cmd.arg.match(/^(.*?)\s+([+-]\d{1,2})$/)
      const name = (m ? m[1] : cmd.arg).trim()
      if (!name) return '唱哪首？比如 /sing 小幸运 田馥甄'
      return deps.song.request({ song: name, pitch: m ? Number(m[2]) : undefined, chatId: msg.chatId }).message
    }
    case 'mood':
      return mood && cfg.mood?.enabled !== false ? `现在${mood.label()}` : '单维心情已经停用了，她的情绪看「记忆星海」里的 10 维'
    case 'diary': {
      if (!qzone) return '空间日记没开'
      const r = await qzone.writeDiary()
      return r.ok ? (r.dryRun ? '写好了，不过现在是试运行，没真发' : '写好发出去啦，去空间看看') : '没写成：' + (r.message || '不知道为啥')
    }
    case 'remember': {
      if (!cmd.arg) return '要我记住什么呀？比如 /remember 我不吃香菜'
      // 记忆只走记忆星海（星图）：内置记忆模块已停用，优先交给 memcore
      const mc = deps.memcore
      if (mc && typeof mc.remember === 'function') {
        try {
          await mc.remember(cmd.arg, { kind: 'fact', importance: 0.8, visibility: 'private', owner: String(cfg.ownerQQ || ''), meta: { source: 'command', chatId: msg.chatId } })
          return '记住了（记进记忆星海）'
        } catch (e) { return '没记上：' + String(e?.message || e).slice(0, 80) }
      }
      if (!memory) return '记忆星海没连上，记不了'
      const r = memory.add({ text: cmd.arg, aboutName: cfg.ownerName || '主人', about: cfg.ownerQQ, importance: 0.8, source: 'panel', chatId: msg.chatId })
      return r.ok ? '记住了' : '没记上：' + (r.message || '')
    }
    case 'reset':
      hub.resetChat(msg.chatId)
      return '好，我们重新开始'
    case 'on':
      setConfig({ ...cfg, enabled: true })
      return cfg.dryRun ? '总开关打开了（现在是试运行，我说的话只进日志）' : '我上线啦'
    case 'off':
      setConfig({ ...cfg, enabled: false })
      return '好，我先下线了。发 /on 叫我回来'
    default:
      return null
  }
}
