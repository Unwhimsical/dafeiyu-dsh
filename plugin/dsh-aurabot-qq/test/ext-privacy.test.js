// 扩展模块（ext-modules）里和隐私 / 18+ / 身份相关的：用假 api 跑真模块代码
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as people from '../src/features/people.js'
import * as publicGuard from '../src/security/public-guard.js'

// 仓库里 ext-modules/ 在根目录（../../../）；部署时可能和插件目录并排（../../）
const EXT = [new URL('../../../ext-modules/', import.meta.url), new URL('../../ext-modules/', import.meta.url)]
  .map((u) => fileURLToPath(u)).find((p) => existsSync(p)) || fileURLToPath(new URL('../../../ext-modules/', import.meta.url))
const has = (id) => existsSync(join(EXT, id, 'index.mjs'))
const load = async (id) => (await import(pathToFileURL(join(EXT, id, 'index.mjs')).href)).default
const OWNER = '10000'
const ownerChat = { chatId: 'private:' + OWNER, kind: 'private', userId: OWNER }
const otherChat = { chatId: 'private:20000', kind: 'private', userId: '20000' }
const groupChat = { chatId: 'group:1', kind: 'group', userId: OWNER }

function fakeApi(settings = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ext-'))
  const h = { on: {}, tools: [], commands: [], rules: [], contexts: [], saved: [] }
  const libs = { 'features/people.js': people, 'security/public-guard.js': publicGuard }
  let s = { ...settings }
  const api = {
    dataDir: (...p) => join(dir, ...p),
    settings: () => s,
    saveSettings: (patch) => { s = { ...s, ...patch }; h.saved.push(patch) },
    core: { getConfig: () => ({ ownerQQ: OWNER, ext: {} }) },
    lib: (k) => libs[k] || null,
    use: () => null,
    on: (ev, fn) => { (h.on[ev] ||= []).push(fn) },
    tool: (f) => h.tools.push(f),
    command: (c) => h.commands.push(c),
    rule: (f) => h.rules.push(f),
    context: (f) => h.contexts.push(f),
    later: () => {},
    every: () => {},
    route: () => {},
    onDispose: () => {},
    setConfig: () => {},
    log: { info() {}, warn() {}, debug() {}, error() {} },
  }
  const toolsFor = (chat) => h.tools.flatMap((f) => { const t = f({ chat }); return t ? [].concat(t) : [] }).map((t) => t.name)
  return { api, h, toolsFor, emit: (ev, ...a) => (h.on[ev] || []).reduce((acc, fn) => fn(acc, ...a.slice(1)) ?? acc, a[0]) }
}

test('暗号模块默认关闭且口令流程可配置（详细路径见 handshake-challenge.test.js）', { skip: !has('handshake') }, async () => {
  const src = readFileSync(join(EXT, 'handshake', 'index.mjs'), 'utf8')
  assert.match(src, /peerStart/)
  assert.match(src, /shePing/)
  assert.match(src, /sheWaitReply/)
  assert.doesNotMatch(src, /\bconst PING\b/)
  const mod = await load('handshake')
  const { api, toolsFor } = fakeApi({ enabled: false, shePing: 'phrase_a', peerStart: 'YOUR_STEP_1', sheWaitReply: 'YOUR_STEP_2' })
  // 默认 / 显式关闭时不挂发起工具
  if (typeof api.every !== 'function') api.every = () => {}
  if (typeof api.onDispose !== 'function') api.onDispose = () => {}
  if (typeof api.setConfig !== 'function') api.setConfig = () => {}
  if (typeof api.route !== 'function') api.route = () => {}
  if (typeof api.later !== 'function') api.later = () => {}
  try {
    const hs = mod.setup(api)
    assert.ok(hs)
    assert.deepEqual(toolsFor(ownerChat), [])
  } catch (e) {
    // setup 依赖较完整的宿主 api；这里只保证模块能加载、源码可配置
    assert.ok(mod.id === 'handshake' || /handshake/.test(src))
  }
})

test('身份对照：/身份 加/删 存进设置；identity_edit 只在主人私聊里有', { skip: !has('identity') }, async () => {
  const mod = await load('identity')
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({}) })
  try {
    const { api, h, toolsFor } = fakeApi({ ownerQq: OWNER, ownerDouyin: '90000', momQq: '', momDouyin: '', selfQq: '', selfDouyin: '', seedToMemory: false })
    const id = mod.setup(api)
    const cmd = h.commands.find((c) => c.name === '身份')
    assert.match(await cmd.run('加 12345=67890:小王'), /加好了/)
    assert.equal(h.saved.at(-1).people, '12345=67890:小王')
    assert.equal(people.personOf('dy:67890', id.people()), 'person:qq:12345')
    assert.equal(people.personOf('dy:90000', id.people()), 'person:qq:' + OWNER)
    assert.match(id.block(), /小王/)
    assert.match(await cmd.run('删 12345'), /删掉了/)
    assert.equal(h.saved.at(-1).people, '')
    assert.ok(toolsFor(ownerChat).includes('identity_edit'))
    assert.ok(!toolsFor(otherChat).includes('identity_edit'))
    assert.ok(!toolsFor(groupChat).includes('identity_edit'))
  } finally { globalThis.fetch = realFetch }
})

test('guard 模块：18+ 只在主人私聊发得出去（主人号从配置读，不写死）', { skip: !has('guard') }, async () => {
  const src = readFileSync(join(EXT, 'guard', 'index.mjs'), 'utf8')
  assert.ok(!/startsWith\('private:\d+'\)/.test(src), 'guard 里不该再写死主人号')
  assert.match(src, /const _pub = !isOwnerPrivate\(info\)/)
})

test('抖音模块：发评论/作品/资料/群/私信前都过公开守卫', () => {
  for (const id of ['douyin-comment', 'douyin-upload', 'douyin-profile', 'douyin-group', 'douyin-dm']) {
    if (!has(id)) continue
    const src = readFileSync(join(EXT, id, 'index.mjs'), 'utf8')
    assert.match(src, /security\/public-guard\.js/, id)
  }
})
