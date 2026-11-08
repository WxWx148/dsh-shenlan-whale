/**
 * tests/style.test.mjs — 说话手感：实测口径、规则预算、分条
 *
 * 除了「像不像人说话」，这份测试还盯两件事：
 *   1. 规则块不许再写长。凡是模型默认就会的、教它怎么思考的，一律不许出现在里面。
 *   2. 规则块里不许再出现**字数**。字数一旦写进提示词，模型就会去凑那个数，
 *      变成节拍器而不是人 —— 用户明确要求「去掉字数限制」。
 */

import assert from 'node:assert/strict'
import { STYLE_PROFILE, styleGuide, splitBursts, hardWrap } from '../voice/index.mjs'

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

await check('实测口径：模型原始输出本来就在聊天的范围里', () => {
  // 这组数字是「不用拿字数去掰它」的依据：
  // 模型自己的 p50=21、p90=38、p99=106、最长 160 —— 都在聊天能接受的范围里。
  assert.ok(STYLE_PROFILE.raw.p50Chars <= 30)
  assert.ok(STYLE_PROFILE.raw.p99Chars <= 120)
  assert.ok(STYLE_PROFILE.raw.singleLineShare >= 0.6, '模型多数时候只写一行')
})

await check('规则：只留实测差异项（分条、标点、语气词、口癖）', () => {
  const guide = styleGuide({ channel: 'private', maxParts: 3 })
  assert.match(guide, /一行一条/)
  assert.match(guide, /第一条先说结论/)
  assert.match(guide, /句尾不加句号/)
  assert.match(guide, /连接词/)
  assert.match(guide, /语气词该带就带/)
  assert.match(guide, /你说得对/)
  assert.match(guide, /私聊/)
})

await check('规则里不许再出现字数：写了模型就会去凑那个数', () => {
  // 用户原话：「去掉字数限制，他想说多长说多长，只是尽量聊天拟人就好」
  for (const channel of ['private', 'group']) {
    for (const verbosity of ['brief', 'normal', 'chatty']) {
      const guide = styleGuide({ channel, maxParts: 3, verbosity })
      assert.ok(!/\d+\s*字/.test(guide), `${channel}/${verbosity} 的规则块里还有字数：${guide}`)
      assert.ok(!/超过\s*\d+/.test(guide), `${channel}/${verbosity} 的规则块里还有字数上限：${guide}`)
    }
  }
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
    assert.ok(guide.length <= 260, `${channel} 规则块 ${guide.length} 字，超预算`)
    assert.ok(guide.split('\n').length <= 8, `${channel} 规则块行数过多`)
  }
})

await check('规则：群聊更短，不抢话', () => {
  const group = styleGuide({ channel: 'group', maxParts: 3 })
  const priv = styleGuide({ channel: 'private', maxParts: 3 })
  assert.match(group, /群里 1~2 条/)
  assert.ok(!priv.includes('群里 1~2 条'))
})

await check('规则：条数上限跟随配置，不写死', () => {
  assert.match(styleGuide({ maxParts: 2 }), /最多 2 条/)
  assert.match(styleGuide({ maxParts: 5 }), /最多 4 条/, '硬上限仍是 4')
})

await check('规则：话多话少只改倾向，不改条数上限', () => {
  const brief = styleGuide({ maxParts: 3, verbosity: 'brief' })
  const chatty = styleGuide({ maxParts: 3, verbosity: 'chatty' })
  const normal = styleGuide({ maxParts: 3, verbosity: 'normal' })
  assert.match(brief, /简短点/)
  assert.match(chatty, /想多说就说/)
  assert.ok(!normal.includes('简短点'))
  assert.ok(!normal.includes('想多说就说'))
  // 三种倾向下条数上限都一样 —— 倾向不是配额
  for (const guide of [brief, chatty, normal]) assert.match(guide, /最多 3 条/)
})

await check('分条：换行即边界，句号抹掉', () => {
  assert.deepEqual(splitBursts('鱼呢\n在呢\n咋了', { maxParts: 4 }), ['鱼呢', '在呢', '咋了'])
  assert.deepEqual(splitBursts('我看看。\n好吧', { maxParts: 3 }), ['我看看', '好吧'])
  assert.deepEqual(splitBursts('', {}), [])
})

await check('分条：问号要留住 —— 这是本轮修掉的真 bug', () => {
  // 早先把问号当分隔符 split 掉了：「听不懂？」发出去变成「听不懂」。
  // 后果是深蓝 616 条消息里含问号的 0 条，而群里他人 37/575（6.4%）会扣问号。
  // 「听不懂就扣一个问号」这个习惯就是这么落不了地的。
  assert.deepEqual(splitBursts('听不懂？', { maxParts: 3 }), ['听不懂？'])
  assert.deepEqual(splitBursts('真的吗？你说', { maxParts: 3 }), ['真的吗？', '你说'])
  assert.match(splitBursts('听不懂？', { maxParts: 3 })[0], /？/)
})

await check('分条：换行不被黏成逗号', () => {
  // 早先两套并行实现里有一套把换行拼成逗号：「A\nB」发出去是「A，B」。
  // 那是深蓝逗号率 50%（真人 24%）的根因。
  assert.deepEqual(splitBursts('A\nB', { maxParts: 3 }), ['A', 'B'])
  assert.ok(!splitBursts('A\nB', { maxParts: 3 }).join('').includes('，'))
})

await check('分条：按语义断 —— 描述不同事实的几句各发一条', () => {
  // 用户原话：「一句话拆两三次发或者连发发两三句描述不同的事实」。
  assert.deepEqual(
    splitBursts('老大给我的搜索源太差，换我我也不好意思交差', { maxParts: 3 }),
    ['老大给我的搜索源太差', '换我我也不好意思交差'],
  )
  assert.deepEqual(
    splitBursts('我先看看啊，等会儿给你结果', { maxParts: 3 }),
    ['我先看看啊', '等会儿给你结果'],
  )
})

await check('分条：不切出碎片', () => {
  // 用户截图里的原问题：「没有一条真新」/「的」——「的」单独发一条谁看都难受。
  const parts = splitBursts('搜出来的全是百科和官网首页，没有一条真新的老大给我的搜索源太差，换我我也不好意思交差', { maxParts: 4 })
  assert.ok(parts.length >= 2)
  for (const part of parts) {
    assert.ok(!/^[的地得了着过们]$/.test(part), `「${part}」这种碎片不该单独发`)
    assert.ok(part.length >= 4, `「${part}」太短，像是碎片`)
  }
})

await check('分条：没有字数上限 —— 他想说多长说多长', () => {
  // 用户原话：「去掉字数限制，他想说多长说多长」。
  const long = '这是一段很长的话'.repeat(20)
  const parts = splitBursts(long, { maxParts: 3 })
  assert.equal(parts.length, 1, '一整段没有标点的话就该原样发出去，不许被切碎')
  assert.equal(parts[0], long)
})

await check('分条：条数超了合并，不丢内容', () => {
  const parts = splitBursts('一\n二\n三\n四\n五', { maxParts: 3 })
  assert.equal(parts.length, 3)
  // 合并时用**原来的间隔**接回去：换行还是换行，不能一律变成逗号
  assert.equal(parts.join('\n').replace(/\n/g, ''), '一二三四五')
  assert.ok(!parts.join('').includes('，'), '合并不该凭空造出逗号')
})

await check('分条：超长整段才防呆切开，正常聊天一次都不会碰到', () => {
  // 防呆线是 200：模型原始输出 p99 才 106、最长 160。
  const wall = '啊'.repeat(500)
  const parts = splitBursts(wall, { maxParts: 4 })
  assert.ok(parts.length > 1, '500 字的整块内容该被切开，不能发一堵墙')
  assert.equal(parts.join(''), wall, '切开不许丢字')
})

await check('硬切不劈开 emoji：发出去不能是半个字符', () => {
  // 'ab' + 10 个 emoji，按 5 个码位切一刀 —— 第一刀之后就会落在表情中间。
  // 劈开之后 QQ 上显示的是「�」，而且原文再也拼不回来（另一半在下一句里）。
  const text = `ab${'😀'.repeat(10)}`
  const parts = hardWrap(text, 5)
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
  assert.deepEqual(parts.filter((part) => lone.test(part)), [], '不许出现孤立代理')
  assert.equal(parts.join(''), text, '内容要被完整保留，一个字都不能丢')

  // 由多个码位拼成的表情（👨‍👩‍👦）也不许被拆散
  const family = '👨‍👩‍👦'.repeat(3)
  const famParts = hardWrap(family, 3)
  assert.deepEqual(famParts.filter((part) => lone.test(part)), [])
  assert.ok(!famParts.some((part) => part.endsWith('\u200d')), '不能切在 ZWJ 上')
})

console.log(`\n✓ 说话手感用例通过：${passed} 项`)
