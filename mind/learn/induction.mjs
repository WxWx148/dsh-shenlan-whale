/**
 * mind/induction.mjs — 从「事件流 + 行为流」里归纳出几句可验证的结论。
 *
 * 只在提示词里放**一句**结论。为什么不是一段：
 *   模型对「你最近响应率 83%」这种数字没有概念，但对「他叫你 12 次你回了 10 次，
 *   剩下 2 次他没再说话」会有反应；而一整页统计塞进提示词，只会挤掉真正重要的上下文。
 *
 * 每个比率都能从两份 jsonl 现场算出来，不存中间状态 —— 旧版把统计写进
 * evolution.json 又不同步更新，导致面板上的数字和实际行为对不上。
 */

import { KIND, SCOPE, kindOf, needsReply } from '../../facts/index.mjs'
import { BEHAVIOR } from '../../decide/index.mjs'

const MESSAGE_KINDS = new Set([KIND.MESSAGE, KIND.IMAGE])

function ratio(part, total) {
  if (!total || total <= 0) return null
  return Number((part / total).toFixed(3))
}

/** 均值，没有样本时给 null（不是 0 —— 0 会被误读成「瞬间回复」） */
function mean(values) {
  const list = values.filter((value) => Number.isFinite(value) && value > 0)
  if (!list.length) return null
  const sum = list.reduce((acc, value) => acc + value, 0)
  return Math.round(sum / list.length)
}

/**
 * @param {object} input
 * @param {object[]} [input.events]     最新在前（journal.read 的顺序）
 * @param {object[]} [input.behaviors]  最新在前
 * @param {number} [input.window]       只看最近多少条
 * @returns {{
 *   sample: number, replyRate: number|null, silenceRate: number|null,
 *   avgMs: number|null, top: string, counts: object, line: string
 * }}
 */
export function induce(input = {}) {
  const window = Math.max(1, Number(input.window) || 200)
  const events = (Array.isArray(input.events) ? input.events : []).slice(0, window)
  const behaviors = (Array.isArray(input.behaviors) ? input.behaviors : []).slice(0, window)

  const messages = events.filter((event) => MESSAGE_KINDS.has(kindOf(event)))
  // 内存事件用 kind，落盘记录用 type —— kindOf 统一过，否则从磁盘读回来一条都认不出
  const demanded = messages.filter((event) => needsReply(event))
  const groupMessages = messages.filter((event) => event?.scope === SCOPE.GROUP)
  // 「没被点到」和「被点到但没回」是两件事，混着说会得出完全相反的结论。
  //   没被点到（unaddressed）：按设计就不该回，不算失职；
  //   被点到没回（missed）    ：才是真的漏了。
  const unaddressed = groupMessages.filter((event) => needsReply(event) === false)
  const addressedGroup = groupMessages.length - unaddressed.length

  // 事件按 id 建索引：行为记录里只有 eventId，要靠它反查这条属于群还是私聊。
  // 少了这一步，「群里的响应率」就只能拿总数硬凑 —— 之前那句文案就是这么错的。
  const eventById = new Map()
  for (const event of messages) {
    const key = String(event?.id || '')
    if (key) eventById.set(key, event)
  }
  const scopeOfReply = (row) => {
    const event = eventById.get(String(row?.eventId || ''))
    return event?.scope || row?.scope || ''
  }

  const replies = behaviors.filter((row) => row?.behavior === BEHAVIOR.REPLY)
  const okReplies = replies.filter((row) => row?.ok !== false)
  const avgMs = mean(okReplies.map((row) => Number(row?.ms) || 0))
  const groupReplied = okReplies.filter((row) => scopeOfReply(row) === SCOPE.GROUP).length
  // 每条回复能不能认出「属于哪个会话」。
  // 有一条认不出，就说明这批数据不足以判断「点了没接」——
  // 宁可不说，也不能把「不知道」说成「漏了」。旧版就是这么把背景说成失职的。
  const scopeKnown = okReplies.length > 0 && okReplies.every((row) => scopeOfReply(row) !== '')

  const counts = {}
  for (const row of behaviors) {
    const key = String(row?.behavior || '')
    if (!key) continue
    counts[key] = (counts[key] || 0) + 1
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || ''

  const replyRate = ratio(okReplies.length, demanded.length)
  const silenceRate = ratio(unaddressed.length, groupMessages.length)

  return {
    sample: messages.length,
    replyRate,
    silenceRate,
    avgMs,
    top,
    counts,
    // 四个原始计数一起给：下游要按会话算比率，不能拿"总数"去减"另一个总数"
    demanded: demanded.length,
    replied: okReplies.length,
    groupMessages: groupMessages.length,
    unaddressed: unaddressed.length,
    addressedGroup,
    groupReplied,
    line: line({
      demanded: demanded.length,
      replied: okReplies.length,
      avgMs,
      unaddressed: unaddressed.length,
      addressedGroup,
      groupReplied,
      scopeKnown,
    }),
  }
}

/** 进提示词的那一句。宁可少说一个数字，也不要把话写成报表 */
export function line(stats) {
  const {
    demanded = 0, replied = 0, avgMs = null,
    unaddressed = 0, addressedGroup = 0, groupReplied = 0, scopeKnown = true,
  } = stats || {}
  if (demanded + unaddressed === 0) return '还没有足够记录，先处一天再看'
  const first = demanded ? `最近叫他/她 ${demanded} 次，回了 ${replied} 次` : '最近没人叫他/她'
  const speed = avgMs ? `，平均 ${(avgMs / 1000).toFixed(1).replace(/\.0$/, '')} 秒` : ''
  // 这里说的是「群里没点到他/她的还有几条」，不是「群里一共几条」。
  // 前者是背景（正常现象），后者会被模型读成「群里一直在自言自语」。
  const second = unaddressed ? `；群里另有 ${unaddressed} 条没点到他/她` : ''
  // 被点到却没回才算漏。但只有在每条回复都认得出属于哪个会话时才敢这么说；
  // 认不出就不下结论 —— 沉默比冤枉好。
  const missed = scopeKnown ? Math.max(0, addressedGroup - groupReplied) : 0
  const third = missed > 0 ? `，其中 ${missed} 条点了没接` : ''
  return `${first}${speed}${second}${third}`
}

/** 响应率是否在下降 —— 进化模块用它决定要不要自动回滚 */
export function isDeclining(previous, current) {
  if (!previous || !current) return false
  if (previous.replyRate === null || current.replyRate === null) return false
  return current.replyRate < previous.replyRate - 0.05
}

/**
 * 把归纳结果翻成一组「基线奖励」，喂给进化。
 *
 * 为什么需要这一层：没有它，归纳算出来的响应率只是写进 induction.json 给人看，
 * 进化用的还是调用方临时拍脑袋给的 rewards —— 两条平行线，谁也不影响谁。
 *
 * 三条克制规则（都写进测试）：
 *   1. 样本不足 5 条不给奖励。两三条消息得出的比率是噪声，据此调权重比不调更糟。
 *   2. 只往「坏」的方向给较强信号。回得少（< 40%）扣 0.25；回得好只加 0.05。
 *      因为「回得好」还有别的因素（内容质量、时机），不该全记在权重账上；
 *      而「该回的没回」是很确定的失败，值得重罚。
 *   3. 不碰 proactive / activity。响应率只说明「该回的回没回」，
 *      推不出「该不该主动开口」—— 那是另一份证据的事。
 *
 * @param {object} stats induce() 的返回值
 * @returns {{ rewards: object, notes: string[] }} notes 写进审计，解释这次为什么这么给
 */
export function deriveRewards(stats) {
  const notes = []
  const rewards = { behavior: {} }
  const sample = Number(stats?.sample) || 0
  const rate = stats?.replyRate
  if (sample < 5) {
    return { rewards: {}, notes: ['样本不足 5 条，不给奖励'] }
  }
  if (rate === null || rate === undefined) {
    return { rewards: {}, notes: ['没有「该回」的样本，不给奖励'] }
  }
  if (rate < 0.4) {
    rewards.behavior[BEHAVIOR.REPLY] = -0.25
    notes.push(`该回的只回了 ${Math.round(rate * 100)}%，扣 0.25`)
  } else if (rate < 0.6) {
    rewards.behavior[BEHAVIOR.REPLY] = -0.1
    notes.push(`该回的回了 ${Math.round(rate * 100)}%，扣 0.1`)
  } else if (rate > 0.95) {
    rewards.behavior[BEHAVIOR.REPLY] = 0.05
    notes.push(`该回的基本都回了（${Math.round(rate * 100)}%），加 0.05`)
  } else {
    notes.push(`响应率 ${Math.round(rate * 100)}% 在正常区间，不动`)
  }
  return { rewards, notes }
}
