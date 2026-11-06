/**
 * lib/backfill.mjs — 掉线补回：把断线期间漏掉的消息捞回来，只记事实，不回话。
 *
 * 为什么需要它：WebSocket 断开的那段时间，NapCat 不会把消息排队送来；
 * 连上之后如果不管，聊天记录里就永久缺一段 —— 而这正好是「他/她刚才说了什么」
 * 最需要的那段。NapCat 还留着最近的历史（get_group_msg_history /
 * get_friend_msg_history），趁它还在，补进事件流。
 *
 * 三条纪律：
 *   1. 只写事件，不触发回复 —— 补回来的是「发生过」，不是「现在要接」；
 *   2. 按 messageId 去重 —— 重连、重复投递都不能把同一句记两遍；
 *   3. 补不到也要留痕 —— 审计里写清空档多久、补了几条，别让缺口静默消失。
 */

import { KIND, SCOPE } from '../event.mjs'

/** 空档小于这个值就不折腾（网络抖一下不算掉线） */
const MIN_GAP_MS = 15_000
/** 前后各留一点余量：NapCat 的时间只到秒，本地时间可能差几毫秒 */
const SKEW_MS = 5_000
/** 一次最多补几个会话：重连不该打一串接口把协议端拖慢 */
const MAX_CONVERSATIONS = 12

/**
 * @param {object} input
 * @param {object} input.runtime
 * @param {object} input.channel          需要 getHistory(conversation, {count})
 * @param {number} input.since            掉线开始时间（ms）
 * @param {number} [input.until]          连上的时间（ms），默认 now
 * @param {number} [input.now]
 * @param {(line:string)=>void} [input.log]
 * @returns {Promise<{ok:boolean, restored?:number, skipped?:number, failed?:number, reason?:string}>}
 */
export async function backfillMissed(input = {}) {
  const { runtime, channel, log = () => {} } = input
  const now = Number(input.now) || Date.now()
  const until = Number(input.until) || now
  const since = Number(input.since) || 0
  if (!runtime || !runtime.events || !channel || typeof channel.getHistory !== 'function') {
    try { runtime?.log?.('channel_backfill', { ok: false, reason: '通道没有历史消息接口' }) } catch {}
    return { ok: false, reason: '通道没有历史消息接口' }
  }
  if (!since || until - since < MIN_GAP_MS) {
    return { ok: true, reason: '空档太短', restored: 0, skipped: 0, failed: 0 }
  }

  const conversations = pickConversations(runtime, since, until, Number(input.maxConversations) || MAX_CONVERSATIONS)
  const seen = recentMessageIds(runtime)
  const perConversation = Math.max(1, Math.min(50, Number(input.perConversation) || 50))
  let restored = 0
  let skipped = 0
  let failed = 0

  for (const conversation of conversations) {
    let items = []
    try {
      items = await channel.getHistory(conversation, { count: perConversation })
    } catch {
      failed += 1
      continue
    }
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !item.at) continue
      // 只认这段空档里的：更早的是旧账，更晚的会由正常消息链路处理
      if (item.at < since - SKEW_MS || item.at > until + SKEW_MS) continue
      const messageId = String(item.messageId || '')
      if (messageId && seen.has(messageId)) {
        skipped += 1
        continue
      }
      let event = null
      try {
        event = runtime.decide(toRaw(item), { config: runtime.config })?.event || null
      } catch {
        failed += 1
        continue
      }
      if (!event) continue
      runtime.logEvent(event, { backfilled: true })
      if (messageId) {
        seen.add(messageId)
        // 让「重复投递」的闸门也知道这条已经记过：重连后协议端可能再推一遍
        try { runtime.claimMessage?.(messageId) } catch {}
      }
      restored += 1
    }
  }

  const detail = {
    since,
    until,
    ms: Math.max(0, until - since),
    conversations: conversations.length,
    restored,
    skipped,
    failed,
  }
  try {
    runtime.log?.('channel_backfill', detail)
  } catch {
    // 审计写不进去不该影响补回本身
  }
  log(`[whale] 掉线补回：空档 ${Math.round(detail.ms / 1000)} 秒，补 ${restored} 条，跳过 ${skipped} 条`)
  return { ok: true, ...detail }
}

/** 补回历史消息 → 内部 raw（与通道 toRaw 同形，但不含 atMe：补回来的不该触发回复） */
function toRaw(item) {
  return {
    source: 'channel',
    kind: item.images && item.images.length && !item.text ? KIND.IMAGE : KIND.MESSAGE,
    scope: item.scope === SCOPE.GROUP ? SCOPE.GROUP : SCOPE.PRIVATE,
    from: String(item.from || ''),
    text: String(item.text || ''),
    at: Number(item.at) || 0,
    messageId: String(item.messageId || ''),
    payload: {
      groupId: String(item.groupId || ''),
      senderName: String(item.sender || ''),
      images: Array.isArray(item.images) ? item.images : [],
      replyId: String(item.replyId || ''),
      replySummary: String(item.replySummary || ''),
      forwardId: String(item.forwardId || ''),
      messageId: String(item.messageId || ''),
      backfilled: true,
    },
  }
}

/**
 * 挑要补的会话：最近真的有消息的群/私聊，按最后一句时间倒序。
 * 不拿 groupList 全量扫 —— 几十个群挨个拉历史，重连会被拖成几分钟。
 */
function pickConversations(runtime, since, until, limit) {
  let rows = []
  try {
    // 必须按「消息」筛：直接读 400 行只覆盖最近十几分钟的心跳，
    // 空档长一点，真正聊过的群就全被挤出去了。
    rows = runtime.events.read({
      limit: 300,
      maxScan: 20000,
      filter: (row) => row?.type === KIND.MESSAGE || row?.type === KIND.IMAGE,
    }).rows || []
  } catch {
    return []
  }
  const cutoff = Math.min(since, until) - 6 * 3600_000
  const map = new Map()
  for (const row of rows) {
    const conversation = String(row.conversation || '')
    if (!conversation.startsWith('group:') && !conversation.startsWith('private:')) continue
    const at = Number(row.at) || 0
    if (at < cutoff) continue
    if (!map.has(conversation) || at > map.get(conversation)) map.set(conversation, at)
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, limit))
    .map(([conversation]) => conversation)
}

/** 已经记过的 messageId：最近一段就够，补回只会碰最近的历史 */
function recentMessageIds(runtime) {
  const set = new Set()
  try {
    for (const row of runtime.events.read({
      limit: 1500,
      maxScan: 20000,
      filter: (row) => Boolean(row?.messageId),
    }).rows || []) {
      set.add(String(row.messageId))
    }
  } catch {}
  return set
}
