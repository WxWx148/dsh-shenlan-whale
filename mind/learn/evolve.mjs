/**
 * mind/evolve.mjs — 管「他/她怎么慢慢学你」。
 *
 * ══════════════════════════════════════════════════════════════
 * 【这份文件管什么】← 不看代码的人，只读这一段就够
 *
 *   他/她每回完一次话，系统会记一笔：这次回得好不好。
 *   攒够 20 次，就拿这份记录微调四个习惯：
 *
 *     · 哪个工具好用   —— 反复用得顺的，以后多让它出手
 *     · 哪类举动有效   —— 回话、主动开口、自己找事，各记一个分
 *     · 说话的分寸     —— 一次分几条、每条多长
 *     · 记性留多久     —— 旧事从什么时候开始变模糊
 *
 *   调得不好有两条路退回去：
 *     界面上点「退回到上周」；或者叫这里面的 rollback()。
 *   每一版都留着，退回去不会丢东西。
 *
 *   **人格、人设、语气、价值观不在这里动。** 那是他/她是谁，
 *   不是可以调优的参数 —— 学得再多，也不该把人学成另一个人。
 * ══════════════════════════════════════════════════════════════
 *
 * 给改代码的人：进化只做一件小而可测的事——调四类权重。
 *
 * 旧版 981 行的病：策略散、无证据、无回滚、把「人格」也一起动。
 *   981 行里没有一处权重，只有「提案 → 人审」，所以既没学到东西，也说不清学了啥。
 *
 * 四个旋钮：
 *   toolWeight[tool]        哪个工具好用            0.2 – 3.0
 *   behaviorWeight[kind]    哪类行为有效            0.2 – 3.0（只有 reply / proactive / activity）
 *   styleParams             一次说几条              1–4 条
 *   netDecay                记忆衰减                0.75 – 0.9
 *
 * **人格、人设、语气词、价值观不参与进化** —— 那是身份，不是可优化参数。
 *
 * 三条硬规矩（都有测试盯着）：
 *   1. 无证据不动：没有 reason 与 sample 的调用直接拒；
 *   2. 单次变动 ≤ clamp（默认 0.15），方向对了也不会一步跳到位；
 *   3. 可以回滚：每版都留快照，回滚只追加一条记录，不删历史。
 */

import { BEHAVIOR, TUNABLE_BEHAVIORS } from '../../decide/index.mjs'
// 四个旋钮的形状（上下限 / 默认值 / 校验 / 单步钳制）在 weights.mjs：
// 那是纯函数，面板和审计也要用；这里只留「怎么学」的编排。
import {
  BOUNDS,
  clampNumber,
  cloneWeights,
  defaultWeights,
  normalizeWeights,
  stepClamp,
} from './weights.mjs'

const DEFAULT_OPTIONS = Object.freeze({
  window: 20,
  ema: 0.1,
  clamp: 0.15,
  keepVersions: 50,
})

/**
 * 权重进化器。有状态（版本、历史），所以是类。
 */
export class Evolver {
  /**
   * @param {object} [input]
   * @param {object} [input.state]  从 evolve.json 读回来的状态
   * @param {object} [input.options] window / ema / clamp / keepVersions
   */
  constructor(input = {}) {
    const options = { ...DEFAULT_OPTIONS, ...(input.options || {}) }
    this.options = {
      window: Math.max(1, Number(options.window) || DEFAULT_OPTIONS.window),
      ema: clampNumber(Number(options.ema), 0.01, 0.5) || DEFAULT_OPTIONS.ema,
      clamp: clampNumber(Number(options.clamp), 0.01, 1) || DEFAULT_OPTIONS.clamp,
      keepVersions: Math.max(1, Number(options.keepVersions) || DEFAULT_OPTIONS.keepVersions),
    }
    this.state = this.#normalizeState(input.state)
  }

  #normalizeState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {}
    const weights = normalizeWeights(source.weights)
    const version = Number.isFinite(Number(source.version)) ? Math.max(0, Math.trunc(Number(source.version))) : 0
    const versions = (Array.isArray(source.versions) ? source.versions : [])
      .filter((item) => item && Number.isFinite(Number(item.version)))
      .map((item) => ({
        version: Math.trunc(Number(item.version)),
        at: Number(item.at) || 0,
        weights: normalizeWeights(item.weights),
      }))
    if (!versions.some((item) => item.version === version)) versions.push({ version, at: Number(source.at) || 0, weights: cloneWeights(weights) })
    versions.sort((a, b) => a.version - b.version)

    const changes = (Array.isArray(source.changes) ? source.changes : []).filter((item) => item && typeof item === 'object')
    const batches = (Array.isArray(source.batches) ? source.batches : [])
      .filter((item) => item && Number.isFinite(Number(item.version)))
      .slice(-4)

    return {
      version,
      at: Number(source.at) || 0,
      pausedUntil: Number(source.pausedUntil) || 0,
      weights,
      versions,
      changes: changes.slice(-500),
      batches,
    }
  }

  /** 当前权重（拷贝，外面改不到内部状态） */
  current() {
    return cloneWeights(this.state.weights)
  }

  /** 给人看的摘要。at 由调用方给（运行时用同一个时钟，测试用模拟时钟） */
  summary(at = Date.now()) {
    const s = this.state
    return {
      version: s.version,
      paused: s.pausedUntil > Number(at),
      pausedUntil: s.pausedUntil,
      changes: s.changes.length,
      versions: s.versions.length,
      weights: this.current(),
    }
  }

  /** 可回滚的版本列表（新的在前） */
  history() {
    return this.state.versions
      .slice()
      .sort((a, b) => b.version - a.version)
      .map((item) => ({ version: item.version, at: item.at }))
  }

  /**
   * 吃一次奖励，产出一版新权重。
   *
   * @param {object} input
   * @param {number} [input.at]
   * @param {string} input.reason            这一版为什么动（人话，会写进证据）
   * @param {string[]} input.sample          支撑这次变动的记录 id
   * @param {object} [input.rewards]         { tool:{名:分}, behavior:{类:分}, maxParts:分, netDecay:分 }
   * @param {number} [input.responseDelta]   这一轮的响应率变化（用于自动回滚判定）
   * @returns {{ ok: boolean, error?: string, version?: number, changes?: object[], autoRolledBack?: boolean }}
   */
  apply(input = {}) {
    const at = Number(input.at) || Date.now()
    if (this.state.pausedUntil && at < this.state.pausedUntil) {
      return { ok: false, error: `进化已暂停到 ${new Date(this.state.pausedUntil).toLocaleString('zh-CN')}` }
    }
    const reason = String(input.reason || '').trim()
    const sample = Array.isArray(input.sample) ? input.sample.filter(Boolean).map(String) : []
    if (!reason) return { ok: false, error: '权重变动必须带证据：缺 reason' }
    if (!sample.length) return { ok: false, error: '权重变动必须带证据：缺 sample' }

    const rewards = input.rewards && typeof input.rewards === 'object' ? input.rewards : {}
    const before = this.current()
    const { ema, clamp } = this.options

    const toolRewards = rewards.tool && typeof rewards.tool === 'object' ? rewards.tool : {}
    const behaviorRewards = rewards.behavior && typeof rewards.behavior === 'object' ? rewards.behavior : {}

    // 1) EMA：w' = w × (1 + ema × reward)
    //    乘性而不是「×0.9 + reward×0.1」——后者在 reward=0 时每轮白掉 10%，
    //    五十轮之后所有权重贴在下限上，等于把进化变成「慢性自杀」。
    const rawTool = { ...before.toolWeight }
    for (const [name, value] of Object.entries(toolRewards)) {
      // 空名字会在权重表里写出 `toolWeight.""` 这种脏键，直接跳过
      const key = String(name ?? '').trim()
      if (!key) continue
      const reward = clampNumber(Number(value), -1, 1)
      if (!Number.isFinite(Number(value))) continue
      const base = Number(rawTool[key] ?? 1)
      rawTool[key] = clampNumber(base * (1 + ema * reward), BOUNDS.weight.min, BOUNDS.weight.max)
    }
    const rawBehavior = { ...before.behaviorWeight }
    for (const [kind, value] of Object.entries(behaviorRewards)) {
      if (!TUNABLE_BEHAVIORS.includes(kind)) continue
      // NaN 经 clamp 会变成 -1（重罚），必须在钳制之前先剔掉
      if (!Number.isFinite(Number(value))) continue
      const reward = clampNumber(Number(value), -1, 1)
      const base = Number(rawBehavior[kind] ?? 1)
      rawBehavior[kind] = clampNumber(base * (1 + ema * reward), BOUNDS.weight.min, BOUNDS.weight.max)
    }

    // 2) 单步钳制 + 上下限
    const nextTool = {}
    for (const name of Object.keys(rawTool)) {
      const base = Number(before.toolWeight[name] ?? 1)
      nextTool[name] = clampNumber(stepClamp(base, rawTool[name], clamp), BOUNDS.weight.min, BOUNDS.weight.max)
    }
    const nextBehavior = {}
    for (const kind of Object.keys(rawBehavior)) {
      const base = Number(before.behaviorWeight[kind] ?? 1)
      nextBehavior[kind] = clampNumber(stepClamp(base, rawBehavior[kind], clamp), BOUNDS.weight.min, BOUNDS.weight.max)
    }

    const changes = []
    const push = (key, was, now) => {
      const a = Number(Number(was).toFixed(4))
      const b = Number(Number(now).toFixed(4))
      if (a === b) return
      changes.push({ key, before: a, after: b })
    }
    for (const name of Object.keys(nextTool)) push(`toolWeight.${name}`, before.toolWeight[name] ?? 1, nextTool[name])
    for (const kind of Object.keys(nextBehavior)) {
      push(`behaviorWeight.${kind}`, before.behaviorWeight[kind] ?? 1, nextBehavior[kind])
    }

    // 4) 说话参数：同样是先算目标，再钳制，再卡区间，最后取整
    const styleParams = { ...before.styleParams }
    const tuneInt = (key, bounds, reward) => {
      if (!Number.isFinite(reward)) return
      const was = Number(styleParams[key])
      const target = was * (1 + ema * clampNumber(reward, -1, 1))
      const clamped = clampNumber(stepClamp(was, clampNumber(target, bounds.min, bounds.max), clamp), bounds.min, bounds.max)
      const next = Math.round(clamped)
      if (next === was) return
      styleParams[key] = next
      changes.push({ key: `styleParams.${key}`, before: was, after: next })
    }
    tuneInt('maxParts', BOUNDS.maxParts, rewards.maxParts)

    let netDecay = Number(before.netDecay)
    const decayReward = Number(rewards.netDecay)
    if (Number.isFinite(decayReward)) {
      const target = netDecay * (1 + ema * clampNumber(decayReward, -1, 1))
      const next = Number(
        clampNumber(
          stepClamp(netDecay, clampNumber(target, BOUNDS.netDecay.min, BOUNDS.netDecay.max), clamp),
          BOUNDS.netDecay.min,
          BOUNDS.netDecay.max,
        ).toFixed(3),
      )
      if (next !== Number(netDecay.toFixed(3))) {
        changes.push({ key: 'netDecay', before: Number(netDecay.toFixed(3)), after: next })
        netDecay = next
      }
    }

    if (!changes.length) {
      // 没有实质变化：不涨版本号，也不留垃圾记录
      return { ok: true, version: this.state.version, changes: [] }
    }

    const version = this.state.version + 1
    const weights = { toolWeight: nextTool, behaviorWeight: nextBehavior, styleParams, netDecay }
    this.state.version = version
    this.state.at = at
    this.state.weights = weights
    this.state.versions.push({ version, at, weights: cloneWeights(weights) })
    this.state.versions.sort((a, b) => a.version - b.version)
    while (this.state.versions.length > this.options.keepVersions) this.state.versions.shift()

    const win = this.options.window
    for (const change of changes) {
      this.state.changes.push({
        at,
        version,
        key: change.key,
        before: change.before,
        after: change.after,
        reason,
        sample: sample.slice(0, 20),
        win,
      })
    }
    this.state.changes = this.state.changes.slice(-500)

    const delta = Number(input.responseDelta)
    this.state.batches.push({
      version,
      fromVersion: version - 1,
      at,
      responseDelta: Number.isFinite(delta) ? delta : null,
    })
    this.state.batches = this.state.batches.slice(-4)

    // 连续两轮响应率下降 → 自动回滚并暂停 24 小时
    const risk = this.#risk()
    if (risk) {
      this.rollback(risk.to, { at, reason: '连续两轮响应率下降，自动回滚' })
      this.pause(24, at)
      // 清空批次，否则下一轮还会看到同样两条负值，变成「每轮都回滚」的死循环
      this.state.batches = []
      return { ok: true, version: this.state.version, changes, autoRolledBack: true, rollbackTo: risk.to }
    }

    return { ok: true, version, changes }
  }

  /** 最近两轮都在掉，就回滚到更早那一轮之前 */
  #risk() {
    const usable = this.state.batches.filter((item) => Number.isFinite(item.responseDelta))
    if (usable.length < 2) return null
    const last2 = usable.slice(-2)
    if (!(last2[0].responseDelta < 0 && last2[1].responseDelta < 0)) return null
    const oldest = last2[0].fromVersion
    const target = this.state.versions.filter((item) => item.version <= oldest).pop()
    if (!target) return null
    return { to: target.version }
  }

  /**
   * 回滚到某一版。不删历史，只追加一条 rollback 记录，版本号继续往前走。
   * @param {number} version
   * @param {{at?: number, reason?: string}} [meta]
   */
  rollback(version, meta = {}) {
    const target = this.state.versions.find((item) => item.version === Number(version))
    if (!target) return { ok: false, error: `没有第 ${version} 版可以回滚` }
    const at = Number(meta.at) || Date.now()
    const newVersion = this.state.version + 1
    const restored = cloneWeights(target.weights)
    this.state.changes.push({
      at,
      version: newVersion,
      key: '*',
      kind: 'rollback',
      before: this.state.version,
      after: target.version,
      reason: String(meta.reason || `回滚到第 ${target.version} 版`),
      sample: [],
      win: this.options.window,
    })
    this.state.changes = this.state.changes.slice(-500)
    this.state.weights = restored
    this.state.version = newVersion
    this.state.at = at
    this.state.versions.push({ version: newVersion, at, weights: cloneWeights(restored) })
    this.state.versions.sort((a, b) => a.version - b.version)
    while (this.state.versions.length > this.options.keepVersions) this.state.versions.shift()
    return { ok: true, version: newVersion, restoredFrom: target.version }
  }

  /** 暂停进化（默认 24 小时） */
  pause(hours = 24, at = Date.now()) {
    this.state.pausedUntil = Number(at) + Math.max(1, Number(hours) || 24) * 3600_000
    return { ok: true, pausedUntil: this.state.pausedUntil }
  }

  /** 手动恢复 */
  resume() {
    this.state.pausedUntil = 0
    return { ok: true }
  }

  /** 落盘用 */
  toJSON() {
    return {
      version: this.state.version,
      at: this.state.at,
      pausedUntil: this.state.pausedUntil,
      weights: cloneWeights(this.state.weights),
      versions: this.state.versions.map((item) => ({ version: item.version, at: item.at, weights: cloneWeights(item.weights) })),
      changes: this.state.changes.slice(-500),
      batches: this.state.batches.slice(-4),
    }
  }

  /**
   * 把进化出来的说话参数，落到「配置允许的范围内」。
   * 配置是用户定的硬上限，进化只能在里面动 —— 否则用户把「一次最多 1 条」改了，
   * 进化两轮就把它顶回 3 条，等于用户的设置被悄悄推翻。
   *
   * 这里只有「一次几条」是可调的。
   *
   * 为什么没有「每条多少字」：那不是调优参数，是硬指标 ——
   * 用户填 150 就按 150 断，填 25 就按 25 断，两头都不对：
   * 一头把人话变成节拍器，另一头让进化悄悄换掉用户的设置。
   * 现在断句只认语义边界（换行 + 站得住的逗号），没有字数上限。
   *
   * @param {object} config 完整配置对象
   * @returns {{ maxParts: number }}
   */
  styleParamsFor(config) {
    const capParts = Number(config?.persona?.maxParts)
    const weights = this.state.weights.styleParams
    // 一条都没学过时（version 0），直接按用户设的值来。
    // 否则用户把「一次最多几条」从 3 调到 4，界面说改好了，实际还是 3 ——
    // 默认权重把用户的设置压住了，这属于「设置静默无效」，最难排查的一类。
    const learned = Number(this.state.version) > 0
    const wantParts = learned
      ? Number(weights.maxParts)
      : (Number.isFinite(capParts) ? capParts : Number(weights.maxParts))
    const maxParts = Math.max(
      BOUNDS.maxParts.min,
      Math.min(BOUNDS.maxParts.max, Math.round(wantParts), Number.isFinite(capParts) ? Math.round(capParts) : BOUNDS.maxParts.max),
    )
    return { maxParts }
  }

  /** 记忆网络衰减（夹在区间内） */
  netDecayFor(config) {
    const cap = Number(config?.memory?.net?.decay)
    const weights = this.state.weights.netDecay
    return clampNumber(
      Math.min(weights, Number.isFinite(cap) ? cap : BOUNDS.netDecay.max),
      BOUNDS.netDecay.min,
      BOUNDS.netDecay.max,
    )
  }
}

export { BEHAVIOR }
