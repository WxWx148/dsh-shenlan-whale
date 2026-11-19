/**
 * voice/typing.mjs — 出站节奏：像人一样「想一下、打一会儿、再发」。
 *
 * 这一层只管三件事，别的都不管：
 *   1. 这一次该等多久（打字时间模型：基础思考 + 每字耗时 + 抖动，最后封顶）；
 *   2. 谁先发 —— 全局只有一条在打，私聊和群聊排同一队；
 *   3. 分条之间留缝，自己拆的段多留，机器切的少留。
 *
 * 为什么单独成文件（踩过的坑）：节奏以前散在 guard.delay 与 turn.#say 里，
 * 结果「秒回」和「一次刷三条」两个毛病轮流出现 —— 首条延迟按固定值给，
 * 长回复和短回复等得一样久；分条之间只有 guard 的最小间隔，两条几乎同时落地。
 * 提到一个模块里，**等待与发送是同一个函数里的一前一后**，中间没有别的分支能绕过去。
 *
 * 和 guard 的分工不能混：
 *   guard          管「能不能发」（限流 / 夜间 / 静音），是闸门；
 *   typing         管「发的样子」（等多久 / 打几条 / 隔多久），是手感。
 * 闸门没放行就根本走不到这里；走到这里也不代表能绕开闸门。
 */

/** 打字模型的默认值。全部是「常量而非配置键」—— 手感不该让用户反复调 */
export const TYPING = Object.freeze({
  /** 每字打多久（秒）。中文手机输入 0.45 秒一字，接近真人盲打 */
  secPerChar: 0.45,
  /** 看到消息后的基础思考（秒）。0 就是「条件反射」，不像人 */
  thinkingBaseSec: 1.5,
  /** 每字额外的构思时间（秒）。句子越长，想的时间也越长 */
  thinkingPerCharSec: 0.05,
  /** 抖动区间（秒）：真人不会每次都在同一个毫秒数发出 */
  jitterSec: Object.freeze([0.3, 1.2]),
  /** 封顶（秒）。再长就不像打字，像掉线 */
  capSec: 15,
  /** 下限（毫秒）。低于这个数就是秒回，是机器人特征 */
  floorMs: 200,
  /**
   * 纯打字（不算「想」）的封顶（秒）。
   *
   * 「想」只发生一次，在这一轮的第一条之前。后面每条只是接着往下打，
   * 那部分的封顶就该比整体小 —— 否则一条长消息的后半段会拖十几秒，
   * 对方那边早就以为卡死了。
   */
  typingOnlyCapSec: 8,
  /**
   * 纯打字的限（毫秒）。
   *
   * 比整体下限大：一条 2 字的消息，纯打字也就半秒多，
   * 但段与段之间已经有缝了，这一段不必再压到 200 毫秒 ——
   * 那会让两条几乎同时落地，又回到「一次刷三条」的毛病。
   */
  typingOnlyFloorMs: 400,
  /** 队列上限：排队等打字的条数。超了就不再人为拖时间，只保证串行 */
  queueMax: 5,
  /**
   * 一整条回复（多条加起来）最多等多久（秒）。
   *
   * 为什么需要这个上限：每条各按自己的字数算打字时间之后，
   * 三条 40 字的总等待是 15 + 13.5 + 13.5 ≈ 42 秒 ——
   * 对方那边早就以为卡死了。
   *
   * 真人的情况是：他确实要打那么久，但**不会一条一条憋到最后才发**——
   * 他是「想到一句发一句」。所以这里把总量压住，
   * 让总时长落在一个「他还活着但打得慢」的范围内。
   *
   * 24 秒是按「三条分条、最长的 40 字」估的：
   * 一条 40 字真要 15 秒，三条不该超过 24 秒 —— 差不多是「打了第一条，
   * 后面两条快一点」。
   */
  totalWaitCapSec: 24,
  /**
   * 有人在排队时，这一条最多打多久（秒）。
   *
   * 没有这个上限时，一条长回复能把后面的会话压住整整 15 秒 ——
   * 群里刷屏时尤其明显：每条都按「完整打字时长」慢慢发，越积越久，
   * 最后变成「十分钟前的消息现在才回」。有人等就让路，是排队的基本礼貌。
   */
  crowdedCapSec: 4,
  /** 自己拆出来的两段之间（毫秒）：打完一段想一下再打下一段 */
  selfSplitGapMs: Object.freeze([1000, 3000]),
  /** 机器切出来的两条之间（毫秒）：同一次思考的产物，缝小一点 */
  partGapMs: Object.freeze([500, 1400]),
})

/**
 * 这一段文字「打」出来该花多久。
 *
 * 纯函数，随机量由调用方给（默认取抖动区间中值），所以用例可以钉住确切数字。
 * 顺序是「先加后夹」：先算出真实耗时，再夹进 [下限, 封顶]。
 * 反过来（先夹再加）会让长回复的封顶失效 —— 那正是旧版 8 秒封顶被绕过的原因。
 *
 * @param {string} text
 * @param {{baseSec?:number, perCharSec?:number, jitterMs?:number, capMs?:number, floorMs?:number}} [options]
 * @returns {number} 毫秒
 */
export function typingDelayMs(text, options = {}) {
  const body = String(text || '')
  const baseSec = Number(options.baseSec ?? TYPING.thinkingBaseSec)
  const perCharSec = Number(options.perCharSec ?? TYPING.secPerChar + TYPING.thinkingPerCharSec)
  const jitterMs = Number(options.jitterMs ?? ((TYPING.jitterSec[0] + TYPING.jitterSec[1]) / 2) * 1000)
  const capMs = Number(options.capMs ?? TYPING.capSec * 1000)
  const floorMs = Number(options.floorMs ?? TYPING.floorMs)
  const raw = baseSec * 1000 + body.length * perCharSec * 1000 + jitterMs
  const safe = Number.isFinite(raw) ? raw : floorMs
  return Math.round(Math.max(floorMs, Math.min(safe, capMs)))
}

/**
 * 这一段文字「纯打字」该花多久 —— **不算「想」的那一下**。
 *
 * 为什么单独要一个函数：
 *   一条回复分成三条发，是**同一个连续动作**：
 *   「想」只发生一次（在第一条之前），后面两条是接着往下打。
 *   真人不会在发第二条之前重新想一遍 —— 他是想到一句发一句。
 *
 *   以前这个差别没做出来：
 *     · 更早：只有第一条按字数算，后面的条只给一个固定缝 ——
 *       「5 字的第二条」和「40 字的第二条」发得一样快，不像人在打字；
 *     · 改成每条都算完整时长：每条都重新「想」一次 ——
 *       三条各带 1.5 秒思考，总时长翻倍，对方会以为卡死了。
 *
 *   正确的算法是：
 *     第一条 = 想 + 打（完整时长）
 *     后面每条 = 只算「打」（按它自己的字数）
 *
 *   注意不能拿「完整时长 - 思考时间」来凑：
 *   typingDelayMs 会先算再夹（上限 15 秒、下限 200 毫秒），
 *   夹过的值减掉 base 会失真 —— 长句被封顶后减出来的时间是错的。
 *   所以这里从源头重算一遍：只按字数和抖动，不带 base。
 *
 * @param {string} text
 * @param {{perCharSec?:number, jitterMs?:number, capMs?:number, floorMs?:number}} [options]
 * @returns {number} 毫秒
 */
export function typingOnlyMs(text, options = {}) {
  const body = String(text || '')
  const perCharSec = Number(options.perCharSec ?? TYPING.secPerChar + TYPING.thinkingPerCharSec)
  const jitterMs = Number(options.jitterMs ?? ((TYPING.jitterSec[0] + TYPING.jitterSec[1]) / 2) * 1000)
  // 纯打字的封顶比整体封顶小：一次连续动作里，「打」的部分不该单独占满 15 秒
  const capMs = Number(options.capMs ?? TYPING.typingOnlyCapSec * 1000)
  const floorMs = Number(options.floorMs ?? TYPING.typingOnlyFloorMs)
  const raw = body.length * perCharSec * 1000 + jitterMs
  const safe = Number.isFinite(raw) ? raw : floorMs
  return Math.round(Math.max(floorMs, Math.min(safe, capMs)))
}

/**
 * 两条之间的间隔。
 *
 * 自己 `[split]` 出来的段之间要「像打完一条又想了一下」，所以明显更长；
 * 机器按字数切出来的两条本来同属一次思考，缝短一点。
 *
 * @param {number} ratio 0~1，调用方给的随机比例，便于用例钉死结果
 * @param {{selfSplit?:boolean, selfSplitGapMs?:number[], partGapMs?:number[]}} [options]
 * @returns {number} 毫秒
 */
export function partGapMs(ratio = 0.5, options = {}) {
  const range = options.selfSplit
    ? (options.selfSplitGapMs || TYPING.selfSplitGapMs)
    : (options.partGapMs || TYPING.partGapMs)
  const lo = Number(range?.[0]) || 0
  const hi = Number(range?.[1]) || lo
  const r = Math.max(0, Math.min(1, Number(ratio) || 0))
  return Math.round(lo + (hi - lo) * r)
}

/**
 * 打字台。
 *
 * 单线程是**全局**的，不按会话分：两条回复同时在「打字」，人看着就像两个人在抢键盘。
 * 实现上是一条 Promise 链（tail）：每个任务先把链尾换成自己的闸门，再等上一段跑完。
 * 这样后到的永远排在前一条**发完之后**，中间不会出现「A 的第一条、B 的第一条、A 的第二条」。
 */
export class TypingDesk {
  /**
   * @param {object} input
   * @param {object} [input.channel]      需要 inputStatus(scope, target)（可缺，缺了就不亮「正在输入」）
   * @param {(ms:number)=>Promise<void>} [input.sleep]
   * @param {()=>number} [input.random]   0~1 随机源，用例注入固定值
   * @param {(line:string)=>void} [input.log]
   * @param {object} [input.options]      typingDelayMs / partGapMs 的参数覆盖
   * @param {()=>number} [input.now]      时钟，用例注入固定值
   */
  constructor(input = {}) {
    this.channel = input.channel || null
    this.sleep = typeof input.sleep === 'function' ? input.sleep : (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
    this.random = typeof input.random === 'function' ? input.random : Math.random
    this.log = typeof input.log === 'function' ? input.log : () => {}
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()
    this.options = input.options || {}
    this.tail = Promise.resolve()
    // 正在排队（含正在打）的条数。队列上限用它判断，不用 tail 的长度（Promise 没有长度）
    this.waiting = 0
    this.typed = 0
    this.lastWaitMs = 0
    this.overloads = 0
    /** 已经亮了「正在输入」的会话 → 亮起时刻。避免同一条回复亮两次（会闪） */
    this.indicated = new Map()
    /** 因为「生成时间已经让用户等过了」而省掉的等待合计 */
    this.savedMs = 0
    /** 最近一次真正开始打的会话，排障用 */
    this.lastKey = ''
  }

  /** 换通道（重连后是同一个对象，但宿主可能重建） */
  configure(channel) {
    this.channel = channel || this.channel
  }

  get busy() {
    return this.waiting > 0
  }

  /** 面板/排障用的一行数字 */
  stats() {
    return {
      typed: this.typed,
      waiting: this.waiting,
      lastWaitMs: this.lastWaitMs,
      overloads: this.overloads,
      savedMs: this.savedMs,
      lastKey: this.lastKey,
      busy: this.busy,
    }
  }

  /**
   * 提前亮「正在输入」。
   *
   * 为什么要提前：模型生成要 3~10 秒，这期间对方盯着一个静止的聊天窗口，
   * 什么反馈都没有 —— 这是整套体验里最长的一段空白。等生成完再亮，
   * 亮的时间反而短，看起来像「先卡住、再飞速打字」。
   *
   * 这里只登记「已经亮过」，不负责等：等多久由 typeOut 决定，
   * 而且会把这段已经过去的时间从打字时长里扣掉（见 elapsedMs）。
   *
   * @param {string} scope group / private
   * @param {string|number} target
   * @param {string} [key]  会话键，typeOut 用它认领「这条已经亮过了」
   */
  async early(scope, target, key = '') {
    if (!target) return false
    const ok = await this.#indicate(scope, target)
    if (ok) {
      const tag = String(key || `${scope}:${target}`)
      this.indicated.set(tag, this.now())
      // 只留最近 64 条：这个表只用于「刚亮过就别再亮」，不需要历史
      if (this.indicated.size > 64) {
        const oldest = this.indicated.keys().next().value
        this.indicated.delete(oldest)
      }
    }
    return ok
  }

  /** 排队：前一段结束才轮到这一段。无论中间抛不抛，闸门都要放行，否则整条链永久卡死 */
  async #serial(task) {
    const prev = this.tail
    let release = () => {}
    this.tail = new Promise((resolve) => { release = resolve })
    try {
      await prev
    } catch {
      // 上一条炸了也要放行：以前 `await prev` 在 try 外面，
      // 只要有一次 reject，这条链就永久停摆，之后所有回复都发不出去。
    }
    try {
      return await task()
    } finally {
      release()
    }
  }

  /**
   * 亮一下「对方正在输入」。
   *
   * 失败必须静默：协议端不一定支持这个接口（有的版本直接 404），
   * 亮不出来只是少了一点真实感，不该让整条回复失败。
   */
  async #indicate(scope, target) {
    const fn = this.channel && this.channel.inputStatus
    if (typeof fn !== 'function') return false
    try {
      await fn.call(this.channel, scope, target)
      return true
    } catch (error) {
      this.log('[whisper] 正在输入没亮出来：' + String(error?.message || error))
      return false
    }
  }

  /**
   * 把若干条按人的节奏发出去。
   *
   * @param {object} input
   * @param {string[]} input.parts                 已经渲染好的文案（空串会被丢掉）
   * @param {(text:string, index:number)=>Promise<void>} input.say  真正发一条
   * @param {string} [input.scope]                 group / private
   * @param {string|number} [input.target]
   * @param {string} [input.key]                   会话键。用来认领「这条已经提前亮过正在输入」
   * @param {number} [input.elapsedMs]             调用方从收到消息到此刻已经花掉的时间（模型生成等）
   * @param {()=>number} [input.pace]              下限等待（guard.delay），0 表示不设
   * @param {boolean} [input.selfSplit]            这几段是模型自己拆的
   * @param {boolean} [input.indicator]            要不要亮「正在输入」，默认亮
   * @returns {Promise<{ok:boolean, lines:number, waitedMs:number, overloaded:boolean, error?:string}>}
   */
  async typeOut(input = {}) {
    const list = (Array.isArray(input.parts) ? input.parts : [input.parts])
      .map((part) => String(part ?? ''))
      .filter((part) => part.trim())
    if (!list.length) return { ok: true, lines: 0, waitedMs: 0, overloaded: false }

    const say = typeof input.say === 'function' ? input.say : null
    if (!say) return { ok: false, lines: 0, waitedMs: 0, overloaded: false, error: '没有可用的发送函数' }

    const tag = String(input.key || '')
    // 提前亮过的凭证：读走就删，一条回复只认领一次
    const armedAt = tag ? this.indicated.get(tag) || 0 : 0
    if (tag) this.indicated.delete(tag)

    // 排队长度在进队**之前**读：读到 5 说明前面已经有 5 条在等，这一条再慢慢打就是堆积
    const queued = this.waiting
    const overloaded = queued >= TYPING.queueMax
    // 后面还有人等：这一条自觉打快一点，别把队尾压到十几秒后
    const crowded = queued >= 1
    this.waiting += 1
    if (overloaded) {
      this.overloads += 1
      this.log(`[whisper] 打字队列已满（${queued} 条在等），这一条不再拖时间，只保证串行`)
    }

    return this.#serial(async () => {
      let waited = 0
      let lines = 0
      try {
        this.lastKey = tag
        const floor = typeof input.pace === 'function' ? Math.max(0, Number(input.pace()) || 0) : 0
        // 先亮指示，再等 —— 顺序反了就成了「发完才显示正在输入」，比不亮更假。
        // 已经提前亮过的（turn 在生成前就亮了）不再亮第二次，否则会闪一下。
        if (input.indicator !== false && !armedAt) await this.#indicate(input.scope, input.target)

        // 已经花掉的时间要扣掉：模型想了 6 秒，对方这 6 秒已经看见「正在输入」，
        // 就不该再按完整打字时长等一遍。以前两步相加，长回复能等 20 秒。
        const spent = armedAt
          ? Math.max(0, this.now() - armedAt)
          : Math.max(0, Number(input.elapsedMs) || 0)
        const model = this.#model()
        // ══════════════════════════════════════════════════════
        // 「想」只发生一次，在这一轮的第一条之前。
        //
        // 一条回复分成三条发，是**同一个连续动作**：
        // 真人不会在发第二条之前重新想一遍 —— 他是想到一句发一句。
        // 所以：
        //   第一条 = 想（thinkingBase）+ 打（按字数）
        //   后面每条 = 只算「打」（按它自己的字数）
        //
        // 这两头的错都犯过：
        //   · 早期：只有第一条按字数算，后面只给固定缝 ——
        //     「5 字的第二条」和「40 字的第二条」发得一样快，不像人在打字；
        //   · 后来：每条都算完整时长 ——
        //     每条都重新「想」一次，三条各带 1.5 秒思考，总时长翻倍，
        //     对方那边早就以为卡死了。
        //
        // 而**下一轮**对话是另一回事：那是新的一次思考，
        // 该重新付「想」的成本 —— 所以 thinkingBase 只在每轮的第一条里。
        // ══════════════════════════════════════════════════════
        const firstFull = typingDelayMs(list[0], model)
        let planned = firstFull
        // 这条回复前面已经走过连发合并窗口：那段空窗期就是“看到消息、等对方说完、
        // 想了一下”的时间，不能再在发送前加一遍打字机基础等待，否则两段相加。
        if (input.noFirstDelay === true) planned = 0
        // 模型已经想了多久。超出一条打字时间的部分，说明它还在想 ——
        // 那部分时间不该算进「打」里，扣掉就行。
        if (spent > 0 && planned > 0) {
          const saved = Math.min(spent, planned)
          this.savedMs += saved
          planned -= saved
        }
        if (crowded) planned = Math.min(planned, TYPING.crowdedCapSec * 1000)
        planned = overloaded ? 0 : Math.max(0, planned, floor)
        if (planned > 0) {
          await this.sleep(planned)
          waited += planned
        }
        this.lastWaitMs = waited

        for (let i = 0; i < list.length; i += 1) {
          if (i > 0) {
            // 段间的缝：自己拆的段像「打完一条又想了一下」，机器切的短一点
            let gap = Math.max(partGapMs(this.random(), { selfSplit: input.selfSplit === true }), floor)
            // 后面有人等时，段间的「想一想」也收一收：一次刷三条本来就够显眼了
            if (crowded) gap = Math.min(gap, TYPING.partGapMs[0])
            if (gap > 0) {
              await this.sleep(gap)
              waited += gap
            }
            // 再加上这条**自己**的打字时间 —— 只有「打」，没有「想」。
            //
            // 不加的话，三条分条会在一两秒内齐发，看起来像程序一次性吐出来的；
            // 加了之后间隔随字数变化：短的接得快，长的接得慢 ——
            // 那正是真人在群里的节奏。
            let wait = typingOnlyMs(list[i], model)
            if (crowded) wait = Math.min(wait, TYPING.crowdedCapSec * 1000)
            wait = overloaded ? 0 : Math.max(0, wait)
            // 总量封顶：这一整条回复（所有分条加起来）不能等太久。
            // 剩下的额度按比例分给还没发的条 —— 早发的条优先拿够，
            // 后面的少等一点，但仍然比「齐发」慢。
            const budget = Math.max(0, TYPING.totalWaitCapSec * 1000 - waited)
            if (wait > budget) {
              const remaining = list.length - i
              // 剩下的条平分剩下的额度
              wait = remaining > 0 ? Math.floor(budget / remaining) : 0
            }
            if (wait > 0) {
              await this.sleep(wait)
              waited += wait
            }
          }
          await say(list[i], i)
          lines += 1
          this.typed += 1
        }
        return { ok: true, lines, waitedMs: waited, overloaded }
      } catch (error) {
        return { ok: false, lines, waitedMs: waited, overloaded, error: String(error?.message || error) }
      } finally {
        this.waiting -= 1
      }
    })
  }

  /** 手感参数：抖动每次现算，其余走常量（可在构造时覆盖） */
  #model() {
    const [lo, hi] = TYPING.jitterSec
    const jitterSec = lo + this.random() * (hi - lo)
    return { ...this.options, jitterMs: jitterSec * 1000 }
  }
}
