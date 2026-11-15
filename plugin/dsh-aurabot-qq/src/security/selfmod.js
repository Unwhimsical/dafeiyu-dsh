// 自改审计：大肥鱼保留用 DSH 的 write / edit 工具改插件和模块的权限（自学、自己长本事），
// 但每次动手前先把原文件拍快照、改完记一行日志，出事能一键回滚（tools/selfmod-rollback.ps1）。
//
// - 不拦截、不改参数：只在 tools/pre-execute 里旁路记录；记录本身出错也照常放行
// - 快照：plugins-data/dafeiyu/selfmod/backups/<编号>/<相对路径>
// - 日志：plugins-data/dafeiyu/selfmod/selfmod.log.jsonl（一行一次：文件、时间、工具、区域、理由、改动摘要、快照位置）
// - 区域：core = 核心（人设、memcore、guard、hub、QQ/抖音主线、隐私……）；module = 正式扩展模块；playground = 游乐场
// - 只能看见 write/edit 这类「按路径写文件」的工具；她用 pwsh/bash 命令直接改文件这里看不到（见 验收清单）
import { existsSync, mkdirSync, copyFileSync, appendFileSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { createHash } from 'node:crypto'

export const WRITE_TOOLS = /^(write|edit|multi_?edit|str_replace(_based_edit_tool|_editor)?|apply_patch|create_file|write_file|edit_file|replace_in_file)$/i
/** selfdev 模块的 mod_write：直接用 fs 写 modules/<id>/index.mjs，也要留痕 */
export const MOD_WRITE = /(^|[_.:-])mod_write$/i
export const modIdOf = (id) => String(id || '').toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32)
const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'target_file', 'filename']
/** 核心扩展模块：动这些要格外留痕（还是放行，只是日志里标 core、日志级别更高） */
export const CORE_MODULES = ['memcore', 'guard', 'identity', 'douyin-dm', 'douyin-group', 'douyin-api', 'mention-watch', 'privacy', 'hub']
/** 插件自身里不算核心的（面板皮肤之类），其它全按核心算 */
const PLUGIN_SOFT = [/^client[\\/]/i, /^docs[\\/]/i, /^test[\\/]/i]

const low = (p) => (process.platform === 'win32' ? p.toLowerCase() : p)
const inside = (p, root) => { if (!root) return false; const r = relative(low(resolve(root)), low(resolve(p))); return r === '' || (!r.startsWith('..') && !isAbsolute(r)) }

/** 从一次工具调用里挑出要写的文件路径 */
export function pathsOf(exec) {
  const a = (exec && exec.arguments) || {}
  const out = []
  for (const k of PATH_KEYS) if (typeof a[k] === 'string' && a[k].trim()) out.push(a[k].trim())
  if (Array.isArray(a.edits)) for (const e of a.edits) for (const k of PATH_KEYS) if (e && typeof e[k] === 'string' && e[k].trim()) out.push(e[k].trim())
  for (const key of ['patch', 'input']) if (typeof a[key] === 'string') for (const m of a[key].matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) out.push(m[1].trim())
  return [...new Set(out)]
}

const sha = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 12)
const readMaybe = (p) => { try { return readFileSync(p) } catch { return null } }
const stampNow = () => { const d = new Date(); const z = (n, w = 2) => String(n).padStart(w, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}-${z(d.getMilliseconds(), 3)}-${Math.random().toString(36).slice(2, 6)}` }

export function createSelfmodAudit({ dataDir, pluginRoot, userDir, playDir, extraCore = [], getConfig = () => ({}), log = console, remember = null, cwdOf = () => process.cwd() }) {
  const root = () => dataDir('selfmod')
  const logFile = () => join(root(), 'selfmod.log.jsonl')
  const opts = () => (getConfig() && getConfig().selfmod) || {}

  /** 这个文件属于哪一块：core / module / playground；不归我们管返回 '' */
  function zoneOf(file) {
    const f = resolve(file)
    if (playDir && inside(f, playDir())) return 'playground'
    if (userDir && inside(f, userDir())) {
      const id = relative(resolve(userDir()), f).split(/[\\/]/)[0]
      return CORE_MODULES.includes(id) || /^(API\.md|aurabot\.d\.ts)$/i.test(id) ? 'core' : 'module'
    }
    if (pluginRoot && inside(f, pluginRoot)) {
      const rel = relative(resolve(pluginRoot), f)
      return PLUGIN_SOFT.some((r) => r.test(rel)) ? 'module' : 'core'
    }
    for (const p of [...extraCore, ...(opts().coreDirs || [])]) if (p && inside(f, p)) return 'core'
    if (inside(f, dataDir('personas')) || low(resolve(f)) === low(resolve(dataDir('config.json')))) return 'core'
    return ''
  }

  function append(entry) {
    mkdirSync(root(), { recursive: true })
    appendFileSync(logFile(), JSON.stringify(entry) + '\n')
  }

  function summaryOf(exec, before, after) {
    const a = (exec && exec.arguments) || {}
    const lines = (b) => (b ? b.toString('utf8').split('\n').length : 0)
    const s = { linesBefore: lines(before), linesAfter: lines(after), bytesBefore: before ? before.length : 0, bytesAfter: after ? after.length : 0 }
    const pick = (x) => (typeof x === 'string' ? x.replace(/\s+/g, ' ').slice(0, 80) : undefined)
    if (a.old_string !== undefined || a.oldString !== undefined) { s.removed = pick(a.old_string ?? a.oldString); s.added = pick(a.new_string ?? a.newString) }
    return s
  }

  /** 人设 / 平台设置文件：人格卡目录、插件 config.json、selfmod.personaPaths 里额外列的（比如 DSH 宿主人设）。 */
  function isPersonaFile(file) {
    const f = resolve(file)
    if (inside(f, dataDir('personas'))) return true
    if (low(f) === low(resolve(dataDir('config.json')))) return true
    for (const p of opts().personaPaths || []) if (p && inside(f, p)) return true
    return false
  }
  const selfEditOff = () => ((getConfig && getConfig()) || {}).selfEditPersona?.enabled === false
  const switchOff = (buf, key) => { try { return JSON.parse(buf.toString('utf8'))?.[key]?.enabled === false } catch { return false } }

  async function preExecute(exec, next) {
    // 主人开关 selfEditPersona.enabled=false：她不能动人设 / 设置文件（审计关着也拦，这是权限不是留痕）
    if (selfEditOff()) {
      try {
        const tool = String((exec && exec.name) || '')
        if (WRITE_TOOLS.test(tool)) {
          const base = cwdOf(exec)
          const hit = pathsOf(exec).map((raw) => (isAbsolute(raw) ? raw : resolve(base || '.', raw))).find(isPersonaFile)
          if (hit) {
            try { append({ id: stampNow(), at: new Date().toISOString(), tool, zone: 'core', file: resolve(hit), denied: 'selfEditPersona.enabled=false', ok: false, changed: false }) } catch {}
            log.warn?.(`自改审计：主人关了「自己改人设」，拦下 ${tool} ${hit}`)
            return { kind: 'deny', reason: '主人把「我自己改人设 / 设置」的开关关了（主人发 /改人设 开 才能改）。' }
          }
        }
      } catch (error) { try { log.warn?.('自改审计：检查人设开关出错（按拦下处理）：', error.message) } catch {} ; return { kind: 'deny', reason: '人设开关检查出错，先不改' } }
    }
    if (opts().enabled === false) {
      // 审计关着也要守住主人的开关：config.json 被改时，关着的开关不许被她自己打开
      let cfgFile = '', before = null
      try {
        if (WRITE_TOOLS.test(String((exec && exec.name) || ''))) {
          const base = cwdOf(exec)
          cfgFile = pathsOf(exec).map((raw) => (isAbsolute(raw) ? raw : resolve(base || '.', raw))).find((f) => low(resolve(f)) === low(resolve(dataDir('config.json')))) || ''
          if (cfgFile && existsSync(cfgFile)) before = readMaybe(cfgFile)
        }
      } catch {}
      const out = await next(exec)
      if (before) {
        try {
          const after = readMaybe(cfgFile)
          const flipped = ['selfAdjust', 'selfEditPersona'].filter((k) => switchOff(before, k) && after && !switchOff(after, k))
          if (flipped.length) { writeFileSync(cfgFile, before); log.warn?.(`自改审计：主人关着的开关不能自己打开（${flipped.join('、')}），已还原 config.json`) }
        } catch {}
      }
      return out
    }
    let pending = []
    try {
      const tool = String((exec && exec.name) || '')
      const modWrite = MOD_WRITE.test(tool) && userDir && modIdOf(exec?.arguments?.id)
      if (WRITE_TOOLS.test(tool) || modWrite) {
        const base = cwdOf(exec)
        const targets = modWrite ? [join(userDir(), modIdOf(exec.arguments.id), 'index.mjs')] : pathsOf(exec)
        for (const raw of targets) {
          const file = isAbsolute(raw) ? raw : resolve(base || '.', raw)
          const zone = zoneOf(file)
          if (!zone) continue
          const id = stampNow()
          const before = existsSync(file) && statSync(file).isFile() ? readMaybe(file) : null
          let backup = ''
          if (before) {
            const rel = (resolve(file).replace(/^([A-Za-z]):/, '$1')).split(/[\\/]+/).filter(Boolean).join(sep)
            backup = join(root(), 'backups', id, rel)
            mkdirSync(join(backup, '..'), { recursive: true })
            copyFileSync(file, backup)
          }
          const a = (exec && exec.arguments) || {}
          pending.push({ id, file: resolve(file), zone, tool, before, backup, reason: String(a.reason || a.note || a.description || a.explanation || a.summary || '').slice(0, 300), session: exec?.agent?.session?.id || '' })
        }
      }
    } catch (error) { try { log.warn?.('自改审计：拍快照失败（照常放行）：', error.message) } catch {} }

    if (!pending.length) return next(exec)
    let result, failed = null
    try { result = await next(exec) } catch (error) { failed = error }
    for (const p of pending) {
      try {
        const after = readMaybe(p.file)
        const entry = {
          id: p.id, at: new Date().toISOString(), tool: p.tool, zone: p.zone, file: p.file,
          existed: Boolean(p.before), backup: p.backup, shaBefore: p.before ? sha(p.before) : '', shaAfter: after ? sha(after) : '',
          changed: (p.before ? sha(p.before) : '') !== (after ? sha(after) : ''), ok: !failed, reason: p.reason, session: p.session,
          summary: summaryOf(exec, p.before, after),
        }
        // 主人关着的开关（情绪自调 / 自己改人设）她不能自己在 config.json 里打开：打开了就还原
        if (entry.changed && p.before && after && low(p.file) === low(resolve(dataDir('config.json')))) {
          const flipped = ['selfAdjust', 'selfEditPersona'].filter((k) => switchOff(p.before, k) && !switchOff(after, k))
          if (flipped.length) {
            writeFileSync(p.file, p.before)
            entry.reverted = `主人关着的开关不能自己打开：${flipped.join('、')}`
            log.warn?.(`自改审计：${entry.reverted}，已还原 config.json`)
          }
        }
        append(entry)
        if (entry.changed) {
          const msg = `自改审计：${p.zone === 'core' ? '【核心】' : ''}${p.tool} ${p.file}（快照 ${p.id}）`
          if (p.zone === 'core') log.warn?.(msg); else log.info?.(msg)
          if (remember && opts().remember !== false) remember({ text: `我自己改了${p.zone === 'core' ? '核心文件' : p.zone === 'playground' ? '游乐场里的' : '模块'} ${p.file.split(/[\\/]/).slice(-2).join('/')}` + (p.reason ? `，因为：${p.reason}` : '') + `（可回滚：${p.id}）`, kind: 'self', tags: ['自改', p.zone] })
        }
      } catch (error) { try { log.warn?.('自改审计：写日志失败：', error.message) } catch {} }
    }
    if (failed) throw failed
    return result
  }

  /** 游乐场模块第一次跑起来：记成一条「学会/装了个小玩具」的记忆，星海里能看到 */
  function onModuleStart(id, info = {}) {
    try {
      if (!playDir || !existsSync(join(playDir(), String(id)))) return false
      const f = join(root(), 'toys.json')
      let toys = {}
      try { toys = JSON.parse(readFileSync(f, 'utf8')) } catch {}
      if (toys[id]) return false
      toys[id] = { at: new Date().toISOString(), name: info.name || id }
      mkdirSync(root(), { recursive: true })
      writeFileSync(f, JSON.stringify(toys, null, 2))
      if (remember) remember({ text: `我自己做了个小玩具模块「${info.name || id}」` + (info.description ? `：${String(info.description).slice(0, 120)}` : '') + '，装在游乐场里', kind: 'self', tags: ['技能', '玩具', 'playground'] })
      return true
    } catch { return false }
  }

  return { preExecute, zoneOf, onModuleStart, logFile }
}

/** 默认的记忆写入：直接打本机 v2 /remember（本机免钥匙）；chat = system（公开，星海可见） */
export function v2Remember(getConfig, log) {
  return ({ text, kind = 'self', tags = [] }) => {
    const c = (getConfig() && getConfig().selfmod) || {}
    const url = String(c.memoryUrl || 'http://127.0.0.1:8780').replace(/\/+$/, '') + '/remember'
    const headers = { 'content-type': 'application/json' }
    if (c.memoryToken) headers.authorization = 'Bearer ' + c.memoryToken
    fetch(url, { method: 'POST', headers, body: JSON.stringify({ text, kind, tags, chat_id: 'system', scope: 'public', importance: 0.45, source: 'selfmod' }), signal: AbortSignal.timeout(5000) })
      .catch((e) => { try { log.debug?.('自改审计：记忆没写上：', e.message) } catch {} })
  }
}
