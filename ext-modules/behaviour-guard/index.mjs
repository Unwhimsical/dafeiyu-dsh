// 扩展模块「behaviour-guard」——把 behaviour.json 里主人的开关，同步到那些还只认旧面板配置的自主行为。
//
// 为什么需要它：抖音 / 语音 / 回忆 / 人格 已经直接读 behaviour.json（保存即生效），
// 但 B 站、主动搭话还在读宿主 config.json。主人改一个总闸，得让这两处也立刻跟上。
// 本模块只做同步，不聊天、不写记忆、不主动发任何消息；值没变就不写配置，避免和面板打架。
//
// 保存即生效，不用重启 DSH。

import fs from 'node:fs'

// 「配置没被冲掉」的守护：
// 如果有模块用局部对象调 setConfig，宿主会把整份 config.json
// 补成出厂默认值，enabled=false / botQQ='' / QQ 网关 unconfigured，主人发消息她一条都发不出去，
// 表面看就像「她死了」。这里每分钟看一眼，发现这种特征就自动从完好快照恢复。
// 主人主动关总开关时 botQQ 不会同时变空，所以不会误判。
const RESET_KEYS = ['enabled', 'dryRun', 'setupDone', 'botQQ', 'ownerQQ', 'ownerName']
function looksLikeFactoryReset(c) {
  return !!c && !c.botQQ && !c.ownerQQ && c.setupDone === false && c.dryRun === true && c.ownerName === '主人'
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null }
}

export default {
  id: 'behaviour-guard',
  name: '行为总开关',
  version: '1.0.0',
  api: 1,
  description: '把 behaviour.json 的主人开关同步到 B 站 / 主动搭话 / 抖音的旧配置，改完保存即生效',

  setup(api) {
    // 模块的 dataDir 是 plugins-data/dafeiyu/modules-data/<id>/，
    // behaviour.json 在插件数据根目录，要往上两级。用相对层级，不写死绝对路径。
    const file = () => api.dataDir('..', '..', 'behaviour.json')
    const read = () => {
      try { return JSON.parse(fs.readFileSync(file(), 'utf8')) || {} } catch { return {} }
    }
    const write = (b) => {
      try { fs.writeFileSync(file(), JSON.stringify(b, null, 2)) } catch (e) {
        api.log?.warn?.('行为总开关写回失败：' + e.message)
      }
    }

    // 完好配置快照（含密钥，只放在本机运行数据目录，不要提交、不要外传）
    const goodFile = () => api.dataDir('..', '..', 'config.good.json')
    function guardConfig(cur) {
      if (looksLikeFactoryReset(cur)) {
        const good = readJson(goodFile())
        if (good && good.botQQ && good.setupDone === true) {
          // 必须交完整对象；只传局部补丁会把其它字段冲成默认值
          api.core.setConfig({ ...cur, ...good })
          api.log?.warn?.('⚠️ 严重：config.json 被冲成出厂默认值（' + RESET_KEYS.join('、') + '），QQ 消息会发不出去。已自动从 config.good.json 恢复，请查最近改动过的模块有没有误用 core.setConfig')
        } else {
          api.log?.warn?.('⚠️ 严重：config.json 被冲成出厂默认值，且找不到完好快照 config.good.json；请手动从你自己的备份恢复')
        }
        return true
      }
      try {
        const prev = readJson(goodFile())
        if (JSON.stringify(prev) !== JSON.stringify(cur)) fs.writeFileSync(goodFile(), JSON.stringify(cur))
      } catch (e) { api.log?.warn?.('配置快照写入失败：' + e.message) }
      return false
    }

    function apply() {
      // 先看配置有没有被冲掉；被冲了就先恢复，本轮不再做开关同步，避免两次写配置叠加
      const curNow = api.core?.getConfig?.()
      if (curNow && typeof api.core.setConfig === 'function' && guardConfig(curNow)) return

      const b = read()
      const off = b.master?.autonomous === false
      b.douyin ||= {}

      // 抖音：duty.js 每分钟重读本文件。总闸关时临时压住 selfBrowse，
      // 并把原值记在 _masterBackup 里；总闸恢复时自动还原，不覆盖主人平时的细粒度设置。
      // 只在状态切换的那一分钟写一次，其余时间完全不碰文件。
      if (off && b._masterBackup === undefined) {
        b._masterBackup = { selfBrowse: b.douyin.selfBrowse !== false }
        b.douyin.selfBrowse = false
        write(b)
      } else if (!off && b._masterBackup !== undefined) {
        b.douyin.selfBrowse = Boolean(b._masterBackup.selfBrowse)
        delete b._masterBackup
        write(b)
      }

      const cur = api.core?.getConfig?.()
      if (!cur || typeof api.core.setConfig !== 'function') return
      const wantBili = !off && b.bili?.selfBrowse !== false
      const wantChat = !off && b.chat?.proactive !== false
      const wantDy = !off && b.douyin?.selfBrowse !== false
      const patch = {}
      if (Boolean(cur.bili?.autoBrowse) !== wantBili) patch.bili = { autoBrowse: wantBili }
      if (Boolean(cur.speakUp?.enabled) !== wantChat) patch.speakUp = { enabled: wantChat }
      if (Boolean(cur.douyin?.autoBrowse) !== wantDy) patch.douyin = { autoBrowse: wantDy }
      if (Object.keys(patch).length) {
        // 注意（必读，别改回去）：
        // api.core.setConfig 是宿主的「整份替换」接口，收到局部对象会先 normalizeConfig()
        // 把没给的字段全补成出厂默认值（enabled=false / dryRun=true / botQQ='' / 模型空 / ext 全空），
        // 再 merge3 写盘 —— 这样会把整份配置冲掉、QQ 消息发不出去。
        // 正确做法：先自己合成一份完整配置（浅层展开 + 每个改动段做对象合并）再交出去。
        // 另外模块 API 里的 api.setConfig() 才是带 deepMerge 的安全包装，但这里已经拿到 cur，
        // 显式合成最不容易受宿主版本影响。
        const full = { ...cur }
        for (const [k, v] of Object.entries(patch)) full[k] = { ...(cur[k] || {}), ...v }
        api.core.setConfig(full)
        api.log?.info?.('行为总开关：' + (off ? '一键全安静' : '恢复自主') + ' → 同步 ' + Object.keys(patch).join(' / '))
      }
    }

    api.every(60_000, () => {
      try { apply() } catch (e) { api.log?.warn?.('行为总开关同步出错：' + e.message) }
    }, '行为总开关·同步')
    try { apply() } catch (e) { api.log?.warn?.('行为总开关首次同步出错：' + e.message) }
  },
}
