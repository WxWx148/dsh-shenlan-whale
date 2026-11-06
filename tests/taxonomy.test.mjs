/**
 * 概念分类用例：域、区域、设置分组、状态项、详情形状，必须互相对得上。
 *
 * 为什么单独一份：面板上的东西分三层（域 → 区域 → 模块），设置还有第四层（分组）。
 * 任何一层多一个没人认领的名字，用户就会在两个地方看到同一个东西的两个叫法 ——
 * 这正是这次整理要消灭的问题。用例在这里做的不是「测功能」，是**测分类自洽**：
 *   · 每个区域必须落在一个已声明的域里；
 *   · 每个设置分组必须落在同一个域里，且必须能在设置页找到；
 *   · 每个只读项必须真的被 runtime.status() 算出来（不许有永远「—」的登记）；
 *   · 每张模块卡的详情 id 只能出现一次，且详情形状必须在闭集里。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { DOMAINS, DOMAIN_IDS, REGIONS, REGION_IDS, DETAIL_KIND_LIST, domainLabel, regionOfDetail } from '../lib/taxonomy.mjs'
import { PANEL_GROUPS, PANEL_ITEMS, LEVEL, itemsOf, readonlyItems } from '../lib/panel.mjs'
import { SKILL_GROUPS, CATALOG } from '../lib/skill.mjs'
import { Runtime } from '../lib/runtime.mjs'
import { Usage } from '../lib/usage.mjs'
import { panelView, detailView } from '../lib/panel-view.mjs'

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

const dir = mkdtempSync(path.join(tmpdir(), 'whale-taxonomy-'))
const runtime = new Runtime({ dir })
const usage = new Usage({ config: runtime.config, journal: runtime.audit, file: path.join(dir, 'usage.json') })
runtime.usage = usage

console.log('\n概念分类')

await check('七个域：名字、说明、id 都不重复', () => {
  assert.equal(DOMAINS.length, 7)
  assert.equal(new Set(DOMAIN_IDS).size, 7)
  for (const domain of DOMAINS) {
    assert.ok(/[\u4e00-\u9fa5]/.test(domain.label), `${domain.id} 的中文名要对`)
    assert.ok(domain.hint && domain.hint.trim(), `${domain.id} 缺一句说明`)
    assert.equal(domainLabel(domain.id), domain.label)
  }
  assert.equal(domainLabel('nope'), '未分类', '不认识的域不许猜')
})

await check('十个区域：每个都落在已声明的域里（概览/规则/设置除外）', () => {
  assert.equal(REGIONS.length, 10)
  assert.equal(new Set(REGION_IDS).size, 10)
  for (const region of REGIONS) {
    assert.ok(region.label && region.hint && region.icon, `${region.id} 缺名字/说明/图标`)
    if (region.domain !== null) {
      assert.ok(DOMAIN_IDS.includes(region.domain), `${region.id} 的域不认识：${region.domain}`)
    }
  }
  assert.equal(regionOfDetail('skills.talk'), 'skills')
  assert.equal(regionOfDetail('qq:group:123'), 'talk')
  assert.equal(regionOfDetail('rules.all'), 'rules')
  assert.equal(regionOfDetail('rules.gaps'), 'rules')
  assert.equal(regionOfDetail('nope.thing'), '')
})

await check('十二个设置分组：每个都有合法域，且都有内容', () => {
  // 0.30.0 删掉「面板与外观」那一组（独立端口服务没写过），从 13 组降到 12 组
  assert.equal(PANEL_GROUPS.length, 12)
  for (const group of PANEL_GROUPS) {
    assert.ok(DOMAIN_IDS.includes(group.domain), `分组 ${group.id} 的 domain 不合法`)
    assert.ok(itemsOf(group.id).length > 0, `分组 ${group.label} 是空的`)
  }
})

await check('每个域至少有一个设置分组（不许有一个域在设置里是空的）', () => {
  const covered = new Set(PANEL_GROUPS.map((group) => group.domain))
  const missing = DOMAIN_IDS.filter((id) => !covered.has(id))
  assert.deepEqual(missing, [], `这些域没有任何设置分组：${missing.join('、')}`)
})

await check('技能分组也归到同一套域里（不再另造一套世界）', () => {
  for (const group of SKILL_GROUPS) {
    assert.ok(DOMAIN_IDS.includes(group.domain), `技能分组 ${group.id} 的 domain 不合法：${group.domain}`)
    assert.ok(CATALOG.some((skill) => skill.group === group.id), `技能分组 ${group.id} 一个技能都没有`)
  }
})

await check('只读项与 runtime.status() 的键集合完全一致（不许有永远算不出的登记）', () => {
  const registered = readonlyItems().map((item) => item.key).sort()
  const produced = Object.keys(runtime.status()).sort()
  assert.deepEqual(registered, produced)
})

await check('可改项与只读项不重叠，合计等于全部登记项', () => {
  const keys = PANEL_ITEMS.map((item) => item.key)
  assert.equal(new Set(keys).size, keys.length, 'key 不许重复登记')
  const editable = PANEL_ITEMS.filter((item) => item.level !== LEVEL.READONLY)
  assert.equal(editable.length + readonlyItems().length, PANEL_ITEMS.length)
})

await check('设置页列出除只读组外的每一个分组（不能有「只有别处能找到」的例外）', () => {
  const page = panelView({ runtime, usage, at: 1 })
  const listed = page.regions.settings.modules.map((module) => module.detail)
  for (const group of PANEL_GROUPS) {
    if (group.id === 'status') continue
    assert.ok(listed.includes(`settings.${group.id}`), `设置页漏了「${group.label}」（settings.${group.id}）`)
  }
})

await check('同一区域内模块卡不重复；概览的入口卡可以跨区指（那是它的职责）', () => {
  const page = panelView({ runtime, usage, at: 1 })
  const owner = new Map()
  for (const region of REGIONS) {
    const one = page.regions[region.id]
    assert.ok(one && one.modules.length > 0, `${region.id} 一张卡都没有`)
    const local = new Set()
    for (const module of one.modules) {
      assert.ok(module.detail && module.detail.includes('.'), `${region.id} 有张卡没 detail：${module.label}`)
      assert.ok(!local.has(module.detail), `${region.id} 里同一张卡挂了两次：${module.detail}`)
      local.add(module.detail)
      if (!owner.has(module.detail)) owner.set(module.detail, [])
      owner.get(module.detail).push(region.id)
      const detail = detailView({ runtime, usage, at: 1, id: module.detail })
      assert.equal(detail.ok, true, `${module.detail} 打不开`)
      assert.ok(DETAIL_KIND_LIST.includes(detail.kind), `${module.detail} 的形状不认识：${detail.kind}`)
    }
  }
  // 跨区只允许两类例外：概览（摘要，本来就指向别处）与设置（索引，能改的都要能在这找到）。
  // 其余区域之间出现同一个 id，说明这张卡没想清楚该归谁。
  const INDEX_PAGES = new Set(['overview', 'settings'])
  for (const [id, regions] of owner) {
    if (regions.length > 1) {
      assert.ok(regions.some((one) => INDEX_PAGES.has(one)), `${id} 同时出现在 ${regions.join(' / ')}，但两边都不是索引页`)
    }
  }
})

await check('状态全表 = 登记项一项不少', () => {
  const one = detailView({ runtime, usage, at: 1, id: 'status.all' })
  assert.equal(one.kind, 'cards')
  assert.equal(one.cards.length, readonlyItems().length)
  // 没接账本/没接执行器时，算不出来的项必须写「—」，不许写 0
  const sandbox = one.cards.find((card) => card.label === '今日沙箱运行')
  assert.equal(sandbox.value, '—', '没有执行器时说「—」，不是 0')
})

await check('导航顺序 = REGIONS 顺序（浏览器与宿主不会各排一套）', () => {
  const page = panelView({ runtime, usage, at: 1 })
  assert.deepEqual(page.nav.map((one) => one.id), REGIONS.map((one) => one.id))
  for (const nav of page.nav) {
    const region = REGIONS.find((one) => one.id === nav.id)
    assert.equal(nav.label, region.label)
    assert.equal(nav.icon, region.icon)
  }
})

rmSync(dir, { recursive: true, force: true })

console.log(`\n${failed.length ? '✗' : '✓'} 概念分类用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
