/**
 * 用量与计费用例。
 *
 * 这一层最容易错的是「单位」：每百万写成每千，账单差一千倍，而数字看起来还挺合理。
 * 所以每条计价用例都写死期望值，不靠目测。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Journal } from '../base/journal.mjs'
import { Usage } from '../facts/index.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}`)
  }
}

const BASE = new Date(2026, 9, 29, 14, 0, 0).getTime()
const cfg = (over = {}) => ({ usage: { currency: 'CNY', inputPerM: 2, outputPerM: 8, budgetPerDay: 5, ...over } })
const dirs = []
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-'))
  dirs.push(dir)
  return dir
}
function withJournal(over) {
  const dir = sandbox()
  const journal = new Journal({ dir, name: 'usage', now: () => BASE })
  return { usage: new Usage({ config: cfg(over), journal, now: () => BASE }), dir }
}

await check('单价按「每百万 token」算：1M 输入 = 2 元', () => {
  const usage = new Usage({ config: cfg(), now: () => BASE })
  assert.equal(usage.cost(1_000_000, 0), 2)
  assert.equal(usage.cost(0, 1_000_000), 8)
})

await check('混合计费：输入 50 万 + 输出 25 万 = 3 元', () => {
  const usage = new Usage({ config: cfg(), now: () => BASE })
  assert.equal(usage.cost(500_000, 250_000), 3)
})

await check('脏用量不会把账算成 NaN（接口偶尔返回不干净的值）', () => {
  const usage = new Usage({ config: cfg(), now: () => BASE })
  assert.equal(usage.cost(NaN, undefined), 0)
  assert.equal(usage.cost(-100, -100), 0, '负数按 0 处理，不能倒赚')
  assert.equal(usage.cost('abc', null), 0)
})

await check('记一笔之后累计对得上', () => {
  const usage = new Usage({ config: cfg(), now: () => BASE })
  const result = usage.record(100_000, 50_000, { at: BASE })
  assert.equal(result.cost, 0.6)
  assert.equal(result.total.input, 100_000)
  assert.equal(result.total.output, 50_000)
  assert.equal(result.total.calls, 1)
})

await check('今天没超预算：over = false，还剩多少算得出来', () => {
  const usage = new Usage({ config: cfg(), now: () => BASE })
  usage.record(100_000, 50_000, { at: BASE })
  const today = usage.today(BASE)
  assert.equal(today.over, false)
  assert.equal(today.left, 4.4)
})

await check('一句话里所有金额都是两位小数（曾经出现过「预算还剩 1.600683」）', () => {
  const usage = new Usage({ config: cfg(), now: () => BASE })
  usage.record(100_000, 50_000, { at: BASE })
  const line = usage.line(BASE)
  // 同一句话里一半是「¥0.60」一半是「4.4000000000000004」，
  // 看的人会以为后者是内部数值而不是钱。
  assert.match(line, /约 ¥0\.60/)
  assert.match(line, /预算还剩 ¥4\.40/, line)
  const over = new Usage({ config: cfg({ budgetPerDay: 0.5 }), now: () => BASE })
  over.record(100_000, 50_000, { at: BASE })
  assert.match(over.line(BASE), /已超过 ¥0\.50 的预算/, over.line(BASE))
})

await check('超预算能当场发现（不让用户第二天对账才知道）', () => {
  const usage = new Usage({ config: cfg({ budgetPerDay: 0.5 }), now: () => BASE })
  const result = usage.record(100_000, 50_000, { at: BASE })
  assert.equal(result.overBudget.over, true)
})

await check('预算填 0 = 不设上限，不是「一分钱都不许花」', () => {
  const usage = new Usage({ config: cfg({ budgetPerDay: 0 }), now: () => BASE })
  usage.record(10_000_000, 0, { at: BASE })
  assert.equal(usage.today(BASE).over, false)
  assert.equal(usage.today(BASE).left, null)
})

await check('账本落盘：换个实例还能读到今天的账（重启不丢）', () => {
  const { usage, dir } = withJournal()
  usage.record(200_000, 100_000, { at: BASE })

  const journal2 = new Journal({ dir, name: 'usage', now: () => BASE })
  const again = new Usage({ config: cfg(), journal: journal2, now: () => BASE })
  const today = again.today(BASE)
  assert.equal(today.input, 200_000)
  assert.equal(today.output, 100_000)
  assert.equal(today.calls, 1)
})

await check('昨天的钱不算进今天（跨天归零）', () => {
  const { usage } = withJournal()
  const yesterday = BASE - 24 * 3600 * 1000
  usage.record(500_000, 0, { at: yesterday })
  const today = usage.today(BASE)
  assert.equal(today.cost, 0, '今天还没花钱')
})

await check('一句话能说清今天花了多少、还剩多少', () => {
  const usage = new Usage({ config: cfg(), now: () => BASE })
  usage.record(100_000, 50_000, { at: BASE })
  const line = usage.line(BASE)
  assert.match(line, /¥0\.60/)
  assert.match(line, /预算还剩/)
})

await check('超预算时那句话要直说超了，不粉饰', () => {
  const usage = new Usage({ config: cfg({ budgetPerDay: 0.5 }), now: () => BASE })
  usage.record(100_000, 50_000, { at: BASE })
  assert.match(usage.line(BASE), /已超过/)
})

await check('换成美元符号也认（币种是配置项，不是写死的）', () => {
  const usage = new Usage({ config: cfg({ currency: 'USD' }), now: () => BASE })
  usage.record(100_000, 0, { at: BASE })
  assert.match(usage.line(BASE), /^\$|约 \$/)
})

await check('累计总用量：跨天累加，不跟着按天账一起被裁掉', () => {
  const dir = sandbox()
  const file = path.join(dir, 'usage.json')
  const usage = new Usage({ config: cfg(), file, now: () => BASE })
  // 造 100 天，每天一笔。按天账只留 90 天，累计值必须仍是 100 天的总和
  for (let day = 0; day < 100; day += 1) {
    usage.record(1000, 500, { at: BASE - day * 86_400_000 })
  }
  const total = usage.total(BASE)
  assert.equal(total.input, 100_000)
  assert.equal(total.output, 50_000)
  assert.equal(total.tokens, 150_000)
  assert.equal(total.calls, 100)
  assert.equal(total.lifetime, true)
  assert.equal(total.days, 90, '按天账该被裁到 90 天')
  // 重启之后累计值还在，不会重新从 0 开始
  const again = new Usage({ config: cfg(), file, now: () => BASE })
  assert.equal(again.total(BASE).calls, 100)
})

await check('累计总用量：老账本没有 total 时按现有天数补算，并写明从哪天起', () => {
  const dir = sandbox()
  const file = path.join(dir, 'usage.json')
  writeFileSync(file, JSON.stringify({
    days: {
      '2026-10-27': { input: 1000, output: 200, calls: 3, cost: 0.1 },
      '2026-10-28': { input: 2000, output: 400, calls: 4, cost: 0.2 },
    },
  }), 'utf8')
  const usage = new Usage({ config: cfg(), file, now: () => BASE })
  const total = usage.total(BASE)
  assert.equal(total.tokens, 3600)
  assert.equal(total.calls, 7)
  assert.equal(total.since, '2026-10-27', '起点要写最早那一天，不能空着')
  // 补算的结果要落盘：重启后不该再按 days 重算一遍
  const again = new Usage({ config: cfg(), file, now: () => BASE })
  assert.equal(again.total(BASE).tokens, 3600)
})

await check('累计总用量：没有账本时说清这是「本次启动以来」，不冒充历史', () => {
  const usage = new Usage({ config: cfg(), now: () => BASE })
  usage.record(1000, 1000, { at: BASE })
  const total = usage.total(BASE)
  assert.equal(total.tokens, 2000)
  assert.equal(total.lifetime, false)
})

await check('一次推理摊成三行：token 要全，次数只算一次', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-split-'))
  dirs.push(dir)
  const usage = new Usage({ config: { usage: { inputPerM: 2, outputPerM: 2 } }, file: path.join(dir, 'usage.json'), now: () => BASE })
  for (let index = 0; index < 3; index += 1) {
    usage.record(300, 20, { at: BASE, source: 'tool', calls: index === 0 ? 1 : 0 })
  }
  const today = usage.today(BASE)
  assert.equal(today.input, 900)
  assert.equal(today.output, 60)
  // 摊三行不等于问三次模型：今天与累计必须是同一个数，否则面板两处会互相矛盾
  assert.equal(today.calls, 1)
  assert.equal(usage.total(BASE).calls, 1)
})

await check('会计上老账本没有 calls 字段：一条按一次算，不能变 0', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-legacy-'))
  dirs.push(dir)
  const journal = new Journal({ dir, name: 'audit', now: () => BASE })
  journal.append({ kind: 'usage', at: BASE, input: 100, output: 10, cost: 0.0002 })
  const usage = new Usage({ config: {}, journal, now: () => BASE })
  assert.equal(usage.today(BASE).calls, 1)
})

await check('账本缺当天记录时按审计重算：噪音行不能把翻页截断（否则今天显示 0）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-noise-'))
  dirs.push(dir)
  const journal = new Journal({ dir, name: 'audit', now: () => BASE })
  // 先写今天的 3 条真账，再用 500 条「没有 at 字段」的噪音把它们挤到第一页之外
  journal.append({ kind: 'usage', at: BASE - 3600_000, input: 100, output: 10, cost: 0.0002, calls: 1, source: 'chat' })
  journal.append({ kind: 'usage', at: BASE - 1800_000, input: 100, output: 10, cost: 0.0002, calls: 1, source: 'chat' })
  journal.append({ kind: 'usage', at: BASE - 600_000, input: 100, output: 10, cost: 0.0002, calls: 1, source: 'chat' })
  for (let i = 0; i < 500; i += 1) journal.append({ kind: 'channel_state', at: BASE - 60_000 + i })
  // 账本文件不存在 → data.days 为空 → today() 必须回落到审计逐页翻
  const usage = new Usage({ config: cfg(), journal, file: path.join(dir, 'usage.json'), now: () => BASE })
  const today = usage.today(BASE)
  assert.equal(today.input, 300, '三条真账一条都不能少')
  assert.equal(today.calls, 3, '次数也不能少')
})

await check('预算正好用完就算用尽：面板显示「还剩 0」却还在花钱是自相矛盾', () => {
  const usage = new Usage({ config: cfg({ budgetPerDay: 1 }), now: () => BASE })
  // 100000 in + 100000 out = 0.2 + 0.8 = 1.00 元，正好等于预算
  usage.record(100000, 100000, { at: BASE, source: 'chat' })
  const today = usage.today(BASE)
  assert.equal(today.cost, 1, '正好花到 1 元')
  assert.equal(today.left, 0, '余额归零')
  assert.equal(today.over, true, '余额归零就该算用尽，不能还显示「没超」')
  assert.equal(usage.overBudget(BASE).over, true)
})

await check('预算为 0 表示不设上限，不算超', () => {
  const usage = new Usage({ config: cfg({ budgetPerDay: 0 }), now: () => BASE })
  usage.record(100000, 100000, { at: BASE, source: 'chat' })
  assert.equal(usage.today(BASE).over, false, '没设上限就不该报超')
  assert.equal(usage.today(BASE).left, null, '没设上限就没有「剩余」')
})

for (const dir of dirs) rmSync(dir, { recursive: true, force: true })

console.log(`\n${failed.length ? '✗' : '✓'} 计费用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.message}`)
  process.exit(1)
}
