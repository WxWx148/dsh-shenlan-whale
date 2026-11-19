/**
 * decide/dedupe.mjs — 出口去重：同一件事，不发第二遍。
 *
 * ══════════════════════════════════════════════════════════════
 * 【为什么要有这一层】
 *
 *   风控最敏感的行为特征之一是「复读」：
 *   同样的内容在短时间内出现两次，在真人里几乎不可能，在机器人里是常态。
 *   两种来源：
 *     1. 掉线补回 —— 协议端重连后把刚才那条再投一次，回复又发一遍；
 *     2. 模型重复 —— 同一轮里两次生成出几乎一样的话，两条都发出去。
 *
 *   参考实现（deepseek_QQFish_Service）用两级去重：
 *     · 内容级 120 秒：同一会话里，同样的内容不重复发；
 *     · 消息级 300 秒：同一条对方消息，不重复回复。
 *
 * ══════════════════════════════════════════════════════════════
 * 【这里跟参考实现不一样，而且是有意的】
 *
 *   参考实现的内容级去重是「同一会话 120 秒内同样内容不重复发」。
 *   本实现**不这么干**，原因只有一个：**会伤到拟人感**。
 *
 *   设想这一句：
 *     主人：「这个功能怎么开」
 *     深蓝：「面板第三层，展开就能看到」
 *     主人：「再说一遍，刚才没看清」   ← 主人没看清，要求重说
 *     深蓝：（应该再说一遍）
 *
 *   按参考实现的口径，第二句和第四句内容一样、间隔不到 120 秒 → 第四句被**静默吞掉**。
 *   主人的体感是「它不理我了 / 它坏了」，而不是「它复读了」。
 *   **静默吞掉一个正常回答，比复读难看得多** —— 复读是有点机械，
 *   而不回应是直接失功能。
 *
 *   更要命的是它拦错了东西。**「复读」的定义是「紧接着又说」**，
 *   特征在**时间邻近**，不在内容相等：
 *     · 真人：一句话说完，隔了十分钟又说一遍 —— 正常得很，还挺像人；
 *     · 机器人：同一句在 1 秒内弹两遍 —— 这才是风控要抓的。
 *
 *   打字台（voice/typing.mjs）给分条之间留 0.5~1.4 秒的缝，
 *   所以「一条回复分成三条陆续发」本来就有间隔 ——
 *   而那恰恰是**最像人的**发话方式：想说的分两三条发，一条一行。
 *   那种情况下拦内容，就是在把拟人感剪掉。
 *
 *   所以本实现的口径是：
 *     · **消息级**（同一条对方消息不回两遍）→ 保留。这是真复读，无误伤。
 *       主人在私聊里问两遍同样的问题，是**两条不同的消息**，走不到这里。
 *     · **内容级** → **按时间邻近度**判，不按内容相等。
 *       只有「同一会话内、间隔很短、且说的是同一句」才算复读。
 *       隔久了再说同一句 → 放行。
 *
 *   那「主人再问一遍、深蓝再答一遍」怎么算？
 *   它跨轮次、且间隔通常超过邻近窗口 → 放行。
 *   真要更严一点，还有**注意力窗口**在管「该不该接话」，
 *   那是决策层的事，不该由出口层用「静默丢弃」来管。
 * ══════════════════════════════════════════════════════════════
 *
 * 三条硬规矩：
 *   1. **只拦重复，不拦正常**：短文本不拦 —— 「嗯」「好」重复是正常对话；
 *   2. **拦了要说清**：跳过时返回原因，让上层能留痕，而不是静默吞掉；
 *   3. **状态在内存**：重启清零可接受 —— 去重看的是秒级到分钟级窗口，
 *      重启本身已经打断了节奏，写盘反而让「重启绕过去重」变得容易。
 */

/**
 * 内容邻近窗口：**八秒**。
 *
 * 为什么是八秒，不是参考实现的两分钟：
 *   · 打字台分条间隔 0.5~1.4 秒 —— 同一句在 8 秒内弹两遍 = 真复读；
 *   · 真人隔 8 秒以上再说同一句 = 正常对话（尤其主人让他重说一遍）；
 *   · 窗口必须**小于**人的反应间隔，否则会拦到正常回答。
 *
 * 8 秒这个数是按「人看完一条消息、决定再说一遍、再打字」的最快速度定的：
 * 超过 8 秒说明中间有人的动作，那就不该拦。
 */
export const DUP_TEXT_MS = 8_000

/** 消息去重窗口：五分钟。同一条消息五分钟内不该回两遍 */
export const DUP_MSG_MS = 300_000

/**
 * 邻近窗口里也算「短」的门槛。
 *
 * 中文一句完整的话常在 4 字以上（「我看看啊」「马上就好」「行不行」）。
 * 用英文单词数的直觉（8 字）会把一半真复读漏掉。
 */
const MIN_DEDUPE_CHARS = 4

/** 最多记多少条（防内存涨） */
const MAX_ENTRIES = 400

/** 归一化：空白与标点差异不算内容差异 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/\s+/g, '')
    .replace(/[，。！？、,.!?~～…—；;：:]/g, '')
    .trim()
}

/**
 * 两段文本是不是「同一句话」的两种写法。
 *
 * 为什么要认包含关系：模型偶尔会说
 *   「好的，我去查一下」 和  「好的，我去查一下，稍等」
 * 去掉标点后一个是另一个的前缀 —— 这是同一句话在长程度上有差别，
 * 属于复读，不是两句话。真人不会这么发。
 *
 * 门槛 0.6 是**从真实语料量的**，不是拍的：
 *   中文里「同一句的加长版」长度比集中在 0.67 左右
 *   （「你好」→「你好啊」、「二弟」→「二弟好」，实测 163 组包含样本）
 *   而「不同的两句恰好互相包含」长度比普遍 ≤ 0.4
 *   （「来」⊂「你如果撅屁股…」、「6」⊂「[face:264] 老大这是…」）
 *   所以 0.6 能分开这两类：0.67 判同一句，0.4 判不同句。
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function sameUtterance(a, b) {
  const x = normalize(a)
  const y = normalize(b)
  if (!x || !y) return false
  if (x === y) return true
  if (x.length < MIN_DEDUPE_CHARS || y.length < MIN_DEDUPE_CHARS) return false
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  // 包含关系，且长度差不太夸张 —— 否则「我看看」和「我看看这个文件这个 bug」会被误判
  if (long.includes(short) && short.length / long.length >= 0.6) return true
  return false
}

/**
 * 出口去重账本。
 *
 * 两张表：
 *   · texts  —— 会话 + 内容 → 上次发出的时间
 *   · replies —— 会话 + 对方消息 id → 上次回复的时间
 */
export class Dedupe {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.texts = new Map()
    this.replies = new Map()
    this.skipped = 0
  }

  #prune(map, at) {
    const cut = at - DUP_MSG_MS
    // 不能「遇到第一条没过期的就 break」：同一句话被再说一遍时，它的**位置**还在原处，
    // 时间是新的 —— 于是排在最前面的那条永远「没过期」，后面的真的过期条目一辈子清不掉。
    // 表的上限只有 400 条，整表扫一遍的代价远小于「清扫静默失效」。
    for (const [key, at2] of map) {
      if (at2 < cut) map.delete(key)
    }
  }

  /**
   * 这条内容是不是**刚刚**才发过。
   *
   * ⚠️ 口径：**时间邻近**，不是内容相等。
   *   同一会话里、8 秒内、说的是同一句 → 复读，拦。
   *   隔久了再说同一句 → 放行（那是正常对话，比如主人让你重说一遍）。
   *
   * 不给 roundKey 就等于关闭内容去重 —— 这是有意的默认值，
   * 宁可漏拦也不能误伤。
   *
   * @param {string} conversation 会话键（群号/私聊号）
   * @param {string} text 内容
   * @param {string} [roundKey] 本轮生成的标识。不给就不拦内容
   * @returns {{ duplicate: boolean, reason?: string }}
   */
  checkText(conversation, text, roundKey = '') {
    const body = normalize(text)
    // 太短的不拦：「嗯」「好」「收到」重复出现是正常对话，不是风控特征
    if (body.length < MIN_DEDUPE_CHARS) return { duplicate: false }
    // 没有轮次标识 → 不做内容判定（跨轮次场景，一律放行）
    if (!roundKey) return { duplicate: false }
    const at = this.now()
    const prefix = `${conversation || ''}|${roundKey}|`
    // 同一轮里逐条比对：本轮说过的话，一条一条对。
    // 不按内容建索引 —— 那样「隔久了再说同一句」也会被误伤。
    for (const [key, at2] of this.texts) {
      if (!key.startsWith(prefix)) continue
      if (at - at2 >= DUP_TEXT_MS) continue
      const said = key.slice(prefix.length)
      if (sameUtterance(said, body)) {
        return { duplicate: true, reason: `刚刚说过一样的话（${Math.round((at - at2) / 1000)} 秒前）` }
      }
    }
    return { duplicate: false }
  }

  /**
   * 记一次发送。
   *
   * 必须在**真的发出去之后**调，不是之前 —— 先记后发的顺序，
   * 万一发送失败，这条就成了一堵假门：下一条同样的内容会被误拦。
   *
   * @param {string} conversation
   * @param {string} text
   * @param {string} [roundKey] 同 checkText
   */
  noteText(conversation, text, roundKey = '') {
    const body = normalize(text)
    if (body.length < MIN_DEDUPE_CHARS) return
    if (!roundKey) return
    const key = `${conversation || ''}|${roundKey}|${body}`
    this.texts.set(key, this.now())
    this.#prune(this.texts, this.now())
    if (this.texts.size > MAX_ENTRIES) {
      // Map 保持插入序，删掉最早的一条
      const oldest = this.texts.keys().next().value
      if (oldest !== undefined) this.texts.delete(oldest)
    }
  }

  /**
   * 这条对方消息是不是已经回过了。
   *
   * 这一层**不伤拟人感**：真人不会对同一条消息回两遍，
   * 而「主人再问一遍」是**新的消息 id**，走不到这里。
   *
   * @param {string} conversation
   * @param {string} messageId 对方消息 id
   */
  checkMessage(conversation, messageId) {
    const mid = String(messageId || '')
    if (!mid) return { duplicate: false }
    const key = `${conversation || ''}|${mid}`
    const at = this.now()
    const last = this.replies.get(key)
    if (last !== undefined && at - last < DUP_MSG_MS) {
      return { duplicate: true, reason: `这条消息 ${Math.round((at - last) / 1000)} 秒前已经回过了` }
    }
    return { duplicate: false }
  }

  /** 记一次回复 */
  noteMessage(conversation, messageId) {
    const mid = String(messageId || '')
    if (!mid) return
    const key = `${conversation || ''}|${mid}`
    this.replies.set(key, this.now())
    this.#prune(this.replies, this.now())
    if (this.replies.size > MAX_ENTRIES) {
      const oldest = this.replies.keys().next().value
      if (oldest !== undefined) this.replies.delete(oldest)
    }
  }

  /** 拦下了一次：记一笔，面板上要能看见 */
  markSkipped() {
    this.skipped += 1
  }

  /** 面板能直接显示的数字 */
  stats() {
    return {
      trackedTexts: this.texts.size,
      trackedReplies: this.replies.size,
      skipped: this.skipped,
    }
  }
}
