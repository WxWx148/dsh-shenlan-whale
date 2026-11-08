/**
 * 归纳（induction）用例：比率算得对、没数据不炸、落盘记录也认得出来。
 */

import assert from 'node:assert/strict'
import { deriveRewards, induce, isDeclining, line } from '../mind/index.mjs'
import { BEHAVIOR } from '../decide/index.mjs'

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

/** 内存里的事件（kind） */
function event(kind, scope, tags, extra = {}) {
  return { kind, scope, tags, ...extra }
}

/** 落盘后的记录（kind 被写成 event，原类型在 type） */
function row(type, scope, tags) {
  return { kind: 'event', type, scope, tags, ts: 1 }
}

console.log('\n归纳')

await check('空数据：给 null 而不是 0，也不出 NaN', () => {
  const stats = induce({})
  assert.equal(stats.sample, 0)
  assert.equal(stats.replyRate, null)
  assert.equal(stats.silenceRate, null)
  assert.equal(stats.avgMs, null)
  assert.equal(stats.top, '')
  assert.ok(!Number.isNaN(stats.replyRate))
  assert.match(stats.line, /还没有足够记录/)
})

await check('响应率：只算「需要回」的那些（私聊 / 被 @ / 被叫名字）', () => {
  const events = [
    event('message', 'private', []),
    event('message', 'group', ['at_me']),
    event('message', 'group', ['mentioned_name']),
    event('message', 'private', []),
    event('message', 'group', []),
    event('message', 'group', []),
  ]
  const behaviors = [
    { behavior: 'reply', ok: true, ms: 1000 },
    { behavior: 'reply', ok: true, ms: 2000 },
    { behavior: 'reply', ok: true, ms: 3000 },
    { behavior: 'reply', ok: false, ms: 500 },
  ]
  const stats = induce({ events, behaviors })
  assert.equal(stats.sample, 6)
  assert.equal(stats.replyRate, 0.75, '需要回 4 次，成功回 3 次（失败那次不算）')
  assert.equal(stats.silenceRate, 0.5, '群里 4 条，2 条没被点到')
  assert.equal(stats.avgMs, 2000, '只算成功那三次的均值')
  assert.equal(stats.top, 'reply')
  assert.equal(stats.counts.reply, 4)
})

await check('落盘记录也认得出来（kind=event + type=message）', () => {
  const stats = induce({
    events: [row('message', 'private', []), row('message', 'group', ['at_me'])],
    behaviors: [{ behavior: 'reply', ok: true, ms: 800 }],
  })
  assert.equal(stats.sample, 2, '从磁盘读回来也要能数出消息')
  assert.equal(stats.replyRate, 0.5)
})

await check('通知 / 心跳不算消息，不拉低响应率', () => {
  const stats = induce({
    events: [event('message', 'private', []), event('notice', 'group', []), event('heartbeat', 'group', [])],
    behaviors: [{ behavior: 'reply', ok: true, ms: 500 }],
  })
  assert.equal(stats.sample, 1)
  assert.equal(stats.replyRate, 1)
})

await check('只取最近 window 条：老数据不参与', () => {
  const events = [event('message', 'private', []), event('message', 'private', []), event('message', 'group', [])]
  const stats = induce({ events, behaviors: [{ behavior: 'reply', ok: true, ms: 100 }], window: 2 })
  assert.equal(stats.sample, 2, '只数最近的 2 条')
  assert.equal(stats.replyRate, 0.5, '两条私聊都算需要回，但只有一次回复')
})

await check('进提示词只有一句话，且带数字不带报表', () => {
  const stats = induce({
    events: [event('message', 'private', []), event('message', 'group', ['at_me']), event('message', 'group', [])],
    behaviors: [{ behavior: 'reply', ok: true, ms: 2000 }],
  })
  assert.ok(stats.line.length <= 80, `一句话应短，实际 ${stats.line.length} 字`)
  assert.match(stats.line, /叫他\/她 2 次/)
  assert.match(stats.line, /回了 1 次/)
  assert.match(stats.line, /平均 2 秒/)
  assert.match(stats.line, /群里另有 1 条没点到他\/她/)
  // 行为记录没带 eventId、认不出属于哪个会话时，不许断言「点了没接」——
  // 把「不知道」说成「漏了」，会让模型以为自己经常不理人
  assert.ok(!stats.line.includes('点了没接'), `认不出会话时不该下结论，实际：${stats.line}`)
  assert.ok(!stats.line.includes('\n'), '不能是多行报表')
})

await check('没有人叫过：句子仍然成立，不出现「0 次回了 0 次」这种死话', () => {
  const stats = induce({ events: [event('message', 'group', [])], behaviors: [] })
  assert.match(stats.line, /最近没人叫他\/她/)
  assert.equal(stats.replyRate, null)
})

await check('响应率下降判定：掉超过 5 个点才算，缺数据不算', () => {
  assert.equal(isDeclining({ replyRate: 0.9 }, { replyRate: 0.7 }), true)
  assert.equal(isDeclining({ replyRate: 0.9 }, { replyRate: 0.87 }), false)
  assert.equal(isDeclining({ replyRate: null }, { replyRate: 0.5 }), false)
  assert.equal(isDeclining(null, { replyRate: 0.5 }), false)
})

await check('line 函数单独调用也不炸（空对象）', () => {
  assert.match(line(), /还没有足够记录/)
})

// ── 口径专测：这批用例锁的是「上游的数被下游正确理解」──
// 上一轮就是这里错的：把「群消息总数」当成「没被点到的条数」写进了提示词。

function groupEvent(i, atMe) {
  return { id: `g${i}`, kind: 'message', type: 'message', scope: 'group', from: `20${i}`, tags: atMe ? ['at_me'] : [], at: 1000 + i }
}
function privateEvent(i) {
  return { id: `p${i}`, kind: 'message', type: 'message', scope: 'private', from: `30${i}`, tags: [], at: 2000 + i }
}

await check('没被点到的条数单独算，不拿群消息总数冒充', () => {
  const events = [groupEvent(0, true), groupEvent(1, true), groupEvent(2, false), groupEvent(3, false), groupEvent(4, false)]
  const stats = induce({ events, behaviors: [] })
  assert.equal(stats.groupMessages, 5)
  assert.equal(stats.unaddressed, 3, '没被点到的是 3 条')
  assert.equal(stats.addressedGroup, 2, '被点到的是 2 条')
  assert.match(stats.line, /另有 3 条没点到他\/她/)
})

await check('会话归属认得出来，才敢说「点了没接」', () => {
  const events = [groupEvent(0, true), groupEvent(1, true), privateEvent(0)]
  // 两条群消息，只回了一条；私聊回了
  const behaviors = [
    { behavior: 'reply', eventId: 'g0', ok: true, ms: 500 },
    { behavior: 'reply', eventId: 'p0', ok: true, ms: 500 },
  ]
  const stats = induce({ events, behaviors })
  assert.equal(stats.groupReplied, 1, '群里的回复数靠 eventId 反查得出')
  assert.match(stats.line, /1 条点了没接/, `实际：${stats.line}`)
})

await check('认不出归属时不下结论：宁可不提，也不冤枉', () => {
  const events = [groupEvent(0, true), groupEvent(1, true)]
  // 行为记录没带 eventId，也没有 scope —— 无法判断回了哪条
  const stats = induce({ events, behaviors: [{ behavior: 'reply', ok: true, ms: 500 }] })
  assert.equal(stats.groupReplied, 0)
  assert.ok(!stats.line.includes('点了没接'), `不该说漏，实际：${stats.line}`)
})

await check('行为记录自带的 scope 也能用（事件日志被轮转清掉之后）', () => {
  const events = [groupEvent(0, true), groupEvent(1, true)]
  const behaviors = [{ behavior: 'reply', eventId: 'gone', scope: 'group', ok: true, ms: 400 }]
  const stats = induce({ events, behaviors })
  assert.equal(stats.groupReplied, 1, '事件找不到时退回用行为记录里的 scope')
})

await check('派生奖励：样本不足不给（两三条的比率是噪声）', () => {
  const { rewards, notes } = deriveRewards({ sample: 3, replyRate: 0 })
  assert.deepEqual(rewards, {})
  assert.match(notes.join(''), /样本不足/)
})

await check('派生奖励：该回没回要重扣，回得好只轻加', () => {
  const low = deriveRewards({ sample: 40, replyRate: 0.2 })
  assert.equal(low.rewards.behavior[BEHAVIOR.REPLY], -0.25, '20% 响应率重扣 0.25')
  const high = deriveRewards({ sample: 40, replyRate: 1 })
  assert.equal(high.rewards.behavior[BEHAVIOR.REPLY], 0.05, '满响应只加 0.05，避免自嗨')
  const mid = deriveRewards({ sample: 40, replyRate: 0.8 })
  assert.deepEqual(mid.rewards.behavior, {}, '正常区间不动')
})

await check('派生奖励不碰主动开口与自主活动（响应率推不出该不该主动）', () => {
  const { rewards } = deriveRewards({ sample: 40, replyRate: 0.1 })
  assert.equal(rewards.behavior[BEHAVIOR.PROACTIVE], undefined)
  assert.equal(rewards.behavior[BEHAVIOR.ACTIVITY], undefined)
})

await check('派生奖励：没有「该回」的样本就不给', () => {
  const { rewards } = deriveRewards({ sample: 40, replyRate: null })
  assert.deepEqual(rewards, {})
})

console.log(`\n${failed.length ? '✗' : '✓'} 归纳用例：${passed} 项通过`)
if (failed.length) {
  for (const item of failed) console.log(`  ${item.name}: ${item.err?.message ?? item.err}`)
  process.exit(1)
}
