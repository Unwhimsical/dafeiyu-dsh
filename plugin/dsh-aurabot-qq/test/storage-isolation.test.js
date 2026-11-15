// 18+ / 隔离号的存放：聊天流水分开放；noDisk 时 18+ 交接笔记不落盘、窗口关掉就删那次的会话文件；
// 暗号模块不再自动改记忆隔离名单（只有主人能改，只在日志里提醒）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createHub } from '../src/chat/hub.js'
import { createCtxPlan } from '../src/chat/ctxplan.js'
import { normalize } from '../src/core/config.js'

const OWNER = '10000001'
const ISO = '30000003'
const PEER = '40000004'

function withGate(gate, fn) {
  const prev = globalThis.__DFY_ADULT_GATE__
  globalThis.__DFY_ADULT_GATE__ = gate
  try { return fn() } finally { if (prev === undefined) delete globalThis.__DFY_ADULT_GATE__; else globalThis.__DFY_ADULT_GATE__ = prev }
}
const gateOf = ({ unlocked = [], isolated = [] } = {}) => ({
  unlockedChat: (c) => unlocked.includes(c),
  isolated: () => [OWNER, ...isolated],                       // 暗号模块的隔离集合里本来就有主人
  isolatedPeers: () => isolated,
  isIsolatedChat: (c) => [OWNER, ...isolated].some((q) => c === 'private:' + q),
})

function setup(extra = {}) {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'aurabot-home-'))
  process.env.AURABOT_DATA_DIR = join(process.env.DSH_HOME, 'plugins-data', 'dafeiyu')
  mkdirSync(process.env.AURABOT_DATA_DIR, { recursive: true })
  const dir = process.env.AURABOT_DATA_DIR
  const archived = []
  const logs = []
  const log = { info: (m) => logs.push(String(m)), debug() {}, warn: (m) => logs.push(String(m)), error() {} }
  const cfg = normalize({ botQQ: '20000002', ownerQQ: OWNER, enabled: false, dryRun: true })
  Object.assign(cfg, extra)
  const dsh = { workspaceRegistry: { archiveSession: (id) => archived.push(id), archivedSessionIds: [] }, get: () => null }
  const hub = createHub({ dsh, getConfig: () => cfg, log, onebot: {}, stickers: {} })
  return { hub, dir, archived, logs, cfg }
}
const lines = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => readFileSync(join(d, f), 'utf8').split('\n').filter(Boolean)) : [])

test('隔离号的话不进普通流水，进单独目录；主人和普通人照常', () => {
  const s = setup()
  withGate(gateOf({ isolated: [ISO] }), () => {
    s.hub.logChat('private:' + OWNER, '主人', '主人的一句', OWNER)
    s.hub.logChat('private:' + PEER, '网友', '网友的一句', PEER)
    s.hub.logChat('private:' + ISO, '隔离号', '隔离号私聊', ISO)
    s.hub.logChat('private:' + ISO, 'bot', '回隔离号')
    s.hub.logChat('group:50000005', '隔离号', '隔离号在群里', ISO)
  })
  const normal = lines(join(s.dir, 'chatlog'))
  const iso = lines(join(s.dir, 'isolated-chats'))
  assert.equal(normal.length, 2)
  assert.ok(normal.every((l) => !l.includes('隔离号')))
  assert.equal(iso.length, 3)
})

test('isolatedStore.enabled=false：隔离号的话一个字都不落盘', () => {
  const s = setup({ isolatedStore: { enabled: false } })
  withGate(gateOf({ isolated: [ISO] }), () => s.hub.logChat('private:' + ISO, '隔离号', '不落盘', ISO))
  assert.equal(lines(join(s.dir, 'chatlog')).length, 0)
  assert.equal(lines(join(s.dir, 'isolated-chats')).length, 0)
})

test('18+ 窗口：流水进 18+ 目录；noDisk 时哪儿都不写', () => {
  const a = setup()
  withGate(gateOf({ unlocked: ['private:' + OWNER] }), () => a.hub.logChat('private:' + OWNER, '主人', '窗口里的一句', OWNER))
  assert.equal(lines(join(a.dir, 'chatlog')).length, 0)
  assert.equal(lines(join(a.dir, 'adult-chats')).length, 1)
  const b = setup({ adultStore: { noDisk: true } })
  withGate(gateOf({ unlocked: ['private:' + OWNER] }), () => b.hub.logChat('private:' + OWNER, '主人', '窗口里的一句', OWNER))
  assert.equal(lines(join(b.dir, 'chatlog')).length, 0)
  assert.equal(lines(join(b.dir, 'adult-chats')).length, 0)
})

test('noDisk：窗口关了就归档并删掉那次 18+ 会话的文件，别的会话不动', async () => {
  const s = setup({ adultStore: { noDisk: true } })
  const sdir = join(process.env.DSH_HOME, 'sessions', '--ws-adult--', 'session-aaaaaaaa-1111')
  const keep = join(process.env.DSH_HOME, 'sessions', '--ws-normal--', 'session-bbbbbbbb-2222')
  for (const d of [sdir, keep]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'session.v4.jsonl.zstd'), 'x') }
  const pc = join(process.env.DSH_HOME, 'storages', 'session_projcache', 'sessions')
  mkdirSync(pc, { recursive: true })
  writeFileSync(join(pc, 'session-aaaaaaaa-1111.json'), '{}')
  writeFileSync(join(pc, 'session-bbbbbbbb-2222.json'), '{}')
  writeFileSync(join(s.dir, 'sessions.json'), JSON.stringify({ chats: {
    ['adult:private:' + OWNER]: { sessionId: 'aaaaaaaa-1111', adult: true },
    ['private:' + OWNER]: { sessionId: 'bbbbbbbb-2222' },
  } }))
  // 窗口还开着：不动
  assert.equal(withGate(gateOf({ unlocked: ['private:' + OWNER] }), () => s.hub.purgeAdultSessions()), 0)
  assert.ok(existsSync(sdir))
  // 窗口关了：清掉
  assert.equal(withGate(gateOf(), () => s.hub.purgeAdultSessions()), 1)
  assert.deepEqual(s.archived, ['aaaaaaaa-1111'])
  const m = JSON.parse(readFileSync(join(s.dir, 'sessions.json'), 'utf8'))
  assert.equal(m.chats['adult:private:' + OWNER], undefined)
  assert.ok(m.chats['private:' + OWNER])
  await new Promise((r) => setTimeout(r, 3300))
  assert.equal(existsSync(sdir), false, '18+ 会话目录删掉了')
  assert.ok(existsSync(keep), '日常会话不动')
  assert.equal(existsSync(join(pc, 'session-aaaaaaaa-1111.json')), false, '侧栏投影缓存也删了')
  assert.ok(existsSync(join(pc, 'session-bbbbbbbb-2222.json')))
  s.hub.disposeRecentMedia()
})

test('noDisk 关着：巡检什么都不做', () => {
  const s = setup()
  writeFileSync(join(s.dir, 'sessions.json'), JSON.stringify({ chats: { ['adult:private:' + OWNER]: { sessionId: 'cccccccc-3333', adult: true } } }))
  assert.equal(withGate(gateOf(), () => s.hub.purgeAdultSessions()), 0)
  s.hub.disposeRecentMedia()
})

test('ctxplan：noDisk 时 18+ 交接笔记只在内存里；隔离号的最近原话从单独目录读', () => {
  const home = mkdtempSync(join(tmpdir(), 'aurabot-ctxp-'))
  const dataDir = (...p) => join(home, ...p)
  const isoDir = dataDir('isolated-chats')
  mkdirSync(isoDir, { recursive: true })
  const day = new Date(); const d = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
  writeFileSync(join(isoDir, d + '.jsonl'), JSON.stringify({ t: Date.now(), chatId: 'private:' + ISO, who: 'x', text: '隔离号最近说的' }) + '\n')
  const cfg = { ownerQQ: OWNER, contextPlan: {} }
  let noDisk = true
  withGate(gateOf({ unlocked: ['private:' + OWNER], isolated: [ISO] }), () => {
    const cp = createCtxPlan({ dsh: {}, getConfig: () => cfg, log: { info() {}, warn() {}, debug() {} }, dataDir, adultNoDisk: () => noDisk,
      chatlogDirFor: (c) => (c === 'private:' + ISO ? isoDir : dataDir('chatlog')) })
    const rec = cp._writeNote('private:' + OWNER, 'switch', 'test')
    assert.equal(rec.adult, true)
    assert.equal(existsSync(dataDir('ctxplan', 'notes')) ? readdirSync(dataDir('ctxplan', 'notes')).length : 0, 0, '18+ 笔记没写盘')
    assert.equal(cp._readNote('private:' + OWNER).adult, true, '内存里还读得到')
    noDisk = false
    const r2 = cp._writeNote('private:' + ISO, 'switch', 'test')
    assert.ok(JSON.stringify(r2.note).includes('隔离号最近说的'), '隔离号笔记带上了自己的最近原话')
  })
})

test('暗号模块：同步名单时不改 ext.memcore.isolatePeople，只在日志里提醒（打码）', async () => {
  const HS = fileURLToPath(new URL('../../../ext-modules/handshake/index.mjs', import.meta.url))
  const mod = (await import(pathToFileURL(HS).href)).default
  const dataHome = mkdtempSync(join(tmpdir(), 'aurabot-hs-'))
  let core = { ownerQQ: OWNER, allow: { private: [] }, ext: { memcore: { isolatePeople: '' } } }
  const setCalls = []
  const logs = []
  const settings = { enabled: true, extraQq: PEER, isolateQq: ISO }
  const api = new Proxy({
    settings: () => settings,
    core: { getConfig: () => core },
    dataDir: (...p) => join(dataHome, ...p),
    log: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), debug() {} },
    setConfig: (fn) => { const next = fn(core); setCalls.push(next); core = next },
    saveSettings: (o) => Object.assign(settings, o),
    later: (_ms, fn) => fn(),
    every: () => {},
    on: () => {},
    onDispose: () => {},
  }, { get: (t, k) => (k in t ? t[k] : () => undefined) })
  mod.setup(api)
  assert.equal(core.ext.memcore.isolatePeople, '', '记忆隔离名单没被自动改')
  assert.ok(setCalls.every((c) => (c.ext?.memcore?.isolatePeople ?? '') === ''))
  const hint = logs.find((m) => /还没写进记忆隔离名单/.test(m))
  assert.ok(hint, '日志里提醒了主人')
  assert.ok(!hint.includes(ISO) && !hint.includes(PEER), '提醒里号码打码')
  delete globalThis.__DFY_ADULT_GATE__
})
