// 自学模块：私聊 / 关于某人的记忆、18+ 内容不会被提炼进公开知识
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as publicGuard from '../src/security/public-guard.js'

// 仓库里 ext-modules/ 在根目录（../../../）；部署时可能和插件目录并排（../../）
const EXT = [new URL('../../../ext-modules/', import.meta.url), new URL('../../ext-modules/', import.meta.url)]
  .map((u) => fileURLToPath(u)).find((p) => existsSync(p)) || fileURLToPath(new URL('../../../ext-modules/', import.meta.url))
const FILE = join(EXT, 'learn', 'index.mjs')

test('learn：私聊 / 18+ 不进公开知识；工具 learn_note 也拦', { skip: !existsSync(FILE) }, async () => {
  const mod = (await import(pathToFileURL(FILE).href)).default
  const dir = mkdtempSync(join(tmpdir(), 'ext-learn-'))
  const later = []; const tools = []; const thinks = []
  const items = [
    { id: 'a', text: '老爹私聊里说他明天去医院复查', source: 'auto', chatId: 'private:10000', at: 3 },
    { id: 'b', text: '关于姐姐的一件事情很重要', source: 'auto', chatId: 'group:1', about: '20000', at: 2 },
    { id: 'c', text: '昨晚那段 18+ 对话（测试样例）', source: 'auto', chatId: 'group:1', at: 1 },
  ]
  const api = {
    dataDir: (...p) => join(dir, ...p), settings: () => ({ enabled: true, memoryUrl: 'http://x', memoryToken: 't' }), saveSettings() {},
    core: { getConfig: () => ({ ext: {} }) }, lib: (k) => (k === 'security/public-guard.js' ? publicGuard : null),
    use: (id) => (id === 'memory' ? { list: () => items } : null), log: { info() {}, warn() {} },
    think: async (p) => { thinks.push(p); return '一句知识' }, every() {}, later: (ms, fn) => later.push(fn), tool: (fn) => tools.push(fn), rule() {}, route() {}, onDispose() {},
  }
  const posts = []
  const orig = globalThis.fetch
  globalThis.fetch = async (u, o) => { posts.push(String(u)); return { ok: true, status: 200, json: async () => ({ ok: true, id: 1 }) } }
  try {
    mod.setup(api)
    for (const fn of later) await fn()
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(thinks.length, 0, '一条都不该拿去提炼')
    assert.ok(!posts.some((u) => u.endsWith('/remember')))
    const note = tools.map((f) => f({ chat: {} })).find((t) => t && t.name === 'learn_note')
    const r = await note.execute({ fact: 'nsfw 测试样例' })
    assert.equal(r.ok, false)
  } finally { globalThis.fetch = orig }
})
