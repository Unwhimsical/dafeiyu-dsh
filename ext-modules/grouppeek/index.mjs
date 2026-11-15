// 群里在聊什么（grouppeek）
// 让大肥鱼在「主人私聊」里也能知道群聊最近说了啥：读插件自己的聊天流水（hub.chatLogOf），
// 不依赖群里 @她，也不往记忆里写东西。
//
// 提供：
//   · 工具 group_recent —— 她想知道「群里刚才在聊什么」时自己调
//   · 规则 —— 主人私聊里提到群/他们/大家时，先看一眼再说，别硬说「我看不见群消息」
//   · 命令 /群消息    —— 主人直接要一份流水
//   · 顺手把内置的「主人私聊里补群聊流水」（group.ownerBrief）打开

const HHMM = (t) => {
  const d = new Date(Number(t) || Date.now())
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

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
  id: 'grouppeek',
  name: '群里在聊什么',
  version: '1.0.0',
  api: 1,
  tab: 'chat',
  description:
    '主人私聊里也能看见群聊最近说了什么：工具 group_recent、命令 /群消息，并自动打开「主人私聊补群聊流水」。',
  defaults: { lines: 15, hours: 24, showPrivate: false },
  settings: [
    { key: 'lines', label: '每个群默认看几条', type: 'number', hint: '默认 15，最多 40。她调用工具时也能自己指定。' },
    { key: 'hours', label: '往前找几小时', type: 'number', hint: '默认 24 小时。再久就得靠记忆了。' },
  ],

  setup(api) {
    const log = api.log

    // ---- 读流水 ----
    function collect({ group = '', lines = 0 } = {}) {
      const st = api.settings()
      const want = Math.max(1, Math.min(40, Number(lines) || Number(st.lines) || 15))
      const hours = Math.max(1, Math.min(120, Number(st.hours) || 24))
      const hub = api.core.hub
      const now = Date.now()
      const cutoff = now - hours * 3600_000
      const days = [dayKey(), dayKey(new Date(cutoff))]
      const rows = []
      for (const d of [...new Set(days)]) {
        let list = []
        try {
          list = hub.chatLogOf(d) || []
        } catch (error) {
          log.warn('读不到聊天流水 ' + d + '：' + error.message)
          continue
        }
        for (const l of list) {
          if (!l || !String(l.chatId || '').startsWith('group:')) continue
          const t = Number(l.t) || 0
          if (t && t < cutoff) continue
          if (!String(l.text || '').trim()) continue
          rows.push(l)
        }
      }
      rows.sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0))

      const by = new Map()
      for (const l of rows) {
        const gid = String(l.chatId).slice(6)
        if (!by.has(gid)) by.set(gid, [])
        by.get(gid).push(l)
      }

      // 按群名/群号筛
      const q = String(group || '').trim().toLowerCase()
      const picked = []
      for (const [gid, list] of by) {
        let name = ''
        try {
          name = hub.groupName(gid) || ''
        } catch (error) {}
        if (q && !gid.includes(q) && !String(name).toLowerCase().includes(q)) continue
        picked.push({ gid, name, list: list.slice(-want) })
      }
      picked.sort((a, b) => (Number(b.list.at(-1)?.t) || 0) - (Number(a.list.at(-1)?.t) || 0))
      return { picked, total: rows.length, want, hours }
    }

    function render({ picked, hours }, { withHint = true } = {}) {
      if (!picked.length) {
        return `最近 ${hours} 小时群里没有人说话（我这边一条流水都没有）。`
      }
      const out = []
      for (const g of picked) {
        const title = g.name && g.name !== g.gid ? `群「${g.name}」（${g.gid}）` : `群 ${g.gid}`
        out.push(`${title}，最后 ${g.list.length} 条：`)
        for (const l of g.list) {
          const who = l.who === 'bot' ? '你自己' : l.who || l.uid || '有人'
          out.push(`${HHMM(l.t)} ${who}：${String(l.text).replace(/\s+/g, ' ').slice(0, 200)}`)
        }
      }
      let text = out.join('\n')
      if (text.length > 2400) text = text.slice(0, 2400) + '\n…（后面还有，看全了就再问一次、把条数说小点）'
      if (withHint) text += '\n\n（这是群聊流水，是你自己看见的。别把它们当成自己的话说出去；主人问起再聊。）'
      return text
    }

    const peek = (opts) => {
      try {
        return render(collect(opts))
      } catch (error) {
        log.error('群流水读失败：' + error.message)
        return '群流水读失败了：' + error.message
      }
    }

    // ---- 工具 ----
    // 只在「主人私聊」挂这个工具：群流水绝不能被带进陌生人会话。
    // 修：原来这里是裸 toolDef({...})，返回值被丢掉，工具从未注册，
    // 但规则里却告诉她「你手上有个 group_recent」——规则在、工具不在。
    api.tool(({ chat } = {}) => {
      if (!chat || chat.kind !== 'private') return []
      const cfg = api.core.getConfig() || {}
      const ownerQQ = String(cfg.ownerQQ || '')
      const uid = String(chat.userId || String(chat.chatId || '').replace(/^private:/, '') || '')
      if (!ownerQQ || uid !== ownerQQ) return []
      return [toolDef({
        name: 'group_recent',
        description:
          '看一眼群里最近在聊什么（读本地聊天流水）。主人问「群里刚才说什么了」「他们在聊啥」「家里人说什么了」这类问题时先调这个，别直接说看不见。group 留空 = 所有群；也可以填群名或群号的一部分。',
        properties: {
          group: { type: 'string', description: '群名或群号的一部分，留空看所有群' },
          lines: { type: 'number', description: '每个群看几条，默认按设置（15），最多 40' },
        },
        required: [],
        execute: async (args = {}) => ({ ok: true, message: peek({ group: args.group, lines: args.lines }) }),
      })]
    })

    // ---- 规则：只在主人私聊里说 ----
    api.rule((kind) => {
      if (kind !== 'private') return ''
      return [
        '你手上有个工具 group_recent，能看见群里最近在聊什么（每个群最近 15 条左右）。',
        '主人在私聊里提起群、他们、大家、或者某个群里的人说了什么，你先调 group_recent 看一眼再回答，',
        '不要说「我看不到群消息」——你看得到，只是要自己去看。看完用你自己的口气说，别把流水原样念出来。',
      ].join('')
    })

    // ---- 命令 ----
    api.command({
      name: '群消息',
      aliases: ['群聊', '群里', '群流水'],
      desc: '看群里最近在聊什么：/群消息 [群名片段]',
      run: async (arg) => peek({ group: arg }),
    })

    // ---- 顺手打开内置的「主人私聊补群聊流水」 ----
    try {
      const cfg = api.core.getConfig()
      const ob = (cfg.group && cfg.group.ownerBrief) || {}
      if (ob.enabled !== true) {
        api.core.setConfig({
          ...cfg,
          group: { ...(cfg.group || {}), ownerBrief: { ...ob, enabled: true, lines: Number(ob.lines) || 15, groups: ob.groups || [] } },
        })
        log.info('已打开「主人私聊里补群聊流水」（group.ownerBrief.enabled = true）')
      }
    } catch (error) {
      log.warn('打开 ownerBrief 失败：' + error.message)
    }
  },
}
