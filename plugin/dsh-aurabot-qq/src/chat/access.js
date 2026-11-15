// 谁能跟她说话、她在每个会话里有多大权限。纯函数。

/** 权限档位：full = DSH 完整工具；social = 只有 QQ 社交工具；chat = 纯聊天，没有工具。 */
export const LEVELS = ['full', 'social', 'chat']

/**
 * @param {object} cfg 插件配置
 * @param {{kind:'private'|'group', userId:string, groupId:string}} msg
 * @returns {{allowed: boolean, reason: string}}
 */
export function checkAllowed(cfg, msg) {
  const owner = String(cfg.ownerQQ || '')
  if (msg.kind === 'private') {
    if (msg.userId === owner) return { allowed: true, reason: '主人' }
    // 私聊默认对所有人开放。主人 / 家人 / 18+ 暗号规则照旧，由大脑隐私层 + 暗号模块 + 公开守卫管。
    // 想恢复白名单：配置 allow.privateOpen=false；单独拉黑：allow.privateDeny
    const deny = (cfg.allow?.privateDeny || []).map(String)
    if (deny.includes(msg.userId)) return { allowed: false, reason: '私聊黑名单' }
    if (cfg.allow?.privateOpen !== false) return { allowed: true, reason: '私聊开放' }
    const list = (cfg.allow?.private || []).map(String)
    return list.includes(msg.userId)
      ? { allowed: true, reason: '私聊白名单' }
      : { allowed: false, reason: '不在私聊白名单' }
  }
  const groups = (cfg.allow?.groups || []).map(String)
  return groups.includes(msg.groupId)
    ? { allowed: true, reason: '群白名单' }
    : { allowed: false, reason: '不在群白名单' }
}

/** 这个会话用哪一档权限。群聊永远不超过 social。 */
export function levelFor(cfg, chat) {
  const owner = String(cfg.ownerQQ || '')
  if (chat.kind === 'private' && chat.userId === owner) {
    return LEVELS.includes(cfg.ownerLevel) ? cfg.ownerLevel : 'full'
  }
  return 'social'
}

/** 档位 → agent preset id。 */
export function presetFor(level, cfg) {
  if (level !== 'full') return 'aurabot-social'
  return cfg && cfg.longTasks ? 'aurabot-private-long' : 'aurabot-private'
}

/** 只有主人能做的事（群管、点歌、写文件……）。 */
export function isOwner(cfg, userId) {
  return String(userId || '') !== '' && String(userId) === String(cfg.ownerQQ || '')
}

/** 能用命令的人：主人 + 面板「指令权限」里加的 QQ（cfg.commandAllow）。别人发的命令一律静默忽略。 */
export function canUseCommands(cfg, userId) {
  if (isOwner(cfg, userId)) return true
  const u = String(userId || '')
  return u !== '' && (Array.isArray(cfg.commandAllow) ? cfg.commandAllow : []).map(String).includes(u)
}

/** 看起来像命令：/xxx、／xxx，或 #sl / #status 这类「# + 英文词」单独一条（SnowLuma 的 #sl 状态命令也算）。 */
export function looksLikeCommand(text) {
  const t = String(text || '')
  return /^\s*[/／]\s*[A-Za-z0-9一-龥_-]/.test(t) || /^\s*[#＃]\s*[A-Za-z][A-Za-z0-9_-]{0,15}\s*$/.test(t)
}

/** 被授权的非主人（指令权限名单）不能用的内置命令：会改主人记忆 / 总开关 / 模型 / 发日记。扩展模块的命令默认也只给主人（模块声明 delegate: true 才放行）。 */
export const DELEGATE_DENY = new Set(['remember', 'on', 'off', 'model', 'diary', 'gmute', 'gunmute'])

/** 改资料类操作（改昵称 / 签名 / 头像、改 B 站签名），以及处理好友申请、改白名单的三档权限。 */
export const PROFILE_PERM_LEVELS = ['off', 'owner', 'all']
export const DOUYIN_PERM_KEYS = ['douyinBrowse', 'douyinLike', 'douyinComment', 'douyinShareOwner', 'douyinDm']
/** 小黑盒：浏览（含热榜/搜索）、点赞、评论、发帖（含删自己的帖）。 */
export const HEYBOX_PERM_KEYS = ['heyboxBrowse', 'heyboxLike', 'heyboxComment', 'heyboxPost']
export const PROFILE_PERM_KEYS = ['qqNickname', 'qqSignature', 'qqAvatar', 'biliSign', 'biliAvatar', 'qqFriendRequest', 'whitelist', ...DOUYIN_PERM_KEYS, ...HEYBOX_PERM_KEYS]
/** 没设过的档位：一律默认仅主人（含抖音浏览/互动/改资料项；用户要放开自己在面板开）。 */
export const profilePermDefault = (key) => 'owner'
export const permOf = (cfg, key) => {
  const p = cfg?.profilePerms?.[key]
  return PROFILE_PERM_LEVELS.includes(p) ? p : profilePermDefault(key)
}

/** 属于「她自己的人设 / 资料」的项：主人用 selfEditPersona.enabled 一键关掉。 */
export const SELF_EDIT_KEYS = ['qqNickname', 'qqSignature', 'qqAvatar', 'biliSign', 'biliAvatar']
export const selfEditAllowed = (cfg) => cfg?.selfEditPersona?.enabled !== false
export const SELF_EDIT_OFF_MSG = '主人把「我自己改人设 / 资料」的开关关了（/改人设 开 才能改）'

/** 这一档在这个会话里要不要挂工具。owner = 只在主人私聊里挂；all = 哪都挂；off = 不挂。 */
export function profileToolVisible(cfg, key, chat) {
  if (SELF_EDIT_KEYS.includes(key) && !selfEditAllowed(cfg)) return false
  const p = permOf(cfg, key)
  if (p === 'all') return chat.kind === 'private' || chat.kind === 'group'
  if (p === 'owner') return chat.kind === 'private' && String(chat.userId) === String(cfg.ownerQQ || '')
  return false
}

/** 执行时再查一遍（面板可能刚改过）。allOwner = 这一轮说话的人全是主人。 */
export function profilePermits(cfg, key, chat, allOwner) {
  const p = permOf(cfg, key)
  if (p === 'off') return { ok: false, message: '这个操作在面板里关掉了' }
  if (SELF_EDIT_KEYS.includes(key) && !selfEditAllowed(cfg)) return { ok: false, message: SELF_EDIT_OFF_MSG }
  if (!profileToolVisible(cfg, key, chat)) return { ok: false, message: '这里不能做这个操作' }
  if (p === 'owner' && !allOwner) return { ok: false, message: '只有主人私聊让我改才行' }
  return { ok: true }
}
