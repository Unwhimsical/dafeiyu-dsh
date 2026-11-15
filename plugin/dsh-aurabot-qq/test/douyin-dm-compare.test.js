import test from 'node:test'
import assert from 'node:assert/strict'
import { dmEqual, dmComparable } from '../src/douyin/site.js'
import { dyTake, dyDrop, dyLockedByOther } from '../src/douyin/duty.js'

test('私信核对：编辑器改写过的同一句算对上', () => {
  assert.ok(dmEqual('好呀，马上去', '好呀,马上去'))                 // 全角/半角逗号
  assert.ok(dmEqual('他说“行”…', '他说"行"...'))                    // 中文引号、省略号
  assert.ok(dmEqual('哈哈哈', '哈哈哈[捂脸]'))                       // 表情码被换成 <img>，innerText 里没有
  assert.ok(dmEqual('哈哈哈[捂脸]', '哈哈哈[捂脸]'))                 // 读到了 img alt
  assert.ok(dmEqual('好\u200b的\ufe0f', '好的'))                     // 零宽字符、emoji 变体
  assert.ok(dmEqual('晚安 🌙', '晚安'))                              // emoji
  assert.ok(dmEqual('真的吗！！', '真的吗!!'))
  assert.ok(dmEqual('ok啦~', 'OK啦～'))
})

test('私信核对：少字、多字、串话不算对上', () => {
  assert.equal(dmEqual('好呀', '好呀马上去'), false)                 // 只打进去半句
  assert.equal(dmEqual('好呀马上去吧', '好呀马上去'), false)
  assert.equal(dmEqual('老爹你好好呀马上去', '好呀马上去'), false)   // 串进了别的会话的字
  assert.equal(dmEqual('', '好呀'), false)
  assert.equal(dmComparable('[捂脸]'), '')
})

test('抖音私信页锁：别人拿着时其他模块让路，放下后恢复', () => {
  dyTake('builtin')
  assert.equal(dyLockedByOther('builtin'), false)
  assert.equal(dyLockedByOther('douyin-dm'), true)
  dyDrop('douyin-dm') // 不是自己的锁，放不掉
  assert.equal(dyLockedByOther('douyin-dm'), true)
  dyDrop('builtin')
  assert.equal(dyLockedByOther('douyin-dm'), false)
  globalThis.__aurabotDyChat = { holder: 'douyin-group', until: Date.now() - 1 } // 过期的锁不算
  assert.equal(dyLockedByOther('builtin'), false)
})
