/* 大肥鱼 · 记忆大脑 v2 —— 前端可调参数（颜色 / 尺寸 / 动画）全部集中在这里。
 * 改完刷新页面即可生效，不需要构建。 */
window.BRAIN_CONFIG = {
  // ---------- 数据源 ----------
  api: {
    mode: 'auto',            // 'auto'：先连真实后端，连不上自动切到演示数据；'real'：只用后端；'mock'：只用演示数据
    base: '',                // 后端地址，空 = 与页面同源（由 8780 服务托管 web/ 时）。单独打开 html 时可填 'http://127.0.0.1:8780'
    keyStorage: 'dafeiyu_admin_key',  // 管理员密钥在 localStorage 里的键名
    pulsePollMs: 1500,       // /pulses 轮询间隔
    timeoutMs: 4000          // 单个请求超时
  },

  // ---------- 记忆类型：显示名 + 星点颜色 ----------
  // kind 来自后端 memories.kind；items 的 type 来自花园内容（梦 / 心痕 / 情绪…）
  kinds: {
    about_user:   { label: '事实', color: '#9fd8ff' },
    profile:      { label: '事实', color: '#9fd8ff' },
    preference:   { label: '偏好', color: '#f6d38b' },
    event:        { label: '事件', color: '#7fe9ff' },
    episode:      { label: '事件', color: '#7fe9ff' },
    relationship: { label: '关系', color: '#ff9fb8' },
    self:         { label: '自我', color: '#c9b6ff' },
    diary:        { label: '日记', color: '#b8f0d0' },
    cognition:    { label: '认知', color: '#5ff3ff' }
  },
  itemTypes: {
    dream:   { label: '梦境', color: '#d59bff' },
    heart:   { label: '心痕', color: '#ff7eb6' },
    mood:    { label: '情绪', color: '#ff9ec4' },
    desire:  { label: '欲望', color: '#ff6f91' },
    diary:   { label: '日记', color: '#b8f0d0' },
    handoff: { label: '交接', color: '#fff09a' },
    worry:   { label: '心事', color: '#7fe0c8' },
    note:    { label: '便条', color: '#ffd9a8' },
    murmur:  { label: '碎碎念', color: '#d4f7b0' },
    novel:   { label: '小说', color: '#ffb38a' },
    card:    { label: '卡片', color: '#8fd3ff' },
    chat:    { label: '聊天摘要', color: '#a3b2ff' },
    entry:   { label: '花园手记', color: '#c2f0a0' },
    image:   { label: '图片', color: '#ffc8ec' },
    voice:   { label: '语音', color: '#a6fff2' },
    memory:  { label: '记忆', color: '#ffffff' }
  },
  // 筛选栏里的“类型”分组（显示名 → 包含的 kind / item type）
  typeGroups: [
    { label: '事实', kinds: ['about_user', 'profile'] },
    { label: '偏好', kinds: ['preference'] },
    { label: '事件', kinds: ['event', 'episode'] },
    { label: '情绪', kinds: ['mood', 'desire', 'worry'] },
    { label: '关系', kinds: ['relationship'] },
    { label: '梦境', kinds: ['dream'] },
    { label: '心痕', kinds: ['heart'] },
    { label: '自我/认知', kinds: ['self', 'cognition', 'diary'] }
  ],
  linkKinds: {
    semantic:  { label: '意思相近',   color: '#b8a6ff' },
    tag:       { label: '同一标签',   color: '#9fd8ff' },
    time:      { label: '同一时期',   color: '#9fd8ff' },
    manual:    { label: '手动',       color: '#f6d38b' },
    co_recall: { label: '常一起想起', color: '#ffc4d6' },
    cognition: { label: '凝成认知',   color: '#5ff3ff' }
  },
  states: { pinned: '钉住 · 永远记得', clear: '清晰', faded: '模糊了', trace: '只剩残影' },
  scopes: { inherit: '继承会话', private: '私密', scoped: '限定', public: '公开' },
  scopeColors: { private: '#ff8fa3', scoped: '#f6d38b', public: '#7fe0c8', inherit: '#9fb3c8' },

  // ---------- 主题 ----------
  // 'cosmos'：新版「宇宙」星图（写实灰白星系 + 双星核心 + 字幕 + 自动漫游，默认）
  // 'classic'：v2 旧版彩色星图（顶栏 + 玻璃卡 + 彩色记忆星）
  // 页面右下角「◐ 经典 / ✦ 宇宙」按钮可以临时切换（记在本机浏览器里）；网址加 ?theme=classic 也行
  theme: 'cosmos',

  // ---------- 宇宙主题外观（只在 theme = 'cosmos' 时生效） ----------
  cosmos: {
    background: '#030207',   // 底色（接近纯黑）
    haze: 0.55,              // 背景淡紫雾强度（0 = 纯黑）
    hazeColor: [0.32, 0.25, 0.48],  // 雾的颜色（RGB 0..1，偏薰衣草紫）
    dustSaturation: 0.14,    // 星尘饱和度（越小越灰白）
    dustSize: 1.7,           // 星尘粒子大小（比经典更细）
    dustOpacity: 0.85,
    armSpread: 1.35,         // 旋臂松散程度（>1 更像真实星系的弥散盘面）
    starSaturation: 0.22,    // 记忆星饱和度：只保留一点点白 / 淡蓝 / 淡金的倾向，不做彩虹色
    glowSize: 2.2,           // 核心淡紫光晕大小（相对星系半径）
    glowStrength: 0.26,      // 核心光晕亮度
    twinGap: 30,             // 双星核心两颗星的间距
    twinSize: 50,            // 双星每颗的光斑大小
    twinPeriod: 26,          // 双星互相绕转一圈的秒数
    camPhi: 1.27,            // 默认俯仰角（越大越侧，1.27 ≈ 视频里那种斜看的盘面）
    camDistance: 1.05,       // 默认距离倍数（乘 camera.distance）
    gold: '#f3cf8a',         // 星座连线 / 选中星的暖金色
    constellationMax: 9,     // 选中 / 悬停时，同标签星座最多连几颗星
    ignoreTags: ['日常'],    // 这些标签不参与连星座（太常见）
    hoverConstellation: true,// 鼠标悬停时也预览星座
    tourIdle: 14,            // 多少秒没操作开始自动漫游（0 = 不自动，只能点「漫游」按钮）
    tourDwell: 7,            // 每颗星停留秒数
    tourDistance: 0.72,      // 漫游时相机距离（乘全景距离）
    narration: true,         // 漫游时在画面中间显示一行旁白（层级说明 / 遗忘倒计时）
    hint: '拖动 · 环视　　滚轮 · 靠近　　点一颗星，点亮它的星座',  // 底部居中的操作提示（空字符串 = 不显示）
    coreLabel: false,        // 是否在双星下方显示「原意识 · 大肥鱼」
    // 星与星之间的动态连线（星座 / 关联）
    links: {
      drawIn: true,          // 选中 / 悬停一颗星时，星座连线从这颗星向外「画出来」
      drawSeconds: 0.9,      // 每一层连线画出来用几秒
      stagger: 0.55,         // 下一层比上一层晚多少（以 drawSeconds 为单位）
      pulses: true,          // 连线上流动的光脉冲（着色器里的亮点，几乎不耗性能）
      pulseSpeed: 0.45,      // 光脉冲流动速度（每秒走过几条线）
      beads: true,           // 沿星座线飞行的小光点（粒子）
      beadSpeed: 0.55,       // 光点速度
      beadDensity: 1,        // 每条线同时跑几个光点（1~3）
      ambient: true,         // 空闲 / 漫游时偶尔闪一下两颗相关记忆之间的连线
      ambientEvery: 2.2,     // 平均每隔几秒闪一次
      ambientMax: 6,         // 同时最多几条闪烁线
      ambientAlpha: 0.32,    // 闪烁线最亮时的透明度
      idleAlpha: 0.022,      // 平时所有关联线的底色透明度（0 = 完全不显示，和视频一样干净）
      lowEndScale: 0.4       // 低配模式（?lowend=1 / 手机）时光点、闪烁数量乘这个系数
    }
  },

  // ---------- 层级与灰度边界（只在 theme = 'cosmos' 时影响布局） ----------
  // 布局规则（时间 = 半径，和「星海生长」联动）：
  //   半径 = 记忆的「相对年龄」× 当前星系半径（星系长大，时间轴跟着拉长）；最新的贴近核心，最老的在外圈
  //   角度 = 沿当前的旋臂（旋臂数由星海生长决定）
  //   亮度 / 大小 / 层级 只看重要度和清晰度，不看半径 —— 很老但重要的记忆，在外圈也照样是亮的「行星」
  //   恒星级不看时间，贴着中间的双星；只有「又老又弱」的记忆才会越过灰度边界变灰（只是显示，不删除）
  // 层级判定顺序：恒星级 → 灰度边界外 → 行星级 → 星星级（先命中先算）。
  tiers: {
    // —— 时间轴 ——
    timeMap: 'rank',             // 'rank'：按新旧排名均匀铺开（推荐，记忆分布均匀）；'log'：按真实天数取对数（最近几天拉得更开）
    timeLogDays: 30,             // 'log' 模式的弯曲程度（天）：越小越强调最近
    crowdShrink: 400,            // 记忆超过这个数量时，星星级/灰色小星会按数量自动缩小变暗，免得盖住旋臂（0 = 不缩）
    armJitter: 2.2,              // 记忆星偏离旋臂中心线的角度范围（弧度，总宽）；越大越像一整片盘面，越小越贴着旋臂；旋臂多于 2~3 条时会自动按比例收窄
    timeCurve: 0.85,             // 'rank' 模式的指数：<1 外圈更稀，>1 外圈更密
    timeInner: 0.1,              // 最新的记忆所在半径（相对当前星系半径）
    timeOuter: 1.0,              // 最老的记忆所在半径（相对当前星系半径）
    // —— 恒星级：本体（核心卡 = 中间双星）+ 钉住 / 最重要 / self 类记忆 ——
    stellarPinned: true,         // 钉住的记忆一律算恒星级
    stellarMinImportance: 5,     // 重要度 ≥ 它也算恒星级
    stellarKinds: ['self'],      // 这些 kind 算恒星级
    stellarMax: 14,              // 恒星级最多几颗（超出的按分数降为行星级）
    stellarBand: [0.08, 0.2],  // 恒星级所在半径带（相对星系半径，不看时间）
    // —— 行星级：整理过 / 总结过 / 分好类、或者重要的记忆（更大更亮，位置仍按时间） ——
    planetKinds: ['cognition', 'profile', 'relationship'],  // 这些 kind 直接算行星级（cognition = 整理出的认知）
    planetMinImportance: 4,      // 重要度 ≥ 它
    planetMinRecall: 3,          // 或被想起 ≥ 它次
    planetItems: true,           // 花园内容（日记 / 梦 / 交接等总结类）算行星级
    planetMaxShare: 0.3,         // 行星级最多占全部记忆的比例（超出的按分数降为星星级，记忆很多时保持层次；0 = 不限）
    planetOrbits: 10,            // 给最亮的几颗行星画一圈淡淡的轨道（0 = 不画）
    // —— 星星级：其余零散的碎片记忆 —— 不用配置，剩下的都是
    // —— 灰度边界：又老又弱才越界 ——
    grayThreshold: 0.15,         // 清晰度（strength）< 它 才可能越界（0.15 = 后端 trace 状态的下限）
    grayMinAge: 0.5,             // 而且相对年龄 ≥ 它（0 = 最新，1 = 最老）；老而强的、新而弱的都不会变灰
    grayMinDays: 7,              // 而且至少写下这么多天
    grayRing: 1.08,              // 灰度边界圈所在半径（相对当前星系半径）
    grayBand: [1.12, 1.34],      // 越界记忆所在半径带（越弱越靠外）
    forgetAt: 0.05,              // 清晰度降到它就算「遗忘」，用来估算倒计时（只是显示，不会删除任何记忆）
    defaultHalfLife: 30,         // 没有 half_life_days 时用的半衰期（天）
    grayLabels: 6,               // 同时最多显示几个「约 N 天后遗忘」标签（离镜头近的优先）
    ringLabel: '灰度边界'
  },

  // ---------- 星图 ----------
  galaxy: {
    arms: 2,                 // 旋臂数（growth.enabled 为 true 时由「星海生长」自动决定）
    radius: 330,             // 星系半径（世界单位；也是生长时相机距离的参照）
    armTwist: 2.9,           // 旋臂缠绕程度（越大越卷）
    dustCount: 80000,        // 旋臂星尘粒子数（低配电脑可降到 40000；生长开启时改用 growth.dust*）
    dustSize: 2.1,           // 星尘粒子大小
    dustOpacity: 0.8,
    bgStars: 2600,           // 远处背景星
    coreSize: 170,           // 金色核心光晕大小
    bulgeSize: 380,          // 核心外层暖光
    coreColor: ['rgba(255,253,240,1)', 'rgba(255,236,190,.95)', 'rgba(246,211,139,.45)'],
    rotateSpeed: 0.018,      // 星系自转速度（弧度/秒）
    idleOrbitSpeed: 0.04,    // 空闲 4 秒后相机缓慢环绕速度
    heroCount: 15,           // 最亮的“英雄星”数量（钉住/重要/常想起）
    skyTop: '#01030a',       // 天空顶部颜色（底部青绿极光在 starmap.js 的 SKY shader 里）
    auroraStrength: 1.0      // 底部青绿极光强度 0..2
  },
  // ---------- 星海生长：星系随记忆数量长大 ----------
  // 关掉（enabled: false）时，星系完全按上面 galaxy 里的 arms / radius / dustCount 固定显示，和以前一模一样。
  // 打开时，上面的 galaxy.arms / radius / dustCount 不再生效，改由下面这些参数根据「记忆条数」计算。
  // 记忆条数 = 星图里的记忆星数量（不含花园内容）。预览：网址加 ?mockcount=2000 模拟 2000 条记忆。
  growth: {
    enabled: true,           // 总开关：true = 星系会随记忆增多而长大；false = 固定星系（旧行为）
    // 旋臂数：记忆条数达到 min 时变成 arms 条（从小到大写）
    armSteps: [
      { min: 0,    arms: 2 },
      { min: 200,  arms: 3 },
      { min: 600,  arms: 4 },
      { min: 1500, arms: 5 },
      { min: 3000, arms: 6 }
    ],
    maxArms: 6,              // 旋臂数上限（armSteps 写得再多也不会超过它）
    // 半径：从 radiusMin 平滑长到 radiusMax
    radiusMin: 260,          // 记忆很少时的半径
    radiusMax: 640,          // 记忆达到 radiusFullAt 时的半径（之后不再变大）
    radiusFullAt: 5000,      // 多少条记忆时长到最大
    radiusCurve: 'log',      // 生长曲线：'log' 前期长得快后期慢（推荐）；'sqrt' 平方根；'linear' 匀速
    radiusLogK: 150,         // 'log' 曲线的弯曲程度：越小前期越陡
    // 星尘粒子：基础数量 + 每条记忆增加的数量，再被上限截住
    dustBase: 50000,         // 记忆为 0 时的星尘数
    dustPerMemory: 25,       // 每多 1 条记忆多几粒星尘
    dustMax: 140000,         // 性能上限（普通电脑）
    dustMaxLow: 45000,       // 低配上限（手机 / 核显 / lowEnd 时用）
    lowEnd: 'auto',          // 'auto' 自动判断（手机或 CPU ≤4 核视为低配）；true 强制低配；false 强制高配
    // 核心：随生长进度略微变大变亮（0 = 不变）
    coreGrow: 0.35,          // 核心光晕最多再大 35%
    coreBright: 0.25,        // 核心最多再亮 25%
    // 动画
    animSeconds: 4,          // 跨过阈值时，旋臂展开 / 半径变化 / 星点滑动的时长（秒）
    cameraFollow: true,      // 星系变大时相机自动拉远，保持整体都在画面里
    refreshSeconds: 60,      // 每隔多少秒重新读一次星图，发现新记忆就生长（0 = 不定时，只在脉冲里出现新记忆时刷新）
    hud: true                // 左下角显示「记忆 1234 · 旋臂 4」
  },

  star: {
    baseSize: 2.3,           // 普通记忆星大小系数
    heroSize: 30,            // 英雄星大小
    pinnedSize: 6,           // 钉住星大小（乘 baseSize）
    importanceBoost: 2,      // 重要度 ≥4 额外加的大小
    minBright: 0.12,         // 最暗的星（快遗忘）亮度
    twinkle: 0.15,           // 闪烁幅度
    dimUnmatched: 0.16,      // 搜索/筛选不匹配的星亮度
    linkAlpha: 0.085,        // 普通关联线透明度（很淡）
    selLinkMax: 14           // 选中时最多画几条放射线
  },
  camera: {
    fov: 55,
    distance: 540,           // 初始距离
    theta: 0.35, phi: 0.62,  // 初始方位角 / 俯仰角
    minDist: 140, maxDist: 1500,
    flyDistance: 320,        // 飞到某颗星时的相机距离
    flyEase: 0.0015          // 越小越快（每秒剩余比例）
  },
  pulse: {
    flareDecay: 1.6,         // 星点闪耀衰减（秒）
    flareGain: 2.4,          // 闪耀亮度倍数
    beadSpeed: 0.9,          // 光点沿连线移动速度（段/秒）
    beadSize: 18,
    fromCore: true,          // 召回时先从核心射出一道光到该星
    maxBeads: 160,
    kindColors: { recall: '#ffe7a8', assoc: '#c9b6ff', spontaneous: '#7fe9ff', used: '#9dffc7', dream: '#d59bff', review: '#ffd9a8', search: '#ffffff' },
    kindLabels: { recall: '召回', assoc: '心流牵出', spontaneous: '自发想起', used: '真用到', dream: '梦里', review: '回顾', search: '搜索' }
  },

  // ---------- 思考动画（核心 → 焦点星 → 发散到相关星 → 回到焦点星 → 回到核心）----------
  // 两种主题都能用。真实召回（/activate、/recall）一来就播；没有真实召回时偶尔“走神”播一段（可关）。
  think: {
    enabled: true,           // 总开关
    speed: 1,                // 光点速度倍数；1 = 和现在召回 / 连线光点差不多快（越大越快）
    fanout: 4,               // 从焦点星发散到几颗相关星（真实召回时先用其他命中，不够再用共同标签 / 连线补）
    fanoutLowEnd: 2,         // 低配模式下的发散数
    maxConcurrent: 2,        // 同时最多几段“思考”在播（超出的真实事件排队，最多排 3 个，再多就丢掉最旧的）
    maxConcurrentLowEnd: 1,
    hold: 0.45,              // 光点到达焦点星 / 相关星后停顿多少秒再出发
    lineAlpha: 0.85,         // 路径连线最亮时的不透明度
    fadeSeconds: 1.2,        // 一段思考结束后连线淡出用时
    trail: 5,                // 光点拖尾长度（几个残影；低配自动减半）
    beadSize: 40,            // 思考光点大小（像素，随距离缩放）
    color: '#ffe3a6',        // 去程颜色（核心→焦点→相关）
    returnColor: '#f3cf8a',  // 回程颜色（相关→焦点→核心），默认偏金
    focalGlow: 1.8,          // 焦点星被点亮的亮度
    corePulse: 0.45,         // 回到核心时核心“咚”一下的放大幅度
    idle: true,              // 没有真实召回时，偶尔随机“走神”一次
    idleEverySec: 16,        // 走神平均间隔（秒，实际在 0.6～1.4 倍之间随机）
    idleQuietSec: 20,        // 最近一次真实召回之后多少秒内不走神
    idleWhenSelected: false, // 选中某颗星（看详情）时是否也走神；false = 不打扰你看（自动漫游时照常走神）
    caption: true,           // 显示一行很淡的小字「想起了：…」
    captionMs: 3600,         // 小字停留时间
    idleCaption: false,      // 走神时也显示小字（默认只在真实召回时显示）
    pollMs: 2500,            // 真实模式下轮询 /api/think 的间隔
    replaceRecallFlight: true, // 有思考动画时，不再重复播放旧的「核心→星」召回飞线（星点闪光和左上角提示照旧）
    fromPulses: true,        // 后端太旧没有 /api/think 时，退回用 /pulses 里同一时刻的召回脉冲拼出一次思考
    mockEverySec: 11         // 演示数据模式下，大约每隔多少秒模拟一次召回（约 70% 概率触发）
  },

  // ---------- 界面 ----------
  ui: {
    gold: '#f6d38b', ink: '#eef4ff', mute: '#9fb3c8', teal: '#7fe0c8',
    glassBlur: 22,           // 玻璃面板模糊度 px
    cardWidth: 330,          // 右下角详情卡宽度
    sheetWidth: 420,         // 右侧详情面板宽度
    workbenchWidth: 760,     // 工作台面板宽度（桌面端）
    toastMs: 2600
  },

  // ---------- 情绪 / 激素 / 身体曲线颜色 ----------
  charts: {
    emotion: { '开心': '#ffd36e', '委屈': '#8fb8ff', '生气': '#ff7a7a', '想念': '#ff9ec4', '安心': '#7fe0c8', '害羞': '#ffb0d9', '吃醋': '#c9a0ff', '疲惫': '#9fb3c8' },
    hormones: { '多巴胺': '#ffd36e', '催产素': '#ff9ec4', '皮质醇': '#ff7a7a', '血清素': '#7fe0c8', '肾上腺素': '#ffb38a', '内啡肽': '#c9b6ff' },
    body: { wetness: '#ff8fa3', emptiness: '#ffb38a', sensitivity: '#ff9ec4', edge: '#ff5c7a', desire: '#ff6f91', fluids: '#9fd8ff', stim: '#ffd36e' },
    bodyLabels: { wetness: '兴奋度', emptiness: '失落感', sensitivity: '敏感度', edge: '临界', desire: '欲望', fluids: '余温', stim: '刺激' }  // 18+ 身体指标（默认关闭）
  }
};
