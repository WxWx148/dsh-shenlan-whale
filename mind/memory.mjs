/**
 * mind/memory.mjs — 深蓝鲸的本地长期记忆（版权：用户）
 * ============================================================================
 * 只做三件事：记住事实、记住人、按当前对话取一小段。
 *   - 不自动猜，不把整段聊天塞进去；
 *   - 所有内容只在本机 ~/.dsh/shenlan-whale/memory.json；
 *   - 读坏文件不炸插件，回退空记忆。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const EMPTY = { facts: [], people: {}, groups: {}, self: [], updatedAt: 0 }

/** 会往记忆里写东西的公开方法。关掉「长期记忆」时统一挡在这儿 */
const MEMORY_WRITES = Object.freeze([
  'rememberFact', 'forgetFact', 'clearFacts',
  'rememberGroup', 'rememberPerson', 'forgetGroup', 'forgetPerson',
  'rememberSelf', 'forgetSelf', 'updateSelf', 'updateFact', 'updatePerson', 'updateGroup',
])

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'“”‘’()（）【】\[\]-]/g, '')
}

function brief(value, max = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** 中文用相邻二字估算相关度，避免只靠“包含整句”导致旧记忆永远取不到 */
function grams(text) {
  const value = normalize(text)
  const out = []
  for (let i = 0; i < value.length - 1; i += 1) out.push(value.slice(i, i + 2))
  return out
}

function overlap(a, b) {
  const left = new Set(grams(a))
  let hits = 0
  for (const token of new Set(grams(b))) if (left.has(token)) hits += 1
  return hits
}

/** 已经算好二元组的两条，直接比 —— 给 digest 的热路径用，不再重复归一化 */
function overlapGrams(left, right) {
  if (!left || !right) return 0
  let hits = 0
  for (const token of right) if (left.has(token)) hits += 1
  return hits
}

/**
 * 反义对：同一个话题上说反话，就应当认为旧事实过期。
 *
 * 为什么必须有：事实是长期累积的，而人的口味会变。
 * 两条相反的记录同时被挑进上下文，模型会当场精分（「你喜欢苹果」+「你讨厌苹果」）。
 * 这里刻意只认「明确的反义对」，不做语义推理 —— 猜错一次就会把用户真说过的话删掉。
 */
const OPPOSITES = Object.freeze([
  ['喜欢', '讨厌'], ['爱吃', '不爱吃'], ['擅长', '不擅长'], ['习惯', '不习惯'],
  ['同意', '反对'], ['打算', '不打算'], ['爱', '恨'],
  ['会', '不会'], ['能', '不能'], ['是', '不是'], ['想', '不想'], ['有', '没有'],
])

/** 反义词按长度倒序，长的先抹 —— 否则抹掉「爱吃」会留下半个「不」 */
const OPPOSITE_WORDS = Object.freeze(
  [...new Set([
    ...OPPOSITES.flat(),
    // 「不喜欢」也要抹掉，否则态度词会漏进 residual，两句话永远对不上
    ...OPPOSITES.filter(([, neg]) => !neg.startsWith('不')).map(([pos]) => `不${pos}`),
  ])].sort((a, b) => b.length - a.length),
)

/**
 * 先过一道闸：整句话里一个态度词都没有，就不必逐对去问。
 *
 * 为什么值得单独一条正则：判断一次冲突要过 12 组反义对、最多 36 次 `includes`，
 * 而每次 rememberFact 都要拿新话去扫**全部**历史事实（上限 8000 条）。
 * 绝大多数事实是「今天做了点杂事」这种没有态度的句子，
 * 一道正则就能把这 36 次字符串查找省掉。
 */
const POLARITY_RE = new RegExp(OPPOSITE_WORDS.join('|'))

/**
 * 一句话在每一组反义对上的态度：'pos' / 'neg' / ''（没表态）。
 *
 * 为什么必须先判否定式：中文的否定式**包含**肯定式 —— 「不爱吃」里有「爱吃」，
 * 「不会」里有「会」，「没有」里有「有」。早先的写法是
 * `left.includes(one) && !left.includes(other)`，靠「左边有没有否定式」来排除，
 * 可否定式恰恰是**右边**那句话里的形态：新话「不爱吃辣」既 includes「不爱吃」
 * 也 includes「爱吃」，于是 forward 分支被自己的 `!right.includes(one)` 判死。
 * 结果是这个功能只在「爱 → 恨」这种长短不交叉的词上生效，
 * 而最常见的「爱吃辣 → 不爱吃辣」一条都抓不到。
 */
function polarityOf(text) {
  if (!POLARITY_RE.test(text)) return null
  for (const [pos, neg] of OPPOSITES) {
    // 否定式有两种写法：专门的 antonym（爱/恨）和「不 + 肯定式」（喜欢/不喜欢）。
    // 只认 antonym 会漏掉后者 —— 而日常说话里「我现在不喜欢咖啡了」远比「我讨厌咖啡」常见。
    // 否定式必须先匹配：它包含肯定式（不爱吃 ⊃ 爱吃）。
    if (text.includes(neg)) return { pair: `${pos}|${neg}`, side: 'neg' }
    if (!neg.startsWith('不') && text.includes(`不${pos}`)) return { pair: `${pos}|${neg}`, side: 'neg' }
    if (text.includes(pos)) return { pair: `${pos}|${neg}`, side: 'pos' }
  }
  return null
}

/** 去掉态度词之后剩下的「在说什么」 */
function residualOf(text) {
  let out = text
  for (const word of OPPOSITE_WORDS) out = out.split(word).join('')
  return out
}

/**
 * 两句话是否在说同一件事、且态度相反。
 *
 * 判定分两步，顺序不能换：
 *   1. 两边都要对**同一组**反义对表过态，而且态度相反；
 *   2. 把态度词抹掉之后，剩下的内容要是同一件事 —— 完全一样、一句比另一句多说了点，
 *      或者二元组重合度 ≥ 0.7。
 *
 * 第 2 步为什么不用早先的「全句重合 ≥ 0.5」：短句里改一个态度词就换掉一半的二元组，
 * 「主人爱猫」/「主人恨猫」只有 1/3 重合，于是最先该抓到的那种改口反而漏掉。
 * 也不能放得太松：「爱吃辣」和「不爱吃甜」抹掉态度词后是「主人辣」「主人甜」，
 * 重合 0.5，判成冲突就会把用户真说过的「爱吃辣」顶掉。0.7 这条线刚好隔开这两种。
 */
function contradicts(oldText, freshText) {
  const left = normalize(oldText)
  const right = normalize(freshText)
  if (!left || !right) return false
  const a = polarityOf(left)
  const b = polarityOf(right)
  // 没表态、或不是同一组反义对（「爱」对「不会」）、或态度一样 —— 都不算改口
  if (!a || !b || a.pair !== b.pair || a.side === b.side) return false

  const leftRest = residualOf(left)
  const rightRest = residualOf(right)
  // 「喜欢」对「讨厌」这种只表了态、没有内容的：态度相反就算改口
  if (!leftRest || !rightRest) return leftRest === rightRest
  if (leftRest === rightRest) return true
  if (leftRest.includes(rightRest) || rightRest.includes(leftRest)) return true

  const leftGrams = new Set(grams(leftRest))
  const rightGrams = new Set(grams(rightRest))
  let hits = 0
  for (const token of rightGrams) if (leftGrams.has(token)) hits += 1
  return hits / Math.max(1, Math.min(leftGrams.size, rightGrams.size)) >= 0.7
}

export class WhaleMemory {
  constructor(options = {}) {
    this.dir = String(options.dir || '.')
    this.file = path.join(this.dir, 'memory.json')
    this.now = options.now || (() => Date.now())
    // 「长期记忆」开关。以前面板上这一项只有提示词文案和技能声明在读，
    // 真正往上下文里塞记忆、往文件里记事实的代码根本没判它 —— 关掉等于没关。
    // 读写都收到这一层，省得 turn.mjs / tools.mjs 十几个调用点各判一次还漏。
    this.enabled = options.enabled !== false
    this.maxEntries = Math.max(100, Math.min(100_000, Number(options.maxEntries) || 8000))
    this.summaryEvery = Math.max(20, Math.min(2000, Number(options.summaryEvery) || 200))
    this.netEntries = Math.max(1, Math.min(6, Number(options.netEntries) || 2))
    this.netHops = Math.max(1, Math.min(12, Number(options.netHops) || 6))
    this.netDecay = Math.max(0.5, Math.min(1, Number(options.netDecay) || 0.82))
    /**
     * 「被挑进上下文」的次数（hits）落盘节流。
     *
     * 为什么需要节流：digest() 每条消息都要跑一次，而它会给被选中的几条事实 +1 hits。
     * 早先是每次 digest 都 `#save()` —— 整份 memory.json（2000 条时约 300 KB）
     * 同步重写一遍。聊十句就写十遍，写的全是同几个加一。
     * 现在最多每 hitsSaveEveryMs 落一次盘；hits 只是排序权重，丢几条不影响正确性，
     * 而代价是每条消息少一次几百 KB 的同步写。退出前 close() 会补一次。
     */
    this.hitsSaveEveryMs = Math.max(0, Number(options.hitsSaveEveryMs) || 30_000)
    this.hitsSaveAt = 0
    this.hitsDirty = false
    /** id → { text, key, tokenSet }：digest 的热路径缓存，见 #tokenOf */
    this.gramCache = new Map()
    this.data = this.#load()

    // 关掉开关时，所有写入统一在这里挡住。包一层而不是给十几个方法各加一行：
    // 以后新增 remember* 只要还在下面这张表里，就不会变成「关了还在记」。
    for (const name of MEMORY_WRITES) {
      const original = this[name].bind(this)
      this[name] = (...args) => (this.enabled === false
        ? { ok: false, error: '长期记忆关着，没记住', disabled: true }
        : original(...args))
    }
  }

  #load() {
    try {
      if (!existsSync(this.file)) return { ...EMPTY, facts: [], people: {}, groups: {} }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      return {
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        people: parsed.people && typeof parsed.people === 'object' ? parsed.people : {},
        groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
        self: Array.isArray(parsed.self) ? parsed.self : [],
        updatedAt: Number(parsed.updatedAt) || 0,
      }
    } catch {
      return { ...EMPTY, facts: [], people: {}, groups: {} }
    }
  }

  /**
   * 一条事实的归一化文本与二元组（带缓存）。
   * 缓存键是 id，值里带原文：正文被改写（updateFact）时原文对不上就重算。
   */
  #tokenOf(item) {
    const id = String(item?.id || '')
    const text = String(item?.text || '')
    const hit = id ? this.gramCache.get(id) : null
    if (hit && hit.text === text) return hit
    const key = normalize(text)
    const value = { text, key, tokenSet: new Set(grams(key)) }
    if (id) {
      // 上限给得比事实条数宽松一截；超了就整份丢掉重建 —— 这层缓存只为了少做重复计算，
      // 不值得为它写一套淘汰算法（清空之后下一次 digest 会自动补回来）。
      if (this.gramCache.size > this.maxEntries * 2) this.gramCache.clear()
      this.gramCache.set(id, value)
    }
    return value
  }

  /**
   * hits 的节流落盘：距上次写盘不足窗口就攒着，到点一次写完。
   * 窗口内的增量只活在内存里 —— hits 是排序权重，重启丢掉几次不影响任何判断。
   */
  #saveHits(at) {
    if (this.hitsSaveEveryMs > 0 && at - this.hitsSaveAt < this.hitsSaveEveryMs) return { ok: true, throttled: true }
    this.hitsSaveAt = at
    this.hitsDirty = false
    return this.#save()
  }

  /** 退出前把攒着的 hits 补写一次。不写也只是权重差几次，不会丢内容 */
  close() {
    if (!this.hitsDirty) return { ok: true, skipped: true }
    this.hitsDirty = false
    return this.#save()
  }

  #save() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      this.data.updatedAt = this.now()
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      renameSync(tmp, this.file)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  /**
   * 面板改了记忆参数之后重新装配。
   *
   * 这几个值原先只在构造时读一次，于是「面板上改了、保存成功、行为不变」——
   * 用户看到的是「保存了没用」，而重启一次又好了，最难查的那种。
   * 钳位和构造时保持同一套，别让面板能设出构造时禁止的值。
   */
  configure(config = {}) {
    const memory = config.memory || {}
    const net = memory.net || {}
    // 开关跟着面板走：改完下一条消息就不再注入 / 写入记忆，不用重启。
    this.enabled = memory.enabled !== false
    this.maxEntries = Math.max(100, Math.min(100_000, Number(memory.maxEntries) || this.maxEntries))
    this.summaryEvery = Math.max(20, Math.min(2000, Number(memory.summaryEvery) || this.summaryEvery))
    this.netEntries = Math.max(1, Math.min(6, Number(net.entries) || this.netEntries))
    this.netHops = Math.max(1, Math.min(12, Number(net.hops) || this.netHops))
    this.netDecay = Math.max(0.5, Math.min(1, Number(net.decay) || this.netDecay))
    return { maxEntries: this.maxEntries, summaryEvery: this.summaryEvery, netEntries: this.netEntries, netHops: this.netHops, netDecay: this.netDecay }
  }

  facts() {
    return Array.isArray(this.data.facts) ? this.data.facts : []
  }

  rememberFact(text, meta = {}) {
    const body = brief(text, 300)
    if (!body) return { ok: false, error: '空内容' }
    const key = normalize(body)
    const existing = this.facts().find((item) => normalize(item.text) === key)
    if (existing) {
      existing.at = this.now()
      existing.hits = (Number(existing.hits) || 1) + 1
      this.#save()
      return { ok: true, duplicated: true, item: existing }
    }
    // 同一个人改口：旧事实退场，不并存。
    // 标 supersededAt 而不是删掉 —— 「以前喜欢、现在讨厌」本身就是信息，
    // 而且误判时还能还原。
    const stale = this.facts().filter((entry) => !entry.supersededAt && contradicts(entry.text, body))
    for (const entry of stale) {
      entry.supersededAt = this.now()
      entry.supersededBy = body.slice(0, 120)
    }
    const item = { id: `F-${this.now().toString(36)}`, text: body, at: this.now(), hits: 1, source: brief(meta.source, 80) }
    this.data.facts.push(item)
    // 只在真的超了才裁：`slice(-8000)` 对 2000 条的数组也会整份复制一遍，
    // 而这条路径每记一条事实就走一次。上限之内一个元素都不必动。
    if (this.data.facts.length > this.maxEntries) this.data.facts = this.data.facts.slice(-this.maxEntries)
    if (this.data.facts.length % this.summaryEvery === 0) {
      const chunk = this.data.facts.slice(-this.summaryEvery)
      this.data.summaries = Array.isArray(this.data.summaries) ? this.data.summaries : []
      this.data.summaries.push({ at: this.now(), text: chunk.map((item) => item.text).join('；').slice(0, 2000) })
      this.data.summaries = this.data.summaries.slice(-20)
    }
    this.#save()
    return { ok: true, item }
  }

  forgetFact(target) {
    const key = String(target || '').trim()
    // 空键必须在这里挡住：下面用的是 `includes(normalize(key))`，
    // 而任何字符串都 includes('') —— 放过去就不是「没找到一条」，
    // 而是把整本事实清空。面板漏传一个字段就能触发，代价是全部记忆。
    if (!normalize(key)) return { ok: false, error: '没说要忘哪条' }
    const before = this.facts()
    const next = before.filter((item) => item.id !== key && !normalize(item.text).includes(normalize(key)))
    if (next.length === before.length) return { ok: false, error: '没找到' }
    this.data.facts = next
    this.#save()
    return { ok: true, removed: before.length - next.length }
  }

  clearFacts() {
    const count = this.facts().length
    this.data.facts = []
    this.#save()
    return { ok: true, removed: count }
  }

  person(uin) {
    return this.data.people[String(uin || '')] || null
  }

  group(groupId) {
    return this.data.groups[String(groupId || '')] || null
  }

  /** 每个群只留最近 5 个话题，重启后仍能知道这里聊过什么 */
  rememberGroup(groupId, patch = {}) {
    const id = String(groupId || '').replace(/\D/g, '')
    if (!id) return { ok: false, error: '没有群号' }
    const entry = this.data.groups[id] || { groupId: id, label: '', topics: [], lastAt: 0 }
    if (patch.label) entry.label = brief(patch.label, 40)
    const topic = brief(patch.topic, 120)
    if (topic && !entry.topics.some((item) => normalize(item) === normalize(topic))) entry.topics.push(topic)
    entry.topics = entry.topics.slice(-5)
    entry.lastAt = this.now()
    this.data.groups[id] = entry
    this.#save()
    return { ok: true, group: entry }
  }

  rememberPerson(uin, patch = {}) {
    const id = String(uin || '').replace(/\D/g, '')
    if (!id) return { ok: false, error: '没有 QQ 号' }
    const person = this.data.people[id] || { uin: id, name: '', notes: [], impression: '', lastAt: 0 }
    if (patch.name) person.name = brief(patch.name, 40)
    if (patch.impression) person.impression = brief(patch.impression, 120)
    if (patch.note) {
      const note = brief(patch.note, 160)
      if (note && !person.notes.some((item) => normalize(item) === normalize(note))) person.notes.push(note)
      person.notes = person.notes.slice(-20)
    }
    person.lastAt = this.now()
    this.data.people[id] = person
    this.#save()
    return { ok: true, person }
  }

  /** 给提示词用：只取少量事实和当前这个人 */
  digest(options = {}) {
    // 关着就返回一份空快照。已有记忆不删 —— 重新打开还要能接着用。
    if (this.enabled === false) {
      return { facts: [], summary: '', network: [], related: [], self: [], person: null, group: null }
    }
    const query = normalize(options.query)
    const now = Number(options.at) || this.now()
    const queryGrams = query ? new Set(grams(query)) : null
    // 归一化文本与二元组只算一次。
    // 早先在邻居筛选的内层循环里现算 `overlap(normalize(item.text), row.item.text)`，
    // 于是「每一跳 × 每个前沿 × 每一条事实」都要跑两遍正则归一化：
    // 2000 条事实、6 跳的时候，一次 digest 实测 994 ms —— 而它每条消息都要跑一次，
    // 表现就是「发一句话，插件卡住一秒」。同样的结果，把归一化搬到循环外就够了。
    const all = this.facts().filter((item) => !item.supersededAt).map((item) => {
      // 归一化 + 二元组按条目缓存：事实的正文几乎不变，而 digest 每条消息都要跑一遍。
      // 2000 条事实时，光这一步（正则替换 + 建 Set）就占掉一次 digest 的大头。
      const token = this.#tokenOf(item)
      const related = query ? overlapGrams(queryGrams, token.tokenSet) : 0
      const exact = query && (token.key.includes(query) || query.includes(token.key)) ? 12 : 0
      const ageDays = Math.max(0, now - (Number(item.at) || now)) / 86_400_000
      const recency = 2 / (1 + ageDays / 7)
      const hits = Math.min(8, Number(item.hits) || 1) * 0.6
      return { item, key: token.key, tokenSet: token.tokenSet, score: related * 2 + exact + recency + hits }
    })
    const ordered = all.filter((row) => (query ? row.score > 1 : true)).sort((a, b) => b.score - a.score)
    // 取哪 6 条看相关度，但**排出来的顺序**必须稳定：按分数排会让同一批事实
    // 每轮换个位置，提示词前缀跟着变，缓存一次都命中不了。
    const picked = ordered.slice(0, 6).map((row) => row.item).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const network = []
    const seen = new Set(picked.map((item) => item.id))
    let frontier = ordered.slice(0, this.netEntries).map((row) => row)
    let weight = 1
    for (let hop = 0; hop < this.netHops && frontier.length; hop += 1) {
      weight *= this.netDecay
      const next = []
      for (const node of frontier) {
        const neighbors = all
          .filter((row) => !seen.has(row.item.id) && overlapGrams(node.tokenSet, row.tokenSet) > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, this.netEntries)
        for (const row of neighbors) {
          seen.add(row.item.id)
          network.push({ ...row.item, score: weight })
          next.push(row)
        }
      }
      frontier = next
    }
    if (picked.length) {
      for (const item of picked) item.hits = (Number(item.hits) || 1) + 1
      this.hitsDirty = true
      this.#saveHits(now)
    }
    const related = all
      .filter((row) => !picked.includes(row.item))
      .filter((row) => (query ? overlapGrams(queryGrams, row.tokenSet) > 0 : false))
      .slice(0, 3)
      .map((row) => row.item)
    const person = options.forUser ? this.person(options.forUser) : null
    return {
      facts: picked,
      summary: Array.isArray(this.data.summaries) && this.data.summaries.length ? this.data.summaries[this.data.summaries.length - 1].text : '',
      network: network.slice(0, 12),
      related,
      self: this.selfNotes(),
      person: person ? { ...person, notes: [...(person.notes || [])].slice(-6) } : null,
      group: options.groupId ? this.group(options.groupId) : null,
    }
  }

  /** 用已有群事件回填群快照（只补 topic，不碰事实/人物） */
  backfillGroups(eventsFile) {
    try {
      if (!existsSync(eventsFile)) return { changed: 0 }
      const rows = readFileSync(eventsFile, 'utf8').split('\n')
      let changed = 0
      for (const line of rows) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line)
          const groupId = String(row?.group || row?.payload?.groupId || '').replace(/\D/g, '')
          if (row?.scope !== 'group' || !groupId || !row?.text) continue
          const entry = this.data.groups[groupId] || { groupId, label: '', topics: [], lastAt: 0 }
          if (!entry.topics.includes(row.text)) {
            entry.topics.push(row.text)
            entry.topics = entry.topics.slice(-5)
            entry.lastAt = Math.max(Number(entry.lastAt) || 0, Number(row.at) || 0)
            this.data.groups[groupId] = entry
            changed += 1
          }
        } catch {}
      }
      if (changed) this.#save()
      return { changed }
    } catch {
      return { changed: 0 }
    }
  }

  selfNotes() {
    return (this.data.self || []).slice(-12)
  }

  rememberSelf(text) {
    const value = brief(text, 160)
    if (!value) return { ok: false, error: '内容是空的' }
    if (!this.data.self) this.data.self = []
    if (!this.data.self.some((item) => normalize(item.text) === normalize(value))) {
      this.data.self.push({ text: value, at: this.now() })
      this.data.self = this.data.self.slice(-40)
      this.#save()
    }
    return { ok: true, text: value }
  }

  forgetSelf(text) {
    const before = this.data.self?.length || 0
    this.data.self = (this.data.self || []).filter((item) => normalize(item.text) !== normalize(text))
    if (this.data.self.length !== before) this.#save()
    return { ok: before !== this.data.self.length }
  }

  updateSelf(oldText, newText) {
    const item = (this.data.self || []).find((row) => normalize(row.text) === normalize(oldText))
    if (!item) return { ok: false, error: '没有这条自我记忆' }
    item.text = brief(newText, 160)
    item.at = this.now()
    this.#save()
    return { ok: true, text: item.text }
  }

  updateFact(oldText, newText) {
    const item = this.data.facts.find((row) => normalize(row.text) === normalize(oldText))
    if (!item) return { ok: false, error: '没有这条事实' }
    const text = brief(newText, 160)
    if (!text) return { ok: false, error: '不能改成空的' }
    item.text = text
    item.at = this.now()
    this.#save()
    return { ok: true, text }
  }

  updatePerson(uin, patch = {}) {
    const id = String(uin || '').replace(/\D/g, '')
    const person = this.data.people[id]
    if (!id || !person) return { ok: false, error: '没有这个人' }
    if (patch.name) person.name = brief(patch.name, 40)
    if (patch.impression) person.impression = brief(patch.impression, 120)
    if (patch.note) {
      const note = brief(patch.note, 160)
      if (note) person.notes = [...(person.notes || []), note].slice(-20)
    }
    person.lastAt = this.now()
    this.#save()
    return { ok: true, person }
  }

  updateGroup(groupId, patch = {}) {
    const id = String(groupId || '').replace(/\D/g, '')
    const entry = this.data.groups[id]
    if (!id || !entry) return { ok: false, error: '没有这个群' }
    if (patch.label) entry.label = brief(patch.label, 40)
    if (patch.topic) entry.topics = [...(entry.topics || []), brief(patch.topic, 120)].slice(-5)
    entry.lastAt = this.now()
    this.#save()
    return { ok: true, group: entry }
  }

  forgetPerson(uin) {
    const id = String(uin || '').replace(/\D/g, '')
    if (!id || !this.data.people[id]) return { ok: false, error: '没有这个人' }
    delete this.data.people[id]
    this.#save()
    return { ok: true, removed: id }
  }

  forgetGroup(groupId) {
    const id = String(groupId || '').replace(/\D/g, '')
    if (!id || !this.data.groups[id]) return { ok: false, error: '没有这个群' }
    delete this.data.groups[id]
    this.#save()
    return { ok: true, removed: id }
  }

  stats() {
    return { facts: this.facts().length, people: Object.keys(this.data.people || {}).length, groups: Object.keys(this.data.groups || {}).length, updatedAt: this.data.updatedAt || 0 }
  }
}

/** 主人私聊里的记忆命令；识别就返回要直接发的话，不经过模型 */
export function memoryCommand(text, memory) {
  if (!memory) return null
  const body = String(text || '').trim()
  if (!body) return null
  if (/^(记住|请记住)(了)?[，,：:]?/.test(body)) {
    const fact = body.replace(/^(记住|请记住)(了)?[，,：:]?\s*/, '')
    if (!fact) return { text: '要记什么？' }
    memory.rememberFact(fact, { source: 'owner' })
    return { text: '记住了：' + fact.slice(0, 80) }
  }
  if (/^(忘记一切|清空记忆)/.test(body)) {
    const result = memory.clearFacts()
    return { text: result.removed ? `清掉了 ${result.removed} 条事实记忆。` : '现在没有事实记忆。' }
  }
  if (/^(忘掉|忘记)[，,：:]?\s*(.+)$/.test(body)) {
    const target = body.replace(/^(忘掉|忘记)[，,：:]?\s*/, '')
    const result = memory.forgetFact(target)
    return { text: result.ok ? `忘了：${target.slice(0, 60)}` : '没找到这条记忆。' }
  }
  if (/^(你记得|记得什么|记忆|你都记得)/.test(body)) {
    const facts = memory.facts().slice(-8)
    const people = Object.values(memory.data.people || {}).slice(-5)
    const lines = []
    if (facts.length) lines.push('事实：', ...facts.map((item) => `- ${item.text}`))
    if (people.length) lines.push('人物：', ...people.map((item) => `- ${item.name || item.uin}`))
    return { text: lines.length ? lines.join('\n').slice(0, 900) : '记忆还是空的。' }
  }
  return null
}
