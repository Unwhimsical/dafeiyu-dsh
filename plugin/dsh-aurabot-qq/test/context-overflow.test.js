// 上下文压缩 / 超长：压缩后交接再带一次；超长失败时换新会话（归档不删），不崩、不失忆
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHub } from '../src/chat/hub.js'
import { normalize } from '../src/core/config.js'

const OWNER = '10000001'
const CHAT = 'private:' + OWNER
function setup() {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-ctx-'))
  const dir = process.env.AURABOT_DATA_DIR
  writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ chats: { [CHAT]: { sessionId: 'S1', preset: 'x', level: 'chat', createdAt: 1 } } }))
  const archived = []
  const logs = []
  const log = { info: (m) => logs.push(m), debug() {}, warn: (m) => logs.push(m), error() {} }
  const cfg = normalize({ botQQ: '20000002', ownerQQ: OWNER, enabled: false, dryRun: true })
  const dsh = { workspaceRegistry: { archiveSession: (id) => archived.push(id), archivedSessionIds: [] }, get: () => null }
  const hub = createHub({ dsh, getConfig: () => cfg, log, onebot: {}, stickers: {} })
  return { hub, dir, archived, logs }
}

test('压缩：compactionsOf 计数（重启后也认得会话），不重开会话', () => {
  const s = setup()
  assert.equal(s.hub.compactionsOf('S1'), 0)
  s.hub.onSessionEvent({ id: 'S1' }, { type: 'compaction/end', data: {} })
  s.hub.onSessionEvent({ id: 'session-S1' }, { type: 'compaction/end', data: {} })
  assert.equal(s.hub.compactionsOf('S1'), 2)
  assert.equal(s.archived.length, 0)
  assert.ok(JSON.parse(readFileSync(join(s.dir, 'sessions.json'), 'utf8')).chats[CHAT], '会话还在')
})

test('超长失败：归档旧会话、下一条开新会话；10 分钟内只重开一次；别的失败不动', () => {
  const s = setup()
  s.hub.onSessionEvent({ id: 'S1' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'failed', error: { message: 'network reset' } } } })
  assert.equal(s.archived.length, 0, '普通失败不重开')
  s.hub.onSessionEvent({ id: 'S1' }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'failed', error: { message: "This model's maximum context length is 131072 tokens" } } } })
  assert.deepEqual(s.archived, ['S1'], '旧会话归档（不删）')
  assert.equal(JSON.parse(readFileSync(join(s.dir, 'sessions.json'), 'utf8')).chats[CHAT], undefined, '下一条开新会话')
  assert.ok(s.logs.some((m) => /上下文超长/.test(m)))
})
