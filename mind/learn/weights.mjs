/**
 * mind/learn/weights.mjs — 四个旋钮的「形状」：上下限、默认值、校验、单步钳制。
 *
 * 设计文档里 `weights` 从来是一件独立的事，0.45.24 却没有独立文件：
 * 它和「怎么学」的编排（Evolver：证据、版本、回滚）一起挤在 evolve.mjs 的 493 行里。
 * 结果是这段纯函数既不好测，也不好复用 —— 面板想把 `0.82` 显示成「记忆留 3 周」
 * 得绕到进化器里去问。
 *
 * 0.46.0 把两件事分开：
 *   weights.mjs  纯的。没有状态、不读写磁盘、不知道「学习」这回事。只回答
 *                「这个值合法吗、默认多少、一次最多挪多远」。
 *   evolve.mjs   有状态的。管证据、窗口、版本、回滚，调这里的纯函数。
 *
 * 分开的判据很简单：把 weights.mjs 单独拿出来，它应该能在任何地方跑 ——
 * 面板、审计脚本、用例，都不需要先造一个 Evolver。
 */

import { TUNABLE_BEHAVIORS } from '../../decide/index.mjs'

/** 三类可调参数的上下限。改这里等于改「学得能有多猛」，用例盯着 */
export const BOUNDS = Object.freeze({
  weight: Object.freeze({ min: 0.2, max: 3 }),
  maxParts: Object.freeze({ min: 1, max: 4 }),
  netDecay: Object.freeze({ min: 0.75, max: 0.9 }),
})

/** 空权重。behaviorWeight 只含三类可优化行为；管理/维护由规则决定，不参与 */
export function defaultWeights() {
  const behaviorWeight = {}
  for (const kind of TUNABLE_BEHAVIORS) behaviorWeight[kind] = 1
  return {
    toolWeight: {},
    behaviorWeight,
    styleParams: { maxParts: 3 },
    netDecay: 0.82,
  }
}

/** 权重名 → 人话（面板与审计共用，避免两边各写一套） */
const WEIGHT_LABELS = Object.freeze({
  'toolWeight': '工具',
  'behaviorWeight': '行为',
  'styleParams.maxParts': '一次说几条',
  'netDecay': '记忆衰减',
  '*': '回滚',
})

export function weightLabel(key) {
  if (WEIGHT_LABELS[key]) return WEIGHT_LABELS[key]
  const [prefix] = String(key).split('.')
  return WEIGHT_LABELS[prefix] || key
}

export function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function cloneWeights(weights) {
  return {
    toolWeight: { ...(weights?.toolWeight || {}) },
    behaviorWeight: { ...(weights?.behaviorWeight || {}) },
    styleParams: { ...(weights?.styleParams || {}) },
    netDecay: Number(weights?.netDecay ?? 0.82),
  }
}

/**
 * 校验并修复从磁盘读回来的权重。
 * 坏值一律回默认，不抛 —— 一个手改坏的 json 不该让整个插件起不来。
 */
export function normalizeWeights(raw) {
  const base = defaultWeights()
  const source = raw && typeof raw === 'object' ? raw : {}

  for (const [name, value] of Object.entries(source.toolWeight || {})) {
    const n = Number(value)
    if (Number.isFinite(n)) base.toolWeight[String(name)] = clampNumber(n, BOUNDS.weight.min, BOUNDS.weight.max)
  }
  for (const kind of TUNABLE_BEHAVIORS) {
    const n = Number(source.behaviorWeight?.[kind])
    if (Number.isFinite(n)) base.behaviorWeight[kind] = clampNumber(n, BOUNDS.weight.min, BOUNDS.weight.max)
  }
  const maxParts = Number(source.styleParams?.maxParts)
  if (Number.isFinite(maxParts)) {
    base.styleParams.maxParts = clampNumber(maxParts, BOUNDS.maxParts.min, BOUNDS.maxParts.max)
  }
  const decay = Number(source.netDecay)
  if (Number.isFinite(decay)) base.netDecay = clampNumber(decay, BOUNDS.netDecay.min, BOUNDS.netDecay.max)
  return base
}

/**
 * 单步钳制：这一版最多挪 clamp。
 *
 * 为什么**不做**「同类权重归一化」（这条与旧方案不同，是实测后改的）：
 *
 *   归一化只在「同类里按份额分配预算」时才有意义。而本模块的类别很小：
 *   行为只有 3 个、工具随技能装载在 10~60 之间波动。
 *   一旦归一化：
 *     - 只有 3 个行为时，把 reply 从 1.0 提到 1.1，另外两个不动，
 *       均值一变，回算回来 reply ≈ 1.07 —— 信号被摊薄；
 *     - 只有 1 个键的类别（比如今天只装了一个工具），归一化直接把它折回 1.0，
 *       学了半天等于没学。
 *
 *   所以这里只做两件事：**单步钳制**与**上下限**。
 *   这两条已经能防住「一次偶然把权重带偏」和「越跑越大」，
 *   而且信号不会被类别大小稀释。真要重新分配预算，那是策略问题，
 *   不该藏在一个算术里。
 */
export function stepClamp(before, after, clamp) {
  const delta = after - before
  if (Math.abs(delta) <= clamp) return after
  return before + Math.sign(delta) * clamp
}
