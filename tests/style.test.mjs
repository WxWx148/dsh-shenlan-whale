/**
 * tests/style.test.mjs — 说话手感：实测口径、规则预算、分条
 *
 * 除了「像不像人说话」，这份测试还盯一件事：
 *   规则块不许再写长。凡是模型默认就会的、教它怎么思考的，一律不许出现在里面。
 */

import assert from 'node:assert/strict'
import { STYLE_PROFILE, styleGuide, splitBursts } from '../lib/style.mjs'

let passed = 0
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e?.message ?? e}`)
    throw e
  }
}

console.log('\n说话手感')

await check('实测口径：真人短句、他/她此前偏长', () => {
  assert.ok(STYLE_PROFILE.human.medianChars <= 10)
  assert.ok(STYLE_PROFILE.human.briefShare > 0.6)
  assert.equal(STYLE_PROFILE.human.periodEndShare, 0, '真人几乎不用句号收尾')
  assert.ok(STYLE_PROFILE.self.medianChars > STYLE_PROFILE.human.medianChars * 2)
  assert.ok(STYLE_PROFILE.human.burstMedian >= 3, '真人一次会说好几句')
})

await check('规则：只留实测差异项（短、分条、标点、语气词、口癖）', () => {
  const guide = styleGuide({ channel: 'private', maxParts: 3, maxChars: 20 })
  assert.match(guide, /2~15 字/)
  assert.match(guide, /一行一条/)
  assert.match(guide, /第一条先说结论/)
  assert.match(guide, /句尾不加句号/)
  assert.match(guide, /连接词/)
  assert.match(guide, /语气词该带就带/)
  assert.match(guide, /你说得对/)
  assert.match(guide, /私聊/)
})

await check('规则：不教模型怎么思考（删掉内部构造类指令）', () => {
  const guide = styleGuide({ channel: 'private' })
  for (const word of ['心里', '提纲', '排练', '先想', '不要先铺垫']) {
    assert.ok(!guide.includes(word), `规则里不该出现「${word}」这种内部构造指令`)
  }
})

await check('规则：字数与条数有预算，防止又写回一篇文章', () => {
  for (const channel of ['private', 'group']) {
    const guide = styleGuide({ channel })
    assert.ok(guide.length <= 220, `${channel} 规则块 ${guide.length} 字，超预算`)
    assert.ok(guide.split('\n').length <= 6, `${channel} 规则块行数过多`)
  }
})

await check('规则：群聊更短，不抢话', () => {
  const group = styleGuide({ channel: 'group', maxParts: 3, maxChars: 20 })
  const priv = styleGuide({ channel: 'private', maxParts: 3, maxChars: 20 })
  assert.match(group, /群里 1~2 条/)
  assert.ok(!priv.includes('群里 1~2 条'))
})

await check('规则：条数上限跟随配置，不写死', () => {
  assert.match(styleGuide({ maxParts: 2 }), /2~2 条/)
  assert.match(styleGuide({ maxParts: 5 }), /2~4 条/, '硬上限仍是 4')
})

await check('分条：换行即边界，句号抹掉', () => {
  assert.deepEqual(splitBursts('鱼呢\n在呢\n咋了', { maxChars: 20, maxParts: 4 }), ['鱼呢', '在呢', '咋了'])
  assert.deepEqual(splitBursts('我看看。\n好吧', { maxChars: 20, maxParts: 3 }), ['我看看', '好吧'])
  assert.deepEqual(splitBursts('', {}), [])
})

await check('分条：长句在断点处拆开，不留省略号', () => {
  const parts = splitBursts('今天下午服务器又抽风了，重启了一遍才恢复，麻烦死了', { maxChars: 12, maxParts: 4 })
  assert.ok(parts.length >= 2)
  assert.ok(parts.every((part) => part.length <= 12))
  assert.ok(parts.every((part) => !part.endsWith('…')))
})

await check('分条：条数超了合并，不丢内容', () => {
  const parts = splitBursts('一\n二\n三\n四\n五', { maxChars: 20, maxParts: 3 })
  assert.equal(parts.length, 3)
  assert.equal(parts.join('，'), '一，二，三，四，五')
})

await check('分条：超长无断点时硬切，也不加省略号', () => {
  const parts = splitBursts('啊'.repeat(50), { maxChars: 20, maxParts: 2 })
  assert.equal(parts.length, 2)
  assert.ok(parts.every((part) => part.length <= 20))
  assert.ok(!parts.join('').includes('…'))
})

await check('硬切不劈开 emoji：发出去不能是半个字符', () => {
  // 'ab' + 10 个 emoji，每 5 个编码单元切一刀 —— 第一刀之后就会落在表情中间。
  // 劈开之后 QQ 上显示的是「�」，而且原文再也拼不回来（另一半在下一句里）。
  const text = `ab${'😀'.repeat(10)}`
  const parts = splitBursts(text, { maxChars: 5, maxParts: 20 })
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  assert.deepEqual(parts.filter((part) => lone.test(part)), [], '不许出现孤立代理')
  assert.equal(parts.join(''), text, '内容要被完整保留，一个字都不能丢')

  // 由多个码位拼成的表情（👨‍👩‍👦）也不许被拆散
  const family = '👨‍👩‍👦'.repeat(3)
  const famParts = splitBursts(family, { maxChars: 3, maxParts: 20 })
  assert.deepEqual(famParts.filter((part) => lone.test(part)), [])
  assert.ok(!famParts.some((part) => part.endsWith('\u200d')), '不能切在 ZWJ 上')
})

console.log(`\n✓ 说话手感用例通过：${passed} 项`)
