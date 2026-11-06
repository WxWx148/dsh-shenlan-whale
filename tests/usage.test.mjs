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
import { Journal } from '../lib/journal.mjs'
import { Usage } from '../lib/usage.mjs'

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

for (const dir of dirs) rmSync(dir, { recursive: true, force: true })

console.log(`\n${failed.length ? '✗' : '✓'} 计费用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.message}`)
  process.exit(1)
}
