// 大肥鱼 · 网页半边：只剩侧栏「记忆星海」+ 整页星图 iframe + postMessage 桥。
// 原来的整页 React 面板（概览 / 连接 / 模型 / 语音 / 权限 / 扩展 …）已整体搬进星图：
//   http://127.0.0.1:8780/console/   （星图菜单「🎛 大肥鱼控制台」，身份对照 = console/#ext:identity）
// 星图页面在 127.0.0.1:8780，不能直接调 DSH 的 /aurabot/api/*（不同源），所以由这里转一手：
//   - 只认来自 http://127.0.0.1:8780 / http://localhost:8780 的消息；
//   - 只放白名单里的接口路径，只放 GET / POST，只转 content-type 头；
//   - 不开新端口、不做代理，DSH 关了就没桥。

window.__ModuleLoader__.load({
  id: 'dsh-aurabot-qq',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const { useState, useEffect } = React
    const h = React.createElement
    const inject = ['slots']
    const PANEL_ID = 'aurabot'
    const API = '/aurabot/api'
    const MEMORY_ID = 'memory-brain'
    const BRAIN = 'http://127.0.0.1:8780'
    // 不再带任何钥匙：星图页面自己从 localStorage（dafeiyu_admin_key，同一个 127.0.0.1:8780 源）读
    const MEMORY_URL = BRAIN + '/?theme=cosmos&v=think3'
    const ORIGINS = ['http://127.0.0.1:8780', 'http://localhost:8780']

    // ---------------- 桥 ----------------
    const ALLOW = new Set(('avatar bili changelog commands diary douyin ext groups heybox image insights local logs memories memory model models ' +
      'modules onebot panel persona personas profiles qzone save sessions setup snowluma song speakup state sticker stickers style test-send update voice').split(' '))
    const DENY = new Set(['open', 'bridge'])
    function pathOk(p) {
      if (typeof p !== 'string' || p[0] !== '/' || p.length > 2048) return false
      if (p.includes('..') || p.includes('\\') || /\s/.test(p) || p.startsWith('//')) return false
      const root = p.slice(1).split(/[/?#]/)[0]
      return ALLOW.has(root) && !DENY.has(root)
    }
    function installBridge() {
      if (window.__dfyBridge) return
      window.__dfyBridge = true
      window.addEventListener('message', async (ev) => {
        const d = ev && ev.data
        if (!d || d.type !== 'dfy-bridge' || !ORIGINS.includes(ev.origin) || !ev.source) return
        const reply = (msg, transfer) => { try { ev.source.postMessage(Object.assign({ type: 'dfy-bridge-res', id: d.id }, msg), ev.origin, transfer || []) } catch (e) {} }
        const method = String(d.method || 'GET').toUpperCase()
        if (!pathOk(d.path) || (method !== 'GET' && method !== 'POST')) {
          const buf = new TextEncoder().encode(JSON.stringify({ ok: false, message: '桥：这个接口不在白名单里' })).buffer
          return reply({ status: 403, contentType: 'application/json; charset=utf-8', body: buf }, [buf])
        }
        try {
          const headers = {}
          const ct = d.headers && (d.headers['content-type'] || d.headers['Content-Type'])
          if (ct) headers['content-type'] = String(ct)
          const body = method === 'POST' && d.body != null && (typeof d.body === 'string' || d.body instanceof ArrayBuffer) ? d.body : undefined
          const r = await fetch(API + d.path, { method, headers, body, cache: 'no-store' })
          const buf = await r.arrayBuffer()
          reply({ status: r.status, contentType: r.headers.get('content-type') || '', body: buf }, [buf])
        } catch (e) {
          reply({ error: String((e && e.message) || e) })
        }
      })
    }

    // ---------------- 侧栏「记忆星海」：整页星图 ----------------
    function MemoryIcon() {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, lineHeight: 1 } }, '\u{1F41F}')
    }
    function MemoryPage() {
      const [src, setSrc] = useState({ url: MEMORY_URL, n: 0 })
      const [up, setUp] = useState(null)
      useEffect(() => {
        installBridge()
        let alive = true
        const check = () => fetch(BRAIN + '/health', { cache: 'no-store', mode: 'no-cors' }).then(() => { if (alive) setUp(true) }).catch(() => { if (alive) setUp(false) })
        check()
        const t = setInterval(() => { if (!document.hidden) check() }, 60000)
        const onMsg = (ev) => {
          const d = ev && ev.data
          if (!d || d.type !== 'dafeiyu-nav' || !ORIGINS.includes(ev.origin)) return
          // 子页「回星海」→ 父页重载星图根；「去身份对照」→ 星图控制台的身份对照页
          if (d.to === 'identity') setSrc((s) => ({ url: BRAIN + '/console/#ext%3Aidentity', n: s.n + 1 }))
          else setSrc((s) => ({ url: MEMORY_URL, n: s.n + 1 }))
        }
        window.addEventListener('message', onMsg)
        return () => { alive = false; clearInterval(t); window.removeEventListener('message', onMsg) }
      }, [])
      return h('div', { style: { position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 'calc(100vh - var(--dsh-frame-top-clearance, 0px))' } },
        up === false ? h('div', { style: { position: 'absolute', top: 8, right: 12, zIndex: 2, fontSize: 12, color: '#fff', background: '#d9534f', borderRadius: 8, padding: '4px 10px' } },
          '记忆大脑没在跑（127.0.0.1:8780）', ' ', h('a', { href: '#', style: { color: '#fff' }, onClick: (e) => { e.preventDefault(); setSrc((s) => ({ url: MEMORY_URL, n: s.n + 1 })) } }, '重试')) : null,
        h('iframe', { key: src.n, src: src.url, title: '记忆星海', style: { flex: 1, width: '100%', height: '100%', border: 0, background: '#01030a', display: 'block' } }))
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return
      installBridge()
      // 侧栏只留「记忆星海」；旧的 main key 'aurabot'（PANEL_ID）也指到同一个星图页，别的地方跳 aurabot 不会白屏
      slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, MemoryPage))
      slots.inject('main', () => slots.register({ name: 'main', key: MEMORY_ID }, MemoryPage))
      slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: MEMORY_ID, order: 21, label: () => '记忆星海' }, MemoryIcon))
    }
    exports.apply = apply
    exports.inject = inject
    exports.AurabotPage = MemoryPage
    exports.WhaleIcon = MemoryIcon
    return module.exports
  },
})
