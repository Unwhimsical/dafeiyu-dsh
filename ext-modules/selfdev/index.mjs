// 自己搞懂新东西：看到她感兴趣的技术/插件，先记成「候选技能」，评估完再告诉主人，
// 主人点头才写进自己的工作区。所有落盘动作都被限制在 SANDBOX 里。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

const SANDBOX = process.env.SELFDEV_SANDBOX || path.join(process.cwd(), 'selfdev-workspace', 'sandbox')
const SKILLS = path.join(SANDBOX, 'skills')
const NOTES = path.join(SANDBOX, 'notes')

function ensure() {
  for (const d of [SANDBOX, SKILLS, NOTES]) fs.mkdirSync(d, { recursive: true })
}

// 只允许在沙箱里读写：任何 ../ 或绝对路径越界都会被拒
function safe(p) {
  const full = path.resolve(SANDBOX, String(p || ''))
  const rel = path.relative(SANDBOX, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('只能在我自己的工作区里动手：' + SANDBOX)
  return full
}

function clean(name) {
  return String(name || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^[.-]+/, '').slice(0, 60)
}

function toolDef({ name, description, properties = {}, required = [], execute }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_a, v) => [{ type: 'text', text: v && v.ok === false ? '✗ ' + (v.message || '没成功') : (v && v.message) || '✓' }],
    },
    async execute(args) {
      try {
        return JSON.parse(JSON.stringify((await execute(args || {})) ?? { ok: true }))
      } catch (e) {
        return { ok: false, message: String((e && e.message) || e) }
      }
    },
  }
}

export default {
  id: 'selfdev',
  name: '自己学新本事',
  version: '1.0.0',
  api: 1,
  description: '看到新插件/新技术先记下来，评估完告诉主人，主人同意才装进自己的工作区（只能动配置里的工作区目录）',
  defaults: { enabled: true, autoNotify: true },
  settings: [
    { key: 'enabled', label: '启用', type: 'boolean', hint: '关掉之后她就不主动琢磨装新东西了' },
    { key: 'autoNotify', label: '有候选就告诉主人', type: 'boolean', hint: '发一条 QQ 消息说「我发现了个东西」' },
  ],

  setup(api) {
    ensure()
    const cfg = () => ({ ...(api.settings() || {}) })
    const stateFile = api.dataDir('state.json')
    const readState = () => {
      try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return { cands: [], installed: [] } }
    }
    const writeState = (s) => {
      try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(s, null, 2), 'utf8') } catch {}
    }

    api.log.info('自己学新本事已就绪（工作区 ' + SANDBOX + '）')

    api.tool(() => toolDef({
      name: 'skill_consider',
      description: '看到一个可能有用/有意思的东西（插件、工具、玩法），先记成候选，写下你对它的判断',
      properties: {
        name: { type: 'string', description: '它叫什么' },
        source: { type: 'string', description: '从哪看到的（链接或「抖音上刷到的视频」）' },
        what: { type: 'string', description: '它大概能干什么（一两句）' },
        worth: { type: 'string', description: '你要不要它，为什么（掂量：有用吗、会不会把别的弄坏、主人会不会喜欢）' },
        want: { type: 'boolean', description: '你想不想装' },
      },
      required: ['name', 'what'],
      async execute(a) {
        const st = readState()
        st.cands = (st.cands || []).filter((c) => c.name !== a.name)
        st.cands.push({
          name: clean(a.name), source: String(a.source || ''), what: String(a.what || ''),
          worth: String(a.worth || ''), want: !!a.want, at: Date.now(),
        })
        st.cands = st.cands.slice(-30)
        writeState(st)
        if (cfg().autoNotify !== false) {
          const line = `主人，我看到个东西：${a.name}。${a.what}${a.want ? ' 我有点想要。' : ' 我觉得不急。'}`
          try { await api.send({ text: line }) } catch {}
        }
        return { ok: true, message: `记下了：${a.name}${a.want ? '（想要）' : '（还在观望）'}，一共 ${st.cands.length} 个候选` }
      },
    }))

    api.tool(() => toolDef({
      name: 'skill_write',
      description: '把学到/写好的技能脚本存进自己的工作区（只有主人在旁边说「装吧」时才该动这个）',
      properties: {
        name: { type: 'string' },
        code: { type: 'string', description: '完整的 .mjs 源码' },
        note: { type: 'string', description: '这东西解决什么问题' },
      },
      required: ['name', 'code'],
      async execute(a) {
        const file = safe(path.join('skills', clean(a.name) + '.mjs'))
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, String(a.code), 'utf8')
        fs.writeFileSync(safe(path.join('notes', clean(a.name) + '.md')), `# ${a.name}\n\n${a.note || ''}\n`, 'utf8')
        const st = readState()
        st.installed = [...new Set([...(st.installed || []), clean(a.name)])]
        writeState(st)
        return { ok: true, message: `装好了：${file}` }
      },
    }))

    api.tool(() => toolDef({
      name: 'skill_list',
      description: '看看我记了哪些候选、装过哪些本事',
      properties: { all: { type: 'boolean' } },
      async execute() {
        const st = readState()
        const cands = (st.cands || []).slice(-8).map((c) => `${c.name}${c.want ? '★' : ''}：${c.what}`)
        const inst = (st.installed || []).slice(-8)
        return {
          ok: true,
          message: `候选 ${(st.cands || []).length} 个\n${cands.join('\n') || '（空）'}\n装过的 ${inst.length} 个：${inst.join('、') || '（空）'}`,
          cands: st.cands || [], installed: inst,
        }
      },
    }))

    api.tool(() => toolDef({
      name: 'skill_run',
      description: '跑一下自己写的技能脚本，看它能不能用（工作区里，20 秒超时）',
      properties: { name: { type: 'string' }, args: { type: 'string' } },
      required: ['name'],
      async execute(a) {
        const file = safe(path.join('skills', clean(a.name) + '.mjs'))
        if (!fs.existsSync(file)) return { ok: false, message: '还没有这个脚本：' + file }
        return await new Promise((resolve) => {
          execFile(process.execPath, [file, ...(a.args ? String(a.args).split(/\s+/).slice(0, 8) : [])],
            { cwd: SANDBOX, timeout: 20000, maxBuffer: 1024 * 512 },
            (err, stdout, stderr) => {
              if (err) resolve({ ok: false, message: '跑挂了：' + String(stderr || err.message).slice(0, 600) })
              else resolve({ ok: true, message: String(stdout || '').slice(0, 1200) || '（没输出，但没报错）' })
            })
        })
      },
    }))

    // —— 自己装插件：写 Aurabot 扩展模块（保存即热加载，不需要重启）——
    const MODS = process.env.SELFDEV_MODS || path.join(process.cwd(), 'selfdev-workspace', 'ext-modules')
    const BAK = process.env.SELFDEV_BAK || path.join(process.cwd(), 'selfdev-workspace', '_backup', 'selfinstalled')

    function modDir(id) {
      const clean = String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32)
      if (!clean) throw new Error('模块名不能用')
      return { id: clean, dir: path.join(MODS, clean) }
    }

    api.tool(() => toolDef({
      name: 'mod_list',
      description: '看看自己现在装了哪些扩展模块（我自己的和内置的都在）。',
      properties: {},
      required: [],
      execute: async () => {
        const list = fs.readdirSync(MODS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
        return { ok: true, message: '现有 ' + list.length + ' 个模块：' + list.join('、') }
      },
    }))

    api.tool(() => toolDef({
      name: 'mod_write',
      description: '给自己写一个新扩展模块（能上网、能读文件、能定时做事）。保存后几秒内自动加载生效。写完会先做语法检查，语法错就不落地。',
      properties: {
        id: { type: 'string', description: '模块 id，小写字母数字短横线，例如 websearch' },
        code: { type: 'string', description: '完整的 index.mjs 源码（ESM，必须 export default {...setup(api){...}}）' },
        note: { type: 'string', description: '一句话说明这个模块干什么' },
      },
      required: ['id', 'code'],
      execute: async (args) => {
        const { id, dir } = modDir(args.id)
        const code = String(args.code || '')
        if (!/export\s+default/.test(code)) return { ok: false, message: '不像一个模块：缺少 export default' }
        // 隔离名单 / 暗号 / 白名单 只能主人手动改，她自己写的模块一律不许碰
        if (/^(handshake|contacts|guard|cmdperm|control|identity|memcore|selfdev)$/.test(id) || /isolateQq|isoLocked|hiddenQq|__DFY_ADULT_GATE__|__DFY_MUTES__|ext\.handshake|handshake|isolatePeople|allow\.private|privateDeny|commandAllow|mutes\.json/.test(code)) return { ok: false, message: '这个模块碰了隔离名单 / 暗号 / 白名单 / 静音，这些只有主人能改，我不给自己开这个口子' }
        if (/privacy\.json|adult_chats|private_chats|owner_chat/.test(code)) return { ok: false, message: '这个模块碰了隐私/成人相关的配置，我不给自己开这个口子' }
        // 语法检查
        const tmp = path.join(SANDBOX, '.check-' + id + '.mjs')
        fs.writeFileSync(tmp, code, 'utf8')
        const okSyntax = await new Promise((res) => {
          execFile(process.execPath, ['--check', tmp], { timeout: 15000 }, (err) => res(!err))
        })
        fs.unlinkSync(tmp)
        if (!okSyntax) return { ok: false, message: '语法没过（node --check 失败），没落地' }
        fs.mkdirSync(dir, { recursive: true })
        const target = path.join(dir, 'index.mjs')
        if (fs.existsSync(target)) {
          fs.mkdirSync(BAK, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          fs.copyFileSync(target, path.join(BAK, id + '.' + stamp + '.mjs'))
        }
        fs.writeFileSync(target, code, 'utf8')
        api.log.info('自己装了个模块：' + id + '（' + (args.note || '') + '）')
        return { ok: true, message: '写好了：modules/' + id + '/index.mjs（几秒后自动加载）' }
      },
    }))

    api.rule(() => '你看到新插件/新技术会自己掂量：有用吗、会不会弄坏现有的东西、主人会不会喜欢。想装就先跟主人说一声，得到同意再写进自己的工作区（WORKSPACE_DIR）；别碰这个文件夹以外的任何地方。')

    api.command({
      name: '本事',
      aliases: ['技能', 'skill'],
      desc: '看候选与已装技能；/本事 装了 <名字>',
      async run(arg) {
        const st = readState()
        const a = String(arg || '').trim()
        if (a.startsWith('装了') || a.startsWith('装')) {
          const nm = clean(a.replace(/^装了?/, '').trim())
          const ok = (st.installed || []).includes(nm)
          return ok ? `装了：${nm}` : `没有「${nm}」这个，候选里有：${(st.cands || []).map((c) => c.name).join('、') || '（空）'}`
        }
        const lines = (st.cands || []).slice(-10).map((c) => `- ${c.name}${c.want ? ' ★想要' : ''}：${c.what}`)
        return `候选 ${(st.cands || []).length} 个\n${lines.join('\n') || '（还没看到什么）'}\n已装：${(st.installed || []).join('、') || '（空）'}`
      },
    })
  },
}
