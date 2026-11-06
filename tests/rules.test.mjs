/**
 * 规则清单用例：面板上那些「此刻生效的约束」必须对得上代码与现状。
 *
 * 这份用例防三件事：
 *   1. 规则写着、模块没了（改名/搬文件后最容易发生）；
 *   2. 规则里混进「以前 / 旧版」这类历史叙述 —— 面板只留现在，历史归变更看板；
 *   3. 规则页点不开，或分组漏了一条。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { RULES, GAPS, RULE_GROUPS, rulesOf, ruleGroupLabel } from '../lib/rules.mjs'
import { panelView, detailView } from '../lib/panel-view.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

const CONFIG = {
  guard: { firstDelayMs: 2000, perMinute: 7, replyQuotaPerHour: 30, mergeWindowMs: 2000 },
  group: { followUpSeconds: 180, followUpMaxTurns: 20 },
  tools: { maxRounds: 2, maxPerRound: 4 },
}

console.log('\n规则清单')

await check('五个分组：顺序、名字、说明都不重复，每组至少有一条规则', () => {
  assert.equal(RULE_GROUPS.length, 5)
  assert.equal(new Set(RULE_GROUPS.map((one) => one.id)).size, 5)
  assert.deepEqual(RULE_GROUPS.map((one) => one.id), ['rhythm', 'channel', 'turn', 'outbound', 'tools'])
  for (const group of RULE_GROUPS) {
    assert.ok(group.label && group.hint, `${group.id} 缺名字或说明`)
    assert.ok(rulesOf(group.id).length > 0, `${group.id} 一条规则都没有`)
    assert.equal(ruleGroupLabel(group.id), group.label)
    assert.equal(ruleGroupLabel('nope'), '')
  }
})

await check('每条规则都有名字、正文、模块、位置，且模块文件真的存在', () => {
  assert.ok(RULES.length >= 20, `规则太少，只有 ${RULES.length} 条`)
  const ids = new Set()
  for (const rule of RULES) {
    assert.ok(rule.id && !ids.has(rule.id), `规则 id 重复：${rule.id}`)
    ids.add(rule.id)
    assert.ok(rule.title && rule.title.trim(), `${rule.id} 缺名字`)
    assert.ok(rule.rule && rule.rule.trim(), `${rule.id} 缺正文`)
    assert.ok(rule.where && rule.where.trim(), `${rule.id} 缺位置`)
    assert.ok(RULE_GROUPS.some((group) => group.id === rule.group), `${rule.id} 的分组不认识：${rule.group}`)
    assert.ok(existsSync(path.join(ROOT, rule.module)), `${rule.id} 指向的模块不存在：${rule.module}`)
  }
})

await check('只写「现在」，不写「以前」：规则正文不许出现历史叙述', () => {
  const banned = /以前|原来|旧版|改前|上一版|旧的|变更看板|diff/i
  for (const rule of RULES) {
    assert.ok(!banned.test(rule.rule), `${rule.id} 的正文混进了旧状态：${rule.rule}`)
  }
  for (const gap of GAPS) {
    assert.ok(!banned.test(`${gap.desc}${gap.next}`), `${gap.id} 的描述混进了旧状态`)
  }
})

await check('现场值读当前配置：同一段规则在不同配置下给出不同数字', () => {
  const detail = detailView({ runtime: { config: CONFIG }, id: 'rules.all' })
  const byId = new Map(detail.rows.map((row) => [row.id, row]))
  assert.match(byId.get('attention.window').badge, /180 秒/)
  assert.match(byId.get('attention.window').badge, /20 轮/)
  assert.match(byId.get('typing.duration').badge, /2 秒/)
  assert.match(byId.get('turn.tools').badge, /2 轮/)
  assert.match(byId.get('guard.floor').badge, /每分钟 7 条/)

  const other = detailView({
    runtime: { config: { ...CONFIG, group: { followUpSeconds: 90, followUpMaxTurns: 6 }, guard: { ...CONFIG.guard, firstDelayMs: 500 }, tools: { maxRounds: 3, maxPerRound: 6 } } },
    id: 'rules.all',
  })
  const next = new Map(other.rows.map((row) => [row.id, row]))
  assert.match(next.get('attention.window').badge, /90 秒/)
  assert.match(next.get('attention.window').badge, /6 轮/)
  assert.match(next.get('typing.duration').badge, /0.5 秒/)
  assert.match(next.get('turn.tools').badge, /3 轮/)
})

await check('规则页按分组切开，全部规则里带分组小标题', () => {
  const page = panelView({})
  const modules = page.regions.rules.modules
  assert.deepEqual(modules.map((one) => one.detail), [
    'rules.all',
    'rules.rhythm',
    'rules.channel',
    'rules.turn',
    'rules.outbound',
    'rules.tools',
    'rules.gaps',
  ])
  const rhythm = modules.find((one) => one.detail === 'rules.rhythm')
  assert.match(rhythm.desc, /说话像不像人/)
  // 区域页按三段排：总表 / 五条链路 / 缺口。信息层级由 section 决定，前端只画标题。
  assert.deepEqual([...new Set(modules.map((one) => one.section))], ['总表', '按链路', '缺口'])

  // 设置页也按域分段：十二张卡不再是一堵平铺的墙。
  const settingSections = [...new Set(page.regions.settings.modules.map((one) => one.section))]
  assert.deepEqual(settingSections, ['身份', '表达', '心智', '自主', '能力', '花费', '运行', '提醒'])

  const all = detailView({ runtime: { config: CONFIG }, id: 'rules.all' })
  assert.equal(all.kind, 'rows')
  assert.equal(all.rows.length, RULES.length)
  assert.equal(all.search, true)
  for (const row of all.rows) {
    assert.ok(row.group, `${row.id} 在总表里缺分组标题`)
    assert.ok(row.desc, `${row.id} 缺正文`)
  }
  assert.equal(new Set(all.rows.map((row) => row.group)).size, RULE_GROUPS.length)

  const one = detailView({ runtime: { config: CONFIG }, id: 'rules.turn' })
  assert.equal(one.rows.length, rulesOf('turn').length)
  assert.ok(one.rows.every((row) => !row.group), '单组页面不再重复画分组标题')
})

await check('缺口单独一页：每条都有模块、下一步，且不把未接写成已支持', () => {
  assert.ok(GAPS.length >= 4)
  for (const gap of GAPS) {
    assert.ok(gap.title && gap.desc && gap.next, `${gap.id} 缺字段`)
    assert.ok(existsSync(path.join(ROOT, gap.module)), `${gap.id} 指向的模块不存在：${gap.module}`)
  }
  assert.ok(GAPS.some((gap) => gap.key === 'guard.mergeWindowMs'), '连发合并应点名 mergeWindowMs')
  const detail = detailView({ runtime: { config: CONFIG }, id: 'rules.gaps' })
  assert.equal(detail.kind, 'rows')
  assert.equal(detail.rows.length, GAPS.length)
  assert.ok(detail.rows.every((row) => row.badge === '还没接上'))
})

await check('连发合并列进缺口，设置里也明说只打标签、不会合并', () => {
  assert.ok(GAPS.some((gap) => gap.key === 'guard.mergeWindowMs'))
  // 它有消费者（打 burst 标签），所以不能塞进 PENDING_KEYS —— 那会破坏
  // 「名册 == 无消费者」这条断言。这里用缺口 + 说明文字把「没接」讲清楚。
  const detail = detailView({ runtime: { config: CONFIG }, id: 'settings.guard' })
  const item = detail.form.items.find((one) => one.key === 'guard.mergeWindowMs')
  assert.equal(item.pending, false)
  assert.match(item.hint, /只给连发打标签/)
  assert.match(item.hint, /不会真的合并/)
})

await check('空输入也不崩：没有运行时也能打开规则页', () => {
  for (const id of ['rules.all', 'rules.rhythm', 'rules.channel', 'rules.turn', 'rules.outbound', 'rules.tools', 'rules.gaps']) {
    const detail = detailView({ id })
    assert.equal(detail.ok, true, `${id} 打不开`)
    assert.equal(detail.kind, 'rows')
    assert.ok(detail.title)
  }
})

console.log(`\n${failed.length ? '✗' : '✓'} 规则清单用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
