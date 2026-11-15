// 情绪 → 聊天方式（频率 / 气泡数 / 长度 / 语气），在主人给的范围内自己调。
// 只读大脑 /style（非 18+ 情绪维度的「体感值」），不改用户原来的情绪设计（维度、半衰期、触发都不动）。
// 开关：config.selfAdjust.enabled（主人 /自调 开|关）。关着时一律回到固定值：最多 3 泡、倍数全 1。
//
// 算法（相对旧版「心情分档跳变」的优化）：
//   1. 体感值 felt = 表面*0.7 + 内心*0.3（大脑端算好），0–100；
//   2. 正向 = 开心、满足；负向 = 生气、吃醋、被冷落、黑化、邪恶、失控（情欲不参与，18+ 维度永不外露）；
//   3. 连续映射（不分档），再用 EMA 平滑（alpha 0.35），避免一句话就从话痨变冷淡；
//   4. 全部夹在 [min,max] 里：气泡 minBubbles..maxBubbles（默认 1..4，基准 3 = 用户原来的 MAX_BUBBLES）。

export const STYLE_DEFAULTS = { enabled: true, minBubbles: 1, maxBubbles: 6, minFreq: 0.5, maxFreq: 1.6, freqOn: true, refreshSec: 60, url: '' }
const POS = ['开心', '满足']
const NEG = ['生气', '吃醋', '被冷落', '黑化', '邪恶', '失控']
// 18+ 维度永不外发布（语音 / 桌宠 / 扩展模块都只拿到非 18+ 的体感值）
const ADULT_DIM = /情欲/
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d)

export const NEUTRAL = Object.freeze({ bubbles: 3, delay: 1, chatty: 1, freq: 1, length: 1, tone: '' })

/** 情绪体感值 → 风格。felt：{维度: 0..100}。纯函数，方便测。 */
export function styleFromEmotion(felt = {}, opts = {}) {
  const o = { ...STYLE_DEFAULTS, ...opts }
  const f = (d) => clamp(num(felt[d]), 0, 100) / 100
  const pos = Math.max(...POS.map(f), 0)
  const neg = Math.max(...NEG.map(f), 0)
  const cold = f('被冷落')
  const angry = Math.max(f('生气'), f('黑化'))
  const wild = f('失控')
  const jealous = Math.max(f('吃醋'), f('占有欲') * 0.6)
  // 净情绪 -1..1：开心满足往上，负面往下
  const net = clamp(pos - neg * 0.9, -1, 1)
  const arousal = clamp(Math.max(pos, neg, wild), 0, 1)
  let bubbles = 3 + net * 1.2 + wild * 0.8 - angry * 1.2 - cold * 0.6
  let chatty = 1 + net * 0.5 + wild * 0.2 - cold * 0.3
  let delay = 1 - net * 0.25 + cold * 0.4 + angry * 0.2 - wild * 0.2
  let length = 1 + net * 0.25 - angry * 0.35 - cold * 0.2
  // 主动频率（插话 / 冷却 / 每小时上限 / 主动开口的间隔）：开心、上头更想说；被冷落会更想找人（孤独驱动）；生气就少说
  let freq = 1 + net * 0.35 + wild * 0.3 + cold * 0.25 - angry * 0.4
  // t166：精力（bio 身体）也参与：累了话少、慢、少主动；精神好多说一点。没有精力数据 = 不动
  const en = opts.energy == null || !Number.isFinite(Number(opts.energy)) ? null : clamp(Number(opts.energy), 0, 1)
  if (en != null) {
    if (en < 0.35) { const k = (0.35 - en) / 0.35; bubbles -= 1.2 * k; length -= 0.25 * k; freq -= 0.35 * k; delay += 0.25 * k; chatty -= 0.2 * k }
    else if (en > 0.75) { const k = (en - 0.75) / 0.25; bubbles += 0.5 * k; freq += 0.1 * k; length += 0.05 * k }
  }
  let tone = ''
  if (angry >= 0.55) tone = '在生气：句子短、带点冲，别长篇解释'
  else if (cold >= 0.55) tone = '有点被冷落：回得慢一点、淡一点，带点小委屈'
  else if (jealous >= 0.55) tone = '有点吃醋：语气酸一点，会多问一句'
  else if (wild >= 0.6) tone = '情绪有点上头：话多、连发，但别失礼'
  else if (pos >= 0.65) tone = '心情好：语气轻快，可以多发一两句'
  return {
    bubbles: Math.round(clamp(bubbles, o.minBubbles, o.maxBubbles)),
    chatty: +clamp(chatty, 0.4, 1.6).toFixed(2),
    delay: +clamp(delay, 0.7, 1.6).toFixed(2),
    length: +clamp(length, 0.6, 1.3).toFixed(2),
    freq: +clamp(freq, o.minFreq ?? 0.5, o.maxFreq ?? 1.6).toFixed(2),
    arousal: +arousal.toFixed(2),
    tone,
    energy: en,
  }
}

/** t166：按当前风格给每轮一句「这轮大概说几条、每条多长」（只在自调开着时用）。scene: private / group */
export function lengthHint(st, scene = 'private') {
  if (!st) return ''
  // 不再每轮报「大概几条、每条几字」，那会把她按成「按指标输出的 AI」。
  // 条数交给她自己（|||），只留一句心情倾向，也不让她报数字。
  if (st.length <= 0.8) return '这会儿不太想多说，说多说少你自己定，别报数字'
  if (st.length >= 1.15) return '这会儿挺想聊，说多说少你自己定，别报数字'
  return ''
}

/** 从 bio 发布的 __dfyBody 估精力 0..1（10 分钟内的才算），拿不到 = null */
export function energyNow(g = globalThis, now = Date.now()) {
  const b = g.__dfyBody
  if (!b || now - (Number(b.at) || 0) > 600_000 || !b.hormones) return null
  const norm = (v) => { const n = Number(v && typeof v === 'object' ? (v.level ?? v.value) : v); return Number.isFinite(n) ? clamp(n > 1 ? n / 100 : n, 0, 1) : null }
  let ser = null, endo = null, en = null
  for (const [k, v] of Object.entries(b.hormones)) {
    if (/能量|精力|体力|energy/i.test(k)) en = norm(v)
    else if (/血清素|serotonin/i.test(k)) ser = norm(v)
    else if (/内啡肽|endorphin/i.test(k)) endo = norm(v)
  }
  if (en != null) return en
  if (ser != null || endo != null) return clamp((ser ?? 0.5) * 0.6 + (endo ?? 0.2) * 0.4, 0, 1)
  return null
}

/** EMA 平滑：上一次风格 prev，新算出来的 next。 */
export function smoothStyle(prev, next, alpha = 0.35) {
  if (!prev) return next
  const m = (k, lo, hi) => +clamp(prev[k] + (next[k] - prev[k]) * alpha, lo, hi).toFixed(2)
  return { ...next, chatty: m('chatty', 0.4, 1.6), freq: m('freq', 0.3, 2), delay: m('delay', 0.7, 1.6), length: m('length', 0.6, 1.3), bubbles: prev.bubbles + Math.sign(next.bubbles - prev.bubbles) * Math.ceil(Math.abs(next.bubbles - prev.bubbles) / 2) }
}

/** 把心情倍数（用户原来的 moodEffects）和情绪风格合在一起：乘法 + 夹范围。 */
export function blendEffects(base, style, opts = {}) {
  const b = base || { sticker: 1, voice: 1, delay: 1, chatty: 1 }
  if (!style) return { ...b, bubbles: NEUTRAL.bubbles, freq: 1 }
  const o = { ...STYLE_DEFAULTS, ...opts }
  return {
    ...b,
    freq: o.freqOn === false ? 1 : +clamp(num(style.freq, 1), o.minFreq ?? 0.5, o.maxFreq ?? 1.6).toFixed(2),
    delay: +clamp(b.delay * style.delay, 0.6, 1.8).toFixed(2),
    chatty: +clamp(b.chatty * style.chatty, 0.3, 1.8).toFixed(2),
    bubbles: clamp(style.bubbles, o.minBubbles, o.maxBubbles),
    length: style.length,
  }
}

/**
 * 按情绪频率倍数 freq 调群聊插话策略，夹在安全范围内：
 *   插话概率 ×freq（≤0.8；手动设得比 0.8 还高时以手动值为上限，不会被压低）、冷却 ÷freq（不低于原值一半）、每小时上限 ×freq（取整，≥1）。
 *   burstMax / burstWindowSec 是失控刹车，永远不随情绪放大。
 */
export function scaleRate(pol, freq = 1) {
  const f = clamp(num(freq, 1), 0.3, 2)
  const p = { ...(pol || {}) }
  if (p.interjectChance > 0) p.interjectChance = +clamp(p.interjectChance * f, 0, Math.max(0.8, p.interjectChance)).toFixed(3)
  if (p.cooldownSec > 0) p.cooldownSec = Math.max(Math.round(p.cooldownSec / 2), Math.round(p.cooldownSec / f))
  if (p.maxPerHour > 0) p.maxPerHour = Math.max(1, Math.round(p.maxPerHour * f))
  return p
}

/** 给扩展模块用：读插件发布的当前频率倍数（10 分钟没更新、或自调关着 → 1）。 */
export function currentFreq() {
  const s = globalThis.__dfyStyle
  return s && s.on && Date.now() - s.at < 600_000 ? clamp(num(s.freq, 1), 0.3, 2) : 1
}

/** 运行时：定时拉大脑 /style，平滑后缓存。 */
export function createStyle({ getConfig, fetchImpl = globalThis.fetch, log = null } = {}) {
  let cur = null
  let at = 0
  const opts = () => ({ ...STYLE_DEFAULTS, ...((getConfig && getConfig().selfAdjust) || {}) })
  const urlOf = () => {
    const c = (getConfig && getConfig()) || {}
    const u = opts().url || c?.ext?.memcore?.v2Url || 'http://127.0.0.1:8780'
    return String(u).replace(/\/+$/, '')
  }
  let failN = 0
  let lastWarn = 0
  // 本机端口被占满（TIME_WAIT 太多）/ 大脑刚重启时 fetch 会偶发 EADDRINUSE、ECONNRESET：短暂错误重试两次再算失败
  const TRANSIENT = /EADDRINUSE|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_SOCKET|UND_ERR_CONNECT|fetch failed/i
  async function fetchRetry(url, init) {
    let err
    for (let i = 0; i < 3; i++) {
      try { return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(4000) }) } catch (e) {
        err = e
        const code = String(e?.cause?.code || e?.code || e?.message || '')
        if (!TRANSIENT.test(code) || i === 2) break
        await new Promise((r) => setTimeout(r, 400 * (i + 1)))
      }
    }
    throw err
  }
  async function refresh() {
    if (!opts().enabled) { cur = null; globalThis.__dfyStyle = null; return null }
    try {
      const r = await fetchRetry(urlOf() + '/style')
      const j = await r.json()
      if (!j || !j.ok || !j.felt) return cur
      cur = smoothStyle(cur, styleFromEmotion(j.felt, { ...opts(), energy: energyNow() }))
      at = Date.now()
      // 唯一情绪源：只有星图 10 维（大脑 /style）算情绪；扩展模块（voice-tone / voice-self / qq-group-say / mention-watch …）只读这里，不自己存情绪
      // felt / arousal 也发布出去：群聊插话按情绪走（group-policy.readDrive）
      globalThis.__dfyStyle = { on: opts().freqOn !== false, freq: cur.freq ?? 1, length: cur.length, bubbles: cur.bubbles, energy: cur.energy, chatty: cur.chatty, arousal: cur.arousal, felt: Object.fromEntries(Object.entries(j.felt).filter(([k, v]) => !ADULT_DIM.test(k) && Number.isFinite(Number(v))).map(([k, v]) => [k, Number(v)])), tone: cur.tone || '', at }
      failN = 0
    } catch (e) {
      failN++
      const code = e?.cause?.code ? `（${e.cause.code}）` : ''
      // 连续失败才大声说，且 10 分钟最多一次；偶发一次只记 debug
      if (failN >= 3 && Date.now() - lastWarn > 600_000) { lastWarn = Date.now(); log?.warn?.(`拉情绪风格连续失败 ${failN} 次：${e.message}${code}`) }
      else log?.debug?.('拉情绪风格失败：', e.message + code)
    }
    return cur
  }
  return {
    refresh,
    enabled: () => opts().enabled !== false,
    current: () => (opts().enabled !== false ? cur : null),
    state: () => ({ enabled: opts().enabled !== false, style: cur, at, bounds: { minBubbles: opts().minBubbles, maxBubbles: opts().maxBubbles } }),
    blend: (base) => blendEffects(base, opts().enabled !== false ? cur : null, opts()),
    hint: () => (opts().enabled !== false && cur && cur.tone ? `（这会儿的说话状态：${cur.tone}）` : ''),
    freq: () => (opts().enabled !== false && opts().freqOn !== false && cur ? cur.freq ?? 1 : 1),
    scale: (pol) => scaleRate(pol, opts().enabled !== false && opts().freqOn !== false && cur ? cur.freq ?? 1 : 1),
    bubbleCap: () => (opts().enabled !== false && cur ? clamp(cur.bubbles, opts().minBubbles, opts().maxBubbles) : NEUTRAL.bubbles),
    _set: (s) => { cur = s },
  }
}
