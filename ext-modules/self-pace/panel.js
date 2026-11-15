// 「自己的节奏」自定义面板：把 7 项数值直接摆出来，不用去翻系统自带表单。
// 这是函数体，最后 return 一个 React 组件；可用 React / h / ui / call（见 modules/API.md「面板」）。
const NUMS = [
  ['hardMaxPerDay', '天花板：一天最多主动几次', '主人定的硬顶，她自己调的时候改不动'],
  ['defaultTarget', '她没拿主意时默认几次', '每天零点回到这个值'],
  ['minGapMinutes', '两次主动至少隔几分钟', '追问减半；防刷屏'],
  ['quietFrom', '夜里安静从几点', '0–23'],
  ['quietTo', '夜里安静到几点', '0–24'],
]
const DEFAULTS = { enabled: true, hardMaxPerDay: 12, defaultTarget: 8, minGapMinutes: 20, quietFrom: 1, quietTo: 8, selfTune: true }

return function Panel({ settings, save, toast, reload }) {
  const [v, setV] = React.useState(() => {
    const o = {}
    for (const k of Object.keys(DEFAULTS)) o[k] = settings && settings[k] !== undefined ? settings[k] : DEFAULTS[k]
    return o
  })
  const [st, setSt] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    let alive = true
    call('/pace/state').then((r) => { if (alive) setSt(r) }).catch(() => {})
    return () => { alive = false }
  }, [])

  const put = (k, val) => setV((prev) => ({ ...prev, [k]: val }))
  const numRow = (key, label, hint) => h(ui.Row, { label, hint },
    h('input', {
      className: 'ab-input sm', type: 'number', value: v[key],
      onChange: (e) => put(key, e.target.value === '' ? '' : Number(e.target.value)),
    }))
  const switchRow = (key, label, hint) => h(ui.Row, { label, hint },
    h('input', { type: 'checkbox', checked: !!v[key], onChange: (e) => put(key, e.target.checked) }))

  const saveAll = async () => {
    const patch = {}
    for (const k of Object.keys(DEFAULTS)) patch[k] = v[k] === '' ? DEFAULTS[k] : v[k]
    setBusy(true)
    try {
      const r = await save(patch)
      if (r && r.ok === false) toast(r.message || '没保存', 'err')
      else { toast('保存好了', 'ok'); if (reload) reload() }
    } catch (e) { toast('没保存：' + e.message, 'err') }
    setBusy(false)
  }

  const used = st && st.used ? Number(st.used.private || 0) + Number(st.used.group || 0) : 0
  const today = st && st.ok !== false
    ? `今天主动 ${used} 次 / 她定的目标 ${st.target} 次 / 天花板 ${st.hard} 次（${st.day}）`
    : '今天的账还没读到（面板桥没连上），设置照样能改。'

  return h(ui.Card, { title: '自己的节奏 · 设置', desc: '上限你定，天花板以内她自己拿主意。改完点「保存这页」，不用重启。' },
    h('div', { className: 'ab-note', style: { marginBottom: 10 } }, today),
    NUMS.map(([k, label, hint]) => h(React.Fragment, { key: k }, numRow(k, label, hint))),
    switchRow('selfTune', '允许她自己调节奏', '关掉 = 按默认次数固定来'),
    switchRow('enabled', '启用这本额度账', '关掉 = 四路回到各自原来的老上限'),
    h('div', { style: { marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' } },
      h(ui.Btn, { kind: 'primary', onClick: saveAll, disabled: busy }, busy ? '保存中…' : '保存这页'),
      h('span', { className: 'ab-small ab-muted' }, '上面系统自带的表单改的是同一处设置，任选一个用。QQ 里也能发 /主动设 天花板 12')),
  )
}
