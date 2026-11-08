/**
 * decide/burst.mjs — 连发合并。
 *
 * ══════════════════════════════════════════════════════════════
 * 【为什么要有这一层】
 *
 *   群里一个人连着发三条：
 *     「在吗」
 *     「你还在不」
 *     「说句话呀」
 *
 *   这三条是**同一个人的连发**。深蓝如果对每条都回一次，
 *   群里看到的就是：一个人问了三句，它答了三遍 —— 刷屏，而且不成比例。
 *
 *   真人怎么做的？把这三条当成**一件事**看，回一句就够。
 *
 * ══════════════════════════════════════════════════════════════
 * 【这一层同时扛两件事，所以两件事是一件事】
 *
 *   风控那边要的是：别刷屏、别复读、别像程序一次性吐一堆。
 *   拟人那边要的是：别秒回、要看对方说完没有、回复要像「想了一下才说的」。
 *
 *   在群里，这两件事落在同一个动作上：
 *   **等对方把话说完，再回一句。**
 *
 *   · 拟人：真人看到有人连着发三句，不会立刻回第一条 ——
 *     他会等一下，看对方是不是还在说，说完了才回。
 *     这个「等一下」就是拟人的一部分。
 *   · 风控：攒完一次回一条，群里就不会出现「问三句答三遍」的刷屏。
 *
 *   所以这一层不是「防复读的补丁」，是「怎么回话」的一部分。
 *
 * ══════════════════════════════════════════════════════════════
 * 【三个判据，缺一不可】
 *
 *   1. **同一个人** —— 群里 A 和 B 各说一句，那是两件事，
 *      拼成一句不通的话比不合并更糟。
 *   2. **同一个会话** —— 私聊和群聊各算各的。
 *   3. **时间挨得近** —— 在窗口内才算连发。
 *
 * 【合并不是丢弃】
 *
 *   合并后的内容用换行连起来（真人连发时看起来就是好几行），
 *   不是拼成一句。一条都不丢 —— 丢内容比刷屏难看得多。
 *
 * 【参考实现（deepseek_QQFish_Service）】
 *
 *   它也是「缓冲 + 窗口 + 同一个人才合并」，窗口 1500ms、上限 6 条。
 *   这里沿用同一套口径，窗口按深蓝自己的配置走。
 * ══════════════════════════════════════════════════════════════
 */

/** 默认合并窗口（毫秒）。跟 guard.mergeWindowMs 对齐。 */
export const DEFAULT_MERGE_WINDOW_MS = 1500

/** 合并后最多留几条。再多就该分开发了 —— 合成一大坨也不是人话。 */
export const MAX_MERGED = 6

/**
 * 该不该把这条消息并进上一条。
 *
 * 判据三条，全都要满足：
 *   1. **同一个人**（from 相同）—— 不同人说的不合并；
 *   2. **同一个会话**（群/私聊相同）；
 *   3. **时间挨得近**（在窗口内）。
 *
 * @param {object} input
 * @param {object} input.last 上一条的消息摘要 { from, conversation, at }
 * @param {object} input.event 这一条的事件
 * @param {number} [input.windowMs]
 * @returns {boolean}
 */
function shouldMerge(last, event, windowMs = DEFAULT_MERGE_WINDOW_MS) {
  if (!last || !event) return false
  // 不同人 → 不是一件事
  const from = String(event.from ?? '')
  if (!from || from !== String(last.from ?? '')) return false
  // 不同会话 → 更不是一件事
  const conversation = String(event.conversation ?? '')
  if (!conversation || conversation !== String(last.conversation ?? '')) return false
  // 自己发的两条不合并 —— 那是自己分条发出去的东西，合并了就乱序了
  if (from === 'self') return false
  const at = Number(event.at ?? 0)
  const lastAt = Number(last.at ?? 0)
  if (!at || !lastAt || at < lastAt) return false
  return at - lastAt <= Math.max(0, Number(windowMs) || 0)
}

/**
 * 把连发合成一条。
 *
 * @param {Array<{text?: string}>} messages 同一人的连发，按时间先后
 * @param {object} [options]
 * @param {number} [options.maxMerged] 最多留几条
 * @returns {string} 合并后的文本（用换行连）
 */
export function mergeTexts(messages, options = {}) {
  const maxMerged = Math.max(1, Number(options.maxMerged) || MAX_MERGED)
  const list = Array.isArray(messages) ? messages : []
  const parts = []
  for (const item of list) {
    const text = String(item?.text ?? '').trim()
    if (!text) continue
    parts.push(text)
  }
  if (!parts.length) return ''
  // 超过上限时只合并、不丢弃：把尾巴全部接进最后一条。
  // 以前这里是 `break`，第 7 条起直接消失 —— 而文件头写的是「合并不是丢弃」，
  // 对方连发一段长话时，模型会拿着缺了后半段的上下文回答。
  if (parts.length <= maxMerged) return parts.join('\n')
  const head = parts.slice(0, maxMerged - 1)
  const tail = parts.slice(maxMerged - 1)
  // 用换行连 —— 真人连发时看起来就是好几行，不是拼成一句长话
  return [...head, tail.join('\n')].join('\n')
}

/**
 * 连发缓冲：把「谁说了什么」攒起来，等对方说完再一次性交出去。
 *
 * 为什么要按「会话 + 人」记，而不是只按会话记：
 *   群里 A 说完、B 接着说 —— B 的那条**不该**并进 A 的那条。
 *   所以每个「会话 + 人」各记各的。
 *
 * 计时器是可注入的：真实运行用 setTimeout，
 * 用例里换成手动控制，才能精确验证「什么时候算对方说完了」。
 */
export class BurstLedger {
  /**
   * @param {object} [options]
   * @param {number} [options.windowMs]
   * @param {(fn:Function, ms:number)=>any} [options.setTimer]
   * @param {(handle:any)=>void} [options.clearTimer]
   */
  constructor(options = {}) {
    this.windowMs = Math.max(0, Number(options.windowMs ?? DEFAULT_MERGE_WINDOW_MS))
    this.setTimer = typeof options.setTimer === 'function'
      ? options.setTimer
      : (fn, ms) => {
        const t = setTimeout(fn, ms)
        // 计时器不该拖着进程不让退出
        t?.unref?.()
        return t
      }
    this.clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : (t) => clearTimeout(t)
    /** 键「会话|人」→ { events, decision, timer } */
    this.slots = new Map()
  }

  /** 键：会话 + 人 */
  #key(conversation, from) {
    return `${conversation || ''}|${from || ''}`
  }

  /**
   * 收一条消息。
   *
   * @param {object} event
   * @param {object} decision 这条消息的路由结果
   * @param {(mergedEvent:object, decision:object)=>void} onFlush 窗口到了就调它
   * @returns {boolean} true = 已收进缓冲（调用方不该再单独处理这条）
   */
  collect(event, decision, onFlush) {
    const key = this.#key(event?.conversation, event?.from)
    let slot = this.slots.get(key)
    if (!slot) {
      slot = { events: [], decision, timer: null }
      this.slots.set(key, slot)
    }

    // 最后一道判定：这条跟上一条到底算不算连发。
    //
    // 按「会话 + 人」分组已经挡住了「不同人合并」，但没挡住时间越窗 ——
    // 比如配置刚被改小、或者时钟跳变。
    // 所以真正合并前再用 shouldMerge 判一次：
    // 不算连发的话，它自己开一批，不跟上一批混。
    const last = slot.events[slot.events.length - 1]
    if (last && !shouldMerge(last, event, this.windowMs)) {
      // 不算连发：先把上一批结算掉，这条单独一批
      this.#flush(key, slot, onFlush)
      slot = { events: [], decision, timer: null }
      this.slots.set(key, slot)
    }
    slot.events.push(event)
    // 决策取**最后一条**的：对方连着说，后一句才是他真正在问的
    slot.decision = decision

    // 窗口推后：每来一条就重新算一次，所以对方一直说就一直等
    if (slot.timer) this.clearTimer(slot.timer)
    slot.timer = this.setTimer(() => {
      this.#flush(key, slot, onFlush)
    }, this.windowMs)

    return true
  }

  /**
   * 结算一批：合成一条，交出去。
   *
   * 单独抽出来是因为有两处要结算 ——
   * 窗口到了（对方说完了），以及中途来了一条不算连发的（时钟跳变/配置改小）。
   */
  #flush(key, slot, onFlush) {
    if (this.slots.get(key) === slot) this.slots.delete(key)
    if (slot.timer) {
      this.clearTimer(slot.timer)
      slot.timer = null
    }
    const mergedEvent = this.merge(slot.events)
    try {
      onFlush?.(mergedEvent, slot.decision)
    } catch {
      // 合并后那一轮自己会兜住错误，这里不该把缓冲的清理带崩
    }
  }

  /**
   * 把攒着的消息合成一条事件。
   *
   * @param {Array<object>} events
   * @returns {object}
   */
  merge(events) {
    const list = Array.isArray(events) ? events : []
    const first = list[0]
    if (!first) return null
    const texts = list.map((one) => String(one?.payload?.text || '')).filter(Boolean)
    // 连发里可能夹着图片、转发卡片：以前只取 first.payload，后一条的 images /
    // forwardId 全丢，于是「先打字再发图/转发」在当前轮里等于没发过。
    const images = []
    const files = []
    const seenImage = new Set()
    let forwardId = ''
    for (const one of list) {
      const payload = one?.payload || {}
      for (const pic of Array.isArray(payload.images) ? payload.images : []) {
        const key = String(pic?.file || pic?.url || '')
        if (!key || seenImage.has(key)) continue
        seenImage.add(key)
        images.push(pic)
      }
      if (Array.isArray(payload.files)) files.push(...payload.files)
      if (!forwardId && payload.forwardId) forwardId = String(payload.forwardId)
    }
    // 只有「一条文字、也没有任何图片/文件/转发」才是真的无事可合。
    // 以前 texts.length<=1 就提前返回，恰好把「文字 + 图片/转发」丢掉。
    if (texts.length <= 1 && !images.length && !files.length && !forwardId) return first
    return {
      ...first,
      payload: {
        ...first.payload,
        // mergeTexts 读的是消息对象的 text 字段；以前传的是 texts 字符串数组，
        // 于是一次合并后正文永远是空串 —— 事件里三条都在，当前这轮却像没听见。
        text: mergeTexts(list.map((one) => ({ text: String(one?.payload?.text || '') }))),
        ...(images.length ? { images } : {}),
        ...(files.length ? { files } : {}),
        ...(forwardId ? { forwardId } : {}),
      },
      // 记下合并了几条：后面要能查「这条回复是攒了几条想出来的」
      burstCount: texts.length,
    }
  }

  /** 现在有几个缓冲 */
  size() {
    return this.slots.size
  }

  /** 清掉（配置热更新或测试用） */
  clear() {
    for (const slot of this.slots.values()) {
      if (slot.timer) this.clearTimer(slot.timer)
    }
    this.slots.clear()
  }
}
