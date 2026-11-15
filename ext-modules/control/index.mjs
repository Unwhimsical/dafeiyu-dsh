// 远程写回：v2 控制台把要改的配置写进 queue.json，这里落进 Aurabot 的真实配置
// （Aurabot 的 config 在内存里缓存，直接改 config.json 不生效，必须走 setConfig）
import fs from 'node:fs'
import path from 'node:path'

export default {
  id: 'control',
  name: '远程设置',
  version: '1.0.0',
  api: 1,
  description: '（精简，只留应急）星图 POST /api/fish/config 写 queue.json，这里拿 setConfig 落进去。没有工具、没有面板入口。',
  defaults: { enabled: true, pollSeconds: 5 },
  settings: [],

  setup(api) {
    const DIR = api.dataDir()
    const QUEUE = path.join(DIR, 'queue.json')
    const APPLIED = path.join(DIR, 'applied.json')

    // 白名单：只允许改这些；其余一律忽略并在回执里标注
    function isModuleToggle(key) {
  const parts = String(key || '').split('.')
  return parts.length === 3 && parts[0] === 'modules' && parts[2] === 'enabled' && /^[A-Za-z0-9_-]+$/.test(parts[1])
}

const ALLOW = [
      'douyin.enabled', 'douyin.autoBrowse', 'douyin.intervalHours', 'douyin.maxRunsPerDay',
      'douyin.perRun', 'douyin.dwellMin', 'douyin.dwellMax', 'douyin.maxWatchPerDay',
      'douyin.dmPollMinutes', 'douyin.shareBias', 'douyin.ownerDm',
      'voice.enabled', 'voice.engine', 'voice.voice', 'voice.rate', 'voice.pitch', 'voice.autoChance', 'voice.autoMaxChars',
  'voice.http.urlTemplate',
  'voice.http.timeoutMs',
  'voice.http.headers',
      'memory.enabled', 'memory.recallCount',
      'group.interjectChance', 'group.cooldownSec', 'group.maxPerHour', 'group.minRelevance',
      'group.burstMax', 'group.burstWindowSec', 'group.activeWindowSec', 'group.minRecentMessages',
      'safeMode', 'ownerLevel', 'groupLevel',
      'ext.autonomy.enabled', 'ext.autonomy.windowStart', 'ext.autonomy.windowEnd', 'ext.autonomy.wantPlay',
      'ext.media.autoVision', 'ext.media.size', 'ext.media.zhipuKey', 'ext.media.genProvider',
  'ext.media.genModel',, 'ext.memcore.v2Url', 'ext.memcore.url', 'ext.media.siliconKey', 'ext.media.visionProvider', 'ext.media.minGapSeconds',
  'allow.groups', 'allow.private',
  'adultStore.enabled', 'adultStore.noDisk', 'adultStore.dir',
]

    const NUM = /^(group\.(interjectChance|cooldownSec|maxPerHour|minRelevance|burstMax|burstWindowSec|activeWindowSec|minRecentMessages)|douyin\.(intervalHours|maxRunsPerDay|perRun|dwellMin|dwellMax|maxWatchPerDay|dmPollMinutes)|memory\.recallCount|ext\.autonomy\.(windowStart|windowEnd)|ext\.media\.size|voice\.(autoChance|autoMaxChars))$/
    const BOOL = /^(douyin\.(enabled|autoBrowse|ownerDm)|voice\.enabled|memory\.enabled|safeMode|ext\.autonomy\.(enabled|wantPlay)|ext\.media\.autoVision)$/

    function readJson(f, dflt) {
      try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return dflt }
    }

    function writeAtomic(f, text) {
      const tmp = f + '.tmp'
      const fd = fs.openSync(tmp, 'w')
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.renameSync(tmp, f)
    }

    function setPath(obj, dotted, value) {
      const parts = dotted.split('.')
      let cur = obj
      for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i]
        if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
        cur = cur[k]
      }
      cur[parts[parts.length - 1]] = value
    }

    function coerce(key, value) {
      if (NUM.test(key)) {
        const n = Number(value)
        if (!Number.isFinite(n)) throw new Error('要数字')
        return n
      }
      if (BOOL.test(key)) {
        if (typeof value === 'boolean') return value
        const s = String(value).toLowerCase()
        return s === 'true' || s === '1' || s === 'on' || s === '开'
      }
      if (typeof value === 'boolean') return value
      if (typeof value === 'number') return value
      if (value && typeof value === 'object') return value
      return String(value).slice(0, 200)
    }

    function drain() {
      if (!fs.existsSync(QUEUE)) return
      const items = readJson(QUEUE, null)
      try { fs.unlinkSync(QUEUE) } catch {}
      if (!Array.isArray(items)) return
      const cfg = api.core.getConfig()
      const ok = [], skipped = []
      for (const it of items) {
        const key = String((it && it.path) || '')
        if (!key) continue
        if (!ALLOW.includes(key) && !isModuleToggle(key)) { skipped.push({ path: key, why: '不在可改范围' }); continue }
        try {
          const v = coerce(key, it.value)
          setPath(cfg, key, v)
          ok.push({ path: key, value: v })
        } catch (e) {
          skipped.push({ path: key, why: e.message })
        }
      }
      if (ok.length) {
        try {
          api.core.setConfig(cfg)
          api.log.info('控制台改好了 ' + ok.length + ' 项：' + ok.map((x) => x.path + '=' + x.value).join('，'))
        } catch (e) {
          api.log.warn('写回配置失败：' + e.message)
        }
      }
      writeAtomic(APPLIED, JSON.stringify({ at: Date.now(), ok, skipped }, null, 2))
    }

    if (api.settings().enabled !== false) {
      api.every(Math.max(2, Number(api.settings().pollSeconds) || 5) * 1000, () => {
        try { drain() } catch (e) { api.log.warn('远程设置轮询出错：' + e.message) }
      }, 'control-queue')
      api.later(3000, () => {
        try { drain() } catch {}
        api.log.info('远程设置已就绪（队列 ' + QUEUE + '）')
      })
    }

    // 精简：只留「星图 POST /api/fish/config → queue.json → setConfig」这条应急写回；
    // 去掉了 remote_set 工具和规则（她不再自己改配置），也不再在面板里单独占一个设置入口。

    return { ALLOW }
  },
}
