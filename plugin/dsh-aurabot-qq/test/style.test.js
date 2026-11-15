import test from 'node:test'
import assert from 'node:assert/strict'
import { styleFromEmotion, smoothStyle, blendEffects, createStyle, NEUTRAL, scaleRate } from '../src/features/style.js'
import { capBubbles, setBubbleCap, bubbleCap } from '../src/chat/reply.js'

test('情绪风格：平静 = 中性，发 3 条左右', () => {
  const s = styleFromEmotion({})
  assert.equal(s.bubbles, 3)
  assert.ok(Math.abs(s.chatty - 1) < 0.15 && Math.abs(s.delay - 1) < 0.15)
})

test('情绪风格：开心话多、生气话少，全部夹在范围里', () => {
  const happy = styleFromEmotion({ 开心: 95, 满足: 80 })
  const angry = styleFromEmotion({ 生气: 95 })
  assert.ok(happy.bubbles > angry.bubbles)
  assert.ok(happy.chatty > angry.chatty)
  for (const felt of [{ 开心: 100, 失控: 100 }, { 生气: 100, 黑化: 100, 被冷落: 100 }, { 开心: -50, 生气: 999 }]) {
    const s = styleFromEmotion(felt, { minBubbles: 1, maxBubbles: 4 })
    assert.ok(s.bubbles >= 1 && s.bubbles <= 4, JSON.stringify(s))
    assert.ok(s.chatty >= 0.4 && s.chatty <= 1.6)
    assert.ok(s.delay >= 0.7 && s.delay <= 1.6)
    assert.ok(s.length >= 0.6 && s.length <= 1.3)
  }
  assert.match(angry.tone, /生气/)
})

test('情绪风格：情欲不参与（18+ 维度不影响公开说话方式）', () => {
  assert.deepEqual(styleFromEmotion({ 情欲: 100 }), styleFromEmotion({}))
})

test('情绪风格：平滑后不会一下子跳满', () => {
  const calm = styleFromEmotion({})
  const wild = styleFromEmotion({ 开心: 100, 失控: 100 }, { maxBubbles: 8 })
  const step = smoothStyle(calm, wild)
  assert.ok(step.chatty < wild.chatty && step.chatty > calm.chatty)
  assert.ok(step.bubbles <= calm.bubbles + Math.ceil((wild.bubbles - calm.bubbles) / 2))
})

test('情绪风格：和用户原来的心情倍数相乘，不覆盖', () => {
  const base = { sticker: 1.2, voice: 0.8, delay: 1.5, chatty: 1.2 }
  const b = blendEffects(base, { ...NEUTRAL, delay: 1.2, chatty: 1.5, bubbles: 9 })
  assert.equal(b.sticker, 1.2); assert.equal(b.voice, 0.8)
  assert.equal(b.delay, 1.8) // 1.5*1.2 夹到 1.8
  assert.equal(b.chatty, 1.8)
  assert.equal(b.bubbles, 6) // 夹到 maxBubbles（默认 6）
  assert.deepEqual(blendEffects(base, null), { ...base, bubbles: 3, freq: 1 }) // 第 1 项加了群聊频率倍数 freq，中性 = 1
})

test('情绪风格：开关关掉就是中性，开着从大脑 /style 拉', async () => {
  let cfg = { selfAdjust: { enabled: true, minBubbles: 1, maxBubbles: 4 } }
  let url = ''
  const st = createStyle({ getConfig: () => cfg, fetchImpl: async (u) => { url = u; return { json: async () => ({ ok: true, felt: { 生气: 100 } }) } } })
  await st.refresh()
  assert.match(url, /\/style$/)
  assert.ok(st.bubbleCap() <= 3)
  assert.match(st.hint(), /生气/)
  cfg = { selfAdjust: { enabled: false } }
  assert.equal(st.bubbleCap(), 3)
  assert.equal(st.hint(), '')
  assert.equal(st.current(), null)
  assert.equal(await st.refresh(), null)
})

test('气泡上限：reply.capBubbles 跟着情绪走，坏值退回 6', () => {
  setBubbleCap(() => 1)
  const items = ['a', 'b', 'c'].map((value) => ({ kind: 'text', value }))
  const one = capBubbles(items)
  assert.equal(one.length, 1)
  assert.equal(one[0].value, 'a\nb\nc') // 多的并进去，不丢字
  setBubbleCap(() => 4)
  assert.equal(capBubbles(items).length, 3)
  setBubbleCap(() => 'x')
  assert.equal(bubbleCap(), 6) // 坏值退回防失控上限 MAX_BUBBLES = 6
  setBubbleCap(null)
  assert.equal(bubbleCap(), 6)
})

test('scaleRate：手动设成 1 的插话概率不会被压到 0.8；普通值仍封顶 0.8', () => {
  assert.equal(scaleRate({ interjectChance: 1 }, 1).interjectChance, 1)
  assert.equal(scaleRate({ interjectChance: 1 }, 2).interjectChance, 1)
  assert.equal(scaleRate({ interjectChance: 0.5 }, 2).interjectChance, 0.8)
  assert.equal(scaleRate({ interjectChance: 0.2 }, 0.5).interjectChance, 0.1)
})
