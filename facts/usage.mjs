/**
 * facts/usage.mjs — 花了多少 token、折成多少钱。
 *
 * 为什么值得单独一份文件：这件事用户会认真看，也最容易算错。
 * 旧版把「用量」和「计价」散在两个文件里（usage 79 行 + pricing 67 行），
 * 结果面板上只有次数没有钱；这次合成一处，且在**同一个地方**做三件事：
 *   1. 累加 token；
 *   2. 按配置的单价换成钱；
 *   3. 判断今天是不是超预算了。
 *
 * 单位说明（这是最容易搞错的地方）：
 *   配置里的 inputPerM / outputPerM 是「每百万 token 多少钱」，
 *   不是「每千」。写成每千会让账单差一千倍，而且很难发现 —— 数字看起来还挺合理。
 *
 * 两本账：
 *   `days`  按天切，只留最近 90 天 —— 用来算「今天」「预算剩多少」；
 *   `total` 只增不减的累计值 —— 用来回答「一共花了多少」，它不跟着按天裁剪走。
 * 早先只有前者，于是「历史总用量」最多只能看到 90 天，还随裁剪越看越少。
 */

const MILLION = 1_000_000
/** 按天账本保留多少天。累计值不受这个限制 */
const KEEP_DAYS = 90

/**
 * 消耗来源。
 *
 * 为什么账本要多这一列：只知道「今天花了 3 万 token」回答不了「钱花在哪」。
 * 真正要判断的是「是不是联网搜太多」「沙箱是不是在烧钱」——
 * 没有来源，这两个问题只能靠猜，而猜错的代价是多花钱或者把好用的功能关掉。
 *
 * 键名会进账本、进审计日志、进面板，改一次老账本就对不上了。
 * 新增来源只能往后加，不要重命名、不要重排语义。
 *
 * 关于沙箱：`exec_sandbox` 跑代码本身是 CPU，不是 token。
 * 记在 sandbox 名下的是「为它写代码」和「读它的结果」这两次推理 ——
 * 代码越长、输出越啰嗦，这部分越贵，所以它必须单独一档，不能糊进「工具」。
 */
export const USAGE_SOURCES = Object.freeze({
  chat: '对话',
  tool: '工具调用',
  search: '联网搜索',
  sandbox: '代码执行',
  auto: '自主活动',
  other: '其他',
})

/** 面板与统计按这个顺序列，固定顺序才不会每次刷新都换位置 */
const SOURCE_ORDER = Object.freeze(Object.keys(USAGE_SOURCES))

const SOURCE_LABEL = USAGE_SOURCES

/** 认不出来的来源一律归「其他」，绝不丢账 —— 宁可标签粗糙，不可总额变少 */
function normalizeSource(value) {
  const key = String(value || '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(SOURCE_LABEL, key) ? key : 'other'
}

/**
 * 把一次推理的用量按「几个东西共同导致」摊开。
 *
 * 为什么摊：一次推理里模型可能同时要调搜索、沙箱、记忆三个工具，
 * 只记进「工具」这一桶，事后就答不出沙箱到底花了多少。
 * 摊法必须**整数分配、余数给最后一个**：小数会让分项相加比总数多出一个尾数，
 * 而账单上「分项合计 ≠ 总计」是最容易被当成 bug 的那种错。
 */
export function splitUsage(usage, count) {
  const input = Math.max(0, Number(usage?.input) || 0)
  const output = Math.max(0, Number(usage?.output) || 0)
  const n = Math.max(1, Math.floor(Number(count) || 1))
  const baseIn = Math.floor(input / n)
  const baseOut = Math.floor(output / n)
  return Array.from({ length: n }, (_, index) => ({
    input: index === n - 1 ? input - baseIn * (n - 1) : baseIn,
    output: index === n - 1 ? output - baseOut * (n - 1) : baseOut,
  }))
}

function emptyBucket() {
  return { input: 0, output: 0, calls: 0, cost: 0 }
}

function addTo(bucket, input, output, cost, calls) {
  bucket.input += Math.max(0, Number(input) || 0)
  bucket.output += Math.max(0, Number(output) || 0)
  bucket.cost += Math.max(0, Number(cost) || 0)
  bucket.calls += Math.max(0, Number(calls) || 0)
  return bucket
}

/**
 * 模型名可能传进来三种形状：字符串、宿主的 {provider, model}、或者 {id, name}。
 * 直接 String() 前两种能过，第三种会变成「[object Object]」—— 账本里记着这么一行，
 * 事后想回答「这笔钱花在哪个模型上」就彻底查不出来了。
 */
function modelNameOf(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return String(value.model || value.name || value.id || value.value || '')
  return String(value)
}

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export class Usage {
  constructor(input = {}) {
    this.config = input.config || {}
    // 落盘的账本。没有就只算内存账（测试、或还没接日志的时候）
    this.journal = input.journal || null
    this.file = String(input.file || '')
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()
    this.memory = { input: 0, output: 0, calls: 0, cost: 0 }
    this.data = this.#load()
    this.#seedFromJournal()
    // 老账本补算出来的累计值要落盘一次，否则每次启动都要重算一遍
    if (this.migrated) {
      this.migrated = false
      this.#save()
    }
    this.loaded = null
  }

  /** 第一次启用本地账本时，把当天 audit 里的旧用量迁进来，避免当天清零 */
  #seedFromJournal() {
    if (!this.file || !this.journal || typeof this.journal.read !== 'function') return
    const key = this.#dayKey(this.now())
    if (this.data.days[key]) return
    try {
      const since = this.#dayStart(this.now())
      const rows = this.journal.read({ limit: 1000 }).rows.filter((row) => row?.kind === 'usage' && Number(row?.at || 0) >= since)
      if (!rows.length) return
      const sum = this.#sum(rows, this.now())
      this.data.days[key] = { input: sum.input, output: sum.output, calls: sum.calls, cost: sum.cost, sources: sum.sources }
      // 迁进来的这一天也是真花掉的钱，累计值必须跟着涨 —— 否则「累计」会低于「今天」。
      // 按来源分别加：一次加总额会把来源拆分的账和总额拆开，从第一天就对不上。
      for (const [source, bucket] of Object.entries(sum.sources || {})) {
        this.#bumpTotal(bucket.input, bucket.output, bucket.cost, bucket.calls, this.now(), source)
      }
      this.#save()
    } catch {}
  }

  #dayKey(at) {
    const date = new Date(Number(at) || this.now())
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  #load() {
    if (!this.file || !existsSync(this.file)) return { days: {} }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.days) return { days: {} }
      // 老账本只有 days。首次读到时按现有天数补一个累计值。
      // 注意这是**下限**：超过 90 天的天已经被裁掉了，补不出来 ——
      // 面板上会把「从哪天开始算」写在提示里，而不是假装这是开天辟地以来的总数。
      if (!parsed.total || typeof parsed.total !== 'object') {
        parsed.total = { input: 0, output: 0, calls: 0, cost: 0, since: '', sources: {} }
        for (const [key, day] of Object.entries(parsed.days)) {
          parsed.total.input += Math.max(0, Number(day?.input) || 0)
          parsed.total.output += Math.max(0, Number(day?.output) || 0)
          parsed.total.calls += Math.max(0, Number(day?.calls) || 0)
          parsed.total.cost += Math.max(0, Number(day?.cost) || 0)
          // 老天账里若有来源（新版写的），跟着迁进累计账，别让累计的分项凭空少一块
          for (const [source, bucket] of Object.entries(day?.sources || {})) {
            addTo((parsed.total.sources[source] = parsed.total.sources[source] || emptyBucket()), bucket?.input, bucket?.output, bucket?.cost, bucket?.calls)
          }
          if (!parsed.total.since || key < parsed.total.since) parsed.total.since = key
        }
        this.migrated = true
      }
      // 累计账可能是老版本写的：没有 sources 字段就补一个空袋，
      // 否则第一次 record 会往 undefined 上加，报错还被 catch 吞掉 —— 分项从此永远是空的
      if (!parsed.total.sources || typeof parsed.total.sources !== 'object') parsed.total.sources = {}
      return parsed
    } catch {
      return { days: {} }
    }
  }

  #save() {
    if (!this.file) return
    try {
      const temp = this.file + '.tmp'
      writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(temp, this.file)
    } catch {}
  }

  configure(config = {}) {
    this.config = config
  }

  /** 单价（元 / 百万 token） */
  price() {
    return {
      // 显式全路径：单价这种「差一千倍也不明显」的配置，必须能在源码里一眼搜到
      input: Math.max(0, Number(this.config.usage?.inputPerM) || 0),
      output: Math.max(0, Number(this.config.usage?.outputPerM) || 0),
      currency: String(this.config.usage?.currency || 'CNY'),
    }
  }

  /**
   * 算这一次多少钱。
   * 入参允许 undefined / 负数 / 小数：真实接口偶尔返回不干净的用量，
   * 这里一律按 0 处理，绝不让账单变成 NaN —— 一个 NaN 会把整页统计染掉。
   */
  cost(inputTokens = 0, outputTokens = 0) {
    const price = this.price()
    const inTok = Math.max(0, Number(inputTokens) || 0)
    const outTok = Math.max(0, Number(outputTokens) || 0)
    return (inTok * price.input + outTok * price.output) / MILLION
  }

  /**
   * 记一次调用。
   * @param {object} [meta] at / model / conversation / source
   * @returns {{ok:boolean, cost:number, total:{input:number,output:number,calls:number,cost:number}}}
   */
  record(inputTokens = 0, outputTokens = 0, meta = {}) {
    const at = Number(meta.at) || this.now()
    const inTok = Math.max(0, Number(inputTokens) || 0)
    const outTok = Math.max(0, Number(outputTokens) || 0)
    const cost = this.cost(inTok, outTok)
    // 来源必须显式带上来。没带就记成「其他」，而不是悄悄算进「对话」——
    // 算进对话会让「对话」这个数看起来偏高，而错的那部分永远查不出来。
    const source = normalizeSource(meta.source)
    // 一次推理被摊成多行时，只有第一行算「一次调用」（传 calls:0 的其余行不算）。
    // 不这么分，摊成三行就变成三次调用 —— 累计次数会凭空翻三倍。
    const calls = Math.max(0, Math.floor(Number(meta.calls ?? 1) || 0))

    this.memory.input += inTok
    this.memory.output += outTok
    this.memory.calls += calls
    this.memory.cost += cost
    addTo((this.memory.sources ||= {})[source] ||= emptyBucket(), inTok, outTok, cost, calls)

    if (this.file) {
      const key = this.#dayKey(at)
      const day = this.data.days[key] || { input: 0, output: 0, calls: 0, cost: 0, sources: {} }
      day.input += inTok
      day.output += outTok
      day.calls += calls
      day.cost += cost
      addTo((day.sources ||= {})[source] ||= emptyBucket(), inTok, outTok, cost, calls)
      this.data.days[key] = day
      this.#bumpTotal(inTok, outTok, cost, calls, at, source)
      const keys = Object.keys(this.data.days).sort()
      for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete this.data.days[old]
      this.#save()
    }

    if (this.journal && typeof this.journal.append === 'function') {
      this.journal.append({
        kind: 'usage',
        at,
        input: inTok,
        output: outTok,
        cost,
        calls,
        source,
        model: modelNameOf(meta.model),
        conversation: String(meta.conversation || ''),
      })
    }

    // 每花一笔就看一眼预算，超了当场告诉调用方，别等到第二天对账。
    // 返回完整对象而不是一个 true/false：调用方通常还要显示「还剩多少」。
    const budget = this.overBudget(at)
    return { ok: true, cost, total: { ...this.memory }, overBudget: budget }
  }

  /** 今天零点（本地时区）。和 runtime.status 用同一口径 */
  #dayStart(at) {
    const date = new Date(Number(at) || this.now())
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }

  /**
   * 今天的账。
   * 有日志就查日志（重启不丢），没日志就退回内存账。
   * 两条路返回同一种形状，调用方不需要知道底下走哪条。
   */
  today(at = this.now()) {
    if (this.file) {
      const day = this.data.days[this.#dayKey(at)]
      if (day) return this.#sum([day], at)
    }
    // 没有账本（测试、或还没接日志）才用内存累计 —— 那是「本次启动以来」的数。
    if (!this.journal || typeof this.journal.read !== 'function') {
      return this.#sum(this.#fromMemory(), at)
    }

    const since = this.#dayStart(at)
    // 有账本就**只**按账本算，今天没记过账就是 0。
    // 早先这里在「今天没记录」时退回了内存累计，于是把昨天的钱算进了今天 ——
    // 用户看到的是「今天还没说话就已经花了 1 块」，而这种错很难被发现。
    //
    // 分页最多翻 4 页（每页 500）：一天超过 2000 次调用时统计会偏少。
    // 这是已知上限，写在这里而不是假装没有；真到那个量级，面板显示的已是下限。
    let rows = []
    let before = undefined
    for (let page = 0; page < 4; page += 1) {
      const slice = this.journal.read({ limit: 500, before })
      rows = rows.concat(slice.rows)
      if (!slice.hasMore || !slice.nextBefore) break
      const oldest = slice.rows[slice.rows.length - 1]
      if (!oldest || Number(oldest?.at || 0) < since) break
      before = slice.nextBefore
    }
    return this.#sum(rows.filter((row) => row?.kind === 'usage' && Number(row?.at || 0) >= since), at)
  }

  #fromMemory() {
    return [{ input: this.memory.input, output: this.memory.output, cost: this.memory.cost }]
  }

  /**
   * 只增不减的累计值。和「按天账」分开维护，所以不会被 90 天裁剪带走。
   *
   * `since` 是账本里最早的那一天（键名 YYYY-MM-DD）。数据库从别处迁过来时
   * 它可能比真实起点晚 —— 面板把 `since` 明写出来，读的人就知道这个数从哪天算起。
   */
  #bumpTotal(input, output, cost, calls, at, source = 'other') {
    if (!this.data.total || typeof this.data.total !== 'object') {
      this.data.total = { input: 0, output: 0, calls: 0, cost: 0, since: '', sources: {} }
    }
    const total = this.data.total
    total.input += Math.max(0, Number(input) || 0)
    total.output += Math.max(0, Number(output) || 0)
    total.cost += Math.max(0, Number(cost) || 0)
    total.calls += Math.max(0, Number(calls) || 0)
    const sources = (total.sources ||= {})
    const key = normalizeSource(source)
    addTo((sources[key] ||= emptyBucket()), input, output, cost, calls)
    const dayKey = this.#dayKey(at)
    if (!total.since || dayKey < total.since) total.since = dayKey
  }

  /** 累计总用量：从账本第一天到今天，一共花了多少 */
  total(at = this.now()) {
    const source = this.file && this.data.total
      ? this.data.total
      : { input: this.memory.input, output: this.memory.output, calls: this.memory.calls, cost: this.memory.cost, since: '', sources: this.memory.sources || {} }
    const input = Math.max(0, Number(source.input) || 0)
    const output = Math.max(0, Number(source.output) || 0)
    return {
      at,
      input,
      output,
      tokens: input + output,
      calls: Math.max(0, Number(source.calls) || 0),
      cost: Number((Math.max(0, Number(source.cost) || 0)).toFixed(6)),
      currency: this.price().currency,
      since: String(source.since || ''),
      sources: source.sources || {},
      days: this.file ? Object.keys(this.data.days).length : 0,
      // 没有账本时这是「本次启动以来」的数，不能说成历史总和
      lifetime: Boolean(this.file),
    }
  }

  #sum(rows, at) {
    let input = 0
    let output = 0
    let cost = 0
    const sources = {}
    for (const row of rows) {
      input += Math.max(0, Number(row?.input) || 0)
      output += Math.max(0, Number(row?.output) || 0)
      cost += Math.max(0, Number(row?.cost) || 0)
      // 两种形状都要认：按天账是 `sources` 一袋，审计日志是每行一个 `source`。
      // 老账本两样都没有 —— 归「其他」，并且面板会明写「这部分拆不开」。
      if (row?.sources && typeof row.sources === 'object') {
        for (const [key, bucket] of Object.entries(row.sources)) {
          addTo((sources[normalizeSource(key)] ||= emptyBucket()), bucket?.input, bucket?.output, bucket?.cost, bucket?.calls)
        }
      } else {
        addTo((sources[normalizeSource(row?.source)] ||= emptyBucket()), row?.input, row?.output, row?.cost, 1)
      }
    }
    const budget = Math.max(0, Number(this.config.usage?.budgetPerDay) || 0)
    return {
      at,
      input,
      output,
      calls: rows.reduce((sum, row) => sum + (row && row.calls !== undefined ? Math.max(0, Number(row.calls) || 0) : 1), 0),
      cost: Number(cost.toFixed(6)),
      budget,
      currency: this.price().currency,
      sources,
      // 预算 0 视为「不设上限」，不是「一点都不许花」
      //
      // 判定用 `>=` 而不是 `>`：正好花到预算（cost == budget）时 left 已经是 0，
      // 面板显示「预算还剩 ¥0.00」却还在继续花钱 —— 显示与判定自相矛盾。
      // 「用完了」和「超了」在预算这件事上是同一件事：没有余额可用了。
      over: budget > 0 && cost >= budget,
      left: budget > 0 ? Number(Math.max(0, budget - cost).toFixed(6)) : null,
    }
  }

  /**
   * 按来源拆好的今日用量，给面板直接用。
   *
   * 返回数组而不是对象：面板要排序、要算占比，数组更好遍历，
   * 也不会因为某个来源从没出现过就少一行（六个格子固定，缺的显示 0）。
   */
  sourcesView(at = this.now()) {
    const today = this.today(at)
    const buckets = today.sources || {}
    const totalTokens = (Number(today.input) || 0) + (Number(today.output) || 0)
    const items = SOURCE_ORDER.map((id) => {
      const bucket = buckets[id] || emptyBucket()
      const tokens = Math.max(0, Number(bucket.input) || 0) + Math.max(0, Number(bucket.output) || 0)
      return {
        id,
        label: SOURCE_LABEL[id],
        input: Math.max(0, Number(bucket.input) || 0),
        output: Math.max(0, Number(bucket.output) || 0),
        tokens,
        calls: Math.max(0, Number(bucket.calls) || 0),
        cost: Number((Math.max(0, Number(bucket.cost) || 0)).toFixed(6)),
        share: totalTokens > 0 ? tokens / totalTokens : 0,
      }
    })
    // 分项相加与总数对不上的差额：只可能来自「没有来源标记的旧账」。
    // 与其悄悄把差额摊给别人，不如算出来告诉用户 —— 差多少、为什么差，都能解释。
    const counted = items.reduce((sum, item) => sum + item.tokens, 0)
    return {
      at,
      total: totalTokens,
      counted,
      untracked: Math.max(0, totalTokens - counted),
      cost: Number((Number(today.cost) || 0).toFixed(6)),
      calls: Number(today.calls) || 0,
      currency: today.currency,
      items,
    }
  }

  overBudget(at = this.now()) {
    const today = this.today(at)
    return { over: today.over, cost: today.cost, budget: today.budget, left: today.left }
  }

  /** 一句话（进面板、也能直接发出去） */
  line(at = this.now()) {
    const today = this.today(at)
    const symbol = today.currency === 'USD' ? '$' : '¥'
    // 钱一律两位小数。以前「预算还剩」直接拼原始浮点，界面上出现过
    // 「预算还剩 1.600683」—— 同一句话里一半是 ¥0.40、一半是 1.600683，
    // 看的人会以为后者是某种内部数值，而不是钱。
    const cash = (value) => `${symbol}${(Number(value) || 0).toFixed(2)}`
    const money = cash(today.cost)
    const tokens = `${Math.round((today.input + today.output) / 1000)}k`
    if (!today.budget) return `今天用了 ${tokens} token，约 ${money}`
    if (today.over) return `今天用了 ${tokens} token，约 ${money}，已超过 ${cash(today.budget)} 的预算`
    return `今天用了 ${tokens} token，约 ${money}，预算还剩 ${cash(today.left)}`
  }
}
