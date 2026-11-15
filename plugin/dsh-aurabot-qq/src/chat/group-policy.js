// 群聊回复策略：什么时候必回、什么时候插话、什么时候闭嘴。纯函数，便于测试。

export const DEFAULT_GROUP_POLICY = {
  wakeWords: ['大肥鱼', '肥鱼'],
  interjectChance: 0.15, // 普通消息的基础插话概率（话题越相关越高，最高 80%）
  cooldownSec: 90, // 两次插话至少间隔
  maxPerHour: 6, // 每群每小时插话上限
  quietHours: [1, 8], // [开始, 结束) 小时，静默时段不插话（必回不受影响）
  minRecentMessages: 3, // 最近 activeWindowSec 内至少有这么多条消息才算「群里在聊」
  activeWindowSec: 300,
  // 话题相关度：群里正在聊的东西和她有关（碰到她感兴趣的话题、或者她记得相关的事），才可能插话
  interests: ['白米饭', '米饭', '吃饭', '好吃', '饿了', '游戏', '追剧', '番剧', '动漫', '猫', '狗', '鲸鱼', '鱼', '睡觉', '熬夜', '困', '天气', '下雨', '表情包', '女仆', '可爱', '奶茶', '甜品'],
  minRelevance: 0.25, // 相关度低于这个就不插话（0 = 不看话题，纯随机）
  burstMax: 8, // 安全刹车：burstWindowSec 秒内她最多说这么多次，超了就歇着（主人 @ 除外），只防失控
  burstWindowSec: 120,
  // 情绪 / 身体驱动：开着时插话、接话由「她想不想说」决定，不再用固定的冷却 / 每小时上限 / 无条件接话。
  // 只留防刷屏：burst（burstWindowSec 内最多 burstMax 次，不再被「正在聊」绕过）+ 防机器人互刷 floodMax/floodWindowSec。
  emotionDriven: true,
  floodMax: 5, // floodWindowSec 秒内她最多开口这么多次（防和别的机器人互刷），主人 @ 除外
  floodWindowSec: 60,
}

const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(Number(x)) ? Number(x) : 0))

/**
 * 她这会儿「想不想说话」：0~1。全是可选输入，缺的按平常值。
 * drive: { chatty, freq（倍数，1=平常）, energy（0~1，0.5=平常）, arousal, social（想找人聊）, lonely, tired, irritated（0~1） }
 */
export function groupDesire(drive = {}) {
  const d = drive || {}
  const e = d.energy == null ? 0.5 : clamp01(d.energy)
  const m = (x) => (Number.isFinite(Number(x)) ? Number(x) : 1)
  const v = 0.45 + 0.4 * (e - 0.5) + 0.15 * clamp01(d.arousal) + 0.2 * clamp01(d.social) + 0.2 * clamp01(d.lonely) -
    0.35 * clamp01(d.tired) - 0.3 * clamp01(d.irritated) + 0.25 * (m(d.chatty) - 1) + 0.25 * (m(d.freq) - 1)
  return +Math.max(0.02, Math.min(0.98, v)).toFixed(2)
}

/**
 * 从插件发布的全局状态读情绪 / 身体（mood 模块的 /style → globalThis.__dfyStyle；bio 模块的 /bio/state → globalThis.__dfyBody）。
 * 10 分钟没更新的当没有。激素名字认中英文；数值 0~1 或 0~100 都行。
 */
export function readDrive(m0 = {}, now = Date.now(), g = globalThis) {
  const out = { chatty: Number(m0?.chatty) || 1, freq: Number(m0?.freq) || 1 }
  const fresh = (x) => x && now - (Number(x.at) || 0) < 600_000
  const norm = (v) => { const n = Number(v && typeof v === 'object' ? (v.level ?? v.value) : v); return Number.isFinite(n) ? clamp01(n > 1 ? n / 100 : n) : null }
  const st = fresh(g.__dfyStyle) ? g.__dfyStyle : null
  if (st) {
    if (st.arousal != null) out.arousal = clamp01(st.arousal)
    const f = st.felt || {}
    const fv = (k) => norm(f[k])
    if (fv('被冷落') != null) out.lonely = fv('被冷落')
    const ang = Math.max(fv('生气') ?? 0, fv('黑化') ?? 0)
    if (ang) out.irritated = ang
  }
  const body = fresh(g.__dfyBody) ? g.__dfyBody : null
  if (body && body.hormones && typeof body.hormones === 'object') {
    const pick = (re) => { let best = null; for (const [k, v] of Object.entries(body.hormones)) if (re.test(k)) { const n = norm(v); if (n != null) best = best == null ? n : Math.max(best, n) } return best }
    const energy = pick(/能量|精力|体力|energy|stamina/i)
    const dopa = pick(/多巴胺|dopamine/i)
    const tired = pick(/疲劳|疲惫|困|累|tired|fatigue|sleep|褪黑|melatonin|腺苷|adenosine/i)
    const social = pick(/社交|social|陪伴/i)
    const oxy = pick(/催产素|oxytocin/i)
    const lonely = pick(/孤独|寂寞|lonely/i)
    const cort = pick(/皮质醇|cortisol|烦躁|irrit|压力|stress/i)
    const adr = pick(/肾上腺|adrenal|去甲|norepi|兴奋|arousal/i)
    if (energy != null || dopa != null) out.energy = energy != null && dopa != null ? energy * 0.7 + dopa * 0.3 : (energy ?? (0.3 + 0.4 * dopa))
    if (tired != null) out.tired = tired
    else if (energy != null) out.tired = clamp01(0.5 - energy) * 2 * 0.8
    if (social != null) out.social = social
    else if (oxy != null) out.social = clamp01(oxy - 0.3) * 0.6
    if (lonely != null) out.lonely = Math.max(out.lonely ?? 0, lonely)
    if (cort != null) out.irritated = Math.max(out.irritated ?? 0, clamp01((cort - 0.4) / 0.6))
    if (adr != null) out.arousal = Math.max(out.arousal ?? 0, adr)
  }
  return out
}

/**
 * 群里最近在聊的内容和她有多相关（0~1）。
 * @param {string[]} recentTexts 最近几条群消息
 * @param {string[]} interests 她感兴趣的话题词
 * @param {number} [memoryScore] 记忆库对这段话题的命中强度（0~1，可选）
 */
export function topicRelevance(recentTexts, interests, memoryScore = 0) {
  const txt = (recentTexts || []).join(' ')
  let hits = 0
  for (const w of interests || []) if (w && txt.includes(w)) hits++
  return Math.min(1, hits * 0.3 + Math.max(0, Math.min(1, memoryScore)) * 0.5)
}

/** 合并全局策略和单群覆盖。 */
export function policyFor(global, overrides, groupId) {
  const g = { ...DEFAULT_GROUP_POLICY, ...(global || {}) }
  const o = overrides && overrides[String(groupId)]
  return o ? { ...g, ...o } : g
}

export function inQuietHours(hour, quiet) {
  if (!Array.isArray(quiet) || quiet.length !== 2) return false
  const [a, b] = quiet.map(Number)
  if (a === b) return false
  return a < b ? hour >= a && hour < b : hour >= a || hour < b
}

/**
 * 决定这段群消息要不要回。
 * @param {object} p
 * @param {object} p.policy  policyFor() 的结果
 * @param {boolean} p.mentioned  被 @
 * @param {boolean} p.repliedToBot  引用了机器人的消息
 * @param {boolean} [p.fromOwner]  是主人说的
 * @param {string} p.text  消息正文
 * @param {number} p.now  毫秒时间戳
 * @param {number[]} p.recentTimes  本群最近消息的时间戳（毫秒）
 * @param {number[]} p.interjectTimes  本群最近插话的时间戳（毫秒）
 * @param {number[]} [p.botReplyTimes]  她在本群最近每次说话的时间戳（毫秒）
 * @param {number} p.hour  当前小时
 * @param {() => number} [p.rand]
 * @param {number} [p.desire]  情绪模式：她想说话的程度 0~1（不给就按 p.drive 算）
 * @param {object} [p.drive]  情绪模式：groupDesire() 的输入
 * @returns {{reply: boolean, mode: 'must'|'interject'|'engaged'|'none', reason: string}}
 */
export function decideGroupReply(p) {
  const pol = p.policy || DEFAULT_GROUP_POLICY
  const text = String(p.text || '')
  const rand = p.rand || Math.random
  const said = p.botReplyTimes || []
  const emo = pol.emotionDriven !== false
  const ownerCall = p.fromOwner && (p.mentioned || p.repliedToBot)
  // 刹车：短时间里说太多了就歇一会儿，只有主人 @ 能叫动
  const burst = said.filter((t) => p.now - t < (pol.burstWindowSec ?? 120) * 1000).length
  const engagedBypass = !emo && p.engagedUntil && p.now < p.engagedUntil   // 旧模式：正在聊这一段，不算刷屏（情绪模式下不绕过，防刷屏）
  if (burst >= (pol.burstMax ?? 8) && !engagedBypass && !ownerCall) {
    return { reply: false, mode: 'none', reason: `刚说了太多（${burst} 次），歇一会儿` }
  }
  if (emo && !ownerCall) {
    const flood = said.filter((t) => p.now - t < (pol.floodWindowSec ?? 60) * 1000).length
    if (flood >= (pol.floodMax ?? 5)) return { reply: false, mode: 'none', reason: `一分钟里说了 ${flood} 次，防刷屏歇一下` }
  }
  if (p.mentioned) return { reply: true, mode: 'must', reason: '被 @' }
  if (p.repliedToBot) return { reply: true, mode: 'must', reason: '引用了她的消息' }
  const hit = (pol.wakeWords || []).find((w) => w && text.includes(w))
  if (hit) return { reply: true, mode: 'must', reason: `叫到了「${hit}」` }
  const rel = typeof p.relevance === 'number' ? p.relevance : 1

  if (!(pol.interjectChance > 0)) return { reply: false, mode: 'none', reason: '插话关着' }
  if (inQuietHours(p.hour, pol.quietHours)) return { reply: false, mode: 'none', reason: '静默时段' }
  const minRel = Number(pol.minRelevance) || 0
  if (emo) {
    // 情绪 / 身体驱动：想说就说。desire 0~1 = 精力、兴奋、想找人、孤单 往上；累、烦 往下；心情倍数 chatty / freq 也算进去
    const desire = typeof p.desire === 'number' ? p.desire : groupDesire(p.drive)
    const tag = `想说 ${desire.toFixed(2)}，相关度 ${rel.toFixed(2)}`
    if (p.engagedUntil && p.now < p.engagedUntil) {
      // 正在聊：接不接看她想不想（不再无条件接）
      const pc = Math.max(0.05, Math.min(0.95, desire * (0.6 + 0.8 * rel)))
      if (rand() < pc) return { reply: true, mode: 'engaged', reason: `正聊着，还想接（${tag}）` }
      return { reply: false, mode: 'none', reason: `正聊着，但这句不太想接（${tag}）` }
    }
    const recent = (p.recentTimes || []).filter((t) => p.now - t < pol.activeWindowSec * 1000).length
    if (recent < pol.minRecentMessages) return { reply: false, mode: 'none', reason: '群里没在聊' }
    // 冷却随想说的程度缩短（很想说 ≈ 不冷却）；没有固定的每小时上限了
    const times = p.interjectTimes || []
    const last = times.length ? Math.max(...times) : 0
    const cool = (Number(pol.cooldownSec) || 0) * (1 - desire)
    if (p.now - last < cool * 1000) return { reply: false, mode: 'none', reason: `刚插过话，不太想再插（${tag}）` }
    // 越想说越不挑话题
    if (minRel > 0 && rel < minRel * Math.max(0, 1.2 - desire * 1.2)) return { reply: false, mode: 'none', reason: `话题没兴趣（${tag}）` }
    const chance = Math.max(0, Math.min(0.9, (pol.interjectChance || 0) * desire * (0.5 + rel) * 1.5))
    if (rand() < chance) return { reply: true, mode: 'interject', reason: `想插一句（${tag}）` }
    return { reply: false, mode: 'none', reason: `这次不想插（${tag}）` }
  }
  // 已经加入了这个话题：接着聊（每段看完再回，不受冷却和每小时上限限制）
  if (p.engagedUntil && p.now < p.engagedUntil && rel >= minRel * 0.5) {   // 聊起来了门槛放低一半，别聊两句就装死
    return { reply: true, mode: 'engaged', reason: `正聊得起劲，接着说（相关度 ${rel.toFixed(2)}）` }
  }
  const times = p.interjectTimes || []
  const lastHour = times.filter((t) => p.now - t < 3600_000).length
  if (lastHour >= pol.maxPerHour) return { reply: false, mode: 'none', reason: '这小时插话够多了' }
  const last = times.length ? Math.max(...times) : 0
  if (p.now - last < pol.cooldownSec * 1000) return { reply: false, mode: 'none', reason: '插话冷却中' }
  const recent = (p.recentTimes || []).filter((t) => p.now - t < pol.activeWindowSec * 1000).length
  if (recent < pol.minRecentMessages) return { reply: false, mode: 'none', reason: '群里没在聊' }
  // 话题和她有关才插，越相关越容易插（不传 relevance 时按「不看话题」处理，兼容旧调用）
  if (minRel > 0 && rel < minRel) return { reply: false, mode: 'none', reason: `话题和她关系不大（相关度 ${rel.toFixed(2)}）` }
  const chance = minRel > 0 ? Math.min(0.8, pol.interjectChance * (1 + 4 * rel)) : pol.interjectChance
  if (rand() < chance) return { reply: true, mode: 'interject', reason: `话题相关，插一句（相关度 ${rel.toFixed(2)}）` }
  return { reply: false, mode: 'none', reason: '这次不插话' }
}
