// 扩展模块「art」——让她自己画图 / 上网找图，用来当头像、背景图、发朋友圈。
//
// 画图：用 SVG 现场生成（渐变底 + 光斑 + 星点 + 可选文字），再用本机 Edge 无头渲染成 PNG。
// 找图：必应图片搜索的 HTML 里抽 murl，下载第一张能用的。
//
// 产物都落在 modules-data/art/ 下，用 api.sendImage 可以直接丢到 QQ / 群里。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const DEFAULTS = {
  outDir: '',            // 空 = api.dataDir()
  edgePath: '',          // 空 = 自动找
  lastImage: '',
  lastSource: '',
}

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
]

// 配色：按关键词挑，挑不到就用「深海蓝」
const PALETTES = [
  { keys: ['米', '饭', '吃', '食物', '甜'], name: '米白', bg: ['#fff7ea', '#ffe3c2'], blobs: ['#ffd9a8', '#ffc078', '#fff2dd'], ink: '#7a4a1d' },
  { keys: ['海', '鲸', '蓝', '水', '雨'], name: '深海', bg: ['#0a1b3d', '#134e7a'], blobs: ['#2fa8ff', '#7fe3ff', '#1b6ea8'], ink: '#eaf6ff' },
  { keys: ['夜', '星', '月', '梦'], name: '夜空', bg: ['#0b0a1f', '#2a1a4a'], blobs: ['#8f6bff', '#45d6ff', '#ff7ac6'], ink: '#efe9ff' },
  { keys: ['花', '粉', '春', '可爱'], name: '樱粉', bg: ['#fff1f6', '#ffd6e7'], blobs: ['#ff9ec4', '#ffc8dd', '#fff0f6'], ink: '#8c3a5c' },
  { keys: ['火', '热', '夏', '橙'], name: '落日', bg: ['#2a0f14', '#7a2b1e'], blobs: ['#ff8a3d', '#ffd166', '#ff4d6d'], ink: '#fff3e0' },
  { keys: ['绿', '草', '森', '叶'], name: '苔原', bg: ['#0d1f16', '#1f4a33'], blobs: ['#5fd18b', '#b7f2c9', '#2f8f5b'], ink: '#eafff2' },
]

function toolDef({ name, description, properties = {}, required = [], execute }) {
  return {
    name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_a, v) => [{ type: 'text', text: (v && v.message) || '✓' }],
    },
    async execute(args) {
      try { return JSON.parse(JSON.stringify((await execute(args || {})) ?? { ok: true })) }
      catch (e) { return { ok: false, message: String((e && e.message) || e) } }
    },
  }
}

const rnd = (a, b) => a + Math.random() * (b - a)
const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)]

function paletteFor(text) {
  const s = String(text || '')
  for (const p of PALETTES) if (p.keys.some((k) => s.includes(k))) return p
  return PALETTES[1]
}

function svgArt({ prompt, text, size }) {
  const [w, h] = size
  const pal = paletteFor(prompt + ' ' + (text || ''))
  const blobs = Array.from({ length: 5 + Math.floor(rnd(0, 3)) }, () => {
    const cx = rnd(0.1, 0.9) * w, cy = rnd(0.1, 0.9) * h
    const r = rnd(0.12, 0.38) * Math.min(w, h) * 1.6
    return `<circle cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" r="${r.toFixed(0)}" fill="${pickOne(pal.blobs)}" opacity="${rnd(0.18, 0.42).toFixed(2)}"/>`
  }).join('\n')
  const stars = Array.from({ length: 70 }, () => `<circle cx="${rnd(0, w).toFixed(0)}" cy="${rnd(0, h).toFixed(0)}" r="${rnd(0.4, 1.6).toFixed(1)}" fill="#ffffff" opacity="${rnd(0.15, 0.75).toFixed(2)}"/>`).join('\n')
  const caption = text
    ? `<text x="${w / 2}" y="${h * 0.86}" text-anchor="middle" font-family="'Noto Sans SC','Microsoft YaHei',sans-serif" font-size="${Math.round(Math.min(w, h) * 0.075)}" fill="${pal.ink}" opacity="0.92">${String(text).replace(/[<>&]/g, '')}</text>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${pal.bg[0]}"/><stop offset="1" stop-color="${pal.bg[1]}"/>
    </linearGradient>
    <filter id="soft"><feGaussianBlur stdDeviation="${Math.round(Math.min(w, h) * 0.06)}"/></filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bg)"/>
  <g filter="url(#soft)">${blobs}</g>
  ${stars}
  ${caption}
</svg>`
}

export default {
  id: 'art',
  name: '自己画图',
  version: '1.0.0',
  api: 1,
  description: '自己生成图片（头像/背景图/朋友圈图）或上网找图',
  defaults: DEFAULTS,
  settings: [
    { key: 'edgePath', label: 'Edge 路径', type: 'text', hint: '留空自动找' },
  ],

  setup(api) {
    const cfg = () => ({ ...DEFAULTS, ...(api.settings() || {}) })
    const outDir = () => {
      const d = cfg().outDir || api.dataDir()
      fs.mkdirSync(d, { recursive: true })
      return d
    }
    const edge = () => {
      const c = cfg().edgePath
      if (c && fs.existsSync(c)) return c
      return EDGE_CANDIDATES.find((p) => fs.existsSync(p)) || ''
    }

    function stamp() {
      const d = new Date()
      const p = (n, w = 2) => String(n).padStart(w, '0')
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    }

    async function make({ prompt = '', text = '', size, width, height } = {}) {
      const exe = edge()
      if (!exe) throw new Error('找不到 Edge，画不出图')
      let W = Number(width) || 1080, H = Number(height) || 1080
      if (size === 'avatar') { W = 512; H = 512 }
      if (size === 'cover') { W = 720; H = 1080 }        // 抖音主页背景竖版
      if (size === 'banner') { W = 1080; H = 480 }
      if (size === 'square') { W = 1080; H = 1080 }
      W = Math.max(64, Math.min(2048, W)); H = Math.max(64, Math.min(2048, H))
      const dir = outDir()
      const base = path.join(dir, `art-${stamp()}`)
      const svgFile = base + '.svg'
      const pngFile = base + '.png'
      fs.writeFileSync(svgFile, svgArt({ prompt, text, size: [W, H] }), 'utf8')
      const profile = path.join(dir, '.edge-profile')
      execFileSync(exe, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars',
        `--window-size=${W},${H}`, `--screenshot=${pngFile}`,
        `--user-data-dir=${profile}`, `--virtual-time-budget=1500`,
        'file:///' + svgFile.replace(/\\/g, '/'),
      ], { stdio: 'ignore', timeout: 45000 })
      if (!fs.existsSync(pngFile)) throw new Error('渲染失败：没生成 PNG')
      const bytes = fs.statSync(pngFile).size
      api.saveSettings({ lastImage: pngFile, lastSource: 'generated' })
      api.log.info(`画了一张图：${pngFile}（${W}×${H}, ${paletteFor(prompt + text).name}, ${(bytes / 1024).toFixed(0)}KB）`)
      return { ok: true, message: `画好了：${pngFile}（${W}×${H}）`, file: pngFile, width: W, height: H, bytes }
    }

    async function findImage(query) {
      if (!query) throw new Error('要搜什么图？')
      const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'
      const url = 'https://www.bing.com/images/search?q=' + encodeURIComponent(query) + '&form=HDRSC2&first=1'
      const html = await (await fetch(url, { headers: { 'user-agent': ua, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(15000) })).text()
      const urls = [...html.matchAll(/murl&quot;:&quot;(.*?)&quot;/g)].map((m) => m[1].replace(/\\\//g, '/'))
        .filter((u) => /^https?:\/\//.test(u) && /\.(jpe?g|png|webp)(\?|$)/i.test(u))
      if (!urls.length) throw new Error('没搜到能用的图')
      const dir = outDir()
      for (const u of urls.slice(0, 6)) {
        try {
          const r = await fetch(u, { headers: { 'user-agent': ua }, signal: AbortSignal.timeout(12000) })
          if (!r.ok) continue
          const buf = Buffer.from(await r.arrayBuffer())
          if (buf.length < 4096) continue
          const ext = (u.match(/\.(jpe?g|png|webp)/i) || ['.jpg'])[0].toLowerCase()
          const file = path.join(dir, `web-${stamp()}-${Math.floor(rnd(100, 999))}${ext}`)
          fs.writeFileSync(file, buf)
          api.saveSettings({ lastImage: file, lastSource: 'web' })
          api.log.info(`找了张图：${file}（${(buf.length / 1024).toFixed(0)}KB，来自 ${u.slice(0, 60)}）`)
          return { ok: true, message: `找到一张：${file}`, file, bytes: buf.length, from: u }
        } catch {}
      }
      throw new Error('搜到了但都下不动')
    }

    api.tool(() => toolDef({
      name: 'art_make',
      description: '自己画一张图（渐变色块风格）。可以当头像、主页背景、朋友圈配图。',
      properties: {
        prompt: { type: 'string', description: '想要什么感觉，比如「深海 星星」「米白色 暖」' },
        text: { type: 'string', description: '可选：图上的字（一行，别太长）' },
        size: { type: 'string', enum: ['avatar', 'cover', 'banner', 'square'], description: 'avatar=512方图 cover=720×1080竖版 banner=1080×480 square=1080方图' },
      },
      execute: (a) => make(a),
    }))

    api.tool(() => toolDef({
      name: 'art_find',
      description: '上网搜一张现成的图（必应图片），存到本机。',
      properties: { query: { type: 'string', description: '搜什么' } },
      required: ['query'],
      execute: ({ query }) => findImage(query),
    }))

    api.tool(() => toolDef({
      name: 'art_send',
      description: '把刚画/刚找的那张图发出去（发给主人或群里）。',
      properties: { file: { type: 'string', description: '图片路径；留空 = 最近一张' } },
      async execute({ file }) {
        const f = file || cfg().lastImage
        if (!f || !fs.existsSync(f)) return { ok: false, message: '手上没有图' }
        await api.sendImage(f)
        return { ok: true, message: '发过去了：' + path.basename(f) }
      },
    }))

    api.command({
      name: '画图', aliases: ['art'], desc: '/画图 深海星星  —— 画一张发过来',
      async run(arg) {
        const prompt = String(arg || '').trim() || '深海 星星 温柔'
        const r = await make({ prompt, size: 'square' })
        try { await api.sendImage(r.file) } catch {}
        return r.message
      },
    })

    api.later(2500, () => {
      api.log.info(`自己画图已就绪（Edge=${edge() ? '有' : '无'}，出图目录=${outDir()}）`)
    })
  },
}
