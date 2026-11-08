import assert from 'node:assert/strict'
import { eventKeyOf, createEventHub } from '../app/index.mjs'

let passed = 0
const failed = []
async function check(name, fn) {
  try { await fn(); passed += 1; console.log('  ✓ ' + name) }
  catch (error) { failed.push(name); console.error('  ✗ ' + name + '：' + (error && error.message)) }
}

const hubOf = (keyOf) => {
  let cleared = 0
  const hub = createEventHub({
    keyOf,
    interval: 1000,
    setIntervalFn: () => 77,
    clearIntervalFn: () => { cleared += 1 },
    at: () => 1234,
  })
  return { hub, cleared: () => cleared }
}

await check('首帧只建基线：刚订阅不该收到 invalidate', () => {
  const { hub } = hubOf(() => 'a')
  const got = []
  hub.subscribe((one) => got.push(one.type))
  hub.tick()
  assert.deepEqual(got, ['ping'])
})

await check('摘要变了才推 invalidate，没变只心跳', () => {
  let key = 'a'
  const { hub } = hubOf(() => key)
  const got = []
  hub.subscribe((one) => got.push(one.type))
  hub.tick()
  key = 'b'
  hub.tick()
  hub.tick()
  assert.deepEqual(got, ['ping', 'invalidate', 'ping'])
})

await check('payload 带时间戳，多个窗口各自收到', () => {
  const { hub } = hubOf(() => 'fixed')
  const a = []
  const b = []
  hub.subscribe((one) => a.push(one))
  hub.subscribe((one) => b.push(one))
  hub.tick()
  assert.equal(hub.size, 2)
  assert.deepEqual(a, b)
  assert.equal(a[0].at, 1234)
})

await check('最后一个订阅者走了就停表，别在面板关着时空转', () => {
  const { hub, cleared } = hubOf(() => 'a')
  const offA = hub.subscribe(() => {})
  const offB = hub.subscribe(() => {})
  offA()
  assert.equal(cleared(), 0, '还有一个订阅者，不能停')
  offB()
  assert.equal(cleared(), 1)
  assert.equal(hub.size, 0)
})

await check('一个订阅者抛异常不影响其他人', () => {
  const { hub } = hubOf(() => 'a')
  const got = []
  hub.subscribe(() => { throw new Error('这个窗口坏了') })
  hub.subscribe((one) => got.push(one.type))
  hub.tick()
  assert.deepEqual(got, ['ping'])
})

await check('keyOf 抛异常时这一拍跳过，不推也不崩', () => {
  let boom = true
  const { hub } = hubOf(() => { if (boom) throw new Error('还没装配好'); return 'a' })
  const got = []
  hub.subscribe((one) => got.push(one.type))
  hub.tick()
  assert.deepEqual(got, [])
  boom = false
  hub.tick()
  assert.equal(got.length, 1)
})

await check('eventKeyOf：对象残缺也不抛，配置修订号进摘要', () => {
  assert.equal(typeof eventKeyOf(), 'string')
  assert.equal(typeof eventKeyOf({ runtime: null, sandbox: null }), 'string')
  const a = eventKeyOf({ runtime: { configRevision: 1, progressText: () => '' } })
  const b = eventKeyOf({ runtime: { configRevision: 2, progressText: () => '' } })
  assert.notEqual(a, b, '配置改了必须变')
})

await check('eventKeyOf：待确认项出现/消失会改变摘要', () => {
  const base = { runtime: { configRevision: 1, progressText: () => '' } }
  const withAsk = {
    ...base,
    sandbox: { approvals: { list: () => [{ id: 'ask-1' }] } },
  }
  assert.notEqual(eventKeyOf(base), eventKeyOf(withAsk))
})

await check('createEventHub 少了 keyOf 直接拒绝', () => {
  assert.throws(() => createEventHub(), /keyOf/)
})

console.log(`\n${failed.length ? '✗' : '✓'} 事件源用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
