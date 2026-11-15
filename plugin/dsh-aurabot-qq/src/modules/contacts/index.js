// 内置模块：好友申请与白名单。
//  · qq_handle_friend_request：通过 / 拒绝别人加她为好友的申请（SnowLuma：set_friend_add_request；被 QQ 过滤的「可能认识的人」走 set_doubt_friends_add_request）。
//  · qq_whitelist：听主人的话把 QQ 号 / 群号加进、移出白名单（allow.private / allow.groups），写进配置并保存。
//  · qq_handle_group_invite：通过 / 拒绝别人拉她进群的邀请（SnowLuma：set_group_add_request，sub_type=invite 或 add）；通过后自动把群加进白名单。
// 「她主动加别人为好友」没做：SnowLuma（v2.2.0）没有这个接口，维护者明确说公开版不会加（SnowLuma#480）。
// 两个工具各一档权限（面板「权限」页）：off 关 / owner 仅主人私聊（默认）/ all 所有人。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { defineTool, str, bool } from '../../tools/tools.js'
import { profileToolVisible, profilePermits } from '../../chat/access.js'

const PENDING_MAX = 50
const ID_RE = /^\d{5,12}$/

/** 取纯数字号码；不像 QQ 号 / 群号的返回空串。 */
export function cleanId(v) {
  const s = String(v ?? '').replace(/\D/g, '')
  return ID_RE.test(s) ? s : ''
}

/** 白名单增删的纯逻辑：返回 { ok, message, next? }。next = 改完后的这张表（没变化时不给）。 */
export function planWhitelist(cfg, { action, kind, id }) {
  const act = String(action || '').trim().toLowerCase()
  if (!['add', 'remove'].includes(act)) return { ok: false, message: 'action 只能是 add 或 remove' }
  const k = String(kind || '').trim().toLowerCase()
  if (!['private', 'group'].includes(k)) return { ok: false, message: 'kind 只能是 private（私聊的人）或 group（群）' }
  const n = cleanId(id)
  if (!n) return { ok: false, message: '号码不对：要 5~12 位数字的 QQ 号 / 群号' }
  const label = k === 'private' ? 'QQ' : '群'
  const listName = k === 'private' ? '私聊白名单' : '群白名单'
  if (k === 'private' && n === String(cfg.ownerQQ || '')) {
    return act === 'remove'
      ? { ok: false, message: '主人不能被移出私聊白名单' }
      : { ok: true, message: '主人本来就能私聊，不用加白名单' }
  }
  if (k === 'private' && act === 'add' && n === String(cfg.botQQ || '')) return { ok: false, message: '这是我自己的号，不用加' }
  const list = (k === 'private' ? cfg.allow?.private : cfg.allow?.groups) || []
  const has = list.map(String).includes(n)
  if (act === 'add') {
    if (has) return { ok: true, message: `${label} ${n} 已经在${listName}里了` }
    return { ok: true, changed: true, message: `${label} ${n} 加进${listName}了`, next: [...list.map(String), n] }
  }
  if (!has) return { ok: true, message: `${label} ${n} 本来就不在${listName}里` }
  return { ok: true, changed: true, message: `${label} ${n} 从${listName}移出了`, next: list.map(String).filter((x) => x !== n) }
}

export default {
  id: 'contacts',
  name: '好友申请与白名单',
  version: '1.0.0',
  description: '听话通过 / 拒绝别人加她为好友的申请（qq_handle_friend_request）、改私聊 / 群白名单（qq_whitelist）；权限在「权限」页',
  setup(api) {
    const { hub, onebot } = api.core
    const pendingFile = () => api.dataDir('friend-requests.json')

    const loadPending = () => {
      try {
        const f = pendingFile()
        if (!existsSync(f)) return []
        const j = JSON.parse(readFileSync(f, 'utf8'))
        return Array.isArray(j) ? j.filter((x) => x && x.flag && x.userId) : []
      } catch (error) { return [] }
    }
    const savePending = (list) => {
      try { writeFileSync(pendingFile(), JSON.stringify(list.slice(-PENDING_MAX))) } catch (error) { api.log.warn('存好友申请出错：', error.message) }
    }

    // 好友申请：她自己判断，不是主人把关、也不是来者不拒。
    //   · 主人设的只隔离号（主人小号）→ 直接通过
    //   · 验证消息像广告 / 诈骗 / 色情 → 拒绝
    //   · 和她在同一个白名单群 → 通过
    //   · 其余：问她自己（后台一轮，不带工具）愿不愿意加
    //   · 每天最多自动通过 contacts.friendDailyMax（默认 8）个，超了留着等主人
    //   结果给主人私聊报一句；flag 必须原样用，不能自己拼。
    const SPAM = /(加微|加v|vx|v信|微信号|威信|兼职|刷单|返利|贷款|网贷|博彩|彩票|赌|代理|招聘|日结|赚钱|理财|投资|股票|裸聊|约炮|色情|成人|福利|看片|收徒|引流|推广|客服|退款)/i
    const dayKey = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    const statFile = () => api.dataDir('friend-auto.json')
    const loadStat = () => { try { const j = JSON.parse(readFileSync(statFile(), 'utf8')); return j && j.day === dayKey() ? j : { day: dayKey(), accepted: 0 } } catch { return { day: dayKey(), accepted: 0 } } }
    const saveStat = (s) => { try { writeFileSync(statFile(), JSON.stringify(s)) } catch {} }
    const isHiddenAlt = (qq) => { try { return (globalThis.__DFY_ADULT_GATE__?.hiddenQq?.() || []).includes(String(qq)) } catch { return false } }
    async function sharedGroup(qq) {
      for (const g of (api.config().allow?.groups || []).map(String)) {
        try { const m = await onebot.call('get_group_member_info', { group_id: Number(g), user_id: Number(qq), no_cache: true }, { timeoutMs: 8000 }); if (m && (m.user_id || m.nickname)) return g } catch {}
      }
      return ''
    }
    async function judgeFriend(req) {
      const cfg = api.config()
      const ct = cfg.contacts || {}
      if (ct.friendAuto === false) return { decide: 'ask', why: '自动判断关着' }
      if (isHiddenAlt(req.userId)) return { decide: 'yes', why: '隔离名单', alt: true }
      if (String(req.userId) === String(cfg.ownerQQ || '')) return { decide: 'yes', why: '主人' }
      if (SPAM.test(req.comment || '')) return { decide: 'no', why: '验证消息像广告 / 诈骗' }
      const g = await sharedGroup(req.userId)
      if (g) return { decide: 'yes', why: '是同群的人' }
      let nick = ''
      try { const info = await onebot.call('get_stranger_info', { user_id: Number(req.userId) }, { timeoutMs: 8000 }); nick = String(info?.nickname || '').slice(0, 30) } catch {}
      try {
        const out = String(await hub.runSystemTurn('friend-judge', '好友申请', `有个陌生人想加你 QQ 好友。昵称：「${nick || '（没取到）'}」，验证消息：「${req.comment || '（没写）'}」。你们不在同一个群。按你自己的性子判断要不要加：看着正常、友善、像真人想认识你就加；像营销号、诈骗、骚扰、色情就不加。只回一行：「通过：理由」或「拒绝：理由」，理由不超过 15 个字。`, { noTools: true, timeoutMs: 90000 }) || '')
        const line = out.replace(/\s+/g, ' ').trim().slice(0, 60)
        if (/^\W*(通过|同意|加)/.test(line)) return { decide: 'yes', why: line.replace(/^\W*(通过|同意|加)[:：]?\s*/, '') || '她觉得可以' }
        if (/(拒绝|不加|不通过)/.test(line)) return { decide: 'no', why: line.replace(/^.*?(拒绝|不加|不通过)[:：]?\s*/, '') || '她不想加' }
        return { decide: 'ask', why: '她没拿定主意' }
      } catch (error) { return { decide: 'ask', why: '想了半天没想好（' + error.message + '）' } }
    }
    api.on('onebot', async (ev) => {
      if (!ev || ev.post_type !== 'request' || ev.request_type !== 'friend' || !ev.flag) return
      const userId = String(ev.user_id || '')
      if (!userId) return
      const list = loadPending()
      const isNew = !list.some((x) => x.flag === String(ev.flag))
      if (!isNew) return
      const req = { flag: String(ev.flag), userId, comment: String(ev.comment || '').slice(0, 80), at: Date.now() }
      list.push(req)
      savePending(list)
      const cfg = api.config()
      const tell = (t) => { if (cfg.ownerQQ) api.sendText(`private:${cfg.ownerQQ}`, t).catch(() => {}) }
      let j = await judgeFriend(req)
      const stat = loadStat()
      const max = Math.max(0, Number(cfg.contacts?.friendDailyMax ?? 8))
      if (j.decide === 'yes' && !j.alt && stat.accepted >= max) j = { decide: 'ask', why: `今天已经自己通过 ${stat.accepted} 个了（上限 ${max}）` }
      if ((j.decide === 'yes' || j.decide === 'no') && !cfg.dryRun) {
        try {
          await onebot.call('set_friend_add_request', { flag: req.flag, approve: j.decide === 'yes' }, { timeoutMs: 15000 })
          savePending(loadPending().filter((x) => x.flag !== req.flag))
          if (j.decide === 'yes' && !j.alt) { stat.accepted++; saveStat(stat) }
          const shownId = j.alt ? (userId.slice(0, 2) + '***' + userId.slice(-2)) : userId
          api.log.info(`好友申请 ${shownId}：她自己${j.decide === 'yes' ? '通过' : '拒绝'}了（${j.why}）`)
          // 隔离号通过后不在主人私聊里以她的口吻报（那句会进她的上下文 = 她知道有这个号）；只记打码日志
          if (j.alt) return
          tell(`有人加我好友（QQ ${userId}${req.comment ? '，验证：「' + req.comment + '」' : ''}），我${j.decide === 'yes' ? '加了' : '没加'}：${j.why}`)
          return
        } catch (error) {
          api.log.warn(`好友申请 ${userId} 处理失败：${error.message}`)
          j = { decide: 'ask', why: '处理失败：' + error.message }
        }
      }
      if ((cfg.profilePerms?.qqFriendRequest || 'owner') !== 'off') {
        tell(`有人想加我好友：QQ ${userId}${req.comment ? `，验证消息：「${req.comment}」` : ''}。${j.why}，你说「通过 ${userId}」或「拒绝 ${userId}」。`)
      }
    })

    // 群邀请 / 被拉进群：记下 flag（必须原样回传），并问主人一句
    const inviteFile = () => api.dataDir('group-invites.json')
    const loadInvites = () => {
      try {
        const f = inviteFile()
        if (!existsSync(f)) return []
        const j = JSON.parse(readFileSync(f, 'utf8'))
        return Array.isArray(j) ? j.filter((x) => x && x.flag) : []
      } catch (error) { return [] }
    }
    const saveInvites = (list) => {
      try { writeFileSync(inviteFile(), JSON.stringify(list.slice(-20))) } catch (error) { api.log.warn('存群邀请出错：', error.message) }
    }

    // 把群加进白名单（用保存那一刻最新的配置再算一遍）。返回 'added' | 'already' | 'fail'
    const whitelistGroup = (gid) => {
      const c = api.config()
      const plan = planWhitelist(c, { action: 'add', kind: 'group', id: gid })
      if (!plan.ok) return 'fail'
      if (!plan.changed) return 'already'
      api.setConfig((cur) => {
        const again = planWhitelist(cur, { action: 'add', kind: 'group', id: gid })
        if (!again.ok || !again.changed) return cur
        return { ...cur, allow: { ...cur.allow, groups: again.next } }
      })
      return 'added'
    }
    const ownerId = () => String(api.config().ownerQQ || '')   // 主人号从配置读，不写死

    api.on('onebot', async (ev) => {
      if (!ev || ev.post_type !== 'request' || ev.request_type !== 'group' || !ev.flag) return
      const gid = String(ev.group_id || '')
      const sub = String(ev.sub_type || 'invite')
      const inviter = String(ev.user_id || '')
      const fromOwner = sub === 'invite' && !!ownerId() && inviter === ownerId()
      const list = loadInvites()
      const isNew = !list.some((x) => x.flag === String(ev.flag))
      if (isNew) {
        list.push({ flag: String(ev.flag), groupId: gid, subType: sub, inviter, fromOwner, comment: String(ev.comment || '').slice(0, 80), at: Date.now() })
        saveInvites(list)
      }
      api.log.info(`收到群邀请：群 ${gid} sub=${sub} 邀请人 ${inviter || '?'}${fromOwner ? '（主人）' : ''}${isNew ? '' : '（重复事件）'}，已记到 group-invites.json`)
      const cfg = api.config()
      if (!isNew) return
      // 主人拉的：直接通过 + 加白名单，不用再问
      if (fromOwner) {
        if (cfg.dryRun) { api.log.info(`试运行：本来要自动通过主人拉的群 ${gid}`); return }
        try {
          await onebot.call('set_group_add_request', { flag: String(ev.flag), sub_type: sub, approve: true }, { timeoutMs: 15000 })
          const wl = whitelistGroup(gid)
          // 记录留到进群事件（group_increase）来了再删；先标记已通过
          saveInvites(loadInvites().map((x) => (x.flag === String(ev.flag) ? { ...x, approvedAt: Date.now() } : x)))
          api.log.info(`主人拉我进群 ${gid}：已自动通过邀请，白名单${wl === 'added' ? '已加上' : wl === 'already' ? '本来就有' : '没加上'}`)
        } catch (error) {
          api.log.warn(`主人拉我进群 ${gid}：自动通过失败：${error.message}（邀请记录留着，主人可以让我用 qq_handle_group_invite 再试）`)
          if (cfg.ownerQQ) api.sendText(`private:${cfg.ownerQQ}`, `你拉我进群 ${gid}，我自动通过没成功（${String(error.message).slice(0, 60)}），可以再拉我一次试试。`).catch(() => {})
        }
        return
      }
      if (cfg.ownerQQ) {
        const who = inviter ? `（邀请人 QQ ${inviter}）` : ''
        api.sendText(`private:${cfg.ownerQQ}`, `有人拉我进群 ${gid}${who}，要我进吗？你说「进群 ${gid}」我就通过。`).catch(() => {})
      }
    })

    // 她自己进了群（group_increase，user_id 是她自己）：主人拉的、或者和主人那条待处理邀请对得上，就加白名单
    api.on('onebot', (ev) => {
      if (!ev || ev.post_type !== 'notice' || ev.notice_type !== 'group_increase') return
      const self = String(ev.self_id || api.config().botQQ || '')
      if (!self || String(ev.user_id || '') !== self) return
      const gid = String(ev.group_id || '')
      if (!gid) return
      const owner = ownerId()
      const op = String(ev.operator_id || '')
      const invites = loadInvites()
      const hit = invites.find((x) => x.groupId === gid && (x.fromOwner || (owner && x.inviter === owner)))
      const byOwner = !!owner && (op === owner || !!hit)
      if (!byOwner) {
        api.log.info(`进了群 ${gid}（sub=${ev.sub_type || '?'} 操作人 ${op || '?'}），不是主人拉的、也没有主人的待处理邀请，白名单不动`)
        return
      }
      const wl = whitelistGroup(gid)
      if (hit) saveInvites(invites.filter((x) => x.groupId !== gid))
      api.log.info(`进了群 ${gid}（${op === owner ? '主人操作' : '对上了主人的邀请'}）：白名单${wl === 'added' ? '已加上' : wl === 'already' ? '本来就有' : '没加上'}`)
    })

    api.rule(() => '【加群 / 好友】主人拉你进群会自动通过、自动加白名单，不用你做什么。别人拉你进群时，先问主人一句「要我进吗」，主人说进就调用 qq_handle_group_invite（approve=true），说别进就 approve=false；通过后群会自动加进白名单。别人加你好友，系统会按你的性子自动判断（同群的、正常的通过，广告骚扰的拒绝），拿不准的留给主人；主人让你通过 / 拒绝时用 qq_handle_friend_request。你现在没法主动加别人好友（QQ 这边不支持），也不能主动建群。你点不了 QQ 里的卡片 / 链接 / 邀请按钮：主人发邀请卡片给你，你只能靠收到的邀请记录处理；qq_handle_group_invite 说没有待处理邀请时，就老实说「我这边没收到邀请记录，你再拉我一次试试」，别假装已经进群了。')
    // 通用诚实规则：工具没调成就别说做了
    api.rule(() => '【诚实】没真的调用工具、或者工具返回失败，就别说「已经做了 / 进群了 / 发过去了 / 唱给你听了」。不能假装做了动作，不能用「[语音条]」「[唱歌]」「（唱）」之类的文字假装发了语音或唱了歌——能发语音 / 唱歌就真的调工具发，发不了就直说现在发不了。')

    const guarded = (key, chat, sessionId, run) => async (args) => {
      const cfg = api.config()
      const p = profilePermits(cfg, key, chat, hub.turnSendersAllOwner(sessionId))
      if (!p.ok) return p
      return run(args, cfg)
    }

    /** 找要处理的那条申请：先看收到过的事件，再看 QQ 过滤掉的「可能认识的人」。 */
    async function findRequest(qq) {
      const pending = loadPending()
      const hit = qq ? pending.find((x) => x.userId === qq) : (pending.length === 1 ? pending[0] : null)
      if (hit) return { ok: true, via: 'event', flag: hit.flag, userId: hit.userId }
      if (!qq && pending.length > 1) {
        return { ok: false, message: `有 ${pending.length} 个待处理的申请：${pending.map((x) => x.userId).join('、')}。说清楚是哪个 QQ 号` }
      }
      let doubt = []
      try { doubt = (await onebot.call('get_doubt_friends_add_request', { count: 50 }, { timeoutMs: 15000 })) || [] } catch (error) { doubt = [] }
      if (!Array.isArray(doubt)) doubt = []
      const d = qq ? doubt.find((x) => String(x.user_id) === qq) : (doubt.length === 1 ? doubt[0] : null)
      if (d && d.uid) return { ok: true, via: 'doubt', flag: String(d.uid), userId: String(d.user_id || qq || '') }
      if (!qq && doubt.length > 1) return { ok: false, message: `有 ${doubt.length} 个被 QQ 过滤的申请：${doubt.map((x) => x.user_id).join('、')}。说清楚是哪个 QQ 号` }
      return { ok: false, message: qq ? `没找到 QQ ${qq} 的好友申请（没收到过，QQ 过滤的列表里也没有）` : '现在没有待处理的好友申请' }
    }

    api.tool(({ chat, sessionId }) => {
      if (chat.kind !== 'private' && chat.kind !== 'group') return []
      const cfg = api.config()
      const tools = []
      if (profileToolVisible(cfg, 'qqFriendRequest', chat)) tools.push(defineTool({
        name: 'qq_handle_friend_request',
        description: '通过或拒绝别人加你为好友的申请。qq 填申请人的 QQ 号（只有一个待处理申请时可不填）；approve 填 true 通过、false 拒绝。你不能主动加别人为好友。',
        properties: { qq: str('申请人的 QQ 号，可不填'), approve: bool('true 通过，false 拒绝') },
        required: ['approve'],
        execute: guarded('qqFriendRequest', chat, sessionId, async ({ qq, approve }, c) => {
          if (typeof approve !== 'boolean') return { ok: false, message: 'approve 要写 true（通过）或 false（拒绝）' }
          const want = String(qq ?? '').trim() ? cleanId(qq) : ''
          if (String(qq ?? '').trim() && !want) return { ok: false, message: 'QQ 号不对：要 5~12 位数字' }
          const req = await findRequest(want)
          if (!req.ok) return req
          const verb = approve ? '通过' : '拒绝'
          if (c.dryRun) return { ok: true, message: `试运行：本来要${verb} QQ ${req.userId} 的好友申请` }
          try {
            if (req.via === 'event') await onebot.call('set_friend_add_request', { flag: req.flag, approve }, { timeoutMs: 15000 })
            else await onebot.call('set_doubt_friends_add_request', { flag: req.flag, approve }, { timeoutMs: 15000 })
          } catch (error) {
            return { ok: false, message: `${verb} QQ ${req.userId} 的好友申请没成功：${error.message}` }
          }
          savePending(loadPending().filter((x) => x.flag !== req.flag && x.userId !== req.userId))
          return { ok: true, message: `已${verb} QQ ${req.userId} 的好友申请` }
        }),
      }))
      if (profileToolVisible(cfg, 'whitelist', chat)) tools.push(defineTool({
        name: 'qq_whitelist',
        description: '改白名单：action 填 add（加进）或 remove（移出），kind 填 private（某个 QQ 号可以私聊你）或 group（某个群你会理），id 填 QQ 号或群号。主人不能被移出。',
        properties: { action: str('add 加进 / remove 移出'), kind: str('private 私聊的人 / group 群'), id: str('QQ 号或群号（数字）') },
        required: ['action', 'kind', 'id'],
        execute: guarded('whitelist', chat, sessionId, async (args, c) => {
          const plan = planWhitelist(c, args)
          if (!plan.ok || !plan.changed) return plan
          if (c.dryRun) return { ok: true, message: `试运行：本来要${plan.message}` }
          const key = String(args.kind).trim().toLowerCase() === 'private' ? 'private' : 'groups'
          // 用保存那一刻最新的配置再算一遍，免得盖掉面板刚改的
          let result = plan
          api.setConfig((cur) => {
            result = planWhitelist(cur, args)
            if (!result.ok || !result.changed) return cur
            return { ...cur, allow: { ...cur.allow, [key]: result.next } }
          })
          return { ok: result.ok, message: result.message }
        }),
      }))
      if (profileToolVisible(cfg, 'qqFriendRequest', chat)) tools.push(defineTool({
        name: 'qq_handle_group_invite',
        description: '通过或拒绝别人拉你进群的邀请。group 填群号（只有一个待处理邀请时可不填）；approve 填 true 通过、false 拒绝。通过后会自动把这个群加进白名单。',
        properties: { group: str('群号，可不填'), approve: bool('true 通过，false 拒绝') },
        required: ['approve'],
        execute: guarded('qqFriendRequest', chat, sessionId, async ({ group, approve }, c) => {
          if (typeof approve !== 'boolean') return { ok: false, message: 'approve 要写 true（通过）或 false（拒绝）' }
          const want = String(group ?? '').trim() ? cleanId(group) : ''
          const list = loadInvites().filter((x) => !x.approvedAt)   // 主人拉的已自动通过的不算待处理
          const hit = want ? list.find((x) => x.groupId === want) : (list.length === 1 ? list[0] : null)
          if (!hit) return { ok: false, message: (want ? `没找到群 ${want} 的邀请记录` : '现在没有待处理的群邀请记录') + '。你点不了 QQ 卡片，没有记录就没法进：老实告诉对方没收到邀请，请他再拉你一次' }
          if (c.dryRun) return { ok: true, message: `试运行：本来要${approve ? '通过' : '拒绝'}群 ${hit.groupId} 的邀请` }
          try {
            await onebot.call('set_group_add_request', { flag: hit.flag, sub_type: hit.subType, approve }, { timeoutMs: 15000 })
          } catch (error) {
            return { ok: false, message: `群 ${hit.groupId} 的邀请没处理成功：${error.message}` }
          }
          saveInvites(loadInvites().filter((x) => x.flag !== hit.flag))
          let extra = ''
          if (approve) {
            const plan = planWhitelist(c, { action: 'add', kind: 'group', id: hit.groupId })
            if (plan.ok && plan.changed) {
              api.setConfig((cur) => {
                const again = planWhitelist(cur, { action: 'add', kind: 'group', id: hit.groupId })
                if (!again.ok || !again.changed) return cur
                return { ...cur, allow: { ...cur.allow, groups: again.next } }
              })
              extra = '，已经把群加进白名单了'
            } else if (plan.ok) extra = '，这个群本来就在白名单里'
          }
          return { ok: true, message: `已${approve ? '通过' : '拒绝'}群 ${hit.groupId} 的邀请${extra}` }
        }),
      }))
      return tools
    })
    return {}
  },
}
