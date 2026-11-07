/**
 * facts/event.mjs — 把「通道收到的一坨原始数据」变成一条**只读事实**。
 * 这一层只做打标，不做判断：不决定回不回、不决定说啥、不写记忆。
 * 为什么非要分开：旧版把「收到消息」和「要不要回」写在同一段 if 里，
 * 于是「群里没 @ 我的消息」在统计里根本不存在 —— 想算「我被点了多少次、
 * 群里多少话我没接」时，数据早就丢了。
 *
 * 事件形状（冻结，谁都改不了）：
 *   { id, at, source, kind, scope, from, conversation, tags[], payload }
 *
 * 打标一律基于事实，不猜：
 *   at_me   只有真的 @ 了这个号才算；@全体成员 不算（旧版就在这里误判过）
 *   night   按「夜间不打扰」窗口算，跨零点也认
 *   burst   同一个会话里连着发，间隔在合并窗口内
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const SOURCE = Object.freeze({
  CHANNEL: 'channel',
  TIMER: 'timer',
  PANEL: 'panel',
  TOOL: 'tool',
  INTERNAL: 'internal',
})

export const KIND = Object.freeze({
  MESSAGE: 'message',
  COMMAND: 'command',
  IMAGE: 'image',
  NOTICE: 'notice',
  HEARTBEAT: 'heartbeat',
  TASK: 'task',
})

export const SCOPE = Object.freeze({
  PRIVATE: 'private',
  GROUP: 'group',
  PANEL: 'panel',
})

export const TAG = Object.freeze({
  AT_ME: 'at_me',
  AT_ALL: 'at_all',
  HAS_IMAGE: 'has_image',
  IS_OWNER: 'is_owner',
  NIGHT: 'night',
  BURST: 'burst',
  FIRST_TODAY: 'first_today',
  MENTIONED_NAME: 'mentioned_name',
  CALLED: 'called',
  FOLLOW_UP: 'follow_up',
})

const SOURCE_SET = new Set(Object.values(SOURCE))
const KIND_SET = new Set(Object.values(KIND))
const SCOPE_SET = new Set(Object.values(SCOPE))

/**
 * 解析 `23:00-07:00`。返回分钟数，跨零点时 start > end。
 * 解析不出来返回 null（宁可不判夜间，也别因为一个脏配置把消息全吞了）。
 */
export function parseWindow(text) {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text || ''))
  if (!match) return null
  const startHour = Number(match[1])
  const startMin = Number(match[2])
  const endHour = Number(match[3])
  const endMin = Number(match[4])
  if (startHour > 23 || endHour > 23 || startMin > 59 || endMin > 59) return null
  const start = startHour * 60 + startMin
  const end = endHour * 60 + endMin
  if (start === end) return null
  return { start, end, wraps: start > end }
}

/** 某个时间点是否落在窗口里（本地时区） */
export function inWindow(at, window) {
  const parsed = typeof window === 'string' ? parseWindow(window) : window
  if (!parsed) return false
  const date = new Date(Number(at) || 0)
  const minute = date.getHours() * 60 + date.getMinutes()
  if (parsed.wraps) return minute >= parsed.start || minute < parsed.end
  return minute >= parsed.start && minute < parsed.end
}

/** 本地日期键，用于「今天第一次说话」 */
function dayKey(at) {
  const date = new Date(Number(at) || 0)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** 会话键：群按群号，私聊按对方。会话是打标与限流的最小单位 */
export function conversationOf(raw) {
  if (raw && typeof raw.conversation === 'string' && raw.conversation) return raw.conversation
  const scope = String(raw?.scope || '')
  if (scope === SCOPE.GROUP) return `group:${raw?.groupId ?? raw?.payload?.groupId ?? raw?.from ?? ''}`
  if (scope === SCOPE.PANEL) return 'panel'
  return `private:${raw?.from ?? ''}`
}

/** 修复旧事件：群会话键曾被写成发送者 QQ 号，能拿到 group 的就改回群号 */
export function repairGroupConversations(dir) {
  const file = path.join(String(dir || '.'), 'events.jsonl')
  if (!existsSync(file)) return { changed: 0, backup: '' }
  let changed = 0
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  const next = lines.map((line) => {
    try {
      const row = JSON.parse(line)
      const group = String(row?.group || row?.payload?.groupId || '')
      if (row?.scope === 'group' && group && row.conversation !== `group:${group}`) {
        row.conversation = `group:${group}`
        changed += 1
        return JSON.stringify(row)
      }
    } catch {}
    return line
  })
  if (!changed) return { changed: 0, backup: '' }
  const backup = `${file}.bad-group-${Date.now()}`
  copyFileSync(file, backup)
  writeFileSync(file, next.join('\n') + '\n', 'utf8')
  return { changed, backup }
}

/**
 * 打标器。**有状态**（要记「这个会话上一条是什么时候」），所以做成实例，
 * 而不是一个纯函数 —— 纯函数没法判断 burst / first_today。
 */
export class EventTagger {
  /**
   * @param {object} [options]
   * @param {string} [options.ownerId]
   * @param {string[]} [options.selfNames]     他/她自己的名字，用来判 mentioned_name
   * @param {string} [options.nightWindow]
   * @param {number} [options.mergeWindowMs]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.ownerId = String(options.ownerId ?? '')
    this.selfNames = (Array.isArray(options.selfNames) ? options.selfNames : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean)
    this.callWords = (Array.isArray(options.callWords) ? options.callWords : ['在吗', '在不在', '出来', '理我', '呼叫', '醒醒', '别装死'])
      .map((word) => String(word || '').trim())
      .filter(Boolean)
    this.nightWindow = parseWindow(options.nightWindow || '23:00-07:00')
    this.mergeWindowMs = Math.max(0, Number(options.mergeWindowMs) || 0)
    this.now = options.now || (() => Date.now())
    this.isActive = typeof options.isActive === 'function' ? options.isActive : () => false
    this.lastByConversation = new Map()
    this.dayByConversation = new Map()
    this.seq = 0
  }

  /** 配置热更新时用：只换参数，不丢已积累的状态 */
  configure(options = {}) {
    if (options.ownerId !== undefined) this.ownerId = String(options.ownerId ?? '')
    if (Array.isArray(options.selfNames)) {
      this.selfNames = options.selfNames.map((name) => String(name || '').trim()).filter(Boolean)
    }
    if (options.nightWindow !== undefined) this.nightWindow = parseWindow(options.nightWindow)
    if (options.mergeWindowMs !== undefined) this.mergeWindowMs = Math.max(0, Number(options.mergeWindowMs) || 0)
    return this
  }

  /**
   * @param {object} raw
   * @param {string} raw.source  channel / timer / panel / tool / internal
   * @param {string} raw.kind    message / command / image / notice / heartbeat / task
   * @param {string} raw.scope   private / group / panel
   * @param {string|number} [raw.from]
   * @param {string} [raw.text]
   * @param {boolean} [raw.atMe]   真的 @ 了这个号
   * @param {boolean} [raw.atAll]  @ 了全体（不算 at_me）
   * @returns {Readonly<object>}
   */
  tag(raw) {
    if (!raw || typeof raw !== 'object') throw new TypeError('事件必须是对象')
    const source = String(raw.source || '')
    const kind = String(raw.kind || '')
    const scope = String(raw.scope || '')
    if (!SOURCE_SET.has(source)) throw new TypeError(`未知来源：${source || '(空)'}，只能是 ${[...SOURCE_SET].join(' / ')}`)
    if (!KIND_SET.has(kind)) throw new TypeError(`未知类型：${kind || '(空)'}，只能是 ${[...KIND_SET].join(' / ')}`)
    if (!SCOPE_SET.has(scope)) throw new TypeError(`未知范围：${scope || '(空)'}，只能是 ${[...SCOPE_SET].join(' / ')}`)

    const at = Number.isFinite(Number(raw.at)) && Number(raw.at) > 0 ? Number(raw.at) : this.now()
    const conversation = conversationOf({ ...raw, scope })
    const from = raw.from === undefined || raw.from === null ? '' : String(raw.from)
    const text = String(raw.text || '')
    const tags = []

    if (raw.atMe === true) tags.push(TAG.AT_ME)
    if (raw.atAll === true) tags.push(TAG.AT_ALL)
    if (kind === KIND.IMAGE || raw.hasImage === true) tags.push(TAG.HAS_IMAGE)
    if (this.ownerId && from && from === this.ownerId) tags.push(TAG.IS_OWNER)
    if (this.nightWindow && inWindow(at, this.nightWindow)) tags.push(TAG.NIGHT)

    // 名字被叫到：文本里出现自己的名字。已经是 at_me 时也保留这个标（两种事实都成立）
    if (text && this.selfNames.some((name) => text.includes(name))) tags.push(TAG.MENTIONED_NAME)
    if (text && this.callWords.some((word) => text.includes(word)) && (from === this.ownerId || this.isActive(conversation))) tags.push(TAG.CALLED)
    if (scope === SCOPE.GROUP && from && from !== 'self' && this.isActive(conversation)) tags.push(TAG.FOLLOW_UP)

    const last = this.lastByConversation.get(conversation)
    if (last && at >= last.at && at - last.at <= this.mergeWindowMs) tags.push(TAG.BURST)
    this.lastByConversation.set(conversation, { at, id: null })

    const day = dayKey(at)
    if (this.dayByConversation.get(conversation) !== day) {
      this.dayByConversation.set(conversation, day)
      tags.push(TAG.FIRST_TODAY)
    }

    this.seq += 1
    const event = {
      id: `evt_${at}_${this.seq.toString(36)}`,
      at,
      source,
      kind,
      scope,
      from,
      conversation,
      tags: Object.freeze(tags),
      payload: Object.freeze({
        ...(raw.payload && typeof raw.payload === 'object' ? raw.payload : {}),
        ...(text ? { text } : {}),
        ...(raw.messageId ? { messageId: String(raw.messageId) } : {}),
      }),
    }
    return Object.freeze(event)
  }
}

/** 事件上有没有某个标 */
export function has(event, tag) {
  return Array.isArray(event?.tags) && event.tags.includes(tag)
}

/**
 * 事件类型。内存里的事件是 `kind`；落盘后为了区分「事件流 / 行为流」，
 * jsonl 里的 `kind` 被写成 `'event'`，原类型存进 `type` —— 所以两边都要认。
 * 这个差异只有串起来跑才会暴露，故在这里统一，别让每个调用方自己猜。
 */
export function kindOf(event) {
  return String(event?.type || event?.kind || '')
}

/** 「需要回」的判定：私聊、被 @、被叫名字。群里没被点到的，按设计就不该回 */
export function needsReply(event) {
  if (!event) return false
  const kind = kindOf(event)
  if (kind !== KIND.MESSAGE && kind !== KIND.IMAGE) return false
  if (event.scope === SCOPE.PRIVATE || event.scope === SCOPE.PANEL) return true
  return has(event, TAG.AT_ME) || has(event, TAG.MENTIONED_NAME)
}
