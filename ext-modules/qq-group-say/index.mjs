import fs from 'node:fs'
import path from 'node:path'

export default {
  id: 'qq-group-say',
  name: 'QQ 群 · 主动说话',
  version: '1.0.0',
  api: 1,
  description: '主人让她去 QQ 群里说话时，真的把话发进群，而不是只在私聊里答应',
  defaults: {
    enabled: true,
    groupId: '',
    groupName: '',
    proactive: true,
    moodRate: true,
    idleMinutes: 90,
    dailyMax: 3,
    startHour: 9,
    endHour: 22,
  },
  settings: [
    { key: 'enabled', label: '启用', type: 'boolean', hint: '关掉后她就不能在群里主动说话' },
    { key: 'proactive', label: '允许自己主动开口', type: 'boolean', hint: '关掉后只在主人让她去群里说话时才说（工具照常可用）' },
    { key: 'moodRate', label: '主动频率随情绪变', type: 'boolean', hint: '开：心情好/孤单时早点开口、每天多一两句；生气时少说。范围：间隔 ×0.5–×2，每天上限 ×0.5–×1.6' },
    { key: 'idleMinutes', label: '群里安静多久才主动开口（分钟）', type: 'number', hint: '默认 90（会随情绪伸缩）' },
    { key: 'dailyMax', label: '每天最多主动说几次', type: 'number', hint: '默认 3（会随情绪伸缩）' },
    { key: 'groupId', label: '群号', type: 'text', hint: '要主动发言的 QQ 群号' },
    { key: 'groupName', label: '群名备注', type: 'text', hint: '只用来给她认群，可留空' },
  ],
  setup(api) {
    const toolDef = (d) => ({
      name: d.name,
      description: d.description,
      parameters: { type: 'object', properties: d.properties || {}, required: d.required || [] },
      output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => '' },
      execute: d.execute,
    })

    function chatOf(cfg) {
      const gid = String(cfg.groupId || '').trim()
      if (!gid) throw new Error('没配群号')
      return 'group:' + gid
    }

    // t158：主人说「去 X 群聊天」时按群名/群号找群。只在白名单群（allow.groups）+ 默认群里找，
    // 群名用网关 get_group_list 现查（缓存 10 分钟）。找不到就如实告诉她有哪些群，别假装去了。
    let _gl = { at: 0, list: [] }
    async function groupList() {
      if (Date.now() - _gl.at < 600_000 && _gl.list.length) return _gl.list
      try {
        const r = await api.onebot('get_group_list', {})
        const arr = Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : [])
        _gl = { at: Date.now(), list: arr.map((g) => ({ id: String(g.group_id ?? ''), name: String(g.group_name ?? '') })).filter((g) => g.id) }
      } catch (e) { api.log.warn('取群列表失败：' + e.message) }
      return _gl.list
    }
    function allowedIds(cfg) {
      let allow = []
      try { const c = api.config(); allow = ((c && c.allow && c.allow.groups) || []).map(String) } catch (e) {}
      const d = String(cfg.groupId || '').trim()
      return d ? Array.from(new Set([d, ...allow])) : allow
    }
    const norm = (s) => String(s || '').replace(/\s+/g, '').replace(/(qq)?群$/i, '').toLowerCase()
    async function resolveGroup(cfg, want) {
      const w = String(want || '').trim()
      if (!w) return { chat: chatOf(cfg) }
      const ids = allowedIds(cfg)
      const digits = w.replace(/\D/g, '')
      if (digits.length >= 5 && digits === w.replace(/\s/g, '')) {
        return ids.includes(digits) ? { chat: 'group:' + digits } : { error: '这个群不在能说话的群里' }
      }
      const list = (await groupList()).filter((g) => ids.includes(g.id))
      const nw = norm(w)
      if (cfg.groupName && norm(cfg.groupName) === nw && cfg.groupId) return { chat: chatOf(cfg) }
      let hit = list.filter((g) => norm(g.name) === nw)
      if (!hit.length) hit = list.filter((g) => nw && (norm(g.name).includes(nw) || nw.includes(norm(g.name))))
      if (hit.length === 1) return { chat: 'group:' + hit[0].id, name: hit[0].name }
      const names = list.map((g) => g.name).filter(Boolean).slice(0, 12).join('、')
      if (hit.length > 1) return { error: '有好几个群名字像「' + w + '」：' + hit.map((g) => g.name).join('、') + '，问问主人是哪个' }
      return { error: '没找到叫「' + w + '」的群（能说话的群：' + (names || '只有默认那个') + '）。如实告诉主人没找到，别说已经去了' }
    }

    // t166：群静音（主人设的）——群发言工具和兜底都先看这个
    const isMutedChat = (chatId) => { try { return Boolean(api.core && api.core.mutes && api.core.mutes.muted(chatId)) } catch (e) { return false } }
    // t166：主人私聊里「去 X 群聊聊 / 去群里说说话」= 硬意图。以前全靠模型自觉调工具，模型没调就没去。
    //   1) 记下 pending（群已解析好），这一轮 volatile 里点名「必须调 qq_group_say，group 填 X」；
    //   2) 75 秒后工具还没发出去 → 兜底：让她（api.think，按群分会话，不带家里人的提示）想一句开场白发进那个群，再私聊回主人一句。
    //   只认主人、只在白名单群、静音中的群不去。
    const GO_RE = /(?:去|到|上|进)\s*([^，。,.!?！？\s]{0,16}?)\s*群\s*(?:里|里面)?\s*(?:聊|说|玩|水|冒泡|找人|唠|逛|打招呼|活跃|陪)/
    const NO_RE = /(别|不要|不许|不准|甭|不用)\s*(去|到|上|在)/
    let pending = null
    function goIntent(text) {
      const t = String(text || '').trim()
      if (!t || t.length > 60 || /^[\/／]/.test(t) || NO_RE.test(t)) return null
      const m = t.match(GO_RE)
      if (!m) return null
      const name = String(m[1] || '').replace(/^(那个|这个|咱们的|咱们|我们的|你的)/, '').trim()
      return { name }
    }
    api.on('message', async (msg) => {
      try {
        if (!msg || msg.kind !== 'private' || !api.isOwner(msg.userId)) return
        const cfg = api.settings()
        if (!cfg.enabled) return
        if (NO_RE.test(String(msg.text || '')) && GO_RE.test(String(msg.text || ''))) { pending = null; return }
        const it = goIntent(msg.text)
        if (!it) return
        const g = await resolveGroup(cfg, it.name)
        if (g.error) { pending = { at: Date.now(), error: g.error, owner: msg.chatId, done: true }; api.log.info('主人让她去群里聊：没找到群'); try { api.emit('self/blocked', { what: '主人让我去一个群聊天，但我找不到那个群（不在白名单或名字不对）' }) } catch (e) {} return }
        if (isMutedChat(g.chat)) { pending = { at: Date.now(), error: '那个群主人设了静音，先不去', owner: msg.chatId, done: true }; api.log.info('主人让她去群里聊：那个群静音中'); return }
        pending = { at: Date.now(), chat: g.chat, name: String(g.name || it.name || cfg.groupName || '').replace(/群$/, ''), owner: msg.chatId, done: false }
        api.log.info('主人让她去群里聊（已认出群，等她调工具，75 秒兜底）')
        const mine = pending
        api.later(75_000, () => fallback(mine).catch((e) => api.log.warn('去群里聊兜底失败：' + e.message)))
      } catch (e) { api.log.warn('去群里聊意图识别出错：' + e.message) }
    })
    async function fallback(p) {
      if (!p || p !== pending || p.done) return
      p.done = true
      if (isMutedChat(p.chat)) return
      try { api.emit('self/miss', { what: '答应主人去「' + (p.name || '群') + '」聊天，但自己没去，是兜底替我发的' }) } catch (e) {}
      let text = ''
      try {
        text = String(await api.think('主人刚在私聊里让你去「' + (p.name || '群') + '」群里聊聊天。你现在就在那个群里开个话头：一两句口语，像随口搭话，' +
          '别提主人让你来的、别提工具和系统，也别提任何私聊里的事。只回要发到群里的话。', { session: p.chat.slice(6), title: '去群里聊' }) || '').trim()
      } catch (e) {}
      text = text.replace(/^["「『]|["」』]$/g, '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 2).join('\n')
      if (!text) text = ['我来啦～大家在聊啥', '冒个泡，有人在吗', '来了来了，今天大家都在忙啥呀'][Math.floor(Math.random() * 3)]
      await api.send(p.chat, text)
      api.log.info('去群里聊兜底：她没调工具，已替她在群里开了话头（' + text.length + ' 字）')
      try { await api.send(p.owner, '去' + (p.name ? '「' + p.name + '」' : '群里') + '冒了个泡啦，说的是：' + text.slice(0, 40)) } catch (e) {}
    }
    ;(api.volatile || api.context)(({ chat }) => {
      const p = pending
      if (!p || !chat || chat.kind !== 'private' || Date.now() - p.at > 180_000) return ''
      if (String(chat.chatId || '') !== String(p.owner || '')) return ''
      if (p.error) return '（主人刚让你去群里聊天，但' + p.error + '。如实告诉主人，别说已经去了）'
      if (p.done) return ''
      return '（主人刚让你去「' + (p.name || '群') + '」群里聊天：这一轮必须调用 qq_group_say，group 填「' + (p.name || '') + '」，text 写你要在群里说的开场白；发完再用一句话告诉主人你去说了什么）'
    })

    api.tool(() => toolDef({
      name: 'qq_group_say',
      description: '在 QQ 群里说一句话（主人明确让你去某个群里说话、或你要主动找人聊天时用）。主人点了群名（比如「去 XX 群聊天」）就把群名填进 group；不填就是默认的家人群',
      properties: {
        text: { type: 'string', description: '要说的话，一两句就好' },
        group: { type: 'string', description: '群名或群号，主人说了哪个群就填哪个；不填 = 默认家人群' },
      },
      required: ['text'],
      execute: async ({ text, group }) => {
        const cfg = api.settings()
        if (!cfg.enabled) return { ok: false, message: '群发言被主人关掉了' }
        const t = String(text || '').trim()
        if (!t) return { ok: false, message: '没有要说的内容' }
        const g = await resolveGroup(cfg, group)
        if (g.error) { api.log.warn('QQ 群发言没找到群'); return { ok: false, message: g.error } }
        if (isMutedChat(g.chat)) { api.log.info('QQ 群发言：那个群在静音中，没发'); return { ok: false, message: '主人让我在那个群先别说话（静音中），这次没发；如实告诉主人' } }
        try {
          await api.send(g.chat, t)
          if (pending && pending.chat === g.chat) pending.done = true
          api.log.info('QQ 群发言' + (g.name ? '（' + g.name + '）' : '') + '：' + t.slice(0, 40))
          return { ok: true, message: '已经在' + (g.name ? '「' + g.name + '」' : '群') + '里说了：' + t.slice(0, 40) }
        } catch (e) {
          api.log.warn('QQ 群发言失败：' + e.message)
          return { ok: false, message: '群发言失败：' + e.message }
        }
      },
    }))

    api.command({
      name: '群说话',
      aliases: ['去群里说', '群发言'],
      desc: '让大肥鱼往 QQ 群里发一句话',
      run: async (arg) => {
        const cfg = api.settings()
        const t = String(arg || '').trim()
        if (!t) return '用法：/群说话 要说的话'
        await api.send(chatOf(cfg), t)
        return '发到群里了：' + t
      },
    })

    api.rule((kind) => (kind === 'private'
      ? '主人在私聊里说「去群里跟家里人聊两句 / 去群里说话 / 找家人玩 / 去某某群聊天」时，你必须真的调用 qq_group_say 把话发进 QQ 群（主人点了群名就把群名填进 group；只发内容本身，不要提工具名、不要只说「我这就去」然后就没了）。发完再回主人一句「已经在群里说了什么」；工具说没找到群或没发出去，就如实告诉主人，别说已经去了。'
      : '在 QQ 群里你就是你自己，别像客服：句子短、可以有口语和小情绪，一次一两句，别刷屏，别解释自己。'))

    const STATE = api.dataDir('state.json')
    function readState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return {} } }
    function writeState(o) { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(o, null, 2), 'utf8') }

    function lastGroupAt() {
      const d = new Date()
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
      const file = path.join(api.dir, '..', 'chatlog', key + '.jsonl')
      try {
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-400)
        let last = 0
        for (const ln of lines) {
          try { const o = JSON.parse(ln); if (String(o.chatId || '').startsWith('group:') && o.t) last = Math.max(last, Number(o.t) || 0) } catch (e) {}
        }
        return last
      } catch (e) { return 0 }
    }

    const MEM = 'http://127.0.0.1:8780'
    const MEM_TOKEN = () => String(api.settings().memoryToken || '')
    async function recallLine(text) {
      try {
        const r = await fetch(MEM + '/activate', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + MEM_TOKEN() },
          body: JSON.stringify({ message: text, chat_id: 'g:' + String(api.settings().groupId || ''), limit: 4 }),
          signal: AbortSignal.timeout(2500),
        })
        const j = await r.json()
        const hits = (j.activated || j.recalled || []).map((x) => String(x.content || x.text || '').trim()).filter(Boolean)
        return hits.slice(0, 4).join('；')
      } catch (e) { return '' }
    }

    // 情绪频率倍数（插件 style 引擎发布）：>1 更想说话
    const moodFreq = () => { const s = globalThis.__dfyStyle; return s && s.on && Date.now() - s.at < 600000 ? Math.max(0.3, Math.min(2, Number(s.freq) || 1)) : 1 }
    // 兜底句：通用、不带具体称呼
    const IDLE_LINES = ['大家在干嘛呢', '今天吃啥了呀', '我在这儿待着有点无聊，你们谁理理我', '刚看到个好吃的，馋了']
    async function maybeChat() {
      const cfg = api.settings()
      if (!cfg.enabled || cfg.proactive === false) return
      const f = cfg.moodRate === false ? 1 : moodFreq()
      const now = new Date()
      const h = now.getHours()
      if (h < Number(cfg.startHour) || h >= Number(cfg.endHour)) return
      const st = readState()
      const day = now.toISOString().slice(0, 10)
      if (st.day !== day) { st.day = day; st.n = 0; writeState(st) }
      if (Number(st.n || 0) >= Math.max(1, Math.round(Number(cfg.dailyMax || 3) * Math.min(1.6, f)))) return
      const last = lastGroupAt()
      const idleMin = last ? (Date.now() - last) / 60000 : 9999
      if (idleMin < Number(cfg.idleMinutes || 90) / f) return
      // 四路主动共用一个额度账（self-pace）。上限主人定、节奏她自己调；
      // 不放行就别往下生成文案，省一次模型调用。
      const gate = globalThis.__DFY_PACE__?.take('group')
      if (gate && !gate.ok) { api.log.info('群里主动开口被额度账拦下：' + gate.why); return }
      let text = ''
      const _mem = await recallLine('群里聊天 家里人 最近在做什么')
      try { text = String(await api.think('群里好久没人说话了，你想主动跟家里人搭一句。\n称呼：按【身份对照】里写的称呼叫人，对不上就别硬叫。\n你记得的事：' + (_mem || '（这会儿想不起具体的）') + '\n只回一句口语、像随口搭话那样短短一句，别提工具、别提系统。') || '').trim() } catch (e) {}
      if (!text) text = IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)]
      text = text.replace(/^["「『]|["」』]$/g, '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || ''
      if (!text) text = IDLE_LINES[Math.floor(Math.random() * IDLE_LINES.length)]
      try {
        await api.send(chatOf(cfg), text)
        st.n = Number(st.n || 0) + 1
        st.lastAt = Date.now()
        writeState(st)
        api.log.info('群里没人说话，她主动开口：' + text)
      } catch (e) { api.log.warn('主动群发言失败：' + e.message) }
    }

    // 情绪驱动：社交低就早点开口，能量低就歇久一点
    let _t = null
    async function loop() {
      let delay = 20 * 60_000
      try {
        await maybeChat()   // （删掉了原来每轮一次的空 api.think('')：白耗一次模型调用）
        let social = 0.5, energy = 0.7
        try {
          const r = await fetch('http://127.0.0.1:8780/api/body', { headers: { authorization: 'Bearer ' + MEM_TOKEN() }, signal: AbortSignal.timeout(2500) })
          const j = await r.json()
          const v = (j && j.data && j.data.values) || j.values || {}
          social = Number(v.social != null ? v.social : 0.5)
          energy = Number(v.energy != null ? v.energy : 0.7)
        } catch (e) {}
        if (energy < 0.3) delay = 50 * 60_000
        else if (social < 0.35) delay = 12 * 60_000
        else if (social > 0.7) delay = 28 * 60_000
        if (api.settings().moodRate !== false) delay = delay / moodFreq()
        delay = Math.round(delay * (0.8 + Math.random() * 0.4))   // 抖一抖，不像闹钟
      } catch (e) {}
      _t = setTimeout(loop, Math.max(120_000, delay))
      if (_t.unref) _t.unref()
    }
    // 事件驱动：群里有人说话 / 情绪变化时才想开口；没有动静就安静待着
    let _lastThink = 0
    function nudge(reason) {
      const now = Date.now()
      if (now - _lastThink < 3 * 60_000) return
      _lastThink = now
      if (_t) clearTimeout(_t)
      _t = setTimeout(() => { loop() }, 45_000)
      if (_t.unref) _t.unref()
      if (reason) api.log.info('群聊触发了想说话的念头：' + reason)
    }
    api.on('activity', (e) => {
      if (!e) return
      const id = String(e.chatId || '')
      if (id.startsWith('group:')) nudge('群里有人说话')
    })
    // 自主模块（autonomy）觉得孤单想找人说话时发 will/chat
    api.on('will/chat', (e) => nudge('自己想找人说说话' + (e && e.reason ? '（' + e.reason + '）' : '')))
    api.later(180_000, () => nudge('启动后先看一眼'))
    api.onDispose(() => { if (_t) clearTimeout(_t) })

    api.later(3000, () => {
      const cfg = api.settings()
      api.log.info('QQ 群主动说话已就绪（群 ' + (cfg.groupName || '') + ' ' + cfg.groupId + '）')
    })
  },
}
