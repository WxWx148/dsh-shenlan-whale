/**
 * 掉线补回用例。
 *
 * 这条链路最怕的不是补不到，而是「补重了」或「把补回来的当成新消息再回一遍」：
 *   - 同一段历史在每次重连都被追加一次 → 聊天记录里同一句越来越多；
 *   - 补回来的消息触发回复 → 对着几小时前的话突然接一句。
 * 所以这里断言三件事：只补空档、按 messageId 去重、只写事件不走回复。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runtime } from '../lib/runtime.mjs'
import { backfillMissed } from '../lib/qq/backfill.mjs'
import { KIND, SCOPE, SOURCE } from '../lib/event.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}`)
  }
}

const BASE = new Date(2026, 9, 30, 18, 0, 0).getTime()
const dirs = []
function open() {
  const dir = mkdtempSync(path.join(tmpdir(), 'backfill-'))
  dirs.push(dir)
  return { dir, runtime: new Runtime({ dir, now: () => BASE }) }
}

/** 往事件流里放一条「已经在日志里」的消息 */
function seed(runtime, { text, messageId, at, from = '20002', sender = '老王' }) {
  const event = runtime.decide({
    source: SOURCE.CHANNEL,
    kind: KIND.MESSAGE,
    scope: SCOPE.GROUP,
    from,
    text,
    at,
    messageId,
    payload: { groupId: '555', senderName: sender },
  }).event
  runtime.logEvent(event)
}

const item = (over = {}) => ({
  messageId: '',
  at: BASE - 30_000,
  from: '20003',
  sender: '小李',
  text: '掉线时说的',
  images: [],
  replyId: '',
  replySummary: '',
  forwardId: '',
  scope: 'group',
  groupId: '555',
  ...over,
})

await check('只补空档里的消息：已有的跳过，空档外的不要', async () => {
  const { runtime } = open()
  seed(runtime, { text: '已有的', messageId: 'm-old', at: BASE - 60_000 })
  const asked = []
  const channel = {
    getHistory: async (conversation) => {
      asked.push(conversation)
      return [
        item({ messageId: 'm-old', at: BASE - 60_000, text: '已有的' }),
        item({ messageId: 'm-new', at: BASE - 30_000 }),
        item({ messageId: 'm-late', at: BASE + 60_000, text: '连上之后才说的' }),
      ]
    },
  }
  const result = await backfillMissed({ runtime, channel, since: BASE - 60_000, until: BASE, now: BASE })
  assert.equal(result.ok, true)
  assert.equal(result.restored, 1, '只补一条新的')
  assert.equal(result.skipped, 1, '已有的按 messageId 跳过')
  assert.deepEqual(asked, ['group:555'])

  const rows = runtime.events.read({ limit: 20 }).rows
  const found = rows.find((row) => row.messageId === 'm-new')
  assert.ok(found, '新消息要进事件流')
  assert.equal(found.text, '掉线时说的')
  assert.equal(found.backfilled, true, '要能一眼看出是补回来的')
  assert.equal(found.conversation, 'group:555')
  assert.ok(!rows.some((row) => row.messageId === 'm-late'), '空档之后的消息交给正常链路，别在这里补')

  const audit = runtime.audit.read({ limit: 20 }).rows
  assert.ok(audit.some((row) => row.kind === 'channel_backfill'), '补了多少要留痕')
})

await check('空档太短不折腾：不算掉线，也不写审计', async () => {
  const { runtime } = open()
  seed(runtime, { text: '刚才', messageId: 'm1', at: BASE - 5_000 })
  let called = 0
  const channel = { getHistory: async () => { called += 1; return [] } }
  const result = await backfillMissed({ runtime, channel, since: BASE - 10_000, until: BASE, now: BASE })
  assert.equal(result.ok, true)
  assert.equal(result.restored, 0)
  assert.equal(result.reason, '空档太短')
  assert.equal(called, 0, '抖一下不该打一串接口')
  assert.ok(!runtime.audit.read({ limit: 20 }).rows.some((row) => row.kind === 'channel_backfill'))
})

await check('通道没有历史接口：如实说补不了，不假装成功', async () => {
  const { runtime } = open()
  const result = await backfillMissed({ runtime, channel: {}, since: BASE - 60_000, until: BASE, now: BASE })
  assert.equal(result.ok, false)
  assert.match(result.reason, /历史/)
})

for (const dir of dirs) rmSync(dir, { recursive: true, force: true })

console.log(`\n${failed.length ? '✗' : '✓'} 掉线补回用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.stack || error.message}`)
  process.exit(1)
}
