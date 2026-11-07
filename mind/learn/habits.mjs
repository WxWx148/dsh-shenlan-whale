/**
 * mind/habits.mjs — 从真实聊天里学「大家是怎么说话的」。
 *
 * ══════════════════════════════════════════════════════════════
 * 【这份文件管什么】
 *
 *   人设写的是「我要是什么样」，习惯学的是「这屋里的人实际是怎么说话的」。
 *   两者会打架：人设说「一条一个念头」，但他实际发 14 字、逗号占一半。
 *   靠人设压不住，得靠**数据**。
 *
 *   所以这里做一件事：从群聊记录里量三组人的说话特征，
 *   把自己跟别人的差距算出来，写成一行能直接进提示词的话。
 *
 *   为什么是「算」不是「抄」：
 *     抄一句「别人都这样说话」等于没约束，模型照旧。
 *     「群里别人中位 9 字、你现在 14 字」是一句能被检验的话。
 *
 *   三组分开量，因为它们该学的对象不同：
 *     · others  —— 群里其他人：学「这里的说话密度」
 *     · owner   —— 主人：学「他跟你说话的方式」
 *     · self    —— 他/她自己：量差距（光有目标没用，得知道差多少）
 *
 *   实测（本机 2026-10-26 ~ 11-07，events.jsonl 1368 条带文本消息）：
 *     群-他人  n=569 p25=4 p50=9 p75=13 p90=21 p99=51 ≤6字37% 句尾句号1% 逗号25% 语气词15%
 *     群-自己  n=285 p25=10 p50=14 p75=18 p90=23 p99=34 ≤6字7%  句尾句号1% 逗号52% 语气词35%
 *     私聊-主人 n=205 p25=4 p50=8 p75=15 p90=22 p99=50 ≤6字38% 句尾句号3% 逗号36% 语气词31%
 *
 *   差距看得很清楚，而且**不在「太长」上**：
 *     别人 p99 是 51 字、最长 78 字 —— 人家照样说长话，长短是看语境的。
 *     真正的差别在短的那头：≤6 字的占比别人 37%、自己 7%。
 *   所以要学的是「该短的时候能短下去」，不是「一律压到几个字」。
 *   另外两条：逗号用太多、从不扣问号。
 * ══════════════════════════════════════════════════════════════
 */

import { KIND, kindOf } from '../../facts/index.mjs'

/**
 * 语气词表。
 *
 * 为什么要单列：句尾语气词是「像不像人」最容易被模型学走的一样东西，
 * 但也最容易误伤 —— 「行吧」里的「吧」是真语气，
 * 「酒吧」里的「吧」不是。所以按「出现在句尾或后面跟标点」来判。
 */
const PARTICLES = ['啊', '吧', '呢', '嘛', '呗', '啦', '哦', '哈', '哟', '嗷']

/** 纯问号回复：就一个问号（或几个），什么话都没说 */
const ONLY_QUESTION = /^[？?？\s]+$/u

/** 含问号的短句：问号 + 不超过这么多字 */
const SHORT_QUESTION_MAX = 8

/** 句尾句号（中英文都算） */
const PERIOD_END = /[。.]\s*$/u

/** 样本太少就不给结论 */
const MIN_SAMPLE = 12

/** 习惯行总长上限：这一行是塞进提示词的，不能占地方 */
const GUIDE_BUDGET = 220

/**
 * 量一组消息的说话特征。
 *
 * 这里量的是**分布形状**，不是一个数。
 *
 * 为什么不能拿中位数当目标：真人说话长短看语境 —— 群里别人 p50 是 9 字，
 * 但 p99 是 51 字、最长 78 字，也就是说他们也会说长话。
 * 拿 9 字当硬指标，等于教「每句都得 9 字以内」，那不是像人，是像节拍器。
 *
 * 真正的差距在**短的那一头**：
 *   群-他人 p25=4，≤6 字占 37%
 *   群-自己 p25=10，≤6 字占 7%
 * 也就是说：他/她不怎么说长话，但**太不说短话了**。
 * 学的是这个 —— 该短的时候要短得下去，而不是一律压到某个字数。
 *
 * @param {Array<object>} rows 事件行
 * @returns {object|null} 样本不足返回 null
 */
export function measure(rows) {
  const texts = (rows || [])
    .map((row) => String(row?.text ?? '').trim())
    .filter(Boolean)
  const n = texts.length
  if (!n) return null

  const lengths = texts.map((text) => text.length).sort((a, b) => a - b)
  const median = lengths[Math.floor(n / 2)]
  const percentile = (p) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * p))] || 0
  const count = (test) => texts.filter(test).length

  return {
    samples: n,
    medianChars: median,
    // 分布的两端：短的那头与长的那头
    p25Chars: percentile(0.25),
    p75Chars: percentile(0.75),
    p90Chars: percentile(0.9),
    longShare: count((text) => text.length > 20) / n,
    shortShare: count((text) => text.length <= 6) / n,
    briefShare: count((text) => text.length <= 12) / n,
    periodEndShare: count((text) => PERIOD_END.test(text)) / n,
    commaShare: count((text) => /[，,]/.test(text)) / n,
    particleShare: count((text) => hasParticle(text)) / n,
    questionShare: count((text) => /[？?]/.test(text)) / n,
    onlyQuestion: count((text) => ONLY_QUESTION.test(text)),
    shortQuestion: count((text) => /[？?]/.test(text) && text.length <= SHORT_QUESTION_MAX),
  }
}

/**
 * 有没有句尾语气词。
 *
 * 判「句尾」而不是「出现过」：模型很容易学成满篇「啊」「吧」，
 * 那比不用语气词更假。真人只在句尾带一下。
 *
 * 而且只认**最后一个字**：用 `includes` 判前 3 个字是错的 ——
 * 「酒吧在哪」里有个「吧」，但那不是语气词，是「酒吧」的一部分。
 * 实测踩过：这样判会把「酒吧」「的吧」全算成语气词，
 * 于是「语气词偏多」这条差距指向一个不存在的问题。
 */
export function hasParticle(text) {
  const source = String(text || '').trim()
  if (!source) return false
  const tail = source.slice(-1)
  return PARTICLES.includes(tail)
}

/**
 * 把事件流分成三组。
 *
 * @param {Array<object>} events
 * @param {object} options { ownerId }
 */
export function splitGroups(events, options = {}) {
  const ownerId = String(options.ownerId || '')
  const groups = { others: [], owner: [], self: [] }
  for (const event of events || []) {
    if (kindOf(event) !== KIND.MESSAGE) continue
    const text = String(event?.text ?? event?.payload?.text ?? '').trim()
    if (!text) continue
    const from = String(event?.from ?? '')
    const sender = String(event?.sender ?? '')
    // 「自己」有两种标记：from='self'，以及 sender 是「我」。
    // 之前只认 from='self'，于是漏掉了一批自己的发言，统计出来「自己」比「别人」还少。
    if (from === 'self' || sender === '我') {
      groups.self.push(event)
      continue
    }
    if (ownerId && from === ownerId) {
      groups.owner.push(event)
      continue
    }
    groups.others.push(event)
  }
  return groups
}

/**
 * 算出「差在哪」。
 *
 * 返回的每一项都是**可检验的差距**，不是感想：
 *   { kind: 'too_long', gap: 5, want: 9, now: 14 }
 * 差得不多就不报 —— 差 1 个字报出来是噪音。
 */
export function gaps(mine, theirs) {
  const out = []
  if (!mine || !theirs) return out

  // 短的那头不够短 —— 这是最该学的一条。
  //
  // 为什么不是「太长」：群里别人 p50=9 但 p99=51、最长 78 字，
  // 人家照样说长话。长短看语境，不是看字数上限。
  // 真正的差别在短的那头：
  //   别人 ≤6 字占 37%、p25=4
  //   自己 ≤6 字占 7%、p25=10
  // 也就是说他/她**不怎么说长话，但太不说短话了**。
  // 该学的��是「该短的时候能短下去」。
  if (theirs.shortShare - mine.shortShare >= 0.15) {
    out.push({
      kind: 'not_short_enough',
      gap: Math.round((theirs.shortShare - mine.shortShare) * 100),
      wantShort: theirs.shortShare,
      nowShort: mine.shortShare,
      wantP25: theirs.p25Chars,
      nowP25: mine.p25Chars,
    })
  }
  // 逗号太多：差 15 个百分点以上
  if (mine.commaShare - theirs.commaShare >= 0.15) {
    out.push({ kind: 'too_comma', gap: Math.round((mine.commaShare - theirs.commaShare) * 100), want: theirs.commaShare, now: mine.commaShare })
  }
  // 语气词太多
  if (mine.particleShare - theirs.particleShare >= 0.12) {
    out.push({ kind: 'too_particle', gap: Math.round((mine.particleShare - theirs.particleShare) * 100), want: theirs.particleShare, now: theirs.particleShare })
  }
  // 从不扣问号：别人常扣、自己不扣 —— 这是最该学的一条
  const theirsQuestion = theirs.onlyQuestion + theirs.shortQuestion
  const mineQuestion = mine.onlyQuestion + mine.shortQuestion
  if (theirsQuestion >= 3 && mineQuestion === 0) {
    out.push({ kind: 'no_question', gap: theirsQuestion, want: theirsQuestion, now: 0 })
  }
  // 句尾爱加句号
  if (mine.periodEndShare - theirs.periodEndShare >= 0.2) {
    out.push({ kind: 'too_period', gap: Math.round((mine.periodEndShare - theirs.periodEndShare) * 100), want: theirs.periodEndShare, now: mine.periodEndShare })
  }
  return out
}

/**
 * 把差距翻译成一句能进提示词的话。
 *
 * 为什么是「行为指令」而不是「统计报告」：
 * 模型看到「p50=9」不会改；看到「人家 ≤6 字的占 37%，你只占 7% —— 该短的时候短下去」会改。
 *
 * 为什么**不给字数上限**：
 *   真人说话长短看语境。群里别人 p50=9 字但 p99=51 字、最长 78 字 ——
 *   人家照样说长话。写「压到 9 字」等于教出一个节拍器：不管说什么都 9 字，
 *   那不像人。给的是**倾向**（「该短时能短」），不是**上限**。
 *
 * `who` 说清参照的是谁：不然模型不知道自己是在跟「主人」比还是跟「群里其他人」比。
 */
export function gapLines(gapList, context = {}) {
  const lines = []
  const where = context.where || '群里'
  // 参照对象的名字。私聊里参照主人、群里参照别人 —— 但正文里不用重复说两遍
  // 「群里其他人」，读起来啰嗦。这里区分「主人」与「人家」。
  const who = context.who || '人家'
  for (const gap of gapList || []) {
    if (gap.kind === 'not_short_enough') {
      lines.push(`该短的时候要短得下去 —— ${who} ≤6 字的占 ${Math.round(gap.wantShort * 100)}%，你只占 ${Math.round(gap.nowShort * 100)}%；长短看语境，别一句都写满`)
    } else if (gap.kind === 'too_comma') {
      lines.push(`你逗号用得比${who}多 ${gap.gap} 个点，少用逗号，靠换行断气`)
    } else if (gap.kind === 'too_particle') {
      lines.push(`你语气词比${who}多 ${gap.gap} 个点，别句句都带`)
    } else if (gap.kind === 'no_question') {
      lines.push(`听不懂就扣一个「？」就行 —— ${who}这么干过 ${gap.gap} 次，你一次没有`)
    } else if (gap.kind === 'too_period') {
      lines.push(`你句尾爱加句号，${who}基本不加，别加`)
    }
  }
  return lines
}

/**
 * 完整算一次：分组 → 量 → 比差距 → 出提示词行。
 *
 * @param {object} input
 * @param {Array<object>} input.events
 * @param {string} [input.ownerId]
 * @param {'group'|'private'} [input.scope]
 * @returns {{ line: string, stats: object, gaps: object[] }}
 */
export function observe(input = {}) {
  const events = Array.isArray(input.events) ? input.events : []
  const scope = input.scope || 'group'
  const inScope = scope === 'private'
    ? events.filter((event) => (event?.scope || 'group') !== 'group')
    : events.filter((event) => (event?.scope || 'group') === 'group')

  const groups = splitGroups(inScope, { ownerId: input.ownerId })
  const others = measure(groups.others)
  const owner = measure(groups.owner)
  const mine = measure(groups.self)

  // 私聊场景的兜底参照来自**群聊**。
  //
  // 为什么：主人私聊样本不够时要退到「群里别人」当参照，可「别人」在私聊里
  // 本来就少（实测 21 条），退回去仍然是稀的，量出来的中位数照样偏。
  // 而群里别人有 569 条 —— 那才是稳定的说话密度。
  // 所以这里单独量一份跨场景的「别人」，只在主人样本不够时用。
  let fallbackOthers = others
  if (scope === 'private' && (!owner || owner.samples < MIN_SAMPLE)) {
    const allGroups = splitGroups(events, { ownerId: input.ownerId })
    const crossScope = measure(allGroups.others)
    if (crossScope.samples > (others?.samples || 0)) fallbackOthers = crossScope
  }

  // 学谁：群里的学「别人」，私聊优先学「主人」。
  //
  // 但主人样本不够时**不能硬用**：实测私聊最近 500 条里主人只有 20 条发言，
  // 而且全是长句抱怨（「你查完也不会输出内容给我」）。
  // 拿这 20 条当参照，算出来的中位数是 19 字 —— 那是**抱怨时的他**，不是他平时。
  // 照着 19 字去教「说话短一点」，等于把一次情绪当成了常态。
  //
  // 所以：主人样本够就用主人，不够就退到群里大家的稳定分布，
  // 并在提示词里说清参照的是谁 —— 不然模型不知道自己是在跟谁比。
  const ownerUsable = owner && owner.samples >= MIN_SAMPLE
  const target = scope === 'private' ? (ownerUsable ? owner : fallbackOthers) : others
  // 措辞上区分：主人就说「主人」，别人就说「人家」。
  // 「群里其他人」塞进句子里会读成「群里其他人中位 8 字」——啰嗦但没错；
  // 只是每句都带就长了，所以这里用短说法。
  const targetWho = scope === 'private' ? (ownerUsable ? '主人' : '人家') : '人家'
  const gapList = gaps(mine, target)
  const lines = gapLines(gapList, { where: scope === 'private' ? '私聊' : '群里', who: targetWho })

  // 样本不够就明说「还没学够」，别硬给结论。
  // 硬给结论的代价是提示词里塞一条没有依据的规矩，模型照着做，改的是错的方向。
  if (!target || target.samples < MIN_SAMPLE) {
    return {
      line: '',
      stats: { others, owner, self: mine, target, scope, targetWho },
      gaps: [],
      reason: `样本还不够（${target?.samples || 0} < ${MIN_SAMPLE}），先不乱学`,
    }
  }
  if (!gapList.length) {
    return {
      line: '',
      stats: { others, owner, self: mine, target, scope, targetWho },
      gaps: [],
      reason: '已经跟人家一个样了，不用改',
    }
  }

  const head = `【学到的手感·${scope === 'private' ? '私聊' : '群里'}】`
  let line = head + lines.join('；')
  if (line.length > GUIDE_BUDGET) {
    line = line.slice(0, GUIDE_BUDGET)
  }
  return { line, stats: { others, owner, self: mine, target, scope, targetWho }, gaps: gapList }
}

/**
 * 带缓存的观察器。
 *
 * 为什么需要缓存：每条消息进来都重算一遍 6000 行事件，
 * 一秒几次就把 CPU 烧了，而结论半小时内不会变。
 *
 * 缓存按「事件条数 + 最后一��的时间」失效：
 * 有人发了新消息就重算，没人发就一直用旧的。
 */
export class HabitObserver {
  /**
   * @param {object} options
   * @param {() => Array<object>} options.read 读事件流
   * @param {string} [options.ownerId]
   * @param {number} [options.ttlMs] 缓存有效期
   */
  constructor(options = {}) {
    this.read = typeof options.read === 'function' ? options.read : () => []
    this.ownerId = String(options.ownerId || '')
    this.ttlMs = Math.max(1000, Number(options.ttlMs) || 5 * 60_000)
    this.cache = new Map()
    this.now = options.now || (() => Date.now())
  }

  /** 观察某个场景（group / private） */
  observe(scope = 'group') {
    const key = String(scope || 'group')
    const hit = this.cache.get(key)
    const at = this.now()

    // 指纹一定要先算出来再看 TTL。
    //
    // 以前是「TTL 没到就直接返回」，于是新消息进来也不重算 ——
    // 学出来的手感永远停在 TTL 那一刻的数据上，而面板上看不出任何异常。
    // 现在改成：先读事件算指纹（读的是 journal 已缓存的行，代价很小），
    // 指纹没变就用缓存值，指纹变了就重算。TTL 只决定「多久没消息也要重算一次」。
    const events = this.read()
    // 注意 journal 的 read() 是**最新在前**（倒序读盘），
    // 所以「最新那条」是 rows[0]，不是最后一条。
    // 以前取了最后一条，指纹永远是同一个老消息 —— 于是新消息到了也不重算，
    // 学出来的手感永远停在旧数据上。
    const fingerprint = `${events.length}:${events.length ? events[0]?.id || events[0]?.at || '' : ''}`
    if (hit && hit.fingerprint === fingerprint && at - hit.at < this.ttlMs) {
      hit.at = at
      return hit.value
    }
    const value = observe({ events, ownerId: this.ownerId, scope: key })
    this.cache.set(key, { at, fingerprint, value })
    return value
  }

  /** 只取提示词行 */
  line(scope = 'group') {
    return this.observe(scope).line || ''
  }

  /** 清缓存 */
  invalidate() {
    this.cache.clear()
  }
}
