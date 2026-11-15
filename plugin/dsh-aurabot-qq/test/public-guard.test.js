import test from 'node:test'
import assert from 'node:assert/strict'
import { adultHit, checkPublic, checkAdultSync, assertPublic, wrapOnebotPublic, textOf, _setFetch } from '../src/security/public-guard.js'

const OWNER = '10000'
const cfg = (extra = {}) => ({ ownerQQ: OWNER, publicGuard: { enabled: true, failClosed: true, leakCheck: true }, ...extra })
const quiet = { warn() {}, info() {}, debug() {} }

test('公开守卫：18+ 词硬拦，「上床睡觉」不误伤', () => {
  assert.ok(adultHit('昨晚好湿'))
  assert.ok(adultHit('NSFW 内容'))
  assert.equal(adultHit('该上床睡觉了'), '')
  assert.equal(adultHit('今天吃了火锅'), '')
  assert.equal(checkAdultSync('呻吟').ok, false)
})

test('公开守卫：说说/签名先过 18+，再问大脑有没有私聊泄漏', async () => {
  let body = null
  _setFetch(async (url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ ok: true, blocked: true, hits: [{ memory_id: 1 }] }) } })
  try {
    const a = await checkPublic('她好湿', { getConfig: () => cfg() })
    assert.equal(a.reason, 'adult'); assert.equal(body, null) // 18+ 本地就拦，不出网
    const b = await checkPublic('老爹昨天跟我说的那个秘密', { getConfig: () => cfg(), target: 'qzone' })
    assert.equal(b.ok, false); assert.equal(b.reason, 'leak')
    assert.equal(body.chat_id, 'system')
    _setFetch(async () => ({ ok: true, json: async () => ({ ok: true, blocked: false }) }))
    assert.equal((await checkPublic('今天天气不错', { getConfig: () => cfg() })).ok, true)
  } finally { _setFetch(null) }
})

test('公开守卫：大脑连不上时 failClosed 不发，关掉 failClosed 才放行', async () => {
  _setFetch(async () => { throw new Error('down') })
  try {
    assert.equal((await checkPublic('普通的话', { getConfig: () => cfg() })).reason, 'unavailable')
    assert.equal((await checkPublic('普通的话', { getConfig: () => cfg({ publicGuard: { failClosed: false } }) })).ok, true)
    await assert.rejects(assertPublic('普通的话', { getConfig: () => cfg() }), (e) => e.code === 'PUBLIC_GUARD')
  } finally { _setFetch(null) }
})

test('公开守卫：OneBot 包装——群/别人私聊/说说拦 18+，主人私聊放行', async () => {
  _setFetch(async () => ({ ok: true, json: async () => ({ ok: true, blocked: false }) }))
  const calls = []
  const ob = { call: async (action, params) => { calls.push(action); return { ok: true } } }
  wrapOnebotPublic(ob, { getConfig: () => cfg(), log: quiet })
  try {
    await ob.call('send_private_msg', { user_id: OWNER, message: '想你想得好湿' })
    await assert.rejects(ob.call('send_private_msg', { user_id: '20000', message: '想你想得好湿' }))
    await assert.rejects(ob.call('send_group_msg', { group_id: 1, message: [{ type: 'text', data: { text: '呻吟' } }] }))
    await assert.rejects(ob.call('send_qzone_msg', { content: '今晚做爱' }))
    await assert.rejects(ob.call('set_self_longnick', { longNick: '小穴' }))
    await ob.call('send_group_msg', { group_id: 1, message: '大家晚上好' })
    await ob.call('send_qzone_msg', { content: '今天去公园了' })
    await ob.call('get_login_info', {})
    assert.deepEqual(calls, ['send_private_msg', 'send_group_msg', 'send_qzone_msg', 'get_login_info'])
    assert.equal(wrapOnebotPublic(ob), ob) // 不会包两层
  } finally { _setFetch(null) }
})

test('公开守卫：textOf 认 CQ 码 / 段数组 / 转发节点', () => {
  assert.equal(textOf('a[CQ:face,id=1]b').replace(/\s+/g, ''), 'ab')
  assert.equal(textOf([{ type: 'node', data: { content: [{ type: 'text', data: { text: 'x' } }] } }]).trim(), 'x')
})

test('展示面：面板列表默认藏 18+，日志/桌宠打码保留条数；主人开 adultReveal 才显示', async () => {
  const { hideAdultItems, maskAdultField, ADULT_MASK, adultRevealOn } = await import('../src/security/public-guard.js')
  const { DEFAULTS } = await import('../src/core/config.js')
  assert.equal(DEFAULTS.privacyView.adultReveal, false)
  const items = [{ id: 1, text: '今天吃了面' }, { id: 2, text: '昨晚好湿', tags: [] }, { id: 3, text: 'x', tags: ['NSFW'] }]
  assert.deepEqual(hideAdultItems(items, {}).map((i) => i.id), [1])
  assert.deepEqual(hideAdultItems(items, { privacyView: { adultReveal: true } }).map((i) => i.id), [1, 2, 3])
  const logs = maskAdultField([{ text: '发了：呻吟' }, { text: '连上了' }], 'text', {})
  assert.equal(logs.length, 2); assert.equal(logs[0].text, ADULT_MASK); assert.equal(logs[1].text, '连上了')
  assert.equal(adultRevealOn({ privacyView: { adultReveal: 'yes' } }), false) // 只认 true
})
