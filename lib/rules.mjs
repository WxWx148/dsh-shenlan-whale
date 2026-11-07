/**
 * lib/rules.mjs — 此刻生效的硬约束，一份给人看的清单。
 *
 * 为什么单独成文件（不是散在代码注释里）：
 *   1. 规则散在 typing / attention / behavior / turn / index 五处，
 *      用户问「现在到底按什么跑」，不该让他去读五个文件；
 *   2. 规则会过期，代码不会。把规则集中在这里，改代码时漏改一条，
 *      tests/rules.test.mjs 会当场报出来；
 *   3. 这里只写「现在是什么」，不写「以前是什么」——前后对比是变更看板的事，
 *      面板上只留此刻能照着做的规则。
 *
 * 每条规则四个字段：叫什么（title）、规则正文（rule）、落在哪个模块（module / where）、
 * 现场值（live，可选）。现场值由面板读当前配置算，不把数字写死在正文里，
 * 于是「规则」和「设置」不会各说一套。
 */

/** 分组顺序跟着一条消息的生命周期走：开口 → 进通道 → 判该不该回 → 发出去 → 怎么验 */
export const RULE_GROUPS = Object.freeze([
  { id: 'rhythm', label: '节奏与注意力', hint: '说话像不像人、在跟谁说话' },
  { id: 'channel', label: '通道与事件', hint: 'QQ 侧进来什么、出去什么' },
  { id: 'turn', label: '回合与路由', hint: '该不该回、回什么、怎么拆' },
  { id: 'outbound', label: '入口与出站', hint: '装配、统一出口、权限边界' },
  { id: 'tools', label: '工具链与元信息', hint: '工具怎么调、改完怎么验' },
])

import { pathOfSymbol } from './structure.mjs'

const secText = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return '—'
  return `${n % 1000 === 0 ? n / 1000 : (n / 1000).toFixed(1)} 秒`
}

const RAW_RULES = [
  // ── 节奏与注意力 ─────────────────────────────────────────────
  {
    id: 'typing.duration',
    group: 'rhythm',
    title: '打字时长按字数算',
    rule: '一条消息的等待 = 1.5 秒基础 + 每字 0.5 秒 + 0.3~1.2 秒抖动，再与 guard 的下限取大，最后夹在 200ms~15 秒；先加后夹，长回复不会绕过封顶。',
    parent: 'voice',
    symbol: 'typingDelayMs',
    where: 'typingDelayMs() / TypingDesk.typeOut()',
    live: (read) => `guard 下限 ${secText(read('guard.firstDelayMs'))}`,
  },
  {
    id: 'typing.serial',
    group: 'rhythm',
    title: '全局只有一条在打',
    rule: '私聊和群聊排同一队；排队超过 5 条后不再人为拖延，只保证串行，内容不丢。',
    parent: 'voice',
    symbol: 'TypingDesk',
    where: 'TypingDesk.#serial() / TYPING.queueMax',
  },
  {
    id: 'typing.gap',
    group: 'rhythm',
    title: '分条之间要留缝',
    rule: '模型自己 [split] 的段之间 1~3 秒，机器按字数切的段之间 0.5~1.4 秒；[split] 最多切两段。',
    parent: 'voice',
    symbol: 'partGapMs',
    where: 'partGapMs() / TYPING.selfSplitGapMs',
  },
  {
    id: 'typing.indicator',
    group: 'rhythm',
    title: '正在输入只亮不取消',
    rule: '「正在输入」只在通道层亮：失败静默；消息落地后由客户端清状态，不额外发取消。',
    parent: 'voice',
    symbol: 'TypingDesk',
    where: 'TypingDesk.#indicate()',
  },
  {
    id: 'attention.window',
    group: 'rhythm',
    title: '群里按人开窗',
    rule: '同一个人在同一会话只有一个注意力窗口；窗口内不 @ 也接，到期或到轮数上限自动关。',
    parent: 'decide',
    symbol: 'AttentionDesk',
    where: 'AttentionDesk.open() / hit() / bump()',
    live: (read) => `窗口 ${Number(read('group.followUpSeconds')) || 180} 秒 · 最多 ${Number(read('group.followUpMaxTurns')) || 5} 轮`,
  },
  {
    id: 'attention.handoff',
    group: 'rhythm',
    title: '换人要有判据',
    rule: '这句含「你/您」，或与上一句的二元组重合率 ≥ 0.2，才从旧目标换到新目标；换人时关旧窗口，一次只留一个热目标。',
    parent: 'decide',
    symbol: 'AttentionDesk',
    where: 'AttentionDesk.consider() / textOverlaps()',
  },
  {
    id: 'guard.floor',
    group: 'rhythm',
    title: 'guard 是闸门，typing 是手感',
    rule: 'guard 管能不能发（限流、夜间、静音），typing 管发的样子（等多久、分几条）；guard 没放行就走不到打字台。',
    parent: 'decide',
    symbol: 'Guard',
    where: 'Guard.check() / Guard.delay()',
    live: (read) => `每分钟 ${Number(read('guard.perMinute')) || 0} 条 · 每群每小时 ${Number(read('guard.replyQuotaPerHour')) || 0} 条`,
  },

  // ── 通道与事件 ───────────────────────────────────────────────
  {
    id: 'channel.notice',
    group: 'channel',
    title: '通知与请求必须进事件流',
    rule: '戳一戳、加好友、拉群都要留下记录；路由层只记录，不产生行为。',
    parent: 'channel',
    symbol: 'OneBotChannel',
    where: 'toRaw() 的 notice / request 分支',
  },
  {
    id: 'channel.dirty',
    group: 'channel',
    title: '脏包不猜',
    rule: '通道只翻译、不判断：缺 notice_type 或 flag 的包返回 null，不替协议端补字段。',
    parent: 'channel',
    symbol: 'toRaw',
    where: 'toRaw()',
  },
  {
    id: 'channel.input',
    group: 'channel',
    title: '正在输入是可选能力',
    rule: '协议端不支持 set_input_status 时失败被吞掉，不影响这条消息发出去。',
    parent: 'channel',
    symbol: 'OneBotChannel',
    where: 'OneBotChannel.inputStatus()',
  },
  {
    id: 'channel.raw',
    group: 'channel',
    title: '通道不替上层做决定',
    rule: 'QQ 发送只发生在通道层；该不该发、发几条由行为和打字台决定。',
    parent: 'channel',
    symbol: 'OneBotChannel',
    where: 'OneBotChannel.say()',
  },

  // ── 回合与路由 ───────────────────────────────────────────────
  {
    id: 'route.order',
    group: 'turn',
    title: '判定顺序不许调',
    rule: '群消息依次判：@ → 叫名字 → 呼唤 → 注意力窗口 → 兴趣词 → 续聊标签；顺序一变，接话的对象就会变。',
    parent: 'decide',
    symbol: 'route',
    where: 'behavior.route()',
  },
  {
    id: 'turn.attention',
    group: 'turn',
    title: '注意力判定在路由之前',
    rule: '判定在 decide 之前完成，开窗关窗的副作用留在 turn；被 @ 的消息不走注意力判定。',
    parent: 'turn',
    symbol: 'Turn',
    where: 'Turn.#attention() / Turn.handle()',
  },
  {
    id: 'turn.say',
    group: 'turn',
    title: '#say 只做渲染和交棒',
    rule: '#say 把每一段渲染成文字后交给打字台；空串不发；发送失败返回已发条数，不装作全发完。',
    parent: 'turn',
    symbol: 'Turn',
    where: 'Turn.#say()',
  },
  {
    id: 'turn.tools',
    group: 'turn',
    title: '工具环有上限',
    rule: '工具调用必须过工具白名单和技能开关；每调一次记一条 outcome；轮次上限读 tools.maxRounds（0=不限），每轮最多 tools.maxPerRound 次。',
    parent: 'turn',
    symbol: 'Turn',
    where: 'Turn.#tools() / config.tools.maxRounds',
    live: (read) => {
      const rounds = Number(read('tools.maxRounds')) || 0
      return `${rounds > 0 ? `最多 ${rounds} 轮` : '轮次不限'} · 每轮 ${Number(read('tools.maxPerRound')) || 0} 次`
    },
  },

  // ── 入口与出站 ───────────────────────────────────────────────
  {
    id: 'outbound.single',
    group: 'outbound',
    title: '出站只有一个口',
    rule: 'index.js 里 channel.say 只允许出现在 outbound 和面板「代发」两处；定时器、提醒、告警一律走 outbound。',
    parent: 'app',
    pendingModule: 'index.js',
    where: 'outbound() / 面板代发',
  },
  {
    id: 'outbound.request',
    group: 'outbound',
    title: '申请类永不自动通过',
    rule: '加好友、拉群这类申请只转告主人：必须带 QQ 号与附言，并说清「要主人自己点」。',
    parent: 'app',
    pendingModule: 'index.js',
    where: 'notifyOwnerOfRequest()',
  },
  {
    id: 'outbound.panel',
    group: 'outbound',
    title: '面板代发保留直连',
    rule: '用户在面板点了发送，等的是立刻出去，不是像人打字；这一条路径不经过打字台。',
    parent: 'app',
    pendingModule: 'index.js',
    where: '面板 /qq/send 路由',
  },

  // ── 工具链与元信息 ───────────────────────────────────────────
  {
    id: 'sandbox.confirm',
    group: 'tools',
    title: '只有「先问我」档才问人',
    rule: 'free 不问、off 不问，只有 ask 在静态闸门之后、真正执行之前挂起请求；没应答就按拒绝收口，绝不默认放行。面板弹窗与 QQ 私聊两条路同时问，回复「同意 / 拒绝 理由」即可，消息里必须写明项目名与目的。',
    parent: 'ability',
    symbol: 'ApprovalDesk',
    where: 'ApprovalDesk.request() / takeReply() / Sandbox.run()',
    live: (read) => `弹窗等 ${Number(read('sandbox.confirmSeconds')) || 60} 秒`,
  },
  {
    id: 'usage.total',
    group: 'tools',
    title: '今日与累计是两本账',
    rule: '按天账只留 90 天，用来算今天和预算；累计总用量单独累加、不随裁剪减少。面板上两个数分开显示，不拿其中一个冒充另一个。',
    parent: 'facts',
    symbol: 'Usage',
    where: 'Usage.total() / #bumpTotal()',
  },
  {
    id: 'sync.mirror',
    group: 'tools',
    title: '同步要清孤儿',
    rule: '源码删了文件，副本必须同步删；指纹必须含 package.json，否则版本差一个字符也会报「一致」。',
    pendingModule: 'scripts/sync-to-profile.mjs',
    where: 'orphansOf() / fingerprint()',
  },
  {
    id: 'smoke.chain',
    group: 'tools',
    title: '动链路就跑全链路自检',
    rule: 'npm run smoke 有 18 项，覆盖私聊、群聊、工具环、限流、沙箱确认、面板和三本账；任何一项红，先修关节再谈功能。',
    pendingModule: 'scripts/smoke-chain.mjs',
    where: 'npm run smoke',
  },
  {
    id: 'tests.reverse',
    group: 'tools',
    title: '改判据必须改反例',
    rule: '只加正例不算测过；反例要能证明「改坏就红」。',
    pendingModule: 'tests/turn.test.mjs',
    where: '各 tests/*.test.mjs',
  },
  {
    id: 'layers.guard',
    group: 'tools',
    title: '分层守卫不许绕',
    rule: '不许断链、环、越层、绕闸；通道层以外不许直接调 OneBot 发送。',
    pendingModule: 'scripts/check-layers.mjs',
    where: 'npm test 内置',
  },
]
/**
 * 还没接上的事。
 *
 * 这不是「待办清单」，是**对用户可见的缺口**：面板把它列出来，
 * 免得他改一个开关、等半天，最后发现底下根本没有执行器。
 * 每一条都要写清楚「现在是什么」「为什么没做」「下一步要付什么代价」。
 */
const RAW_GAPS = [
  {
    id: 'gap.switch-model',
    title: '换目标的模型判定没接',
    desc: '换人只判「你/您」与二元组重合率；上游还有一次内部模型调用，这里没有。',
    next: '需要时在 AttentionDesk.consider() 上再加一层判定，先算清一次调用值不值。',
    parent: 'decide',
    symbol: 'AttentionDesk',
    key: '',
  },
  {
    id: 'gap.qzone',
    title: '说说 / 朋友圈没有入口',
    desc: '通道已经有 sendQzone，但没有工具、权限和面板入口去调它。',
    next: '要开就得同时补工具、权限与面板入口，不能只加一个按钮。',
    parent: 'channel',
    symbol: 'OneBotChannel',
    key: '',
  },
  {
    id: 'gap.cross-group',
    title: '跨群记忆没接',
    desc: '只带本会话的上下文，别的群聊过的话题不会自动带进来。',
    next: '要做先定「谁能看到哪个群」的边界，再谈实现。',
    parent: 'mind',
    symbol: 'WhaleMemory',
    key: '',
  },
]
/**
 * 把「父模块 + 符号」解析成真实路径。
 *
 * 为什么不在每条里手写路径（以前就是那么干的）：
 *   24 条规则各写一个 'lib/xxx.mjs'，搬一次目录就要人肉改 N 条，
 *   改漏了要等 tests/rules.test.mjs 的 existsSync 才报 —— 那是事后报错，不是跟随。
 *
 * 三态：
 *   structure  父模块已落地，符号能在成员文件里找到 → 用解析出来的路径
 *   pending    父模块还在计划中 → 暂时用 pendingModule，搬完自动切换
 *   literal    脚本 / 测试，本来就不属于父模块 → 原样保留
 *
 * 界面读的仍然是 `rule.module`，所以调用方零改动；但值的来源从「人写」变成「结构给」。
 */
function locate(one) {
  const byStructure = one.parent && one.symbol ? pathOfSymbol(one.parent, one.symbol) : ''
  return {
    ...one,
    module: byStructure || one.pendingModule || '',
    locatedBy: byStructure ? 'structure' : (one.parent ? 'pending' : 'literal'),
  }
}

export const RULES = Object.freeze(RAW_RULES.map(locate))
export const GAPS = Object.freeze(RAW_GAPS.map(locate))

/** 某个分组的规则；分组 id 不认识时返回空数组，不猜 */
export function rulesOf(groupId) {
  const id = String(groupId || '')
  if (!id || id === 'all') return RULES
  return RULES.filter((rule) => rule.group === id)
}

/** 分组名；不认识的返回空串，界面据此不画小标题 */
export function ruleGroupLabel(groupId) {
  const one = RULE_GROUPS.find((group) => group.id === groupId)
  return one ? one.label : ''
}
