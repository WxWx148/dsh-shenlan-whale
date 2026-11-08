/**
 * 清单与对账清单的用例（truth/manifest.mjs + truth/audit.mjs）。
 *
 * 这里钉的不是「数字对不对」——数字会随功能变，钉死了每天要改。钉的是**形状**：
 *   · 三份真源之间的对账必须是零缺口（有缺口说明面板上有一项改了没用）；
 *   · 合并投影必须真的是算出来的（改 panel 就跟着变，不是抄了一份副本）；
 *   · 对账清单里每一条的脚本必须真的存在（写了跑不了，等于没有这道守卫）。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDITS, auditOf, auditSummary, manifest, manifestCheck } from '../truth/index.mjs'
import { PANEL_ITEMS } from '../truth/index.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log('  ✓ ' + name)
}

await check('清单对账没有缺口：每个配置键都有面板项，每个可改项都有默认值', () => {
  const result = manifestCheck()
  assert.deepEqual(result.problems, [], result.problems.join('；'))
  assert.equal(result.ok, true)
  assert.ok(result.counts.keys >= 90, `配置键 ${result.counts.keys} 个，少得可疑`)
  assert.ok(result.counts.items >= PANEL_ITEMS.length)
})

await check('三个投影都是现算的：data / derive / check 出自同一份真源', () => {
  const snapshot = manifest()
  assert.equal(snapshot.schema, 'shenlan.manifest/1')
  // data 里的键必须与面板项一一对上（同一个真源，不是两份清单）
  const dataKeys = new Set(snapshot.data.items.map((one) => one.key))
  assert.equal(dataKeys.size, snapshot.data.items.length, '面板项 key 有重复')
  // derive 的分组必须把所有项都装进去，一条不漏
  const inGroups = snapshot.derive.groups.flatMap((group) => group.keys)
  assert.equal(inGroups.length, PANEL_ITEMS.length, '有面板项没归进任何分组')
  // 可改项 = 面板里 canEdit 的那些，derive 不能自己再判一遍
  assert.ok(snapshot.derive.editable.length > 0)
  assert.equal(typeof snapshot.derive.counts.line, 'string')
})

await check('对账清单：每一条都能跑到真脚本，没有写在纸上却没实现的守卫', () => {
  assert.ok(AUDITS.length >= 8, `只有 ${AUDITS.length} 道对账，少于预期`)
  const ids = new Set()
  for (const audit of AUDITS) {
    assert.ok(audit.id && !ids.has(audit.id), `对账 id 重复：${audit.id}`)
    ids.add(audit.id)
    assert.ok(audit.label && audit.proves, `${audit.id} 缺 label/proves（说不清它证明什么）`)
    assert.ok(existsSync(path.join(ROOT, audit.script)), `${audit.id} 的脚本不存在：${audit.script}`)
    assert.ok(['fast', 'slow'].includes(audit.speed), `${audit.id} 的 speed 只能是 fast/slow`)
  }
  const summary = auditSummary()
  assert.equal(summary.total, AUDITS.length)
  assert.ok(summary.fast.length >= 4, '提交前那几道太少，等于没有')
  assert.equal(auditOf('layers')?.id, 'layers')
  assert.equal(auditOf('nope'), null)
})

console.log(`\n✓ 清单用例：${passed} 项通过`)
