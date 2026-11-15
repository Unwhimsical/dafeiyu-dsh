import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { selfEditAllowed, profileToolVisible, profilePermits, SELF_EDIT_KEYS } from '../src/chat/access.js'
import { createSelfmodAudit } from '../src/security/selfmod.js'
import { DEFAULTS } from '../src/core/config.js'

const owner = { kind: 'private', userId: '10000', chatId: 'private:10000' }

test('自改开关：默认开（和原来行为一样），三个开关都有默认值', () => {
  assert.equal(DEFAULTS.selfAdjust.enabled, true)
  assert.equal(DEFAULTS.selfEditPersona.enabled, true)
  assert.equal(DEFAULTS.publicGuard.enabled, true)
  assert.equal(selfEditAllowed({}), true)
})

test('自改开关：selfEditPersona 关了 → 改昵称/签名/头像工具不挂、调用也拒（主人私聊也一样）', () => {
  const cfg = { ownerQQ: '10000', selfEditPersona: { enabled: false } }
  for (const k of SELF_EDIT_KEYS) {
    assert.equal(profileToolVisible(cfg, k, owner), false)
    assert.equal(profilePermits(cfg, k, owner, true).ok, false)
  }
})

function setup(cfg) {
  const base = mkdtempSync(join(tmpdir(), 'selfedit-'))
  const dataDir = (...p) => join(base, 'data', ...p)
  mkdirSync(dataDir('personas'), { recursive: true })
  const pluginRoot = join(base, 'plugin'); mkdirSync(join(pluginRoot, 'src'), { recursive: true })
  const audit = createSelfmodAudit({ dataDir, pluginRoot, getConfig: () => cfg, log: { info() {}, warn() {}, debug() {} } })
  return { dataDir, audit }
}

test('自改开关：关着时她写人设卡 / config.json 被拦（审计关着也拦），并留一条拒绝日志', async () => {
  const cfg = { selfEditPersona: { enabled: false }, selfmod: { enabled: false } }
  const { dataDir, audit } = setup(cfg)
  let ran = false
  const r = await audit.preExecute({ name: 'write', arguments: { path: dataDir('personas', 'a.md'), content: 'x' } }, async () => { ran = true })
  assert.equal(r.kind, 'deny'); assert.equal(ran, false)
  const r2 = await audit.preExecute({ name: 'edit', arguments: { path: dataDir('config.json') } }, async () => { ran = true })
  assert.equal(r2.kind, 'deny')
  const log = readFileSync(audit.logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.ok(log.every((e) => e.denied))
  // 不相干的文件照常
  assert.equal(await audit.preExecute({ name: 'write', arguments: { path: dataDir('other.txt') } }, async () => 7), 7)
})

test('自改开关：情绪自调关着时她不能自己在 config.json 里打开（审计开/关都会还原）', async () => {
  for (const selfmod of [{ enabled: true }, { enabled: false }]) {
    const cfg = { selfEditPersona: { enabled: true }, selfmod }
    const { dataDir, audit } = setup(cfg)
    const file = dataDir('config.json')
    const before = JSON.stringify({ selfAdjust: { enabled: false }, x: 1 })
    writeFileSync(file, before)
    await audit.preExecute({ name: 'write', arguments: { path: file } }, async () => writeFileSync(file, JSON.stringify({ selfAdjust: { enabled: true }, x: 2 })))
    assert.equal(readFileSync(file, 'utf8'), before, JSON.stringify(selfmod))
    // 别的设置照常能改
    await audit.preExecute({ name: 'write', arguments: { path: file } }, async () => writeFileSync(file, JSON.stringify({ selfAdjust: { enabled: false }, x: 3 })))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).x, 3)
  }
})
