/**
 * QQ 会话视图的用例。
 *
 * 这一块最容易出的错不是崩溃，而是**看起来对但不全**：
 *   少算了自己发出去的消息 → 界面上对方像在自说自话；
 *   顺序反了 → 读起来像吵架；
 *   把没文本的通知也算成消息 → 「聊了什么」变成一串空行。
 */

import assert from 'node:assert/strict'
import { listConversations, thread, overviewOf, peerOf } from '../view/index.mjs'

let passed = 0
const failed = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed.push({ name, err })
    console.error(`  ✗ ${name}\n    ${err?.message ?? err}`)
  }
}

/** 假日志：按「新的在前」返回，支持 filter 与 limit —— 与真 Journal 的读法一致 */
function fakeEvents(rows) {
  return {
    read({ limit = 50, filter } = {}) {
      const hit = rows.filter((row) => (typeof filter === 'function' ? filter(row) : true))
      return { rows: hit.slice(0, limit), nextBefore: null, hasMore: hit.length > limit }
    },
  }
}

const rows = [
  // 新的在前
  { id: 's3', at: 3000, from: 'self', type: 'message', scope: 'private', conversation: 'private:1001', text: '我在的', sender: '我' },
  { id: 'a2', at: 2000, from: '1001', type: 'message', scope: 'private', conversation: 'private:1001', text: '在吗', sender: '小明' },
  { id: 's2', at: 1800, from: 'self', type: 'message', scope: 'group', conversation: 'group:2002', text: '来了', sender: '我' },
  { id: 'a1', at: 1500, from: '1001', type: 'message', scope: 'private', conversation: 'private:1001', text: '早上好', sender: '小明' },
  { id: 'g1', at: 1200, from: '3003', type: 'message', scope: 'group', conversation: 'group:2002', text: '今天谁值班', sender: '阿花' },
  // 通知没有正文：不该出现在「聊了什么」里
  { id: 'n1', at: 1100, type: 'notice', scope: 'group', conversation: 'group:2002', text: '' },
  { id: 'h1', at: 1000, type: 'heartbeat', scope: 'group', conversation: 'group:2002', text: '' },
]

console.log('\nQQ 会话视图')

await check('会话 id 拆得出范围与对方', () => {
  assert.deepEqual(peerOf('private:1001'), { scope: 'private', id: '1001' })
  assert.deepEqual(peerOf('group:2002'), { scope: 'group', id: '2002' })
  assert.deepEqual(peerOf('panel'), { scope: 'panel', id: '' })
})

await check('列表：按最近说话倒序，私聊与群分开，自己发的也算进去', () => {
  const list = listConversations({ events: fakeEvents(rows) })
  assert.equal(list.rows.length, 2)
  assert.equal(list.rows[0].conversation, 'private:1001', '最近说话的排在前面')
  assert.equal(list.rows[0].where, '私聊')
  assert.equal(list.rows[0].count, 3, '两条收到 + 一条自己发的')
  assert.equal(list.rows[0].lastText, '我在的')
  assert.equal(list.rows[0].lastFrom, 'self')
  assert.equal(list.rows[0].title, '小明', '私聊标题用对方昵称，不用号码')
  assert.equal(list.rows[1].conversation, 'group:2002')
  assert.equal(list.rows[1].where, '群聊')
  assert.equal(list.rows[1].title, '群 2002')
})

await check('列表：通知与心跳不算「聊了什么」', () => {
  const list = listConversations({ events: fakeEvents(rows) })
  const group = list.rows.find((row) => row.conversation === 'group:2002')
  assert.equal(group.count, 2, '群里的两条真消息，不含 notice/heartbeat')
})

await check('一段会话：老的在上、新的在下，自己的消息有标记', () => {
  const page = thread({ events: fakeEvents(rows), conversation: 'private:1001' })
  assert.deepEqual(page.rows.map((row) => row.text), ['早上好', '在吗', '我在的'])
  assert.deepEqual(page.rows.map((row) => row.self), [false, false, true])
  assert.equal(page.rows[2].who, '我')
  assert.equal(page.rows[1].who, '小明')
})

await check('一段会话：只取这段，不串台', () => {
  const page = thread({ events: fakeEvents(rows), conversation: 'group:2002' })
  assert.deepEqual(page.rows.map((row) => row.text), ['今天谁值班', '来了'])
})

await check('只引用的消息也在聊天记录里，并能还原被引用的原话', () => {
  const quoted = [
    { id: 'q1', at: 1000, messageId: 'm1', from: '1001', type: 'message', conversation: 'private:1001', text: '原话', sender: '小明' },
    { id: 'q2', at: 2000, messageId: 'm2', from: '1001', type: 'message', conversation: 'private:1001', text: '你看这个', sender: '小明', replyId: 'm1' },
    { id: 'q3', at: 3000, messageId: 'm3', from: '1001', type: 'message', conversation: 'private:1001', text: '', sender: '小明', replyId: 'm1' },
  ]
  const page = thread({ events: fakeEvents(quoted), conversation: 'private:1001' })
  assert.equal(page.rows.length, 3, '只引用不打字的那条不能丢')
  const reply = page.rows.find((row) => row.id === 'q2')
  assert.equal(reply.reply.who, '小明')
  assert.equal(reply.reply.text, '原话')
  assert.equal(page.rows.find((row) => row.id === 'q3').text, '（引用了一条消息）', '没有正文时给占位')
})

await check('同一条 messageId 只显示一次（重复投递/重连不会多一句）', () => {
  const dup = [
    { id: 'd2', at: 1000, messageId: 'm9', from: '1', type: 'message', conversation: 'private:1', text: '在吗', sender: '小明' },
    { id: 'd1', at: 1000, messageId: 'm9', from: '1', type: 'message', conversation: 'private:1', text: '在吗', sender: '小明' },
  ]
  const page = thread({ events: fakeEvents(dup), conversation: 'private:1' })
  assert.equal(page.rows.length, 1)
})

await check('只发图的消息也在记录里，显示 [图片]', () => {
  const images = [
    { id: 'i1', at: 1000, messageId: 'm1', type: 'image', from: '1', conversation: 'private:1', sender: '小明', text: '' },
  ]
  const page = thread({ events: fakeEvents(images), conversation: 'private:1' })
  assert.equal(page.rows.length, 1)
  assert.equal(page.rows[0].text, '[图片]')
})

await check('打开一段会话默认加载 100 条（按消息算，不是按日志行）', () => {
  assert.equal(thread({ events: fakeEvents([]), conversation: 'private:1' }).pageSize, 100)
})

await check('没有日志也不崩：返回空，而不是抛异常', () => {
  assert.deepEqual(listConversations({ events: null }).rows, [])
  assert.deepEqual(thread({ events: null, conversation: 'private:1' }).rows, [])
  assert.equal(overviewOf({ events: null }).total, 0)
})

await check('概括：总数与「今天还在说话」的会话数分开报', () => {
  const now = Date.now()
  const fresh = [
    { id: 'x1', at: now - 1000, from: '1', type: 'message', scope: 'private', conversation: 'private:1', text: '刚说过', sender: '甲' },
    { id: 'x2', at: now - 3 * 24 * 3600 * 1000, from: '2', type: 'message', scope: 'private', conversation: 'private:2', text: '三天前', sender: '乙' },
  ]
  const one = overviewOf({ events: fakeEvents(fresh) })
  assert.equal(one.total, 2)
  assert.equal(one.active, 1, '三天没说话的不算「今天还在说」')
  assert.match(one.line, /2 个会话/)
})

await check('群会话显示群名，不显示群号；没名字才退回群号', () => {
  const named = listConversations({ events: fakeEvents(rows), groupName: (id) => (id === '2002' ? '观鸟小分队' : '') })
  const group = named.rows.find((row) => row.conversation === 'group:2002')
  assert.equal(group.title, '观鸟小分队', '有名字就该显示名字')
  assert.equal(group.groupName, '观鸟小分队')
  assert.match(group.where, /2002/, '群号退到副标题，别丢 —— 排查时还要用')

  const unnamed = listConversations({ events: fakeEvents(rows) })
  assert.equal(unnamed.rows.find((row) => row.conversation === 'group:2002').title, '群 2002', '拿不到名字要有确定的退路')
})

await check('引用：本地找得到就给全文（不再截 200 字），并标 replyFound', () => {
  const long = '这是一段很长的原话'.repeat(40)
  const quoted = [
    { id: 'q2', at: 3000, from: '3003', type: 'message', scope: 'group', conversation: 'group:2002', text: '接着上面说', sender: '阿花', messageId: 'm-2', replyId: 'm-1' },
    { id: 'q1', at: 1000, from: '3003', type: 'message', scope: 'group', conversation: 'group:2002', text: long, sender: '阿花', messageId: 'm-1' },
  ]
  const one = thread({ events: fakeEvents(quoted), conversation: 'group:2002', limit: 10 })
  const hit = one.rows.find((row) => row.messageId === 'm-2')
  assert.equal(hit.replyFound, true)
  assert.equal(hit.reply.text.length, long.length, '数据层不许截断，截断只发生在界面上')
  assert.equal(hit.reply.who, '阿花')
})

await check('引用：本地找不到时只用摘要兜底，并标 replyFound=false（界面才会给「查看原文」）', () => {
  const only = [
    { id: 'r1', at: 3000, from: '3003', type: 'message', scope: 'group', conversation: 'group:2002', text: '回复了一条更早的', sender: '阿花', messageId: 'm-9', replyId: 'm-old', replySummary: '很早以前那句话' },
  ]
  const one = thread({ events: fakeEvents(only), conversation: 'group:2002', limit: 10 })
  const hit = one.rows.find((row) => row.messageId === 'm-9')
  assert.equal(hit.replyFound, false)
  assert.equal(hit.replyText, '很早以前那句话')
  assert.equal(hit.reply, null)
})

console.log(`\n${failed.length ? '✗' : '✓'} QQ 会话视图用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
