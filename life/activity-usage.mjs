/**
 * life/activity-usage.mjs — 自主活动自己的 token 账本
 * ============================================================================
 * 以前自主活动的消耗只能靠「思维链」这一条路看见：runActivityStep 把 tokens
 * 挂在 logCot 条目上，面板思维链右侧才显示一行「700 in · 45 out」。
 * 问题是：
 *   · 主动开口定时器、群聊插话这两路压根不写带来源的思维链；
 *   · 反思没生成文字时那条 cot 也不会落，可那次推理已经花过钱；
 *   · runner 换个 usage 字段名（prompt_tokens / inputTokens / …）就是 null，
 *     spend() 直接 return，账本上连「调用过一次」都没有。
 * 于是「自主活动有时候不走思维链，看不到 token 消耗」。
 *
 * 现在把计量从思维链里彻底拆出来，放到自主活动自己这一层：
 *   · 每一次自主推理都记进独立账本 activity-usage.json，按天 + 按动作分类；
 *   · 有数字就同时进总账本（source=auto），没有数字也记「一次调用」并写审计，
 *     面板显示「有 N 次没拿到数字」，而不是一片空白；
 *   · 思维链仍然带 tokens（旧界面照常显示），但它只是**副本**，不再是唯一来源。
 *
 * 独立账本与总账本不是双花：总账本记的是全插件花了多少，这里记的是其中
 * 「自主活动」这一档花了多少，两者可以逐日对账。
 * ============================================================================
 */
import path from 'node:path'
import { readJson, writeJson } from '../base/core.mjs'

const KEEP_DAYS = 90

/** 动作分类。键名进账本，只加不改 —— 改了老账本就对不上 */
export const ACTIVITY_KINDS = Object.freeze({
  think: '想查什么',
  reflect: '查完想想',
  proactive: '主动开口',
  interject: '群里插话',
  qzone: '写说说',
  other: '其它自主推理',
})

function emptyBucket() {
  return { input: 0, output: 0, calls: 0, cost: 0, untracked: 0 }
}

function emptyDay() {
  return { input: 0, output: 0, calls: 0, cost: 0, untracked: 0, byKind: {} }
}

function emptyData() {
  return { days: {}, total: { ...emptyDay(), since: '' } }
}

function firstNumber(...values) {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return null
}

/**
 * 宿主给用量的写法至少有六种，流式 finish 里还可能只给一个总数。
 * 缺字段不等于没花钱 —— 但也绝不编一个数字出来，只标「没拿到」。
 * @returns {{tracked:boolean,input:number,output:number,total:number}}
 */
export function usageOf(result) {
  const raw = result?.usage || result?.tokenUsage || result?.tokens || null
  if (!raw || typeof raw !== 'object') return { tracked: false, input: 0, output: 0, total: 0 }
  const input = firstNumber(
    raw.inputTokens, raw.input_tokens, raw.promptTokens, raw.prompt_tokens, raw.prompt, raw.input,
  )
  const output = firstNumber(
    raw.outputTokens, raw.output_tokens, raw.completionTokens, raw.completion_tokens, raw.completion, raw.output,
  )
  if (input !== null || output !== null) {
    return { tracked: true, input: input || 0, output: output || 0, total: (input || 0) + (output || 0) }
  }
  const total = firstNumber(raw.totalTokens, raw.total_tokens, raw.total) || 0
  return { tracked: false, input: 0, output: 0, total }
}

function dayKey(at) {
  const d = new Date(Number(at) || Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function bump(bucket, spent, cost, untracked) {
  bucket.input += spent.input
  bucket.output += spent.output
  bucket.calls += 1
  bucket.cost += cost
  bucket.untracked += untracked
}

class ActivityMeter {
  constructor(runtime) {
    this.runtime = runtime
    const dir = String(runtime?.dir || '').trim()
    // 没有目录（纯内存测试）就只记内存，不往工作目录里乱写文件
    this.file = dir ? path.join(dir, 'activity-usage.json') : ''
    this.data = this.#load()
  }

  #load() {
    if (!this.file) return emptyData()
    const read = readJson(this.file, emptyData())
    const value = read?.ok && read.value && typeof read.value === 'object' ? read.value : emptyData()
    if (!value.days || typeof value.days !== 'object') value.days = {}
    if (!value.total || typeof value.total !== 'object') value.total = { ...emptyDay(), since: '' }
    return value
  }

  #save() {
    if (!this.file) return
    const keys = Object.keys(this.data.days).sort()
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete this.data.days[old]
    if (!this.data.total.since) this.data.total.since = keys[0] || dayKey(this.now())
    writeJson(this.file, this.data)
  }

  now() {
    const at = Number(this.runtime?.now?.())
    return Number.isFinite(at) && at > 0 ? at : Date.now()
  }

  /**
   * 记一次自主推理。无论有没有拿到数字都会落账。
   * @returns {{tracked:boolean,input:number,output:number}}
   */
  record(result, meta = {}) {
    const at = Number(meta.at) || this.now()
    const kind = Object.prototype.hasOwnProperty.call(ACTIVITY_KINDS, meta.kind) ? meta.kind : 'other'
    const spent = usageOf(result)
    const key = dayKey(at)
    const day = this.data.days[key] || (this.data.days[key] = emptyDay())
    const bucket = day.byKind[kind] || (day.byKind[kind] = emptyBucket())
    const totalBucket = this.data.total.byKind || (this.data.total.byKind = {})

    let cost = 0
    if (spent.tracked && spent.total > 0) {
      // 同一笔在总账本里记「自主活动」这一档：保持「今天的账」与这里能对得上
      try {
        const billed = this.runtime?.usage?.record?.(spent.input, spent.output, {
          at,
          model: result?.model || '',
          conversation: 'activity',
          source: 'auto',
        })
        cost = Math.max(0, Number(billed?.cost) || 0)
        if (!cost && typeof this.runtime?.usage?.cost === 'function') {
          cost = Math.max(0, Number(this.runtime.usage.cost(spent.input, spent.output)) || 0)
        }
      } catch {}
      bump(day, spent, cost, 0)
      bump(bucket, spent, cost, 0)
      const all = totalBucket[kind] || (totalBucket[kind] = emptyBucket())
      bump(all, spent, cost, 0)
      bump(this.data.total, spent, cost, 0)
    } else {
      // 没拿到数字也要留痕：否则「看不到消耗」会变成「连调用过都不知道」
      const blank = { input: 0, output: 0 }
      bump(day, blank, 0, 1)
      bump(bucket, blank, 0, 1)
      const all = totalBucket[kind] || (totalBucket[kind] = emptyBucket())
      bump(all, blank, 0, 1)
      bump(this.data.total, blank, 0, 1)
      try {
        this.runtime?.log?.('activity_usage_missing', {
          kind,
          model: String(result?.model || ''),
          total: spent.total,
          text: String(meta.label || '').slice(0, 80),
        })
      } catch {}
    }
    try { this.#save() } catch {}
    return { tracked: spent.tracked && spent.total > 0, input: spent.input, output: spent.output }
  }

  /** 今天这一档的账。形状固定，面板不需要判断有没有数据 */
  today(at = this.now()) {
    const day = this.data.days[dayKey(at)] || emptyDay()
    const byKind = Object.entries(ACTIVITY_KINDS).map(([id, label]) => {
      const bucket = day.byKind?.[id] || emptyBucket()
      return {
        id,
        label,
        input: bucket.input,
        output: bucket.output,
        tokens: bucket.input + bucket.output,
        calls: Math.max(0, Number(bucket.calls) || 0),
        untracked: Math.max(0, Number(bucket.untracked) || 0),
        cost: Number((Math.max(0, Number(bucket.cost) || 0)).toFixed(6)),
      }
    })
    return {
      at,
      input: day.input,
      output: day.output,
      tokens: day.input + day.output,
      calls: Math.max(0, Number(day.calls) || 0),
      untracked: Math.max(0, Number(day.untracked) || 0),
      cost: Number((Math.max(0, Number(day.cost) || 0)).toFixed(6)),
      byKind,
    }
  }

  /** 一句人话，给面板和调试台直接用 */
  line(at = this.now()) {
    const day = this.today(at)
    if (!day.calls) return '今天还没有自主活动'
    const missing = day.untracked ? `，其中 ${day.untracked} 次没拿到 token 数` : ''
    return `今天自主活动 ${day.calls} 次，用了 ${day.tokens} token，约 ¥${day.cost.toFixed(3)}${missing}`
  }
}

const meters = new WeakMap()

/** 一个 runtime 一本账；没挂过就现建，不需要在装配处多写一行 */
export function meterOf(runtime) {
  if (!runtime) return new ActivityMeter({})
  let meter = meters.get(runtime)
  if (!meter) {
    meter = new ActivityMeter(runtime)
    meters.set(runtime, meter)
  }
  return meter
}

/** 各处自主推理的统一入口：一行调用，记账 + 返回可挂在日志上的数字 */
export function activitySpend(runtime, result, meta = {}) {
  return meterOf(runtime).record(result, meta)
}

/** 给面板/调试台：账本汇总 + 人话 */
export function activityUsageView(runtime, at) {
  const meter = meterOf(runtime)
  return { ...meter.today(at), line: meter.line(at) }
}
