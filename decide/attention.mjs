/**
 * decide/attention.mjs — 群里「现在在跟谁说话」的注意力账本。
 *
 * 群里最难的不是回话，是**知道该不该回、回给谁**。三个真实场景：
 *   1. 刚回过 A，A 接着说 —— 不用再 @ 一次，否则每句都要点人，像客服；
 *   2. 刚回完 A 十秒，B 开口了 —— B 可能是接话，也可能是在跟别人聊，
 *      判错就是「插嘴」，比不回更烦人；
 *   3. 窗口里已经有 A，半天没人再提这茬 —— 窗口必须自己过期，不能永久热着。
 *
 * 所以账本是「会话 → 人 → 到期时间 + 已聊轮数」：
 *   · 命中 = 接着说（不用 @）；
 *   · 换人 = 关掉旧窗口、开新窗口，一次只留一个热目标；
 *   · 轮数到上限 = 关窗，等下一个人 @ 或是别人起新话题。
 *
 * 这里**只记账、只判断**，不发消息也不读日志文件 —— 判定要是纯的，
 * 「为什么这条没接」才能事后回答；把发送混进来，同一个问题会有两种答案。
 */

/** 默认值。窗口长度与轮数上限走配置（group.followUpSeconds / followUpMaxTurns） */
export const ATTENTION = Object.freeze({
  /** 窗口默认 3 分钟。短了接不上话，长了像缠着人 */
  windowSec: 180,
  /** 一次开窗最多聊几轮 */
  maxTurns: 5,
  /** 两句中文的二元组重合率达到这个比例，就算「在接上一句」 */
  overlapRatio: 0.2,
})

/**
 * 两句中文的二元组重合率 —— 「这句是不是在接上一句」的廉价判据。
 *
 * 为什么不用模型：这一步每来一条群消息都要跑，用模型既慢又贵；
 * 而且这里的判断标准要**宽松且稳定**（宁可多接一句，不要漏接），模型反而飘。
 * 真正需要仔细判的只有「换人」那一种情况，那时才值得多花一次调用。
 *
 * @param {string} a
 * @param {string} b
 * @param {number} [ratio]
 * @returns {boolean}
 */
export function textOverlaps(a, b, ratio = ATTENTION.overlapRatio) {
  const norm = (x) => String(x || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '')
  const left = norm(a)
  const right = norm(b)
  // 太短的句子（「好」「嗯」「在」）重合率没有意义：随便两句都能撞上
  if (left.length < 4 || right.length < 4) return false
  const grams = new Set()
  for (let i = 0; i < right.length - 1; i += 1) grams.add(right.slice(i, i + 2))
  let hit = 0
  for (let i = 0; i < left.length - 1; i += 1) {
    if (grams.has(left.slice(i, i + 2))) hit += 1
  }
  return hit / Math.max(1, left.length - 1) >= Math.max(0, Math.min(1, Number(ratio) || 0))
}

/**
 * 这句话有没有对着「你」说。
 *
 * 只有人称，不看内容：群里讨论「你们公司」也算，但那种情况后面还有重合率兜着。
 * 先宽后严比先严后宽好 —— 漏接一句是遗憾，抢话是冒犯。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function addressesSelf(text) {
  return /(你|您)/.test(String(text || ''))
}

/**
 * 注意力账本。
 *
 * 一条纪律：**同一个人在一个会话里只有一个窗口**。重复开窗不累加到期时间之外的东西，
 * 否则「聊得越久窗口越长」，最后变成永远热着 —— 那不是注意力，是粘着。
 */
export class AttentionDesk {
  /**
   * @param {object} input
   * @param {object} [input.config]  读 group.followUpSeconds / group.followUpMaxTurns
   * @param {()=>number} [input.now]
   * @param {(line:string)=>void} [input.log]
   */
  constructor(input = {}) {
    this.config = input.config || {}
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()
    this.log = typeof input.log === 'function' ? input.log : () => {}
    /** conversation → Map<who, { until, turns, max }> */
    this.windows = new Map()
    /** conversation → 最近一次自己说出去的话，换人判定要用 */
    this.lastReply = new Map()
    /** 最近一次换人：面板要能回答「刚才为什么切给了别人」 */
    this.lastHandoff = null
    this.handoffs = 0
  }

  /** 配置热改后跟着变 */
  configure(config = {}) {
    this.config = config
  }

  #windowMs() {
    return Math.max(10, Number(this.config.group?.followUpSeconds) || ATTENTION.windowSec) * 1000
  }

  #maxTurns() {
    return Math.max(1, Number(this.config.group?.followUpMaxTurns) || ATTENTION.maxTurns)
  }

  /**
   * 清掉过期的；避免长跑时账本只增不减。
   *
   * `lastReply` 必须跟着一起清：它只为「换人」判定服务，没有热窗口的会话
   * 就永远不会再被比一次。以前只清窗口，这张表在长跑里只进不出 ——
   * 每个聊过的群都留一条，属于慢性泄漏。
   */
  #prune(at) {
    for (const [key, map] of this.windows) {
      for (const [who, rec] of map) {
        if (at >= rec.until) map.delete(who)
      }
      if (!map.size) {
        this.windows.delete(key)
        this.lastReply.delete(key)
        if (this.lastHandoff && this.lastHandoff.conversation === key) this.lastHandoff = null
      }
    }
  }

  /**
   * 开窗。`reset` 为 true 时把已聊轮数清零（新话题、新目标都该清零）。
   *
   * @param {string} conversation
   * @param {string|number} who
   * @param {boolean} [reset]
   */
  open(conversation, who, reset = true) {
    const key = String(conversation || '')
    const person = String(who || '')
    if (!key || !person) return null
    const at = this.now()
    const map = this.windows.get(key) || new Map()
    const prev = map.get(person)
    const rec = {
      until: at + this.#windowMs(),
      turns: reset ? 0 : (prev?.turns || 0),
      max: this.#maxTurns(),
    }
    map.set(person, rec)
    this.windows.set(key, map)
    this.#prune(at)
    return { ...rec }
  }

  /**
   * 这条窗口有没有命中。
   *
   * 先按人，再按群级 `*`（给「整群都在跟他/她说话」这种场景留的口子，
   * 目前没有地方开，但命中顺序必须稳定，不能等用到时再补）。
   *
   * @param {string} conversation
   * @param {string|number} from
   * @returns {{who:string, rec:object}|null}
   */
  hit(conversation, from) {
    const map = this.windows.get(String(conversation || ''))
    if (!map) return null
    const at = this.now()
    for (const who of [String(from || ''), '*']) {
      const rec = map.get(who)
      if (!rec) continue
      if (at >= rec.until) {
        map.delete(who)
        continue
      }
      return { who, rec }
    }
    if (!map.size) this.windows.delete(String(conversation || ''))
    return null
  }

  /**
   * 又聊了一轮。到上限就关窗 —— 关窗不是惩罚，是「该等下一个人了」。
   *
   * @param {string} conversation
   * @param {string|number} who
   */
  bump(conversation, who) {
    const key = String(conversation || '')
    const map = this.windows.get(key)
    if (!map) return null
    const person = String(who || '')
    const rec = map.get(person) || map.get('*')
    if (!rec) return null
    rec.turns += 1
    rec.until = this.now() + this.#windowMs()
    if (rec.turns >= rec.max) {
      map.delete(map.get(person) ? person : '*')
      this.log(`[attention] ${key} 聊满 ${rec.max} 轮，关窗`)
    }
    return { ...rec }
  }

  /** 关掉某个人的窗口。换人时只关旧目标，别人不受影响 */
  close(conversation, who) {
    const key = String(conversation || '')
    const map = this.windows.get(key)
    if (!map) return false
    const ok = map.delete(String(who || ''))
    if (!map.size) {
      this.windows.delete(key)
      // 窗口关了就没人「接着上一句」了，这句留白只会占内存
      this.lastReply.delete(key)
    }
    return ok
  }

  /**
   * 窗口还热着、但不是当前这个人在说 —— 返回那个人。
   * 换人判定要知道「热的是谁」，否则就变成「谁说话都接着聊」。
   */
  otherTarget(conversation, exceptFrom) {
    const key = String(conversation || '')
    const map = this.windows.get(key)
    if (!map) return null
    const at = this.now()
    for (const [who, rec] of map) {
      if (at >= rec.until) {
        // 顺手清掉：这里以前只 skip，过期项要等到下一次 open/stat 才消失，
        // 结果是「明明没人热着，却一直显示有窗口」
        map.delete(who)
        continue
      }
      if (who === '*') continue
      if (exceptFrom && who === String(exceptFrom)) continue
      return who
    }
    if (!map.size) {
      this.windows.delete(key)
      this.lastReply.delete(key)
    }
    return null
  }

  /**
   * 这条群消息要不要当成「接着说」处理。
   *
   * 两条路径，顺序不能换：
   *   1. 自己的窗口命中 —— 最可靠，直接接；
   *   2. 窗口热着但是别人 —— 先看这句是不是冲自己说的（你/您）或明显在接上一句的话，
   *      成立才「换人」：关旧窗口、开新窗口。**不成立就当没听见**，这条路径不许猜。
   *
   * @param {{conversation:string, from:string|number, text:string}} input
   * @returns {{continue:boolean, handoffFrom:string, why:string}|null}
   */
  consider(input = {}) {
    const key = String(input.conversation || '')
    const who = String(input.from || '')
    if (!key || !who) return null
    const text = String(input.text || '')

    const mine = this.hit(key, who)
    if (mine) {
      return { continue: true, handoffFrom: '', why: mine.who === who ? 'window' : 'group_window' }
    }

    const other = this.otherTarget(key, who)
    if (!other) return null
    const last = String(this.lastReply.get(key) || '')
    if (!addressesSelf(text) && !textOverlaps(text, last)) return null

    return this.handoff({ conversation: key, from: who, other })
  }

  /**
   * 快判据没命中、但旧窗口还热着：这是一次“可能是换人接话”的候选。
   * 调用方可以拿它去问一次小模型；不要在这里直接关旧窗口——
   * 判错就是插嘴，必须等判定回来再动账本。
   */
  candidate(input = {}) {
    const key = String(input.conversation || '')
    const who = String(input.from || '')
    if (!key || !who) return null
    if (this.hit(key, who)) return null
    const other = this.otherTarget(key, who)
    if (!other) return null
    const text = String(input.text || '')
    const lastReply = String(this.lastReply.get(key) || '')
    // 快判据已经能确定的，不浪费模型调用。
    if (addressesSelf(text) || textOverlaps(text, lastReply)) return null
    return { conversation: key, from: who, other, text, lastReply }
  }

  /** 确认换人：关旧窗、开新窗。只有快判据或模型判定通过后才调用。 */
  handoff(input = {}) {
    const key = String(input.conversation || '')
    const who = String(input.from || '')
    const other = String(input.other || '')
    if (!key || !who || !other) return null
    this.close(key, other)
    this.open(key, who)
    this.handoffs += 1
    this.lastHandoff = { conversation: key, from: other, to: who, at: this.now() }
    this.log(`[attention] ${key} 换人接话：${other} → ${who}（旧窗口已关）`)
    return { continue: true, handoffFrom: other, why: 'handoff' }
  }

  /**
   * 自己刚说完一句：记下来（换人判定要拿它比重合），并推进窗口。
   *
   * 只对群生效：私聊没有「在跟谁说话」的问题，一个人就是一个会话。
   *
   * @param {{conversation:string, from:string|number, scope:string, text:string}} input
   */
  noteReply(input = {}) {
    const key = String(input.conversation || '')
    if (!key) return { ok: false, opened: false }
    this.lastReply.set(key, String(input.text || ''))
    if (String(input.scope || '') !== 'group' || !input.from) return { ok: true, opened: false }
    const mine = this.hit(key, input.from)
    if (mine && mine.who === String(input.from)) {
      this.bump(key, mine.who)
      return { ok: true, opened: false }
    }
    this.open(key, input.from)
    return { ok: true, opened: true }
  }

  /** 面板/排障用：几个会话热着、各几个人 */
  stats() {
    const at = this.now()
    this.#prune(at)
    let people = 0
    for (const map of this.windows.values()) people += map.size
    return {
      conversations: this.windows.size,
      people,
      handoffs: this.handoffs,
      windowMs: this.#windowMs(),
      maxTurns: this.#maxTurns(),
      lastHandoff: this.lastHandoff ? { ...this.lastHandoff } : null,
    }
  }

  /**
   * 每个热窗口的现场：谁、第几轮、还剩多久。
   *
   * 面板要回答的是「它现在觉得在跟谁说话」，而不是只给一个数字。
   * 只读快照，不改账本 —— 面板刷新不该影响判定。
   *
   * @returns {{conversation:string, who:string, turns:number, max:number, remainingMs:number}[]}
   */
  snapshot() {
    const at = this.now()
    this.#prune(at)
    const out = []
    for (const [conversation, map] of this.windows) {
      for (const [who, rec] of map) {
        out.push({
          conversation,
          who,
          turns: Number(rec.turns) || 0,
          max: Number(rec.max) || this.#maxTurns(),
          remainingMs: Math.max(0, rec.until - at),
        })
      }
    }
    // 快过期的排后面：面板第一屏应该是最「热」的
    return out.sort((a, b) => b.remainingMs - a.remainingMs)
  }
}
