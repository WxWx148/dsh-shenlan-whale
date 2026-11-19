/**
 * view/panel-view.mjs — 界面的「视图模型」：所有要显示的字，在宿主这边一次算完。
 *
 * 为什么不让浏览器自己算：
 *   1. 界面上每个数字背后都是一条业务判断（「掉线了」和「还没连上」不是一回事，
 *      「还没接上」和「你关掉了」也不是一回事）。判断只能有一份，
 *      放进浏览器就等于抄第二份，抄完必然对不上。
 *   2. 浏览器那份代码进不了 `npm test`。算在宿主这边，才能用离线用例把
 *      「谁会什么、第几版权重、谁在跟谁聊、改了哪项不生效」全部断言住。
 *   3. 前端因此只剩「把字段摆到屏幕上」，改样式不会顺手改错逻辑。
 *
 * 结构分三层（这一层是页面骨架，不是数据表）：
 *   域（domain)  —— 七个概念块，写在 truth/taxonomy.mjs，设置分组也归到它上面
 *   区域（region）—— 左侧栏的一级入口，共 9 个，每个落在某个域里
 *   模块（module）—— 区域里的卡片，点进去就是详情（detail）
 * 一张卡片必须有 id，因为详情就是按这个 id 取的；没有 id 的卡片等于点不动。
 *
 * 这一层只读：不写盘、不发消息、不改配置。它也**不抛异常** ——
 * 某个分区算不出来，就把原因放进 `notices`，其余照常显示。
 * 面板最怕的不是少一栏，是整页白屏。
 */

import { get } from '../truth/index.mjs'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { LEVEL, RISK, PANEL_GROUPS, itemsOf, isPending, optionLabelsOf, readonlyItems, summary as panelSummary } from '../truth/index.mjs'
import { REGIONS, NAV_SECTIONS, DETAIL_KIND_LIST, domainLabel, regionOfDetail } from '../truth/index.mjs'
import { DEBUG_ITEMS } from './debug.mjs'
import { activityUsageView } from '../life/index.mjs'
import { SKILL_GROUPS } from '../ability/index.mjs'
import { weightLabel } from '../mind/index.mjs'
import { listConversations, thread, overviewOf, peerOf, THREAD_PAGE_SIZE } from './qqview.mjs'
import { LEVELS, LEVEL_IDS, LEVEL_LABELS, auditFilter, auditVisible, labelOf, severityOf } from '../base/log.mjs'
import { RULES, GAPS, RULE_GROUPS, ruleGroupLabel, rulesOf } from '../lib/rules.mjs'
import { USAGE_SOURCES } from '../facts/index.mjs'
import { buildInfo } from '../app/index.mjs'
import { ALIASES } from '../lib/blueprint.mjs'
import { apiUrl, assetUrl } from '../lib/structure.mjs'

/**
 * 侧边栏几何 —— 这些数字同时被 lib/client.panel.js 的样式表和 tests/panel-view.test.mjs 读取。
 *
 * 取值理由：
 *   · 248 —— 与 DSH 外层侧栏（264–420，默认偏窄）同一量级但更窄，不至于「又套一层宽栏」。
 *   · 56  —— 直接用宿主收起轨道的宽度，从外层收起切到内层收起是同一条竖线。
 *   · 200–320 —— 手动拖动的上下限。低于 200 中文标签折行，高于 320 就不该再展开。
 *   · 720 —— 自动收起的门槛：低于这个宽度，正文再让出 248 就没法读了。
 *   · 480 —— 紧凑档：轨道图标间距收紧，正文栅格变一列。
 */
export const SIDEBAR = Object.freeze({
  expanded: 248,
  collapsed: 56,
  min: 200,
  max: 320,
  autoCollapseAt: 720,
  compactAt: 480,
})

/** 区域表只有一份，在 truth/taxonomy.mjs；这里转出去是为了老调用方不必改 import */
export { REGIONS }

/** 语气档：前端只认这四个，颜色由样式表决定，文案不用关心色值 */
const TONE = Object.freeze({ OK: 'ok', WARN: 'warn', BAD: 'bad', IDLE: 'idle' })

// ── 排版用的格式化 ──────────────────────────────────────────────
// 全是纯函数：同样的输入永远同样的字，方便用例逐条钉住。

/** 数字：小于一千照实说，再往上用 k/m，避免「今日 1234567 次」这种读不出来的字 */
export function countText(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 1_000_000) return `${(n / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

/** 钱：一眼看到分。货币符号跟着计价货币走，不硬写人民币 */
export function moneyText(value, currency = 'CNY') {
  const n = Number(value)
  const symbol = currency === 'USD' ? '$' : '¥'
  return `${symbol}${(Number.isFinite(n) ? n : 0).toFixed(2)}`
}

/** 时长：从秒到天，四档。要的是「3 小时 12 分」，不是 11520000 */
export function spanText(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '—'
  const sec = Math.floor(n / 1000)
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟`
  const hour = Math.floor(min / 60)
  if (hour < 24) return min % 60 ? `${hour} 小时 ${min % 60} 分` : `${hour} 小时`
  const day = Math.floor(hour / 24)
  return hour % 24 ? `${day} 天 ${hour % 24} 小时` : `${day} 天`
}

/** 多久以前：null 就说「还没有」，不显示 0 秒前那种假精确 */
export function agoText(at, now = Date.now()) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return '还没有'
  const diff = Math.max(0, Number(now) - t)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 时刻：只有「今天几点几分」对人有意义，多一个日期都是噪声 */
function clockText(at) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return ''
  const date = new Date(t)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** 成功率：没试过就明说，不许显示 0%（那是「每次都失败」的意思） */
export function rateText(rate, uses) {
  if (!Number(uses)) return '还没试过'
  const r = Number(rate)
  if (!Number.isFinite(r)) return '—'
  return `${Math.round(Math.min(1, Math.max(0, r)) * 100)}%`
}

/** 数字 + 单位。面板上「300」是没法用的，300 毫秒还是 300 秒？ */
export function withUnit(value, unit) {
  const text = value === undefined || value === null || value === '' ? '—' : String(value)
  if (text === '—') return text
  return unit ? `${text} ${unit}` : text
}

// ── 状态翻译：把内部枚举翻成人话，并定语气 ──────────────────────

/**
 * 通道状态。
 * 「还没连上」和「掉线了」必须分开：前者是刚启动还没消息，后者是连过又断了。
 * 合成一句「未连接」会让用户以为要手动做点什么，其实什么都不用做。
 */
export function channelFace(state, info = {}) {
  if (state === 'online') {
    // 心跳正常 ≠ QQ 消息真的进来了。NapCat 入站卡死时心跳还会继续，
    // 只看 connected 会把“在线但收不到”说成“收发正常”。
    const last = Number(info.lastInboundAt) || 0
    const now = Number(info.now) || Date.now()
    if (last && now - last > 30 * 60_000) {
      const mins = Math.max(1, Math.round((now - last) / 60_000))
      return { label: '在线但没消息', tone: TONE.WARN, hint: `心跳还在，但已经 ${mins} 分钟没收到任何消息；先确认入站/重启协议端` }
    }
    return { label: '在线', tone: TONE.OK, hint: last ? '心跳正常；能不能收到消息看下面的最后入站时间' : '心跳正常；还没收到过消息，先确认聊天对象和登录' }
  }
  if (state === 'stale') return { label: '连接没响应', tone: TONE.BAD, hint: '超过 45 秒没收到心跳，消息可能发不出去；正在等它恢复' }
  if (state === 'offline') return { label: '掉线了', tone: TONE.BAD, hint: '连上过又断了，正在自己重连' }
  // 「未知」不是「在线」，也不是「正在重连」：协议端没应答时消息就是发不出去。
  // 用红色「连接未响应」而不是黄色「还没连上」，避免把掉线看成只是启动慢。
  if (state === 'unknown') return { label: '连接未响应', tone: TONE.BAD, hint: '协议端没应答，消息现在发不出去；先看 QQ 连接/扫码' }
  return { label: '已关闭', tone: TONE.IDLE, hint: '通道关着，他/她不会收发任何消息' }
}

/** 技能状态：三态各自对应「谁能解决」，这是这栏最重要的信息 */
export function skillFace(item) {
  if (item?.state === 'on') return { label: '开着', tone: TONE.OK, toggleable: true }
  if (item?.state === 'off') return { label: '关着', tone: TONE.IDLE, toggleable: true }
  if (item?.wired === false) return { label: '还没接上', tone: TONE.WARN, toggleable: false }
  return { label: '用不了', tone: TONE.BAD, toggleable: false }
}

/** 熟练度：颜色只用来区分「没试过 / 在学 / 会了 / 很熟」四档 */
function masteryTone(level) {
  if (level === 'solid' || level === 'learned') return TONE.OK
  if (level === 'trying') return TONE.WARN
  return TONE.IDLE
}

// ── 基础数据块（区域页与详情页共用）─────────────────────────────

/** 总览的 8 块状态牌。只放「此刻真的算得出来」的，算不出来的写 —，不填 0 */
/**
 * 总览的 8 块状态牌。
 *
 * 只认 `runtime.status()` 一个来源 —— 以前这里又从 usage / guard / channel 各算一遍，
 * 于是「今日 token」在状态牌和「今天的账」里可能是两个数，而且 status() 里
 * 那 20 多项只读状态除了这十块牌子，没有任何地方看得全。
 * 现在牌子是状态的摘要，全表在 `status.all` 详情里，两边同源。
 */
function statusTiles({ status, config, login, lastInboundAt = 0, now = Date.now() }) {
  const face = channelFace(status['status.channel'], { lastInboundAt, now })
  const currency = String(get(config, 'usage.currency') || 'CNY')
  const budget = Number(status['status.budget']) || 0
  const cost = Number(status['status.todayCost'])
  const over = budget > 0 && Number.isFinite(cost) && cost > budget
  // null 是「算不出来」，不是 0。直接丢给 countText/moneyText 会变成 0 或 ¥0.00，
  // 那正好是面板最容易撒的谎。
  const dash = (value) => (value === null || value === undefined ? undefined : value)
  return [
    {
      label: '通道',
      value: face.label,
      tone: face.tone,
      // 通道「掉线」的原因常常是没登录。登录层知道得更细，就把它的一句话借过来；
      // 不知道就还用通道自己的说明，不编。
      hint: login && login.online !== true && login.hint ? login.hint : face.hint,
    },
    { label: '已运行', value: spanText(status['status.uptime']), tone: TONE.IDLE, hint: '这次启动到现在' },
    { label: '今日收发', value: countText(status['status.todayMessages']), tone: TONE.IDLE, hint: '收到 + 发出，不含心跳与通知' },
    { label: '今日 token', value: countText(dash(status['status.todayTokens'])), tone: TONE.IDLE, hint: '今天所有生成消耗的输入与输出' },
    {
      label: '累计 token',
      value: countText(dash(status['status.totalTokens'])),
      tone: TONE.IDLE,
      // 累计值不随按天裁剪走，所以它和「今日」是两个口径。写清楚别让人以为是今天的
      hint: '从账本第一天到今天，一共消耗的 token',
    },
    {
      label: '今日花费',
      value: status['status.todayCost'] === null || status['status.todayCost'] === undefined ? '—' : moneyText(cost, currency),
      tone: over ? TONE.BAD : TONE.IDLE,
      hint: budget
        ? over
          ? `已超过 ${moneyText(budget, currency)} 预算`
          : `预算还剩 ${moneyText(status['status.balance'], currency)}`
        : '没设日预算',
    },
    {
      label: '预算还剩',
      value: budget ? moneyText(status['status.balance'], currency) : '没设上限',
      tone: over ? TONE.BAD : TONE.IDLE,
      hint: budget ? '按日预算算的可用余额，不是 DeepSeek 账户余额' : '去「设置 → 花费」填日预算后显示',
    },
    {
      label: '会几项',
      value: withUnit(countText(status['status.skillOn']), '项'),
      tone: TONE.OK,
      hint: `练熟 ${countText(status['status.skillLearned'])} 项 · 用不了 ${countText(status['status.skillBlocked'])} 项（其中 ${countText(status['status.skillNotWired'])} 项还没接上）`,
    },
    {
      label: '说话方式',
      value: status['status.evolveCount'] ? `调过 ${countText(status['status.evolveCount'])} 次` : '还是原样',
      tone: TONE.IDLE,
      hint: '按「说完有没有人接」慢慢调整，明细在「学习」里',
    },
  ]
}

/** 一项状态的显示值。null 一律写「—」—— 0 和「不知道」是两件事 */
function statusText(item, raw, currency) {
  if (raw === null || raw === undefined || raw === '') return '—'
  if (item.key === 'status.channel') return channelFace(raw).label
  if (item.format === 'duration' || item.format === 'span') return spanText(raw)
  if (item.format === 'money') return moneyText(raw, currency)
  if (item.format === 'count') return countText(raw)
  if (item.format === 'ago') return agoText(raw)
  return String(raw)
}

/** 一项状态的语气：只有「正在出事」才标红，其余一律安静 */
function statusTone(item, raw, { budget, cost }) {
  if (item.key === 'status.channel') return channelFace(raw).tone
  if (item.key === 'status.sandboxFuse') return raw && raw !== '正常' ? TONE.BAD : TONE.IDLE
  if (item.key === 'status.pendingConfig') return Number(raw) > 0 ? TONE.WARN : TONE.IDLE
  if (item.key === 'status.todayCost') return budget > 0 && Number.isFinite(cost) && cost > budget ? TONE.BAD : TONE.IDLE
  return TONE.IDLE
}

/**
 * 全表：注册了多少只读项就画多少张，一张不多一张不少。
 *
 * 这张表的存在是为了消灭「登记了却看不到」：以前 20 多项状态只有 8 块牌子，
 * 剩下的记忆条数、表情收藏、审计跨度谁也看不见，配置里却一直写着它们。
 */
function statusCards({ status, config }) {
  const currency = String(get(config, 'usage.currency') || 'CNY')
  const budget = Number(status['status.budget']) || 0
  const cost = Number(status['status.todayCost'])
  return readonlyItems().map((item) => ({
    label: item.label,
    value: statusText(item, status[item.key], currency),
    tone: statusTone(item, status[item.key], { budget, cost }),
    hint: item.hint || '',
  }))
}

/** 技能：按用途分组 */
function skillsOf({ skillsView }) {
  const groups = (skillsView.groups || []).map((group) => ({
    id: group.id,
    label: group.label,
    desc: group.desc,
    items: group.items.map((item) => {
      const face = skillFace(item)
      return {
        id: item.id,
        name: item.name,
        what: item.what,
        state: item.state,
        stateLabel: face.label,
        tone: face.tone,
        toggleable: face.toggleable,
        why: item.why,
        masteryLabel: item.masteryLabel,
        masteryTone: masteryTone(item.mastery),
        rateText: rateText(item.rate, item.uses),
        uses: Number(item.uses) || 0,
        risk: item.risk,
        canForget: item.canForget === true,
      }
    }),
  }))
  const counts = skillsView.counts || {}
  return {
    line: skillsView.line || '',
    counts: {
      total: Number(counts.total) || 0,
      on: Number(counts.on) || 0,
      learned: Number(counts.learned) || 0,
      blocked: Number(counts.blocked) || 0,
      notWired: Number(counts.notWired) || 0,
      taught: Number(counts.taught) || 0,
    },
    groups,
    learned: (skillsView.learned || []).slice(0, 6).map((item) => ({ id: item.id, name: item.name, masteryLabel: item.masteryLabel })),
    blocked: (skillsView.blocked || []).slice(0, 8).map((item) => ({ id: item.id, name: item.name, why: item.why, wired: item.wired !== false })),
  }
}

/** 权重行：用「×1.03」而不是 1.03，读起来是倍数 */
function weightRowsOf({ summary, skillsView }) {
  const w = summary.weights || {}
  const nameOf = new Map((skillsView.groups || []).flatMap((group) => group.items).map((item) => [item.id, item.name]))
  const toolRows = Object.entries(w.toolWeight || {})
    .map(([key, value]) => ({
      id: key,
      label: nameOf.get(key) || weightLabel(key),
      value: `×${Number(value).toFixed(2)}`,
      tone: Number(value) >= 1 ? TONE.OK : TONE.WARN,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
  const behaviorRows = Object.entries(w.behaviorWeight || {}).map(([key, value]) => ({
    id: key,
    label: weightLabel('behaviorWeight') + '·' + behaviorLabel(key),
    value: `×${Number(value).toFixed(2)}`,
    tone: Number(value) >= 1 ? TONE.OK : TONE.WARN,
  }))
  const styleRows = [
    { id: 'style.maxParts', label: weightLabel('styleParams.maxParts'), value: withUnit(countText(w.styleParams?.maxParts), '条'), tone: TONE.IDLE },
    { id: 'netDecay', label: weightLabel('netDecay'), value: Number(w.netDecay ?? 0).toFixed(2), tone: TONE.IDLE },
  ]
  return { toolRows, behaviorRows, styleRows }
}

/** 行为三类的中文名。面板只需要这三个词，不必读 behavior.mjs */
function behaviorLabel(kind) {
  if (kind === 'reply') return '回话'
  if (kind === 'proactive') return '主动开口'
  if (kind === 'activity') return '自己找事做'
  return String(kind || '')
}

/**
 * 设置：把 panel.mjs 的清单翻成「能直接摆进输入框」的形状。
 *
 * 三件事必须逐项说清，否则就是「看起来能改、改完没反应」：
 *   · level   —— 立刻生效 / 要重启 / 只能看
 *   · pending —— 保存了也不会生效（功能还没写）
 *   · risk    —— 危险项要二次确认
 */
/**
 * 这两项不再摆到界面上：追问几次、一次办几件事是执行细节，
 * 由任务类型自动决定（主人让核对数据时自动多查几次）。
 * 底层键仍在清单里，配置对账不受影响 —— 只是用户不需要看见「轮」这个字。
 */
const HIDDEN_SETTING_KEYS = new Set(['tools.maxRounds', 'tools.maxPerRound'])

/**
 * 生效时机的唯一翻译表。
 *
 * 以前只有 `needRestart` 一个布尔，界面上「保存完到底什么时候起作用」全靠
 * 用户自己猜 —— 改了没反应就以为没存上，其实是要重启。现在每个设置项都带
 * `effect`（机器值）+ `badge`（人话），前端只负责摆位置，不判断语义。
 * `pending` 优先于一切：这一项连实现都还没接上，谈生效时机没有意义。
 */
const EFFECT_LABEL = Object.freeze({
  pending: '改了也不会有变化',
  readonly: '只读',
  restart: '改后需重启',
  next: '下一轮生效',
})
function effectOf(item, pending) {
  if (pending) return 'pending'
  if (item.level === LEVEL.READONLY) return 'readonly'
  if (item.level === LEVEL.RESTART) return 'restart'
  return 'next'
}

function settingItemsOf({ config, groupId }) {
  return itemsOf(groupId).filter((item) => !HIDDEN_SETTING_KEYS.has(item.key)).map((item) => {
    const pending = isPending(item.key)
    const raw = get(config, item.key)
    const effect = effectOf(item, pending)
    return {
      key: item.key,
      label: item.label,
      hint: item.hint || '',
      kind: item.kind,
      level: item.level,
      readonly: item.level === LEVEL.READONLY,
      risk: item.risk,
      needConfirm: item.risk === RISK.HIGH,
      needRestart: item.level === LEVEL.RESTART,
      pending,
      effect,
      badge: EFFECT_LABEL[effect],
      secret: item.secret === true,
      secretConfigured: item.secret === true ? !!raw : false,
      // 敏感项不回显原值，也不把「已配置」当成输入框的值 —— 那样一保存就把令牌改成这三个字。
      value: item.secret ? '' : raw === undefined || raw === null ? '' : raw,
      options: item.options || null,
      // 档位必须给中文名：摆 free/ask/off 出去等于让人猜
      optionLabels: item.optionLabels || null,
      unit: item.unit || '',
      // 存的是毫秒、显示的是秒，这个换算比例必须一起给前端。
      // 漏了它，前端就不会除/乘，用户填「10 秒」会按 10 毫秒存下去 ——
      // 面板上写着 10 秒，实际防连发是 0.01 秒，等于没有。
      scale: item.scale ?? null,
      min: item.min ?? null,
      max: item.max ?? null,
      step: item.step ?? null,
      maxLen: item.maxLen ?? null,
      multiline: item.multiline === true,
      placeholder: item.secret ? (raw ? '已配置，留空表示不修改' : '还没配置') : '',
    }
  })
}

// ── 区域与模块（页面骨架）───────────────────────────────────────

/**
 * 一个区域由若干模块卡组成；每张卡必须带 `detail`（点进去看什么）。
 *
 * 为什么模块是「问题」而不是「功能」：
 *   用户不会想「我要打开配置管理」，他会想「它到底会不会算数」。
 *   所以技能区按用途拆（说话/知道/动手…），过程区按「出什么事了」拆
 *   （跑了代码吗 / 谁改了什么 / 它怎么想的）。
 */
/** 登录快照是同步缓存：面板每 5 秒重画一次，不能在这里发网络请求 */
function loginSnapshot(runtime) {
  try {
    return runtime?.napcat?.snapshot?.() || null
  } catch {
    return null
  }
}

/** 没有登录层时（旧调用方 / 测试）也能据二维码文件说一句实话 */
function fallbackQr(config, now = Date.now()) {
  const file = get(config, 'channel.qrcodePath') || path.join(homedir(), '.dsh', 'qq-fish', 'napcat', '4.18.41', 'napcat', 'cache', 'qrcode.png')
  let exists = false
  let at = 0
  try {
    const stat = statSync(file)
    if (stat.isFile()) {
      exists = true
      at = stat.mtimeMs
    }
  } catch {}
  const ageMs = exists ? Math.max(0, now - at) : null
  return {
    path: file,
    exists,
    at,
    ageMs,
    ageText: exists ? agoText(at, now) : '',
    usable: exists && ageMs !== null ? ageMs < 300_000 : false,
    src: assetUrl('napcat/qr'),
  }
}

/**
 * 卡片片段表。
 *
 * 以前是 10 个连续的 `if (regionId === 'xxx')`。后来改成表，再后来页面从 10 个并成 6 个，
 * 于是有了第三层：**页面 → 片段**。
 *
 * 为什么不把两个页面的片段硬拼成一个大函数：片段是"一段话能说清的展示单元"，
 * 页面是"回答同一个问题的若干段话"。合并页面只该改名单，不该重写内容 ——
 * 否则每次调整页面划分都要动几百行，而调整划分是迟早会再发生的。
 *
 * 约定：片段拿 (modules, ctx)，往 modules 里推进去；不返回东西。
 */
export const CARD_PARTS = {
  connection(modules, ctx) {
    const { sections, status, summary, skillsView, chat, qq, config, runtime, login } = ctx
    const qr = login?.qr || null
    const waiting = login?.phase === 'waiting_qr' || login?.phase === 'scanned'
    modules.push(
      {
        detail: 'connection.status',
        label: '连接状态',
        desc: login ? login.phaseLabel + ' · ' + login.hint : 'QQ 现在连没连上、二维码有没有生成',
        icon: 'plug',
        tone: login?.tone || TONE.IDLE,
        badge: login?.phase === 'offline' ? '没登录' : waiting ? '待扫码' : '',
      },
      {
        detail: 'connection.qr',
        label: '扫码登录',
        desc: login?.qrSuppressed
          ? '自动出码关着；点进去可以手动出码'
          : qr?.exists
            ? `二维码${qr.usable ? '已生成' : '可能过期'}（${qr.ageText}）；点进去看大图`
            : 'NapCat 登录二维码；刷新可换一张',
        icon: 'chat',
        tone: waiting ? TONE.WARN : TONE.IDLE,
        badge: waiting ? '待扫码' : '',
      },
      { detail: 'connection.groups', label: '群列表', desc: '自动列出机器人加入的群，可直接看群号', icon: 'grid' },
      { detail: 'settings.channel', label: '连接设置', desc: 'OneBot 地址、令牌、QQ 号、登录方式、开机自启', icon: 'sliders' },
    )
  },

  overview(modules, ctx) {
    const { sections, status, summary, skillsView, chat, qq, config, runtime, login } = ctx
    modules.push(
      { detail: 'usage.today', label: '今天的账', desc: '用了多少 token、花了多少钱、还剩多少预算', icon: 'coin' },
      {
        detail: 'talk.qq',
        label: '谁在跟他说话',
        desc: qq.total ? `${qq.total} 个会话，其中今天还在说的有 ${qq.active} 个` : '还没有任何 QQ 会话',
        icon: 'chat',
        tone: qq.total ? TONE.OK : TONE.IDLE,
      },
      {
        detail: 'skills.all',
        label: '它会什么',
        desc: sections.skills.line || '',
        icon: 'grid',
        badge: sections.skills?.counts?.blocked ? `${sections.skills.counts.blocked} 项用不了` : '',
        tone: sections.skills?.counts?.blocked ? TONE.WARN : TONE.OK,
      },
      {
        detail: 'process.audit',
        label: '最近发生了什么',
        desc: status['status.auditCount'] ? `最近 ${countText(status['status.auditCount'])} 条记录可以翻` : '还没有记录',
        icon: 'layers',
      },
      {
        // 规则放在概览里，是因为「它现在按什么跑」和「它现在怎么样」一样，
        // 是进来第一眼就该知道的事；点进去才是完整清单。
        detail: 'rules.all',
        label: '现在按什么规则跑',
        desc: `${RULES.length} 条此刻生效的约束；${GAPS.length} 项还没接上`,
        icon: 'shield',
        badge: `${RULES.length} 条`,
      },
      // 打字台与注意力是 0.35 就装上的东西，但面板上一直没有任何入口 ——
      // 装了、跑了、谁也看不见。这张卡就是它们的家：点进去看实时读数。
      ...(sections.rhythm?.typing || sections.rhythm?.attention
        ? [{
            detail: 'overview.rhythm',
            label: '说话的节奏',
            desc: rhythmLine(sections.rhythm),
            icon: 'chat',
            tone: sections.rhythm?.typing?.overloads ? TONE.WARN : TONE.IDLE,
            badge: sections.rhythm?.typing?.busy ? `排队 ${countText(sections.rhythm.typing.waiting)}` : '',
          }]
        : []),
      {
        // 状态牌只放得下 8 块；剩下十几项（记忆、表情、自主活动、审计跨度…）
        // 以前登记了却没有任何页面看得到。这一张卡就是它们的家。
        detail: 'status.all',
        label: '运行状态全表',
        desc: `${readonlyItems().length} 项状态一次看全，算不出来的写「—」`,
        icon: 'pulse',
        badge: `${readonlyItems().length} 项`,
      },
    )
  },

  talk(modules, ctx) {
    const { sections, status, summary, skillsView, chat, qq, config, runtime, login } = ctx
    modules.push(
      {
        detail: 'talk.local',
        label: '独立对话',
        // chat 为 null 是正常状态（宿主没给生成器），不能裸读 chat.ready，
        // 否则「对话」这一栏会整个算崩、被塞进 notices。判空后照常给出只读卡。
        desc: chat && chat.ready ? '不用 QQ，也不用心跳、扫码，直接说一句' : '生成能力还没接上，只能看历史',
        icon: 'chat',
        tone: chat && chat.ready ? TONE.OK : TONE.WARN,
        badge: chat && chat.ready ? '' : '只读',
      },
      {
        detail: 'talk.qq',
        label: 'QQ 会话',
        desc: qq.online ? '看它在跟谁聊、在哪聊、聊了什么，并能直接替它发话' : 'QQ 没连上，这里只能看，不能发',
        icon: 'plug',
        tone: qq.online ? TONE.OK : TONE.IDLE,
        badge: qq.online ? '' : '未连接',
      },
    )
  },

  skills(modules, ctx) {
    const { sections, status, summary, skillsView, chat, qq, config, runtime, login } = ctx
    for (const group of sections.skills.groups) {
      const blocked = group.items.filter((item) => item.state !== 'on').length
      modules.push({
        detail: `skills.${group.id}`,
        label: group.label,
        desc: group.desc,
        icon: 'grid',
        badge: blocked ? `${blocked} 项用不了` : '都能用',
        tone: blocked ? TONE.WARN : TONE.OK,
      })
    }
  },

  evolve(modules, ctx) {
    const { sections, status, summary, skillsView, chat, qq, config, runtime, login } = ctx
    modules.push(
      {
        detail: 'evolve.weights',
        label: '说话方式',
        desc: `调过 ${summary.changes} 次，能看它现在偏向怎么说话`,
        icon: 'spark',
        badge: summary.paused ? '先停一停' : '',
        tone: summary.paused ? TONE.WARN : TONE.OK,
      },
      {
        detail: 'evolve.history',
        label: '退回上一次',
        desc: `留着 ${summary.versions} 次记录，可以退回之前的说法`,
        icon: 'layers',
      },
      { detail: 'evolve.policy', label: '什么时候调整、什么时候停', desc: '按多久的结果算一次、一次最多改多少', icon: 'sliders' },
    )
  },

  usage(modules, ctx) {
    const { sections, status, summary, skillsView, chat, qq, config, runtime, login } = ctx
    modules.push(
      { detail: 'usage.today', label: '今天的账', desc: sections.usage.line || '今天还没花', icon: 'coin' },
      { detail: 'usage.price', label: '单价与预算', desc: '每百万 token 多少钱、每天最多花多少', icon: 'sliders' },
    )
  },

  process(modules, ctx) {
    const { sections, status, summary, skillsView, chat, qq, config, runtime, login } = ctx
    const sandbox = sandboxCard(runtime, config)
    const approvals = sandboxState(runtime)?.approvals || null
    modules.push(
      {
        detail: 'process.debug',
        label: '数据与调试',
        desc: '选一份数据当场核对，改完设置不用去 QQ 试',
        icon: 'sliders',
      },
      {
        detail: 'process.sandbox',
        label: '沙箱',
        desc: sandboxLine(config),
        icon: 'plug',
        badge: sandbox.badge,
        tone: sandbox.tone,
      },
      {
        detail: 'process.approvals',
        label: '沙箱确认',
        desc: '谁被问过、同意还是拒绝、超时几次；记住的结论也在这里清',
        icon: 'shield',
        badge: approvals && approvals.pending ? `${countText(approvals.pending)} 条待确认` : approvals && approvals.asked ? `${countText(approvals.asked)} 次` : '',
        tone: approvals && approvals.pending ? TONE.WARN : TONE.IDLE,
      },
      {
        detail: 'process.audit',
        label: '最近的记录',
        desc: '谁改了什么、哪次没发出去、为什么；可以按类型翻',
        icon: 'layers',
        badge: status['status.auditCount'] ? `${countText(status['status.auditCount'])} 条` : '',
      },
      {
        detail: 'process.cot',
        label: '它当时怎么判断的',
        desc: '做过什么、结论是什么，按时间一条条翻',
        icon: 'spark',
        badge: status['status.cotCount'] ? `${countText(status['status.cotCount'])} 条` : '',
      },
      {
        detail: 'process.activity',
        label: '自主活动',
        desc: '它自己的时间：做了什么、用了多少 token',
        icon: 'spark',
        // 这个数来自自主活动自己的账本，不是从思维链里数出来的 ——
        // 主动开口、群里插话这些不写思维链的推理也算在内。
        badge: `${runtime?.activities?.count?.() ?? 0} 条 · ${countText(activityUsageView(runtime).tokens)} token`,
      },
      {
        // 「刚才为什么没理我」——主人最常问、也最难自己查出来的一件事。
        // 以前行为账本一直在记，但面板上没有任何入口看它。
        detail: 'process.skips',
        label: '没回的时候',
        desc: '哪条消息没回应、为什么；夜间、限流、预算都会写在这儿',
        icon: 'chat',
      },
      {
        detail: 'process.vision',
        label: '看图自检',
        desc: '检查服务、模型图片能力，并真实识别一张测试图',
        icon: 'chat',
      },
    )
  },

  rules(modules, ctx) {
    const { sections, status, summary, skillsView, chat, qq, config, runtime, login } = ctx
    // 先给一份总表，再按链路分开：用户既可能「搜一个词」，也可能「只看注意力」。
    // 分组用的就是 lib/rules.mjs 的 RULE_GROUPS，不在视图层另造一套名字。
    modules.push({
      detail: 'rules.all',
      label: '全部规则',
      desc: `${RULES.length} 条此刻生效的约束，可搜关键词、模块或位置`,
      icon: 'shield',
      badge: `${RULES.length} 条`,
      section: '总表',
    })
    for (const group of RULE_GROUPS) {
      const count = rulesOf(group.id).length
      modules.push({
        detail: `rules.${group.id}`,
        label: group.label,
        desc: group.hint,
        icon: 'layers',
        badge: `${count} 条`,
        section: '按链路',
      })
    }
    if (GAPS.length) {
      modules.push({
        detail: 'rules.gaps',
        label: '还没接上',
        desc: `${GAPS.length} 项已知缺口：先记下来，不装作有`,
        icon: 'plug',
        badge: `${GAPS.length} 项`,
        tone: TONE.WARN,
        section: '缺口',
      })
    }
  },

  settings(modules, ctx) {
    const { sections, status, summary, skillsView, chat, qq, config, runtime, login } = ctx
    for (const group of PANEL_GROUPS) {
      // 只读组不进设置页：它没有「可改」的东西，整表在概览的 status.all 里。
      // 其余每一组都必须出现 —— 包括「QQ 连接」：它虽然也有专门的连接区，
      // 但「能改的都列在这里」这句话要成立，就不能留一个只有别处能找到的例外。
      if (group.id === 'status') continue
      const items = itemsOf(group.id)
      const pending = items.filter((item) => isPending(item.key)).length
      modules.push({
        detail: `settings.${group.id}`,
        label: group.label,
        desc: group.desc,
        icon: 'sliders',
        domain: group.domain,
        domainLabel: domainLabel(group.domain),
        // 分组标题按域走：12 张卡平铺像一堵墙，按「身份 / 表达 / 心智…」
        // 分段之后，用户找的是「哪一类」而不是「第几张」。
        section: domainLabel(group.domain),
        badge: pending ? `${pending} 项目前改了没用` : `${items.length} 项`,
        tone: pending ? TONE.WARN : TONE.IDLE,
      })
    }
    const reminders = runtime && runtime.reminders && typeof runtime.reminders.list === 'function' ? runtime.reminders.list() : []
    modules.push({
      detail: 'reminders.all',
      label: '提醒',
      desc: reminders.length ? `还有 ${reminders.length} 条没到点` : '没有未到点的提醒',
      icon: 'spark',
      badge: reminders.length ? `${reminders.length} 条` : '',
      tone: TONE.IDLE,
      section: '提醒',
    })
  },

  memory(modules, ctx) {
    const { sections, status, summary, skillsView, chat, qq, config, runtime, login } = ctx
    const mem = runtime && runtime.memory && typeof runtime.memory.stats === 'function' ? runtime.memory.stats() : null
    modules.push(
      {
        detail: 'memory.all',
        label: '全部记忆',
        desc: mem ? `事实 ${mem.facts} 条 · 人物 ${mem.people} 个 · 群 ${mem.groups || 0} 个` : '还没有记忆数据',
        icon: 'spark',
        badge: mem ? `${mem.facts + mem.people + (mem.groups || 0)} 条` : '',
        tone: TONE.IDLE,
      },
      {
        detail: 'memory.facts',
        label: '事实',
        desc: '它记住的关于你和这个世界的长期事实',
        icon: 'layers',
        badge: mem ? `${mem.facts} 条` : '',
        tone: TONE.IDLE,
      },
      {
        detail: 'memory.people',
        label: '人物',
        desc: '认识谁、叫什么、聊过什么',
        icon: 'chat',
        badge: mem ? `${mem.people} 个` : '',
        tone: TONE.IDLE,
      },
      {
        detail: 'memory.groups',
        label: '群记忆',
        desc: '每个群最近聊过什么',
        icon: 'grid',
        badge: mem ? `${mem.groups || 0} 个` : '',
        tone: TONE.IDLE,
      },
      {
        detail: 'memory.self',
        label: '自我',
        desc: '它对自己的认识',
        icon: 'spark',
        badge: runtime && runtime.memory && typeof runtime.memory.selfNotes === 'function' ? `${runtime.memory.selfNotes().length} 条` : '',
        tone: TONE.IDLE,
      },
    )
  },

}

/**
 * 每个页面由哪几段组成。顺序 = 从上到下的显示顺序。
 *
 * 这份表是「页面 10 → 6」的唯一定义：taxonomy.REGIONS 决定"有哪些页"，
 * 这里决定"每页由哪些内容拼成"，两边由 check:ui 的 R3 对账。
 */
export const PAGE_CARDS = Object.freeze({
  // 花费不再是独立页：它就是"今天怎么样"的一部分，放在状态牌之后
  overview: Object.freeze(['overview', 'usage']),
  talk: Object.freeze(['talk']),
  // 学习不再是独立页：它回答的是"它变成什么样了"，与记忆同一个主题
  mind: Object.freeze(['memory', 'evolve']),
  // 规则不再是独立页：它回答的是"它被允许做什么"，与技能同一个主题
  ability: Object.freeze(['skills', 'rules']),
  channel: Object.freeze(['connection']),
  settings: Object.freeze(['settings']),
  process: Object.freeze(['process']),
})

function modulesOf(input) {
  const ctx = { ...input, login: input.sections?.login || null }
  const modules = []
  for (const part of PAGE_CARDS[input.regionId] || []) CARD_PARTS[part]?.(modules, ctx)
  // 同一页里同一个详情只留一次，先出现的赢。
  //
  // 页面合并之后必然会撞：总览片段本来就有「今天的账」，花费片段又有一张。
  // 两处都在说同一件事，重复的后果不是"多一张卡"，而是**前端出现重复的 key**，
  // React 会静默只渲染第一张，另一张的 hover、跳转跟着错位。
  // 与其要求每个片段自己记住"别人推过没有"，不如在这里一次说清。
  const seen = new Set()
  const unique = []
  for (const one of modules) {
    const key = String(one.detail || '')
    if (key && seen.has(key)) continue
    if (key) seen.add(key)
    unique.push(one)
  }
  return unique
}

/**
 * 规则的显示行。
 *
 * 正文只放「此刻生效的约束」，不写前后对比 —— 变更看板负责历史，面板负责现在。
 * 现场值单独做角标：规则正文保持稳定，数字随配置变，两边不会各说一套。
 */
function ruleRowsOf({ groupId = '', config = {} } = {}) {
  const read = (key) => get(config, key)
  return rulesOf(groupId).map((rule) => {
    const live = typeof rule.live === 'function' ? safeCall(() => String(rule.live(read) || ''), '') : ''
    return {
      id: rule.id,
      title: rule.title,
      desc: rule.rule,
      meta: `${rule.module} · ${rule.where}`,
      // 分组只在「全部规则」里画：单独打开一组时，页标题已经说了是哪一组
      group: groupId ? '' : ruleGroupLabel(rule.group),
      badge: live,
      tone: TONE.IDLE,
    }
  })
}

/** 节奏一句话：面板上不给数字表格，先给一句人能读的话 */
function rhythmLine({ typing = null, attention = null } = {}) {
  const bits = []
  if (typing) {
    bits.push(typing.typed ? `发出 ${countText(typing.typed)} 条，上次等了 ${spanText(typing.lastWaitMs)}` : '还没发过话')
    if (typing.busy) bits.push(`正在打 ${countText(typing.waiting)} 条`)
  }
  if (attention) bits.push(attention.people ? `${countText(attention.people)} 个热窗口` : '没有热窗口')
  return bits.join('；') || '还没接上'
}

/** 已知缺口：每条都要有「下一步」，否则只是一句抱怨 */
function gapRowsOf() {
  return GAPS.map((gap) => ({
    id: gap.id,
    title: gap.title,
    desc: gap.desc,
    meta: `${gap.module}${gap.key ? ' · ' + gap.key : ''} · 下一步：${gap.next}`,
    badge: '还没接上',
    tone: TONE.WARN,
  }))
}

/** 沙箱一句话：档位说中文，限额带单位 */
function sandboxLine(config) {  const mode = String(get(config, 'sandbox.mode') || 'ask')
  const labels = { free: '自由', ask: '先问我', off: '关掉' }
  const perHour = get(config, 'sandbox.hourlyMax')
  const perDay = get(config, 'sandbox.dailyMax')
  if (mode === 'off') return '现在是「关掉」，它不能跑任何代码'
  return `现在是「${labels[mode] || mode}」：每小时最多 ${perHour ?? '—'} 次、每天最多 ${perDay ?? '—'} 次`
}

/**
 * 执行器现在是什么状态。
 *
 * 没有执行器（这次运行没接上、或测试里的假运行时）就返回 null ——
 * 面板据此写「没有执行器」，而不是编一个 0 出来冒充「今天没跑过」。
 */
function sandboxState(runtime) {
  const sandbox = runtime && runtime.sandbox
  if (!sandbox || typeof sandbox.status !== 'function') return null
  try {
    return sandbox.status()
  } catch {
    return null
  }
}

/** 拒绝原因的短说法。牌子上一格放不下长句，完整原因在审计里 */
const SANDBOX_REASONS = Object.freeze({
  off: '沙箱关着',
  ask: '先问我档',
  fuse: '熔断中',
  plan: '没交计划',
  empty: '代码空着',
  too_long: '代码太长',
  gate: '碰到禁止写法',
  lang: '写的是 Python',
  quota_hour: '这一小时到顶了',
  quota_day: '今天到顶了',
  timeout: '超时',
  net: '要联网',
  denied: '越界读写',
  memory: '内存超限',
  killed: '被系统停掉',
  failed: '跑出错了',
})

function sandboxReason(reason) {
  const key = String(reason || '')
  return SANDBOX_REASONS[key] || (key ? `没跑成（${key}）` : '没跑成')
}

/** 过程区那张卡片的角标与语气：关闭 / 熔断要压过次数 —— 状态比统计重要 */
function sandboxCard(runtime, config) {
  if (String(get(config, 'sandbox.mode') || '') === 'off') return { badge: '已关闭', tone: TONE.IDLE }
  const state = sandboxState(runtime)
  if (!state) return { badge: '暂时用不了', tone: TONE.WARN }
  if (state.fuseLeftMs) return { badge: '已熔断', tone: TONE.BAD }
  return state.today
    ? { badge: `今天 ${countText(state.today)} 次`, tone: TONE.OK }
    : { badge: '今天还没跑', tone: TONE.IDLE }
}

/** 确认留档里那几种决定的说法。未知值原样显示，不编一个看起来合理的词 */
const APPROVAL_LABELS = Object.freeze({
  asked: '发问',
  allow: '同意',
  deny: '拒绝',
  timeout: '超时拒绝',
  remembered: '按记住的结论',
  forget: '清掉记住',
  overflow: '排队满，没问',
})

/** 沙箱页的横幅：把「执行器在不在、档位是什么意思」说清楚，不夸大隔离强度 */
function sandboxNotice(state, mode, config) {
  if (!state) return '现在还不能在这儿跑代码：这次没接上执行环境，跑不了的原因会记下来。'
  if (mode === 'off') return '沙箱是关着的：一条都不会执行。'
  if (mode === 'ask') return `「先问我」：每次跑之前会弹一次确认（默认等 ${get(config, 'sandbox.confirmSeconds') ?? '—'} 秒，走完没人点就按拒绝处理）。拒绝可以写一句理由，勾了「记住我的选择」以后不再弹。`
  if (state.fuseLeftMs) return `熔断中：连续越界，先停 ${spanText(state.fuseLeftMs)}，期间一条都不跑。`
  const max = Number(get(config, 'sandbox.maxCodeBytes')) || 0
  return `现在可以跑：代码放在独立的小空间里，只看得到这次要用的东西，到点就停；单段最多 ${Math.round(max / 1024)} KB，每次都会留一条记录。`
}

// ── 详情页 ──────────────────────────────────────────────────────

/**
 * 取一个详情。id 就是模块卡上的 `detail`。
 *
 * 返回的 `kind` 决定前端怎么画（闭集在 truth/taxonomy.mjs 的 DETAIL_KINDS）：
 *   cards —— 一格格状态牌（沙箱、权重、预算、状态全表）
 *   rows  —— 一条条记录（技能、会话列表、审计、思维链），可分页
 *   chat  —— 聊天窗口（独立对话、QQ 会话），带输入框
 *   form  —— 一组可改的配置（设置）
 *   image / groups / vision —— 前端按 src 自己再取一次的东西
 * 加新形状之前先问一句：是不是把两种东西硬塞进一个界面了。
 */
/**
 * 群名字典：通道那边有缓存就同步取（面板是同步渲染，不能等网络）。
 * 拿不到就是空串，调用方自己退回「群 + 号」。
 */
function groupNameOf(channel, groupId) {
  try {
    if (channel && typeof channel.groupNameOf === 'function') return String(channel.groupNameOf(groupId) || '')
  } catch {}
  return ''
}

export function detailView(input = {}) {
  const { runtime, chat, usage, guard, channel, typing, attention, id, before, at = Date.now() } = input
  const limit = input.limit
  const key = String(id || '')
  // 面包屑指向哪个区域：`qq:*` 归对话，其余按点号前一段。与 taxonomy 同一份规则，
  // 浏览器侧不另算一遍，否则「详情在 A 区、面包屑写 B 区」会长期存在。
  const region = regionOfDetail(key) || 'overview'
  const config = safeCall(() => runtime?.config || {}, {})
  // 登录快照是 NapCatLogin 的同步缓存，详情页拿它只为「说清楚现在到哪一步」
  const login = safeCall(() => loginSnapshot(runtime), null)
  // 四份数据按需取：打开「设置」不该顺手把 37 项技能和整本审计算一遍。
  // 每次 detail 请求只算真正用到的那些（memo 保证同一分支里只算一次）。
  const memo = (fn) => {
    let done = false
    let value
    return () => {
      if (!done) {
        value = fn()
        done = true
      }
      return value
    }
  }
  const getStatus = memo(() => safeCall(() => runtime?.status?.() || {}, {}))
  const getSkills = memo(() => safeCall(() => runtime?.skills?.() || { groups: [], counts: {} }, { groups: [], counts: {} }))
  const getSummary = memo(() => safeCall(() => runtime?.evolver?.summary?.(at) || { weights: {} }, { weights: {} }))

  const base = { ok: true, id: key, region, at }

  // ── 独立对话 ──
  if (key === 'talk.local') {
    const history = safeCall(() => (chat ? chat.history({ limit, before }) : { rows: [] }), { rows: [] })
    return {
      ...base,
      kind: 'chat',
      title: '独立对话',
      subtitle: '不走 QQ：不开协议端也能说上话。回复只留在这块屏幕里',
      chat: {
        source: 'local',
        conversation: '',
        canSend: chat?.ready === true,
        disabledReason: chat?.ready ? '' : '生成能力还没接上：宿主没把模型给我',
        // 存储层用 from: 'me' / 'self'，而聊天气泡组件只认 self / who。
        // 这一层负责把领域形状转成界面形状，与 QQ 会话的 thread() 对齐；
        // 不转的话独立对话里所有气泡都堆在同一边，也分不清谁说的。
        // 视角差异要说清：独立对话里「自己这边」是用户（me），
        // QQ 界面里「自己这边」是它（self）—— 两处方向不同，但都是对的。
        rows: (history.rows || [])
          .filter((row) => String(row?.text || '').trim())
          .map((row) => ({
            id: row.id,
            at: row.at,
            self: row.from === 'me',
            who: row.from === 'self' ? String(get(config, 'persona.name') || '它') : '我',
            text: row.text,
            parts: row.parts || [],
            tone: row.tone || '',
          })),
        nextBefore: history.nextBefore || null,
        hasMore: history.hasMore === true,
        pageSize: Math.max(1, Math.min(200, Number(limit) || 60)),
      },
    }
  }

  // ── QQ 会话列表 ──
  if (key === 'talk.qq') {
    const face = channelFace(safeCall(() => channel?.state?.() || 'unknown', 'unknown'), {
      lastInboundAt: Number(channel?.lastInboundAt) || 0,
      now: at,
    })
    const list = listConversations({ events: runtime?.events, scan: 500, limit: 100, groupName: (id) => groupNameOf(channel, id) })
    return {
      ...base,
      kind: 'rows',
      title: 'QQ 会话',
      subtitle: face.label + '：' + (face.tone === TONE.OK ? '可以在这里直接替它发话' : '现在只能看，发不出去'),
      notice: face.tone === TONE.OK ? '' : `通道${face.label}。要发消息，先去「设置 → QQ 连接」把地址与登录弄好。`,
      rows: list.rows.map((row) => ({
        id: row.conversation,
        open: `qq:${row.conversation}`,
        title: row.title,
        meta: `${row.where} · ${row.count} 条 · ${agoText(row.lastAt, at)}`,
        desc: row.lastText,
        tone: row.lastFrom === 'self' ? TONE.IDLE : TONE.OK,
        badge: row.lastFrom === 'self' ? '我说最后一句' : row.lastWho,
      })),
      empty: '还没有任何 QQ 消息。连上协议端之后，这里的会话会自己出现。',
    }
  }

  // ── 说话的节奏：打字台 + 注意力账本的实时读数 ──
  // 这两个模块 0.35 就装上了，但面板里一直没有任何地方能看它们跑了什么。
  // 只读、按需取，不碰账本本身。
  if (key === 'overview.rhythm') {
    const t = safeCall(() => (typeof typing?.stats === 'function' ? typing.stats() : null), null)
    const a = safeCall(() => (typeof attention?.stats === 'function' ? attention.stats() : null), null)
    if (!t && !a) {
      return {
        ...base,
        kind: 'rows',
        title: '说话的节奏',
        subtitle: '',
        rows: [],
        empty: '打字台与注意力都还没装配：宿主没把它们交给面板。',
      }
    }
    const cards = []
    if (t) {
      cards.push(
        { label: '已发出', value: countText(t.typed) + ' 条', tone: TONE.IDLE, hint: '打字台经手的条数，含分条' },
        {
          label: '正在打',
          value: t.busy ? `${countText(t.waiting)} 条在等` : '空闲',
          tone: t.busy ? TONE.OK : TONE.IDLE,
          hint: '全局只有一条在打：私聊和群聊排同一队',
        },
        {
          label: '上次等了',
          value: spanText(t.lastWaitMs),
          tone: TONE.IDLE,
          hint: '从「决定要回」到第一条真的发出去，中间等的时间',
        },
        {
          label: '省掉的等待',
          value: spanText(t.savedMs),
          tone: TONE.IDLE,
          hint: '生成期间已经亮着「正在输入」，这段时间从打字时长里扣掉了',
        },
        {
          label: '拥挤降速',
          value: countText(t.overloads) + ' 次',
          tone: t.overloads ? TONE.WARN : TONE.IDLE,
          hint: '队列满时不再人为拖时间；有人在排队时单条最多打 4 秒',
        },
      )
    }
    if (a) {
      cards.push(
        {
          label: '热窗口',
          value: `${countText(a.people)} 个人 / ${countText(a.conversations)} 个会话`,
          tone: a.people ? TONE.OK : TONE.IDLE,
          hint: '窗口里的人不用 @ 也会接话',
        },
        { label: '接着聊多久', value: spanText(a.windowMs), tone: TONE.IDLE, hint: '刚聊过的人，这段时间里不用点名也会接' },
        { label: '最多接着说几次', value: countText(a.maxTurns) + ' 次', tone: TONE.IDLE, hint: '到数就换下一个人，不会一直缠着聊' },
        {
          label: '换人次数',
          value: countText(a.handoffs) + ' 次',
          tone: TONE.IDLE,
          hint: a.lastHandoff
            ? `最近一次：${a.lastHandoff.from} → ${a.lastHandoff.to}（${agoText(a.lastHandoff.at, at)}）`
            : '还没换过：窗口只由一个人热着，或没人接话',
        },
      )
    }
    return {
      ...base,
      kind: 'cards',
      title: '说话的节奏',
      subtitle: '打字台管「发的样子」，注意力管「在跟谁说话」；两者都不改内容',
      cards,
      note: '这些是现在这一刻的情形，重开一次会从头算。',
    }
  }

  // ── 注意力现场：现在在跟谁说话、还能接着聊多久 ──
  if (key === 'overview.attention') {
    const list = safeCall(() => (typeof attention?.snapshot === 'function' ? attention.snapshot() : []), [])
    return {
      ...base,
      kind: 'rows',
      title: '现在在跟谁说话',
      subtitle: '刚聊过的人不用点名也会接；过一阵没动静就自然结束',
      rows: list.map((one) => ({
        id: `${one.conversation}:${one.who}`,
        title: one.who === '*' ? '整个会话' : `QQ ${one.who}`,
        meta: `${one.conversation} · 还能接着聊 ${spanText(one.remainingMs)}`,
        desc: '',
        tone: TONE.IDLE,
        badge: one.turns >= one.max ? '快结束了' : '',
      })),
      empty: '现在没有热窗口：群里要 @ 或叫名字才会接话。',
      note: '窗口按人开：同一个人一个窗口；换人时旧窗口关掉，一次只留一个热目标。',
    }
  }

  // ── 单个 QQ 会话 ──
  if (key.startsWith('qq:')) {
    const conversation = key.slice(3)
    const peer = peerOf(conversation)
    const face = channelFace(safeCall(() => channel?.state?.() || 'unknown', 'unknown'), {
      lastInboundAt: Number(channel?.lastInboundAt) || 0,
      now: at,
    })
    // 群聊默认加载 100 条：40 条只够看半屏，「翻消息」第一页就到底了。
    // 仍按消息条数算（thread 内部先过滤心跳/通知），不是日志行数。
    const pageSize = Math.max(1, Math.min(200, Number(limit) || THREAD_PAGE_SIZE))
    const page = thread({ events: runtime?.events, conversation, limit: pageSize, before })
    const groupName = peer.scope === 'group' ? groupNameOf(channel, peer.id) : ''
    return {
      ...base,
      kind: 'chat',
      // 群里给人看名字，群号退到副标题 —— 群号对人没有意义，还会和 QQ 号混淆
      title: peer.scope === 'group' ? groupName || `群 ${peer.id}` : `QQ ${peer.id}`,
      subtitle: peer.scope === 'group' ? (groupName ? `群聊 · ${peer.id}` : '群聊') : '私聊',
      chat: {
        source: 'qq',
        conversation,
        scope: peer.scope,
        target: peer.scope === 'group' ? peer.id : peer.id,
        canSend: face.tone === TONE.OK,
        disabledReason: face.tone === TONE.OK ? '' : `通道${face.label}，发不出去`,
        rows: page.rows || [],
        pageSize: page.pageSize || pageSize,
        nextBefore: page.nextBefore || null,
        hasMore: page.hasMore === true,
      },
    }
  }

  // ── 技能 ──
  if (key === 'skills.all' || key.startsWith('skills.')) {
    const skillsView = getSkills()
    const groupId = key === 'skills.all' ? '' : key.slice(7)
    const groups = groupId ? sectionsSkillsGroup(skillsView, groupId) : skillsOf({ skillsView }).groups
    const rows = groups.flatMap((group) =>
      group.items.map((item) => ({
        id: item.id,
        title: `${group.label} · ${item.name}`,
        meta: `${item.source === 'taught' ? '自己学/教' : '原有'} · ${item.stateLabel} · ${
          // 0 次的时候别把「没试过」写三遍（原来那行是「没试过 · 用过 0 次 · 成功率 还没试过」）。
          // 这三个字段本来就同源：没调用过就只能没试过，成功率也必然没有。
          Number(item.uses) > 0 ? `${item.masteryLabel} · 用过 ${item.uses} 次 · 成功率 ${item.rateText}` : '还没用过（用一次就记下）'
        }`,
        desc: item.why && item.state !== 'on' ? `${item.what}（原因：${item.why}）` : item.what,
        tone: item.tone,
        badge: item.risk === 'high' ? '高危' : '',
        // 开关跟着行走：详情页里也要能开能关，而不是「看得到、改不了」
        skill: { id: item.id, name: item.name, what: item.what, group: item.group, state: item.state, toggleable: item.toggleable, wired: item.wired !== false },
        // 教过的能改名、能忘掉。名字打错或粘进乱码时，「忘掉重教」会把
        // 开关与成功率一起清零 —— 改一个错字不该付出这个代价。
        actions: item.canForget
          ? [{ action: 'edit-skill', actionLabel: '改名' }, { action: 'forget-skill', actionLabel: '忘掉' }]
          : [],
      })),
    )
    return {
      ...base,
      kind: 'rows',
      title: groupId ? (SKILL_GROUPS.find((group) => group.id === groupId)?.label || '技能') : '全部技能',
      subtitle: skillsView.line || '',
      rows,
      empty: '这一组还没有登记任何技能',
    }
  }

  // ── 学习 ──
  if (key === 'evolve.weights') {
    const summary = getSummary()
    const weight = weightRowsOf({ summary, skillsView: getSkills() })
    return {
      ...base,
      kind: 'cards',
      title: '现在偏向怎么说话',
      subtitle: `一共调过 ${summary.changes} 次`,
      cards: [
        ...weight.toolRows.map((row) => ({ label: row.label, value: row.value, tone: row.tone, hint: '办事的习惯' })),
        ...weight.behaviorRows.map((row) => ({ label: row.label, value: row.value, tone: row.tone, hint: '接话的习惯' })),
        ...weight.styleRows.map((row) => ({ label: row.label, value: row.value, tone: row.tone, hint: '说话的样子' })),
      ],
      note: summary.paused ? '先停一停：最近几次说完都没人接，24 小时后再看' : '只按「说完有没有人接」慢慢调整，不看聊天内容',
    }
  }

  if (key === 'evolve.history') {
    const summary = getSummary()
    const history = safeCall(() => runtime?.evolver?.history?.() || [], [])
    return {
      ...base,
      kind: 'rows',
      title: '退回上一次',
      subtitle: `留着 ${history.length} 次记录；退回前会再问一次`,
      rows: history.map((row) => ({
        id: `v${row.version}`,
        title: `第 ${row.version} 次调整`,
        meta: agoText(row.at, at),
        desc: row.version === summary.version ? '现在正在用' : '可以退回这一版',
        tone: row.version === summary.version ? TONE.OK : TONE.IDLE,
        badge: row.version === summary.version ? '当前' : '',
      })),
      empty: '还没有历史版本',
      note: '回滚入口会在「权重自动回滚」接通后出现；现在只能看，不能点。',
    }
  }

  if (key === 'evolve.policy') {
    const summary = getSummary()
    const w = summary.weights || {}
    return {
      ...base,
      kind: 'cards',
      title: '什么时候调整、什么时候停',
      subtitle: '这些是规则，不是偏好 —— 改了会影响它学得多快',
      cards: [
        { label: '多久看一次结果', value: withUnit(get(config, 'evolve.window'), '句对话'), hint: '攒够多少句结算一次' },
        { label: '调整幅度', value: withUnit(Number(get(config, 'evolve.ema')), '倍'), hint: '越大越信这一次的结果' },
        { label: '一次最多改多少', value: withUnit(Number(get(config, 'evolve.clamp')), '倍'), hint: '防止被偶然带偏' },
        { label: '留几次记录', value: withUnit(get(config, 'evolve.keepVersions'), '次'), hint: '能退回多少次' },
        { label: '当前状态', value: summary.paused ? '先停一停' : '正常', tone: summary.paused ? TONE.WARN : TONE.OK, hint: summary.paused ? `停到 ${new Date(Number(summary.pausedUntil) || at).toLocaleString('zh-CN', { hour12: false })}` : '按结果慢慢调' },
        { label: '记忆衰减', value: String(w.netDecay ?? '—'), hint: '每跳一层忘掉多少' },
      ],
      note: '连着几次说完都没人接，就退回上一次并先停 24 小时。',
    }
  }

  // ── 规则 ──
  if (key === 'rules.all' || key.startsWith('rules.')) {
    if (key === 'rules.gaps') {
      return {
        ...base,
        kind: 'rows',
        title: '还没接上',
        subtitle: '已知缺口：先记下来，不装作有',
        rows: gapRowsOf(),
        empty: '之前登记的三个缺口都已接上，现在没有未接项',
        note: GAPS.length ? '这些是需求，不是开关；接上之前不要把对应能力写进「已支持」。' : '换人判定、QQ 空间说说、跨群记忆都已接上。',
      }
    }
    const groupId = key === 'rules.all' ? '' : key.slice('rules.'.length)
    const group = groupId ? RULE_GROUPS.find((one) => one.id === groupId) : null
    if (groupId && !group) {
      return {
        ...base,
        kind: 'rows',
        title: '没有这一组规则',
        subtitle: '',
        rows: [],
        empty: '这一组没有登记规则。',
      }
    }
    return {
      ...base,
      kind: 'rows',
      title: group ? group.label : '全部规则',
      subtitle: group ? group.hint : '此刻仍然生效的硬约束；现场值读当前配置',
      rows: ruleRowsOf({ groupId, config }),
      search: true,
      empty: '这一组还没有登记规则',
      note: '规则正文只在规则清单里维护；改了对应模块，要回来改这一条。',
    }
  }

  // ── 花费 ──
  if (key === 'usage.today') {
    const today = usage ? safeCall(() => usage.today(at), {}) : {}
    const lifetime = usage && typeof usage.total === 'function' ? safeCall(() => usage.total(at), null) : null
    const tokens = (Number(today.input) || 0) + (Number(today.output) || 0)
    return {
      ...base,
      kind: 'cards',
      title: '今天的账',
      subtitle: usage ? safeCall(() => usage.line(at), '') : '还没有账本',
      cards: [
        { label: '输入 token', value: countText(today.input), hint: '发给模型的上下文' },
        { label: '输出 token', value: countText(today.output), hint: '模型生成的正文' },
        { label: '合计', value: countText(tokens), hint: `一共 ${countText(today.calls)} 次调用` },
        {
          // 累计值和今日值放在同一页：两者一起看才知道「今天」在整段历史里占多少
          label: '累计总用量',
          value: lifetime ? countText(lifetime.tokens) : '—',
          tone: TONE.IDLE,
          hint: lifetime
            ? `${lifetime.since ? `从 ${lifetime.since} 起` : '从有账本起'}，共 ${countText(lifetime.calls)} 次调用、约 ${moneyText(lifetime.cost, lifetime.currency)}`
            : '还没有账本',
        },
        { label: '今天花了', value: moneyText(today.cost, today.currency), tone: today.over ? TONE.BAD : TONE.OK, hint: today.budget ? `预算 ${moneyText(today.budget, today.currency)}` : '没设日预算' },
        { label: '预算还剩', value: today.budget ? moneyText(today.left, today.currency) : '没设上限', tone: today.over ? TONE.BAD : TONE.IDLE, hint: today.budget ? '超过就会停下并提醒' : '0 表示不设上限' },
        { label: '计价货币', value: today.currency === 'USD' ? '美元（$）' : '人民币（元）', hint: '在「设置 → 花费」里改' },
      ],
      note: '账本按天切（保留 90 天），累计总用量单独记一份、不随裁剪减少；一天超过 2000 次调用时当天统计会偏少（已知上限）。',
    }
  }

  if (key === 'usage.price') {
    const currency = String(get(config, 'usage.currency') || 'CNY')
    const symbol = currency === 'USD' ? '$' : '¥'
    return {
      ...base,
      kind: 'cards',
      title: '单价与预算',
      subtitle: '填错了这里，上面的钱数全都会跟着错',
      cards: [
        { label: '计价货币', value: currency === 'USD' ? '美元（$）' : '人民币（元）' },
        { label: '输入单价', value: `${symbol}${get(config, 'usage.inputPerM') ?? '—'} / 百万 token`, hint: '每百万输入 token 的价格' },
        { label: '输出单价', value: `${symbol}${get(config, 'usage.outputPerM') ?? '—'} / 百万 token`, hint: '每百万输出 token 的价格' },
        { label: '每天预算', value: withUnit(get(config, 'usage.budgetPerDay'), '元/天'), hint: '0 表示不设上限' },
      ],
      note: '改单价要进「设置 → 花费」，那里会校验范围。',
    }
  }

  // ── 过程 ──
  // ── 数据与调试：同一份清单驱动界面与后端，改完参数当场能核对 ──
  if (key === 'process.debug') {
    return {
      ...base,
      kind: 'debug',
      title: '数据与调试',
      subtitle: '选一份数据，跑一次，当场看结果；不用切到 QQ 发消息碰运气',
      items: DEBUG_ITEMS.map((one) => ({ ...one })),
      note: '核对的是当前这一刻的真数据。改过设置后回来再跑一次，就能看到改动有没有生效。',
    }
  }

  if (key === 'process.sandbox') {
    const mode = String(get(config, 'sandbox.mode') || 'ask')
    // 档位中文名的唯一出处是 panel.mjs 的 OPTION_LABELS，这里不再抄一份。
    // 抄一份的代价在改名时才现形（「跑代码」→「沙箱」那次就漏了这一处）。
    // 后面那个兜底只在这一项将来被移除时顶上，正常不会走到。
    const labels = optionLabelsOf('sandbox.mode') || { free: '自由', ask: '先问我', off: '关掉' }
    const state = sandboxState(runtime)
    const last = state?.last || null
    const lastText = !last
      ? '还没有跑过'
      : last.kind === 'deny'
        ? `${agoText(last.at, at)}被拒：${sandboxReason(last.reason)}`
        : last.ok
          ? `${agoText(last.at, at)}跑成，用了 ${spanText(last.ms)}`
          : `${agoText(last.at, at)}没跑成：${sandboxReason(last.reason)}`
    return {
      ...base,
      kind: 'cards',
      title: '沙箱',
      subtitle: state ? '沙箱现在能跑，下面是这次的情况' : '沙箱这次没接上，暂时跑不了',
      cards: [
        { label: '自治档位', value: labels[mode] || mode, tone: mode === 'free' ? TONE.WARN : TONE.IDLE, hint: '改这里等于改它能不能自己动手' },
        {
          label: '今天跑了',
          value: state ? `${countText(state.today)} / ${countText(state.dailyMax)} 次` : '—',
          tone: state && state.dailyMax && state.today >= state.dailyMax ? TONE.BAD : TONE.IDLE,
          hint: '到了上限就拒绝，跨天自动清零',
        },
        {
          label: '这一小时',
          value: state ? `${countText(state.hour)} / ${countText(state.hourlyMax)} 次` : '—',
          tone: state && state.hourlyMax && state.hour >= state.hourlyMax ? TONE.BAD : TONE.IDLE,
          hint: '超过就不许再跑',
        },
        {
          label: '熔断',
          value: !state ? '—' : state.fuseLeftMs ? `还有 ${spanText(state.fuseLeftMs)}` : '正常',
          tone: state && state.fuseLeftMs ? TONE.BAD : TONE.IDLE,
          hint: `连续越界 ${get(config, 'sandbox.fuseAfter') ?? '—'} 次就停 ${get(config, 'sandbox.fuseHours') ?? '—'} 小时`,
        },
        {
          label: '等人确认',
          value: state ? countText(state.approvals?.pending || 0) : '—',
          tone: state && state.approvals?.pending ? TONE.WARN : TONE.IDLE,
          hint: `「先问我」档弹窗等 ${state?.confirmSeconds ?? '—'} 秒；走完没人点按拒绝处理`,
        },
        {
          label: '确认记录',
          value: state ? `同意 ${countText(state.approvals?.allowed || 0)} / 拒绝 ${countText((state.approvals?.denied || 0) + (state.approvals?.timedOut || 0))}` : '—',
          hint: '超时也记在拒绝里；每一条都能在「沙箱确认」里翻',
        },
        {
          label: '记住的结论',
          value: state?.approvals?.remember ? (state.approvals.remember.allow ? '一律同意' : '一律拒绝') : '没记住',
          tone: state?.approvals?.remember && !state.approvals.remember.allow ? TONE.WARN : TONE.IDLE,
          hint: state?.approvals?.remember?.reason
            ? `理由：${String(state.approvals.remember.reason).slice(0, 24)}`
            : '在弹窗里勾「记住我的选择」才会写下来，可随时清掉',
        },
        { label: '上次运行', value: lastText, hint: '被拒也记一笔，完整原因在审计里' },
        { label: '单次超时', value: withUnit(get(config, 'sandbox.timeoutMs'), '毫秒'), hint: '到点就掐掉' },
        { label: '内存上限', value: withUnit(get(config, 'sandbox.memMb'), 'MB'), hint: '超过会被杀' },
        { label: '代码长度', value: withUnit(get(config, 'sandbox.maxCodeBytes'), '字节'), hint: '一次最多贴这么多' },
        { label: '熔断阈值', value: withUnit(get(config, 'sandbox.fuseAfter'), '次'), hint: '连续越界几次就停' },
        { label: '熔断时长', value: withUnit(get(config, 'sandbox.fuseHours'), '小时'), hint: '停多久' },
      ],
      notice: sandboxNotice(state, mode, config),
    }
  }

  if (key === 'process.approvals') {
    const desk = runtime?.sandbox?.approvals
    if (!desk || typeof desk.recent !== 'function') {
      return {
        ...base,
        kind: 'rows',
        title: '沙箱确认',
        subtitle: '「先问我」档的弹窗与留档',
        rows: [],
        empty: '沙箱这次没接上，确认界面也用不了。',
      }
    }
    const stats = safeCall(() => desk.stats(), {}) || {}
    const rows = []
    const remember = stats.remember || null
    if (remember) {
      rows.push({
        id: 'remember',
        title: `记住的结论：${remember.allow ? '一律同意' : '一律拒绝'}`,
        meta: remember.at ? agoText(remember.at, at) + '记下的' : '记下的',
        desc: remember.reason ? `理由：${remember.reason}` : '没写理由；「记住我的选择」勾上时才会写下来',
        aside: '生效中',
        tone: remember.allow ? TONE.OK : TONE.WARN,
        // `forget-` 前缀会让前端自动加一次「再点一下」的确认 —— 清掉一个结论值得两下
        actions: [{ action: 'forget-approval', actionLabel: '清掉' }],
      })
    }
    // 账本按时间往下翻，但同一个请求会先有一条 asked、后来一条 allow/deny。
    // 只留这个请求最后的那一条：否则一段代码会变成两行，看着像问了两次。
    const seen = new Set()
    for (const row of safeCall(() => desk.recent(80), []) || []) {
      const id = String(row.id || '')
      const decision = String(row.decision || '')
      if (id && seen.has(id)) continue
      if (id) seen.add(id)
      const label = APPROVAL_LABELS[decision] || decision
      const pending = decision === 'asked'
      const allow = row.allow === true
      const purpose = String(row.purpose || row.label || '')
      rows.push({
        id: `a:${id || row.at}`,
        title: pending ? `等你点：${purpose || '有一段代码要跑'}` : label + (purpose ? `：${purpose}` : ''),
        meta: [
          clockText(row.at),
          row.project ? String(row.project) : '',
          row.hash ? String(row.hash).slice(0, 8) : '',
          row.bytes ? String(row.bytes) + ' 字节' : '',
        ].filter(Boolean).join(' · '),
        desc: row.reason ? String(row.reason) : pending ? '还没人处理；超时会按拒绝记一条' : '没写理由',
        aside: pending ? '进行中' : '',
        tone: pending ? TONE.WARN : allow ? TONE.OK : decision === 'timeout' ? TONE.WARN : TONE.BAD,
      })
    }
    return {
      ...base,
      kind: 'rows',
      title: '沙箱确认',
      subtitle: `问了 ${countText(stats.asked || 0)} 次 · 同意 ${countText(stats.allowed || 0)} · 拒绝 ${countText((stats.denied || 0) + (stats.timedOut || 0))}（其中超时 ${countText(stats.timedOut || 0)}）${stats.remembered ? ` · 按记住的结论直接放行 ${countText(stats.remembered)} 次` : ''}`,
      rows,
      empty: '还没问过。等「先问我」档第一次要跑代码时，这里会出现一条。',
      note: '每次发问、同意、拒绝、超时、记住、忘记都写进 sandbox/approvals.jsonl，同时进审计；超时默认按拒绝处理。',
    }
  }

  if (key === 'process.audit') {
    // 三件事分开看：
    //   · 设置里的 log.audit* 是**默认口径**（打开页面不用每次点）；
    //   · 页面上点的那几个胶囊是**临时口径**（这一次、这一页）；
    //   · 无论哪一套，都只影响「显示什么」，磁盘上的 audit.jsonl 一条不少。
    const configured = auditFilter(runtime?.config || {})
    const askedLevel = String(input.level || '')
    const level = LEVELS[askedLevel] === undefined ? configured.level : askedLevel
    const askedKinds = String(input.kind || '').trim()
    const kinds = askedKinds ? askedKinds.split(',').map((one) => one.trim()).filter(Boolean) : configured.kinds
    const askedNoise = input.noise === undefined || input.noise === null ? '' : String(input.noise)
    const noise = askedNoise === '' ? configured.noise : askedNoise !== '0'
    const filter = { level, kinds, noise }
    const page = journalPage(runtime?.audit, { before, limit, filter: (row) => auditVisible(row, filter) })
    return {
      ...base,
      kind: 'rows',
      title: '审计日志',
      subtitle: auditSubtitle(filter),
      rows: page.rows.map((row) => ({
        id: String(row.id || `${row.at}`),
        title: labelOf(row.kind),
        meta: `${clockText(row.at)} · ${levelName(severityOf(row.kind))} · ${String(row.kind || '')}`,
        desc: auditDesc(row),
        tone: auditTone(row.kind),
      })),
      // 页面顶上那几个胶囊要用的东西：当前口径 + 能选什么。
      // 把「能选什么」交给服务端，前端就不用再抄一份档位表（抄了必分叉）。
      filter: {
        level,
        kinds,
        noise,
        levels: LEVEL_IDS.map((id) => ({ id, label: LEVEL_LABELS[id] })),
        dirty: !!(askedLevel || askedKinds || askedNoise),
      },
      nextBefore: page.nextBefore,
      hasMore: page.hasMore,
      empty: `没有符合「${levelNoun(level)}」的审计记录`,
    }
  }

  if (key === 'process.skips') {
    // 「刚才为什么没回我」——用户最常问、也最难自己查出来的一件事。
    //
    // 为什么以前查不到：行为账本（behaviors.jsonl）一直在记每条消息的处置结果，
    // 但面板上没有任何入口看它，审计页也只读 audit.jsonl（另一本账）。
    // 主人看到「他/她没理我」，能做的只有翻 QQ 记录或者重启。
    //
    // 这里只列「没回」的那些（有回复的不用看），按时间倒序。
    const page = journalPage(runtime?.behaviors, { before, limit })
    const rows = page.rows.filter((row) => isSkipRow(row))
    return {
      ...base,
      kind: 'rows',
      title: '没回的时候',
      subtitle: rows.length ? `最近 ${rows.length} 次没有回应` : '最近每条消息都回了',
      rows: rows.map((row) => ({
        id: String(row.eventId || `${row.ts || row.at}`),
        title: skipReasonOf(row),
        meta: `${clockText(row.ts || row.at)}${row.scope ? ' · ' + scopeNameOf(row.scope) : ''}${row.conversation ? ' · ' + row.conversation : ''}`,
        desc: row.reason && row.reason !== skipReasonOf(row) ? row.reason : '',
        tone: TONE.WARN,
      })),
      nextBefore: page.nextBefore,
      hasMore: page.hasMore,
      empty: '最近没有不回的消息',
    }
  }

  if (key === 'process.vision') {
    return {
      ...base,
      kind: 'vision',
      title: '看图自检',
      subtitle: '服务、模型图片能力、真实识别逐项检查',
      src: apiUrl('/vision/selftest'),
      empty: '还没有自检结果',
    }
  }

  if (key === 'process.activity') {
    const page = journalPage(runtime?.activities, { before, limit })
    // 汇总直接读自主活动自己的账本：主动开口、群里插话这些不写思维链的推理，
    // 以及宿主没给 usage 的调用，都在这里，不靠思维链条目反推。
    const spend = activityUsageView(runtime, at)
    const breakdown = spend.byKind
      .filter((one) => one.calls)
      .map((one) => `${one.label} ${one.calls} 次 / ${countText(one.tokens)} token`)
      .join('；')
    const summaryRow = {
      id: 'activity-usage',
      title: '今天的自主活动',
      meta: '单独算的账',
      desc: spend.line + (breakdown ? `（${breakdown}）` : ''),
      aside: `${countText(spend.tokens)} token`,
      tone: TONE.OK,
    }
    return {
      ...base,
      kind: 'rows',
      title: '自主活动',
      subtitle: '它自己的时间：做了什么、用了多少 token；消耗单独算，不依赖思维链',
      rows: [
        ...(before ? [] : [summaryRow]),
        ...page.rows.map((row) => ({
          id: String(row.id || `${row.at}`),
          title: clockText(row.at),
          meta: String(row.kind || '活动'),
          desc: String(row.text || ''),
          aside: activitySpendText(row),
          tone: TONE.IDLE,
        })),
      ],
      nextBefore: page.nextBefore,
      hasMore: page.hasMore,
      empty: '还没有自主活动',
    }
  }

  if (key === 'process.cot') {
    const page = journalPage(runtime?.cot, { before, limit })
    const live = typeof runtime?.liveCotRows === 'function' ? runtime.liveCotRows() : []
    // 旧的自主活动记录还躺在 cot.jsonl 里；界面只展示聊天回合的思考，
    // 自主活动统一去「自主活动」页看，不再混进思维链。
    const isAutonomous = (row) => ['activity', 'proactive', 'interject'].includes(String(row?.kind || ''))
      || String(row?.conversation || '') === 'activity'
    return {
      ...base,
      kind: 'rows',
      title: '思维链',
      subtitle: '想完再做：每次工具调用与回复发出前，先落一条',
      rows: [
        ...live.filter((row) => !isAutonomous(row)).map((row) => ({
          id: 'live:' + String(row.conversation || ''),
          title: '正在想…',
          meta: `${clockText(row.at)} · ${row.conversation ? String(row.conversation).replace(':', ' · ') : '实时'}`,
          desc: String(row.text || ''),
          aside: '实时',
          tone: TONE.OK,
        })),
        ...page.rows.map((row) => ({
          id: String(row.id || `${row.at}`),
          title: row.summary ? String(row.summary).slice(0, 42) : '一轮思考',
          meta: `${clockText(row.at)} · ${row.conversation ? String(row.conversation).replace(':', ' · ') : '未标会话'}`,
          desc: String(row.text || cotSteps(row)),
          aside: cotSpend(row),
          tone: TONE.IDLE,
        })),
      ],
      nextBefore: page.nextBefore,
      hasMore: page.hasMore,
      empty: '还没有思维链记录',
    }
  }

  // ── 提醒 ──
  if (key === 'reminders.all') {
    const items = runtime && runtime.reminders && typeof runtime.reminders.list === 'function' ? runtime.reminders.list() : []
    return {
      ...base,
      kind: 'rows',
      title: '提醒',
      subtitle: '还没到点的提醒；点删除可取消',
      rows: items.map((item) => ({
        id: item.id,
        title: new Date(item.at).toLocaleString('zh-CN', { hour12: false }),
        meta: '提醒主人',
        desc: item.text,
        actions: [{ action: 'edit-reminder', actionLabel: '编辑' }, { action: 'cancel-reminder', actionLabel: '取消' }],
        value: item.id,
        text: item.text,
        at: item.at,
      })),
      empty: '没有未到点的提醒',
    }
  }

  // ── QQ 连接 ──
  // 登录状态、方式、二维码、上次失败原因：四件事分开说。
  // 以前只有「通道在线/掉线」一句，用户不知道是没启动、没登录、还是扫了没确认。
  if (key === 'connection.status') {
    const state = typeof channel === 'string' ? channel : channel && typeof channel.state === 'function' ? channel.state() : 'unknown'
    const face = channelFace(state, {
      lastInboundAt: Number(channel?.lastInboundAt) || 0,
      now: at,
    })
    const enabled = get(config, 'channel.enabled') !== false
    const info = login
    const online = state === 'online'
    const mode = info?.mode || get(config, 'channel.login.mode') || 'ticket'
    const modeLabel = info?.modeLabel || { ticket: '票据', password: '密码', qr: '扫码' }[mode] || mode
    const qr = info?.qr || fallbackQr(config, at)
    const phase = info?.phase || (online ? 'online' : enabled ? 'unknown' : 'off')
    const lastInboundAt = Number(channel?.lastInboundAt) || 0
    const methodHint =
      mode === 'ticket'
        ? '优先用协议端已登录的票据；扫过一次之后不再扫'
        : mode === 'password'
          ? info?.warnings?.length
            ? info.warnings[0] + '；去「连接设置」补密码，或改用扫码'
            : '票据失效时用密码兜底；密码只留在本机，不回显'
          : '每一次都扫码；适合临时登录，或者票据怎么都过不去'
    const actions = []
    if (!online && enabled) {
      if (['starting', 'offline', 'unknown', 'not_ready'].includes(phase)) {
        actions.push({ action: 'login-start', actionLabel: '启动协议端' })
      }
      actions.push({ action: 'login-retry', actionLabel: '再试一次' })
      if (['waiting_qr', 'scanned', 'generating_qr'].includes(phase)) {
        actions.push({ action: 'login-refresh', actionLabel: '刷新二维码' })
      } else {
        actions.push({ action: 'login-qr', actionLabel: '改用扫码' })
      }
    }
    const rows = [
      {
        id: 'state',
        title: '登录状态',
        meta: enabled ? info?.phaseLabel || face.label : '已关闭',
        desc: enabled ? info?.hint || face.hint : '通道开关关着，去「连接设置」打开',
        tone: enabled ? info?.tone || face.tone : TONE.IDLE,
        actions,
      },
      {
        id: 'lastInbound',
        title: '最后收到消息',
        meta: lastInboundAt ? agoText(lastInboundAt, at) : '还没收到过',
        desc: lastInboundAt
          ? '心跳在线只说明连接还在；这个时间才是真正收到 QQ 消息的时间。长时间不动说明入站可能卡住。'
          : '通道在线但一条消息都还没收到；先确认聊天对象是这个机器人 QQ，再重启/重新登录 NapCat。',
        tone: online && (!lastInboundAt || at - lastInboundAt > 30 * 60_000) ? TONE.WARN : TONE.IDLE,
      },
      {
        id: 'method',
        title: '登录方式',
        meta: modeLabel,
        desc: methodHint,
        open: 'settings.channel',
      },
      {
        id: 'self',
        title: '机器人 QQ',
        meta: String(get(config, 'channel.selfId') || '未填'),
        desc: '设置 → QQ 连接里可改；票据和密码都要用到',
        open: 'settings.channel',
      },
      {
        id: 'font',
        title: '聊天字体',
        meta: '由机器人 QQ 客户端决定',
        desc: 'OneBot 只负责发纯文本，不改字体；要和你的号一致，请在机器人 QQ 的“设置 → 通用/聊天 → 字体”里选默认字体。',
      },
      {
        id: 'qzone',
        title: 'QQ 空间说说',
        meta: get(config, 'qzone.enabled') === true ? '已开' : '关着',
        desc: get(config, 'qzone.enabled') === true
          ? '直接写一条发出去；每天上限在设置里，发送前会检查通道'
          : '去「设置 → QQ 连接」打开“允许发空间说说”后才能发',
        tone: get(config, 'qzone.enabled') === true ? TONE.OK : TONE.IDLE,
        actions: get(config, 'qzone.enabled') === true && online
          ? [{ action: 'qzone-post', actionLabel: '写一条' }]
          : [],
      },
      {
        id: 'qr',
        title: '登录二维码',
        meta: info?.qrSuppressed ? '自动出码已关' : qr.exists ? '已生成（' + qr.ageText + '）' : '还没有',
        desc: info?.qrSuppressed
          ? '票据没成功；自动出码关着，点「改用扫码」才出码'
          : qr.exists
            ? qr.usable
              ? '点这一行看大图；用手机 QQ 扫一下'
              : '这张码可能过期了，点「刷新二维码」换一张'
            : '还没出码；点「改用扫码」或先启动协议端',
        tone: qr.exists && qr.usable ? TONE.OK : TONE.WARN,
        open: qr.exists ? 'connection.qr' : undefined,
      },
    ]
    if (info?.lastAttempt?.message) {
      rows.push({
        id: 'attempt',
        title: '上次登录尝试',
        meta: (info.lastAttempt.mode === 'qr' ? '扫码' : info.lastAttempt.mode === 'password' ? '密码' : '票据') + ' · ' + clockText(info.lastAttempt.at),
        desc: info.lastAttempt.message,
        tone: info.lastAttempt.ok ? TONE.OK : TONE.BAD,
      })
    }
    rows.push({ id: 'edit', title: '改连接设置', meta: '地址 / 令牌 / 登录方式 / 开关', desc: '点这一行进设置', open: 'settings.channel' })
    return {
      ...base,
      kind: 'rows',
      title: 'QQ 连接状态',
      subtitle: '登录方式与自动出码改完立即生效；下面每一步都能点',
      rows,
      note: '密码和令牌只留在本机 config.json；日志与面板都不会回显原值。',
      empty: '没有连接信息',
    }
  }

  if (key === 'connection.qr') {
    const info = login
    const qr = info?.qr || fallbackQr(config, at)
    const online = info?.online === true
    const srcBase = qr.src || assetUrl('napcat/qr')
    return {
      ...base,
      kind: 'image',
      title: '扫码登录',
      subtitle: online
        ? '已经在线了；这张码只作记录'
        : info?.qrSuppressed
          ? '自动出码关着；点「改用扫码」手动出码'
          : '用已登录这个 QQ 的设备扫码授权',
      src: srcBase + '?ts=' + (qr.at || at),
      note: qr.exists ? '二维码文件：' + qr.path + '（' + qr.ageText + '生成）' : info?.hint || '还没有二维码，先启动 NapCat',
      empty: '还没有二维码',
      login: info || null,
      qrAt: qr.at,
      qrExists: qr.exists,
    }
  }

  if (key === 'connection.groups') {
    return {
      ...base,
      kind: 'groups',
      title: '群列表',
      subtitle: '自动从 NapCat 拉取，不需要手填群号',
      src: apiUrl('/list/groups'),
      empty: '还没有群列表',
    }
  }

  // ── 记忆 ──
  if (key.startsWith('memory.')) {
    const memory = runtime && runtime.memory
    const facts = memory && typeof memory.facts === 'function' ? memory.facts() : []
    const people = memory && memory.data ? Object.values(memory.data.people || {}) : []
    const groups = memory && memory.data ? Object.values(memory.data.groups || {}) : []
    // 每行的标题就是内容，别写「事实」两个字当标题 ——
    // 一屏十几条「事实 / 自我」，眼睛没法扫，只能一条条读副标题，
    // 而副标题里全是「记得」「对自己的认识」这种没有信息量的字。
    const edit = (action, label) => ({ action, actionLabel: label })
    const factRows = facts.map((item) => ({
      id: 'fact-' + (item.id || item.at),
      title: String(item.text || '（空）'),
      meta: `事实 · 记得${item.at ? '于 ' + agoText(item.at) : ''}${Number(item.hits) > 1 ? ' · 提到过 ' + Number(item.hits) + ' 次' : ''}`,
      desc: '',
      actions: [edit('edit-fact', '改'), edit('forget-fact', '删')],
      value: String(item.text || ''),
      undo: { type: 'fact', text: String(item.text || '') },
    }))
    const peopleRows = people.map((item) => ({
      id: 'person-' + item.uin,
      title: item.name || item.uin,
      meta: `人物 · ${item.uin}${item.lastAt ? ' · 上次说话 ' + agoText(item.lastAt) : ''}`,
      desc: (item.impression ? '印象：' + item.impression + '；' : '') + ((item.notes || []).join('；') || '还没有备注'),
      actions: [edit('edit-person', '改'), edit('forget-person', '删')],
      value: item.uin,
      undo: { type: 'person', uin: item.uin, name: item.name || '', impression: item.impression || '', note: (item.notes || [])[0] || '' },
    }))
    const groupRows = groups.map((item) => ({
      id: 'group-' + item.groupId,
      title: item.label || ('群 ' + item.groupId),
      meta: `群记忆 · ${item.groupId}${item.lastAt ? ' · 上次聊到 ' + agoText(item.lastAt) : ''}`,
      desc: (item.topics || []).join('；') || '还没有话题',
      actions: [edit('edit-group', '改'), edit('forget-group', '删')],
      value: item.groupId,
      undo: { type: 'group', groupId: item.groupId, label: item.label || '', topics: item.topics || [] },
    }))
    const selfRows = (memory && typeof memory.selfNotes === 'function' ? memory.selfNotes() : []).map((item) => ({
      id: 'self-' + item.at,
      title: String(item.text || '（空）'),
      meta: `自我 · 记下于 ${agoText(item.at)}`,
      desc: '',
      actions: [edit('edit-self', '改'), edit('forget-self', '删')],
      value: String(item.text || ''),
      undo: { type: 'self', text: String(item.text || '') },
    }))
    const picked = key === 'memory.facts' ? factRows : key === 'memory.people' ? peopleRows : key === 'memory.groups' ? groupRows : key === 'memory.self' ? selfRows : [...factRows, ...peopleRows, ...groupRows, ...selfRows]
    const title = key === 'memory.facts' ? '事实' : key === 'memory.people' ? '人物' : key === 'memory.groups' ? '群记忆' : key === 'memory.self' ? '自我' : '全部记忆'
    const counts = `事实 ${factRows.length} · 人物 ${peopleRows.length} · 群 ${groupRows.length} · 自我 ${selfRows.length}`
    return {
      ...base,
      kind: 'rows',
      title,
      subtitle: `${counts}。删除要点两下，删完还能撤销`,
      rows: picked,
      empty: '这一类还没有记忆。跟它聊几句，或者在上面手动记一条',
    }
  }

  // ── 运行状态全表（只读，一张不多一张不少）──
  if (key === 'status.all') {
    const status = getStatus()
    return {
      ...base,
      kind: 'cards',
      title: '运行状态',
      subtitle: `全部 ${readonlyItems().length} 项只读状态；算不出来的写「—」，不填 0`,
      cards: statusCards({ status, config }),
      note: status['status.pendingConfig'] ? `有 ${status['status.pendingConfig']} 项现在改了也不会有变化` : '',
    }
  }

  // ── 设置 ──
  if (key.startsWith('settings.')) {
    const groupId = key.slice(9)
    const group = PANEL_GROUPS.find((item) => item.id === groupId)
    if (!group) return { ...base, kind: 'rows', title: '没有这一组', rows: [], empty: '这一组不存在' }
    return {
      ...base,
      kind: 'form',
      title: group.label,
      subtitle: `${group.desc}（属于「${domainLabel(group.domain)}」）`,
      form: { id: group.id, items: settingItemsOf({ config, groupId }) },
    }
  }

  return { ...base, ok: false, kind: 'rows', title: '没有这个页面', subtitle: key, rows: [], empty: '这一项可能已经被删掉了' }
}

// ── 详情用的小工具 ──────────────────────────────────────────────

/** 一组技能（详情页只画一组时用） */
function sectionsSkillsGroup(skillsView, groupId) {
  const all = skillsOf({ skillsView }).groups
  return all.filter((group) => group.id === groupId)
}

/** 日志分页；读不动就返回空页，不抛 */
function journalPage(journal, { before, limit, filter }) {
  if (!journal || typeof journal.read !== 'function') return { rows: [], nextBefore: null, hasMore: false }
  const options = { limit: Math.max(1, Math.min(100, Number(limit) || 40)), before }
  if (typeof filter === 'function') {
    options.filter = filter
    // 加了过滤就得扫更多行才能凑满一页。不设上限的话，一条冷门类型会把
    // 十几万行全扫一遍 —— 面板点开转三秒，用户以为卡死了。
    options.maxScan = 6000
  }
  const slice = safeCall(() => journal.read(options), { rows: [], nextBefore: null, hasMore: false })
  return { rows: slice.rows || [], nextBefore: slice.nextBefore || null, hasMore: slice.hasMore === true }
}

/**
 * 级别 id → 人话。
 *
 * 两套说法是有意分开的：
 *   · 下拉框里是「动作」——「只看错误」「错误与警告」，念起来是一句选择；
 *   · 句子中间要的是「名词」——「只看『错误』」，套上动作说法会变成
 *     「只看『只看错误』」，读起来像个 bug。
 */
const LEVEL_NOUN = Object.freeze({
  error: '错误',
  warn: '警告及以上',
  info: '常规信息',
  debug: '全部（含心跳与通道状态）',
})

function levelName(level) {
  return LEVEL_LABELS[String(level || '')] || String(level || '')
}

/**
 * 「为什么没回」的原因对照表。
 *
 * 行为账本里存的是 trigger（内部代号：night、per_minute、over_budget…）。
 * 直接摆英文代号给主人看，等于让人去猜 `follow_up_skip` 是什么意思 ——
 * 而「为什么刚才不理我」恰恰是最需要说人话的一件事。
 *
 * 表不全时退回原始代号，不猜、不编。
 */
const SKIP_REASONS = Object.freeze({
  night: '夜间静音时段',
  muted: '被静音了',
  per_minute: '这一分钟说得太多了',
  per_hour: '这一小时说得太多了',
  over_budget: '日预算用完了',
  refused: '登记过暂时不想理',
  follow_up_skip: '这次没接话（概率没中）',
  follow_up_limit: '连续对话轮数到上限',
  bad_scope: '会话范围认不出来',
  observe_only: '只是记录，不用回',
  command_not_owner: '不是主人发的指令',
  quiet: '安静时段',
  no_event: '没有可处理的事件',
  invalid_event: '这条消息不合法',
  runner_error: '生成时出错了',
  duplicate: '重复投递，只处理一次',
  empty: '没有可发的内容',
  quiet_period: '安静时段',
})

/** 会话范围 → 人话 */
function scopeNameOf(scope) {
  const key = String(scope || '')
  if (key === 'private') return '私聊'
  if (key === 'group') return '群里'
  return key
}

/** 一句人话：为什么这条没回 */
function skipReasonOf(row) {
  const trigger = String(row?.trigger || '')
  const reason = String(row?.reason || '').trim()
  const known = SKIP_REASONS[trigger] || ''
  if (reason) return reason
  if (known) return known
  return trigger || '没写原因'
}

/** 这个行为算不算「没回」 */
function isSkipRow(row) {
  if (row?.ok !== false) return false
  // 发了但没发出去（限流/通道问题）也算「主人那边看到的是没回」
  return true
}

function levelNoun(level) {
  return LEVEL_NOUN[String(level || '')] || levelName(level)
}

/**
 * 审计页那一行说明。
 *
 * 必须先把「磁盘上一条不少」说清，再讲现在筛掉了什么 ——
 * 否则用户看到「记录少了」第一反应是数据丢了，然后开始怀疑整个系统。
 */
function auditSubtitle(filter) {
  const parts = [`只看「${levelNoun(filter.level)}」`]
  parts.push(Array.isArray(filter.kinds) && filter.kinds.length ? `类型：${filter.kinds.join('、')}` : '全部类型')
  if (filter.noise === false) parts.push('含心跳与通道状态')
  return `${parts.join(' · ')}。磁盘上的审计一条没删，这里只是不显示`
}

/** 审计正文：只留人看得懂的那几个字段，不把整条 JSON 甩出来 */
function auditDesc(row) {
  const parts = []
  if (row.before !== undefined) parts.push(`从 ${brief(row.before)}`)
  if (row.after !== undefined) parts.push(`改成 ${brief(row.after)}`)
  else if (row.value !== undefined) parts.push(`值 ${brief(row.value)}`)
  if (row.error) parts.push(`原因：${String(row.error).slice(0, 120)}`)
  if (row.reason) parts.push(String(row.reason).slice(0, 120))
  if (row.actor) parts.push(`操作者：${row.actor}`)
  return parts.join(' · ') || '—'
}

function brief(value) {
  if (value === null || value === undefined) return '空'
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 80)
  const text = String(value)
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/** 审计类型 → 语气。失败与拒绝要一眼看出来 */
function auditTone(kind) {
  const k = String(kind || '')
  if (/fail|error|reject|conflict|fuse/.test(k)) return TONE.BAD
  if (/confirm|pending|skip|pause/.test(k)) return TONE.WARN
  return TONE.IDLE
}

/**
 * 思维链右侧那个小标签：这一步花了多少、花在哪一档。
 *
 * 只写 token 不写来源，人看到「700 in · 45 out」也不知道这笔该算给谁 ——
 * 而「自主活动到底花不花钱」正是最常被问的一句。
 * 老记录没有 source（那时还没分档），就只显示数字，不硬编一个来源。
 */
function cotSpend(row) {
  const tokens = row?.tokens
  if (!tokens) return ''
  // 0/0 是「这次没拿到用量」，不是「花了 0」。显示成 0 in · 0 out 会让人以为
  // 这一步真的不花钱 —— 而这正是最容易被误解、也最该留白的地方。
  if (!Number(tokens.input) && !Number(tokens.output)) return ''
  const spell = `${countText(tokens.input)} in · ${countText(tokens.output)} out`
  const source = USAGE_SOURCES[String(row.source || '')] || ''
  return source ? `${source} · ${spell}` : spell
}

/**
 * 自主活动每条正文旁边的消耗标签。
 * 宿主没给用量时写「没拿到 token 数」：写成 0 会让人以为这次不花钱，
 * 而实际上独立账本里已经记了一次调用（untracked）。
 */
function activitySpendText(row) {
  const tokens = row?.tokens
  // learn 这类活动只联网读页、根本没调模型，不该显示成空白让人以为漏账；
  // 其它有模型调用但宿主没给数字的，明确写「没拿到」。
  if (!tokens) return row?.kind === 'learn' ? '未调用模型' : ''
  if (tokens.tracked === false || (!Number(tokens.input) && !Number(tokens.output))) return '没拿到 token 数'
  return `${countText(tokens.input)} in · ${countText(tokens.output)} out`
}

/** 思维链可能是步骤数组，也可能是整段文本，两种都要能读 */
function cotSteps(row) {
  const steps = row?.steps
  if (Array.isArray(steps) && steps.length) {
    return steps
      .map((step) => (typeof step === 'string' ? step : step?.text || step?.summary || ''))
      .filter(Boolean)
      .join(' → ')
      .slice(0, 300)
  }
  return '—'
}

function safeCall(fn, fallback) {
  try {
    return fn()
  } catch {
    return fallback
  }
}

// ── 对外入口 ────────────────────────────────────────────────────

/**
 * 算一次完整页面骨架。
 *
 * @param {object} input
 * @param {object} input.runtime
 * @param {object} [input.chat]    独立对话（app/chat.mjs）
 * @param {object} [input.usage]
 * @param {object} [input.guard]
 * @param {object} [input.channel]
 * @param {number} [input.at]
 */
export function panelView({ runtime, chat, usage, guard, channel, typing, attention, clientProbe = null, at = Date.now() } = {}) {
  const notices = []
  /** 一个分区算坏了，只让这一栏说清原因；其余照常。整页白屏是最差的降级 */
  const safe = (section, fn, fallback) => {
    try {
      return fn()
    } catch (error) {
      notices.push({ section, message: String(error?.message || error) })
      return fallback
    }
  }

  const status = safe('status', () => runtime?.status?.() || {}, {})
  const skillsView = safe('skills', () => runtime?.skills?.() || { groups: [], counts: {} }, { groups: [], counts: {} })
  const summary = safe('evolve', () => runtime?.evolver?.summary?.(at) || { weights: {} }, { weights: {} })
  const config = safe('config', () => runtime?.config || {}, {})
  // 登录层可能比通道层知道得更多（等扫码 / 已扫码 / 票据失效）。
  // 它自己维护同步快照，这里只读一眼，不触发网络请求。
  const login = safe('login', () => loginSnapshot(runtime), null)

  // 状态牌只算一次。以前 overview 与 usage 各算一遍、每遍又各自重算 token 与花费，
  // 同一页上同一个数字有三个来源，改一处就会有两处对不上。
  const tiles = safe('overview', () => statusTiles({
    status,
    config,
    login,
    lastInboundAt: Number(channel?.lastInboundAt) || 0,
    now: at,
  }), [])
  // 限流器是进程内的实时值，不是持久状态，所以不进 status 快照 ——
  // 但仍然要能看见「这一小时说了几条」，否则调了限流没有反馈。
  const guardStats = safe('guard', () => (typeof guard?.stats === 'function' ? guard.stats(at) : null), null)
  if (guardStats) {
    tiles.push({
      label: '说话频率',
      value: withUnit(countText(guardStats.lastMinute), '条/分钟'),
      tone: guardStats.quiet ? TONE.IDLE : TONE.OK,
      hint: guardStats.quiet ? `现在是安静时段，这一小时说了 ${countText(guardStats.lastHour)} 条` : `这一小时说了 ${countText(guardStats.lastHour)} 条`,
    })
  }

  // 两个新模块（打字台 / 注意力）以前在面板上完全不存在：装了、跑了、没人看见。
  // 「能看见」不是装饰 —— 没有读数就没法回答「它为什么回得慢」「它现在觉得在跟谁说话」。
  const typingStats = safe('typing', () => (typeof typing?.stats === 'function' ? typing.stats() : null), null)
  const attentionStats = safe('attention', () => (typeof attention?.stats === 'function' ? attention.stats() : null), null)

  if (typingStats) {
    tiles.push({
      label: '打字台',
      value: typingStats.busy ? `排队 ${countText(typingStats.waiting)} 条` : '空闲',
      tone: typingStats.overloads > 0 ? TONE.WARN : TONE.IDLE,
      hint: typingStats.typed
        ? `已发出 ${countText(typingStats.typed)} 条；上次打字等了 ${spanText(typingStats.lastWaitMs)}`
        : '还没发过话',
    })
  }
  if (attentionStats) {
    tiles.push({
      label: '注意力',
      value: attentionStats.people ? `${countText(attentionStats.people)} 个热窗口` : '没有热窗口',
      tone: attentionStats.people ? TONE.OK : TONE.IDLE,
      hint: attentionStats.people
        ? `${countText(attentionStats.conversations)} 个会话里有人刚跟它说完话，${spanText(attentionStats.windowMs)} 内不用 @`
        : '群里没人刚跟它说完话，接话要 @ 或叫名字',
    })
  }

  let usageLine = ''
  if (usage) usageLine = safe('usage', () => usage.line(at), '') || ''

  // 通道状态以 runtime 报的为准（它会把「开关关了」也折成 off）；
  // 测试或旧调用方只给了 channel 时再退回问通道层。
  const channelState = status['status.channel'] !== undefined
    ? String(status['status.channel'])
    : safe('channel', () => channel?.state?.() || 'unknown', 'unknown')
  const face = channelFace(channelState, {
    lastInboundAt: Number(channel?.lastInboundAt) || 0,
    now: at,
  })

  const qq = safe(
    'qq',
    () => {
      const one = overviewOf({ events: runtime?.events })
      return { ...one, online: face.tone === TONE.OK }
    },
    { total: 0, active: 0, line: '', online: false },
  )

  const panel = safe('settings', () => panelSummary(), { line: '', editable: 0, readonly: 0 })
  const sections = {
    overview: safe('overview', () => ({
      tiles,
      line: `${face.label}｜今天 ${countText(status['status.todayMessages'])} 条消息，${countText(status['status.todayTokens'])} token`,
      note: status['status.pendingConfig']
        ? `还有 ${status['status.pendingConfig']} 项现在改了也不会有变化`
        : '',
    }), { tiles: [] }),
    skills: safe('skills', () => skillsOf({ skillsView }), { groups: [], counts: {} }),
    evolve: safe('evolve', () => ({ ...weightRowsOf({ summary, skillsView }), version: Number(summary.version) || 0, changes: Number(summary.changes) || 0, kept: Number(summary.versions) || 0, paused: summary.paused === true }), {}),
    usage: safe('usage', () => ({ line: usageLine, tiles: tiles.filter((tile) => ['今日 token', '今日花费', '预算还剩'].includes(tile.label)) }), { tiles: [] }),
    channel: safe('channel', () => ({ face, state: channelState }), { face }),
    login: login || null,
    // 节奏与注意力的现场。没有装配（用例、或宿主没给）时是 null，
    // 视图层据此少画一张卡，而不是画一张全是「—」的卡。
    rhythm: { typing: typingStats, attention: attentionStats },
    settings: safe('settings', () => ({ line: panel.line, editable: panel.editable, readonly: panel.readonly }), {}),
  }

  const regions = {}
  for (const region of REGIONS) {
    regions[region.id] = {
      id: region.id,
      label: region.label,
      hint: region.hint,
      icon: region.icon,
      // 这一页属于哪个域。界面上不一定要显示，但「它归哪一类」必须有答案 ——
      // 没有答案的页面就是下一个「没人知道该放哪」的东西。
      domain: region.domain,
      domainLabel: region.domain ? domainLabel(region.domain) : '',
      modules: safe(`modules.${region.id}`, () => modulesOf({ regionId: region.id, sections, status, summary, skillsView, chat, qq, config, runtime }), []),
    }
  }

  // 角标只报「有事要处理」的数字，不报总量
  const nav = REGIONS.map((region) => ({
    ...region,
    badge:
      region.id === 'ability'
        ? Number(sections.skills?.counts?.blocked) || 0
        : region.id === 'settings'
          ? Number(status['status.pendingConfig']) || 0
          : 0,
  }))

  return {
    ok: true,
    at,
    layout: { ...SIDEBAR },
    // 旧页面 id → 新页面 id。前端不抄这张表，随面板一起下发 ——
    // 抄一份的后果是"下次合并页面，前端那份没人改"，深链静默失效。
    aliases: { ...ALIASES },
    nav,
    // 侧栏按四段收敛；nav 仍是 REGIONS 原顺序，前端只按这个分组加标题。
    navSections: NAV_SECTIONS.map((one) => ({ ...one, regions: [...one.regions] })),
    // 一句人话的进度状态（「正在核对数据」）。空字符串表示现在没在忙。
    progress: safeCall(() => runtime?.progressText?.(at) || '', ''),
    regions,
    sections,
    notices,
    head: {
      title: '深蓝鲸',
      subtitle: '长在这台机器上的人格体',
      version: String(status['status.version'] || ''),
      // 「现在跑的是哪一份」：副本落后或残缺都要能看见。
      // 这一栏以前只有版本号，而版本号在复制时不变 —— 它证明不了任何事。
      // client：页面里跑的前端自报的现场（版本 / 实测宽度 / 视口 / 被外层裁掉多少）。
      //
      // 为什么要有 viewport 和 overflow 这两个数：插件根节点的宽度是宿主给的，
      // 窗口可见区却可能比它窄 —— 结果是内容右边缘被裁，而插件内部「有没有溢出」
      // 永远是 0（overflow:hidden 自己吃掉）。光看截图分不清是「样式写宽了」
      // 还是「宿主给的位置不够」，猜错就会去改一个九成无关的样式。
      //
      // 全空 = 这一版前端还没有上报能力（旧代码），本身就是个有用的事实。
      build: safe('build', () => ({
        ...buildInfo(),
        client: {
          rev: String(clientProbe?.rev || ''),
          width: Number(clientProbe?.width) || 0,
          viewport: Number(clientProbe?.viewport) || 0,
          left: Number(clientProbe?.left) || 0,
          overflow: Number(clientProbe?.overflow) || 0,
          geo: String(clientProbe?.geo || ''),
        },
      }), null),
    },
  }
}
