/**
 * 行为路由（behavior）用例：路由表逐条走，重点是「不该行为的时候真的不行为」。
 *
 * 路由错了的后果不是崩溃，是**统计全错**：把群里没 @ 的话算成「已处理」，
 * 响应率就永远好看，进化也就永远学不到东西。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { BEHAVIOR, BEHAVIOR_LIST, TUNABLE_BEHAVIORS, record, route } from '../decide/index.mjs'
import { EventTagger, KIND, SCOPE, SOURCE, TAG } from '../facts/index.mjs'
import { Journal } from '../base/journal.mjs'

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

const OWNER = '10001'
const AT = new Date(2026, 9, 29, 14, 0, 0).getTime()

function make(raw) {
  return new EventTagger({ ownerId: OWNER, selfNames: ['深蓝'], now: () => AT }).tag({ at: AT, source: SOURCE.CHANNEL, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, from: '20002', ...raw })
}

console.log('\n行为路由')

await check('五类行为是闭集，且只有三类参与权重进化', () => {
  assert.deepEqual([...BEHAVIOR_LIST].sort(), ['activity', 'admin', 'maintenance', 'proactive', 'reply'])
  assert.deepEqual([...TUNABLE_BEHAVIORS].sort(), ['activity', 'proactive', 'reply'], '管理/维护不该被「效果」带跑')
})

await check('私聊消息 → 回话', () => {
  const result = route(make({ scope: SCOPE.PRIVATE }))
  assert.equal(result.behavior, BEHAVIOR.REPLY)
  assert.equal(result.trigger, 'private')
})

await check('群聊 @我 → 回话', () => {
  const result = route(make({ scope: SCOPE.GROUP, groupId: '900', atMe: true }))
  assert.equal(result.behavior, BEHAVIOR.REPLY)
  assert.equal(result.trigger, 'at_me')
})

await check('群聊叫了名字 → 回话', () => {
  const result = route(make({ scope: SCOPE.GROUP, groupId: '900', text: '深蓝出来' }))
  assert.equal(result.behavior, BEHAVIOR.REPLY)
  assert.equal(result.trigger, 'name_called')
})

await check('主人在群里说闭嘴/恢复说话：不 @ 也要进控制分支', () => {
  const mute = route(make({ scope: SCOPE.GROUP, groupId: '900', from: OWNER, text: '闭嘴' }))
  assert.equal(mute.behavior, BEHAVIOR.REPLY)
  assert.equal(mute.trigger, 'owner_group_control')
  const back = route(make({ scope: SCOPE.GROUP, groupId: '900', from: OWNER, text: '恢复说话' }))
  assert.equal(back.trigger, 'owner_group_control')
  const leave = route(make({ scope: SCOPE.GROUP, groupId: '900', from: OWNER, text: '退出群聊 300000002' }))
  assert.equal(leave.behavior, BEHAVIOR.REPLY)
  assert.equal(leave.trigger, 'owner_group_control')
  const stranger = route(make({ scope: SCOPE.GROUP, groupId: '900', from: '20002', text: '闭嘴' }))
  assert.equal(stranger.behavior, null, '别人说闭嘴不能控制机器人')
})

await check('群里没点到 → 不行为，但原因说得清（不是「忽略」）', () => {
  const result = route(make({ scope: SCOPE.GROUP, groupId: '900', text: '今晚吃啥' }))
  assert.equal(result.behavior, null)
  assert.equal(result.trigger, 'group_not_addressed')
  assert.match(result.reason, /按设计不接/)
})

await check('主人发指令 → 执行；陌生人发同样的字 → 不执行', () => {
  const owner = route(make({ kind: KIND.COMMAND, from: OWNER, text: '/restart' }))
  assert.equal(owner.behavior, BEHAVIOR.ADMIN)

  const stranger = route(make({ kind: KIND.COMMAND, from: '99999', text: '/restart' }))
  assert.equal(stranger.behavior, null)
  assert.equal(stranger.trigger, 'command_not_owner')
})

await check('群里有指令意味的话：主人说 → 执行优先，不只是回话', () => {
  const matchCommand = (text) => (text.includes('重启') ? 'restart' : null)
  const event = make({ scope: SCOPE.GROUP, groupId: '900', atMe: true, from: OWNER, text: '深蓝 重启一下' })
  const result = route(event, { matchCommand })
  assert.equal(result.behavior, BEHAVIOR.ADMIN)
  assert.equal(result.trigger, 'owner_command')
})

await check('别人说同样的话 → 只回话，不执行', () => {
  const matchCommand = (text) => (text.includes('重启') ? 'restart' : null)
  const event = make({ scope: SCOPE.GROUP, groupId: '900', atMe: true, from: '20002', text: '深蓝 重启一下' })
  assert.equal(route(event, { matchCommand }).behavior, BEHAVIOR.REPLY)
})

await check('通知与心跳只记录，不产生行为', () => {
  assert.equal(route(make({ kind: KIND.NOTICE })).behavior, null)
  assert.equal(route(make({ kind: KIND.HEARTBEAT })).behavior, null)
})

await check('定时任务 → 维护', () => {
  assert.equal(route(make({ kind: KIND.TASK })).behavior, BEHAVIOR.MAINTENANCE)
})

await check('面板提问 → 回话（和私聊同一条路）', () => {
  assert.equal(route(make({ source: SOURCE.PANEL, scope: SCOPE.PANEL })).behavior, BEHAVIOR.REPLY)
})

await check('定时器：限流没过就不行为', () => {
  const event = make({ source: SOURCE.TIMER, kind: KIND.TASK })
  assert.equal(route(event, { guardAllowed: false }).trigger, 'task', 'task 走维护，不受活动限流影响')
  const activityEvent = new EventTagger({ now: () => AT }).tag({ at: AT, source: SOURCE.TIMER, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE })
  assert.equal(route(activityEvent, { guardAllowed: false }).behavior, null)
})

await check('定时器：到维护点优先做维护，否则按意图做活动', () => {
  const event = new EventTagger({ now: () => AT }).tag({ at: AT, source: SOURCE.TIMER, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE })
  assert.equal(route(event, { maintenanceDue: true }).behavior, BEHAVIOR.MAINTENANCE)
  assert.equal(route(event, { timerIntent: BEHAVIOR.PROACTIVE }).behavior, BEHAVIOR.PROACTIVE)
  assert.equal(route(event, {}).behavior, BEHAVIOR.ACTIVITY)
})

await check('没有事件时不炸，给 null', () => {
  const result = route(null)
  assert.equal(result.behavior, null)
  assert.equal(result.trigger, 'no_event')
})

await check('行为落盘：字段齐全，能按 eventId 与事件对上', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'behavior-test-'))
  try {
    const journal = new Journal({ dir, name: 'behaviors', now: () => AT })
    const result = record(journal, { eventId: 'evt_1', behavior: 'reply', trigger: 'private', lines: 3, ms: 1200, ok: true })
    assert.equal(result.ok, true)
    assert.equal(result.row.eventId, 'evt_1')
    assert.equal(result.row.behavior, 'reply')
    assert.equal(result.row.lines, 3)
    assert.equal(result.row.ms, 1200)
    assert.equal(result.row.ts, AT, '时间由日志层统一补，别两处各写一个')

    const page = journal.read({ limit: 10 })
    assert.equal(page.rows.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('行为落盘：非法行为名当场拒，不写脏数据', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'behavior-test-'))
  try {
    const journal = new Journal({ dir, name: 'behaviors' })
    const result = record(journal, { eventId: 'e', behavior: 'sleep' })
    assert.equal(result.ok, false)
    assert.match(result.error, /未知行为/)
    assert.equal(journal.read().rows.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await check('行为落盘：没有日志对象时明确报错，不静默丢', () => {
  const result = record(null, { eventId: 'e', behavior: 'reply' })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有可写的日志/)
})

await check('路由是纯函数：同一个事件路由两次结果一致', () => {
  const event = make({ scope: SCOPE.GROUP, groupId: '900', atMe: true })
  const a = route(event)
  const b = route(event)
  assert.deepEqual(a, b)
})


// ── 落盘契约：行为必须挂得上事件、带得回会话 ──
// 少了这两个字段，归纳就只能拿总数硬凑，「群里回了几条」永远算不准。

await check('行为必须挂在一条事件上：没有 eventId 直接拒', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bhv-'))
  const journal = new Journal({ dir, name: 'b' })
  const result = record(journal, { behavior: 'reply' })
  assert.equal(result.ok, false)
  assert.match(result.error, /eventId/)
  assert.equal(journal.read({ limit: 5 }).rows.length, 0, '拒绝的不能偷偷写进去')
  rmSync(dir, { recursive: true, force: true })
})

await check('空白 eventId 也算没有（防止 " " 混过去）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bhv-'))
  const journal = new Journal({ dir, name: 'b' })
  assert.equal(record(journal, { eventId: '   ', behavior: 'reply' }).ok, false)
  rmSync(dir, { recursive: true, force: true })
})

await check('会话范围与所属会话一起落盘', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bhv-'))
  const journal = new Journal({ dir, name: 'b' })
  record(journal, { eventId: 'e1', behavior: 'reply', scope: SCOPE.GROUP, conversation: 'group:900' })
  const row = journal.read({ limit: 1 }).rows[0]
  assert.equal(row.scope, 'group')
  assert.equal(row.conversation, 'group:900')
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${failed.length ? '✗' : '✓'} 行为路由用例：${passed} 项通过`)
if (failed.length) {
  for (const item of failed) console.log(`  ${item.name}: ${item.err?.message ?? item.err}`)
  process.exit(1)
}
