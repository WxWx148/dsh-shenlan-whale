/**
 * 群聊注意力用例。
 *
 * 这一层判错的代价不对称：漏接一句只是没聊上，抢话是冒犯。
 * 所以用例的重点全在「不该接的时候真的没接」——
 * 尤其是「窗口里是 A，B 说了句无关的话」这种最容易误判成接话的情况。
 */

import assert from 'node:assert/strict'
import { ATTENTION, AttentionDesk, addressesSelf, textOverlaps } from '../lib/attention.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}：${error?.message || error}`)
  }
}

const cfg = (over = {}) => ({ group: { followUpSeconds: 180, followUpMaxTurns: 5, ...over } })

/** 可控时钟：用来把窗口推到过期，而不是真等三分钟 */
function clock(start = 1_700_000_000_000) {
  const box = { now: start }
  return { box, now: () => box.now }
}

await check('重合率：在接上一句就认，无关的不认', () => {
  assert.equal(textOverlaps('这个显卡太贵了买不起', '显卡确实太贵了，我也买不起'), true)
  assert.equal(textOverlaps('今天天气不错', '显卡确实太贵了，我也买不起'), false)
})

await check('重合率：太短的句子不算（随便两句都能撞上）', () => {
  assert.equal(textOverlaps('好', '好'), false)
  assert.equal(textOverlaps('嗯', '嗯嗯嗯嗯'), false)
})

await check('人称：你/您 算对着自己说，我没有', () => {
  assert.equal(addressesSelf('你刚才说的那个在哪'), true)
  assert.equal(addressesSelf('您说的是显卡吗'), true)
  assert.equal(addressesSelf('我觉得这游戏还行'), false)
})

await check('窗口：开窗后在窗口内命中，过期就不命中', () => {
  const c = clock()
  const desk = new AttentionDesk({ config: cfg(), now: c.now })
  desk.open('group:1', 'A')
  assert.equal(desk.hit('group:1', 'A')?.who, 'A')
  c.box.now += (ATTENTION.windowSec + 1) * 1000
  assert.equal(desk.hit('group:1', 'A'), null)
  const stats = desk.stats()
  assert.equal(stats.conversations, 0)
  assert.equal(stats.people, 0)
})

await check('窗口：聊满轮数自动关窗，不永久热着', () => {
  const c = clock()
  const desk = new AttentionDesk({ config: cfg({ followUpMaxTurns: 2 }), now: c.now })
  desk.open('group:1', 'A')
  desk.bump('group:1', 'A')
  assert.ok(desk.hit('group:1', 'A'), '第一轮之后还该在')
  desk.bump('group:1', 'A')
  assert.equal(desk.hit('group:1', 'A'), null, '第二轮满了就该关')
})

await check('判定：自己窗口命中 → 接着聊，不用 @', () => {
  const desk = new AttentionDesk({ config: cfg(), now: clock().now })
  desk.open('group:1', 'A')
  const verdict = desk.consider({ conversation: 'group:1', from: 'A', text: '那后来呢' })
  assert.equal(verdict.continue, true)
  assert.equal(verdict.why, 'window')
})

await check('判定：窗口里是 A，B 说了句无关的 → 不接，A 的窗口还在', () => {
  const desk = new AttentionDesk({ config: cfg(), now: clock().now })
  desk.open('group:1', 'A')
  desk.noteReply({ conversation: 'group:1', from: 'A', scope: 'group', text: '这个显卡太贵了买不起' })
  const verdict = desk.consider({ conversation: 'group:1', from: 'B', text: '今晚八点开黑来人' })
  assert.equal(verdict, null)
  assert.equal(desk.hit('group:1', 'A')?.who, 'A')
})

await check('判定：窗口里是 A，B 直接对着自己说 → 换人，旧窗口关掉', () => {
  const desk = new AttentionDesk({ config: cfg(), now: clock().now })
  desk.open('group:1', 'A')
  desk.noteReply({ conversation: 'group:1', from: 'A', scope: 'group', text: '这个显卡太贵了买不起' })
  const verdict = desk.consider({ conversation: 'group:1', from: 'B', text: '你那句话是什么意思' })
  assert.equal(verdict.continue, true)
  assert.equal(verdict.handoffFrom, 'A')
  assert.equal(desk.hit('group:1', 'A'), null, '旧目标必须关窗')
  assert.equal(desk.hit('group:1', 'B')?.who, 'B', '新目标开窗')
})

await check('判定：B 在接上一句的话题 → 同样换人（不用等模型）', () => {
  const desk = new AttentionDesk({ config: cfg(), now: clock().now })
  desk.open('group:1', 'A')
  desk.noteReply({ conversation: 'group:1', from: 'A', scope: 'group', text: '显卡现在太贵了，等降价' })
  const verdict = desk.consider({ conversation: 'group:1', from: 'B', text: '显卡太贵了，等降价再说吧' })
  assert.equal(verdict.continue, true)
  assert.equal(verdict.handoffFrom, 'A')
})

await check('判定：没有窗口时什么都不接（不猜）', () => {
  const desk = new AttentionDesk({ config: cfg(), now: clock().now })
  assert.equal(desk.consider({ conversation: 'group:1', from: 'B', text: '你在吗' }), null)
})

await check('记账：群聊回复开窗，私聊不开（一个人就是一个会话）', () => {
  const desk = new AttentionDesk({ config: cfg(), now: clock().now })
  assert.equal(desk.noteReply({ conversation: 'private:9', from: '9', scope: 'private', text: '嗯' }).opened, false)
  assert.equal(desk.hit('private:9', '9'), null)
  assert.equal(desk.noteReply({ conversation: 'group:1', from: 'A', scope: 'group', text: '嗯' }).opened, true)
  assert.ok(desk.hit('group:1', 'A'))
})

await check('记账：同一个人再回一句，是续轮而不是重置窗口', () => {
  const c = clock()
  const desk = new AttentionDesk({ config: cfg(), now: c.now })
  desk.noteReply({ conversation: 'group:1', from: 'A', scope: 'group', text: '一' })
  const first = desk.hit('group:1', 'A').rec.until
  c.box.now += 60_000
  desk.noteReply({ conversation: 'group:1', from: 'A', scope: 'group', text: '二' })
  const second = desk.hit('group:1', 'A').rec
  assert.equal(second.turns, 1)
  assert.ok(second.until > first)
})

await check('统计：几个会话热着、各几个人', () => {
  const desk = new AttentionDesk({ config: cfg(), now: clock().now })
  desk.open('group:1', 'A')
  desk.open('group:2', 'B')
  const stats = desk.stats()
  assert.equal(stats.conversations, 2)
  assert.equal(stats.people, 2)
  // 现场参数跟着配置走：面板显示的和判定用的是同一个数
  assert.equal(stats.windowMs, 180_000)
  assert.equal(stats.maxTurns, 5)
})

await check('现场快照：谁、第几轮、还剩多久，按最热的排前面', () => {
  const c = clock()
  const desk = new AttentionDesk({ config: cfg(), now: c.now })
  desk.open('group:1', 'A')
  c.box.now += 100_000
  desk.open('group:1', 'B')
  const list = desk.snapshot()
  assert.equal(list.length, 2)
  assert.equal(list[0].who, 'B', '刚开窗的应该排在前面')
  assert.equal(list[0].remainingMs, 180_000)
  assert.equal(list[1].remainingMs, 80_000)
})

await check('过期清理：窗口没了，记着的那句话也一起清掉（长跑不漏内存）', () => {
  const c = clock()
  const desk = new AttentionDesk({ config: cfg(), now: c.now })
  desk.noteReply({ conversation: 'group:1', from: 'A', scope: 'group', text: '在说显卡' })
  assert.equal(desk.lastReply.size, 1)
  c.box.now += 181_000
  desk.stats()
  assert.equal(desk.windows.size, 0)
  assert.equal(desk.lastReply.size, 0, 'lastReply 跟着窗口一起清，否则只进不出')
})

await check('换人有记录：面板要能回答「刚才为什么切给了别人」', () => {
  const desk = new AttentionDesk({ config: cfg(), now: clock().now })
  desk.open('group:1', 'A')
  desk.lastReply.set('group:1', '显卡现在太贵了，等降价')
  const verdict = desk.consider({ conversation: 'group:1', from: 'B', text: '显卡这价格你怎么看' })
  assert.equal(verdict.handoffFrom, 'A')
  const stats = desk.stats()
  assert.equal(stats.handoffs, 1)
  assert.equal(stats.lastHandoff.from, 'A')
  assert.equal(stats.lastHandoff.to, 'B')
})

console.log('')
if (failed.length) {
  console.log(`✗ 注意力用例：${failed.length} 项失败（通过 ${passed} 项）`)
  for (const item of failed) console.log(`  - ${item.name}：${item.error?.stack || item.error}`)
  process.exit(1)
}
console.log(`✓ 注意力用例：${passed} 项通过`)
