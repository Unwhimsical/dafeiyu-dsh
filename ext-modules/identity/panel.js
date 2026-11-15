// 身份对照 · 记忆星海唯一的身份/隐私编辑器（中文面板）
// 人（QQ/抖音/微信/称呼）→ 插件 ext.identity.people；每人私聊隔离、群可见、默认策略、说话守卫 → 星海 privacy.json（经 /ext/identity/privacy 代理）；
// 重点隔离 → ext.memcore.isolatePeople（原「记忆桥」里的那一栏搬到这里）。旧的工作台「隐私」页与 privacy/ 子页已下线。
return function IdentityPanel({ settings, draftSettings, setSettings, save, toast }) {
  const s = draftSettings || settings || {}
  const POL = [{ value: 'private', label: '隔离' }, { value: 'scoped', label: '限定' }, { value: 'public', label: '公开' }]
  const digits = (v) => String(v || '').replace(/\D/g, '')
  const parse = (raw) => {
    const out = []
    for (let line of String(raw || '').split(/[\n;；]+/)) {
      line = line.trim()
      if (!line || line.startsWith('#')) continue
      let m = line.match(/^(\d{4,20})\s*[=＝]\s*(\d{0,25})\s*[=＝]\s*([^:：]*)\s*[:：]\s*(.*)$/)
      if (m) { out.push({ qq: m[1], dy: m[2] || '', wechat: String(m[3] || '').trim(), name: String(m[4] || '').trim() }); continue }
      m = line.match(/^(\d{4,20})\s*[=＝]\s*(\d{0,25})\s*[=＝]\s*([^:：]*)$/)
      if (m) { out.push({ qq: m[1], dy: m[2] || '', wechat: String(m[3] || '').trim(), name: '' }); continue }
      m = line.match(/^(\d{4,20})\s*(?:[=＝]\s*(\d{4,25})?)?\s*(?:[:：]\s*(.*))?$/)
      if (m) out.push({ qq: m[1], dy: m[2] || '', wechat: '', name: String(m[3] || '').trim() })
    }
    return out
  }
  const format = (list) => (list || []).map((p) => {
    const dy = p.dy || '', wx = p.wechat || ''
    const mid = (dy || wx) ? ('=' + dy + (wx ? '=' + wx : '')) : ''
    return p.qq + mid + (p.name ? ':' + p.name : '')
  }).join('\n')
  const isoParse = (raw) => String(raw || '').split(/[,，;；\n]+/).map((x) => x.trim()).filter(Boolean)

  const [pv, setPv] = React.useState(null)       // 星海 privacy.json
  const [chats, setChats] = React.useState([])
  const [rows, setRows] = React.useState([])     // 额外的人 + 每人策略
  const [core, setCore] = React.useState([])     // 主人 / 家人 / 她自己 的策略
  const [groups, setGroups] = React.useState([])
  const [iso, setIso] = React.useState([])       // 重点隔离（原记忆桥）
  const [guard, setGuard] = React.useState({ enabled: true, allow: '' })
  const [def, setDef] = React.useState('public')
  const [err, setErr] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [ck, setCk] = React.useState({ chat: '', text: '', out: '' })

  const canSeeOf = (P, id) => Object.keys(P.groups || {}).filter((g) => ((P.groups[g] || {}).can_see || []).map(String).some((x) => x === id || x === 'p:' + id)).join(',')

  const load = async () => {
    const r = await call('/privacy')
    if (!r || r.ok === false) { setErr((r && r.message) || '读不到星海隐私规则'); return }
    setErr('')
    const P = r.privacy || {}
    P.private_chats = P.private_chats || {}; P.groups = P.groups || {}; P.guard = P.guard || { enabled: true, allow_phrases: [] }
    setPv(P); setChats(r.known_chats || [])
    const isoList = isoParse(r.isolatePeople)
    setIso(isoList)
    const isIso = (qq) => isoList.some((e) => e.split('=')[0].trim() === qq)
    const pol = (id) => P.private_chats[id] || P.default || 'public'
    const people = parse(s.people)
    const known = new Set([digits(s.ownerQq), digits(s.momQq), digits(s.selfQq), ...people.map((p) => p.qq)].filter(Boolean))
    // 旧「身份·隐私」页手填过、但插件里没有的人：并进来（保存后插件成为唯一来源，不丢数据）
    const pm = Object.assign({}, r.person_map || {}, P.person_map || {})
    const legacy = Object.keys(pm).filter((k) => /^\d{4,20}$/.test(k) && !known.has(k)).map((k) => ({ qq: k, dy: digits(pm[k].douyin), wechat: String(pm[k].wechat || ''), name: String(pm[k].label || ''), legacy: true }))
    setRows([...people, ...legacy].map((p) => ({ ...p, wechat: p.wechat || String((pm[p.qq] || {}).wechat || ''), pol: pol(p.qq), gs: canSeeOf(P, p.qq), iso: isIso(p.qq) })))
    setCore([
      { key: 'owner', label: '主人', qq: digits(s.ownerQq), dy: digits(s.ownerDouyin), wx: s.ownerWechat || '' },
      { key: 'mom', label: '家人', qq: digits(s.momQq), dy: digits(s.momDouyin), wx: s.momWechat || '' },
      { key: 'self', label: '她自己', qq: digits(s.selfQq), dy: digits(s.selfDouyin), wx: s.selfWechat || '' },
    ].map((p) => ({ ...p, pol: p.qq ? pol(p.qq) : 'private', gs: p.qq ? canSeeOf(P, p.qq) : '', iso: p.qq ? isIso(p.qq) : false })))
    const gids = new Set([...(r.known_chats || []).filter((c) => String(c.chat).startsWith('g:')).map((c) => String(c.chat).slice(2)), ...Object.keys(P.groups)])
    const label = (g) => ((r.known_chats || []).find((c) => c.chat === 'g:' + g) || {}).label || g
    setGroups([...gids].map((g) => ({ id: g, label: label(g), policy: (P.groups[g] || {}).policy || 'public' })))
    setGuard({ enabled: P.guard.enabled !== false, allow: (P.guard.allow_phrases || []).join(' ') })
    setDef(P.default || 'public')
  }
  React.useEffect(() => { load() }, [s.people, s.ownerQq, s.momQq, s.selfQq])

  const editRow = (i, patch) => setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const editCore = (i, patch) => setCore(core.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))

  const persist = async () => {
    if (!pv) return
    setBusy(true)
    try {
      const cleaned = rows.filter((r) => /^\d{4,20}$/.test(digits(r.qq))).map((r) => ({ ...r, qq: digits(r.qq), dy: digits(r.dy) }))
      const text = format(cleaned)
      setSettings({ people: text })
      await save({ people: text })
      // 星海隐私规则
      const next = JSON.parse(JSON.stringify(pv))
      next.default = def
      next.guard = { ...(next.guard || {}), enabled: !!guard.enabled, allow_phrases: guard.allow.split(/\s+/).filter(Boolean) }
      const all = [...core.filter((p) => p.qq).map((p) => ({ qq: p.qq, dy: p.dy, wechat: p.wx, name: p.label, pol: p.pol, gs: p.gs, iso: p.iso })), ...cleaned]
      const ids = new Set(); all.forEach((p) => { ids.add(p.qq); if (p.dy) ids.add(p.dy) })
      Object.keys(next.groups).forEach((g) => { const o = next.groups[g]; if (o && o.can_see) o.can_see = o.can_see.map(String).filter((x) => !ids.has(x.replace(/^p:/, ''))) })
      groups.forEach((g) => { next.groups[g.id] = { ...(next.groups[g.id] || { can_see: [] }), policy: g.policy } })
      const pm = {}
      Object.keys(next.person_map || {}).forEach((k) => { if (!/^\d{4,20}$/.test(k)) pm[k] = next.person_map[k] })   // 非 QQ 键原样保留
      all.forEach((p) => {
        pm[p.qq] = { douyin: p.dy || '', wechat: p.wechat || '', label: p.name || '', manual: true }
        next.private_chats[p.qq] = p.pol
        if (p.dy) next.private_chats[p.dy] = p.pol
        if (p.wechat) next.private_chats['wx_' + String(p.wechat).replace(/[^A-Za-z0-9]/g, '').slice(0, 48)] = p.pol
        String(p.gs || '').split(/[,，\s]+/).filter(Boolean).forEach((g) => {
          const o = next.groups[g] = next.groups[g] || { policy: 'public', can_see: [] }
          o.can_see = Array.from(new Set((o.can_see || []).concat([p.qq]).concat(p.dy ? [p.dy] : [])))
        })
      })
      next.person_map = pm
      // 重点隔离：勾了的人写成 QQ=抖音；表里没有的旧条目原样保留
      const inTable = new Set(all.map((p) => p.qq))
      const isoNext = iso.filter((e) => !inTable.has(e.split('=')[0].trim()))
      all.filter((p) => p.iso).forEach((p) => isoNext.push(p.qq + '=' + (p.dy || '')))
      const r = await call('/privacy/save', { privacy: next, isolatePeople: isoNext.join(',') })
      toast(r.message || (r.ok ? '保存好了' : '没保存成功'), r.ok === false ? 'err' : 'ok')
      await load()
    } catch (e) { toast('保存失败：' + e.message, 'err') }
    setBusy(false)
  }

  const inp = (value, onChange, ph, w) => h('input', { className: 'ab-input', style: { width: w || 120 }, value: value || '', placeholder: ph || '', onChange: (e) => onChange(e.target.value) })
  const sel = (value, onChange) => h(ui.Select, { value, width: 92, onChange, options: POL })
  const chk = (v, onChange) => h('input', { type: 'checkbox', checked: !!v, onChange: (e) => onChange(e.target.checked) })
  const saveBtn = h(ui.Btn, { small: true, kind: 'primary', disabled: busy || !pv, onClick: persist }, busy ? '保存中…' : '保存身份与隐私')

  if (err) return h('div', { className: 'ab-note err' }, err, '　', h(ui.Btn, { small: true, onClick: load }, '重试'))
  if (!pv) return h(ui.Empty, { icon: '⏳', text: '正在读星海隐私规则…' })

  return h('div', { className: 'ab-grid' },
    h(ui.Card, { title: '固定的三个人', desc: '号码在上方表单改（主人 / 家人 / 她自己，含微信）；这里定他们的私聊隔离和限定群。', right: saveBtn },
      h('table', { className: 'ab-table' },
        h('thead', null, h('tr', null, ['称呼', 'QQ', '抖音', '微信', '私聊', '限定给这些群', '重点隔离'].map((x) => h('th', { key: x }, x)))),
        h('tbody', null, core.map((p, i) => h('tr', { key: p.key },
          h('td', null, p.label), h('td', null, p.qq || '—'), h('td', null, p.dy || '—'), h('td', null, p.wx || '—'),
          h('td', null, p.qq ? sel(p.pol, (v) => editCore(i, { pol: v })) : '—'),
          h('td', null, p.qq ? inp(p.gs, (v) => editCore(i, { gs: v }), '群号,逗号分隔', 150) : '—'),
          h('td', null, p.qq && p.key !== 'owner' ? chk(p.iso, (v) => editCore(i, { iso: v })) : '—')))))),
    h(ui.Card, { title: '更多人', desc: '每行一个人。私聊：隔离 = 只在和他的私聊里想得起；限定 = 再加上右边列出的群；公开 = 哪里都行。重点隔离 = 他的 QQ 和抖音私聊都只对他自己开放（原「记忆桥」里的「重点隔离的人」）。18+ 永远只在主人私聊，不受这里影响。',
      right: h('div', { className: 'ab-flex' }, h(ui.Btn, { small: true, onClick: () => setRows([...rows, { qq: '', dy: '', wechat: '', name: '', pol: 'private', gs: '', iso: false }]) }, '＋ 添加'), saveBtn) },
      h('table', { className: 'ab-table' },
        h('thead', null, h('tr', null, ['称呼', 'QQ', '抖音 uid', '微信', '私聊', '限定给这些群', '重点隔离', ''].map((x, k) => h('th', { key: k }, x)))),
        h('tbody', null,
          rows.length ? rows.map((r, i) => h('tr', { key: i },
            h('td', null, inp(r.name, (v) => editRow(i, { name: v }), '称呼', 90), r.legacy ? h('div', { className: 'ab-small ab-muted' }, '来自旧隐私页，保存后并入') : null),
            h('td', null, inp(r.qq, (v) => editRow(i, { qq: v }), 'QQ', 110)),
            h('td', null, inp(r.dy, (v) => editRow(i, { dy: v }), '抖音', 130)),
            h('td', null, inp(r.wechat, (v) => editRow(i, { wechat: v }), '微信', 110)),
            h('td', null, sel(r.pol, (v) => editRow(i, { pol: v }))),
            h('td', null, inp(r.gs, (v) => editRow(i, { gs: v }), '群号,逗号分隔', 150)),
            h('td', null, chk(r.iso, (v) => editRow(i, { iso: v }))),
            h('td', null, h(ui.Btn, { small: true, kind: 'danger', onClick: () => setRows(rows.filter((_, k) => k !== i)) }, '删')))) :
            h('tr', null, h('td', { colSpan: 8, className: 'ab-muted' }, '还没有额外的人，点「添加」。'))))),
    h(ui.Card, { title: '群聊 · 默认 · 说话守卫', desc: '群聊策略决定群里写下的记忆能被带到哪里；默认策略给没单独设置的私聊用；说话守卫在她要说出私密记忆里的内容时拦一下。', right: saveBtn },
      h(ui.Row, { label: '私聊默认' }, sel(def, setDef)),
      groups.length ? h('table', { className: 'ab-table' },
        h('thead', null, h('tr', null, ['群', '群号', '群里的记忆'].map((x) => h('th', { key: x }, x)))),
        h('tbody', null, groups.map((g, i) => h('tr', { key: g.id }, h('td', null, g.label), h('td', null, g.id),
          h('td', null, sel(g.policy, (v) => setGroups(groups.map((x, k) => (k === i ? { ...x, policy: v } : x))))))))) : h('div', { className: 'ab-muted ab-small' }, '星海还没见过任何群。'),
      h(ui.Row, { label: '说话守卫', hint: '开着时会拦下泄漏私密记忆的话' }, chk(guard.enabled, (v) => setGuard({ ...guard, enabled: v }))),
      h(ui.Row, { label: '放行短语', hint: '空格分隔；命中这些词不拦' }, inp(guard.allow, (v) => setGuard({ ...guard, allow: v }), '例如：生日快乐', 320))),
    h(ui.Card, { title: '泄漏自检', desc: '输入会话（p:QQ 或 g:群号）和一句话，看在那里能想起几条、这句话会不会被拦。' },
      h('div', { className: 'ab-flex' },
        inp(ck.chat, (v) => setCk({ ...ck, chat: v }), 'g:123456', 140),
        inp(ck.text, (v) => setCk({ ...ck, text: v }), '她要说的话', 300),
        h(ui.Btn, { small: true, onClick: async () => { const r = await call('/privacy/check', { chat: ck.chat.trim(), text: ck.text }); setCk({ ...ck, out: r.ok === false ? r.message : ('能想起 ' + r.visible + ' 条、隐藏 ' + r.hidden + ' 条；这句话' + (r.guard && r.guard.blocked ? '会被拦下' : '可以说')) }) } }, '检查')),
      ck.out ? h('div', { className: 'ab-small', style: { marginTop: 8 } }, ck.out) : null),
  )
}
