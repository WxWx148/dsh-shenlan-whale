/**
 * 面板清单的离线用例：登记完整性、可改性分级、校验、覆盖率。
 * 这些断言的作用是「结构上防止漏项」，不是测试 UI。
 */

import assert from 'node:assert/strict'
import {
  PANEL_ITEMS,
  PANEL_GROUPS,
  LEVEL,
  RISK,
  itemsOf,
  editable,
  readonlyItems,
  needsConfirm,
  needsRestart,
  find,
  describe,
  validate,
  coverage,
  summary,
} from '../lib/panel.mjs'

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

console.log('\n面板清单')

await check('每条都有中文名，没有「看不见的配置」', () => {
  const unnamed = PANEL_ITEMS.filter((item) => !item.label || !String(item.label).trim())
  assert.deepEqual(unnamed.map((item) => item.key), [], '每项都必须有 label')
})

await check('每条都归到一个已声明的分组', () => {
  const known = new Set(PANEL_GROUPS.map((group) => group.id))
  const strangers = PANEL_ITEMS.filter((item) => !known.has(item.group))
  assert.deepEqual(strangers.map((item) => item.key), [], '不能有野分组')
})

await check('分组顺序表里的每个组都有内容（不留空页）', () => {
  for (const group of PANEL_GROUPS) {
    assert.ok(itemsOf(group.id).length > 0, `分组「${group.label}」是空的`)
  }
})

await check('key 不重复', () => {
  const keys = PANEL_ITEMS.map((item) => item.key)
  assert.equal(new Set(keys).size, keys.length)
})

await check('每条的 level 与 risk 都在闭集里', () => {
  for (const item of PANEL_ITEMS) {
    assert.ok(Object.values(LEVEL).includes(item.level), `${item.key} 的 level 非法：${item.level}`)
    assert.ok(Object.values(RISK).includes(item.risk), `${item.key} 的 risk 非法：${item.risk}`)
  }
})

await check('只读项一律是 readonly，可改项一律不是', () => {
  for (const item of PANEL_ITEMS) {
    if (item.kind === 'readonly') {
      assert.equal(item.level, LEVEL.READONLY, `${item.key} 是只读类型却不是 readonly 档`)
    } else {
      assert.notEqual(item.level, LEVEL.READONLY, `${item.key} 可改却标了只读档`)
    }
  }
})

await check('状态类全部只读，且都说明了数据来源', () => {
  const statuses = readonlyItems()
  assert.ok(statuses.length >= 20, `状态项应有 20 条以上，实际 ${statuses.length}`)
  for (const item of statuses) {
    assert.ok(item.source, `${item.key} 缺 source，面板不知道怎么取数`)
  }
})

await check('改不了的东西明确说「只能看」', () => {
  assert.match(describe('status.todayTokens'), /只能看/)
  assert.equal(validate('status.todayTokens', 100).ok, false)
})

await check('数字项：上下限真的拦得住', () => {
  assert.equal(validate('guard.perMinute', 5).ok, true)
  assert.equal(validate('guard.perMinute', 0).ok, false, '低于下限应拒绝')
  assert.equal(validate('guard.perMinute', 999).ok, false, '高于上限应拒绝')
  assert.equal(validate('guard.perMinute', 'abc').ok, false, '非数字应拒绝')
  assert.equal(validate('guard.perMinute', '12').value, 12, '数字字符串应转成数字')
})

// 事故回归：带 scale 的时长项，历史上有人把「秒」的数值直接写进 config.json
// （0.3 → 0.3 毫秒 = 秒回）。换算不能只靠前端 —— 绕过前端的写入照样会中招。
// 服务端按**存储单位**判定并如实拒绝，不猜「你是不是想填秒」——
// 猜错会把「想快点回」放大成「等 10 秒」，比拒绝更难查。
await check('带单位的时长项：低于下限的值拒绝，并把单位说清楚', () => {
  const bad = validate('guard.firstDelayMs', 0.0003)
  assert.equal(bad.ok, false, '0.3 毫秒低于 0.3 秒下限，应拒绝')
  assert.match(bad.error, /不能小于 0\.3 秒/)
})

await check('带单位的时长项：合法毫秒值原样保留，不许重复换算', () => {
  const ok = validate('guard.firstDelayMs', 2500)
  assert.equal(ok.ok, true)
  assert.equal(ok.value, 2500, '2500 毫秒本来就是对的，不许再乘一次 1000')
})

await check('带单位的时长项：超过上限的照样拒绝', () => {
  assert.equal(validate('guard.firstDelayMs', 40_000).ok, false, '40 秒超过 30 秒上限')
})

await check('开关项：只认布尔与 true/false 字符串', () => {
  assert.deepEqual(validate('memory.enabled', true), { ok: true, value: true })
  assert.deepEqual(validate('memory.enabled', 'false'), { ok: true, value: false })
  assert.equal(validate('memory.enabled', 'yes').ok, false)
})

await check('枚举项：不在选项里的值拒绝，并把可选值告诉他/她', () => {
  const bad = validate('sandbox.mode', 'open')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /free \/ ask \/ off/)
  assert.equal(validate('sandbox.mode', 'free').ok, true)
})

await check('文本框：超长被拦，空值允许（清空是合法操作）', () => {
  assert.equal(validate('persona.name', 'x'.repeat(30)).ok, false)
  assert.equal(validate('persona.name', '').ok, true)
})

await check('危险项必须二次确认，普通项不用', () => {
  assert.equal(needsConfirm('sandbox.mode'), true, '自治档位是危险项')
  assert.equal(needsConfirm('identity.ownerId'), true, '改我的号会锁死自己')
  assert.equal(needsConfirm('guard.perMinute'), false)
  assert.equal(needsConfirm('不存在的键'), false)
})

await check('要重启的项明确标注，不需要的不会误报', () => {
  assert.equal(needsRestart('channel.wsUrl'), true)
  // log.level 0.30.1 起即时生效（每次打印时现读配置），不再是重启项
  assert.equal(needsRestart('log.level'), false)
  assert.equal(needsRestart('guard.perMinute'), false)
})

await check('生效时机说清楚（这是最容易让人以为「改了没反应」的地方）', () => {
  assert.match(describe('guard.perMinute'), /下一条消息就生效/)
  assert.match(describe('channel.wsUrl'), /重启/)
  assert.match(describe('sandbox.mode'), /先让你确认/)
})

await check('敏感项标了 secret，面板只显示「已配置 / 未配置」', () => {
  for (const key of ['channel.token', 'channel.login.password']) {
    assert.equal(find(key).secret, true, `${key} 应标记 secret`)
  }
})

await check('覆盖率：配置里新增一个键、清单没跟上就报缺', () => {
  const configKeys = PANEL_ITEMS.filter((item) => item.level !== LEVEL.READONLY).map((item) => item.key)
  const full = coverage(configKeys)
  assert.equal(full.ok, true, '全登记时应通过')
  assert.equal(full.ratio, 1)

  // 模拟「加了个配置项，忘了在面板登记」——这正是旧版 169 键只有 26 个能改的成因
  const added = coverage(configKeys.concat('guard.brandNewKey'))
  assert.equal(added.ok, false)
  assert.deepEqual(added.missing, ['guard.brandNewKey'])
  assert.ok(added.ratio < 1, '漏登记时覆盖率必须下降')
})

await check('覆盖率：清单里有、配置里没有的也算问题（删配置忘了删面板）', () => {
  const configKeys = PANEL_ITEMS.filter((item) => item.level !== LEVEL.READONLY).map((item) => item.key)
  const removed = configKeys.filter((key) => key !== 'log.redact')
  const result = coverage(removed)
  assert.equal(result.ok, false)
  assert.deepEqual(result.extra, ['log.redact'])
})

await check('汇总：数字对得上，一句话说清可改性', () => {
  const s = summary()
  assert.equal(s.total, PANEL_ITEMS.length)
  assert.equal(s.editable + s.readonly, s.total)
  assert.equal(s.readonly, readonlyItems().length)
  assert.match(s.line, /\d+ 项状态全部可见/)
  assert.match(s.line, /可以直接改/)
})

await check('可改项数量确实过半（不然「能改」是空话）', () => {
  const e = editable()
  assert.ok(e.length >= 40, `可改项应有 40 条以上，实际 ${e.length}`)
})

await check('找不到的键给出明确提示，不静默', () => {
  assert.equal(find('nope'), null)
  assert.match(describe('nope'), /没有这一项/)
  assert.equal(validate('nope', 1).ok, false)
})

console.log(`\n${failed.length ? '✗' : '✓'} 面板清单用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
