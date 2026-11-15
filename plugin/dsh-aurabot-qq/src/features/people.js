// 跨平台身份对照（QQ ↔ 抖音）：一个人 = 一个规范 id「person:qq:<QQ>」。
// 数据来源（只读，谁写的谁说了算）：
//   1. 扩展模块 identity 的六个号（主人 / 家人 / 她自己）
//   2. identity 的「people」对照表：一行一个「QQ=抖音:名字」（抖音、名字可省，也认「QQ:名字」）
//   3. memcore 的 isolatePeople（老格式「QQ=抖音」逗号分隔）
// 大脑那边 brain/identity_sync.py 读的是同一份 config、同一个格式。

const QQ_RE = /^\d{4,20}$/
const digits = (v) => String(v ?? '').replace(/\D/g, '')

export const personKey = (qq) => (digits(qq) ? 'person:qq:' + digits(qq) : '')

/** 「QQ=抖音:名字」多行文本（或 [{qq,dy,name}]）→ [{qq, dy, name}] */
export function parsePeople(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => ({ qq: digits(x?.qq), dy: digits(x?.dy ?? x?.douyin), wechat: String(x?.wechat ?? x?.wx ?? '').trim(), name: String(x?.name ?? '').trim() })).filter((x) => QQ_RE.test(x.qq))
  }
  const out = []
  for (let line of String(raw ?? '').split(/[\n;；]+/)) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    // QQ=抖音=微信:名字 或 QQ=抖音:名字 或 QQ:名字
    let m = line.match(/^(\d{4,20})\s*[=＝]\s*(\d{0,25})\s*[=＝]\s*([^:：]*)\s*[:：]\s*(.*)$/)
    if (m) { out.push({ qq: m[1], dy: m[2] || '', wechat: String(m[3] || '').trim(), name: String(m[4] || '').trim() }); continue }
    m = line.match(/^(\d{4,20})\s*[=＝]\s*(\d{0,25})\s*[=＝]\s*([^:：]*)$/)
    if (m) { out.push({ qq: m[1], dy: m[2] || '', wechat: String(m[3] || '').trim(), name: '' }); continue }
    m = line.match(/^(\d{4,20})\s*(?:[=＝]\s*(\d{4,25})?)?\s*(?:[:：]\s*(.*))?$/)
    if (m) out.push({ qq: m[1], dy: m[2] || '', wechat: '', name: String(m[3] || '').trim() })
  }
  return out
}

export function formatPeople(list) {
  return (list || []).map((p) => {
    const dy = p.dy || ''
    const wx = p.wechat || ''
    const mid = (dy || wx) ? ('=' + dy + (wx ? '=' + wx : '')) : (wx ? '==' + wx : '')
    return p.qq + mid + (p.name ? ':' + p.name : '')
  }).join('\n')
}

/** 把一个人加进 / 改进对照表文本（按 QQ 去重，新值覆盖旧值；空字段保留旧的） */
export function upsertPeople(raw, person) {
  const list = parsePeople(raw)
  const p = { qq: digits(person?.qq), dy: digits(person?.dy), wechat: String(person?.wechat ?? person?.wx ?? '').trim(), name: String(person?.name ?? '').trim() }
  if (!QQ_RE.test(p.qq)) throw new Error('QQ 号不对（4~20 位数字）')
  const i = list.findIndex((x) => x.qq === p.qq)
  if (i >= 0) list[i] = { qq: p.qq, dy: p.dy || list[i].dy, wechat: p.wechat || list[i].wechat || '', name: p.name || list[i].name }
  else list.push(p)
  return formatPeople(list)
}

export function removePeople(raw, qq) {
  const q = digits(qq)
  return formatPeople(parsePeople(raw).filter((x) => x.qq !== q))
}

/** 一句话命令解析：「加 12345=67890:小王」「删 12345」「列表」 */
export function parsePeopleCommand(arg) {
  const s = String(arg ?? '').trim()
  if (!s || /^(列表|list|看|查看|状态)$/i.test(s)) return { op: 'list' }
  let m = s.match(/^(?:加|添加|改|add|set)\s+(.+)$/i)
  if (m) { const [p] = parsePeople(m[1]); return p ? { op: 'add', person: p } : { op: 'bad' } }
  m = s.match(/^(?:删|删除|去掉|rm|del)\s+(\d{4,20})$/i)
  if (m) return { op: 'remove', qq: m[1] }
  const [p] = parsePeople(s)
  return p ? { op: 'add', person: p } : { op: 'bad' }
}

/** 汇总全部来源 → [{qq, dy, name, role}]，按 QQ 去重（先出现的名字优先，抖音号补齐） */
export function allPeople(cfg = {}, identityDefaults = {}) {
  const ext = cfg.ext || {}
  const id = { ...identityDefaults, ...(ext.identity || {}) }
  const out = new Map()
  const put = (qq, dy, name, role = '') => {
    const q = digits(qq)
    if (!QQ_RE.test(q)) return
    const prev = out.get(q)
    if (prev) out.set(q, { ...prev, dy: prev.dy || digits(dy), name: prev.name || name, role: prev.role || role })
    else out.set(q, { qq: q, dy: digits(dy), name: String(name || ''), role })
  }
  put(id.ownerQq, id.ownerDouyin, String(id.ownerCall || '主人'), 'owner')
  put(id.momQq, id.momDouyin, String(id.familyName || '家人'), 'mom')
  put(id.selfQq, id.selfDouyin, '大肥鱼自己', 'self')
  for (const p of parsePeople(id.people)) put(p.qq, p.dy, p.name, 'people')
  for (const chunk of String(ext.memcore?.isolatePeople || '').split(/[,，;；\n]+/)) {
    const m = chunk.trim().match(/^(\d{4,20})\s*[=:：]\s*(\d{4,25})?$/)
    if (m) put(m[1], m[2] || '', '', 'isolate')
  }
  return [...out.values()]
}

/** 任意会话/号 → 规范 id。认：12345 / private:12345 / dy:67890 / private:dy:67890 / p:12345 / person:qq:12345 */
export function personMap(list) {
  const map = {}
  for (const p of list || []) {
    const key = personKey(p.qq)
    map[p.qq] = key; map['private:' + p.qq] = key; map['p:' + p.qq] = key; map[key] = key
    if (p.dy) { map['dy:' + p.dy] = key; map['private:dy:' + p.dy] = key; map[p.dy] = key }
  }
  return map
}

export function personOf(rawId, list) {
  const id = String(rawId ?? '').trim()
  if (!id || /^group:|^g:/.test(id)) return ''
  const map = personMap(list)
  if (map[id]) return map[id]
  const bare = id.replace(/^(private:|p:|dy:)+/, '')
  return (/dy:/.test(id) && map['dy:' + bare]) || map[bare] || ''
}

/** 记忆大脑 v2 的会话号：同一个人不管哪个平台都落到 p:<QQ>；不认识的抖音号照旧落 p:<uid>（和原来存的记忆对得上） */
export function v2ChatOf(rawId, list) {
  const id = String(rawId ?? '')
  if (id.startsWith('group:')) return 'g:' + digits(id)
  if (id.startsWith('g:')) return id
  const p = personOf(id, list)
  if (p) return 'p:' + p.replace('person:qq:', '')
  const d = digits(id)
  return d ? 'p:' + d : 'p:0'
}
