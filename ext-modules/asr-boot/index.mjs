// 让 Aurabot 走本地语音识别（config.local.asr = true），并自检一次
export default {
  id: 'asr-boot',
  name: '语音输入（本地识别）',
  version: '1.0.0',
  api: 1,
  description: '打开本地接口里的 asr，让 QQ/抖音语音消息能被转成文字',
  defaults: { enabled: true },
  settings: [{ key: 'enabled', label: '启用', type: 'boolean', hint: '关掉就还用原来的兜底方式' }],

  setup(api) {
    const cfg = () => ({ ...(api.settings() || {}) })

    function ensure() {
      try {
        if (cfg().enabled === false) return
        const cur = api.core.getConfig()
        if (cur?.local?.asr === true) return
        api.core.setConfig({ ...cur, local: { ...(cur.local || {}), asr: true } })
        api.log.info('已打开本地语音识别（local.asr = true）')
      } catch (e) {
        api.log.warn('打开本地语音识别失败：' + (e && e.message))
      }
    }

    api.later(5000, ensure)
    api.every(10 * 60_000, ensure, '确认识别开关')

    api.command({
      name: '听写',
      aliases: ['语音转文字'],
      desc: '看语音识别接口状态',
      run: async () => {
        const st = api.core.local?.status ? api.core.local.status() : null
        const one = (st || []).find((x) => x.slot === 'asr')
        return one
          ? `语音识别：${one.active ? '已接管' : '没接管'}（文件 ${one.exists ? '在' : '缺'}，开关 ${one.enabled ? '开' : '关'}）` +
            (one.last ? `，上次：${one.last.ok ? '成功' : '失败'} ${one.last.message}` : '')
          : '拿不到本地接口状态'
      },
    })

    api.log.info('语音输入模块已加载')
  },
}
