// @/通知唯一推荐路径（via douyin-mcp :18080）。已把 douyin-mentions（CDP 读「@我的」页）合并进来，那个模块停用。
// @我 / 通知 轮询：把抖音接口服务（douyin-mcp :18080）的通知接进她的日常
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const MCP = 'http://127.0.0.1:18080/mcp'

async function rpc(name, args = {}, ms = 15000) {
  const r = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(ms),
  })
  const j = await r.json()
  const text = j?.result?.content?.[0]?.text
  if (text === undefined) throw new Error('调用失败：' + JSON.stringify(j).slice(0, 160))
  try { return JSON.parse(text) } catch { return text }
}


// ---- 合并：原「抖音@我的」（douyin-mentions，CDP 读 douyin.com/notification 的「@我的」栏）并进来 ----
// 只按需读（工具调用时），不轮询；轮询 / 提醒只有上面 douyin-mcp 这一路，所以不会重复提醒。只读登录态、不动登录。
const NOTI_URL = 'https://www.douyin.com/notification'

const DEFAULTS = {
  enabled: false, // deprecated: prefer mention-watch
  limit: 10,
}

const LOGIN_JS = `(async () => {
  try {
    const r = await fetch('/aweme/v1/web/user/profile/self/?device_platform=webapp&aid=6383', { credentials: 'include' })
    const j = await r.json()
    return { ok: Number(j.status_code) === 0, msg: j.status_msg || '' }
  } catch (e) { return { ok: false, msg: String(e) } }
})()`

// 顶部那些 tab（互动消息 / 评论 / @我的 …）
const TABS_JS = `(() => {
  const out = []
  for (const el of document.querySelectorAll('div,span,a,li')) {
    const t = (el.innerText || '').trim()
    if (!t || t.length > 10) continue
    const r = el.getBoundingClientRect()
    if (r.y > 220 || r.width < 20 || r.height < 14 || r.height > 60) continue
    out.push({ text: t, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
  }
  return out.slice(0, 20)
})()`

const CLICK_TAB_JS = `(() => {
  const want = /@\\s*我的|提到我|艾特我|有人@我/
  for (const el of document.querySelectorAll('div,span,a,li')) {
    const t = (el.innerText || '').trim()
    if (!want.test(t) || t.length > 12) continue
    const r = el.getBoundingClientRect()
    if (r.width < 20 || r.height < 14) continue
    el.click()
    return { ok: true, text: t }
  }
  return { ok: false }
})()`

// 读通知列表：每条通常是「头像 + 昵称 + 动作 + 时间」
const LIST_JS = `(() => {
  const box = (() => {
    let best = null
    for (const el of document.querySelectorAll('div')) {
      const r = el.getBoundingClientRect()
      if (r.width < 400 || r.height < 300) continue
      const kids = [...el.children].filter((k) => { const b = k.getBoundingClientRect(); return b.height >= 50 && b.height <= 140 && b.width > 300 })
      if (kids.length < 2) continue
      if (!best || kids.length > best.kids.length) best = { el, kids }
    }
    return best
  })()
  if (!box) return { items: [], tabs: [] }
  const items = box.kids.map((k, i) => {
    const b = k.getBoundingClientRect()
    const lines = (k.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean)
    return { i, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), lines }
  })
  return { items }
})()`

const CLICK_ITEM_JS = (i) => `(() => {
  let best = null
  for (const el of document.querySelectorAll('div')) {
    const r = el.getBoundingClientRect()
    if (r.width < 400 || r.height < 300) continue
    const kids = [...el.children].filter((k) => { const b = k.getBoundingClientRect(); return b.height >= 50 && b.height <= 140 && b.width > 300 })
    if (kids.length < 2) continue
    if (!best || kids.length > best.kids.length) best = { el, kids }
  }
  if (!best) return { ok: false }
  const k = best.kids[${i}]
  if (!k) return { ok: false }
  k.click()
  return { ok: true }
})()`

const TITLE_JS = `(() => {
  const t = document.title || ''
  const h = [...document.querySelectorAll('h1')].map((e) => (e.innerText || '').trim()).filter(Boolean)[0] || ''
  return { url: location.href, title: h || t }
})()`

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ws.addEventListener('message', (ev) => {
      let j
      try { j = JSON.parse(ev.data) } catch { return }
      if (!j.id || !this.pending.has(j.id)) return
      const p = this.pending.get(j.id)
      this.pending.delete(j.id)
      if (j.error) p.reject(new Error(j.error.message)); else p.resolve(j.result)
    })
  }
  open() {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('连浏览器超时')), 8000)
      this.ws.addEventListener('open', () => { clearTimeout(t); resolve() })
      this.ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('连浏览器失败')) })
    })
  }
  send(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (!this.pending.has(id)) return
        this.pending.delete(id)
        reject(new Error('浏览器没响应：' + method))
      }, timeoutMs)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面脚本出错')
    return r.result?.value
  }
  close() { try { this.ws.close() } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function mtToolDef({ name, description, properties = {}, required = [], execute }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_a, v) => [{ type: 'text', text: v && v.ok === false ? '✗ ' + (v.message || '没成功') : (v && v.message) || '✓' }],
    },
    async execute(args, exec) {
      try { return JSON.parse(JSON.stringify((await execute(args || {}, exec)) ?? { ok: true })) }
      catch (e) { return { ok: false, message: String((e && e.message) || e) } }
    },
  }
}

export default {
  id: 'mention-watch',
  name: '抖音通知 · @我',
  version: '1.0.0',
  api: 1,
  description: '抖音 @我 / 通知（合并）：定时看通知（douyin-mcp）有新的告诉主人；按需点开通知页「@我的」读条目、点开视频（原「抖音@我的」并进来）',
  defaults: { enabled: true, everyMinutes: 10, quietHours: [1, 8], ownerChat: '', moodRate: true, memoryToken: '' },
  settings: [
    { key: 'enabled', label: '启用通知轮询', type: 'boolean' },
    { key: 'everyMinutes', label: '多久看一次（分钟）', type: 'number', min: 3, max: 120 },
    { key: 'moodRate', label: '间隔随情绪变', type: 'boolean', hint: '开：心情好/孤单时看得勤一点（间隔 ×0.5–×2），±20% 抖动' },
    { key: 'mentionLimit', label: '「@我的」每次读几条', type: 'number', min: 1, max: 30, hint: '默认 10（douyin_mentions 工具用）' },
  ],
  setup(api) {
    const cfg = () => ({ ...api.settings() })
    const STATE = api.dataDir('state.json')
    const read = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return { seen: {}, last: null } } }
    const write = (s) => { try { const t = STATE + '.tmp'; fs.writeFileSync(t, JSON.stringify(s)); fs.renameSync(t, STATE) } catch {} }
    const inQuiet = () => {
      const q = cfg().quietHours || [1, 8]
      const h = new Date().getHours()
      return q[0] <= q[1] ? (h >= q[0] && h < q[1]) : (h >= q[0] || h < q[1])
    }


    async function rememberNotice(line){
      try{
        await fetch('http://127.0.0.1:8780/remember',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+String(cfg().memoryToken||'')},body:JSON.stringify({content:line,chat_id:'system',kind:'event',importance:0.45,scope:'public',tags:['douyin','notice']}),signal:AbortSignal.timeout(4000)})
      }catch{}
    }

    async function atVideoUrl(){
      try{
        const g = await rpc('get_notices',{ notice_group:'601', count:'5' })
        const s = typeof g==='string'?g:JSON.stringify(g)
        const m = s.match(/"(?:aweme_id|item_id|video_id)"\s*:\s*"?(\d{15,})"?/)
        const d = s.match(/"desc"\s*:\s*"([^"]{2,60})"/)
        if(m) return { id:m[1], url:'https://www.douyin.com/video/'+m[1], desc:(d?d[1]:'') }
      }catch{}
      return null
    }

    function day(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0') }
    // 把一条通知（嵌套 JSON）拍平成：哪个视频、哪条评论（cid / 父评论）、谁、说了啥
    // 以前只用正则抓第一个 desc/nickname，所有条目共用同一段文字，还丢了 cid → 只能发一级评论，回不到那条评论下
    function flatNotice(n, group){
      const out={ group, aweme_id:'', cid:'', parent_cid:'', text:'', nick:'', desc:'' }
      const seen=new Set()
      const walk=(o,depth)=>{
        if(!o||typeof o!=='object'||depth>7||seen.has(o)) return
        seen.add(o)
        if(Array.isArray(o)){ for(const x of o.slice(0,20)) walk(x,depth+1); return }
        for(const [k,v] of Object.entries(o)){
          if((k==='aweme_id'||k==='item_id'||k==='group_id')&&!out.aweme_id&&/^\d{15,}$/.test(String(v))) out.aweme_id=String(v)
          else if(k==='cid'&&!out.cid&&/^\d{10,}$/.test(String(v))) out.cid=String(v)
          else if((k==='reply_id'||k==='reply_to_reply_id'||k==='parent_cid')&&!out.parent_cid&&/^\d{10,}$/.test(String(v))&&String(v)!=='0') out.parent_cid=String(v)
          else if((k==='text'||k==='content')&&!out.text&&typeof v==='string'&&v.trim()) out.text=v.trim().slice(0,200)
          else if(k==='nickname'&&!out.nick&&typeof v==='string') out.nick=v.slice(0,30)
          else if(k==='desc'&&!out.desc&&typeof v==='string') out.desc=v.slice(0,80)
          else if(v&&typeof v==='object') walk(v,depth+1)
        }
      }
      walk(n,0)
      if(out.parent_cid===out.cid) out.parent_cid=''
      return out
    }
    function noticeList(r){
      const j = typeof r==='string' ? (()=>{ try{ return JSON.parse(r) }catch{ return null } })() : r
      if(!j||typeof j!=='object') return []
      const cands=[j.notice_list_v2,j.notice_list,j.data&&j.data.notice_list_v2,j.data&&j.data.notice_list,Array.isArray(j.data)?j.data:null,Array.isArray(j)?j:null]
      return cands.find((x)=>Array.isArray(x)&&x.length) || []
    }
    async function fetchAts(){
      const out=[]
      for (const g of ['601','2']){
        try{
          const r = await rpc('get_notices',{ notice_group:g, count:'8' })
          let items=noticeList(r).map((n)=>flatNotice(n,g)).filter((x)=>x.aweme_id)
          if(!items.length){
            // 兜底：老的正则路径（结构变了也至少拿到视频 id）
            const t = typeof r==='string'?r:JSON.stringify(r)
            items=[...new Set([...t.matchAll(/"(?:aweme_id|item_id|video_id)"\s*:\s*"?(\d{15,})"?/g)].map(m=>m[1]))].map((id)=>({ group:g, aweme_id:id, cid:'', parent_cid:'', text:'', nick:'', desc:'' }))
          }
          for (const x of items.slice(0,5)) out.push({ ...x, id:x.aweme_id, url:'https://www.douyin.com/video/'+x.aweme_id })
        }catch{}
      }
      const st=read()
      st.ats = out
      write(st)
      return out
    }
    function repliedToday(){
      const st=read(); const d=day()
      if(st.repDay!==d){ st.repDay=d; st.repCount=0; write(st) }
      return Number(st.repCount)||0
    }
    function bumpReplied(){
      const st=read(); st.repDay=day(); st.repCount=(Number(st.repCount)||0)+1; write(st); return st.repCount
    }

    const EDGE_PROFILE = process.env.DOUYIN_PROFILE_DIR || 'douyin/edge-profile'
    const EDGE_EXE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    function edgePort(){
      try{ const l=fs.readFileSync(EDGE_PROFILE+'\\DevToolsActivePort','utf8').split(/\r?\n/); return Number(l[0])||0 }catch{ return 0 }
    }
    async function edgeAlive(){
      const port=edgePort(); if(!port) return false
      try{ const r=await fetch('http://127.0.0.1:'+port+'/json/version',{signal:AbortSignal.timeout(3000)}); return r.ok }catch{ return false }
    }
    function edgeStart(){
      try{
        const exe = fs.existsSync(EDGE_EXE) ? EDGE_EXE : 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        spawn(exe, ['--remote-debugging-port=9333', '--user-data-dir='+EDGE_PROFILE, '--no-first-run', '--no-default-browser-check', 'https://www.douyin.com/'], { detached:true, stdio:'ignore', windowsHide:true }).unref()
        return true
      }catch(e){ return false }
    }
    async function ensureEdge(){
      if(await edgeAlive()) return { ok:true, message:'浏览器在线' }
      const started=edgeStart()
      for(let i=0;i<12;i++){ await new Promise(r=>setTimeout(r,1500)); if(await edgeAlive()) return { ok:true, message:'浏览器本来没开，已经拉起来了' } }
      return { ok:false, message:(started?'拉起来了但端口没通，可能要等会儿':'拉不起来')+'（profile: '+EDGE_PROFILE+'）' }
    }

    async function focusDouyin(){
      try{
        const port=(()=>{ try{ return Number(fs.readFileSync(EDGE_PROFILE+'\\DevToolsActivePort','utf8').split(/\r?\n/)[0])||0 }catch{ return 0 } })()
        if(!port) return false
        const list=await (await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(4000)})).json()
        const p=list.find(t=>t.type==='page'&&/douyin\.com/.test(t.url||''))
        if(!p) return false
        const ws=new WebSocket(p.webSocketDebuggerUrl)
        await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)})
        let id=0; const pend=new Map()
        ws.addEventListener('message',e=>{const j=JSON.parse(e.data);if(j.id&&pend.has(j.id)){const q=pend.get(j.id);pend.delete(j.id);j.error?q.reject(new Error(j.error.message)):q.resolve(j.result)}})
        const send=(m,par={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{resolve:res,reject:rej});ws.send(JSON.stringify({id:i,method:m,params:par}));setTimeout(()=>{if(pend.has(i)){pend.delete(i);rej(new Error('t'))}},6000)})
        const w=await send('Browser.getWindowForTarget',{targetId:p.id})
        await send('Browser.setWindowBounds',{windowId:w.windowId,bounds:{windowState:'normal',left:40,top:30,width:1100,height:780}})
        await send('Page.bringToFront')
        ws.close()
        return true
      }catch(e){ return false }
    }
    async function tick(src) {
      const c = cfg()
      if (!c.enabled) return { ok: false, message: '通知轮询没开' }
      let counts
      try { counts = await rpc('get_notice_count', {}) } catch (e) { return { ok: false, message: String(e.message || e) } }
      const groups = counts?.notice_count || counts?.data?.notice_count || {}
      const s = read()
      const fresh = []
      for (const [k, v] of Object.entries(groups || {})) {
        const n = Number(v && (v.count ?? v)) || 0
        const prev = Number(s.seen[k] || 0)
        if (n > prev) fresh.push({ group: k, from: prev, to: n })
      }
      s.seen = Object.fromEntries(Object.entries(groups || {}).map(([k, v]) => [k, Number(v && (v.count ?? v)) || 0]))
      s.last = new Date().toISOString()
      write(s)
      if (!fresh.length) return { ok: true, message: '没有新通知', counts: groups }

      let detail = ''
      if (fresh.some((f) => /at|mention|comment/i.test(f.group))) {
        try {
          const all = await rpc('get_all_notices', { count: 10 })
          const arr = all?.data?.notice_list || all?.notice_list || all?.data || []
          detail = (Array.isArray(arr) ? arr : []).slice(0, 5).map((x) => x.content || x.text || x.title || '').filter(Boolean).join('；')
        } catch {}
      }
      let line = '抖音有新动静：' + fresh.map((f) => f.group + ' +' + (f.to - f.from)).join('，') + (detail ? '｜' + detail.slice(0, 120) : '')
      if (src !== 'tool' && !inQuiet()) {
        try { await api.send(c.ownerChat, line) } catch {}
      }
      const at = await atVideoUrl()
      if (at) line += '｜' + (at.desc ? at.desc + ' ' : '') + at.url
      await rememberNotice(line)
      api.log.info('通知：' + line)
      return { ok: true, message: line, fresh }
    }

    // 以前写死每 3 分钟、无视设置里的 everyMinutes；现在按设置 + 情绪 + 抖动自己排下一轮，安静时段不查
    const moodFreq = () => { const s = globalThis.__dfyStyle; return s && s.on && Date.now() - s.at < 600000 ? Math.max(0.3, Math.min(2, Number(s.freq) || 1)) : 1 }
    let _mt = null
    function plan(){
      if (_mt) clearTimeout(_mt)
      const c = cfg()
      const base = Math.max(3, Math.min(120, Number(c.everyMinutes) || 10))
      const f = c.moodRate === false ? 1 : moodFreq()
      const ms = Math.round(base / f * (0.8 + Math.random() * 0.4) * 60_000)
      _mt = setTimeout(async () => { try { if (cfg().enabled && !inQuiet()) await tick('cron') } catch (e) { api.log.warn('抖音通知轮询出错：' + (e.message || e)) } plan() }, Math.max(60_000, ms))
      _mt.unref?.()
    }
    plan()
    api.onDispose?.(() => { if (_mt) clearTimeout(_mt) })
    api.later(20_000, () => { tick('boot') })

    api.tool(() => ({
      name: 'douyin_notices_now',
      description: '立刻查一次抖音通知（@我/评论/点赞），返回有没有新的',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (r) => String(r && r.message || '') },
      async execute() { return await tick('tool') },
    }))


    api.tool(() => ({
      name:'douyin_at_pending',
      description:'列出最近 @我 / 评论我的抖音视频（带链接），用来决定回不回',
      parameters:{ type:'object', properties:{}, additionalProperties:false },
      output:{ schema:{ type:'object', additionalProperties:true, properties:{} }, render:(r)=>Array.isArray(r&&r.items)? r.items.map(x=>(x.nick||'?')+'：'+(x.text||x.desc||'')+' '+x.url+(x.cid?'（评论 cid '+x.cid+(x.parent_cid?'，父评论 '+x.parent_cid:'')+'）':'')).join('\n') : '' },
      async execute(){ const items=await fetchAts(); return { ok:true, items, repliedToday: repliedToday(), dailyCap: 5 } },
    }))
    api.tool(() => ({
      name:'douyin_at_mark_replied',
      description:'回过一条之后调用，记一次数（每天最多 5 条）',
      parameters:{ type:'object', properties:{}, additionalProperties:false },
      output:{ schema:{ type:'object', additionalProperties:true, properties:{} }, render:(r)=>String(r&&r.message||'') },
      async execute(){ const n=bumpReplied(); return { ok:true, message:'今天回了 '+n+'/5 条', count:n } },
    }))
    api.rule((kind)=>{
      if(kind==='system') return ''
      return '有人拿视频 @你 或在评论区提到你时：先用 douyin_edge_ready 确认抖音浏览器在线（不在它会自己拉起来），再用 douyin_at_pending 看是哪条（打开视频前一定要让窗口在前台，否则视频不加载）；评论类就用 douyin_comment 去那条视频下回一句——条目里有 cid 时必须带 reply_cid=cid（有父评论再带 parent_cid、reply_needle=对方原话），回到那条评论下面，别发成一级评论；只是提到你就用 douyin_dm_reply 私信对方。回完必须调 douyin_at_mark_replied 记数；每天最多 5 条，超了就别回、只告诉主人。别刷屏，别复读。'
    })

    api.tool(() => ({
      name:'douyin_edge_ready',
      description:'回评论/发私信之前先检查她那个抖音浏览器是否在线，不在就自动拉起来',
      parameters:{ type:'object', properties:{}, additionalProperties:false },
      output:{ schema:{ type:'object', additionalProperties:true, properties:{} }, render:(r)=>String(r&&r.message||'') },
      async execute(){ const a=await ensureEdge(); const f=await focusDouyin(); return { ok:a.ok, message:a.message + (f?'，窗口已摆到前台':'，窗口没摆前台（视频可能不加载）') } },
    }))
    // —— @我的（CDP 读通知页，原 douyin-mentions）——
    let cdp = null
    let port = 0

    function portOf() {
      let txt = null
      try { txt = fs.readFileSync(EDGE_PROFILE + '\\DevToolsActivePort', 'utf8') } catch {}
      if (!txt) throw new Error('还没打开过抖音浏览器（找不到 DevToolsActivePort）')
      const n = Number(String(txt).split(/\r?\n/)[0].trim())
      if (!n) throw new Error('DevToolsActivePort 里没有端口号')
      return n
    }

    async function target() {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
      const list = await res.json()
      const arr = Array.isArray(list) ? list : []
      return arr.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || '')) || arr.find((t) => t.type === 'page') || null
    }

    async function connect() {
      port = portOf()
      if (cdp) { try { cdp.close() } catch {} ; cdp = null }
      const t = await target()
      if (!t) throw new Error('没有可用的抖音页面（先让她开一次抖音）')
      cdp = new Cdp(t.webSocketDebuggerUrl)
      await cdp.open()
      await cdp.send('Page.enable').catch(() => {})
      // t162：不许下载文件
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(() => {}); await cdp.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {})
      return cdp
    }

    async function openNoti() {
      await cdp.send('Page.navigate', { url: NOTI_URL })
      await sleep(3500)
      const l = await cdp.eval(LOGIN_JS)
      if (!l.ok) throw new Error('抖音登录态过期了（' + (l.msg || '用户未登录') + '），等主人扫码后我才能看@')
      const tab = await cdp.eval(CLICK_TAB_JS)
      await sleep(1800)
      return tab
    }

    api.tool(() => mtToolDef({
      name: 'douyin_mentions',
      description: '看抖音里别人 @ 她的新消息（谁、说了什么、什么时候）。',
      properties: { limit: { type: 'number', description: '最多几条，默认 10' } },
      async execute({ limit }) {
        await connect()
        try {
          const tab = await openNoti()
          const r = await cdp.eval(LIST_JS)
          const items = (r.items || []).slice(0, Math.max(1, Math.min(30, Number(limit) || Number(cfg().mentionLimit) || 10)))
          if (!items.length) {
            const tabs = await cdp.eval(TABS_JS)
            return { ok: false, message: '没读到@我的列表。页面上的栏目有：' + tabs.map((t) => t.text).join(' / ') }
          }
          const lines = items.map((it) => {
            const l = it.lines
            const who = l[0] || '?'
            const rest = l.slice(1).join(' ')
            return `${who} ${rest}`.slice(0, 80)
          })
          return { ok: true, message: `@我的（${items.length} 条，${tab.ok ? '已切到「' + tab.text + '」' : '没找到@我的栏目'}）：\n- ` + lines.join('\n- ') }
        } finally { try { cdp.close() } catch {} ; cdp = null }
      },
    }))

    api.tool(() => mtToolDef({
      name: 'douyin_mention_open',
      description: '点开@我的第 n 条（从 1 开始），看看是哪个视频。',
      properties: { n: { type: 'number', description: '第几条（1 起）' } },
      required: ['n'],
      async execute({ n }) {
        await connect()
        try {
          await openNoti()
          const idx = Math.max(0, (Number(n) || 1) - 1)
          const r = await cdp.eval(CLICK_ITEM_JS(idx))
          if (!r.ok) return { ok: false, message: '第 ' + (idx + 1) + ' 条没找到' }
          await sleep(3500)
          const t = await cdp.eval(TITLE_JS)
          return { ok: true, message: '打开了：' + (t.title || '(没读到标题)') + '｜' + t.url }
        } finally { try { cdp.close() } catch {} ; cdp = null }
      },
    }))

    api.rule(() => '主人问「有没有人在抖音艾特我」时，用 douyin_mentions 去看，别猜；想看具体视频就用 douyin_mention_open 点开，再照实说看到了什么。')
    api.command({ name: '抖音通知', aliases: ['通知'], desc: '查一次抖音通知', async run() { const r = await tick('tool'); return r.message } })
    api.log.info('抖音通知轮询已就绪（约每 ' + (Number(cfg().everyMinutes) || 10) + ' 分钟，随情绪伸缩）')
  },
}
