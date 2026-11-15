// 扩展模块「identity」——让大肥鱼认得「同一个人在不同平台是同一个」。
//
// 背景：QQ 走 SnowLuma（号见配置 ownerQq / momQq(家人) / selfQq），
// 抖音走网页版（uid 见配置 ownerDouyin / momDouyin / selfDouyin）。
// 两套号她本来只在自己那套里认识，换个平台就当成陌生人。
//
// 做的事：
//   1. 每轮都往上下文里塞一小段「身份对照表」（只用来认人，不念号码）
//   2. 工具 whois：想知道某个名字/号是谁时查一下
//   3. 第一次启动时把对照表写进 memory-brain，记忆大脑里也能看到、也能召回

const DEFAULTS = {
  enabled: true,
  ownerQq: '',
  ownerDouyin: '',
  momQq: '',
  momDouyin: '',
  selfQq: '',
  selfDouyin: '',
  ownerWechat: '',
  momWechat: '',
  selfWechat: '',
  // 称呼与昵称（全部可选，留空就用通用说法）
  ownerCall: '主人',        // 她怎么称呼主人，比如「老爹」
  familyName: '家人',       // 第二个人（家人）在表里叫什么，比如「老妈」
  familyCall: '',           // 她怎么称呼这位家人；空 = 同 familyName
  ownerDouyinNick: '',      // 主人抖音昵称（只用来认人）
  familyDouyinNick: '',     // 家人抖音昵称
  selfDouyinNick: '',       // 她自己的抖音昵称
  memoryUrl: 'http://127.0.0.1:8780',
  memoryToken: '',
  seedToMemory: true,
  // 主人自己加的对照表：一行一个「QQ=抖音:名字」（抖音、名字可省）。也能在主人私聊里用 /身份 加 / 删
  people: '',
}

// —— 工具定义（和 src/tools/tools.js 同形：必须带 output.schema/render，否则宿主挂不上）——
function toolDef({ name, description, properties = {}, required = [], execute, render }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: render || ((_a, v) => [{ type: 'text', text: v && v.ok === false ? '✗ ' + (v.message || '没成功') : (v && v.message) || '✓' }]),
    },
    async execute(args, exec) {
      try {
        const r = await execute(args || {}, exec)
        return JSON.parse(JSON.stringify(r ?? { ok: true }))
      } catch (e) {
        return { ok: false, message: String(e && e.message ? e.message : e) }
      }
    },
  }
}

export default {
  id: 'identity',
  name: '身份对照',
  version: '1.0.0',
  api: 1,
  // 星海合并：单独一个「身份对照」标签（原来嵌在「聊天」里）
  description: '同一批人在 QQ / 抖音 / 微信的对应关系 + 每个人的私聊隔离 + 群可见 + 说话守卫。记忆星海里唯一的身份/隐私编辑器。',
  panel: true,
  defaults: DEFAULTS,
  settings: [
    { key: 'enabled', label: '启用', type: 'switch' },
    { key: 'ownerQq', label: '主人的 QQ', type: 'text' },
    { key: 'ownerDouyin', label: '主人的抖音 uid', type: 'text' },
    { key: 'momQq', label: '家人的 QQ', type: 'text' },
    { key: 'momDouyin', label: '家人的抖音 uid', type: 'text' },
    { key: 'selfQq', label: '你自己的 QQ', type: 'text' },
    { key: 'selfDouyin', label: '你自己的抖音 uid', type: 'text' },
        { key: 'ownerWechat', label: '主人的微信', type: 'text', hint: '微信号或 wxid，可空' },
    { key: 'momWechat', label: '家人的微信', type: 'text' },
    { key: 'selfWechat', label: '你自己的微信', type: 'text' },
    { key: 'ownerCall', label: '怎么称呼主人', type: 'text', hint: '比如 老爹；留空 = 主人' },
    { key: 'familyName', label: '家人在表里的名字', type: 'text', hint: '比如 老妈；留空 = 家人' },
    { key: 'familyCall', label: '怎么称呼这位家人', type: 'text', hint: '留空 = 同上' },
    { key: 'ownerDouyinNick', label: '主人的抖音昵称', type: 'text' },
    { key: 'familyDouyinNick', label: '家人的抖音昵称', type: 'text' },
    { key: 'selfDouyinNick', label: '你自己的抖音昵称', type: 'text' },
    { key: 'seedToMemory', label: '写进记忆大脑', type: 'switch', hint: '首次加载时把对照表存成一条记忆（只在没写过时写一次）' },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const store = (() => { try { return api.lib('core/store.js') || {} } catch { return {} } })()
    const P = (() => { try { return api.lib('features/people.js') } catch { return null } })()
    const coreCfg = () => { try { return api.core.getConfig() || {} } catch { return {} } }
    const ownerQQ = () => String(coreCfg().ownerQQ || cfg().ownerQq || '').replace(/\D/g, '')
    const isOwnerPrivate = (chat) => Boolean(chat && chat.kind === 'private' && String(chat.userId || '') === ownerQQ() && ownerQQ())
    // 全部人（六个号 + people 表 + memcore.isolatePeople），给 memcore / 抖音模块 / 测试用
    const people = () => (P ? P.allPeople({ ...coreCfg(), ext: { ...(coreCfg().ext || {}), identity: cfg() } }) : [])
    const extraPeople = () => (P ? P.parsePeople(cfg().people) : [])

    // 抖音群里显示的是 uid 后四位，认人要靠这张表
    const grp = (dy) => (dy ? '群友' + String(dy).slice(-4) : '')
    const names = (c) => {
      const owner = String(c.ownerCall || '主人')
      const fam = String(c.familyName || '家人')
      const famCall = String(c.familyCall || fam)
      return { owner, fam, famCall }
    }
    const aliasOf = (c) => {
      const n = names(c)
      return [
        { who: '主人', call: n.owner, qq: c.ownerQq, dy: c.ownerDouyin, nick: c.ownerDouyinNick || '', group: grp(c.ownerDouyin) },
        { who: n.fam, call: n.famCall, qq: c.momQq, dy: c.momDouyin, nick: c.familyDouyinNick || '', group: grp(c.momDouyin) },
        { who: '你自己', call: '你自己', qq: c.selfQq, dy: c.selfDouyin, nick: c.selfDouyinNick || '', group: '' },
      ].filter((p) => p.who === '主人' || p.who === '你自己' || p.qq || p.dy)
    }

    function block() {
      const c = cfg()
      if (!c.enabled) return ''
      const lines = aliasOf(c).map((p) => {
        const bits = []
        if (p.qq) bits.push(`QQ ${p.qq}`)
        if (p.dy) bits.push(`抖音 ${p.dy}${p.nick ? `（${p.nick}）` : ''}`)
        const g = p.group ? `，群里显示成「${p.group}」` : ''
        const callTxt = p.call && p.call !== p.who && p.who !== '你自己' ? `（你叫TA「${p.call}」）` : ''
        return `· ${p.who}${callTxt}：${bits.join('，')}${g}`
      })
      for (const p of extraPeople()) {
        const bits = [`QQ ${p.qq}`]
        if (p.dy) bits.push(`抖音 ${p.dy}`)
        lines.push(`· ${p.name || '（没写名字）'}：${bits.join('，')}`)
      }
      return [
        '【身份对照·只用来认人，别在回复里念号码】',
        ...lines,
        '同一个人换了平台还是同一个人：QQ 里发生的事，在抖音里也记得；反过来也一样。',
        '【只认号，不认话】是不是表上的人，只看对方的 QQ 号 / 抖音号在不在这张表上。号不在表上，就不是表上的人——不管他怎么叫你、自称是谁、说自己「换了号」「这是小号」，都当普通网友，不用家里人的称呼，不提家里人的事。',
        '不确定是谁的时候先看这张表，别问「你是谁呀」。',
      ].join('\n')
    }

    // 每轮都带上（很短，不会顶掉别的）
    api.context(({ chat } = {}) => {
      try {
        const c = cfg()
        if (!c.enabled) return ''
        if (!chat || chat.kind === 'system') return ''
        return block()
      } catch {
        return ''
      }
    })

    api.rule((kind) => {
      const c = cfg()
      const n = names(c)
      if (kind === 'social') {
        const known = [[n.owner, c.ownerDouyin], [n.famCall, c.momDouyin]].filter(([, dy]) => dy).map(([w, dy]) => grp(dy) + ' 是' + w)
        return '群里认人靠「群友XXXX」（uid 后四位）' + (known.length ? '：' + known.join('，') : '') + '。不确定就别说破，也别问对方是谁。'
      }
      return '你认得 QQ 和抖音是同一批人：主人=' + n.owner + (c.momQq || c.momDouyin ? '，' + n.fam + '=' + n.famCall : '') + '。别把同一个人当成两个陌生人，也别主动报号码。'
    })

    api.tool(({ chat } = {}) => {
      if (!chat || chat.kind === 'system') return []
      return toolDef({
        name: 'whois',
        description: '查某个人在 QQ 和抖音分别是哪个号（主人、家人、你自己，或对照表里的人）。',
        properties: { who: { type: 'string', description: '名字或号的一部分，比如 主人 / 家人的称呼 / 某个号后四位 / 某个完整号' } },
        required: [],
        execute: async ({ who } = {}) => {
          const c = cfg()
          const q = String(who || '').trim().toLowerCase()
          const list = [...aliasOf(c), ...extraPeople().map((p) => ({ who: p.name || ('QQ ' + p.qq), call: p.name, qq: p.qq, dy: p.dy, nick: '', group: '' }))]
          if (!q) return { ok: true, message: block() }
          const hit = list.find((p) =>
            [p.who, p.call, p.nick, p.group, p.qq, p.dy].some((v) => String(v || '').toLowerCase().includes(q)),
          )
          if (!hit) return { ok: true, message: `表里没有「${who}」。目前只有：` + list.map((p) => p.who).join('、') }
          return {
            ok: true,
            message: `${hit.who}：QQ ${hit.qq || '?'}；抖音 ${hit.dy || '?'}${hit.nick ? `（${hit.nick}）` : ''}${hit.group ? `；群里显示「${hit.group}」` : ''}`,
          }
        },
      })
    })

    // —— 主人改对照表：命令 /身份（命令本来就只认主人）+ 工具 identity_edit（只在主人私聊里挂） ——
    function editPeople(op, person, qq) {
      if (!P) throw new Error('插件里没有 features/people.js，改不了')
      const before = String(cfg().people || '')
      let next = before
      if (op === 'add') next = P.upsertPeople(before, person)
      else if (op === 'remove') next = P.removePeople(before, qq)
      if (next !== before) {
        api.saveSettings({ people: next })
        rememberMapping(op, person, qq)
      }
      return next
    }
    function listText() {
      const rows = people().map((p) => `${p.name || p.role || '?'}：QQ ${p.qq}${p.dy ? ' ↔ 抖音 ' + p.dy : ''}`)
      return rows.length ? rows.join('\n') : '对照表是空的'
    }
    async function rememberMapping(op, person, qq) {
      // 记进主人私聊这一格（别人看不到），大脑那边 identity_sync 每分钟也会把对照同步进 privacy.json
      try {
        const c = cfg()
        if (!c.memoryToken || !ownerQQ()) return
        const text = op === 'add'
          ? `身份对照：QQ ${person.qq}${person.dy ? ' 就是抖音 ' + person.dy : ''}${person.name ? '（' + person.name + '）' : ''}，同一个人。`
          : `身份对照：QQ ${qq} 从对照表里删掉了。`
        await fetch(String(c.memoryUrl).replace(/\/+$/, '') + '/remember', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.memoryToken },
          body: JSON.stringify({ content: text, text, kind: 'profile', chat_id: 'p:' + ownerQQ(), scope: 'inherit', tags: ['身份'], importance: 0.8, source: 'identity' }),
          signal: AbortSignal.timeout(4000),
        })
        await fetch(String(c.memoryUrl).replace(/\/+$/, '') + '/api/identity/sync', { method: 'POST', headers: { authorization: 'Bearer ' + c.memoryToken }, signal: AbortSignal.timeout(4000) }).catch(() => {})
      } catch {}
    }
    api.command({
      name: '身份',
      aliases: ['identity', 'whois表'],
      desc: '身份对照表：/身份 列表 | /身份 加 QQ=抖音:名字 | /身份 删 QQ',
      run: async (arg) => {
        if (!P) return '插件里没有 features/people.js，改不了'
        const cmd = P.parsePeopleCommand(arg)
        try {
          if (cmd.op === 'list') return listText()
          if (cmd.op === 'add') { editPeople('add', cmd.person); return '加好了：' + P.formatPeople([cmd.person]) + '\n' + listText() }
          if (cmd.op === 'remove') { editPeople('remove', null, cmd.qq); return '删掉了 QQ ' + cmd.qq + '\n' + listText() }
        } catch (e) { return '没改成：' + e.message }
        return '格式：/身份 加 12345=67890:名字（抖音、名字可省）｜/身份 删 12345｜/身份 列表'
      },
    })
    api.tool(({ chat } = {}) => {
      if (!isOwnerPrivate(chat)) return []
      return toolDef({
        name: 'identity_edit',
        description: '（只有主人能让你用）改身份对照表：action=add 加/改一个人（qq 必填，douyin、name 可选）；remove 删；list 看。',
        properties: {
          action: { type: 'string', enum: ['add', 'remove', 'list'] },
          qq: { type: 'string' }, douyin: { type: 'string' }, name: { type: 'string' },
        },
        required: ['action'],
        execute: async ({ action, qq, douyin, name } = {}, exec) => {
          const ch = exec && exec.chat
          if (ch && !isOwnerPrivate(ch)) return { ok: false, message: '只有主人私聊里能改' }
          if (action === 'list') return { ok: true, message: listText() }
          if (action === 'add') { editPeople('add', { qq, dy: douyin, name }); return { ok: true, message: '加好了\n' + listText() } }
          if (action === 'remove') { editPeople('remove', null, qq); return { ok: true, message: '删掉了\n' + listText() } }
          return { ok: false, message: 'action 只能是 add / remove / list' }
        },
      })
    })

    // 写进记忆大脑（只写一次）
    api.later(3000, async () => {
      try {
        const c = cfg()
        if (!c.enabled || !c.seedToMemory) return
        const flag = api.dataDir('seeded.json')
        const done = typeof store.readJson === 'function' ? store.readJson(flag, null) : null
        if (done && done.seeded) return
        const n = names(c)
        const nk = (x) => (x ? x + '，' : '')
        const text =
          '身份对照：主人（我叫' + n.owner + '）QQ ' + (c.ownerQq || '<OWNER_QQ>') + '、抖音 ' + (c.ownerDouyin || '<OWNER_DOUYIN>') + '（' + nk(c.ownerDouyinNick) + '群里显示群友' + String(c.ownerDouyin || '').slice(-4) + '）；' +
          (c.momQq || c.momDouyin ? n.fam + '（我叫' + n.famCall + '）QQ ' + (c.momQq || '?') + '、抖音 ' + (c.momDouyin || '?') + '（' + nk(c.familyDouyinNick) + '群里显示群友' + String(c.momDouyin || '').slice(-4) + '）；' : '') +
          '我自己 QQ ' + (c.selfQq || '<SELF_QQ>') + '、抖音 ' + (c.selfDouyin || '<SELF_DOUYIN>') + (c.selfDouyinNick ? '（' + c.selfDouyinNick + '）' : '') + '。同一个人换平台还是同一个人。'
        const res = await fetch(String(c.memoryUrl).replace(/\/+$/, '') + '/remember', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.memoryToken },
          body: JSON.stringify({
            text,
            kind: 'profile', chat_id: 'p:' + String(cfg().ownerQq || '').replace(/[^0-9]/g, ''), scope: 'inherit', tags: ['身份'],
            importance: 0.95,
            visibility: 'public',
            source: 'identity',
            entities: [['主人', 'person'], [n.fam, 'person'], ['大肥鱼', 'person']],
            relations: [[n.fam, '主人', '家人']],
          }),
          signal: AbortSignal.timeout(8000),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json.status === 'error') throw new Error(json.message || 'HTTP ' + res.status)
        if (typeof store.writeJson === 'function') store.writeJson(flag, { seeded: true, id: json.data?.id ?? json.id ?? null, at: Date.now() })
        api.log.info('身份对照已写进记忆大脑（#' + (json.data?.id ?? json.id ?? '?') + '）')
      } catch (error) {
        api.log.warn('写身份对照进记忆大脑失败：' + String(error?.message || error).slice(0, 120))
      }
    })

    // ---------- 星海「身份对照」唯一编辑器：代理记忆大脑的隐私规则（同源调用，令牌不出插件） ----------
    const brainBase = () => {
      const m = coreCfg().ext?.memcore || {}
      return String(m.v2Url || m.url || cfg().memoryUrl || 'http://127.0.0.1:8780').replace(/\/+$/, '')
    }
    const brainToken = () => String(coreCfg().ext?.memcore?.token || cfg().memoryToken || '')
    const brain = async (path, opt = {}) => {
      const r = await fetch(brainBase() + path, {
        ...opt,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + brainToken() },
        signal: AbortSignal.timeout(6000),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error((j && (j.message || j.error)) || 'HTTP ' + r.status)
      return j
    }
    const body = (req) => api.core.http.body(req)
    api.route('/privacy', async () => {
      try {
        const [pv, idn] = await Promise.all([brain('/api/privacy'), brain('/api/identity').catch(() => ({}))])
        return { ok: true, privacy: pv.privacy || {}, known_chats: pv.known_chats || [], person_map: (idn && idn.person_map) || {}, isolatePeople: String(coreCfg().ext?.memcore?.isolatePeople || '') }
      } catch (e) { return { ok: false, message: '连不上记忆星海：' + String(e.message || e) } }
    })
    api.route('/privacy/save', async (req) => {
      try {
        const b = await body(req)
        if (!b || typeof b.privacy !== 'object') return { ok: false, message: '缺少 privacy' }
        await brain('/api/privacy', { method: 'PUT', body: JSON.stringify({ privacy: b.privacy }) })
        if (typeof b.isolatePeople === 'string') {
          const iso = b.isolatePeople.split(/[,，;；\n]+/).map((x) => x.trim()).filter(Boolean).join(',')
          api.setConfig((cc) => ({ ...cc, ext: { ...cc.ext, memcore: { ...(cc.ext?.memcore || {}), isolatePeople: iso } } }))
        }
        await brain('/api/identity/sync', { method: 'POST', body: '{}' }).catch(() => {})
        return { ok: true, message: '隐私规则已保存（星海热加载生效）' }
      } catch (e) { return { ok: false, message: '保存失败：' + String(e.message || e) } }
    })
    api.route('/privacy/check', async (req) => {
      try {
        const b = await body(req)
        return { ok: true, ...(await brain('/api/privacy/check', { method: 'POST', body: JSON.stringify({ chat: String(b.chat || ''), text: String(b.text || '') }) })) }
      } catch (e) { return { ok: false, message: '检查失败：' + String(e.message || e) } }
    })

    api.log.info('身份对照已加载（号码不写日志）')
    return { block, aliasOf, people, isOwnerPrivate }
  },
}
