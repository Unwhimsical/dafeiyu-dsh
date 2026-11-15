// 好友请求守卫（friend-guard）
//
// 为什么需要：SnowLuma 把「好友申请」上送成一条**普通私聊**（文本＝「请求添加你为好友」），
// 不是 OneBot 标准的 post_type:'request' / request_type:'friend'，所以内置 contacts 模块
// 第 107 行 `if (ev.post_type !== 'request') return` 永远进不去。结果是：
//   · 她以为对方已经加好了，正常开聊，甚至文字里「演」了一句「（点了通过）」；
//   · 随后大量 `send_private_msg failed: result=16 发送失败，请先添加对方为好友`。
//
// 本模块只补「自动触发 + 别让她演」这一段，判断与接口调用复用现有 contacts 链路：
//   · api.on('message') 返回 true = 接管这条系统私聊，不进聊天中枢（API.md「事件」节）
//   · 主人说「通过 <QQ>」/「拒绝 <QQ>」时，contacts 已有的 qq_handle_friend_request 工具
//     会自己调 get_doubt_friends_add_request 找 uid 并分派 set_doubt_friends_add_request
//   · 默认档位最保守：只记录 + 通知主人，不自动通过、不调任何 set_* 接口（dryRun）
//
// 开关在 behaviour.json → friends.*，改完保存即生效，不用重启 DSH。

import fs from 'node:fs'
import path from 'node:path'

const REQ = /请求添加你为好友|请求加你为好友|申请添加你为好友|想添加你为好友/
const SPAM = /(加微|加v|vx|v信|微信号|威信|兼职|刷单|返利|贷款|网贷|博彩|彩票|赌|代理|招聘|日结|赚钱|理财|投资|股票|裸聊|约炮|色情|成人|福利|看片|收徒|引流|推广|客服|退款)/i

export default {
  id: 'friend-guard',
  name: '好友请求守卫',
  version: '1.0.0',
  api: 1,
  tab: 'chat',
  description: '识别被当成普通私聊上送的 QQ 好友申请：记下来、告诉主人、别让她「演」通过；默认只通知不自动加。',

  setup(api) {
    // behaviour.json 在插件数据根目录，模块自己的 dataDir 在 modules-data/<id>/
    const behaviour = () => {
      try {
        const b = JSON.parse(fs.readFileSync(api.dataDir('..', '..', 'behaviour.json'), 'utf8'))
        return b.friends || {}
      } catch { return {} }
    }
    const conf = () => { try { return api.core.getConfig() || {} } catch { return {} } }
    const logFile = () => api.dataDir('requests.jsonl')
    const record = (o) => {
      try {
        const p = logFile()
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...o }) + '\n')
      } catch (e) { api.log?.warn?.('好友请求记档失败：' + e.message) }
    }
    const doubtList = async () => {
      try {
        const r = await api.onebot('get_doubt_friends_add_request', { count: 20 })
        if (Array.isArray(r)) return r
        if (Array.isArray(r?.data)) return r.data
        return []
      } catch (e) {
        api.log?.warn?.('读「可能认识的人」失败：' + e.message)
        return []
      }
    }
    // 只有 autoApprove + selfJudge 且退出 dryRun 后才走；默认三者都不满足
    const selfJudge = async (qq, nick, reason) => {
      if (SPAM.test(reason || '')) return { decide: 'no', why: '验证消息像广告' }
      const hub = api.core?.hub
      if (!hub || typeof hub.runSystemTurn !== 'function') return { decide: 'ask', why: '判断通道没接上' }
      try {
        const out = String(await hub.runSystemTurn(
          'friend-judge', '好友申请',
          `有个陌生人想加你 QQ 好友。昵称：「${nick || '（没取到）'}」，验证消息：「${reason || '（没写）'}」。按你自己的性子判断要不要加：看着正常、友善、像真人想认识你就加；像营销号、诈骗、骚扰就不加。只回一行：「通过：理由」或「拒绝：理由」，理由不超过 15 个字。`,
          { noTools: true, timeoutMs: 60000 },
        ) || '')
        const line = out.replace(/\s+/g, ' ').trim().slice(0, 80)
        if (/^\W*(通过|同意|加)/.test(line)) return { decide: 'yes', why: line.replace(/^\W*(通过|同意|加)[:：]?\s*/, '') || '她觉得可以' }
        if (/(拒绝|不加|不通过)/.test(line)) return { decide: 'no', why: line.replace(/^.*?(拒绝|不加|不通过)[:：]?\s*/, '') || '她不想加' }
        return { decide: 'ask', why: '她没拿定主意' }
      } catch (e) { return { decide: 'ask', why: '没想好：' + e.message } }
    }

    const recent = new Map() // 同一 QQ 30 分钟内只通知一次，但仍吞掉系统私聊

    api.on('message', async (msg) => {
      const f = behaviour()
      if (!f.enabled) return false
      if (!msg || msg.kind !== 'private') return false
      const text = String(msg.text || '')
      if (!REQ.test(text)) return false
      const qq = String(msg.userId || msg.raw?.user_id || '')
      if (!qq) return false
      try { if (api.isOwner?.(qq)) return false } catch {}

      const swallow = f.swallowSystemMsg !== false
      const now = Date.now()
      if (now - (recent.get(qq) || 0) < 30 * 60_000) return swallow
      recent.set(qq, now)

      const list = await doubtList()
      const hit = list.find((x) => String(x.user_id) === qq) || (list.length === 1 ? list[0] : null)
      const nick = String(hit?.nick || msg.nickname || '').slice(0, 30)
      const reason = String(hit?.reason || '').slice(0, 80)
      const uid = hit?.uid ? String(hit.uid) : ''
      const dryRun = f.dryRun !== false

      let action = 'notify'
      if (f.autoApprove && f.selfJudge && !dryRun && uid) {
        const j = await selfJudge(qq, nick, reason)
        if (j.decide !== 'ask') {
          try {
            await api.onebot('set_doubt_friends_add_request', { flag: uid, approve: j.decide === 'yes' })
            action = j.decide === 'yes' ? 'approved' : 'rejected'
            api.log.info(`好友申请 ${qq}：她自己${action === 'approved' ? '通过' : '拒绝'}了（${j.why}）`)
          } catch (e) { api.log.warn(`好友申请 ${qq} 处理失败：${e.message}`) }
        }
      }

      record({ qq, nick, reason, source: hit?.source || '', uid, found: !!hit, listCount: list.length, dryRun, action, text: text.slice(0, 120) })

      const owner = String(conf().ownerQQ || '')
      if (f.notifyOwner !== false && owner) {
        const head = `有人想加我好友：QQ ${qq}${nick ? `（${nick}）` : ''}${reason ? `，验证：「${reason}」` : ''}。`
        const mid = action === 'approved' ? '我自己加了。' : action === 'rejected' ? '我没加。' : '我先记着，没自动加。'
        const tail = uid
          ? `你说「通过 ${qq}」或「拒绝 ${qq}」我就办。`
          : '接口没捞到这条申请（可能被 QQ 客户端收进「新朋友」了），可能得你手动点一下。'
        try { await api.sendText(`private:${owner}`, head + mid + tail) } catch (e) { api.log?.warn?.('好友请求通知主人失败：' + e.message) }
      }
      return swallow
    })

    // 标准 request/friend 事件仍由内置 contacts 处理，本模块不碰，避免重复
    api.log.info('好友请求守卫已挂上：默认只记录 + 通知，不自动通过')
  },
}
