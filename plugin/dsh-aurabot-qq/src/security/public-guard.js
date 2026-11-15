// 公开输出守卫：任何「别人看得见」的输出（QQ 空间说说 / 评论、QQ 昵称签名、B 站评论签名、
// 抖音评论 / 作品文案 / 主页 / 群聊 / 私信、小黑盒评论发帖、群里主动发言）发出去之前过一遍：
//   1. 18+ 硬拦：命中成人词一律不发（18+ 只许在主人 QQ 私聊里出现）；
//   2. 私密泄漏检查：问大脑 /guard（chat=system 或目标群），对比「这个场合看不见的记忆」，
//      和主人 / 家人 / 隔离名单里的人的私聊内容撞上专有词就拦；
//   3. 大脑连不上：failClosed（默认开）就不发，宁可少发也不漏。
// 配置：config.publicGuard { enabled, failClosed, leakCheck }；大脑地址取 ext.memcore.v2Url（默认 127.0.0.1:8780）。

export const ADULT_PUBLIC_RE = /湿润|湿了|湿透|好湿|高潮|情欲|做爱|性交|口交|插进|插入身体|进入身体|腿间|乳头|奶头|自慰|内裤|呻吟|娇喘|色情|上床(?!睡)|小穴|肉棒|阴道|阴茎|淫|射了|爱液|体液|私处|nsfw|18\+/i

/** 会把内容公开出去的 OneBot 动作 → 内容字段。私聊只查发给非主人的。 */
export const PUBLIC_ONEBOT_ACTIONS = {
  send_qzone_msg: ['content'],
  set_self_longnick: ['longNick'],
  set_qq_profile: ['nickname', 'personal_note'],
  comment_qzone: ['content'],
  send_qzone_comment: ['content'],
  qzone_comment: ['content'],
  send_group_msg: ['message'],
  send_private_msg: ['message'],
  send_msg: ['message'],
  send_group_forward_msg: ['messages'],
}

let configGetter = null
let fetchImpl = (...a) => globalThis.fetch(...a)
export function setPublicGuardConfig(getConfig) { configGetter = typeof getConfig === 'function' ? getConfig : null }
export function _setFetch(fn) { fetchImpl = fn || ((...a) => globalThis.fetch(...a)) }

// 暗号 / 隔离模块（modules/handshake）挂在 globalThis 上的闸门：
//   unlockedQq(qq)  这个私聊现在是不是对上暗号（额外 18+ 号用）
//   leakCheck(text, { exceptQq }) 本地指纹比对：隔离账号私聊里说过的事（含换说法）不许出现在别处
const gate = () => (globalThis.__DFY_ADULT_GATE__ && typeof globalThis.__DFY_ADULT_GATE__ === 'object' ? globalThis.__DFY_ADULT_GATE__ : null)
function isolatedLeak(text, exceptQq) {
  const g = gate()
  if (!g || typeof g.leakCheck !== 'function') return null
  try { const r = g.leakCheck(String(text || ''), { exceptQq: exceptQq ? String(exceptQq) : '' }); return r && r.ok === false ? r : null } catch { return null }
}
const leakError = () => Object.assign(new Error('公开守卫：这段话像是在说某个隔离账号私聊里的事，不能在这里说'), { code: 'PUBLIC_GUARD', reason: 'isolated' })
export { isolatedLeak }

const optsOf = (cfg) => ({ enabled: true, failClosed: true, leakCheck: true, ...((cfg && cfg.publicGuard) || {}) })

/** 把 OneBot message（字符串 / 段数组 / 转发节点）里的文字抽出来。 */
export function textOf(v) {
  if (v == null) return ''
  if (typeof v === 'string') return v.replace(/\[CQ:[^\]]*\]/g, ' ')
  if (Array.isArray(v)) return v.map(textOf).join(' ')
  if (typeof v === 'object') {
    if (v.type === 'text') return String(v.data?.text ?? '')
    if (v.type === 'node') return textOf(v.data?.content ?? v.data?.message)
    if (v.data && typeof v.data.text === 'string') return v.data.text
    return ''
  }
  return String(v)
}

export function adultHit(text) {
  const m = String(text || '').match(ADULT_PUBLIC_RE)
  return m ? m[0] : ''
}

/**
 * 公开前检查。返回 { ok, reason, hits }。不抛错。
 * target：'qzone' | 'signature' | 'douyin-comment' | 'group:<id>' | ...；chat：给大脑 /guard 的场合（默认 system = 公开）。
 */
export async function checkPublic(text, { target = 'public', chat = 'system', getConfig = null, log = null } = {}) {
  const getter = getConfig || configGetter
  const cfg = getter?.() || {}
  const o = optsOf(cfg)
  const t = String(text || '').trim()
  if (!t) return { ok: true }
  const hit = adultHit(t)
  if (hit) {
    log?.warn?.(`公开守卫拦下 18+ 内容（${target}）`)
    return { ok: false, reason: 'adult', message: '18+ 内容只能在主人私聊里说，公开的地方一律不发' }
  }
  // 隔离账号（主人 / 额外 18+ 号）的私聊内容：本地指纹比对，换个说法也拦
  const iso = isolatedLeak(t, '')
  if (iso) {
    log?.warn?.(`公开守卫拦下疑似隔离账号的私聊内容（${target}）`)
    return { ok: false, reason: 'isolated', message: '这段话像是在说私聊里的事，公开的地方不能发' }
  }
  // 没接上插件配置（单测 / 独立脚本）就只做 18+ 硬拦，不去连大脑
  if (!getter || o.enabled === false || o.leakCheck === false) return { ok: true }
  const base = String(cfg?.ext?.memcore?.v2Url || cfg?.publicGuard?.url || 'http://127.0.0.1:8780').replace(/\/+$/, '')
  try {
    const r = await fetchImpl(base + '/guard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, reply: t }),
      signal: AbortSignal.timeout(6000),
    })
    const j = await r.json()
    if (j && j.blocked) {
      log?.warn?.(`公开守卫拦下疑似私密内容（${target}，撞上 ${(j.hits || []).length} 条看不见的记忆）`)
      return { ok: false, reason: 'leak', hits: (j.hits || []).length, message: '这段话像是在说私聊里的事，公开的地方不能发' }
    }
    if (!r.ok && o.failClosed) return { ok: false, reason: 'unavailable', message: '记忆大脑没回应，先不公开发' }
    return { ok: true }
  } catch (e) {
    if (o.failClosed) {
      log?.warn?.(`公开守卫：大脑连不上，按 failClosed 不发（${target}）`)
      return { ok: false, reason: 'unavailable', message: '记忆大脑连不上，为了不漏私密内容，先不公开发' }
    }
    return { ok: true }
  }
}

/** 同步版：只做 18+ 硬拦（给不能 await 的地方用）。 */
export function checkAdultSync(text) {
  const hit = adultHit(text)
  return hit ? { ok: false, reason: 'adult', message: '18+ 内容只能在主人私聊里说，公开的地方一律不发' } : { ok: true }
}

/** 抛错版：直接在发帖函数开头 await assertPublic(text, …)。 */
export async function assertPublic(text, opts = {}) {
  const r = await checkPublic(text, opts)
  if (!r.ok) { const e = new Error('公开守卫：' + r.message); e.code = 'PUBLIC_GUARD'; e.reason = r.reason; throw e }
  return true
}

/**
 * 包住 OneBot client.call：
 *   - 说说 / 签名 / 昵称 / 空间评论：18+ + 私密泄漏检查（chat=system）；
 *   - 群消息：18+ 硬拦（群里的私密泄漏由大脑隐私层 + guard 模块管）；
 *   - 私聊：发给主人以外的人 18+ 硬拦。主人私聊不管（那里 18+ 由暗号 / 大脑 adult 开关决定）。
 */
export function wrapOnebotPublic(onebot, { getConfig, log } = {}) {
  if (!onebot || typeof onebot.call !== 'function' || onebot.__publicGuard) return onebot
  const raw = onebot.call.bind(onebot)
  onebot.call = async (action, params = {}, ...rest) => {
    // —— 最底层群静音闸门：不管谁发（hub / 工具 / 扩展模块 / speakup / pet / autonomy），群静音中一律不发。
    // 只有主人命令的回执带 __dfyForce 能过；标记在这里去掉，不会发到 OneBot。
    let forced = false
    if (params && typeof params === 'object' && params.__dfyForce) { forced = true; params = { ...params }; delete params.__dfyForce }
    if (!forced && /^send_(group_msg|msg|group_forward_msg|forward_msg)$/.test(action) && params?.group_id && !(action === 'send_msg' && params?.message_type === 'private')) {
      const mu = globalThis.__DFY_MUTES__
      try {
        if (mu && mu.muted('group:' + String(params.group_id))) {
          log?.info?.('群静音中（主人让她别说话），最底层拦下一条群消息 → group:' + String(params.group_id))
          throw Object.assign(new Error('群静音中，主人让她在这个群先别说话'), { code: 'MUTED' })
        }
      } catch (e) { if (e && e.code === 'MUTED') throw e }
    }
    const fields = PUBLIC_ONEBOT_ACTIONS[action]
    if (fields) {
      const cfg = (getConfig || configGetter)?.() || {}
      const text = fields.map((k) => textOf(params?.[k])).join(' ').trim()
      const isPrivate = action === 'send_private_msg' || (action === 'send_msg' && (params?.message_type === 'private' || (params?.user_id && !params?.group_id)))
      const isGroup = action === 'send_group_msg' || action === 'send_group_forward_msg' || (action === 'send_msg' && !isPrivate)
      if (isPrivate) {
        const uid = String(params?.user_id ?? '')
        // 额外 18+ 号：只有它自己的私聊、而且现在对上了暗号，才放 18+
        const unlockedAlt = (() => { try { return Boolean(gate()?.unlockedQq?.(uid)) } catch { return false } })()
        if (uid !== String(cfg.ownerQQ || '') && !unlockedAlt) {
          const r = checkAdultSync(text)
          if (!r.ok) { log?.warn?.('公开守卫：给非主人的私聊里有 18+ 内容，拦下'); throw Object.assign(new Error('公开守卫：' + r.message), { code: 'PUBLIC_GUARD' }) }
        }
        if (isolatedLeak(text, uid)) { log?.warn?.('公开守卫：私聊里像在说另一个隔离账号的私事，拦下'); throw leakError() }
      } else if (isGroup) {
        const r = checkAdultSync(text)
        if (!r.ok) { log?.warn?.('公开守卫：群消息里有 18+ 内容，拦下'); throw Object.assign(new Error('公开守卫：' + r.message), { code: 'PUBLIC_GUARD' }) }
        if (isolatedLeak(text, '')) { log?.warn?.('公开守卫：群消息像在说隔离账号的私事，拦下'); throw leakError() }
      } else {
        await assertPublic(text, { target: action, chat: 'system', getConfig, log })
      }
    }
    return raw(action, params, ...rest)
  }
  onebot.__publicGuard = true
  return onebot
}

// —— 展示面隐藏 18+（面板记忆列表 / 回想 / 档案 / 日记历史 / 日志 / 桌宠历史）——
// 默认藏；主人想看自己去配置里开 privacyView.adultReveal=true（只有主人能进面板改配置）。
export const ADULT_MASK = '（18+ 内容，已隐藏）'
export function adultRevealOn(cfg) { return Boolean(cfg && cfg.privacyView && cfg.privacyView.adultReveal === true) }
const strOf = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v) } catch { return String(v) } }
/** 列表里含 18+ 的条目直接不给（返回新数组）；reveal 开着原样返回。 */
export function hideAdultItems(list, cfg) {
  if (!Array.isArray(list) || adultRevealOn(cfg)) return list
  return list.filter((it) => !adultHit(strOf(it)))
}
/** 文本字段打码（日志 / 气泡这种要保留条数的）。 */
export function maskAdultField(list, field, cfg) {
  if (!Array.isArray(list) || adultRevealOn(cfg)) return list
  return list.map((it) => (it && typeof it === 'object' && adultHit(strOf(it[field])) ? { ...it, [field]: ADULT_MASK } : (typeof it === 'string' && adultHit(it) ? ADULT_MASK : it)))
}
