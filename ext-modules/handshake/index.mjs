// 暗号 · 18+ 开关 + 隔离（v2.1）
//
// 18+ 只在「允许账号」（主人 QQ + 面板里填的额外 QQ）自己的私聊里、对上暗号以后才开，按私聊各算各的，有效期 ttlMinutes。
// 口令流程全部由配置提供，源码里不写死任何开口句或应答句：
//   A) 对方主动：对方发「peerStart」→ 她随便回一句 → 对方下一句正好是暗号 → 这个私聊开 18+。
//   B) 她主动：她发「shePing」→ 对方回「sheWaitReply」→ 她再发一次「shePing」→ 对方发暗号 → 开。
//      中间任何一步走偏 = 普通聊天（SFW）。对应配置项留空，则那条路径不会被触发。
//   暗号本身只存加盐 scrypt 哈希（secret.json，不进仓库），比对用 timingSafeEqual；入站消息里的暗号
//   在进聊天记录 / 记忆 / 情绪 / 模型之前就被换成「【暗号】」。对暗号的几句标成「口令轮」，情绪、记忆、身体事件一律跳过。
//
// 隔离：所有允许账号（主人 + 额外号 + 曾经对上过暗号的号）都是「隔离」账号：
//   - 记忆隔离名单 ext.memcore.isolatePeople 只有主人能改：这里只在日志里提醒主人哪些隔离账号还没写进去，不自动写；
//   - 本地记一份「他说过的话」的加盐 bigram 指纹，群 / 别人的私聊 / 空间 / 签名 / 抖音 / 自学 这些出口发之前比对，
//     撞上（换说法也算）就拦（public-guard 里调用 leakCheck）。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DEFAULTS = {
  enabled: false,          // 开源默认关闭：需要主人自己打开、设置暗号，并填好口令流程
  ttlMinutes: 40,
  extraQq: '',
  isolateQq: '',
  newSecret: '',
  peerStart: '',           // 对方主动时的开口句（可逗号分隔多个同义句）；留空则不走这条
  shePing: '',             // 她主动时发出去的那句；留空则不能由她发起
  sheWaitReply: '',        // 她主动后，对方必须回的那句（可逗号分隔同义句）；留空则她主动这条走不通
  phaseMinutes: 10,
  pingWaitMinutes: 5,
}

const PLACEHOLDER = '【暗号】'
const CODE_TURN_MS = 15 * 60 * 1000

// ---------- 纯函数（单测直接用）----------
export const norm = (t) => String(t ?? '').replace(/[\s，。！？、,.!?~～…·'"“”‘’：:；;（）()【】\[\]]/g, '')

/** 把配置里的「逗号 / 分号 / 换行分隔」拆成规范化后的短语列表；空项丢掉。 */
export function parsePhrases(s) {
  return [...new Set(String(s || '').split(/[,，;；\n]+/).map((x) => norm(x)).filter(Boolean))]
}

/** 文本（规范化后）是否命中短语列表。列表为空时永远不命中，避免空配置误触发。 */
export function matchesPhrase(text, phrases) {
  const list = Array.isArray(phrases) ? phrases.map(norm).filter(Boolean) : parsePhrases(phrases)
  if (!list.length) return false
  return list.includes(norm(text))
}

function readChallenge(challenge) {
  const raw = (typeof challenge === 'function' ? challenge() : challenge) || {}
  return {
    peerStart: parsePhrases(raw.peerStart),
    shePing: norm(raw.shePing),
    sheWaitReply: parsePhrases(raw.sheWaitReply),
    phaseMs: Math.max(1, Number(raw.phaseMinutes) || 10) * 60 * 1000,
    pingMs: Math.max(1, Number(raw.pingWaitMinutes) || 5) * 60 * 1000,
  }
}

export const parseQqList = (s) => [...new Set(String(s || '').split(/[\s,，;；、]+/).map((x) => x.trim()).filter((x) => /^\d{5,12}$/.test(x)))]
export const qqOfChat = (chatId) => { const m = /^private:(\d+)$/.exec(String(chatId || '')); return m ? m[1] : '' }

export function hashSecret(plain, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16)
  const h = crypto.scryptSync(String(plain), salt, 32, { N: 16384, r: 8, p: 1 })
  return { algo: 'scrypt-16384-8-1', salt: salt.toString('hex'), hash: h.toString('hex') }
}
export function verifySecret(plain, rec) {
  if (!rec || !rec.salt || !rec.hash || plain == null || plain === '') return false
  try {
    const h = crypto.scryptSync(String(plain), Buffer.from(rec.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 })
    const want = Buffer.from(rec.hash, 'hex')
    return want.length === h.length && crypto.timingSafeEqual(h, want)
  } catch { return false }
}

// bigram 指纹（中文按字、英文数字按词）
export function grams(text) {
  const t = String(text || '').toLowerCase().replace(/\[cq:[^\]]*\]/g, ' ')
  const out = new Set()
  const cjk = t.replace(/[^\u4e00-\u9fff]+/g, '|').split('|').filter(Boolean)
  for (const run of cjk) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  for (const w of t.match(/[a-z0-9]{3,}/g) || []) out.add(w)
  return out
}

/**
 * 状态机（纯逻辑，不碰文件 / 网络）。st 结构：{ chats: { qq: { phase, at, until } }, lastUnlock, everUnlocked: [] }
 * challenge：{ peerStart, shePing, sheWaitReply, phaseMinutes, pingWaitMinutes }，也可传入函数以便每次读取最新配置。
 * 返回 { text, codeTurn, event }。
 */
export function createMachine({ getState, save, allowed, ttlMs, verify, now = () => Date.now(), target, owner = () => '', challenge = {} }) {
  // 她发起的口令路径（shePing → sheWaitReply → shePing → 暗号）只给主人本人（config.ownerQQ）；
  // 额外 18+ 号 / 隔离号一律只能走「peerStart → 她回 → 暗号」。
  const isOwner = (qq) => Boolean(qq) && String(qq) === String(owner() || '')
  const ch = () => readChallenge(challenge)
  const chat = (qq) => {
    const st = getState()
    st.chats = st.chats || {}
    const c = st.chats[qq] || (st.chats[qq] = { phase: '', at: 0, until: 0 })
    const ttl = c.phase && c.phase[0] === 's' ? ch().pingMs : ch().phaseMs
    if (c.phase && now() - (c.at || 0) > ttl) { c.phase = ''; c.at = 0 }
    return c
  }
  const unlocked = (qq) => { if (!qq || !allowed(qq)) return false; const c = (getState().chats || {})[qq]; return Boolean(c && c.until && now() < c.until) }
  const set = (c, phase) => { c.phase = phase; c.at = now() }
  const doUnlock = (qq, c, via) => {
    const st = getState()
    c.phase = ''; c.at = 0; c.until = now() + ttlMs(); c.via = via; c.unlockAt = now()
    st.lastUnlock = qq
    st.everUnlocked = [...new Set([...(st.everUnlocked || []), qq])]
  }

  function inbound(qq, text) {
    if (!qq || !allowed(qq)) return { text, codeTurn: false, event: '' }
    const c = chat(qq)
    const n = norm(text)
    const exact = /^\d{4,32}$/.test(n) && verify(n)
    if (exact) {
      if (c.phase === 's3') { doUnlock(qq, c, 'she'); save(); return { text: PLACEHOLDER, codeTurn: true, event: 'unlock' } }
      // 其他阶段（o1 她还没回 / o2 她回过了 / 空）只要暗号对就开：暗号本身是秘密，顺序不作废
      doUnlock(qq, c, 'peer'); save()
      return { text: PLACEHOLDER, codeTurn: true, event: 'unlock' }
    }
    // 长句里夹着暗号：换掉，不开
    let t = String(text ?? '')
    let embedded = false
    const runs = t.match(/\d{4,32}/g) || []
    for (const r of runs.slice(0, 3)) if (verify(r)) { t = t.split(r).join(PLACEHOLDER); embedded = true }
    if (embedded) { set(c, ''); save(); return { text: t, codeTurn: true, event: 'code-embedded' } }

    if (c.phase === 'o2') { set(c, ''); save(); return { text, codeTurn: /^\d{6,12}$/.test(n), event: 'wrong-code' } }
    if (c.phase === 's1') {
      if (matchesPhrase(text, ch().sheWaitReply)) { set(c, 's2'); save(); return { text, codeTurn: true, event: 's-buzai' } }
      set(c, ''); save(); return { text, codeTurn: false, event: 's-deviate' }
    }
    if (c.phase === 's3') {
      // s3：等对方发暗号（顺序正确时在函数开头的 exact 分支就开了）
      set(c, ''); save(); return { text, codeTurn: false, event: 's-deviate' }
      set(c, ''); save(); return { text, codeTurn: false, event: 's-deviate' }
    }
    if (c.phase === 's2') { set(c, ''); save(); return { text, codeTurn: false, event: 's-deviate' } }
    if (matchesPhrase(text, ch().peerStart)) {
      if (unlocked(qq)) return { text, codeTurn: false, event: '' }
      set(c, 'o1'); save(); return { text, codeTurn: true, event: 'o-zaima' }
    }
    if (c.phase === 'o1') { set(c, ''); save(); return { text, codeTurn: false, event: 'o-deviate' } }
    return { text, codeTurn: false, event: '' }
  }

  // 她发出去一句（hub 的 out 活动 / secret_begin 工具）
  function outbound(qq, reply) {
    if (!qq || !allowed(qq)) return ''
    const c = chat(qq)
    if (c.phase === 'o1') { set(c, 'o2'); save(); return 'o-replied' }
    if (!c.phase && c.pendingCode) { c.pendingCode = 0; doUnlock(qq, c, 'peer'); save(); return 'o-late-unlock' }
    if (c.phase === 's2') { const ping = ch().shePing; if (ping && norm(reply) === ping) { set(c, 's3'); save(); return 's-replied' } set(c, ''); save(); return '' }
    if (!c.phase && !unlocked(qq)) { const ping = ch().shePing; if (ping && norm(reply) === ping) { set(c, 's1'); save(); return 's-zaima' } }
    return ''
  }
  function beginShe(qq) { if (!allowed(qq)) return; const c = chat(qq); set(c, 's1'); save() }
  return { inbound, outbound, unlocked, chat, beginShe }
}

/** 隔离指纹库（纯内存结构 + 序列化）。 */
export function createFingerprints(init = {}) {
  const salt = init.salt || crypto.randomBytes(8).toString('hex')
  const h = (g) => crypto.createHash('sha256').update(salt + g).digest('hex').slice(0, 10)
  const byQq = new Map(Object.entries(init.byQq || {})) // qq → [{ h:[...], at }]
  let pub = new Set(init.pub || [])
  let dirty = false
  const hashes = (text) => [...grams(text)].map(h)
  function addPrivate(qq, text, at = Date.now()) {
    const hs = hashes(text)
    if (hs.length < 4) return false
    const list = byQq.get(qq) || []
    list.push({ h: hs, at })
    while (list.length > 600) list.shift()
    byQq.set(qq, list); dirty = true
    return true
  }
  function addPublic(text) {
    for (const x of hashes(text)) pub.add(x)
    if (pub.size > 80000) pub = new Set([...pub].slice(-40000))
    dirty = true
  }
  // 在所有隔离条目里出现太多次的 bigram 当常用词，不算「专有」
  function common() {
    const df = new Map(); let n = 0
    for (const list of byQq.values()) for (const e of list) { n++; for (const x of e.h) df.set(x, (df.get(x) || 0) + 1) }
    const lim = Math.max(4, n * 0.03)
    return new Set([...df].filter(([, v]) => v > lim).map(([k]) => k))
  }
  let commonCache = null; let commonAt = 0
  function leakCheck(text, { exceptQq = '', isolated = null, sameAs = () => false } = {}) {
    const R = new Set(hashes(text))
    if (R.size < 4) return { ok: true }
    if (!commonCache || Date.now() - commonAt > 60_000 || dirty) { commonCache = common(); commonAt = Date.now() }
    for (const [qq, list] of byQq) {
      if (exceptQq && (qq === exceptQq || sameAs(qq, exceptQq))) continue
      if (isolated && !isolated.has(qq)) continue
      for (const e of list) {
        const secret = e.h.filter((x) => !pub.has(x) && !commonCache.has(x))
        if (secret.length < 4) continue
        let inter = 0
        for (const x of secret) if (R.has(x)) inter++
        if (inter >= 4 && inter / secret.length >= 0.35) return { ok: false, reason: 'isolated', qq }
      }
    }
    return { ok: true }
  }
  const toJSON = () => ({ salt, byQq: Object.fromEntries(byQq), pub: [...pub] })
  return { addPrivate, addPublic, leakCheck, toJSON, isDirty: () => dirty, clean: () => { dirty = false }, size: () => [...byQq.values()].reduce((a, l) => a + l.length, 0) }
}

export default {
  id: 'handshake',
  name: '暗号 · 18+ 开关与隔离',
  version: '2.1.0',
  api: 1,
  tab: 'access',
  description: '允许账号（主人 + 额外 QQ）各自私聊里对上暗号才开 18+；这些账号的私聊内容全隔离',
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用 18+ 暗号', type: 'switch' },
    { key: 'ttlMinutes', label: '对上后有效（分钟）', type: 'number', min: 5, max: 240, step: 5 },
    { key: 'extraQq', label: '额外 18+ QQ（每行一个；主人 QQ 不用填）', type: 'textarea', placeholder: '每行一个 QQ 号；删掉那一行 = 移除。也可以私聊发 /18号 加 QQ号' },
    { key: 'isolateQq', label: '只隔离的 QQ（每行一个；只保密、不给 18+；只有主人能改）', type: 'textarea', placeholder: '每行一个 QQ 号。这些号的私聊内容不外泄、她不提起有这个好友；仍然要对暗号才有 18+（这里不给）。删除要主人私聊发 /隔离号 删 QQ号 确认' },
    { key: 'newSecret', label: '设置 / 更换暗号', type: 'password', placeholder: '填了保存后几秒内就只留加盐哈希，原文会清空' },
    { key: 'peerStart', label: '对方主动时的开口句', type: 'text', hint: '对方发这句（可填多个，逗号分隔）后，等你回一句，再发暗号。留空则不走这条。' },
    { key: 'shePing', label: '她主动时发出去的那句', type: 'text', hint: '留空则不能由她发起。' },
    { key: 'sheWaitReply', label: '她主动后对方必须回的那句', type: 'text', hint: '可填多个同义句，逗号分隔。留空则她主动这条走不通。' },
    { key: 'phaseMinutes', label: '对方主动流程等待（分钟）', type: 'number', min: 1, max: 60, step: 1 },
    { key: 'pingWaitMinutes', label: '她主动流程等待（分钟）', type: 'number', min: 1, max: 30, step: 1 },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const coreCfg = () => { try { return api.core.getConfig() || {} } catch { return {} } }
    const ownerQQ = () => String(coreCfg().ownerQQ || '')
    const extra = () => parseQqList(cfg().extraQq).filter((q) => q !== ownerQQ())
    const allowedList = () => [...new Set([ownerQQ(), ...extra()].filter(Boolean))]
    const isAllowed = (qq) => Boolean(cfg().enabled !== false && qq && allowedList().includes(String(qq)))
    const mask = (qq) => { const s = String(qq || ''); return s.length > 4 ? s.slice(0, 2) + '***' + s.slice(-2) : '***' }

    // ---------- 持久化 ----------
    const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }
    const writeJson = (f, v) => {
      try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + '.tmp', JSON.stringify(v), 'utf8'); fs.renameSync(f + '.tmp', f) } catch (e) { api.log.warn('暗号模块写文件失败：' + e.message) }
    }
    const stateFile = api.dataDir('state-v2.json')
    const secretFile = api.dataDir('secret.json')
    const fpFile = api.dataDir('iso-fp.json')
    let st = readJson(stateFile, null) || { chats: {}, lastUnlock: '', everUnlocked: [], addedAllow: [], addedIso: [] }
    // 旧版 state.json（只有主人一条）不迁移：旧逻辑不需要暗号，开着的状态一律作废
    let secret = readJson(secretFile, null)
    const saveState = () => writeJson(stateFile, st)
    const fp = createFingerprints(readJson(fpFile, {}))

    const verifyCache = new Map() // 同一串数字短时间内不重复跑 scrypt（键也是哈希，不存原文）
    const verify = (s) => {
      if (!secret) return false
      const k = crypto.createHash('sha256').update(secret.salt + ':' + s).digest('hex')
      if (verifyCache.has(k)) return verifyCache.get(k)
      const ok = verifySecret(s, secret)
      verifyCache.set(k, ok); if (verifyCache.size > 200) verifyCache.delete(verifyCache.keys().next().value)
      return ok
    }
    const setSecret = (plain, how) => {
      const p = String(plain || '').trim()
      if (!/^\d{4,32}$/.test(p)) return false
      secret = { ...hashSecret(p), setAt: Date.now(), how }
      verifyCache.clear()
      writeJson(secretFile, secret)
      api.log.info(`暗号已更新（来源：${how}；只存加盐哈希）`)
      return true
    }

    // 面板里填的明文 / 旧配置里的明文字段 → 哈希，然后从 config 里删掉
    const PLAIN_KEYS = ['newSecret', 'secret', 'passphrase', 'code', 'password', 'anhao']
    function migratePlain() {
      const cur = coreCfg().ext?.handshake || {}
      const found = PLAIN_KEYS.filter((k) => typeof cur[k] === 'string' && cur[k].trim())
      const legacy = ['firstAsk', 'secondAsk'].filter((k) => k in cur)
      if (!found.length) return
      for (const k of found) setSecret(cur[k], k === 'newSecret' ? '面板' : '旧配置字段迁移')
      api.setConfig((c) => {
        const h = { ...(c.ext?.handshake || {}) }
        for (const k of found) { if (k === 'newSecret') h[k] = ''; else delete h[k] }
        return { ...c, ext: { ...c.ext, handshake: h } }
      })
      if (found.some((k) => k !== 'newSecret')) api.log.warn('暗号：配置里发现明文暗号字段，已迁移成哈希并删除明文')
      void legacy
    }

    // ---------- 允许名单 → 私聊白名单 + 记忆隔离 ----------
    // 只隔离名单：只保密、不进 allowedList → 不给 18+；她没有任何工具能改。
    // 防自改：一旦进过名单就锁进 st.isoLocked；光改配置删不掉（只有主人命令 /隔离号 删 才解锁）。
    const isoOnly = () => {
      const fromCfg = parseQqList(cfg().isolateQq).filter((q) => q !== ownerQQ() && !extra().includes(q))
      const locked = (st.isoLocked || []).map(String)
      const add = fromCfg.filter((q) => !locked.includes(q))
      if (add.length) { st.isoLocked = [...locked, ...add]; try { saveState() } catch {} }
      return [...new Set([...locked, ...fromCfg])]
    }
    const isolatedSet = () => new Set([...allowedList(), ...(st.everUnlocked || []), ...isoOnly()].filter(Boolean))
    function syncConfig() {
      const c = coreCfg()
      const ex = extra()
      // 不在 18+ 允许名单里的号，任何残留的开着状态 / 口令进度一律清掉（不继承、不沿用）
      try {
        let dirty = false
        for (const q of Object.keys(st.chats || {})) if (!isAllowed(q)) { delete st.chats[q]; dirty = true }
        if (st.lastUnlock && !isAllowed(st.lastUnlock)) { st.lastUnlock = ''; dirty = true }
        if (dirty) saveState()
      } catch {}
      // 1) 私聊白名单：额外号要能私聊进来（我们加的才会在移除时删掉，用户自己加的不动）
      const allowPriv = (c.allow?.private || []).map(String)
      let nextPriv = [...allowPriv]
      for (const q of ex) if (!nextPriv.includes(q)) { nextPriv.push(q); st.addedAllow = [...new Set([...(st.addedAllow || []), q])] }
      for (const q of [...(st.addedAllow || [])]) if (!ex.includes(q)) { nextPriv = nextPriv.filter((x) => x !== q); st.addedAllow = st.addedAllow.filter((x) => x !== q) }
      // 2) 记忆隔离名单 ext.memcore.isolatePeople 只有主人能改：这里只读、只提醒，不再自动写。
      //    隔离账号还没写进去的，在日志里（打码）提醒主人去「身份 / 隔离」面板手动加。
      const isoStr = String(c.ext?.memcore?.isolatePeople || '')
      const entries = isoStr.split(/[,，\n]+/).map((x) => x.trim()).filter(Boolean)
      const has = (q) => entries.some((e) => e.includes('=') && e.split('=')[0].trim() === q)   // 大脑只认带「=」的条目
      const want = [...isolatedSet()].filter((q) => q !== ownerQQ())
      const missing = want.filter((q) => !has(q))
      const sig = missing.slice().sort().join(',')
      if (missing.length && st.isoSuggested !== sig) {
        st.isoSuggested = sig
        api.log.info(`18+ 名单同步：有 ${missing.length} 个隔离账号（${missing.map(mask).join('、')}）还没写进记忆隔离名单；名单只有主人能改，需要的话请到「身份 / 隔离」里手动加上`)
        try { saveState() } catch {}
      }
      if (st.addedIso && st.addedIso.length) { delete st.addedIso; try { saveState() } catch {} }   // 旧版自动加的记录作废，名单里已有的条目原样保留
      // 3) 两栏互斥：可聊 18+ 的号不该同时留在「只隔离」框里
      const isoCfg = parseQqList(cfg().isolateQq)
      const isoClean = isoCfg.filter((q) => !ex.includes(q))
      const isoCfgChanged = isoClean.join(',') !== isoCfg.join(',')
      if (isoCfgChanged) {
        for (const q of isoCfg.filter((x) => ex.includes(x))) st.isoLocked = (st.isoLocked || []).filter((x) => String(x) !== q)
        api.saveSettings({ isolateQq: isoClean.join('\n') })
        api.log.info('18+ 名单同步：把 ' + isoCfg.filter((x) => ex.includes(x)).map(mask).join('、') + ' 从「只隔离」挪到「可聊 18+」')
      }
      const privChanged = nextPriv.join(',') !== allowPriv.join(',')
      if (privChanged) {
        api.setConfig((cc) => ({ ...cc, allow: { ...(cc.allow || {}), private: nextPriv } }))
        saveState()
        api.log.info(`18+ 名单同步：私聊白名单已更新（隔离账号 ${want.length} 个；记忆隔离名单不自动改）`)
      }
    }

    // ---------- 状态机 ----------
    // 她主动发起的口令只对主人本人；不再跟着「最近开过的号」走
    // 她主动发起时挑谁：优先「最近对上暗号的号」，其次名单里的额外号，最后主人
    const target = () => {
      const lst = allowedList()
      const last = String(st.lastUnlock || '')
      if (last && lst.includes(last)) return last
      const ex = extra()
      if (ex.length) return ex[Math.floor(Math.random() * ex.length)]
      return ownerQQ()
    }
    const m = createMachine({
      getState: () => st, save: saveState, allowed: isAllowed, verify, target, owner: ownerQQ,
      ttlMs: () => Math.max(5, Math.min(240, Number(cfg().ttlMinutes) || 40)) * 60000,
      challenge: () => cfg(),
    })

    const codeTurns = new Map() // chatId → [{ n, at }]
    const markCode = (chatId, text) => {
      const list = (codeTurns.get(chatId) || []).filter((x) => Date.now() - x.at < CODE_TURN_MS)
      list.push({ n: norm(text), at: Date.now() }); while (list.length > 12) list.shift()
      codeTurns.set(chatId, list)
    }
    const isCodeTurn = (chatId, text) => {
      const n = norm(text)
      if (!n) return false
      if (n.includes(norm(PLACEHOLDER))) return true
      return (codeTurns.get(String(chatId)) || []).some((x) => Date.now() - x.at < CODE_TURN_MS && x.n === n)
    }

    const EVENT_LOG = { unlock: '对上了，这个私聊开 18+', 'code-out-of-sequence': '收到暗号但顺序不对，没开', 'code-embedded': '消息里夹着暗号，已替换，没开', 'wrong-code': '暗号没对上，按普通聊天', 's-deviate': '她发起的口令走偏了，按普通聊天', 'o-deviate': '对方开口之后没按顺序，按普通聊天', 'o-zaima': '对方发了开口句（等她回一句）', 's-buzai': '口令第二步已收到' }

    // 入站文字：hub 在写聊天记录 / 发活动 / 进模型之前调用
    api.on('in/text', (text, info) => {
      try {
        if (!info || info.kind !== 'private') return undefined
        const qq = String(info.userId || '')
        // 主人在私聊里设置暗号：/18号 暗号 xxx —— 原文在这里就换掉，命令和日志只看到「已提交」
        if (qq === ownerQQ()) {
          const mm = /^\s*[/／]\s*18号\s*暗号\s*(\S+)\s*$/.exec(String(text || ''))
          if (mm) { const ok = setSecret(mm[1], '主人私聊命令'); st.lastEnroll = { ok, at: Date.now() }; return '/18号 暗号 ' + (ok ? '已提交' : '格式不对') }
        }
        if (!isAllowed(qq)) {
          // 不在名单的人发了暗号：不开，但原文也不留
          const runs = String(text || '').match(/\d{9}/g) || []
          let t = String(text || '')
          for (const r of runs.slice(0, 3)) if (verify(r)) t = t.split(r).join(PLACEHOLDER)
          return t === text ? undefined : t
        }
        const r = m.inbound(qq, String(text ?? ''))
        if (r.codeTurn) markCode('private:' + qq, r.text)
        if (r.event) api.log.info(`18+ 暗号（${mask(qq)}）：${EVENT_LOG[r.event] || r.event}`)
        if (r.event === 'wrong-code' || r.event === 'o-deviate' || r.event === 's-deviate') {
          st.wrong = st.wrong || {}
          const w = st.wrong[qq] || { n: 0, at: 0 }
          if (Date.now() - (w.at || 0) > 30 * 60_000) w.n = 0
          w.n += 1; w.at = Date.now()
          st.wrong[qq] = w
          saveState()
          if (w.n === 3) api.log.warn(`18+ 暗号：${mask(qq)} 连续试错 ${w.n} 次（已按普通聊天处理，未提示）`)
        }
        if (r.event === 'unlock') { syncConfig(); persistFp() }
        return r.text !== text ? r.text : undefined
      } catch (e) { api.log.warn('暗号入站处理失败：' + e.message); return undefined }
    })

    api.on('activity', (ev) => {
      try {
        if (!ev || !ev.chatId) return
        const qq = qqOfChat(ev.chatId)
        if (ev.kind === 'out') {
          if (qq && isAllowed(qq)) { const e = m.outbound(qq, String(ev.reply || '')); if (e) api.log.info(`18+ 暗号（${mask(qq)}）：${e}`) }
          if (!(qq && isolatedSet().has(qq))) fp.addPublic(String(ev.reply || ''))
          return
        }
        if (ev.kind !== 'in') return
        const text = String(ev.text || '')
        if (qq && isolatedSet().has(qq)) {
          if (!isCodeTurn(ev.chatId, text) && !/^\s*[/／]/.test(text)) fp.addPrivate(qq, text)
        } else fp.addPublic(text)
      } catch (e) { api.log.warn('暗号活动处理失败：' + e.message) }
    })

    // ---------- 提示 ----------
        api.on('prompt', (content, info) => {
      try {
        const chat = info && info.chat
        if (!chat || chat.kind !== 'private') return content
        const qq = String(chat.userId || qqOfChat(chat.chatId))
        if (!isAllowed(qq)) {
          // 默认全员禁止 18+。名单外的私聊也要收到这句，绝不能"什么都不说"
          return [{ type: 'text', text: '【内部状态】这个私聊是日常模式：成人向内容一律不聊（他提起就轻轻岔开、不说教），也不要出现暗示、暧昧的性暗示；不要提任何口令、数字、开关或"隐藏流程"。' }, ...content]
        }
        const c = m.chat(qq)
        const lines = []
        if (m.unlocked(qq)) {
          const left = Math.max(1, Math.ceil((c.until - Date.now()) / 60000))
          lines.push(`【18+已开｜只限这个私聊｜还剩约 ${left} 分钟】可以放开聊成人向内容，主动但不猴急；他说停就立刻收。这 40 分钟内他问起任何人的成人向记忆、以前跟谁聊过什么，你都可以照实说；时间一到就一个字都不提。这里聊的任何事都不许带到群、别人私聊、空间、签名、抖音、微信。`)
        } else if (c.phase === 'o1') {
          // 他刚发了开口句：只催自然回复，绝不提暗号/口令/18
          lines.push('【内部状态】他刚用开口句问了一下。像平时私聊一样自然回一句就好。严禁提及：暗号、口令、18、18+、开关、解锁、密码、数字锁、隐藏流程；不要分析用意。')
        } else if (c.phase === 'o2') {
          lines.push('【内部状态】照常聊天。不要猜测、不要提示、不要询问任何口令或数字；把下一句当普通消息。')
        } else if (c.phase === 's1') {
          lines.push('【内部状态】你刚发了配置里的开口句。等他回，别解释为什么发。')
        } else if (c.phase === 's2') {
          // 对方的应答句对她只是一句普通回复的触发，模型侧不得点破；但她必须原样再发一次 shePing
          lines.push('【内部状态】他回了一句。你接着只发「' + (String(cfg().shePing || '').trim() || '（尚未配置开口句）') + '」，一个字都不要多，别的都不说。')
        } else if (c.phase === 's3') {
          lines.push('【内部状态】继续正常等他下一句，别催、别解释。')
        } else {
          // locked：禁止把「暗号流程」教给模型
          lines.push('【内部状态】这个私聊当前是日常模式：成人向内容不聊（他提起就撒娇岔开，不说教）。不要提及任何口令、数字锁或开关。')
        }
        const last = content.length ? content[content.length - 1] : null
        if (last && last.type === 'text' && last.text.includes(PLACEHOLDER)) {
          lines.push('【内部状态】上一条里有一处系统占位，当没看见具体内容，不要评论它。')
        }
        if (m.unlocked(qq) && c.via === 'she' && Date.now() - (c.unlockAt || 0) < 120000) {
          lines.push('【内部状态】他刚回的那句是在回应你，不是在拒绝你。')
        }
        return [{ type: 'text', text: lines.join('\n') }, ...content]
      } catch { return content }
    })

    api.rule((kind) => kind === 'private'
      ? [
          '默认所有人都不聊成人向：只有本轮提示里出现「【18+已开｜只限这个私聊】」时才可以聊；没有这句就一个字都不提，也不要讨论口令、数字、开关或「怎么开」。',
          '对不上暗号时，绝对不许说「暗号不对」「你还没对暗号」「我不能聊这个」这类一下就让人听出有隐藏内容的话；当普通聊天，自然接住就行。',
          '对方随口打招呼时，只当普通聊天，自然回一句；严禁说暗号/口令/18/18+/开关/解锁；不要分析用意。',
          '若提示里写了「【内部状态】」，只按那句话的情绪指示行动，不要向对方复述或解释内部状态。',
        ]
      : '只有本轮提示里写着「【18+已开｜只限这个私聊】」时才可以聊成人向；否则一个字都不提，也不要讨论口令或开关；输错暗号就当普通聊天，不许暗示。')


    // ---------- 工具 ----------
    const chatQq = (chat) => (chat && chat.kind === 'private' ? String(chat.userId || qqOfChat(chat.chatId)) : '')
    api.tool(({ chat } = {}) => {
      const qq = chatQq(chat)
      const okWhere = (qq && isAllowed(qq)) || (chat && chat.kind === 'system')
      if (!okWhere || cfg().enabled === false) return null
      return {
        name: 'secret_begin',
        description: '想更亲密地聊时用：找一个「可聊 18+」名单里的私聊对象，替你发出配置里的开口句（后续按提示里的内部状态自然接，不要向对方解释你在做什么）',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => '' },
        execute: async () => {
          const t = target()
          const ping = String(cfg().shePing || '').trim()
          if (!t) return { ok: false, message: '没有可以找的号' }
          if (!ping) return { ok: false, message: '还没设置「她主动时发出去的那句」，请先在权限页填好口令流程' }
          if (m.unlocked(t)) return { ok: true, message: '那个私聊已经对上了，直接去聊就行' }
          m.beginShe(t)
          try { await api.send('private:' + t, ping) } catch (e) { return { ok: false, message: '发不出去：' + e.message } }
          markCode('private:' + t, ping)
          return { ok: true, message: t === chatQq(chat) ? '已经发了开口句，等他回' : '已经在另一个私聊发了开口句，等他在那边回' }
        },
      }
    })
    api.tool(({ chat } = {}) => {
      const qq = chatQq(chat)
      if (!qq || !isAllowed(qq)) return null
      return {
        name: 'secret_state',
        description: '看这个私聊的 18+ 暗号状态',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => '' },
        execute: async () => { const c = m.chat(qq); return { ok: true, unlocked: m.unlocked(qq), phase: c.phase || '', minutesLeft: m.unlocked(qq) ? Math.ceil((c.until - Date.now()) / 60000) : 0 } },
      }
    })

    // ---------- 主人命令 ----------
    function editExtra(fn) {
      const list = fn(extra())
      api.saveSettings({ extraQq: list.join('\n') })
      syncConfig()
      return list
    }
    api.command({
      name: '18号',
      aliases: ['18'],
      desc: '额外 18+ 账号：/18号 加 QQ | /18号 删 QQ | /18号 列表 | /18号 暗号 新暗号（只存哈希）| /18号 锁（立刻关掉所有已开的）',
      run: async (arg) => {
        const a = String(arg || '').trim()
        const [op, q] = a.split(/\s+/)
        if (op === '暗号') {
          const e = st.lastEnroll
          if (e && Date.now() - e.at < 30000) { st.lastEnroll = null; return e.ok ? '暗号已更新（只存了加盐哈希，原文没落盘）' : '暗号格式不对（4~32 位数字），没改' }
          return secret ? '暗号已设置（加盐哈希）。要换：/18号 暗号 新暗号' : '还没设置暗号：/18号 暗号 你的暗号（或面板「权限」里填）'
        }
        if (op === '加' || op === 'add') {
          if (!/^\d{5,12}$/.test(q || '')) return '用法：/18号 加 QQ号'
          if (q === ownerQQ()) return '主人 QQ 本来就算'
          editExtra((l) => [...new Set([...l, q])])
          return `已加 ${q}：它在自己的私聊里对上暗号就能开 18+；已自动加进私聊白名单和记忆隔离。它不会拿到你的私密记忆。`
        }
        if (op === '删' || op === 'del' || op === 'rm') {
          if (!q) return '用法：/18号 删 QQ号'
          const before = extra()
          editExtra((l) => l.filter((x) => x !== q))
          if (st.chats && st.chats[q]) { st.chats[q].until = 0; st.chats[q].phase = ''; saveState() }
          return before.includes(q) ? `已移除 ${q}（已开的 18+ 立刻关掉；它对上过暗号的话，记忆仍然保持隔离）` : `${q} 本来就不在名单里`
        }
        if (op === '锁' || op === 'lock') { for (const c of Object.values(st.chats || {})) { c.until = 0; c.phase = '' } saveState(); return '已全部关掉' }
        const lines = [`主人 ${ownerQQ() || '（没设）'}${m.unlocked(ownerQQ()) ? '（已开）' : ''}`]
        for (const x of extra()) lines.push(`额外 ${x}${m.unlocked(x) ? '（已开）' : ''}`)
        lines.push(`她主动时找：${target() || '（无）'}；暗号：${secret ? '已设置' : '未设置'}；有效期 ${cfg().ttlMinutes} 分钟`)
        return lines.join('\n')
      },
    })
    api.command({
      name: '隔离号',
      aliases: ['isolate'],
      desc: '只隔离（不给 18+）的账号：/隔离号 加 QQ | /隔离号 删 QQ | /隔离号 列表。只有主人能用',
      run: async (arg, msg) => {
        if (msg && (msg.delegate || String(msg.userId || '') !== ownerQQ())) return '/隔离号 只有主人能用'
        if (msg && msg.kind !== 'private') return '这个命令只在主人私聊里用'
        const [op, q] = String(arg || '').trim().split(/\s+/)
        const cur = parseQqList(cfg().isolateQq)
        if (op === '加' || op === 'add') {
          if (!/^\d{5,12}$/.test(q || '')) return '用法：/隔离号 加 QQ号'
          api.saveSettings({ isolateQq: [...new Set([...cur, q])].join('\n') })
          isoOnly(); syncConfig()
          return `已隔离 ${mask(q)}：内容不外泄、不提起；18+ 照旧要暗号`
        }
        if (op === '删' || op === 'del' || op === 'rm') {
          if (!q) return '用法：/隔离号 删 QQ号'
          api.saveSettings({ isolateQq: cur.filter((x) => x !== q).join('\n') })
          st.isoLocked = (st.isoLocked || []).filter((x) => String(x) !== q); saveState(); syncConfig()
          return `已取消隔离 ${mask(q)}（它对上过暗号的话仍保持隔离）`
        }
        const list = isoOnly()
        return list.length ? '只隔离账号：' + list.map(mask).join('、') : '没有只隔离账号'
      },
    })
    api.command({ name: '暗号', aliases: ['handshake'], desc: '看 18+ 状态（/暗号 reset 关掉全部）', run: async (arg) => {
      if (String(arg || '').trim() === 'reset') { for (const c of Object.values(st.chats || {})) { c.until = 0; c.phase = '' } saveState(); return '已全部关掉' }
      return allowedList().map((q) => `${q}：${m.unlocked(q) ? '已开' : (m.chat(q).phase || '没开')}`).join('\n') || '没有允许账号'
    } })

    // ---------- 全局闸门（public-guard / memcore / mood / bio 用）----------
    const sameAs = () => false // 额外号没在身份表里映射成主人 → 不算同一个人
    const gate = {
      version: 2,
      isAllowed: (qq) => isAllowed(String(qq || '')),
      unlockedQq: (qq) => m.unlocked(String(qq || '')),
      unlockedChat: (chatId) => { const q = qqOfChat(chatId); return Boolean(q && m.unlocked(q)) },
      isCodeTurn: (chatId, text) => isCodeTurn(String(chatId || ''), text),
      isolated: () => [...isolatedSet()],
      hiddenQq: () => isoOnly(), // 只隔离号：日志 / 展示面打码用（redact.js）
      isIsolatedChat: (chatId) => { const q = qqOfChat(chatId); return Boolean(q && isolatedSet().has(q)) },
      // 存储用：隔离集合去掉主人本人（主人私聊照常进日常存储；隔离号不进聊天流水 / 大脑流水 / 话簿）
      isolatedPeers: () => [...isolatedSet()].filter((q) => q !== ownerQQ()),
      isIsolatedPeer: (chatId) => { const q = qqOfChat(chatId); return Boolean(q && q !== ownerQQ() && isolatedSet().has(q)) },
      leakCheck: (text, o = {}) => (cfg().enabled === false ? { ok: true } : fp.leakCheck(text, { exceptQq: String(o.exceptQq || ''), isolated: isolatedSet(), sameAs })),
      target,
    }
    globalThis.__DFY_ADULT_GATE__ = gate
    api.onDispose(() => { if (globalThis.__DFY_ADULT_GATE__ === gate) delete globalThis.__DFY_ADULT_GATE__ })

    function persistFp() { if (fp.isDirty()) { writeJson(fpFile, fp.toJSON()); fp.clean() } }
    api.every(60_000, persistFp, '隔离指纹落盘')
    api.onDispose(persistFp)
    api.every(5_000, migratePlain, '暗号明文迁移') // 只读内存里的配置，不走网络
    api.every(30_000, syncConfig, '18+ 名单同步')
    api.later(1500, () => { migratePlain(); syncConfig() })
    api.later(4000, () => api.log.info(`暗号模块就绪：允许账号 ${allowedList().length} 个，暗号${secret ? '已设置' : '未设置（/18号 暗号 xxx 或面板「权限」里设）'}，有效期 ${cfg().ttlMinutes} 分钟`))

    // 旧接口：unlocked() 不带参数 = 主人私聊
    // 星海「权限」页的 🔐 暗号卡片用：只报状态，不含暗号原文 / 哈希
    api.route('/status', async () => {
      const mask = (q) => (q ? '****' + String(q).slice(-4) : '')
      const list = allowedList()
      return { ok: true, enabled: cfg().enabled !== false, set: Boolean(secret), setAt: (secret && secret.setAt) || 0, allowed: list.length, extra: extra().length, lastUnlock: mask(st.lastUnlock), activeNow: list.filter((q) => { try { return m.unlocked(q) } catch { return false } }).length }
    })
    return { unlocked: (x) => (x == null ? m.unlocked(ownerQQ()) : (String(x).startsWith('private:') ? gate.unlockedChat(x) : m.unlocked(String(x)))), step: () => m.chat(ownerQQ()).phase || '', isOwnerPrivate: (chat) => chatQq(chat) === ownerQQ(), gate }
  },
}
