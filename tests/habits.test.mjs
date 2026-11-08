/**
 * 学到手感的用例。
 *
 * 这层的价值全在一句话上：**从真实聊天里量出差距，再把差距变成一句能约束模型的话**。
 * 所以用例盯三件事：
 *   1. 量得准 —— 中位数、比例不能算错（算错了教出来的规矩就是错的）；
 *   2. 学得到 —— 「别人都扣问号、自己从不扣」这种差距必须被抓出来；
 *   3. 不乱学 —— 样本不够时必须闭嘴，不能给一条没依据的规矩。
 */

import assert from 'node:assert/strict'
import { HabitObserver, gaps, gapLines, hasParticle, measure, observe, splitGroups } from '../mind/index.mjs'

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

/** 造一条消息事件 */
function msg(text, from = 'other', sender = '某人', scope = 'group') {
  return { type: 'message', scope, from, sender, text }
}

console.log('\n学到手感')

await check('量一组消息：中位数与几个比例', async () => {
  const rows = [msg('好'), msg('在吗'), msg('嗯嗯行'), msg('我看看'), msg('等下'), msg('走起')]
  const stat = measure(rows)
  assert.equal(stat.samples, 6)
  assert.equal(stat.medianChars, 2, '中位数：2、2、2、2、3、3 → 2')
  assert.equal(stat.shortShare, 1, '六条都不超过 6 字')
  assert.equal(stat.periodEndShare, 0, '没有一条以句号结尾')
})

await check('句尾句号算得准', async () => {
  const stat = measure([msg('好的。'), msg('行'), msg('就这样。')])
  assert.equal(stat.periodEndShare, 2 / 3)
})

await check('语气词只认句尾，不认词中间', async () => {
  assert.equal(hasParticle('好吧'), true, '句尾的「吧」要算')
  assert.equal(hasParticle('走起啊'), true)
  assert.equal(hasParticle('酒吧在哪'), false, '「酒吧」里的「吧」不是语气')
  assert.equal(hasParticle('我要去'), false)
})

await check('纯问号回复单独计数', async () => {
  const stat = measure([msg('？'), msg('？？？'), msg('在吗'), msg('？别光说啊')])
  assert.equal(stat.onlyQuestion, 2, '就一个问号的算纯问号')
  assert.equal(stat.shortQuestion, 3, '带问号且不超过 8 字的算短问句')
})

await check('分组：自己 / 主人 / 他人分开', async () => {
  const rows = [
    msg('主人的话', '200000001', '光的无限旅程'),
    msg('别人的话', '10001', '张三'),
    msg('自己的话', 'self', '我'),
    msg('我发的', '10002', '我'),
  ]
  const groups = splitGroups(rows, { ownerId: '200000001' })
  assert.equal(groups.owner.length, 1)
  assert.equal(groups.others.length, 1)
  assert.equal(groups.self.length, 2, 'from=self 和 sender=我 都要算自己')
})

await check('差距：短得不够、逗号多、不扣问号都能抓出来', async () => {
  const mine = { medianChars: 14, p25Chars: 10, shortShare: 0.07, commaShare: 0.52, particleShare: 0.35, periodEndShare: 0.01, onlyQuestion: 0, shortQuestion: 0 }
  const theirs = { medianChars: 9, p25Chars: 4, shortShare: 0.40, commaShare: 0.19, particleShare: 0.15, periodEndShare: 0.01, onlyQuestion: 8, shortQuestion: 9 }
  const found = gaps(mine, theirs)
  const kinds = found.map((gap) => gap.kind)
  assert.ok(kinds.includes('not_short_enough'), '要抓出短得不够')
  assert.ok(kinds.includes('too_comma'), '要抓出逗号太多')
  assert.ok(kinds.includes('no_question'), '要抓出从不扣问号')
})

await check('差距：不能因为中位数高就报「太长」——长短看语境', async () => {
  // 真人说话长短看语境：群里别人 p50=9 字但 p99=51 字、最长 78 字。
  // 所以「中位数高 3 字」不是差距 —— 那是分布整体平移，不是该改的地方。
  // 真正该报的是「短的那头不够短」。
  const mine = { medianChars: 14, p25Chars: 4, shortShare: 0.40, commaShare: 0.19, particleShare: 0.15, periodEndShare: 0.01, onlyQuestion: 5, shortQuestion: 5 }
  const theirs = { medianChars: 9, p25Chars: 4, shortShare: 0.38, commaShare: 0.19, particleShare: 0.15, periodEndShare: 0.01, onlyQuestion: 8, shortQuestion: 9 }
  const kinds = gaps(mine, theirs).map((gap) => gap.kind)
  assert.ok(!kinds.includes('too_long'), '不该再有「太长」这一项')
  assert.ok(!kinds.includes('not_short_enough'), '短的占比差不多，就不该报')
})

await check('差距很小就不报：噪音不是规矩', async () => {
  const mine = { medianChars: 9, p25Chars: 4, shortShare: 0.39, commaShare: 0.2, particleShare: 0.15, periodEndShare: 0.01, onlyQuestion: 5, shortQuestion: 5 }
  const theirs = { medianChars: 9, p25Chars: 4, shortShare: 0.38, commaShare: 0.19, particleShare: 0.15, periodEndShare: 0.01, onlyQuestion: 8, shortQuestion: 9 }
  assert.equal(gaps(mine, theirs).length, 0, '只差 1 个百分点不算差距')
})

await check('差距变成能约束模型的话', async () => {
  const mine = { medianChars: 14, p25Chars: 10, shortShare: 0.07, commaShare: 0.52, particleShare: 0.35, periodEndShare: 0.01, onlyQuestion: 0, shortQuestion: 0 }
  const theirs = { medianChars: 9, p25Chars: 4, shortShare: 0.40, commaShare: 0.19, particleShare: 0.15, periodEndShare: 0.01, onlyQuestion: 8, shortQuestion: 9 }
  const lines = gapLines(gaps(mine, theirs), { where: '群里' })
  assert.ok(lines.length >= 3)
  const joined = lines.join('\n')
  assert.match(joined, /该短的时候要短得下去/, '要教「该短时能短」')
  assert.match(joined, /「？」/, '要把扣问号这条写进去')
  assert.match(joined, /逗号/, '要把少用逗号写进去')
})

await check('提示词里不许出现字数上限：「压到 N 字」是错的', async () => {
  // 真人长短看语境。写死字数上限等于教出一个节拍器：
  // 不管说什么都 N 字，那不像人。这条断言盯着这个错误别再回来。
  const mine = { medianChars: 14, p25Chars: 10, shortShare: 0.07, commaShare: 0.52, particleShare: 0.35, periodEndShare: 0.01, onlyQuestion: 0, shortQuestion: 0 }
  const theirs = { medianChars: 9, p25Chars: 4, shortShare: 0.40, commaShare: 0.19, particleShare: 0.15, periodEndShare: 0.01, onlyQuestion: 8, shortQuestion: 9 }
  const lines = gapLines(gaps(mine, theirs), { where: '群里' }).join('\n')
  assert.doesNotMatch(lines, /压到/, '不许出现「压到 N 字」这种硬指标')
  assert.doesNotMatch(lines, /不超过 ?\d+ ?字/, '不许出现字数上限')
  assert.match(lines, /长短看语境/, '要说明长短看语境')
})

await check('样本不够就不给结论', async () => {
  const rows = [msg('在吗', '10001', '张三')]
  const result = observe({ events: rows, ownerId: '200000001', scope: 'group' })
  assert.equal(result.line, '', '样本不够时不能给一行规矩')
  assert.ok(result.reason, '要说清为什么不给')
})

await check('样���够了但没差距：闭嘴，不硬凑', async () => {
  const rows = []
  for (let i = 0; i < 30; i += 1) rows.push(msg('好', '10001', '张三'))
  for (let i = 0; i < 30; i += 1) rows.push(msg('好', 'self', '我'))
  const result = observe({ events: rows, ownerId: '200000001', scope: 'group' })
  assert.equal(result.line, '')
  assert.match(result.reason, /一个样/)
})

await check('真实场景：学出来的那行说得清差距', async () => {
  const rows = []
  // 群里别人：短、少逗号、偶尔扣问号
  for (let i = 0; i < 40; i += 1) rows.push(msg(i % 5 === 0 ? '？' : '在吗', '10001', '张三'))
  // 自己：长、逗号多
  for (let i = 0; i < 20; i += 1) rows.push(msg('我看看啊，稍等一下，马上就好', 'self', '我'))
  const result = observe({ events: rows, ownerId: '200000001', scope: 'group' })
  assert.ok(result.line, '要给出提示词行')
  assert.match(result.line, /【学到的手感·群里】/)
  assert.match(result.line, /该短的时候要短得下去/, '要给出可执行的方向')
  assert.ok(result.line.length <= 220, '这一行不能太长，否则挤掉真上下文')
})

await check('私聊场景：学主人的，不学群里的', async () => {
  const rows = []
  for (let i = 0; i < 30; i += 1) rows.push(msg('嗯嗯', '200000001', '光的无限旅程', 'private'))
  for (let i = 0; i < 15; i += 1) rows.push(msg('我这就去看一下啊', 'self', '我', 'private'))
  const result = observe({ events: rows, ownerId: '200000001', scope: 'private' })
  assert.match(result.line, /【学到的手感·私聊】/)
  assert.equal(result.stats.target, result.stats.owner, '私聊要拿主人当参照')
  assert.equal(result.stats.targetWho, '主人')
})

await check('主人私聊样本太少时不硬用：退到群里别人，不拿一次情绪当常态', async () => {
  // 实测踩过：私聊最近 500 条里主人只有 20 条发言，而且全是长句抱怨
  //（「你查完也不会输出内容给我」）。拿它当参照算出中位 19 字 ——
  // 那是抱怨时的他，不是他平时。照着 19 字教「说话短一点」等于把情绪当常态。
  const rows = []
  // 群里别人：样本充足、稳定
  for (let i = 0; i < 60; i += 1) rows.push(msg('在吗', '10001', '张三', 'group'))
  // 主人私聊：只有 8 条，全是长句
  for (let i = 0; i < 8; i += 1) rows.push(msg('你查完也不会输出内容给我真是太过分了', '200000001', '光的无限旅程', 'private'))
  // 自己私聊：也是长句
  for (let i = 0; i < 15; i += 1) rows.push(msg('我这就去看一下啊稍等马上', 'self', '我', 'private'))

  const result = observe({ events: rows, ownerId: '200000001', scope: 'private' })
  assert.ok(result.stats.owner.samples < 12, '主人私聊样本确实不够')
  assert.equal(result.stats.targetWho, '人家', '不够时不能拿主人当参照')
  assert.ok(result.stats.target, '必须有参照')
  assert.ok(result.stats.target.samples >= 12, '参照样本要够')
  assert.equal(result.stats.target.medianChars, 2, '参照要是稳定的短句，不是抱怨的长句')
  assert.match(result.line, /该短的时候要短得下去/, '提示词行要照着参照写')
})

await check('缓存：同一批数据不重复算', async () => {
  let reads = 0
  const rows = []
  for (let i = 0; i < 30; i += 1) rows.push(msg('在吗', '10001', '张三'))
  for (let i = 0; i < 20; i += 1) rows.push(msg('好的收到', 'self', '我'))
  const observer = new HabitObserver({
    ownerId: '200000001',
    read: () => { reads += 1; return rows },
    now: () => 1000,
  })
  const first = observer.line('group')
  const second = observer.line('group')
  assert.equal(first, second, '同一批数据两次结果必须一样')
  // 指纹没变就直接沿用缓存值，不重算 observe。
  // 判据是「结果一致 + 缓存里有这条指纹」，而不是「read 被调了几次」——
  // read 是取数据，重算才是真的重新统计。
  assert.ok(observer.cache.get('group'), '要有缓存')
  assert.equal(observer.cache.get('group').fingerprint, `${rows.length}:${rows[0]?.id || rows[0]?.at || ''}`)
  // 数据变了要重算
  rows.push(msg('新消息', '10001', '张三'))
  const third = observer.line('group')
  assert.notEqual(observer.cache.get('group').fingerprint, `${rows.length - 1}:${rows[0]?.id || rows[0]?.at || ''}`, '有新消息指纹必须变')
  assert.ok(third !== undefined)
})

await check('缓存按场景分开：群与私聊不互相污染', async () => {
  const observer = new HabitObserver({
    ownerId: '200000001',
    read: () => [msg('在吗', '10001', '张三', 'group')],
    now: () => 1000,
  })
  observer.observe('group')
  observer.observe('private')
  const keys = [...observer.cache.keys()]
  assert.ok(keys.includes('group') && keys.includes('private'))
})

if (failed.length) {
  console.log(`\n✗ 学到手感用例：${passed} 项通过，${failed.length} 项失败`)
  for (const row of failed) console.log(`  ${row.name}\n    ${row.err?.message ?? row.err}`)
  process.exit(1)
}
console.log(`\n✓ 学到手感用例：${passed} 项通过`)
