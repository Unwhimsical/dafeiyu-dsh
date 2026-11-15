import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePeople, upsertPeople, removePeople, parsePeopleCommand, allPeople, personOf, v2ChatOf, personKey } from '../src/features/people.js'

const cfg = {
  ownerQQ: '10000',
  ext: {
    identity: { ownerQq: '10000', ownerDouyin: '90000', momQq: '10001', momDouyin: '90001', people: '12345=67890:小王\n33333:老李' },
    memcore: { isolatePeople: '44444=55555' },
  },
}

test('身份对照：people 文本格式解析 / 增删', () => {
  assert.deepEqual(parsePeople('12345=67890:小王；33333:老李\n# x\n乱写'), [{ qq: '12345', dy: '67890', wechat: '', name: '小王' }, { qq: '33333', dy: '', wechat: '', name: '老李' }])
  let t = upsertPeople('', { qq: '12345', dy: '67890', name: '小王' })
  t = upsertPeople(t, { qq: '12345', name: '王哥' })
  assert.equal(t, '12345=67890:王哥')
  assert.equal(removePeople(t + '\n22222:x', '12345'), '22222:x')
  assert.throws(() => upsertPeople('', { qq: 'abc' }))
})

test('身份对照：/身份 命令解析', () => {
  assert.deepEqual(parsePeopleCommand(''), { op: 'list' })
  assert.deepEqual(parsePeopleCommand('加 12345=67890:小王'), { op: 'add', person: { qq: '12345', dy: '67890', wechat: '', name: '小王' } })
  assert.deepEqual(parsePeopleCommand('删 12345'), { op: 'remove', qq: '12345' })
  assert.equal(parsePeopleCommand('加 不是号').op, 'bad')
})

test('身份对照：所有平台的号归到同一个人 person:qq:<QQ>', () => {
  const list = allPeople(cfg)
  assert.equal(list.length, 5)
  assert.equal(personOf('dy:90000', list), personKey('10000'))
  assert.equal(personOf('private:10000', list), 'person:qq:10000')
  assert.equal(personOf('dy:67890', list), 'person:qq:12345')
  assert.equal(personOf('dy:55555', list), 'person:qq:44444')
  assert.equal(personOf('group:1', list), '')
  // 大脑会话号：抖音和 QQ 落在同一格（共享记忆）；陌生抖音号照旧
  assert.equal(v2ChatOf('dy:90001', list), 'p:10001')
  assert.equal(v2ChatOf('private:10001', list), 'p:10001')
  assert.equal(v2ChatOf('dy:77777', list), 'p:77777')
  assert.equal(v2ChatOf('group:42', list), 'g:42')
})
