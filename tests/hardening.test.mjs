/**
 * 这一轮加固的四处，各自一条用例。
 *
 * 共同点：都不是「算错了」，而是「接得不对」——
 *   · 看门狗每分钟 stop/start，把通道自己的退避重连打断；
 *   · 面板标「秒」的三个时长，存进去的是毫秒，没有任何下限，0.01 秒也算合法；
 * 这类错单看某一行代码都挺合理，只有把调用方和被调方放在一起才看得出来。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OneBotChannel } from '../channel/index.mjs'
import { Guard, MIN_DELAY_MS } from '../decide/index.mjs'
import { Runtime } from '../app/index.mjs'
import { DEFAULTS, migrate } from '../truth/index.mjs'
import { createTicker } from '../base/ticker.mjs'
import { validate } from '../truth/index.mjs'

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

/** 最小可用的假 WebSocket：够触发 open / close，不碰真网络 */
class FakeSocket extends EventTarget {
  constructor() {
    super()
    this.sent = []
    this.closed = false
  }
  send(data) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed = true
  }
}

const channelConfig = { channel: { enabled: true, wsUrl: 'ws://127.0.0.1:3001', token: '', selfId: '10001' } }

function makeChannel() {
  const marks = []
  const sockets = []
  const channel = new OneBotChannel({
    config: channelConfig,
    runtime: { markChannel: (state) => marks.push(state) },
    open: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
  })
  return { channel, marks, sockets }
}

console.log('\n看门狗：只补一脚，不打断退避')

await check('连上了：看门狗什么都不做', () => {
  const { channel, sockets } = makeChannel()
  channel.start()
  sockets[0].dispatchEvent(new Event('open'))
  assert.equal(channel.state(), 'online')
  assert.equal(channel.ensureRetrying().action, 'idle')
})

await check('断了：退避定时器还在跑，看门狗不许再建一条连接', () => {
  const { channel, sockets } = makeChannel()
  channel.start()
  sockets[0].dispatchEvent(new Event('open'))
  sockets[0].dispatchEvent(new Event('close'))
  assert.equal(channel.state(), 'offline')
  const result = channel.ensureRetrying()
  assert.equal(result.action, 'waiting')
  // 只应有 start() 那一次建连，不该因为看门狗多出第二次
  assert.equal(sockets.length, 1)
})

await check('真卡住（没有待重连定时器）：补一次建连，而不是 stop/start', () => {
  const { channel, sockets, marks } = makeChannel()
  channel.start()
  sockets[0].dispatchEvent(new Event('close'))
  // 手动清掉定时器，模拟「退避链断了」
  clearTimeout(channel.retryTimer)
  channel.retryTimer = null
  const before = marks.length
  assert.equal(channel.ensureRetrying().action, 'connecting')
  assert.equal(sockets.length, 2)
  // 补一脚不该改变状态（还是 offline），所以不该多写状态行
  assert.equal(marks.length, before)
})

await check('主动关掉：看门狗也不许偷偷拉起来', () => {
  const { channel } = makeChannel()
  channel.start()
  channel.stop()
  assert.equal(channel.ensureRetrying().action, 'stopped')
  assert.equal(channel.state(), 'off')
})

await check('stop() 要顺手清掉待重连定时器，否则退出后还会自己连回来', () => {
  const { channel, sockets } = makeChannel()
  channel.start()
  sockets[0].dispatchEvent(new Event('close'))
  assert.ok(channel.retryTimer)
  channel.stop()
  assert.equal(channel.retryTimer, null)
})

console.log('\n时长单位：秒进、毫秒存、有下限')

await check('面板填 0.01 秒（也就是 10 毫秒）不该被当成合法值', () => {
  const bad = validate('guard.minGapMs', 5)
  assert.equal(bad.ok, false)
  const good = validate('guard.minGapMs', 1200)
  assert.equal(good.ok, true)
  assert.equal(good.value, 1200)
})

await check('旧配置里的 10/5/2 毫秒：加载时自动修回默认值，而不是继续秒回连发', () => {
  const result = migrate({ guard: { firstDelayMs: 10, minGapMs: 5, mergeWindowMs: 2 } })
  assert.ok(result.repaired.includes('guard.firstDelayMs'))
  assert.ok(result.repaired.includes('guard.minGapMs'))
  assert.ok(result.repaired.includes('guard.mergeWindowMs'))
  assert.equal(result.config.guard.firstDelayMs, DEFAULTS.guard.firstDelayMs)
  assert.equal(result.config.guard.minGapMs, DEFAULTS.guard.minGapMs)
  assert.equal(result.config.guard.mergeWindowMs, DEFAULTS.guard.mergeWindowMs)
})

await check('正常填的秒数原样保留，不被「修复」误伤', () => {
  const result = migrate({ guard: { firstDelayMs: 3500, minGapMs: 900, mergeWindowMs: 4000 } })
  assert.deepEqual(result.repaired, [])
  assert.equal(result.config.guard.firstDelayMs, 3500)
  assert.equal(result.config.guard.minGapMs, 900)
  assert.equal(result.config.guard.mergeWindowMs, 4000)
})

// 端到端：脏值从「躺进 config.json」到「节奏层怎么走」的完整链路。
// 事故的真实形态是：磁盘上是 0.3（秒的数值），读出来当 0.3 毫秒用，
// 于是每条消息都是秒回 —— 面板看不出，日志也不报，只有风控会记。
await check('端到端：脏节奏值 → 加载即兜回毫秒级默认值 → 不会只剩秒回', () => {
  // 脏数据的真身：想填 0.3 秒，却被写成了 0.3（被当成毫秒）
  const loaded = migrate({ guard: { firstDelayMs: 0.3, minGapMs: 0.3, mergeWindowMs: 0.3 } })
  assert.ok(loaded.repaired.includes('guard.firstDelayMs'), '修过的项要说出来，不能静默')
  assert.equal(loaded.config.guard.firstDelayMs, DEFAULTS.guard.firstDelayMs)
  assert.ok(loaded.config.guard.firstDelayMs >= MIN_DELAY_MS, '兜回的值必须是毫秒级')

  const at = new Date(2026, 9, 29, 14, 0, 0).getTime()
  const guard = new Guard({ config: loaded.config, now: () => at })
  assert.ok(guard.delay(at) >= MIN_DELAY_MS)
})

// 纵深防御：就算绕过校验，脏值直接进了内存，节奏层也得兜住。
await check('节奏层兜底：脏值直接进内存也不许秒回', () => {
  const at = new Date(2026, 9, 29, 14, 0, 0).getTime()
  const guard = new Guard({ config: { guard: { firstDelayMs: 0.3, minGapMs: 0 } }, now: () => at })
  assert.equal(guard.delay(at), 300)
})

// 磁盘上的 config.json 被改过之后，内存里这份还是旧的：面板照着旧值显示、
// 节奏照着旧值走，改都改不回来。要是不重启就没法同步，「修数据」只能靠重启。
await check('配置重载：磁盘上改过之后，不重启也能同步进内存', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rhythm-'))
  try {
    const runtime = new Runtime({ dir })
    runtime.config.guard.firstDelayMs = 999
    runtime.save() // 落盘，磁盘上现在是 999

    // 模拟「外面把配置文件改了」：直接写磁盘，不动内存
    const file = path.join(dir, 'config.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.guard.firstDelayMs = 1200
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')

    assert.equal(runtime.config.guard.firstDelayMs, 999, '重载前内存里还是旧值')
    const result = runtime.reloadConfig()
    assert.equal(result.ok, true)
    assert.equal(runtime.config.guard.firstDelayMs, 1200, '磁盘上的修正要能进内存')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await check('定时器重入：上一份还没跑完，这一次到点就跳过', async () => {
  const ticker = createTicker()
  let entered = 0
  let released
  const gate = new Promise((resolve) => { released = resolve })

  const first = ticker.once('proactive', async () => {
    entered += 1
    await gate
    return 'first'
  })
  // 第二次在第一次还挂着的时候到点：必须跳过，不能跟着一起跑
  const second = await ticker.once('proactive', () => { entered += 1 })
  assert.equal(second.skipped, true, '上一份没回来，这一次要跳过')
  assert.equal(second.reason, 'in_flight')
  assert.equal(entered, 1, '同一时刻只能有一份在跑')

  released()
  assert.equal((await first).ok, true)
  // 放开之后再进：闸是用来挡撞车的，不是把任务锁死
  const third = await ticker.once('proactive', () => { entered += 1 })
  assert.equal(third.skipped, false, '跑完之后要能再进')
  assert.equal(entered, 2)
})

await check('定时器任务抛异常：记下来，但不掀翻进程，闸照样放开', async () => {
  const seen = []
  const ticker = createTicker({ onError: (error, key) => seen.push(`${key}:${error.message}`) })
  const result = await ticker.once('digest', () => { throw new Error('模型挂了') })
  assert.equal(result.ok, false)
  assert.deepEqual(seen, ['digest:模型挂了'], '异常要落到 onError，不能变成 unhandledRejection')
  assert.equal(ticker.busy('digest'), false, '失败之后闸必须放开，否则这一天都不会再试')
})

await check('stop 之后定时器不再触发（插件卸载不该在宿主里留活口）', async () => {
  const ticker = createTicker()
  let count = 0
  ticker.every(200, 'watchdog', () => { count += 1 })
  await sleep(520)
  assert.ok(count >= 1, '停之前得真的跑过')
  ticker.stop()
  const frozen = count
  await sleep(400)
  assert.equal(count, frozen, 'stop 之后一次都不该再跑')
  assert.equal(ticker.stopped(), true)
})

await check('改配置之后，装配时拿到 config 的那几层看到的是新值（对象不许换身份）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-config-identity-'))
  try {
    const runtime = new Runtime({ dir, now: () => Date.now() })
    // 完全照 index.js 的接法：把 runtime.config 这个**引用**交给限流层
    const guard = new Guard({ config: runtime.config })
    const ref = runtime.config

    const result = runtime.setConfig('guard.perMinute', 7, { confirm: true })
    assert.equal(result.ok, true, '改配置本身要成功')
    assert.equal(runtime.config === ref, true, '配置对象必须原地更新，不能换成新对象')
    assert.equal(guard.config.guard.perMinute, 7, '早就拿着旧引用的消费者也要看到新值')

    // 重载（手改 config.json 之后走的那条路）同样不许换身份
    runtime.reloadConfig()
    assert.equal(runtime.config === ref, true, '重载之后还是同一个对象')

    // 只加不减也是 bug：删掉的白名单项不该永远留在内存里
    runtime.setConfig('net.allowlist', ['a.com', 'b.com'], { confirm: true })
    runtime.setConfig('net.allowlist', ['a.com'], { confirm: true })
    assert.deepEqual(runtime.config.net.allowlist, ['a.com'], '配置要能被改小，不能只增不减')
    runtime.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`\n加固：${passed} 过 / ${failed.length} 挂`)
if (failed.length) {
  for (const item of failed) console.error('  ✗ ' + item.name + '\n    ' + (item.error?.stack || item.error))
  process.exit(1)
}
