/**
 * 出口闸门用例（decide/speech.mjs）。
 *
 * guardPlan 0.46.0 从 voice/say.mjs 搬到这里：它判「该不该说」，不是「怎么说」。
 * 规则一条没改，但归属变了 —— 用例也跟着搬，免得出题人说「这条测的是表达层」。
 */

import assert from 'node:assert/strict'
import { guardPlan } from '../decide/index.mjs'

let passed = 0
async function check(name, fn) {
  await fn()
  passed += 1
  console.log('  ✓ ' + name)
}

await check('计划闸门：没计划不许跑，计划太长也不许', () => {
  assert.equal(guardPlan([]).ok, false)
  assert.match(guardPlan([]).reason, /先写清楚要做什么/)
  assert.equal(guardPlan(['一', '二', '三', '四', '五', '六']).ok, false)
  assert.equal(guardPlan(['一个字' + '啊'.repeat(70)]).ok, false)
  const good = guardPlan(['取记录', '画图'])
  assert.equal(good.ok, true)
  assert.deepEqual(good.plan, ['取记录', '画图'])
  assert.equal(guardPlan('直接说一句话').ok, true, '字符串也算计划')
})

await check('计划闸门：空白项不算一步，空字符串不等于有计划', () => {
  assert.equal(guardPlan(['  ', '\n']).ok, false, '全是空白等于没写')
  assert.deepEqual(guardPlan(['  取记录  ']).plan, ['取记录'], '前后空格要剪掉')
  assert.equal(guardPlan(null).ok, false)
  assert.equal(guardPlan(undefined).ok, false)
})

await check('计划闸门：不再从 voice 门面露出（归属唯一）', async () => {
  const voice = await import('../voice/index.mjs')
  assert.equal('guardPlan' in voice, false, 'voice 门面不该再有 guardPlan：一个符号只能有一个来源')
})

console.log(`\n✓ 出口闸门用例：${passed} 项通过`)
