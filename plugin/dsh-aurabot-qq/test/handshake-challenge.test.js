// 18+ 口令流程必须由配置驱动：源码里不写死开口句 / 应答句。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HS = fileURLToPath(new URL('../../../ext-modules/handshake/index.mjs', import.meta.url))

test('handshake 模块存在，便于本仓库测试定位', () => {
  assert.ok(existsSync(HS), '找不到 ext-modules/handshake/index.mjs')
})

test('源码不再写死口令流程（无 PING / isZaiMa 等旧标识，无示例占位以外的固定开口句）', () => {
  const src = readFileSync(HS, 'utf8')
  assert.doesNotMatch(src, /\bconst PING\b/)
  assert.doesNotMatch(src, /\bisZaiMa\b/)
  assert.doesNotMatch(src, /\bisBuZai\b/)
  assert.doesNotMatch(src, /\bisBuXiang\b/)
  assert.match(src, /peerStart/)
  assert.match(src, /shePing/)
  assert.match(src, /sheWaitReply/)
  // 默认必须关闭，且默认开口句为空（占位只出现在 example，不出现在 DEFAULTS）
  assert.match(src, /enabled:\s*false/)
  assert.match(src, /peerStart:\s*''/)
  assert.match(src, /shePing:\s*''/)
  assert.match(src, /sheWaitReply:\s*''/)
})

test('配置驱动的两条路径；空配置不触发', async () => {
  const mod = await import(pathToFileURL(HS).href)
  const rec = mod.hashSecret('24680')
  const make = (challenge) => {
    const st = { chats: {}, everUnlocked: [] }
    return { st, m: mod.createMachine({
      getState: () => st,
      save() {},
      allowed: () => true,
      ttlMs: () => 40 * 60 * 1000,
      verify: (s) => mod.verifySecret(s, rec),
      owner: () => '10000',
      challenge,
    }) }
  }

  const empty = make({ peerStart: '', shePing: '', sheWaitReply: '' })
  assert.equal(empty.m.inbound('10000', 'YOUR_STEP_1').event, '')
  assert.equal(empty.m.outbound('10000', 'phrase_a'), '')
  assert.equal(empty.m.unlocked('10000'), false)

  const peer = make({ peerStart: 'YOUR_STEP_1', shePing: 'phrase_a', sheWaitReply: 'YOUR_STEP_2' })
  assert.equal(peer.m.inbound('10000', 'YOUR_STEP_1').event, 'o-zaima')
  assert.equal(peer.m.outbound('10000', '随便回一句'), 'o-replied')
  const unlocked = peer.m.inbound('10000', '24680')
  assert.equal(unlocked.event, 'unlock')
  assert.equal(unlocked.text, '【暗号】')
  assert.equal(peer.m.unlocked('10000'), true)

  const she = make({ peerStart: 'YOUR_STEP_1', shePing: 'phrase_a', sheWaitReply: 'YOUR_STEP_2' })
  assert.equal(she.m.outbound('10000', 'phrase_a'), 's-zaima')
  assert.equal(she.m.inbound('10000', 'YOUR_STEP_2').event, 's-buzai')
  assert.equal(she.m.outbound('10000', 'phrase_a'), 's-replied')
  assert.equal(she.m.inbound('10000', '24680').event, 'unlock')
  assert.equal(she.m.unlocked('10000'), true)

  const deviate = make({ peerStart: 'YOUR_STEP_1', shePing: 'phrase_a', sheWaitReply: 'YOUR_STEP_2' })
  deviate.m.outbound('10000', 'phrase_a')
  assert.equal(deviate.m.inbound('10000', '不对的一句').event, 's-deviate')
  assert.equal(deviate.m.unlocked('10000'), false)
})

test('同义句按逗号分隔；规范化后匹配', async () => {
  const mod = await import(pathToFileURL(HS).href)
  assert.deepEqual(mod.parsePhrases('YOUR_STEP_1, YOUR_STEP_1B'), ['YOUR_STEP_1', 'YOUR_STEP_1B'])
  assert.equal(mod.matchesPhrase('YOUR_STEP_1。', 'YOUR_STEP_1, YOUR_STEP_1B'), true)
  assert.equal(mod.matchesPhrase('nope', 'YOUR_STEP_1'), false)
  assert.equal(mod.matchesPhrase('anything', ''), false)
})
