// 抖音接口（只读）— 桥接本地 douyin-mcp（Go，127.0.0.1:18080），补上「通知/@我、搜索、热搜、评论、观看历史、收藏、用户资料」
// 设计原则：
//   1) 只读优先。写接口（点赞/评论/发布）需要 ticket-guard 材料，缺料时接口会自己报错，这里不主动调用。
//   2) 与现有模块不重名：工具全用 dyapi_ 前缀；私信/群聊仍走 douyin-dm / douyin-group（CDP 版）。
//   3) 服务没起就拉起来；未登录就明确告诉她「没登录」，不许编。
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

// douyin-mcp 二进制位置：默认相对路径，真实位置请用环境变量覆盖（见 SECURITY.md / README 配置外置）
const EXE = process.env.DOUYIN_MCP_EXE || 'douyin-mcp/douyin-mcp-windows-amd64.exe'
const WORKDIR = process.env.DOUYIN_MCP_DIR || 'douyin-mcp'

export default {
  id: 'douyin-api',
  name: '抖音接口（只读）',
  version: '1.0.0',
  api: 1,
  description: '通过本地 douyin-mcp 服务读取抖音数据：消息通知/@我、搜索、热搜、作品评论、观看历史、收藏、用户资料。不需要浏览器。',
  defaults: {
    enabled: true,
    baseUrl: 'http://127.0.0.1:18080',
    autoStart: true,
    timeoutMs: 15000,
    maxList: 10,
  },
  settings: [
    { key: 'enabled', label: '总开关', type: 'bool' },
    { key: 'baseUrl', label: '服务地址', type: 'text', hint: '默认 http://127.0.0.1:18080' },
    { key: 'autoStart', label: '没启动时自动拉起', type: 'bool', hint: '只拉起一次，180 秒内不重复' },
    { key: 'timeoutMs', label: '超时（毫秒）', type: 'number' },
    { key: 'maxList', label: '每次最多几条', type: 'number' },
  ],

  setup(api) {
    const C = () => ({
      enabled: true,
      baseUrl: 'http://127.0.0.1:18080',
      autoStart: true,
      timeoutMs: 15000,
      maxList: 10,
      ...(api.settings() || {}),
    })

    let spawnAt = 0
    let lastNote = ''

    function toolDef(o) {
      return {
        name: o.name,
        description: o.description,
        parameters: o.parameters || { type: 'object', properties: {}, additionalProperties: false },
        output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => '' },
        execute: o.execute,
      }
    }

    async function health(c) {
      try {
        const r = await fetch(`${c.baseUrl}/health`, { signal: AbortSignal.timeout(2500) })
        return r.ok
      } catch {
        return false
      }
    }

    async function ensureService(c) {
      if (await health(c)) return true
      if (!c.autoStart) return false
      if (Date.now() - spawnAt < 180000) return false
      if (!fs.existsSync(EXE)) {
        lastNote = '没找到 douyin-mcp 可执行文件'
        return false
      }
      spawnAt = Date.now()
      try {
        const p = spawn(EXE, ['-port', ':18080'], {
          cwd: WORKDIR,
          detached: true,
          windowsHide: true,
          stdio: 'ignore',
        })
        p.unref()
        api.log.info('抖音接口：服务没在跑，尝试拉起')
      } catch (e) {
        lastNote = '拉起失败：' + e.message
        return false
      }
      // 给进程 3 秒起来
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 800))
        if (await health(c)) return true
      }
      lastNote = '服务拉起后没响应'
      return false
    }

    async function rpc(name, args, ms) {
      const c = C()
      const body = { jsonrpc: '2.0', id: Date.now() % 100000, method: 'tools/call', params: { name, arguments: args || {} } }
      const r = await fetch(`${c.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(ms || Number(c.timeoutMs) || 15000),
      })
      const txt = await r.text()
      const line = txt.split('\n').find((l) => l.trim().startsWith('{')) || txt
      let j = null
      try {
        j = JSON.parse(line)
      } catch {
        throw new Error('服务返回看不懂：' + txt.slice(0, 120))
      }
      const t = j?.result?.content?.[0]?.text
      let data = null
      try {
        data = t ? JSON.parse(t) : null
      } catch {
        data = t
      }
      const s = typeof data === 'string' ? data : JSON.stringify(data || '')
      if (/用户未登录|status_code=8|not.?login/i.test(s)) {
        const e = new Error('抖音没登录')
        e.needLogin = true
        throw e
      }
      if (j?.result?.isError) {
        const e = new Error(String(s).slice(0, 200) || '接口出错')
        e.apiError = true
        throw e
      }
      return data
    }

    async function call(name, args, ms) {
      const c = C()
      if (!c.enabled) throw new Error('抖音接口关着')
      const ok = await ensureService(c)
      if (!ok) throw new Error(lastNote || '抖音接口服务没在跑')
      return rpc(name, args, ms)
    }

    function fail(e) {
      lastNote = e.message
      api.log.warn('抖音接口：' + e.message)
      if (e.needLogin) return { ok: false, message: '抖音这套接口现在未登录（cookie 过期）。要我去把登录二维码取出来你扫一下吗？' }
      return { ok: false, message: '没读出来：' + e.message }
    }

    const clip = (s, n) => {
      const t = String(s == null ? '' : s)
      return t.length > n ? t.slice(0, n) + '…' : t
    }

    // —— 状态 ——
    // —— 从自动化浏览器导出 cookie 并重启服务（扫码登录后、或接口报未登录时刷新用）——
    const EDGE_PROFILE = process.env.DOUYIN_PROFILE_DIR || 'douyin/edge-profile'
    const COOKIE_FILE = path.join(WORKDIR, 'cookies.txt')

    function edgePort() {
      try {
        const t = fs.readFileSync(path.join(EDGE_PROFILE, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0].trim()
        const n = Number(t)
        return Number.isFinite(n) && n > 0 ? n : 0
      } catch {
        return 0
      }
    }

    async function exportCookies(port) {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(8000) })).json()
      const page = list.find((t) => t.type === 'page' && /douyin\.com/.test(t.url || '')) || list.find((t) => t.type === 'page')
      if (!page) throw new Error('浏览器里没有抖音页面')
      const ws = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('连不上浏览器调试端口')), 8000)
        ws.addEventListener('open', () => { clearTimeout(t); res() })
        ws.addEventListener('error', () => { clearTimeout(t); rej(new Error('调试端口错误')) })
      })
      let id = 0
      const pend = new Map()
      ws.addEventListener('message', (e) => {
        const j = JSON.parse(e.data)
        if (j.id && pend.has(j.id)) {
          const p = pend.get(j.id)
          pend.delete(j.id)
          j.error ? p.reject(new Error(j.error.message)) : p.resolve(j.result)
        }
      })
      const send = (m, p = {}) =>
        new Promise((res, rej) => {
          const i = ++id
          pend.set(i, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id: i, method: m, params: p }))
          setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('浏览器操作超时')) } }, 15000)
        })
      await send('Network.enable')
      const { cookies } = await send('Network.getAllCookies', {})
      ws.close()
      const keep = cookies.filter((c) => /douyin\.com$|amemv\.com$|iesdouyin\.com$/.test(c.domain))
      const seen = new Set()
      const parts = []
      for (const c of keep) {
        if (seen.has(c.name)) continue
        seen.add(c.name)
        parts.push(c.name + '=' + c.value)
      }
      const header = parts.join('; ')
      if (!header.includes('sessionid=')) throw new Error('浏览器里没有 sessionid，先在那个抖音窗口里扫码登录')
      fs.writeFileSync(COOKIE_FILE, header, 'utf8')
      return { count: parts.length, bytes: header.length }
    }

    function servicePid(c) {
      try {
        const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
        const port = new URL(c.baseUrl).port || '18080'
        const line = String(r.stdout || '').split(/\r?\n/).find((l) => l.includes(':' + port) && l.includes('LISTENING'))
        if (!line) return 0
        const m = line.trim().split(/\s+/)
        return Number(m[m.length - 1]) || 0
      } catch {
        return 0
      }
    }

    async function restartService(c) {
      const pid = servicePid(c)
      if (pid) {
        try { spawnSync('taskkill', ['/F', '/PID', String(pid)], { windowsHide: true, timeout: 10000 }) } catch {}
      }
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (!(await health(c))) break
      }
      spawnAt = 0
      return ensureService(c)
    }

    api.tool(() =>
      toolDef({
        name: 'dyapi_login_from_browser',
        description:
          '把自动化浏览器（Aurabot 的 Edge）里已经登录的抖音 cookie 导出给 douyin-mcp，并重启服务让它立刻生效。接口报「用户未登录」时先跑这个。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          const c = C()
          const port = edgePort()
          if (!port) return { ok: false, message: '没找到浏览器的调试端口（DevToolsActivePort），抖音窗口可能没开。' }
          let info
          try {
            info = await exportCookies(port)
          } catch (e) {
            return { ok: false, message: '导出 cookie 失败：' + String(e && e.message) }
          }
          const ok2 = await restartService(c)
          if (!ok2) return { ok: false, message: 'cookie 已导出（' + info.count + ' 个），但服务没重启起来。' }
          const t = await rpc('get_notice_count', {}, c).catch((e) => 'ERR ' + e.message)
          const bad = typeof t === 'string' && /未登录|status_code=8/.test(t)
          api.log.info('[douyin-api] 已从浏览器同步登录态：' + info.count + ' 个 cookie，登录校验=' + (bad ? '未通过' : '通过'))
          return {
            ok: !bad,
            message: bad
              ? 'cookie 已导出并重启服务，但仍然报未登录。可能浏览器那边的登录态也过期了，先在窗口里重新扫码。'
              : '已经从浏览器同步登录态并重启服务，接口可用了（' + info.count + ' 个 cookie）。',
            cookies: info.count,
          }
        },
      })
    )

    api.tool(() =>
      toolDef({
        name: 'dyapi_status',
        description: '看抖音只读接口通不通、有没有登录。问「抖音接口能用吗」时用。',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          const c = C()
          const up = await ensureService(c)
          if (!up) return { ok: false, message: '服务没在跑：' + (lastNote || '未知原因') }
          // check_login_status 会因为 cookie 文件存在就报 true，拿真实接口验一次才算数
          let real = false
          let why = ''
          try {
            await rpc('get_notice_count', {})
            real = true
          } catch (e) {
            real = false
            why = e.message
          }
          if (real) return { ok: true, message: '接口在线，已登录（真实读取通过）', baseUrl: c.baseUrl, loggedIn: true }
          return { ok: true, message: '接口在线，但没登录：' + (why || '未知') + '。要我把二维码取出来你扫一下吗？', baseUrl: c.baseUrl, loggedIn: false }
        },
      }),
    )

    // —— 通知 / @我 ——
    api.tool(() =>
      toolDef({
        name: 'dyapi_notices',
        description: '看抖音消息通知：未读数 + 最新通知（评论、赞、@我、系统）。回答「有没有人@我」「有没有新评论」用它。',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'comment / digg / at / system / all，默认 all' },
            limit: { type: 'number' },
          },
        },
        execute: async ({ type: t, limit }) => {
          const c = C()
          const n = Math.min(30, Number(limit) || Number(c.maxList) || 10)
          try {
            let unread = null
            try {
              unread = await rpc('get_notice_count', {})
            } catch (e) {
              if (e.needLogin) throw e
            }
            const list = await rpc('get_all_notices', t && t !== 'all' ? { type: t, count: n } : { count: n })
            const items = Array.isArray(list) ? list : list?.notices || list?.data || []
            const lines = (Array.isArray(items) ? items : []).slice(0, n).map((x, i) => {
              const who = x.user?.nickname || x.nickname || x.from_user?.nickname || '某人'
              const what = x.content || x.text || x.comment?.text || x.title || JSON.stringify(x).slice(0, 60)
              const when = x.create_time || x.timestamp || x.time || ''
              return `${i + 1}. ${who}：${clip(what, 60)}${when ? '（' + when + '）' : ''}`
            })
            const head = unread ? `未读：${clip(JSON.stringify(unread), 120)}` : '未读：没读到'
            return {
              ok: true,
              message: `${head}\n${lines.length ? lines.join('\n') : '（没有新通知）'}`,
              count: lines.length,
            }
          } catch (e) {
            return fail(e)
          }
        },
      }),
    )

    // —— 搜索 / 热搜 ——
    api.tool(() =>
      toolDef({
        name: 'dyapi_search',
        description: '搜抖音：视频、用户、直播、话题、热搜、联想词。想看某个主题/某个人/什么在火，用这个。',
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string' },
            kind: { type: 'string', description: 'video / user / live / challenge / suggest / hot，默认 video' },
            limit: { type: 'number' },
          },
        },
        execute: async ({ keyword, kind, limit }) => {
          const c = C()
          const k = String(kind || 'video').toLowerCase()
          const n = Math.min(20, Number(limit) || Number(c.maxList) || 10)
          const kw = String(keyword || '').trim()
          try {
            if (k === 'hot') {
              const hot = await rpc('get_hot_search_board', {})
              const list = hot?.data?.data || hot?.data || hot?.list || []
              const lines = (Array.isArray(list) ? list : []).slice(0, n).map((x, i) => `${i + 1}. ${x.word || x.sentence || x.title || clip(JSON.stringify(x), 40)}${x.hot_value ? '（热' + x.hot_value + '）' : ''}`)
              return { ok: true, message: `抖音热搜：\n${lines.join('\n') || '（空）'}`, count: lines.length }
            }
            if (!kw) return { ok: false, message: '要搜什么？给我个关键词' }
            const map = { video: 'search_videos', user: 'search_users', live: 'search_lives', challenge: 'search_challenges', suggest: 'search_suggest' }
            const name = map[k] || 'search_videos'
            const res = await rpc(name, { keyword: kw, count: n })
            const list = res?.data || res?.list || res
            const arr = Array.isArray(list) ? list : []
            const lines = arr.slice(0, n).map((x, i) => {
              if (k === 'user') return `${i + 1}. ${x.nickname || x.nick_name || '?'}（抖音号 ${x.unique_id || x.short_id || '?'}，粉丝 ${x.follower_count ?? '?'}）`
              if (k === 'live') return `${i + 1}. ${x.title || x.nickname || '?'}（在线 ${x.user_count ?? '?'}）`
              if (k === 'suggest') return `${i + 1}. ${x.word || x.sentence || String(x)}`
              if (k === 'challenge') return `${i + 1}. #${x.cha_name || x.challenge_name || '?'}（${x.view_count ?? '?'} 次）`
              const st = x.statistics || {}
              return `${i + 1}. ${clip(x.desc || x.title || x.aweme_info?.desc || '?', 60)}${st.digg_count != null ? '（赞 ' + st.digg_count + '）' : ''}`
            })
            return { ok: true, message: `抖音搜「${kw}」（${k}）：\n${lines.join('\n') || '（没搜到）'}`, count: lines.length }
          } catch (e) {
            return fail(e)
          }
        },
      }),
    )

    // —— 作品评论 ——
    api.tool(() =>
      toolDef({
        name: 'dyapi_comments',
        description: '读一个抖音作品的评论（含二级回复）。需要 aweme_id（作品 id）或作品链接。',
        parameters: {
          type: 'object',
          properties: { target: { type: 'string', description: 'aweme_id 或 https://www.douyin.com/video/xxx' }, limit: { type: 'number' } },
          required: ['target'],
        },
        execute: async ({ target, limit }) => {
          const c = C()
          const n = Math.min(30, Number(limit) || Number(c.maxList) || 10)
          const raw = String(target || '')
          const m = raw.match(/(\d{15,25})/)
          const id = m ? m[1] : raw.trim()
          if (!id) return { ok: false, message: '给我作品 id 或链接' }
          try {
            const res = await rpc('get_all_video_comments', { aweme_id: id, count: n })
            const arr = res?.data || res?.comments || res
            const lines = (Array.isArray(arr) ? arr : []).slice(0, n).map((x, i) => {
              const who = x.user?.nickname || '某人'
              const txt = x.text || x.content || ''
              const like = x.digg_count != null ? `（赞 ${x.digg_count}）` : ''
              return `${i + 1}. ${who}：${clip(txt, 80)}${like}`
            })
            return { ok: true, message: `作品 ${id} 的评论：\n${lines.join('\n') || '（没有评论）'}`, count: lines.length }
          } catch (e) {
            return fail(e)
          }
        },
      }),
    )

    // —— 观看历史 / 收藏 / 稍后再看 ——
    api.tool(() =>
      toolDef({
        name: 'dyapi_library',
        description: '看抖音的「观看历史 / 收藏夹 / 稍后再看」。想知道自己之前刷过什么、收藏了什么用它。',
        parameters: {
          type: 'object',
          properties: { kind: { type: 'string', description: 'history / collect / later，默认 history' }, limit: { type: 'number' } },
        },
        execute: async ({ kind, limit }) => {
          const c = C()
          const n = Math.min(30, Number(limit) || Number(c.maxList) || 10)
          const k = String(kind || 'history').toLowerCase()
          const map = { history: 'get_watch_history', collect: 'get_collect_list', later: 'get_watch_later' }
          try {
            const res = await rpc(map[k] || 'get_watch_history', { count: n })
            const arr = res?.data || res?.aweme_list || res?.list || res
            const lines = (Array.isArray(arr) ? arr : []).slice(0, n).map((x, i) => {
              const a = x.aweme_info || x.aweme || x
              const title = a.desc || a.title || x.title || clip(JSON.stringify(x), 50)
              const who = a.author?.nickname || x.author_name || ''
              return `${i + 1}. ${clip(title, 60)}${who ? '（@' + who + '）' : ''}`
            })
            const label = k === 'collect' ? '收藏夹' : k === 'later' ? '稍后再看' : '观看历史'
            return { ok: true, message: `抖音${label}：\n${lines.join('\n') || '（空的）'}`, count: lines.length }
          } catch (e) {
            return fail(e)
          }
        },
      }),
    )

    // —— 用户资料 / 作品 ——
    api.tool(() =>
      toolDef({
        name: 'dyapi_user',
        description: '看某个抖音用户：资料 + 最近作品。需要 sec_uid（MS4wLjABAAAA… 开头）或抖音号。',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' }, limit: { type: 'number' } },
          required: ['id'],
        },
        execute: async ({ id, limit }) => {
          const c = C()
          const n = Math.min(20, Number(limit) || Number(c.maxList) || 10)
          const v = String(id || '').trim()
          if (!v) return { ok: false, message: '给我 sec_uid 或抖音号' }
          try {
            const info = v.startsWith('MS4wLjAB')
              ? await rpc('get_user_info', { sec_uid: v })
              : await rpc('get_user_info', { unique_id: v })
            const u = info?.data?.user || info?.user || info?.data || info
            const nick = u?.nickname || '?'
            const posts = await rpc('get_user_posts', v.startsWith('MS4wLjAB') ? { sec_uid: v, count: n } : { unique_id: v, count: n }).catch(() => null)
            const arr = posts?.data?.aweme_list || posts?.aweme_list || posts?.data || []
            const lines = (Array.isArray(arr) ? arr : []).slice(0, n).map((x, i) => `${i + 1}. ${clip(x.desc || '?', 50)}${x.statistics?.digg_count != null ? '（赞 ' + x.statistics.digg_count + '）' : ''}`)
            return {
              ok: true,
              message: `${nick}｜抖音号 ${u?.unique_id || u?.short_id || '?'}｜粉丝 ${u?.follower_count ?? '?'}｜作品 ${u?.aweme_count ?? '?'}\n${lines.join('\n') || '（没读到作品）'}`,
            }
          } catch (e) {
            return fail(e)
          }
        },
      }),
    )

    // —— 通用兜底：直接点名某个工具 ——
    api.tool(() =>
      toolDef({
        name: 'dyapi_call',
        description: '直接调用抖音服务的任意只读工具（高级用法）。比如 get_hot_search_board、search_videos、get_notice_count。',
        parameters: {
          type: 'object',
          properties: { tool: { type: 'string' }, args: { type: 'object', additionalProperties: true } },
          required: ['tool'],
        },
        execute: async ({ tool: name, args }) => {
          const t = String(name || '').trim()
          if (!/^[a-z_][a-z0-9_]*$/.test(t)) return { ok: false, message: '工具名要像 search_videos 这样' }
          if (/^(digg_|post_|collect_video|remove_collect|publish_|send_|leave_|kick_|update_conversation|delete_)/.test(t)) {
            return { ok: false, message: '写操作要 ticket-guard 材料，先别用它。' }
          }
          try {
            const r = await rpc(t, args || {})
            return { ok: true, message: clip(typeof r === 'string' ? r : JSON.stringify(r), 1500), tool: t }
          } catch (e) {
            return fail(e)
          }
        },
      }),
    )

    api.command({
      name: '抖音接口',
      aliases: ['dyi', 'dyapi'],
      desc: '抖音只读接口：/抖音接口 status|通知|热搜|搜 关键词|评论 <作品id>|历史',
      run: async (arg) => {
        const a = String(arg || 'status').trim()
        const [head, ...rest] = a.split(/\s+/)
        try {
          if (/^status|状态|通了?$/.test(head)) {
            const up = await ensureService(C())
            return up ? '抖音接口：服务在线' + (lastNote ? '（上次：' + lastNote + '）' : '') : '抖音接口：服务没在跑（' + lastNote + '）'
          }
          if (/^通知|消息|@/.test(head)) {
            const r = await rpc('get_all_notices', { count: 5 })
            return clip(typeof r === 'string' ? r : JSON.stringify(r), 600)
          }
          if (/^热搜|hot$/.test(head)) {
            const r = await rpc('get_hot_search_board', {})
            return clip(typeof r === 'string' ? r : JSON.stringify(r), 600)
          }
          if (/^搜/.test(head)) {
            const kw = rest.join(' ').trim()
            if (!kw) return '要搜什么？/抖音接口 搜 露营'
            const r = await rpc('search_videos', { keyword: kw, count: 5 })
            return clip(typeof r === 'string' ? r : JSON.stringify(r), 600)
          }
          if (/^历史/.test(head)) {
            const r = await rpc('get_watch_history', { count: 5 })
            return clip(typeof r === 'string' ? r : JSON.stringify(r), 600)
          }
          return '用法：/抖音接口 status|通知|热搜|搜 关键词|历史'
        } catch (e) {
          return fail(e).message
        }
      },
    })

    api.rule((kind) => {
      const base = '抖音有两套通道：私信/群聊走 douyin-dm、douyin-group（浏览器）；看通知/@我、搜索、热搜、评论、观看历史、收藏走 dyapi_* 工具（本地服务）。'
      const nofake = '拿不到就说「没登录/没读到」，不许编造通知、评论或数据。'
      if (kind === 'private' || kind === 'group') return base + nofake
      return base
    })

    api.later(6000, () => {
      ensureService(C())
        .then((up) => api.log.info(`抖音接口：${up ? '服务在线' : '服务没在跑（' + (lastNote || '未知') + '）'}`))
        .catch((e) => api.log.warn('抖音接口自检失败：' + e.message))
    })

    api.every(10 * 60_000, () => {
      if (!C().enabled) return
      ensureService(C()).catch(() => {})
    }, '抖音接口保活')
  },
}
