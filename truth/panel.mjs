/**
 * truth/panel.mjs — 「状态看得全 + 改得动」的唯一清单。
 *
 * 旧版的真实数字（这就是要说清楚的问题）：
 *   169 个配置键，面板只能改 **26 个（15%）**，剩下 143 个只能去开 config.json；
 *   169 个键里 **134 个连中文名都没有**（只有 35 个有 label），面板当然没法展示；
 *   后端 63 条路由，面板只接了 38 条 —— 有接口、没界面。
 *
 * 所以「能不能看清楚状态」不是 UI 问题，是**清单问题**：东西没登记，就永远漏。
 *
 * 做法：把每个「能看的」和「能改的」都声明成一条记录，面板只从这个数组渲染。
 *   漏登记 → `coverage()` 报错 → `npm test` 红。结构上不可能再出现死接口。
 *
 * 每个条目必须回答三个问题：
 *   1. 这是什么（label + hint）
 *   2. 能不能改（level：live 即时 / restart 要重启 / readonly 只读）
 *   3. 改坏了怎么办（risk：high 必须二次确认 + 写审计）
 */

import { DOMAIN_IDS } from './taxonomy.mjs'

/** 生效时机。用户最容易被坑的一点：改完没反应，其实是没重启 */
export const LEVEL = Object.freeze({
  LIVE: 'live', // 下一次行为就用新值
  RESTART: 'restart', // 要重启 DSH 才生效
  READONLY: 'readonly', // 只能看
})

/** 改动风险。high 一律弹二次确认，并写一条审计 */
export const RISK = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high' })

/**
 * 分组 = 「能改的东西」的唯一索引。
 *
 * 顺序跟着域走（身份 → 表达 → 心智 → 自主 → 能力 → 花费 → 运行），
 * 每个组必须声明 `domain`，且域名必须在 taxonomy.DOMAINS 里 —— 有用例钉住。
 * 设置页直接按这个顺序渲染，所以**不要再另写一份排序**。
 *
 * `status` 是唯一的只读组：它不进设置页，而是由概览的「运行状态」详情整表渲染。
 */
export const PANEL_GROUPS = Object.freeze([
  { id: 'status', label: '运行状态', desc: '只读。一眼看完运行状态，不用翻文件', domain: 'runtime' },
  { id: 'persona', label: '身份', desc: '它叫什么、什么人设、怎么称呼你', domain: 'identity' },
  { id: 'guard', label: '说话的节奏', desc: '多久回一次、什么时候不该回', domain: 'speech' },
  { id: 'memory', label: '记忆', desc: '记多少、多久总结、能不能改自己', domain: 'cognition' },
  { id: 'evolve', label: '学习', desc: '它怎么从结果里学到东西；改坏了能回滚', domain: 'cognition' },
  { id: 'activity', label: '自主活动', desc: '没人叫的时候它自己做什么、什么时候主动开口', domain: 'autonomy' },
  { id: 'skills', label: '技能', desc: '最多教几个、连续失败几次自动关', domain: 'capability' },
  { id: 'tools', label: '能力开关', desc: '哪些工具能调、联网能去哪、浏览器与图片', domain: 'capability' },
  { id: 'sandbox', label: '沙箱', desc: '自治档位、预算、熔断、工作区', domain: 'capability' },
  { id: 'usage', label: '花费', desc: 'token、单价、日预算', domain: 'budget' },
  { id: 'model', label: '模型', desc: '用哪个模型回话；留空就跟着宿主当前选择', domain: 'runtime' },
  { id: 'channel', label: 'QQ 连接', desc: '连哪个协议端、怎么登录', domain: 'runtime' },
  { id: 'ops', label: '日志与排障', desc: '日志级别、脱敏', domain: 'runtime' },
])

/**
 * 现在还没有执行器的开关。
 *
 * 这些键写在配置里、摆在面板上，但对应的功能还没接上：用户改了它们，
 * 行为上不会发生他期待的那件事。它不一定「没人读」—— 有的键读了，
 * 只是读它的那一段本身还没做完（比如 mergeWindowMs 只打标签、不合并）。
 *
 * 为什么要把这件事显式说出来，而不是装作没看见：
 *   面板最伤人的不是「功能少」，是「看起来能改，改完没反应」。
 *   不知道的人会以为是自己填错了，反复试，最后对整个面板失去信任。
 *
 * 这份清单由 `scripts/check-config-consumers.mjs` 扫源码对账；
 * 接了执行器却忘了从这里删 → 面板会一直标「暂不生效」，用户白等一场。
 */
export const PENDING_KEYS = Object.freeze([
])

/** 这一项现在改了有没有用 */
export function isPending(key) {
  return PENDING_KEYS.includes(key)
}

// 分组声明错误要在模块加载时就炸，而不是等某次用例：
// 一个拼错的 domain 会让设置页那张卡永远显示「未分类」，而不会报错。
for (const group of PANEL_GROUPS) {
  if (!DOMAIN_IDS.includes(group.domain)) {
    throw new Error(`面板分组「${group.id}」的 domain 不认识：${group.domain}`)
  }
}

// ── 简写：一行一条，避免 80 条各自写六行 ──────────────────────────
const num = (key, label, group, extra = {}) => ({ key, label, group, kind: 'number', level: LEVEL.LIVE, risk: RISK.LOW, ...extra })
const bool = (key, label, group, extra = {}) => ({ key, label, group, kind: 'bool', level: LEVEL.LIVE, risk: RISK.LOW, ...extra })
const text = (key, label, group, extra = {}) => ({ key, label, group, kind: 'text', level: LEVEL.LIVE, risk: RISK.LOW, ...extra })
const oneOf = (key, label, group, options, extra = {}) => ({
  key, label, group, kind: 'enum', options, level: LEVEL.LIVE, risk: RISK.LOW, ...extra,
})
const ro = (key, label, group, extra = {}) => ({ key, label, group, kind: 'readonly', level: LEVEL.READONLY, risk: RISK.LOW, ...extra })
const list = (key, label, group, extra = {}) => ({ key, label, group, kind: 'list', level: LEVEL.LIVE, risk: RISK.LOW, ...extra })

/** 全部条目。新增配置必须同时在这里登记，否则 coverage() 会报缺。 */
const RAW_ITEMS = [
  // ── 运行状态（只读）─────────────────────────────────────────────
  // 这一组的每一条都必须能被 `runtime.status()` 真的算出来 ——
  // 登记了却永远填不上的项，等于在面板上留一个「—」，用户还以为是自己没配好。
  // 有用例逐键对账：登记的键集合必须与 status() 返回的键集合完全一致。
  ro('status.version', '版本', 'status', { source: 'health', hint: '当前运行的代码版本' }),
  ro('status.channel', 'QQ 通道', 'status', { source: 'health', hint: '关闭 / 未连接 / 等扫码 / 在线 / 掉线' }),
  ro('status.uptime', '已运行', 'status', { source: 'runtime', format: 'duration', hint: '这次启动到现在' }),
  ro('status.todayMessages', '今日收发', 'status', { source: 'runtime', format: 'count', hint: '收到 + 发出，不含心跳与通知' }),
  ro('status.todayTokens', '今日 token', 'status', { source: 'usage', format: 'count', hint: '今天所有生成消耗的输入与输出' }),
  ro('status.totalTokens', '累计 token', 'status', { source: 'usage', format: 'count', hint: '从账本第一天到现在，一共消耗了多少 token' }),
  ro('status.todayCost', '今日花费', 'status', { source: 'usage', format: 'money' }),
  ro('status.budget', '每天预算', 'status', { source: 'usage', format: 'money', hint: '0 表示不设上限' }),
  ro('status.balance', '预算还剩', 'status', { source: 'usage', format: 'money', hint: '按日预算算的可用余额，不是账户余额；没设预算时为空' }),
  ro('status.memoryCount', '记忆条数', 'status', { source: 'memory', format: 'count', hint: '记住的事实条数' }),
  ro('status.people', '认识的人', 'status', { source: 'memory', format: 'count', hint: '有档案的人有几个' }),
  ro('status.stickers', '表情收藏', 'status', { source: 'stickers', format: 'count', hint: '收藏了多少张表情' }),
  ro('status.activityToday', '今日自主活动', 'status', { source: 'activity', format: 'count', hint: '没人叫的时候它自己做了几次事' }),
  ro('status.sandboxToday', '今日沙箱运行', 'status', { source: 'sandbox', format: 'count', hint: '没接上时显示「—」，不是 0' }),
  ro('status.sandboxFuse', '熔断状态', 'status', { source: 'sandbox', hint: '正常 / 已熔断（还有多久）' }),
  ro('status.auditCount', '审计条数', 'status', { source: 'journal', format: 'count', hint: '谁改了什么、哪次被拒，都在这里' }),
  ro('status.auditSpan', '审计可追溯', 'status', { source: 'journal', format: 'span', hint: '能往回翻多久' }),
  ro('status.cotCount', '思维链条数', 'status', { source: 'journal', format: 'count' }),
  ro('status.behaviorCount', '行为记录数', 'status', { source: 'journal', format: 'count', hint: '回话 / 主动 / 活动各做了多少次' }),
  ro('status.evolveVersion', '说话方式的调整', 'status', { source: 'evolve', format: 'count', hint: '从开始到现在调过几版，明细在「学习」里' }),
  ro('status.evolveCount', '调整过几次', 'status', { source: 'evolve', format: 'count' }),
  // 这一项存在的唯一目的：让「改了没反应」变成一句明确的话，而不是让用户自己犯嘀咕
  ro('status.pendingConfig', '现在改了也没用的项', 'status', {
    source: 'panel',
    format: 'count',
    hint: `这些项现在改了不会生效（对应的功能还没写），共 ${PENDING_KEYS.length} 项，清单在 PENDING_KEYS`,
  }),
  // 技能这三项是「一句话说得清它行不行」的数字。明细在技能页，不塞进状态表，
  // 否则状态页又变成一张读不完的表。
  ro('status.skillOn', '现在会几项', 'status', { source: 'skill', format: 'count', hint: '算上教的，不含用不了的' }),
  ro('status.skillLearned', '练熟了几项', 'status', { source: 'skill', format: 'count', hint: '做过 3 次以上且成功过半才算会' }),
  ro('status.skillBlocked', '几项用不了', 'status', { source: 'skill', format: 'count', hint: '点进技能页看是哪一项、缺什么' }),
  // 和上一项分开显示，是因为这两件事的应对完全不同：
  // 「还没接上」只能等更新；「权限不够」点两下就好。
  ro('status.skillNotWired', '其中几项还没接上', 'status', { source: 'skill', format: 'count', hint: '底层能力还没写，不是你设置错了，等更新就行' }),
  // 防复读的自检数字。摆出来不是为了好看，是为了让「它最近话变少了」能被看见 ——
  // 复读只是有点机械，不回应是直接失功能。数字涨上去就得查。
  ro('status.dedupeSkipped', '拦下的复读', 'status', { source: 'journal', format: 'count', hint: '同一句话刚说过又说，被挡住了；一般是 0' }),

  // ── 身份与人设 ────────────────────────────────────────────────
  text('persona.name', '名字', 'persona', { maxLen: 24 }),
  text('persona.persona', '人设正文', 'persona', { multiline: true, maxLen: 20_000, risk: RISK.MEDIUM, hint: '改这段会直接改变说话方式' }),
  // 「话多话少」是倾向，不是字数上限。
  // 为什么不再有「每条最多几个字」：那个旋钮有两处坏处 ——
  //   1. 键名对不上（面板写 maxReplyChars，运行时读 partChars），一直空转；
  //   2. 更要命的是它把「说话长短」变成了硬指标：模型会开始凑那个字数，
  //      于是每条都一样长 —— 那不是人，是节拍器。
  // 现在只给倾向：简短 / 正常 / 爱聊。真正断句交给语义层（换行 + 站得住的逗号）。
  oneOf('persona.verbosity', '话多话少', 'persona', ['brief', 'normal', 'chatty'], {
    optionLabels: { brief: '简短', normal: '正常', chatty: '爱聊' },
    hint: '只改说话倾向，不设字数上限：他想说多长说多长',
  }),
  // 范围必须等于「真能生效的范围」：进化模块把上限钳到 4，面板写 8 就是在骗人
  num('persona.maxParts', '一次最多几条', 'persona', {
    min: 1,
    max: 4,
    step: 1,
    hint: '这是上限。他/她学到习惯之后，实际可能比这个少',
  }),
  text('identity.ownerName', '我的称呼', 'persona', { maxLen: 24 }),

  // ── 模型 ──────────────────────────────────────────────────────
  // 留空是**合法**的：留空 = 跟着宿主当前对话用的模型走。
  // 但宿主一个模型都没选时，这里是唯一能救场的地方 —— 所以它必须在界面上，
  // 而不是像以前那样只活在错误提示里（提示让人去填，填了又被 migrate 丢掉）。
  bool('modelFollowDefault', '默认跟随 deepseek-account / deepseek-flash', 'model', {
    hint: '开启时下面两项不生效，固定用默认档；关闭后才按下面两项。两项都留空 = 跟随宿主当前对话模型',
  }),
  text('modelProvider', '模型提供方', 'model', {
    placeholder: '留空 = 跟随当前对话；没有对话模型时用 deepseek-account',
    hint: '关闭「默认跟随」后才生效；要和下面那一项一起填，只填一个按「没填」处理',
  }),
  text('model', '模型名', 'model', {
    placeholder: '留空 = 跟随当前对话；没有对话模型时用 deepseek-flash',
    hint: '写模型自己的名字（例如 deepseek-chat）。默认档：deepseek-account / deepseek-flash；填错不会崩，但每次生成都会失败并说明原因',
  }),

  // ── QQ 连接 ───────────────────────────────────────────────────
  bool('channel.enabled', '启用 QQ 通道', 'channel'),
  bool('channel.autoStartNapcat', '开机自启 NapCat', 'channel', { hint: '开启后登录 Windows 自动运行启动脚本；关闭后需手动双击' }),
  text('channel.napcatBat', 'NapCat 启动脚本', 'channel', { placeholder: 'E:\\深蓝鲸\\启动NapCat.bat' }),
  bool('channel.watchdogEnabled', '掉线自愈', 'channel', { hint: '掉线超过设定时间：先重连；仍离线且不在等扫码时，重启协议端（每小时最多 2 次，不碰你的 QQ 客户端）' }),
  num('channel.watchdogMinutes', '掉线多久后处理', 'channel', { min: 1, max: 60, unit: '分钟', hint: '默认 2 分钟；正在等扫码时不会重启' }),
  text('channel.wsUrl', 'OneBot 地址', 'channel', { level: LEVEL.RESTART, placeholder: 'ws://127.0.0.1:3001' }),
  text('channel.token', 'OneBot 令牌', 'channel', { secret: true, level: LEVEL.RESTART, hint: '只显示「已配置 / 未配置」' }),
  text('channel.selfId', '我的 QQ 号（深蓝）', 'channel', { level: LEVEL.RESTART, hint: '深蓝自己登录的号。留空 = 自动跟随 QQ 桥当前登录的号；填了就必须和协议端登录号一致，否则认不出自己的发言' }),
  text('identity.ownerId', '用户 QQ 号（主人）', 'channel', { risk: RISK.HIGH, hint: '深蓝认准这个号是主人：私聊、指令、撤回确认都靠它。填用户自己的号，不是深蓝的号' }),
num('channel.maxOutputTokens', '单次最多生成多少 token', 'channel', { min: 256, max: 8000, step: 64, unit: 'token', hint: '思考也算在内；太小会把正文挤没，出现「只想不说」' }),
num('channel.turnTimeoutMs', '等模型多久', 'channel', { min: 10_000, max: 180_000, step: 5_000, unit: '毫秒', format: 'ms', hint: '超时不再弹「没做成」，改用一句人话兜底' }),
  oneOf('channel.login.mode', '登录方式', 'channel', ['ticket', 'password', 'qr'], {
    hint: '票据优先：扫一次后不用再扫；密码只在票据失效时兜底；扫码每次都要扫。改完立即生效',
  }),
  bool('channel.login.autoQr', '票据失效时自动出二维码', 'channel', {
    hint: '关掉后票据失效不会自动出码，要你在「QQ 连接」里点「改用扫码」才出',
  }),
  bool('qzone.enabled', '允许发 QQ 空间说说', 'channel', { hint: '打开后，主人可以说“发条说说”，也可由模型调用 qzone_post；默认关闭' }),
  num('qzone.dailyLimit', '每天最多发几条说说', 'channel', { min: 0, max: 10, unit: '条', hint: '0 = 不发；默认 2' }),
  text('channel.login.password', 'QQ 密码（密码方式用）', 'channel', {
    secret: true,
    hint: '只用于密码方式；存在本机 config.json，不会写进日志。也可填 32 位 MD5。留空表示不修改',
  }),

  // ── 说话的节奏 ────────────────────────────────────────────────
  num('guard.replyQuotaPerHour', '每群每小时最多回几条', 'guard', { min: 1, max: 200, hint: '按回复算，不按气泡；一句话拆三条只占一条' }),
  num('guard.perMinute', '每个会话每分钟最多回几条', 'guard', { min: 1, max: 60, hint: '按回复算，不按气泡；一个群刷屏不影响私聊和别的群' }),
  num('group.followUpSeconds', '群聊接话窗口', 'guard', { min: 30, max: 600, unit: '秒', hint: '同一个人接着说的窗口：窗口内不 @ 也接；只对群聊生效' }),
  num('group.followUpMaxTurns', '群聊最多接几轮', 'guard', { min: 1, max: 20, unit: '轮', hint: '同一个人连续接话到上限就关窗，等下一个人 @ 或起新话题' }),
  bool('group.attentionModelJudge', '换人接话时多问一次模型', 'guard', { hint: '旧窗口还热、但快判据拿不准时，用小模型确认对方是不是在接深蓝；关掉则按原规则不接' }),
  num('group.followUpChance', '群聊接话概率', 'guard', { min: 0, max: 100, step: 5, unit: '%', hint: '命中续聊标签后，按这个概率决定要不要接下一句' }),
  list('group.interests', '感兴趣的内容', 'guard', { hint: '一行一个词；按概念匹配，不要求原词，比如「游戏」也会认出手游、开黑、副本' }),
  num('guard.firstDelayMs', '首条等待下限', 'guard', { min: 0.3, max: 30, step: 0.5, unit: '秒', scale: 1000, hint: '打字台算出的等待不会低于这个值；长回复会更久' }),
  num('guard.minGapMs', '两条之间至少隔多久', 'guard', { min: 0.3, max: 10, step: 0.1, unit: '秒', scale: 1000, hint: '两条之间、以及分条之间都守这条下限' }),
  num('guard.mergeWindowMs', '连发合并窗口', 'guard', {
    min: 0,
    // 0 = 关掉合并（有意义）；非零的话不能低于 0.3 秒。
    // 2 毫秒那种脏值会让它秒回连发，正是最该拦的。
    minPositive: 0.3,
    max: 30,
    step: 0.5,
    unit: '秒',
    scale: 1000,
    // 0 是有意义的：等于关掉合并，群里每条消息都单独回。
    // 下限必须是 0 ——「关掉某个功能」得真的能关掉，
    // 最小 0.3 秒的话，用户看到 0.3 以为关了，其实还在合并。
    hint: '同一个人在群里连着发的几条，攒这么久当成一件事回一次；设 0 就不合并。',
  }),
  text('guard.nightWindow', '夜间不打扰', 'guard', {
    placeholder: '23:00-07:00',
    hint: '只压群聊和非主人私聊；主人私聊不受这个窗口影响，凌晨也会回。',
    // 没有格式约束的话，填错了不会报错，只是「夜间静音悄悄失效」—— 最难查的一种
    pattern: /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/,
    patternHint: '23:00-07:00',
  }),

  // ── 记忆与自我 ────────────────────────────────────────────────
  bool('memory.enabled', '长期记忆', 'memory'),
  num('memory.maxEntries', '最多记多少条', 'memory', { min: 100, max: 100_000, step: 100 }),
  num('memory.summaryEvery', '多少条总结一次', 'memory', { min: 20, max: 2000, step: 10 }),
  list('memory.crossGroups', '允许跨群记忆的群号', 'memory', { hint: '留空＝不跨群。只在主人私聊里参考这些群最近的话题，不会把 A 群的话带回 B 群' }),
  num('memory.crossGroupHours', '跨群记忆看最近几小时', 'memory', { min: 1, max: 72, unit: '小时' }),
  num('memory.net.entries', '检索从几个入口进', 'memory', { min: 1, max: 6 }),
  num('memory.net.hops', '最多跳几层', 'memory', { min: 1, max: 12 }),
  num('memory.net.decay', '每跳衰减', 'memory', { min: 0.5, max: 1, step: 0.01 }),
  bool('self.enabled', '允许改自己的自我认知', 'memory'),
  num('self.rewriteCooldownHours', '两次自改间隔', 'memory', { min: 1, max: 720, format: 'hours' }),

  // ── 自己安排的事 ──────────────────────────────────────────────
  bool('activity.enabled', '自主活动', 'activity'),
  num('activity.tickMinutes', '多久想一次', 'activity', { min: 5, max: 240, format: 'minutes' }),
  num('activity.maxPerDay', '一天最多几次', 'activity', { min: 0, max: 200 }),
  bool('proactive.enabled', '主动开口', 'activity'),
  num('proactive.intervalMinutes', '隔多久主动一次', 'activity', { min: 30, max: 1440, unit: '分钟' }),
  // 主动开口的节奏改成随机区间。下面两个是区间的上下限：
  // 固定间隔（上面那个）最容易暴露机器 —— 主人看两天时间就知道它准时报时。
  num('proactive.minGapMinutes', '最快隔多久', 'activity', { min: 10, max: 720, unit: '分钟', hint: '每次主动开口的间隔在这段里随机抽，不会准时报时' }),
  num('proactive.maxGapMinutes', '最慢隔多久', 'activity', { min: 20, max: 1440, unit: '分钟', hint: '要大于「最快隔多久」' }),
  num('proactive.startHour', '从几点开始', 'activity', { min: 0, max: 23, unit: '点' }),
  num('proactive.endHour', '到几点结束', 'activity', { min: 0, max: 23, unit: '点' }),
  num('proactive.perDay', '一天最多主动几次', 'activity', { min: 0, max: 20, unit: '次' }),
  oneOf('proactive.scene', '主动的场景', 'activity', ['general', 'morning', 'night', 'care'], { optionLabels: { general: '随便', morning: '早上', night: '深夜', care: '关心' } }),
  bool('proactive.hotNews', '看到热点主动分享', 'activity'),
  num('proactive.hotNewsHours', '热点最少间隔', 'activity', { min: 1, max: 24, unit: '小时' }),
  bool('proactive.dailyDigest', '每日简报', 'activity'),
  bool('proactive.morningBackfill', '早上补回昨晚的消息', 'activity'),
  bool('proactive.coldTopic', '冷群找个话题', 'activity'),
  bool('proactive.nameCall', '被叫名字就应一声', 'activity'),

  // ── 进化与权重 ────────────────────────────────────────────────
  bool('evolve.enabled', '允许从结果里学', 'evolve', { hint: '关掉就固定用现在的权重，不再自己调' }),
  num('evolve.window', '每多少回合算一次', 'evolve', { min: 5, max: 200 }),
  num('evolve.ema', '学得多快', 'evolve', { min: 0.01, max: 0.5, step: 0.01, hint: '越大越信这一次的结果，越小越稳' }),
  num('evolve.clamp', '单次最多调多少', 'evolve', { min: 0.01, max: 1, step: 0.01, hint: '防止一次偶然把权重带偏' }),
  num('evolve.keepVersions', '保留多少版可回滚', 'evolve', { min: 1, max: 500 }),

  // ── 技能 ──────────────────────────────────────────────────────
  // 技能的四个数字在「运行状态」组里（它们本来就是状态），
  // 这里只放「能改的两个旋钮」。同一个键不许登记两次 —— 有用例钉住 key 唯一。
  num('skills.autoOffAfterFails', '连续失败几次就自动关掉', 'skills', {
    min: 0,
    max: 10,
    hint: '0 = 不自动关。一直失败还硬撑，比不会更糟',
  }),
  num('skills.maxTaught', '最多能教几个', 'skills', { min: 1, max: 200, hint: '太多会看不过来，60 左右够用' }),

  // ── 能力开关 ──────────────────────────────────────────────────
  bool('browser.headless', '浏览器无头模式', 'tools', { hint: '关掉会弹出可见浏览器窗口' }),
  text('browser.path', '浏览器程序', 'tools', {
    placeholder: '留空 = 自动找本机 Chrome / Edge',
    hint: '便携版或装在别处的浏览器填这里（选到 .exe）；留空时按常见安装位置找',
  }),
  text('browser.cdpUrl', '浏览器 CDP 地址', 'tools', {
    placeholder: '留空 = 自己起一个；填了就接到已有实例',
    hint: '留空时它自己起一个浏览器；填 http://127.0.0.1:9222 这类地址就复用你已开着的那个',
  }),
  num('browser.idleMinutes', '浏览器空闲关闭', 'tools', { min: 1, max: 120 }),
  num('browser.maxPerHour', '每小时最多开几次', 'tools', { min: 1, max: 300 }),
  bool('browser.allowPrivate', '允许访问内网地址', 'tools', { risk: RISK.HIGH, hint: '关掉更安全，别让浏览器访问 127.0.0.1/局域网' }),
  num('images.maxPerMessage', '单条最多识别几张图', 'tools', { min: 1, max: 4, unit: '张' }),
  num('images.maxBytes', '单张图片大小上限', 'tools', { min: 1, max: 20, unit: 'MB', scale: 1_000_000 }),

  // 这两个「留空」的含义是相反的，文案必须写清，不然用户配了也不知道为什么上不了网
  list('tools.whitelist', '允许他/她调用的工具', 'tools', {
    hint: '留空 = 全部允许（宽松）。想收紧就一行写一个，只有写上的能用',
  }),
  num('tools.maxRounds', '查得多仔细', 'tools', { min: 0, max: 24, unit: '次', hint: '一轮最多追问几次；0 = 不限（靠日预算和原地打转判定收口）' }),
  num('tools.maxPerRound', '一次能办几件事', 'tools', { min: 1, max: 8, unit: '件', hint: '一件事要分几步办时，一次能同时做几步' }),
  list('net.allowlist', '联网白名单', 'tools', {
    hint: '留空＝全部不许。优先放行 www.google.com（搜索默认先走谷歌）；也可加 cn.bing.com、www.baidu.com 兜底。改完立即生效，可在「数据与调试 → 联网开关试一次」验证',
  }),
  num('net.quotaPerHour', '每小时联网次数', 'tools', { min: 0, max: 500, hint: '每小时最多发几次联网请求，0＝不许联网；改完立即生效，不用重启' }),

  // ── 沙箱 ────────────────────────────────────────────────────
  oneOf('sandbox.mode', '自治档位', 'sandbox', ['free', 'ask', 'off'], {
    risk: RISK.HIGH,
    hint: '自由度越高越能干，也越容易闯祸。改这里等于改他/她能不能自己动手',
  }),
  num('sandbox.hourlyMax', '每小时最多跑几次', 'sandbox', { min: 0, max: 100 }),
  num('sandbox.dailyMax', '每天最多跑几次', 'sandbox', { min: 0, max: 500 }),
  num('sandbox.timeoutMs', '单次超时', 'sandbox', { min: 1000, max: 120_000, step: 1000, format: 'ms' }),
  num('sandbox.memMb', '内存上限', 'sandbox', { min: 64, max: 2048, step: 64, format: 'mb' }),
  num('sandbox.maxCodeBytes', '代码长度上限', 'sandbox', { min: 512, max: 65536, step: 512 }),
  num('sandbox.fuseAfter', '连续几次越界就熔断', 'sandbox', { min: 1, max: 10 }),
  num('sandbox.fuseHours', '熔断多久', 'sandbox', { min: 1, max: 168, format: 'hours' }),
  num('sandbox.confirmSeconds', '确认等多久', 'sandbox', {
    min: 10,
    max: 300,
    step: 5,
    format: 'seconds',
    hint: '「先问我」档弹窗里的倒计时。走完没人点，按拒绝处理',
  }),
  oneOf('sandbox.codeMode', '改代码档位', 'sandbox', ['off', 'read', 'write'], {
    risk: RISK.HIGH,
    hint: '他/她动不动得了自己这套源码：read 只能看和搜，write 才能改文件、跑命令（改前会备份，但关键启动文件仍要点头）。这是「在沙箱里跑」之外的另一道闸 —— 跑坏了是一次失败，改坏了是起不来',
  }),

  // ── 花费 ──────────────────────────────────────────────────────
  oneOf('usage.currency', '货币', 'usage', ['CNY', 'USD']),
  num('usage.inputPerM', '输入价（每百万）', 'usage', { min: 0, max: 1000, step: 0.1 }),
  num('usage.outputPerM', '输出价（每百万）', 'usage', { min: 0, max: 1000, step: 0.1 }),
  num('usage.budgetPerDay', '每天预算', 'usage', { min: 0, max: 10_000, step: 1, risk: RISK.MEDIUM, hint: '0 = 不限' }),

  // ── 运维 ──────────────────────────────────────────────────────
  // 日志分成两套口径，六个键：
  //   log.level / log.echo   —— 「终端看什么」（当场排障用）
  //   log.auditLevel / auditKinds / auditNoise —— 「审计页看什么」（事后追查用）
  //   log.redact             —— 出站脱敏
  // 前者调高只让人少看，后者调高只让页少显示：**磁盘上的审计一条都不会少**。
  // 这一条必须写在 hint 里，否则用户会以为「调成只看错误 = 以后只记错误」。
  oneOf('log.level', '终端日志级别', 'ops', ['error', 'warn', 'info', 'debug'], {
    hint: '只管打到宿主控制台的行。调到「只看错误」后常规日志不再刷屏 —— 审计不受影响，一条都不会少',
  }),
  bool('log.echo', '审计也打到终端', 'ops', {
    hint: '关着时终端只有插件自己的几行；打开后每条审计按严重度打到终端，排障能一行行看它做了什么。很吵，平时关着',
  }),
  oneOf('log.auditLevel', '审计页显示级别', 'ops', ['error', 'warn', 'info', 'debug'], {
    hint: '只决定审计页**显示**哪些：选「错误与警告」就看不到常规改动。磁盘上的记录一条不少',
  }),
  list('log.auditKinds', '审计只看这些类型', 'ops', {
    hint: '一行一个类型名，支持通配（例如 skill_*）；留空 = 全部类型。和上面的级别是「都要满足」，不是二选一',
  }),
  bool('log.auditNoise', '折叠高频噪音', 'ops', {
    hint: '通道状态、心跳这类一天两万行的记录默认不显示；关掉就一条不落地全列出来。原始记录一直都在',
  }),
  bool('log.redact', '日志脱敏', 'ops', { risk: RISK.HIGH, hint: '关掉会把密钥写进日志，只在排障时临时关' }),
]

/**
 * 数字项的单位。
 *
 * 面板上写「300」是没法用的：300 毫秒还是 300 秒？300 条还是 300 次？
 * 用户填错一次，就要在「怎么没反应」里泡半天。所以单位必须跟着数字一起显示。
 * 这里用一张表而不是散在每条里，是为了能用一条用例扫描「有没有漏标单位的数字项」。
 */
const UNITS = Object.freeze({
  'persona.maxParts': '条',
  'guard.replyQuotaPerHour': '条/小时',
  'guard.perMinute': '条/分钟',
  'group.followUpSeconds': '秒',
  'group.followUpMaxTurns': '轮',
  'group.followUpChance': '%',
  'group.interests': '词条',
  'guard.firstDelayMs': '秒',
  'guard.minGapMs': '秒',
  'guard.mergeWindowMs': '秒',
  'memory.maxEntries': '条',
  'memory.summaryEvery': '条',
  'memory.net.entries': '个入口',
  'memory.net.hops': '层',
  'memory.net.decay': '倍',
  'self.rewriteCooldownHours': '小时',
  'activity.tickMinutes': '分钟',
  'activity.maxPerDay': '次/天',
  'evolve.window': '个回合',
  'evolve.ema': '倍',
  'evolve.clamp': '倍',
  'evolve.keepVersions': '版',
  'skills.autoOffAfterFails': '次',
  'skills.maxTaught': '个',
  'net.quotaPerHour': '次/小时',
  'browser.idleMinutes': '分钟',
  'browser.maxPerHour': '次/小时',
  'images.maxPerMessage': '张',
  'images.maxBytes': 'MB',
  'sandbox.hourlyMax': '次/小时',
  'sandbox.dailyMax': '次/天',
  'sandbox.timeoutMs': '毫秒',
  'sandbox.memMb': 'MB',
  'sandbox.maxCodeBytes': '字节',
  'sandbox.fuseAfter': '次',
  'sandbox.fuseHours': '小时',
  'sandbox.confirmSeconds': '秒',
  'usage.inputPerM': '元/百万 token',
  'usage.outputPerM': '元/百万 token',
  'usage.budgetPerDay': '元/天',
})

/**
 * 枚举项的档位名。
 *
 * 存的是 free / ask / off 这种机器值，显示必须是「自由（不问就动手）」这种话。
 * 直接把机器值摆给人看，等于让人猜 —— 而这几项恰好都是改错会出事的高危项。
 */
const OPTION_LABELS = Object.freeze({
  'channel.login.mode': Object.freeze({
    ticket: '票据（沿用协议端已登录的号，扫一次后不再扫）',
    password: '密码（票据失效时兜底）',
    qr: '扫码（每次都扫）',
  }),
  'sandbox.mode': Object.freeze({
    free: '自由：不问就动手',
    ask: '先问我：每次都要点头',
    off: '关掉：不许在沙箱里跑',
  }),
  'sandbox.codeMode': Object.freeze({
    off: '关掉：不许看自己的代码',
    read: '只读：能看能搜，改不了',
    write: '可写：能改文件、能跑命令',
  }),
  'usage.currency': Object.freeze({
    CNY: '人民币（元）',
    USD: '美元（$）',
  }),
  'log.level': Object.freeze({
    error: '只记错误',
    warn: '错误与警告',
    info: '常规信息',
    debug: '调试细节（很吵）',
  }),
  // 审计页的档位说法要和终端分开：「记」和「显示」是两件事，
  // 沿用同一套文案会让人以为调这里等于少记。
  'log.auditLevel': Object.freeze({
    error: '只看错误',
    warn: '错误与警告',
    info: '常规（推荐）',
    debug: '全部（含心跳与通道状态）',
  }),
})

/**
 * 取一个枚举项的档位中文名。
 *
 * 为什么单独导出它，而不是让调用方自己再写一份：
 *   `panel-view.mjs` 曾经为 `sandbox.mode` 本地抄了一份一模一样的三行。
 *   抄一份的代价在改名时才现形 —— 「跑代码」改成「沙箱」那次，源码改了、
 *   面板那一组也改了，唯独这份抄的没跟着动，界面于是继续显示旧名，
 *   而排查时谁也不会先怀疑「同一句文案写在两个文件里」。
 *   同一句给人看的话只能有一个出处。
 *
 * @returns {object|null} 没配过专属档位名的返回 null（调用方自己决定兜底）
 */
export function optionLabelsOf(key) {
  return OPTION_LABELS[String(key || '')] || null
}

/**
 * 最终清单 = 原始条目 + 单位 + 档位名。
 * 不给需要改的调用方多一个参数：`unit` / `optionLabels` 读不到就是没有，不会报错。
 */
export const PANEL_ITEMS = Object.freeze(
  RAW_ITEMS.map((item) => {
    const unit = UNITS[item.key]
    const optionLabels = OPTION_LABELS[item.key]
    if (!unit && !optionLabels) return item
    return Object.freeze({
      ...item,
      ...(unit ? { unit } : {}),
      ...(optionLabels ? { optionLabels } : {}),
    })
  }),
)

/** 按分组取条目，顺序跟随 PANEL_GROUPS */
export function itemsOf(group) {
  return PANEL_ITEMS.filter((item) => item.group === group)
}

/** 可改的（live + restart） */
export function editable() {
  return PANEL_ITEMS.filter((item) => item.level !== LEVEL.READONLY)
}

/** 只读的（状态） */
export function readonlyItems() {
  return PANEL_ITEMS.filter((item) => item.level === LEVEL.READONLY)
}

/** 需要二次确认的 */
export function needsConfirm(key) {
  const item = find(key)
  return !!item && item.risk === RISK.HIGH
}

/** 改完要不要重启 */
export function needsRestart(key) {
  const item = find(key)
  return !!item && item.level === LEVEL.RESTART
}

export function find(key) {
  return PANEL_ITEMS.find((item) => item.key === key) || null
}

/** 给人看的一句话：这项改了会怎样 */
export function describe(key) {
  const item = find(key)
  if (!item) return `没有这一项：${key}`
  if (item.level === LEVEL.READONLY) return `${item.label}：只能看，改不了`
  const when =
    item.level === LEVEL.RESTART ? '保存后要重启才生效' : '保存后下一条消息就生效'
  const danger = item.risk === RISK.HIGH ? '；这一项影响很大，会先让你确认' : ''
  return `${item.label}：${when}${danger}`
}

/**
 * 改之前校验。宁可在这里拒，也别让一个脏值写进 config.json
 * @returns {{ ok: boolean, error?: string, value?: * }}
 */
export function validate(key, value) {
  const item = find(key)
  if (!item) return { ok: false, error: `没有这一项：${key}` }
  if (item.level === LEVEL.READONLY) return { ok: false, error: `${item.label} 是只读的` }

  if (item.kind === 'bool') {
    if (typeof value === 'boolean') return { ok: true, value }
    if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' }
    return { ok: false, error: `${item.label} 只能是开或关` }
  }

  if (item.kind === 'number') {
    // 布尔能隐式转成 0/1，true 变成「每分钟 1 条」这种事故必须在入口拦掉
    if (typeof value === 'boolean') return { ok: false, error: `${item.label} 要填数字，不是开关` }
    if (value === null || value === undefined || value === '') return { ok: false, error: `${item.label} 要填数字` }
    let n = Number(value)
    if (!Number.isFinite(n)) return { ok: false, error: `${item.label} 要填数字` }
    // 计数类一律取整：3.7 条消息没法发，写进提示词还会变成「分 2~3.7 条」
    const fractional = Number(item.step) > 0 && Number(item.step) < 1
    if (!fractional) n = Math.round(n)
    // 带 scale 的时长项：存的是毫秒、面板按秒显示，判定一律按存储单位。
    // 这里不猜「用户是不是填了秒」—— 猜错会把「想快点回」放大成「等 10 秒」，更难查。
    // 越界就如实拒绝：启动时由 migrate 兜回默认值，运行时由 guard.delay() 兜住下限。
    const suffix = item.unit ? ` ${item.unit}` : ''
    if (item.min !== undefined && (item.scale ? n / item.scale : n) < item.min) {
      return { ok: false, error: `${item.label} 不能小于 ${item.min}${suffix}` }
    }
    // minPositive：0 有特殊含义（表示「关掉这个功能」），
    // 但**非零**的值仍然有下限。
    //
    // 为什么需要它：合并窗口设成 0 是「不合并」，那是有意义的设置；
    // 但 2 毫秒不是「不合并」，那是脏数据 —— 秒回连发，正是最该拦的事。
    // 只看 min=0 的话两者都放行，脏数据就进了配置。
    if (item.minPositive !== undefined && n !== 0) {
      const scaled = item.scale ? n / item.scale : n
      if (scaled < item.minPositive) {
        return { ok: false, error: `${item.label} 要么填 0（关掉），要么不小于 ${item.minPositive}${suffix}` }
      }
    }
    if (item.max !== undefined && (item.scale ? n / item.scale : n) > item.max) {
      return { ok: false, error: `${item.label} 不能大于 ${item.max}${suffix}` }
    }
    return { ok: true, value: n }
  }

  if (item.kind === 'enum') {
    const s = String(value)
    if (!item.options.includes(s)) {
      return { ok: false, error: `${item.label} 只能是：${item.options.join(' / ')}` }
    }
    return { ok: true, value: s }
  }

  if (item.kind === 'list') {
    // 数组或「逗号 / 换行分开的文本」都收；统一成去空、去重的字符串数组
    const raw = Array.isArray(value)
      ? value
      : String(value === null || value === undefined ? '' : value).split(/[\n,，]/)
    const items = []
    for (const part of raw) {
      const one = String(part === null || part === undefined ? '' : part).trim()
      if (one && !items.includes(one)) items.push(one)
    }
    const maxItems = item.maxItems || 200
    if (items.length > maxItems) return { ok: false, error: `${item.label} 最多 ${maxItems} 项` }
    if (items.some((one) => one.length > 200)) return { ok: false, error: `${item.label} 里有一项太长了` }
    return { ok: true, value: items }
  }

  // text
  // undefined / null 不是「清空」，是没填。清空请传空字符串 ——
  // 否则一次手滑传 undefined 就会把夜间窗口改成空串，静音悄悄失效。
  if (value === undefined || value === null) return { ok: false, error: `${item.label} 要填内容（清空请给空字符串）` }
  const s = String(value).trim()
  if (item.maxLen && s.length > item.maxLen) {
    return { ok: false, error: `${item.label} 太长了（上限 ${item.maxLen} 字）` }
  }
  if (item.pattern && s && !item.pattern.test(s)) {
    return { ok: false, error: `${item.label} 格式不对，应像 ${item.patternHint || '示例'} 这样` }
  }
  return { ok: true, value: s }
}

/**
 * 覆盖率：配置里的键必须在清单里有登记，清单里也不许有配置里没有的键。
 * 挂进 `npm test`——这样「有接口没界面」这类问题会当场变红。
 *
 * @param {string[]} configKeys 扁平键，如 'guard.replyQuotaPerHour'
 */
export function coverage(configKeys) {
  const listed = new Set(PANEL_ITEMS.filter((item) => item.level !== LEVEL.READONLY).map((item) => item.key))
  const actual = new Set(configKeys)
  const missing = [...actual].filter((key) => !listed.has(key)).sort()
  const extra = [...listed].filter((key) => !actual.has(key)).sort()
  const total = actual.size || 1
  return {
    missing,
    extra,
    ratio: Number(((total - missing.length) / total).toFixed(4)),
    ok: missing.length === 0 && extra.length === 0,
  }
}

/** 面板顶部的一句话汇总，给总览页用 */
export function summary() {
  const all = PANEL_ITEMS.length
  const canEdit = editable().length
  const danger = PANEL_ITEMS.filter((item) => item.risk === RISK.HIGH).length
  const restart = PANEL_ITEMS.filter((item) => item.level === LEVEL.RESTART).length
  return {
    total: all,
    editable: canEdit,
    readonly: all - canEdit,
    highRisk: danger,
    needRestart: restart,
    line: `${all} 项状态全部可见，其中 ${canEdit} 项可以直接改；${restart} 项改完要重启，${danger} 项改动会先让你确认。`,
  }
}
