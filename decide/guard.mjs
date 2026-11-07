/**
 * decide/guard.mjs — 该不该说话、该等多久。
 *
 * 这份文件只回答两个问题，且**只回答这两个**：
 *   1. 这一条现在能不能发（限流 / 夜间 / 冷却）；
 *   2. 能发的话，隔多久发（首条延迟、最小间隔、积压时拉长）。
 *
 * 为什么单独成文件：这两件事是「说话」之前唯一的闸门。
 * 混进 turn 里，就会出现「换个生成器，限流忘了带」——旧版就是这样把风控弄丢的。
 *
 * 计数只存在内存里：重启清零可以接受，因为限流看的是分钟/小时这种短窗口，
 * 重启本身已经打断了节奏。把它写盘反而会让「重启一下绕开限制」变得困难——没必要。
 */

import { inWindow } from '../facts/index.mjs'

/** 最近多少毫秒内的发送要计入 */
const MINUTE = 60_000
const HOUR = 3_600_000

/**
 * 节奏下限。**比这还小只可能是把「秒」当「毫秒」写进来了**（历史脏数据就是 0.3）；
 * 300 毫秒以下等于秒回 —— 既是机器人特征，又是风控最敏感的行为。
 * 校验层（panel.validate）已经兜了一次，这里是第二道：
 * 配置里躺着脏值时，宁可按秒解释，也不许退化成秒回。
 */
export const MIN_DELAY_MS = 300
/** 上限：再久就不像人在打字，像掉线了 */
const MAX_DELAY_MS = 8000
/**
 * 主人那一侧的分钟下限。
 *
 * 主人不受「每小时总量」限制，但分钟闸门还在 —— 真·不限会让模型抽风时一分钟刷几百条，
 * 那不是亲切，是把它往风控上送。15 条/分钟 = 平均 4 秒一条，比人打字还慢，
 * 正常对话永远撞不到，只用来兜住失控。
 */
const OWNER_MIN_PER_MINUTE = 15

/**
 * 取一个「以毫秒为单位」的时长。
 *
 * 配置里存的是毫秒，但历史上有把秒的数值直接写进来的情况（0.3 → 0.3 毫秒）。
 * 这里按量级判断：正数却小到不像毫秒，就当它写的是秒，乘 1000 补回来。
 * 宁可补错成稍长一点，也不能放任它缩成 0.3 毫秒那种秒回。
 * @param {*} value
 * @returns {number}
 */
function msOf(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < MIN_DELAY_MS ? Math.round(n * 1000) : Math.round(n)
}

export class Guard {
  constructor(input = {}) {
    this.config = input.config || {}
    // 发送时间戳，只留最近一小时，避免长跑内存涨
    this.sent = []
    // 按会话分开的小时计数。面板上写的是「每群每小时最多回几条」，
    // 旧实现却拿全局发送数去拦 —— 私聊、主动播报、别的群一起把额度吃光，
    // 结果「群里 @ 它没反应，私聊却正常」。键是 conversation（group:xxx / private:xxx）。
    this.sentBy = new Map()
    // 有没有出现过带会话键的计数。老调用方（用例、旧代码）只调 note(at)，
    // 这时 continue 用全局计数；一旦有键，就按会话算，新会话从 0 开始。
    this.keyedNotes = 0
    this.lastAt = 0
    // 临时静音：主人说「闭嘴半小时」时只改这里，不动配置文件。
    // 写进配置会让「安静一会儿」变成永久设置，下次重启还没消。
    this.mutedUntil = 0
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()
  }

  /** 临时闭嘴。分钟数夹在 1 分钟到 12 小时之间 */
  mute(minutes = 30, at = this.now()) {
    const span = Math.max(1, Math.min(720, Number(minutes) || 30))
    this.mutedUntil = at + span * 60_000
    return { ok: true, minutes: span, until: this.mutedUntil }
  }

  unmute() {
    const was = this.mutedUntil
    this.mutedUntil = 0
    return { ok: true, was }
  }

  muted(at = this.now()) {
    return Number(this.mutedUntil) > Number(at)
  }

  /** 配置热改之后要能跟着变 */
  configure(config = {}) {
    this.config = config
  }

  /** 清掉一小时以前的记录 */
  #prune(at) {
    const cut = at - HOUR
    let i = 0
    while (i < this.sent.length && this.sent[i] < cut) i += 1
    if (i) this.sent.splice(0, i)
    for (const [key, list] of this.sentBy) {
      let j = 0
      while (j < list.length && list[j] < cut) j += 1
      if (j) list.splice(0, j)
      if (!list.length) this.sentBy.delete(key)
    }
  }

  #countSince(at, span) {
    const from = at - span
    let n = 0
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      if (this.sent[i] >= from) n += 1
      else break
    }
    return n
  }

  /** 某个会话最近 span 内发了几条 */
  #countKey(key, at, span) {
    const list = this.sentBy.get(String(key || '')) || []
    const from = at - span
    let n = 0
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i] >= from) n += 1
      else break
    }
    return n
  }

  /** 这次发送属于哪个会话；拿不到就返回空串（退回全局计数） */
  #keyOf(context = {}) {
    if (context.conversation) return String(context.conversation)
    const event = context.event || context
    if (event?.conversation) return String(event.conversation)
    if (event?.scope === 'group') {
      const gid = event.payload?.groupId || event.groupId
      if (gid) return `group:${gid}`
    }
    if (event?.scope === 'private' && event.from) return `private:${event.from}`
    if (context.scope && context.target) return `${context.scope}:${context.target}`
    return ''
  }

  /**
   * 记一次发送。必须在真的发出去之后调，不是之前。
   *
   * `count` 是这次发送占几条额度：一句话拆成三条气泡，额度上只算**一条回复**
   * （第一条 count=1，后面 count=0），但每一条都要更新 lastAt ——
   * 条与条之间的间隔仍然按真实发送算，不能因为计数合并就把节奏也合并。
   */
  note(at = this.now(), context = {}, count = 1) {
    this.lastAt = at
    if (Number(count) > 0) {
      this.sent.push(at)
      const key = this.#keyOf(context)
      if (key) {
        const list = this.sentBy.get(key) || []
        list.push(at)
        this.sentBy.set(key, list)
        this.keyedNotes += 1
      }
    }
    this.#prune(at)
  }

  /**
   * 夜间免打扰。窗口可以跨零点（23:00-07:00），跨零点的判断在 event.inWindow 里，
   * 这里不重复实现 —— 同一件事只写一遍，不然两处迟早算出不同答案。
   */
  quiet(at = this.now()) {
    // 显式写全路径而不是走一个 cfg() 取巧：人和静态扫描都要看得见「这个键被谁读了」
    const window = this.config.guard?.nightWindow
    if (!window) return false
    return inWindow(at, window)
  }

  /**
   * 这一条现在能不能发。
   * 顺序是先狠后软：夜间最硬（谁都不能吵），其次总量，最后频率。
   *
   * 关于主人：这三项闸门里，**只有"总量"和"频率"曾经不认人**。
   * 小时配额的本意是「别在群里刷屏惹风控」（面板上写的就是"每群每小时最多回几条"），
   * 但旧实现把主人私聊也算进去 —— 于是跟机器人聊得稍密一阵之后，
   * 它突然一条都不回，而且**什么都不说**：日志里躺着 `per_hour`，人只看得见沉默。
   * 这是最难查的一类故障：通道在线、消息收得到、就是不答话，只能靠重启（内存计数清零）绕。
   *
   * 所以主人现在不受小时总量限制。但不是完全不限 ——
   * 分钟闸门仍然生效（且放宽到不低于 OWNER_MIN_PER_MINUTE），
   * 因为模型抽风时一分钟连发几十条照样是风控特征，那一条不是人情问题。
   */
  check(at = this.now(), context = {}) {
    const ownerId = String(this.config.identity?.ownerId || '')
    const owner = !!ownerId && String(context.event?.from || '') === ownerId
    if (this.muted(at) && !owner) {
      const left = Math.max(1, Math.ceil((this.mutedUntil - at) / 60_000))
      return { ok: false, why: 'muted', text: `安静中（还有 ${left} 分钟）`, retryAfterMs: this.mutedUntil - at }
    }
    if (this.quiet(at) && !owner) return { ok: false, why: 'night', text: '现在是夜间静音时段' }

    const perMinute = Number(this.config.guard?.perMinute) || 0
    if (perMinute > 0) {
      // 分钟闸也按会话算：一个群刷屏不该让私聊和别的群跟着哑一分钟。
      const key = this.#keyOf(context)
      const used = this.keyedNotes > 0 && key ? this.#countKey(key, at, MINUTE) : this.#countSince(at, MINUTE)
      const limit = owner ? Math.max(perMinute, OWNER_MIN_PER_MINUTE) : perMinute
      if (used >= limit) {
        const where = key.startsWith('group:') ? '这个群' : '这个会话'
        return { ok: false, why: 'per_minute', text: `${where}这一分钟已经回了 ${used} 条，到上限了`, retryAfterMs: MINUTE }
      }
    }

    const perHour = Number(this.config.guard?.replyQuotaPerHour) || 0
    if (perHour > 0 && !owner) {
      // 「每群每小时」就按群算；私聊和其他没有会话键的发送仍按全局算，
      // 避免旧行为（私聊被别的群拖累）原样留在另一条路径上。
      const key = this.#keyOf(context)
      const used = key.startsWith('group:') ? this.#countKey(key, at, HOUR) : this.#countSince(at, HOUR)
      if (used >= perHour) {
        return {
          ok: false,
          why: 'per_hour',
          text: key.startsWith('group:') ? `这个群这一小时已经说了 ${used} 条，到上限了` : `这一小时已经说了 ${used} 条，到上限了`,
          retryAfterMs: HOUR,
        }
      }
    }

    return { ok: true, why: 'ok', text: '' }
  }

  /**
   * 开口之前该等多久。
   *
   * 三个来源相加，但**不相乘**：
   *   首条延迟 = 别秒回，秒回像机器人；
   *   最小间隔 = 两条之间留缝，别刷屏；
   *   积压     = 最近一分钟发得越多，等得越久，把节奏拉平。
   *
   * 上限压在 8 秒：再久就不像人在打字，像掉线了。
   */
  delay(at = this.now()) {
    const first = msOf(this.config.guard?.firstDelayMs)
    const gap = msOf(this.config.guard?.minGapMs)
    const sinceLast = this.lastAt ? at - this.lastAt : Infinity
    const waitGap = sinceLast >= gap ? 0 : gap - sinceLast

    const recent = this.#countSince(at, MINUTE)
    // 一分钟里已经发了 5 条以上，每多一条多等 400ms，最多再加 3 秒
    const backlog = recent >= 5 ? Math.min(3000, (recent - 4) * 400) : 0

    return Math.min(MAX_DELAY_MS, first + waitGap + backlog)
  }

  /** 面板能直接显示的一行 */
  stats(at = this.now()) {
    this.#prune(at)
    return {
      lastMinute: this.#countSince(at, MINUTE),
      lastHour: this.#countSince(at, HOUR),
      quiet: this.quiet(at),
    }
  }
}
