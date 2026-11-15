import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSelfmodAudit, pathsOf } from '../src/security/selfmod.js'

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'selfmod-'))
  const dataDir = (...p) => join(base, 'data', ...p)
  const pluginRoot = join(base, 'plugin')
  mkdirSync(join(pluginRoot, 'src'), { recursive: true })
  mkdirSync(dataDir('modules', 'memcore'), { recursive: true })
  mkdirSync(dataDir('modules', 'fun'), { recursive: true })
  mkdirSync(dataDir('playground', 'toy'), { recursive: true })
  const mems = []
  const audit = createSelfmodAudit({ dataDir, pluginRoot, userDir: () => dataDir('modules'), playDir: () => dataDir('playground'), log: { info() {}, warn() {}, debug() {} }, remember: (m) => mems.push(m) })
  return { base, dataDir, pluginRoot, audit, mems }
}

test('自改审计：pathsOf 认得常见写文件工具参数', () => {
  assert.deepEqual(pathsOf({ arguments: { path: 'a.js' } }), ['a.js'])
  assert.deepEqual(pathsOf({ arguments: { file_path: 'b.js', edits: [{ path: 'c.js' }] } }), ['b.js', 'c.js'])
  assert.deepEqual(pathsOf({ arguments: { patch: '*** Update File: d.js\n@@' } }), ['d.js'])
})

test('自改审计：分区 core / module / playground / 不管', () => {
  const { audit, dataDir, pluginRoot, base } = setup()
  assert.equal(audit.zoneOf(join(pluginRoot, 'src', 'host.js')), 'core')
  assert.equal(audit.zoneOf(dataDir('modules', 'memcore', 'index.mjs')), 'core')
  assert.equal(audit.zoneOf(dataDir('modules', 'fun', 'index.mjs')), 'module')
  assert.equal(audit.zoneOf(dataDir('playground', 'toy', 'index.mjs')), 'playground')
  assert.equal(audit.zoneOf(join(base, 'elsewhere.txt')), '')
})

test('自改审计：改核心文件前拍快照、改后记日志和记忆，可按快照还原', async () => {
  const { audit, pluginRoot, mems } = setup()
  const file = join(pluginRoot, 'src', 'host.js')
  writeFileSync(file, 'old\n')
  const r = await audit.preExecute({ name: 'write', arguments: { path: file, content: 'new\n', reason: '试试' } }, async () => { writeFileSync(file, 'new\n'); return 'ok' })
  assert.equal(r, 'ok')
  const lines = readFileSync(audit.logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 1)
  assert.equal(lines[0].zone, 'core'); assert.equal(lines[0].changed, true); assert.equal(lines[0].reason, '试试')
  assert.ok(existsSync(lines[0].backup)); assert.equal(readFileSync(lines[0].backup, 'utf8'), 'old\n')
  assert.equal(mems.length, 1); assert.ok(mems[0].tags.includes('自改'))
})

test('自改审计：不相干的工具和路径原样放行、不写日志', async () => {
  const { audit, base } = setup()
  const r = await audit.preExecute({ name: 'pwsh', arguments: { command: 'dir' } }, async () => 1)
  const r2 = await audit.preExecute({ name: 'write', arguments: { path: join(base, 'x.txt') } }, async () => 2)
  assert.equal(r, 1); assert.equal(r2, 2)
  assert.equal(existsSync(audit.logFile()), false)
})

test('自改审计：游乐场模块第一次启动记一条玩具记忆，只记一次', () => {
  const { audit, mems } = setup()
  assert.equal(audit.onModuleStart('toy', { description: '会转圈' }), true)
  assert.equal(audit.onModuleStart('toy'), false)
  assert.equal(audit.onModuleStart('not-play'), false)
  assert.equal(mems.length, 1); assert.ok(mems[0].tags.includes('玩具'))
})
test('自改审计：selfdev 的 mod_write（直接 fs 写模块）也拍快照、记 note 当理由', async () => {
  const { audit, dataDir } = setup()
  const file = dataDir('modules', 'memcore', 'index.mjs')
  writeFileSync(file, 'v1\n')
  await audit.preExecute({ name: 'mod_write', arguments: { id: 'MemCore', code: 'v2\n', note: '想让记忆更快' } }, async () => { writeFileSync(file, 'v2\n'); return { ok: true } })
  const e = JSON.parse(readFileSync(audit.logFile(), 'utf8').trim())
  assert.equal(e.zone, 'core'); assert.equal(e.reason, '想让记忆更快'); assert.equal(readFileSync(e.backup, 'utf8'), 'v1\n')
})