/**
 * truth/config.mjs — 配置的唯一形状：默认值、扁平化、迁移、读写。
 *
 * 为什么单独一层（且必须和 panel.mjs 同生共死）：
 *   旧版 169 个配置键散在十几个模块里各自 `config.foo?.bar ?? 默认`，
 *   没人说得清「一共有哪些键」；面板只能改 26 个，剩下 143 个去开文件手改。
 *   这里把全部键写成**唯一一份** DEFAULTS，`panel.mjs` 负责给每个键配中文名与校验，
 *   `coverage()` 在测试里对两边逐键对账 —— 任何一边多一个少一个，测试当场红。
 *
 * 三条纪律：
 *   1. 本模块纯函数、不碰磁盘（读写在 index.js），所以能离线测；
 *   2. 旧配置只做「补齐 / 丢弃 / 修复」三件事，绝不因为一个新键就把整份配置重置；
 *   3. 迁移必须幂等：migrate(migrate(x)) 与 migrate(x) 完全一致，重启多少次都一个样。
 */

import { LEVEL, RISK, find, validate } from './panel.mjs'

/**
 * 全部默认值。**键的集合必须与 panel.mjs 里可改项完全一致**（只读状态项不算）。
 * 数组（白名单）是叶子值，不参与扁平化。
 */
export const DEFAULTS = Object.freeze({
  // 身份与说话
  // persona 这一组只有四件事：叫什么、人设正文、话多话少、一次几条。
  //
  // 「话多话少」是**倾向**（brief/normal/chatty），不是字数上限 ——
  // 早先这里是 maxReplyChars（每条最多几个字），面板上写着「超过就断开」，
  // 实际上那个旋钮一直空转（键名对不上），而且它本身就把人话变成了节拍器。
  // 现在没有字数上限：他想说多长说多长。
  persona: Object.freeze({ name: '深蓝', persona: '', verbosity: 'normal', maxParts: 3 }),
  identity: Object.freeze({ ownerName: '主人', ownerId: '' }),

  // 模型：两个键都留空 = 跟随宿主当前对话所用的模型。
  //
  // 为什么要显式给这两个键：宿主那边没选模型时，这是用户唯一能自己指定模型的地方。
  // 以前 host.mjs 已经在读它们，但它们既不在 DEFAULTS 也不在面板 ——
  // 用户照着错误提示去 config.json 里手填，下一次 migrate() 会把它当未知键丢掉。
  // 所以这里必须登记，面板的「模型」组也必须能改。
  // 默认档：开启时忽略下面两项，固定用 deepseek-account / deepseek-flash。
  // 关闭后按下面两项；两项都空则跟随宿主当前对话模型。
  modelFollowDefault: true,
  modelProvider: '',
  model: '',

  // QQ 通道
  channel: Object.freeze({
    enabled: true,
    autoStartNapcat: false,
    napcatBat: 'E:\\深蓝鲸\\启动NapCat.bat',
    watchdogEnabled: false,
    // 掉线多久后重启协议端。默认 2 分钟，对齐参考实现（QQFish watchdog）：
    // 1 分钟太短，NapCat 自己还在重连；5 分钟又太慢，用户已经认定「它死了」。
    watchdogMinutes: 2,
    wsUrl: 'ws://127.0.0.1:3001',
    token: '',
    selfId: '',
    // 模型一次最多生成多少 token。思考分片也算在里面：太小会出现
    // 「只想不说」——正文被思考挤没，用户看到「正在想」然后没做成。
    maxOutputTokens: 1600,
    // 等模型多久。超时不再抛失败卡片，改用一句人话兜底（见 app/host.mjs）。
    turnTimeoutMs: 90_000,
    login: Object.freeze({ mode: 'ticket', autoQr: true, password: '' }),
  }),

  // 说话节奏
  // 三个时长**存毫秒、面板按秒显示**（scale=1000）。默认值按「像人打字」定，不按「尽快回」：
  //   先等 2.5 秒 —— 秒回像机器人；再久就让人以为掉线了。
  //   两条间隔 1.8 秒 —— 人连发两条，中间也要重新想、重新打。
  //   3 秒内连发算同一段 —— 对方还在打字，别插嘴。
  // 这三个键的换算绝不能只靠前端：绕过前端写进来的值会变成 0.3 毫秒这种东西，
  // 等于秒回，是风控最敏感的行为特征。兜底放在 panel.mjs 的 validate() 里。
  guard: Object.freeze({
    replyQuotaPerHour: 60,
    perMinute: 15,
    firstDelayMs: 2500,
    minGapMs: 1800,
    // 连发合并窗口：同一个人在群里连着发的几条，攒这么久当成一件事回。
    // 1.5 秒 —— 参考实现用的也是 1500ms。
    // 不能再长：被点名时是立即回的（不合并），但没点名时多等一秒
    // 就是「明明看到了却不说话」，那是失功能不是从容。
    mergeWindowMs: 1500,
    nightWindow: '23:00-07:00',
  }),

  group: Object.freeze({
    followUpSeconds: 180,
    followUpMaxTurns: 5,
    followUpChance: 100,
    attentionModelJudge: true,
    interests: Object.freeze([]),
  }),

  // QQ 空间：默认关；打开后才允许模型/主人发说说
  qzone: Object.freeze({
    enabled: false,
    dailyLimit: 2,
  }),

  // 记忆与自我
  memory: Object.freeze({
    enabled: true,
    maxEntries: 8000,
    summaryEvery: 200,
    // 跨群记忆只在主人私聊里参考，且只读这些群；空 = 不跨群。
    crossGroups: Object.freeze([]),
    crossGroupHours: 6,
    net: Object.freeze({ entries: 2, hops: 6, decay: 0.82 }),
  }),
  self: Object.freeze({ enabled: true, rewriteCooldownHours: 48 }),

  // 自主
  activity: Object.freeze({ enabled: true, tickMinutes: 45, maxPerDay: 12 }),
  proactive: Object.freeze({
    enabled: false,
    intervalMinutes: 180,
    // 主动开口的节奏：间隔在这段里随机抽，不准时报时。
    // 默认按实测标定（自发发言间隔中位 89 分钟）。
    minGapMinutes: 45,
    maxGapMinutes: 120,
    startHour: 9,
    endHour: 23,
    perDay: 3,
    scene: 'general',
    hotNews: true,
    hotNewsHours: 8,
    dailyDigest: true,
    morningBackfill: true,
    coldTopic: false,
    nameCall: true,
  }),

  // 能力与网络
  // tools.whitelist 留空 = 全部允许；net.allowlist 留空 = 全部拒绝。
  // 两个空值的含义相反，这是本文件最容易误解的一处，面板文案里各写了一遍。
  browser: Object.freeze({
    // 浏览器程序路径。留空 = 自动找本机 Chrome / Edge。
    // 为什么要这个键：以前只能靠 DSH_RENDER_BROWSER 环境变量指定，
    // 装了便携版 / 非默认路径的用户在界面上无处可填，只能看到「没找到浏览器」。
    path: '',
    headless: true,
    cdpUrl: '',
    allowPrivate: false,
    idleMinutes: 10,
    maxPerHour: 60,
  }),
  images: Object.freeze({ maxPerMessage: 2, maxBytes: 6_000_000 }),
  // maxRounds / maxPerRound 是工具环的两个上限：
  //   maxRounds   一轮对话里最多「调完再问」几回；**0 = 不限**（由日预算和
  //               原地打转判定兜底）。旧默认 2 太小：模型改提醒参数、查代码
  //               常常第二步才改对，轮数先用完就只能回一句「我明早再改」。
  //   maxPerRound 一次最多执行几个工具（一件事分成几步时，模型会连着写几行）。
  tools: Object.freeze({ whitelist: Object.freeze([]), maxRounds: 0, maxPerRound: 4 }),
  net: Object.freeze({ allowlist: Object.freeze([]), quotaPerHour: 60 }),

  // 技能。开关本身（哪个技能开、哪个关）不在这里 —— 那是技能簿的动态状态，
  // 塞进配置会让「配置键 ↔ 面板项」逐键对账失效，也会把用户手写的键冲掉。
  //
  // 曾经这里还有一个 `autoLearn`（允不允许自己学新本事）。删掉了：
  // 它开关不影响任何代码路径，是典型的「面板上有、改了没用」。
  // 想限制他/她学东西，用「教的技能默认关着」这一条就够了 —— 那才是真的闸门。
  skills: Object.freeze({
    autoOffAfterFails: 3,
    maxTaught: 60,
  }),

  // 沙箱
  sandbox: Object.freeze({
    mode: 'free',
    hourlyMax: 10,
    dailyMax: 40,
    timeoutMs: 30000,
    memMb: 256,
    maxCodeBytes: 8192,
    fuseAfter: 2,
    fuseHours: 24,
    // 「先问我」档等多久（秒）。走完没人点按拒绝处理，这是默认值不是建议值
    confirmSeconds: 60,
    // 动**自己这套代码**的整体档位：off 一眼不看 / read 只看 / write 能改能跑。
    // 和上面的 mode 是两件事：mode 管「临时跑一段代码」，codeMode 管「碰不碰源码」。
    // 两者分开是因为风险不一样 —— 前者炸了只是这一次跑失败，后者炸了是插件下次起不来。
    codeMode: 'write',
  }),

  // 花费
  usage: Object.freeze({ currency: 'CNY', inputPerM: 2, outputPerM: 8, budgetPerDay: 5 }),

  // 面板：只有宿主内嵌这一种。曾经规划过「独立端口服务」（webui.* 四个键），
  // 执行器从来没写，四个键改了什么也不发生 —— 0.30.0 整块摘掉，不留空壳开关。

  // 运维：终端日志与审计页的过滤。
  //
  // 三件事要分清楚，面板上的说明也按这三件事写：
  //   level       终端（宿主控制台）打多细 —— 只影响"打印"，不影响磁盘
  //   echo        把审计事件同步打到终端（受 level 约束）；关着时终端只有插件自己的几行
  //   audit*      审计页**显示**什么（级别门槛 / 类型白名单 / 噪音折叠）——
  //               磁盘上的 audit.jsonl 一条不少，这三项只决定「看不看得到」
  log: Object.freeze({
    level: 'info',
    echo: false,
    auditLevel: 'info',
    auditKinds: Object.freeze([]),
    auditNoise: true,
    redact: true,
  }),

  // 进化
  evolve: Object.freeze({
    enabled: true,
    window: 20,
    ema: 0.1,
    clamp: 0.15,
    keepVersions: 50,
  }),
})

/**
 * 把新配置**就地**盖到旧对象上，返回同一个对象（身份不变）。
 *
 * 为什么非要在意「同一个对象」这件事：
 *   装配时是把 `runtime.config` 这个**引用**交给各层的（Guard 读限流规则、
 *   通道读开关、注意力读窗口）。而改配置走的是 `set()` → `unflatten()`，
 *   返回的是一份**新对象**；如果调用方直接把 `this.config` 指过去，
 *   那些早就拿到旧引用的消费者就再也看不到新值了 ——
 *   表现是「面板上改了、提示说下一条消息就生效、实际上一直是旧值」，
 *   而且要重启才好。这类 bug 不会报错，只会让人怀疑自己没点中。
 *
 *   所以配置对象在进程生命周期里**只换内容、不换身份**。
 *   这条不变式由 tests/hardening.test.mjs 里的用例钉住。
 */
export function applyInto(target, source) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return clone(source)
  const next = source && typeof source === 'object' ? source : {}
  // 先删掉新配置里没有的键：只加不减会让「删掉的白名单项」永远留在内存里
  for (const key of Object.keys(target)) {
    if (!Object.prototype.hasOwnProperty.call(next, key)) delete target[key]
  }
  for (const [key, value] of Object.entries(next)) {
    const current = target[key]
    const bothPlain = value && typeof value === 'object' && !Array.isArray(value)
      && current && typeof current === 'object' && !Array.isArray(current)
    if (bothPlain) applyInto(current, value)
    else target[key] = clone(value)
  }
  return target
}

/** 深拷贝（默认值都是纯数据，不走 structuredClone 是为了兼容冻结对象） */
export function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = clone(item)
    return out
  }
  return value
}

/** 嵌套 → 扁平：`{ guard: { perMinute: 15 } }` → `{ 'guard.perMinute': 15 }` */
export function flatten(input, prefix = '', out = {}) {
  const source = input && typeof input === 'object' ? input : {}
  for (const [key, value] of Object.entries(source)) {
    const dotted = prefix ? `${prefix}.${key}` : key
    // 数组是叶子：白名单本身就是一个值，展开成 0/1/2 没有意义
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flatten(value, dotted, out)
      continue
    }
    out[dotted] = Array.isArray(value) ? value.slice() : value
  }
  return out
}

/** 扁平 → 嵌套（配扁平键写回去时用） */
export function unflatten(flat) {
  const out = {}
  for (const [dotted, value] of Object.entries(flat || {})) {
    const parts = String(dotted).split('.')
    let node = out
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]
      if (!node[part] || typeof node[part] !== 'object') node[part] = {}
      node = node[part]
    }
    node[parts[parts.length - 1]] = value
  }
  return out
}

/** 取一个扁平键 */
export function get(config, key) {
  const parts = String(key || '').split('.')
  let node = config
  for (const part of parts) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined
    node = node[part]
  }
  return node
}

/**
 * 改一个扁平键，返回**新对象**（不改入参）。
 * 校验一律交给 panel.validate —— 面板能拦住的脏值，从代码改也必须被拦住。
 *
 * @returns {{ ok: boolean, error?: string, config?: object, value?: *, needRestart?: boolean, needConfirm?: boolean }}
 */
export function set(config, key, value) {
  const item = find(key)
  if (!item) return { ok: false, error: `没有这一项：${key}` }
  if (item.level === LEVEL.READONLY) return { ok: false, error: `${item.label} 是只读的` }

  const checked = validate(key, value)
  if (!checked.ok) return checked

  const flat = flatten(config)
  flat[key] = checked.value
  return {
    ok: true,
    config: unflatten(flat),
    value: checked.value,
    needRestart: item.level === LEVEL.RESTART,
    needConfirm: item.risk === RISK.HIGH,
  }
}

/** 默认值的扁平键集合 —— 测试用它跟 panel 对账 */
export function defaultKeys() {
  return Object.keys(flatten(DEFAULTS)).sort()
}

/** 一个值坏到不能用时，怎么退：文本截断，其余回默认值 */
function repair(item, value) {
  if (item.kind === 'text') {
    const text = value === null || value === undefined ? '' : String(value)
    return item.maxLen ? text.slice(0, item.maxLen) : text
  }
  return get(DEFAULTS, item.key)
}

/**
 * 迁移：补齐缺的键、丢掉不认识的键、修好坏值。
 * 幂等，且**永远不因为一个坏键把整份配置重置**。
 *
 * @param {object} raw 磁盘上读到的旧配置（可能是任意形状）
 * @returns {{ config: object, filled: string[], dropped: string[], repaired: string[] }}
 */
export function migrate(raw) {
  const source = raw && typeof raw === 'object' ? flatten(raw) : {}
  const target = flatten(DEFAULTS)

  const filled = []
  const dropped = []
  const repaired = []
  const next = {}

  for (const [key, fallback] of Object.entries(target)) {
    if (!(key in source)) {
      filled.push(key)
      next[key] = clone(fallback)
      continue
    }
    const item = find(key)
    const value = source[key]
    if (!item) {
      // 默认值里有、面板里没有 —— 结构错误，测试会红；这里保底用默认值
      next[key] = clone(fallback)
      continue
    }
    const checked = validate(key, value)
    if (checked.ok) {
      next[key] = checked.value
      continue
    }
    // 只读项不该出现在配置里，但当脏数据带进来了，按文本截断兜住
    repaired.push(key)
    const fixed = item.level === LEVEL.READONLY ? clone(fallback) : repair(item, value)
    const again = validate(key, fixed)
    next[key] = again.ok ? again.value : clone(fallback)
  }

  for (const key of Object.keys(source)) {
    if (key in target) continue
    dropped.push(key)
  }

  return { config: unflatten(next), filled: filled.sort(), dropped: dropped.sort(), repaired: repaired.sort() }
}

/** 两份配置之间改了什么（写审计用） */
export function diff(before, after) {
  const a = flatten(before)
  const b = flatten(after)
  const changed = []
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    const was = a[key]
    const now = b[key]
    if (JSON.stringify(was) === JSON.stringify(now)) continue
    const item = find(key)
    changed.push({
      key,
      label: item?.label || key,
      before: item?.secret ? mask(was) : was,
      after: item?.secret ? mask(now) : now,
      needRestart: item?.level === LEVEL.RESTART,
    })
  }
  changed.sort((x, y) => (x.key < y.key ? -1 : 1))
  return {
    changed,
    needRestart: changed.some((item) => item.needRestart),
  }
}

/** 敏感值只留「有没有配」，永不回显原值 */
function mask(value) {
  if (value === undefined || value === null || value === '') return ''
  return '***'
}

/** 启动时一句话：这次读配置补了多少、丢了多少 */
export function report(result) {
  const parts = []
  if (result.filled.length) parts.push(`补了 ${result.filled.length} 个新键`)
  if (result.dropped.length) parts.push(`丢弃 ${result.dropped.length} 个旧键`)
  if (result.repaired.length) parts.push(`修好 ${result.repaired.length} 个坏值`)
  return parts.length ? parts.join('，') : '配置没有变化'
}
