/**
 * base/log.mjs — 两份日志的关系与「怎么筛」。
 *
 * ══════════════════════════════════════════════════════════════
 * 先把两件事分清楚（这一层存在的唯一理由）
 *
 *   1. **审计日志**（`audit.jsonl`）：按「发生了什么」分类 —— `config`、`skill_state`、
 *      `turn_failed`…… 一行一条 JSON，只追加、可翻页、是**证据**。
 *      它的价值在于「事后能查清谁改了什么」，所以它不按严重程度取舍：
 *      一次成功的改动和一次被拒的改动都要留下，否则「没发生过」和「发生过但没记」分不开。
 *
 *   2. **终端日志**（宿主控制台看得到的那几行）：按「有多该看」分级 ——
 *      error / warn / info / debug。它的价值在于「当场看见出了什么事」，
 *      所以它必须能筛掉噪音，否则排障时人被刷屏刷走。
 *
 * 两者是**两个不同的维度**：审计记「哪一类事」，终端记「多严重」。
 * 但它们不是没关系 —— 每个审计事件都有个天然的严重度（拒了就是 warn，
 * 崩了就是 error，正常改动是 info，高频心跳是 debug）。`severityOf()` 就是这个桥：
 * 有了它，一个级别既能筛终端，也能筛审计页的显示，还不用给每条日志手写级别。
 *
 * ══════════════════════════════════════════════════════════════
 * 三条硬规矩
 *
 *   1. **级别不删证据**。调高门槛只影响「终端打印」和「审计页显示」，
 *      磁盘上的 audit.jsonl 一条不少。把 `level=error` 理解成「只记错误」
 *      是这类系统最常见的误解，代价是出事之后查不到当时发生了什么。
 *   2. **默认全留**。审计的默认过滤只做「折叠噪音」（心跳、通道状态这类
 *      一天两万行的东西），且面板上明确写着「折叠可以关掉」，不偷偷丢。
 *   3. **不认识就放行**。类型名将来还会增加，默认必须是「显示」而不是「隐藏」——
 *      隐藏未知类型会让新功能上线后"看不见"，比吵一点严重得多。
 */

/** 级别：数字越小越严重。比较用 `LEVELS[a] <= LEVELS[b]` */
export const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 })

/** 面板上的中文档位名。枚举项必须每个都有中文名，否则用户看到的是 error / warn 这种半截词 */
export const LEVEL_LABELS = Object.freeze({
  error: '只看错误',
  warn: '错误与警告',
  info: '常规（推荐）',
  debug: '调试（最啰嗦）',
})

/** 可选档位，顺序 = 面板下拉顺序：从最安静到最啰嗦 */
export const LEVEL_IDS = Object.freeze(['error', 'warn', 'info', 'debug'])

/**
 * 高频低价值的类型。它们不是"错"，只是多。
 *
 * 为什么要单独一档：`channel_state` 一天能写两万多行（掉线重连每次都写），
 * 审计页一打开全是它，真正要找的那条「谁改了配置」被埋在下面翻不到。
 * 折叠 ≠ 删除：磁盘上照旧，页面上按需展开。
 */
export const NOISE_KINDS = Object.freeze([
  'channel_state',
  'heartbeat',
  'tool_call',
  'tool_result',
  'reflect_cursor',
  'reflect_cursor_future',
])

/**
 * 严重度规则表。**顺序有意义**：先判最严重的，越往后越轻。
 *
 * 为什么不给每个调用点手写级别：现在 30 多个 kind，将来还会加。
 * 逐个手写必然出现「同一个意思两种级别」，面板上就会看到
 * 一条 `config_reject` 和一条 `skill_reject` 一个色深一个色浅。
 */
const SEVERITY_RULES = Object.freeze([
  // 崩了 / 整份记录读不动 / 一轮对话没跑完 —— 这些是「功能没完成」
  [/^(turn_failed|sandbox_fail|journal_quarantined|crash|fatal)$/, 'error'],
  [/(_failed|_fail|_error)$/, 'error'],
  // 拒了 / 冲突 / 被截断 / 越权 —— 保存了但没生效，或数据被别的实例动过
  [/(_reject|_refused|_conflict|_truncated|_invalid|_blocked|_fuse|_timeout)$/, 'warn'],
  // 噪音与逐条工具往返：默认不进审计页，排查时才展开
  [/^(heartbeat|channel_state|tool_call|tool_result)$/, 'debug'],
  [/(_cursor|_cursor_future)$/, 'debug'],
])

/** 一个审计事件有多严重。不认识的一律 info（放行，见上面第 3 条）。 */
export function severityOf(kind) {
  const key = String(kind || '')
  if (!key) return 'info'
  for (const [pattern, level] of SEVERITY_RULES) {
    if (pattern.test(key)) return level
  }
  return 'info'
}

/** 是不是噪音类型 */
export function isNoise(kind) {
  const key = String(kind || '')
  if (NOISE_KINDS.includes(key)) return true
  return /^(channel_state|heartbeat)/.test(key)
}

/**
 * 常见类型的短中文名。
 *
 * 只做「一眼认得出」，不做完整翻译：没登记的类型直接显示原名，
 * 那也比显示一坨英文好 —— 而且以后加类型不用改这张表才能用。
 */
const KIND_LABELS = Object.freeze({
  config: '改设置',
  config_reject: '设置被拒',
  config_confirm_needed: '等你确认',
  config_save_failed: '设置没存上',
  turn_failed: '一轮对话失败',
  invalid_event: '事件不合法',
  channel_state: '通道状态',
  channel_state_reject: '通道状态被拒',
  napcat_recover: '协议端自愈',
  skill_teach: '教了个技能',
  skill_teach_reject: '技能没教成',
  skill_state: '开关技能',
  skill_reject: '技能开关被拒',
  skill_forget: '忘掉技能',
  skill_amend: '改技能名',
  skill_amend_reject: '改技能名被拒',
  skill_use: '用了技能',
  skills_conflict: '技能簿被别处改过',
  panel_send: '面板代发',
  send_failed: '消息没发出去',
  outbound_too_long: '发出去太长',
  quote_failed: '引用取不回来',
  tool_args_invalid: '工具参数不合法',
  tool_batch_truncated: '工具超过上限',
  tools_wired: '工具接上了',
  journal_quarantined: '日志坏了一份',
  recovered: '配置自愈',
  shutdown: '关闭',
  evolve: '调了权重',
})

/** 人话类型名；没登记就原名 */
export function labelOf(kind) {
  const key = String(kind || '')
  return KIND_LABELS[key] || key || '记录'
}

/** 这个级别放不放行这个严重度 */
export function levelPass(level, severity) {
  const gate = LEVELS[String(level || 'info')] ?? LEVELS.info
  const value = LEVELS[String(severity || 'info')] ?? LEVELS.info
  return value <= gate
}

/**
 * 类型白名单。**空表 = 全部放行**。
 *
 * 为什么空表是「全放行」而不是「全拦」：面板上「只看这些类型」留空是常态，
 * 空着就什么都不显示的话，用户会以为日志坏了。
 * （注意这和 `net.allowlist` 的空值语义**相反** —— 那边是白名单，空=全拒。
 *   两处都写在面板 hint 里，因为这种反义最容易记混。）
 */
export function kindsPass(list, kind) {
  const keys = (Array.isArray(list) ? list : []).map((item) => String(item || '').trim()).filter(Boolean)
  if (!keys.length) return true
  const key = String(kind || '')
  return keys.some((entry) => entry === key || (entry.endsWith('*') && key.startsWith(entry.slice(0, -1))))
}

/**
 * 从配置里读出审计页的过滤条件。
 *
 * 三个条件是**与**关系：级别够、类型在名单里、噪音没被折叠，三条同时满足才显示。
 * 这个组合关系必须写在一处 —— 面板上三个开关，代码里三处各判一次，
 * 迟早出现「关了折叠还是看不到」这种互相打架的 bug。
 */
export function auditFilter(config = {}) {
  const log = config.log || {}
  const level = LEVELS[String(log.auditLevel)] === undefined ? 'info' : String(log.auditLevel)
  return {
    level,
    kinds: Array.isArray(log.auditKinds) ? log.auditKinds.map(String).filter(Boolean) : [],
    noise: log.auditNoise !== false,
  }
}

/** 一条审计记录过不过这个过滤条件 */
export function auditVisible(row, filter) {
  const kind = String(row?.kind || '')
  if (!levelPass(filter.level, severityOf(kind))) return false
  if (!kindsPass(filter.kinds, kind)) return false
  // 噪音折叠只对「默认视图」生效：用户显式点名要看某个类型时，当然要显示 ——
  // 不然就会出现「我明明填了 channel_state，怎么还是空的」。
  const named = Array.isArray(filter.kinds) && filter.kinds.length > 0
  if (filter.noise !== false && !named && isNoise(kind)) return false
  return true
}

/** 终端这一行要不要打。level 缺省当 info */
export function tracePass(config = {}, level = 'info') {
  const gate = LEVELS[String(config?.log?.level)] === undefined ? 'info' : String(config.log.level)
  return levelPass(gate, level)
}
