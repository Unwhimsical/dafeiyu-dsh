// 指令权限：除主人外，还有哪些 QQ 能用命令（/xxx、#sl…）。
// 名单写进核心配置 commandAllow，hub 收消息时据此判断；不在名单里的人发命令会被静默忽略（不回、不进上下文、不透露状态）。
const DEFAULTS = { qq: '' }
const parseQqList = (v) => [...new Set(String(v || '').split(/[\s,，;；、]+/).map((s) => s.trim()).filter((s) => /^\d{5,12}$/.test(s)))]

export default {
  id: 'cmdperm',
  name: '指令权限',
  version: '1.0.0',
  api: 1,
  tab: 'access',
  description: '默认只有主人能用命令（/闭嘴、/状态、#sl 等）；这里加的 QQ 也能用（改主人记忆、总开关、换模型、发日记和模块命令仍只给主人）。其他人发命令会被静默忽略。',
  defaults: DEFAULTS,
  settings: [
    { key: 'qq', label: '额外能用命令的 QQ（每行一个；主人不用填）', type: 'textarea', placeholder: '每行一个 QQ 号；删掉那一行 = 移除。也可以私聊发 /指令权限 加 QQ号' },
  ],

  setup(api) {
    const coreCfg = () => { try { return api.core.getConfig() || {} } catch { return {} } }
    const ownerQQ = () => String(coreCfg().ownerQQ || '')
    const list = () => parseQqList((api.settings() || {}).qq).filter((q) => q !== ownerQQ())
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

    function sync() {
      const want = list()
      const cur = (Array.isArray(coreCfg().commandAllow) ? coreCfg().commandAllow : []).map(String)
      if (same(want, cur)) return
      api.setConfig((c) => ({ ...c, commandAllow: want }))
      api.log.info(`指令权限名单已同步：${want.length} 个额外账号`)
    }

    api.command({
      name: '指令权限',
      aliases: ['cmdperm'],
      desc: '谁能用命令：/指令权限 加 QQ | /指令权限 删 QQ | /指令权限 列表（只有主人能改）',
      run: async (arg, msg) => {
        const [op, q] = String(arg || '').trim().split(/\s+/)
        const edit = (fn) => { api.saveSettings({ qq: fn(list()).join('\n') }); sync() }
        if (op === '加' || op === 'add') {
          if (!/^\d{5,12}$/.test(q || '')) return '用法：/指令权限 加 QQ号'
          if (q === ownerQQ()) return '主人本来就能用'
          edit((l) => [...new Set([...l, q])])
          return `已加 ${q}：它能用命令了（改记忆、总开关、换模型、日记、模块命令除外）`
        }
        if (op === '删' || op === 'del' || op === 'rm') {
          if (!q) return '用法：/指令权限 删 QQ号'
          const had = list().includes(q)
          edit((l) => l.filter((x) => x !== q))
          return had ? `已移除 ${q}` : `${q} 本来就不在名单里`
        }
        const l = list()
        return `能用命令的：主人 ${ownerQQ() || '（没设）'}` + (l.length ? '\n' + l.map((x) => `额外 ${x}`).join('\n') : '\n（没有额外账号）') + '\n其他人发的命令会被静默忽略'
      },
    })

    sync()
    api.every(10_000, sync, '指令权限名单同步')
    api.log.info(`指令权限就绪：主人 + 额外 ${list().length} 个账号`)
  },
}
