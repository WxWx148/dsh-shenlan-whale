/**
 * decide/cadence.mjs — 说话节奏：什么时候开口、隔多久说一次。
 *
 * ══════════════════════════════════════════════════════════════
 * 【为什么要有这一层】
 *
 *   参考实现（deepseek_QQFish_Service）里有一条很容易被忽略、
 *   但恰恰是防封最要紧的设计：**主动消息不是按固定周期发的**。
 *
 *   它是「60~120 分钟随机间隔 + 0.45 的触发概率」——
 *   也就是说：**每隔一段时间来看一眼，到点了也不一定说，说的话时间也不一样**。
 *
 *   为什么这重要：
 *     机器人最扎眼的地方不是「话多」，是「**准**」。
 *     每隔 180 分钟整点发一条，主人只要看两天时间就知道它是机器 ——
 *     比复读还明显，因为复读还有可能是手滑，连着报时不会。
 *
 *   深蓝原来就是固定 180 分钟（config.proactive.intervalMinutes）。
 *   那是**整点报时式**的主动开口 —— 最像机器人的一种主动。
 *
 * ══════════════════════════════════════════════════════════════
 * 【怎么改才不伤拟人感】
 *
 *   这里最容易走偏的方向是「随机得太过」：
 *   间隔随机到 5 分钟一次，或者一天突然蹦出八条 —— 那不是真人，是抽风。
 *
 *   所以这里做三件事：
 *     1. **区间随机**，不是「每次都重置一个倒计时」。
 *        下次开口的间隔在 [下限, 上限] 里随机，抽到哪个算哪个。
 *     2. **保留原有闸门**：每天上限、作息时段、预算 —— 一个都不放松。
 *        随机只改「间隔」，不改「能不能说」。
 *     3. **概率是叠加的，不是替代**：即使到了时间，也有一定概率这轮不说。
 *        真人不会每次到点都必然开口。
 *
 *   间隔的默认值按**实测**标定，不按参考实现照抄：
 *     本机自发发言（前面 3 分钟没人说话时自己开口）实测 7 条，
 *     相邻间隔中位 **89 分钟**，p25=55、p75=876。
 *     参考实现给的是 60~120 —— 跟实测对得上，就用它当默认。
 * ══════════════════════════════════════════════════════════════
 */

/** 主动开口的默认间隔区间（分钟）。下限按实测 p25 略松，上限对齐实测中位。 */
export const DEFAULT_MIN_GAP_MINUTES = 45
export const DEFAULT_MAX_GAP_MINUTES = 120

/** 到点了也不一定开口的概率（0~1）。0.35 ≈ 三次里有一次忍住。 */
export const DEFAULT_SKIP_CHANCE = 0.35

/**
 * 在区间里抽一个间隔（毫秒）。
 *
 * 用「平方分布」而不是均匀分布：均匀抽会让人感觉平均，
 * 而真人更多时候是「隔一阵子」，偶尔隔很久。
 * 平方分布让间隔**偏向短的一端**（靠近下限），
 * 同时保留长尾 —— 这更接近实测里 p25=55 / 中位=89 的形状。
 *
 * @param {number} minMinutes
 * @param {number} maxMinutes
 * @param {() => number} [random] 注入随机源（测试用）
 * @returns {number} 毫秒
 */
export function pickGapMs(minMinutes = DEFAULT_MIN_GAP_MINUTES, maxMinutes = DEFAULT_MAX_GAP_MINUTES, random = Math.random) {
  const lo = Math.max(1, Number(minMinutes) || DEFAULT_MIN_GAP_MINUTES)
  const hi = Math.max(lo, Number(maxMinutes) || DEFAULT_MAX_GAP_MINUTES)
  const r = Math.max(0, Math.min(1, Number(random()) || 0))
  // 平方分布：r² 让结果偏向区间下端
  const ratio = r * r
  return Math.round((lo + (hi - lo) * ratio) * 60_000)
}

/**
 * 这一轮要不要开口。
 *
 * 为什么要概率而不是「到点必说」：
 *   真人不是闹钟。到点想说、但正好在忙 / 没什么想说的，就不说。
 *   固定必说 = 主人能预测它 = 一眼看出是机器。
 *
 * @param {object} [options]
 * @param {number} [options.skipChance] 0~1，越大越常忍住
 * @param {() => number} [options.random]
 * @returns {boolean} true = 说
 */
export function shouldSpeak(options = {}) {
  const chance = Number(options.skipChance)
  // 上限是 1（不是 0.95）：1 的意思就是「永远不说」，
  // 钳到 0.95 会让它偶尔还是开口 —— 那是把配置的意思改了。
  const skip = Number.isFinite(chance) ? Math.max(0, Math.min(1, chance)) : DEFAULT_SKIP_CHANCE
  if (skip <= 0) return true
  if (skip >= 1) return false
  const random = typeof options.random === 'function' ? options.random : Math.random
  return random() >= skip
}

/**
 * 一个会自己记账的「下次开口时间」。
 *
 * 为什么要有状态而不是每次现算：
 *   现算的话，每次检查都重新抽一次间隔 —— 那间隔永远在刷新，
 *   于是永远等不到「攒够间隔」的那一刻（每次都是从头开始）。
 *   必须把「上次说了什么时候 + 那次抽到的间隔」记下来。
 */
export class Cadence {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]
   * @param {() => number} [options.random]
   * @param {number} [options.minMinutes]
   * @param {number} [options.maxMinutes]
   * @param {number} [options.skipChance]
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.random = typeof options.random === 'function' ? options.random : Math.random
    this.minMinutes = Number(options.minMinutes) || DEFAULT_MIN_GAP_MINUTES
    this.maxMinutes = Number(options.maxMinutes) || DEFAULT_MAX_GAP_MINUTES
    this.skipChance = Number.isFinite(Number(options.skipChance)) ? Number(options.skipChance) : DEFAULT_SKIP_CHANCE
    // 上次开口的时刻，以及那一轮抽到的间隔
    this.lastAt = 0
    this.gapMs = 0
    /** 抽到但忍住了的次数：面板上能看出「它经常话到嘴边又咽回去」 */
    this.skipped = 0
  }

  /** 记一次真的开口了，并抽下一次的间隔 */
  markSpoke(at = this.now()) {
    this.lastAt = at
    this.gapMs = pickGapMs(this.minMinutes, this.maxMinutes, this.random)
    return this.gapMs
  }

  /** 从磁盘状态恢复（重启后别把上次的时间忘了） */
  restore(state = {}) {
    this.lastAt = Number(state.lastAt) || 0
    this.gapMs = Number(state.gapMs) || 0
    this.skipped = Number(state.skipped) || 0
    return this
  }

  /** 存回磁盘的状态 */
  snapshot() {
    return { lastAt: this.lastAt, gapMs: this.gapMs, skipped: this.skipped }
  }

  /**
   * 现在能不能开口。
   *
   * 返回三种结果，因为「不能开口」有两种完全不同的原因：
   *   · 'wait'  —— 间隔还没到（正常）
   *   · 'skip'  —— 间隔到了，但这轮忍住了（也是正常，而且更像人）
   *   · 'speak' —— 说
   *
   * 分开是为了让调用方能分别记账 ——
   * 「一直等不到」和「老想说话又不说」是两个完全不同的问题。
   *
   * @param {number} [at]
   * @returns {{ ok: boolean, why: 'speak'|'wait'|'skip', remainingMs?: number }}
   */
  check(at = this.now()) {
    // 从来没说过：第一次总是可以（不然新装上要等 45 分钟才开口）
    if (!this.lastAt) return { ok: true, why: 'speak' }
    // 间隔还没定下来（老状态文件里只有 lastAt）→ 补抽一个
    if (!this.gapMs) this.gapMs = pickGapMs(this.minMinutes, this.maxMinutes, this.random)
    const since = at - this.lastAt
    if (since < this.gapMs) {
      return { ok: false, why: 'wait', remainingMs: this.gapMs - since }
    }
    if (!shouldSpeak({ skipChance: this.skipChance, random: this.random })) {
      this.skipped += 1
      return { ok: false, why: 'skip' }
    }
    return { ok: true, why: 'speak' }
  }
}
