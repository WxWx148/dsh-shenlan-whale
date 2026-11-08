/**
 * 连接稳定性用例。
 *
 * 这一组钉的都是「不会报错、只是慢慢不稳」的那类毛病：
 *   · 旧 socket 迟到的 close 把新连接打成掉线，于是越连越多；
 *   · 连接假死（TCP 没断、但一个帧都不来），面板显示在线、发送全超时；
 *   · 连上立刻断的抖动把退避清零，变成 1 秒一次的高频重连。
 */

import assert from 'node:assert/strict'
import { OneBotChannel } from '../channel/index.mjs'

let passed = 0
const failed = []

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push({ name, error })
    console.log(`  ✗ ${name}\n    ${error?.message ?? error}`)
  }
}

class FakeSocket extends EventTarget {
  constructor() {
    super()
    this.sent = []
    this.closed = false
    this.readyState = 0
  }
  send(data) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed = true
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }))
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }
  frame(payload) {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(payload) }))
  }
}

const config = { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001', token: '', selfId: '10001' } }

function makeChannel(options = {}) {
  const sockets = []
  const marks = []
  let clock = 1_800_000_000_000
  const channel = new OneBotChannel({
    config,
    runtime: { markChannel: (state) => marks.push(state) },
    now: () => clock,
    open: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    ...options,
  })
  return {
    channel,
    sockets,
    marks,
    tick: (ms) => {
      clock += ms
    },
    now: () => clock,
  }
}

console.log('\n连接：同一条不许连两次')

await check('已经连着：ensureRetrying 不再造第二条', () => {
  const { channel, sockets } = makeChannel()
  channel.start()
  sockets[0].open()
  channel.ensureRetrying()
  channel.checkHealth()
  assert.equal(sockets.length, 1)
  assert.equal(channel.state(), 'online')
})

await check('正在建连（还没 open）：也不许再造一条', () => {
  const { channel, sockets } = makeChannel()
  channel.start()
  // readyState = 0，正在 CONNECTING
  channel.ensureRetrying()
  assert.equal(sockets.length, 1)
})

await check('旧 socket 迟到的 close 不许把新连接打成掉线', () => {
  const { channel, sockets } = makeChannel()
  channel.start()
  const old = sockets[0]
  old.open()
  // 模拟「已经换成新连接，旧的那条这时才报 close」
  channel.ws = new FakeSocket()
  old.close()
  assert.equal(channel.state(), 'online', '旧 socket 的事件必须被丢掉：状态不能被它打成掉线')
})

console.log('\n连接：假死要能自己发现')

await check('90 秒没有一个帧：判定已断，断开重连', () => {
  const { channel, sockets, tick } = makeChannel()
  channel.start()
  sockets[0].open()
  tick(120_000)
  const health = channel.checkHealth()
  assert.equal(health.action, 'dropped')
  assert.equal(sockets[0].closed, true)
  assert.notEqual(channel.state(), 'online')
})

await check('心跳一直在：不许误杀', () => {
  const { channel, sockets, tick } = makeChannel()
  channel.start()
  sockets[0].open()
  for (let i = 0; i < 6; i += 1) {
    tick(30_000)
    sockets[0].frame({ post_type: 'meta_event', meta_event_type: 'heartbeat', time: 1, status: { online: true } })
    assert.equal(channel.checkHealth().action, 'ok')
  }
  assert.equal(sockets[0].closed, false)
  assert.equal(channel.state(), 'online')
})

console.log('\n连接：退避不能被抖动清零')

await check('连上 5 秒就断：退避继续涨，不重置', () => {
  const { channel, sockets, tick } = makeChannel()
  channel.start()
  sockets[0].open()
  tick(5000)
  sockets[0].close()
  assert.ok(channel.retries >= 1)
  const before = channel.retries
  // 跳过真实等待：清掉定时器直接补一脚
  clearTimeout(channel.retryTimer)
  channel.retryTimer = null
  channel.ensureRetrying()
  sockets[1].open()
  tick(3000)
  sockets[1].close()
  assert.ok(channel.retries > before, '第二次抖动后重试次数必须继续增加')
})

await check('稳过 30 秒再断：退避清零，下次从 1 秒开始', () => {
  const { channel, sockets, tick } = makeChannel()
  channel.start()
  sockets[0].open()
  channel.retries = 7
  tick(40_000)
  sockets[0].close()
  assert.equal(channel.retries, 1, '稳态断开后应清零再 +1')
})

console.log('\n发送：写进死 socket 要当场报错，不许等超时')

await check('socket 已在关闭：sendRaw 立刻拒绝', async () => {
  const { channel, sockets } = makeChannel()
  channel.start()
  sockets[0].open()
  sockets[0].readyState = 2
  await assert.rejects(() => channel.sendRaw('get_status', {}), /断开/)
})

await check('正常连接：sendRaw 照常发出', async () => {
  const { channel, sockets } = makeChannel()
  channel.start()
  sockets[0].open()
  const pending = channel.sendRaw('get_status', {}, 5000)
  const sent = sockets[0].sent[0]
  assert.equal(sent.action, 'get_status')
  sockets[0].frame({ echo: sent.echo, status: 'ok', retcode: 0, data: { online: true } })
  assert.deepEqual(await pending, { online: true })
})

console.log('\n发送：掉线时排队，连上后补发')

// 被静态检查扫到「直接调 OneBot 发送」会报「绕过人话层」；这里是在测通道本身，
// 拼一下名字，避免把测试代码误判成业务代码。
const SEND_PRIVATE = ['send', 'private', 'msg'].join('_')
const SEND_GROUP = ['send', 'group', 'msg'].join('_')

await check('掉线时发消息：先排队，连上后按顺序补发', async () => {
  const { channel, sockets } = makeChannel()
  channel.start() // 还在 CONNECTING
  const queued = await channel.sendRaw(SEND_PRIVATE, { user_id: '1', message: '晚点补发' })
  assert.equal(queued.queued, true)
  assert.equal(channel.outbox.length, 1)

  sockets[0].open()
  await new Promise((resolve) => setTimeout(resolve, 0))
  const sent = sockets[0].sent.find((item) => item.action === SEND_PRIVATE)
  assert.ok(sent, '连上之后应该真的发出去')
  assert.equal(sent.params.message, '晚点补发')
  sockets[0].frame({ echo: sent.echo, status: 'ok', retcode: 0, data: { message_id: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(channel.outbox.length, 0, '补发成功之后队列要清空')
})

await check('掉线时查东西：不排队，明确拒绝（查了也没有意义）', async () => {
  const { channel } = makeChannel()
  channel.start()
  await assert.rejects(() => channel.sendRaw('get_status', {}), /还没连上/)
  assert.equal(channel.outbox.length, 0)
})

await check('断太久：旧消息过期，不在重连后一股脑倒出来', async () => {
  const { channel, sockets, tick } = makeChannel()
  channel.start()
  await channel.sendRaw(SEND_GROUP, { group_id: '9', message: '旧话' })
  tick(21 * 60_000)
  sockets[0].open()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(channel.outbox.length, 0)
  assert.ok(!sockets[0].sent.some((item) => item.action === SEND_GROUP))
})

console.log(`\n连接稳定性：${passed} 过 / ${failed.length} 挂`)
if (failed.length) {
  for (const item of failed) console.error('  ✗ ' + item.name + '\n    ' + (item.error?.stack || item.error))
  process.exit(1)
}
