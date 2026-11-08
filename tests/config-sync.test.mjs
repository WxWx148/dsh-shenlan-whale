/**
 * 配置变更联动用例 —— 钉住「界面改了一项，行为与其它界面一起跟着变」。
 *
 * 这一组要防的是最难自查的那类坏：
 *   1. 同步清单被抄在某个 HTTP 路由里，别的入口（QQ 指令 / 工具 / reload）改配置不触发；
 *   2. 组件在构造时把配置值拷进自己字段，改完配置还按旧值跑；
 *   3. 界面只刷新自己那一块，已经打开的详情、别的窗口停在旧值。
 *
 * 全部离线，只用一个临时目录，不发网络请求。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Runtime } from '../app/index.mjs'
import { allToolNames, registerTools } from '../ability/index.mjs'

// 每个测试文件是独立进程，全局工具注册表默认是空的。
// 不注册的话技能第一道闸就是「还没接上」，配置变化根本传不到状态判断里。
registerTools(allToolNames())

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

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), 'sl-cfgsync-'))
  return { dir, runtime: new Runtime({ dir }) }
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const readSource = (relative) => readFileSync(path.join(ROOT, relative), 'utf8')

console.log('\n配置变更联动')

await check('任何入口改配置都会广播：带变更键、修订号、来源，且修订号单调递增', async () => {
  const { runtime } = fresh()
  const seen = []
  const off = runtime.onConfigChange((change) => { seen.push(change); return { tag: 'ok' } })
  const first = runtime.setConfig('persona.verbosity', 'brief')
  const second = runtime.setConfig('guard.perMinute', 7)
  assert.equal(seen.length, 2)
  assert.equal(seen[0].key, 'persona.verbosity')
  assert.deepEqual(seen[0].keys, ['persona.verbosity'])
  assert.equal(seen[0].source, 'set')
  assert.equal(seen[0].full, false)
  assert.equal(seen[0].revision, 1)
  assert.equal(seen[1].revision, 2)
  assert.equal(first.revision, 1)
  assert.equal(second.revision, 2)
  assert.equal(seen[0].config, runtime.config, '订阅者拿到的是当前配置引用，不是改前的副本')
  off()
})

await check('记忆参数的构造时快照跟着热更新（不需要经过 /config 路由）', () => {
  const { runtime } = fresh()
  const before = runtime.memory.maxEntries
  const result = runtime.setConfig('memory.maxEntries', 777)
  assert.equal(result.ok, true)
  assert.notEqual(before, 777)
  assert.equal(runtime.memory.maxEntries, 777, 'WhaleMemory 在构造时拷走了值，必须由 #reconfigure 重装')
  const net = runtime.setConfig('memory.net.hops', 4)
  assert.equal(net.ok, true)
  assert.equal(runtime.memory.netHops, 4)
})

await check('退订后不再收到通知，改动本身照常成功', () => {
  const { runtime } = fresh()
  let hits = 0
  const off = runtime.onConfigChange(() => { hits += 1 })
  runtime.setConfig('guard.perMinute', 5)
  off()
  const result = runtime.setConfig('guard.perMinute', 6)
  assert.equal(hits, 1)
  assert.equal(result.ok, true)
})

await check('一个订阅者抛错不影响其它订阅者，也不影响配置改动', async () => {
  const { runtime } = fresh()
  let good = 0
  runtime.onConfigChange(() => { throw new Error('故意炸') })
  runtime.onConfigChange(() => { good += 1; return { tag: 'good' } })
  const result = runtime.setConfig('guard.perMinute', 8)
  assert.equal(result.ok, true)
  assert.equal(good, 1)
  const effects = await result.effects
  assert.deepEqual(effects, [{ tag: 'good' }])
})

await check('订阅者可返回同步对象或 Promise；失败的 Promise 被隔离，effects 不污染响应', async () => {
  const { runtime } = fresh()
  runtime.onConfigChange(() => ({ login: { state: 'online' } }))
  runtime.onConfigChange(async () => ({ message: '按新方式重试过了' }))
  runtime.onConfigChange(async () => { throw new Error('重试失败') })
  const result = runtime.setConfig('guard.perMinute', 9)
  const effects = await result.effects
  assert.equal(effects.length, 2)
  assert.ok(effects.some((e) => e.login && e.login.state === 'online'))
  assert.ok(effects.some((e) => e.message === '按新方式重试过了'))
  assert.equal(JSON.stringify(result).includes('effects'), false, 'effects 必须不可枚举，否则会被序列化 / 深比较看见')
})

await check('没改成的操作不推进修订号（不存在的键 / 校验失败 / 等二次确认）', () => {
  const { runtime } = fresh()
  let hits = 0
  runtime.onConfigChange(() => { hits += 1 })
  assert.equal(runtime.setConfig('nope.notThere', 1).ok, false)
  assert.equal(runtime.setConfig('guard.perMinute', 'not-a-number').ok, false)
  assert.equal(runtime.setConfig('identity.ownerId', '99999').needConfirm, true)
  assert.equal(runtime.configRevision, 0, '没落盘的改动不该让界面以为配置变了')
  assert.equal(hits, 0)
})

await check('外部改 config.json 后 reload：按真实 diff 广播，full=true，联动照常触发', async () => {
  const { runtime, dir } = fresh()
  const seen = []
  runtime.onConfigChange((change) => { seen.push(change); return { relinked: true } })
  // 先落一份盘
  runtime.setConfig('guard.perMinute', 3)
  const file = path.join(dir, 'config.json')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  onDisk.guard.perMinute = 11
  onDisk.persona.verbosity = 'chatty'
  writeFileSync(file, JSON.stringify(onDisk, null, 2), 'utf8')
  const result = runtime.reloadConfig()
  const change = seen[seen.length - 1]
  assert.equal(result.ok, true)
  assert.equal(change.source, 'reload')
  assert.equal(change.full, true)
  assert.ok(change.keys.includes('guard.perMinute'))
  assert.ok(change.keys.includes('persona.verbosity'))
  assert.equal(runtime.config.guard.perMinute, 11)
  assert.equal(runtime.memory.maxEntries, onDisk.memory.maxEntries)
  const effects = await result.effects
  assert.ok(effects.some((e) => e.relinked === true), 'reload 也要走同一套联动，不能再是路由里的另一份清单')
})

await check('看过技能页之后再改设置，技能视图跟着变（缓存不能只靠对象引用失效）', () => {
  const { runtime } = fresh()
  const itemOf = () => runtime.skills().groups.flatMap((g) => g.items).find((row) => row.id === 'net.search')
  const before = itemOf()
  assert.equal(before.state, 'blocked', '默认白名单是空的')
  assert.equal(runtime.setConfig('net.allowlist', 'api.qq.com').ok, true)
  const after = itemOf()
  assert.equal(after.state, 'on', '先建立过缓存再改配置，也必须立刻重算')
  assert.equal(runtime.setConfig('net.quotaPerHour', 0).ok, true)
  assert.equal(itemOf().state, 'blocked', '再改回去同样要刷新')
})

await check('面板关掉「长期记忆」：不注入上下文、不写入，重新打开立刻恢复且不丢记忆', () => {
  const { runtime } = fresh()
  runtime.memory.rememberFact('阿土喜欢观鸟')
  assert.equal(runtime.memory.digest({ query: '观鸟' }).facts.length, 1)
  runtime.setConfig('memory.enabled', false)
  assert.equal(runtime.memory.enabled, false, '开关必须由 #reconfigure 热更新')
  assert.equal(runtime.memory.digest({ query: '观鸟' }).facts.length, 0)
  assert.equal(runtime.memory.rememberFact('新事实').ok, false)
  assert.equal(runtime.memory.facts().length, 1, '关着的时候不许往里写')
  runtime.setConfig('memory.enabled', true)
  assert.equal(runtime.memory.digest({ query: '观鸟' }).facts.length, 1, '已有记忆不删')
  assert.equal(runtime.memory.rememberFact('又一条').ok, true)
})

await check('前后端联动契约：响应统一注入 revision，前端由修订号驱动整页刷新', () => {
  const server = readSource('index.js')
  const client = readSource('lib/client.panel.js')
  assert.match(server, /function sendJson[\s\S]{0,600}\brevision\b/, '所有 HTTP 响应都要带修订号')
  assert.match(server, /onConfigChange\(/, '装配处必须订阅配置变更，联动不能只写在路由里')
  assert.match(server, /configRevision/, '修订号要来自 Runtime')
  assert.match(client, /seenRevision/, '前端要记住见过的修订号')
  assert.match(client, /onRevisionChange/, '前端要有修订号变化时刷新全视图的钩子')
  assert.match(client, /revision !== seenRevision/, '修订号变了才刷新，别每 5 秒都重拉详情')
  assert.match(client, /localConfigWrites/, '要能区分「自己保存的」和「别处改的」，别清掉正在编辑的草稿')
})

if (failed.length) {
  console.log(`\n✗ 配置变更联动：${failed.length} 项失败`)
  for (const { name, err } of failed) console.log(`  · ${name}: ${err?.message ?? err}`)
  process.exit(1)
}
console.log(`\n✓ 配置变更联动：${passed} 项通过`)
