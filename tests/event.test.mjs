/**
 * 事件打标（event）用例：标要打得准，尤其是不该打的时候别乱打。
 *
 * 这一层错了，后面所有统计都是错的：
 * 「我被 @ 了多少次」「群里多少话我没接」全靠 tags 算。
 */

import assert from 'node:assert/strict'
import { EventTagger, KIND, SCOPE, SOURCE, TAG, conversationOf, has, inWindow, kindOf, needsReply, parseWindow } from '../lib/event.mjs'

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
const NIGHT = new Date(2026, 9, 29, 23, 30, 0).getTime()

function tagger(extra = {}) {
  return new EventTagger({ ownerId: OWNER, selfNames: ['深蓝', '小鱼'], nightWindow: '23:00-07:00', mergeWindowMs: 2000, now: () => AT, ...extra })
}

const base = { source: SOURCE.CHANNEL, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, from: OWNER, text: '在吗', at: AT }

console.log('\n事件打标')

await check('窗口解析：正常、跨零点、脏值', () => {
  assert.deepEqual(parseWindow('23:00-07:00'), { start: 1380, end: 420, wraps: true })
  assert.deepEqual(parseWindow('08:30-18:00'), { start: 510, end: 1080, wraps: false })
  for (const bad of ['', 'abc', '25:00-07:00', '23:61-07:00', '23:00', null, undefined, '23:00-23:00']) {
    assert.equal(parseWindow(bad), null, `「${bad}」应解析失败`)
  }
})

await check('夜间判定：跨零点两侧都算，白天不算', () => {
  assert.equal(inWindow(NIGHT, '23:00-07:00'), true, '23:30 应在夜间')
  assert.equal(inWindow(new Date(2026, 9, 30, 2, 0, 0).getTime(), '23:00-07:00'), true, '凌晨 2 点应在夜间')
  assert.equal(inWindow(new Date(2026, 9, 30, 7, 0, 0).getTime(), '23:00-07:00'), false, '7 点整应出夜间')
  assert.equal(inWindow(AT, '23:00-07:00'), false, '下午 2 点不该算夜间')
})

await check('脏窗口不吞消息：解析失败时一律不算夜间', () => {
  assert.equal(inWindow(NIGHT, '乱写的'), false)
  const entity = tagger({ nightWindow: '乱写的' }).tag({ ...base, at: NIGHT })
  assert.ok(!has(entity, TAG.NIGHT))
})

await check('最基本的一条：私聊消息，主人发的', () => {
  const event = tagger().tag(base)
  assert.equal(event.source, 'channel')
  assert.equal(event.kind, 'message')
  assert.equal(event.scope, 'private')
  assert.equal(event.from, OWNER)
  assert.ok(has(event, TAG.IS_OWNER))
  assert.ok(has(event, TAG.FIRST_TODAY))
  assert.ok(!has(event, TAG.AT_ME), '私聊没 @ 就不该有 at_me')
  assert.match(event.id, /^evt_\d+_/)
})

await check('@全体成员 不算 @我（旧版就在这里误判）', () => {
  const event = tagger().tag({ ...base, scope: SCOPE.GROUP, groupId: '900', atAll: true, text: '@全体成员 开会' })
  assert.ok(has(event, TAG.AT_ALL))
  assert.ok(!has(event, TAG.AT_ME), '@全体不是 @我')
  assert.equal(needsReply(event), false, '群里 @全体 不该触发回话')
})

await check('真的 @ 了我才算', () => {
  const event = tagger().tag({ ...base, scope: SCOPE.GROUP, groupId: '900', atMe: true })
  assert.ok(has(event, TAG.AT_ME))
  assert.equal(needsReply(event), true)
})

await check('名字被叫到 = mentioned_name，但不是 at_me', () => {
  const event = tagger().tag({ ...base, scope: SCOPE.GROUP, groupId: '900', text: '深蓝你来说说' })
  assert.ok(has(event, TAG.MENTIONED_NAME))
  assert.ok(!has(event, TAG.AT_ME))
  assert.equal(needsReply(event), true, '叫了名字就该应一声')
})

await check('别人聊别人的，两个标都不该有', () => {
  const event = tagger().tag({ ...base, scope: SCOPE.GROUP, groupId: '900', text: '今晚吃啥' })
  assert.ok(!has(event, TAG.AT_ME))
  assert.ok(!has(event, TAG.MENTIONED_NAME))
  assert.equal(needsReply(event), false)
})

await check('连发：同一个会话 2 秒内算一串，超过就不算', () => {
  const t = tagger()
  const first = t.tag({ ...base, at: AT })
  const second = t.tag({ ...base, at: AT + 1000 })
  const third = t.tag({ ...base, at: AT + 10_000 })
  assert.ok(!has(first, TAG.BURST), '第一条不算连发')
  assert.ok(has(second, TAG.BURST), '1 秒后应算连发')
  assert.ok(!has(third, TAG.BURST), '10 秒后不算连发')
})

await check('连发判定按会话分开：两个群互不影响', () => {
  const t = tagger()
  t.tag({ ...base, scope: SCOPE.GROUP, groupId: '900', at: AT })
  const other = t.tag({ ...base, scope: SCOPE.GROUP, groupId: '901', at: AT + 500 })
  assert.ok(!has(other, TAG.BURST), '别的群不算连发')
})

await check('今天第一条：同会话只标一次，换天重新标', () => {
  const t = tagger()
  const first = t.tag({ ...base, at: AT })
  const second = t.tag({ ...base, at: AT + 1000 })
  const tomorrow = t.tag({ ...base, at: AT + 24 * 3600_000 })
  assert.ok(has(first, TAG.FIRST_TODAY))
  assert.ok(!has(second, TAG.FIRST_TODAY))
  assert.ok(has(tomorrow, TAG.FIRST_TODAY), '第二天应重新算第一条')
})

await check('图片：kind=image 与 hasImage 都算', () => {
  assert.ok(has(tagger().tag({ ...base, kind: KIND.IMAGE }), TAG.HAS_IMAGE))
  assert.ok(has(tagger().tag({ ...base, hasImage: true }), TAG.HAS_IMAGE))
  assert.ok(!has(tagger().tag(base), TAG.HAS_IMAGE))
})

await check('不认识的来源 / 类型 / 范围直接报错（不静默兜底成 message）', () => {
  assert.throws(() => tagger().tag({ ...base, source: 'wechat' }), /未知来源/)
  assert.throws(() => tagger().tag({ ...base, kind: 'video' }), /未知类型/)
  assert.throws(() => tagger().tag({ ...base, scope: 'channel' }), /未知范围/)
  assert.throws(() => tagger().tag(null), /必须是对象/)
})

await check('事件是只读的：拿到手也改不了（否则统计能被业务代码污染）', () => {
  const event = tagger().tag(base)
  assert.throws(() => {
    event.kind = 'command'
  }, TypeError)
  assert.throws(() => {
    event.tags.push('假的')
  }, TypeError)
})

await check('没有 from 时不误判成主人', () => {
  const event = tagger().tag({ ...base, from: '' })
  assert.ok(!has(event, TAG.IS_OWNER))
})

await check('会话键：群按群号，私聊按对方，面板独立', () => {
  assert.equal(conversationOf({ scope: 'group', groupId: '900', from: '1' }), 'group:900')
  assert.equal(conversationOf({ scope: 'private', from: '1' }), 'private:1')
  assert.equal(conversationOf({ scope: 'panel' }), 'panel')
  assert.equal(conversationOf({ conversation: 'group:1' }), 'group:1')
})

await check('类型读取：内存事件看 kind，落盘记录看 type（统一入口别再各猜）', () => {
  assert.equal(kindOf({ kind: 'message' }), 'message')
  assert.equal(kindOf({ kind: 'event', type: 'message' }), 'message', '落盘记录必须能读出原类型')
  assert.equal(kindOf(null), '')
})

await check('配置热更新：改了名字与夜间窗口，立刻生效但不丢已有状态', () => {
  const t = tagger()
  t.tag({ ...base, at: AT })
  t.configure({ selfNames: ['阿蓝'], nightWindow: '00:00-23:59' })
  const event = t.tag({ ...base, at: AT + 500, text: '阿蓝在吗' })
  assert.ok(has(event, TAG.MENTIONED_NAME), '新名字应生效')
  assert.ok(!has(event, TAG.FIRST_TODAY), '同一天的第一条状态不能因改配置而重置')
})

console.log(`\n${failed.length ? '✗' : '✓'} 事件打标用例：${passed} 项通过`)
if (failed.length) {
  for (const item of failed) console.log(`  ${item.name}: ${item.err?.message ?? item.err}`)
  process.exit(1)
}
