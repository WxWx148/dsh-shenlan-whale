/**
 * 权重进化（evolve）用例：方向、钳制、越界、回滚、自动回滚、说话参数封顶。
 *
 * 这一层的每一条都对着「进化把人教坏」的具体方式：
 *   奖励为 0 时权重自己往下掉、一次跳太远、越跑越大、改坏了回不去。
 */

import assert from 'node:assert/strict'
import { BOUNDS, Evolver, defaultWeights, normalizeWeights, weightLabel } from '../lib/evolve.mjs'

let passed = 0
const failed = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed.push({ name, err })
    console.log(`  ✗ ${name}\n    ${err?.message ?? err}`)
  }
}

const EVIDENCE = { reason: '群里被 @ 后连续三轮被追问', sample: ['evt_1', 'evt_2'] }
const evolver = (options) => new Evolver({ options })

console.log('\n权重进化')

await check('默认权重：三类可优化行为各 1.0，管理与维护不在里面', () => {
  const weights = defaultWeights()
  assert.deepEqual(Object.keys(weights.behaviorWeight).sort(), ['activity', 'proactive', 'reply'])
  assert.equal(weights.styleParams.maxParts, 3)
  assert.equal(weights.styleParams.partChars, 20)
  assert.equal(weights.netDecay, 0.82)
})

await check('没证据不许动：缺 reason / 缺 sample 都拒', () => {
  const e = evolver()
  assert.equal(e.apply({ rewards: { behavior: { reply: 1 } } }).ok, false)
  assert.match(e.apply({ rewards: {}, reason: '想改' }).error, /缺 sample/)
  const noReason = e.apply({ rewards: {}, sample: ['e1'] })
  assert.equal(noReason.ok, false)
  assert.match(noReason.error, /缺 reason/)
  assert.equal(e.current().behaviorWeight.reply, 1, '被拒时权重不能动')
})

await check('方向正确：被追问加权重，被否定减权重', () => {
  const up = evolver()
  up.apply({ ...EVIDENCE, rewards: { behavior: { reply: 1 } } })
  assert.ok(up.current().behaviorWeight.reply > 1)

  const down = evolver()
  down.apply({ ...EVIDENCE, rewards: { behavior: { reply: -1 } } })
  assert.ok(down.current().behaviorWeight.reply < 1)
})

await check('奖励为 0 时权重**不变**（旧公式 ×0.9 会让所有权重慢性归零）', () => {
  const e = evolver({ ema: 0.1 })
  const before = e.current()
  const result = e.apply({ ...EVIDENCE, rewards: { behavior: { reply: 0 } } })
  assert.deepEqual(e.current(), before, '中性奖励不该改动任何权重')
  assert.deepEqual(result.changes, [], '没有变化就不该有变更记录')
  assert.equal(e.current().version, undefined, '权重对象本身不带版本号')
  assert.equal(result.version, 0, '没有变化就不涨版本号')
})

await check('单步钳制：学得再快，一版也只挪 clamp（默认 0.15）', () => {
  const e = evolver({ ema: 0.5, clamp: 0.15 })
  e.apply({ ...EVIDENCE, rewards: { behavior: { reply: 1 } } })
  const after = e.current().behaviorWeight.reply
  assert.ok(Math.abs(after - 1) <= 0.15 + 1e-9, `一版挪了 ${after - 1}，超过 0.15`)
})

await check('上下限真的拦得住：连着加也不会超过 3.0', () => {
  const e = evolver({ ema: 0.5, clamp: 0.15 })
  for (let i = 0; i < 60; i += 1) e.apply({ ...EVIDENCE, rewards: { tool: { search: 1 } } })
  const value = e.current().toolWeight.search
  assert.ok(value <= BOUNDS.weight.max + 1e-9, `应封顶 ${BOUNDS.weight.max}，实际 ${value}`)
  assert.ok(value >= BOUNDS.weight.min)
})

await check('连着减也不会低于 0.2（工具不会被判死刑）', () => {
  const e = evolver({ ema: 0.5, clamp: 0.15 })
  for (let i = 0; i < 60; i += 1) e.apply({ ...EVIDENCE, rewards: { tool: { search: -1 } } })
  assert.ok(e.current().toolWeight.search >= BOUNDS.weight.min - 1e-9)
})

await check('越界不再记录成变更（到顶了就是不动，别骗人）', () => {
  const e = evolver({ ema: 0.5, clamp: 0.15 })
  for (let i = 0; i < 40; i += 1) e.apply({ ...EVIDENCE, rewards: { tool: { search: 1 } } })
  const capped = e.current().toolWeight.search
  const result = e.apply({ ...EVIDENCE, rewards: { tool: { search: 1 } } })
  assert.equal(result.changes.length, 0, '已到上限，不该再产生变更')
  assert.equal(e.current().toolWeight.search, capped)
})

await check('每条变更都带证据：原因、样本、窗口', () => {
  const e = evolver({ window: 20 })
  e.apply({ ...EVIDENCE, rewards: { behavior: { reply: 1 } } })
  const json = e.toJSON()
  assert.ok(json.changes.length > 0)
  const one = json.changes[0]
  assert.equal(one.reason, EVIDENCE.reason)
  assert.deepEqual(one.sample, EVIDENCE.sample)
  assert.equal(one.win, 20)
  assert.equal(one.version, 1)
  assert.ok(one.after > one.before)
})

await check('说话参数：2–4 条 / 15–150 字，边界夹得住', () => {
  const e = evolver({ ema: 0.5, clamp: 0.15 })
  for (let i = 0; i < 40; i += 1) e.apply({ ...EVIDENCE, rewards: { maxParts: 1, partChars: 1 } })
  let params = e.current().styleParams
  assert.ok(params.maxParts <= BOUNDS.maxParts.max, `条数应 ≤ ${BOUNDS.maxParts.max}，实际 ${params.maxParts}`)
  assert.ok(params.partChars <= BOUNDS.partChars.max)

  const down = evolver({ ema: 0.5, clamp: 0.15 })
  for (let i = 0; i < 40; i += 1) down.apply({ ...EVIDENCE, rewards: { maxParts: -1, partChars: -1 } })
  params = down.current().styleParams
  assert.ok(params.maxParts >= BOUNDS.maxParts.min, `条数应 ≥ ${BOUNDS.maxParts.min}，实际 ${params.maxParts}`)
  assert.ok(params.partChars >= BOUNDS.partChars.min)
  assert.equal(Number.isInteger(params.maxParts), true, '条数必须是整数')
  assert.equal(Number.isInteger(params.partChars), true)
})

await check('用户配置是硬上限：进化值再大也压不过它', () => {
  const e = evolver({ ema: 0.5, clamp: 0.15 })
  for (let i = 0; i < 40; i += 1) e.apply({ ...EVIDENCE, rewards: { maxParts: 1 } })
  const params = e.styleParamsFor({ persona: { maxParts: 2, maxReplyChars: 18 } })
  assert.equal(params.maxParts, 2, '用户说一次最多 2 条，进化不许顶到 3')
  assert.equal(params.partChars, 18)
  // 学完之后，字数仍按用户设置走：设 150 就按 150 断，不能被默认权重 20 换掉
  assert.equal(e.styleParamsFor({ persona: { maxReplyChars: 150 } }).partChars, 150)
})

await check('记忆衰减：也在 0.75–0.9 之间，且尊重配置上限', () => {
  const e = evolver({ ema: 0.5, clamp: 0.15 })
  for (let i = 0; i < 40; i += 1) e.apply({ ...EVIDENCE, rewards: { netDecay: -1 } })
  const decay = e.netDecayFor({ memory: { net: { decay: 0.8 } } })
  assert.ok(decay >= BOUNDS.netDecay.min && decay <= 0.8)
})

await check('回滚：回到某一版，历史不删，版本号继续往前走', () => {
  const e = evolver({ ema: 0.5, clamp: 0.15 })
  e.apply({ ...EVIDENCE, rewards: { behavior: { reply: 1 } } })
  const v1 = e.current().behaviorWeight.reply
  e.apply({ ...EVIDENCE, rewards: { behavior: { reply: 1 } } })
  const v2 = e.current().behaviorWeight.reply
  assert.ok(v2 > v1)

  const result = e.rollback(0)
  assert.equal(result.ok, true)
  assert.equal(result.restoredFrom, 0)
  assert.equal(e.current().behaviorWeight.reply, 1, '应回到第 0 版')
  assert.ok(e.history().length >= 4, '历史版本不能被删')
  assert.ok(e.history().some((item) => item.version === result.version))
  assert.ok(e.toJSON().changes.some((change) => change.kind === 'rollback'), '回滚本身要留记录')
})

await check('回滚到不存在的版本：明确拒绝，权重不动', () => {
  const e = evolver()
  e.apply({ ...EVIDENCE, rewards: { behavior: { reply: 1 } } })
  const before = e.current()
  const result = e.rollback(99)
  assert.equal(result.ok, false)
  assert.match(result.error, /没有第 99 版/)
  assert.deepEqual(e.current(), before)
})

await check('连续两轮响应率下降 → 自动回滚 + 暂停 24 小时', () => {
  const e = evolver({ ema: 0.5, clamp: 0.15 })
  const at = 1_700_000_000_000
  e.apply({ ...EVIDENCE, at, rewards: { behavior: { reply: 1 } }, responseDelta: -0.2 })
  const second = e.apply({ ...EVIDENCE, at: at + 1000, rewards: { behavior: { reply: 1 } }, responseDelta: -0.2 })
  assert.equal(second.autoRolledBack, true)
  assert.equal(e.current().behaviorWeight.reply, 1, '应回到动手之前')
  assert.ok(e.summary(at + 2000).paused, '应自动暂停')

  const blocked = e.apply({ ...EVIDENCE, at: at + 2000, rewards: { behavior: { reply: 1 } } })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /暂停/)
})

await check('暂停期满可以继续，手动恢复也行', () => {
  const e = evolver()
  const at = 1_700_000_000_000
  e.pause(24, at)
  assert.equal(e.summary(at).paused, true)
  assert.equal(e.apply({ ...EVIDENCE, at, rewards: { behavior: { reply: 1 } } }).ok, false)
  assert.equal(e.apply({ ...EVIDENCE, at: at + 25 * 3600_000, rewards: { behavior: { reply: 1 } } }).ok, true)
  e.pause(1, at)
  e.resume()
  assert.equal(e.summary(at).paused, false)
})

await check('保留版本有上限：只留最近 N 版，不无限膨胀', () => {
  const e = evolver({ keepVersions: 3, ema: 0.5, clamp: 0.15 })
  for (let i = 0; i < 10; i += 1) e.apply({ ...EVIDENCE, rewards: { tool: { search: 1 } } })
  assert.ok(e.toJSON().versions.length <= 3, `版本应 ≤ 3，实际 ${e.toJSON().versions.length}`)
})

await check('磁盘上的坏权重：能读回来并夹回合法区间', () => {
  const weights = normalizeWeights({
    toolWeight: { a: 999, b: -5, c: 'x' },
    behaviorWeight: { reply: 50, admin: 2 },
    styleParams: { maxParts: 99, partChars: 1 },
    netDecay: 5,
  })
  assert.equal(weights.toolWeight.a, BOUNDS.weight.max)
  assert.equal(weights.toolWeight.b, BOUNDS.weight.min)
  assert.equal(weights.toolWeight.c, undefined, '非数字直接丢掉')
  assert.equal(weights.behaviorWeight.reply, BOUNDS.weight.max)
  assert.equal(weights.behaviorWeight.admin, undefined, '管理不该被进化参数污染')
  assert.equal(weights.styleParams.maxParts, BOUNDS.maxParts.max)
  assert.equal(weights.styleParams.partChars, BOUNDS.partChars.min)
  assert.equal(weights.netDecay, BOUNDS.netDecay.max)
})

await check('从磁盘状态恢复：版本、历史、暂停状态都还在', () => {
  const e = evolver()
  e.apply({ ...EVIDENCE, rewards: { behavior: { reply: 1 } } })
  const saved = e.toJSON()
  const again = new Evolver({ state: saved })
  assert.equal(again.summary().version, e.summary().version)
  assert.deepEqual(again.current(), e.current())
  assert.equal(again.history().length, e.history().length)
})

await check('权重名有人话（面板与审计不用各写一套）', () => {
  assert.equal(weightLabel('styleParams.maxParts'), '一次说几条')
  assert.equal(weightLabel('netDecay'), '记忆衰减')
  assert.equal(weightLabel('toolWeight.search'), '工具')
  assert.equal(weightLabel('*'), '回滚')
})

console.log(`\n${failed.length ? '✗' : '✓'} 权重进化用例：${passed} 项通过`)
if (failed.length) {
  for (const item of failed) console.log(`  ${item.name}: ${item.err?.message ?? item.err}`)
  process.exit(1)
}
