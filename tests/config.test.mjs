/**
 * 配置（config）用例：形状、迁移幂等、校验、脱敏 diff。
 * 全部离线，不碰磁盘。
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, clone, defaultKeys, diff, flatten, get, migrate, report, set, unflatten } from '../truth/index.mjs'
import { PENDING_KEYS, coverage, editable, find, isPending, readonlyItems, validate } from '../truth/index.mjs'
import { scanIdle } from '../scripts/check-config-consumers.mjs'

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

console.log('\n配置')

await check('结构锁：默认配置的每个键都在面板登记过，面板的每个可改项都有默认值', () => {
  const result = coverage(defaultKeys())
  assert.deepEqual(result.missing, [], '配置里有、面板没登记的键')
  assert.deepEqual(result.extra, [], '面板登记了、配置里却没有的键')
  assert.equal(result.ok, true)
  assert.equal(result.ratio, 1)
})

await check('键的数量与面板自述一致（不是拍脑袋写死的数字）', () => {
  assert.equal(defaultKeys().length, editable().length)
  assert.ok(defaultKeys().length >= 50, `配置键应有 50 个以上，实际 ${defaultKeys().length}`)
})

await check('扁平化：嵌套变点号，数组当叶子不展开', () => {
  const flat = flatten({ a: { b: 1, c: { d: 2 } }, list: ['x', 'y'] })
  assert.deepEqual(flat, { 'a.b': 1, 'a.c.d': 2, list: ['x', 'y'] })
})

await check('反扁平化：能还原成嵌套结构（往返一致）', () => {
  const source = { a: { b: 1, c: { d: 2 } }, list: ['x'] }
  assert.deepEqual(unflatten(flatten(source)), source)
})

await check('取值：点号路径，取不到给 undefined 而不是抛错', () => {
  assert.equal(get({ a: { b: { c: 7 } } }, 'a.b.c'), 7)
  assert.equal(get({ a: 1 }, 'a.b.c'), undefined)
  assert.equal(get(null, 'a'), undefined)
})

await check('默认值本身合法：迁移一遍既不补也不丢也不修', () => {
  const result = migrate(DEFAULTS)
  assert.deepEqual(result.filled, [])
  assert.deepEqual(result.dropped, [])
  assert.deepEqual(result.repaired, [])
  assert.deepEqual(result.config, DEFAULTS)
})

await check('迁移：空配置补齐全部键', () => {
  const result = migrate({})
  assert.equal(result.filled.length, defaultKeys().length)
  assert.deepEqual(result.config, DEFAULTS)
})

await check('迁移幂等：跑两遍和跑一遍完全一样', () => {
  const once = migrate({ guard: { perMinute: 20 }, 旧键: 1 })
  const twice = migrate(once.config)
  assert.deepEqual(twice.config, once.config)
  assert.deepEqual(twice.filled, [])
  assert.deepEqual(twice.dropped, [])
})

await check('迁移：不认识的旧键丢掉，但报出来（不是静默吞掉）', () => {
  const result = migrate({ guard: { perMinute: 20 }, legacyThing: true, 'a.b.c': 1 })
  assert.ok(result.dropped.includes('legacyThing'))
  assert.ok(result.dropped.includes('a.b.c'))
  assert.equal(get(result.config, 'guard.perMinute'), 20)
})

await check('迁移：一个坏键不会连累其他键（这是最要命的一种重置）', () => {
  const result = migrate({ guard: { perMinute: 30, nightWindow: '25:99-99:99' }, persona: { name: '阿蓝' } })
  assert.equal(get(result.config, 'guard.perMinute'), 30, '好的值必须原样保留')
  assert.equal(get(result.config, 'persona.name'), '阿蓝')
  assert.ok(result.repaired.includes('guard.nightWindow'), '坏值要报出来')
  assert.equal(get(result.config, 'guard.nightWindow'), DEFAULTS.guard.nightWindow)
})

await check('迁移：数字用字符串给也能收（老配置常这么存）', () => {
  const result = migrate({ guard: { perMinute: '12' } })
  assert.equal(get(result.config, 'guard.perMinute'), 12)
  assert.equal(typeof get(result.config, 'guard.perMinute'), 'number')
})

await check('迁移：文本超长截断而不是整段清空（人设不能丢）', () => {
  const long = '啊'.repeat(30_000)
  const result = migrate({ persona: { persona: long } })
  const value = get(result.config, 'persona.persona')
  assert.equal(value.length, find('persona.persona').maxLen)
  assert.ok(result.repaired.includes('persona.persona'))
})

await check('迁移：布尔用 "true"/"false" 字符串也能收', () => {
  const result = migrate({ memory: { enabled: 'false' } })
  assert.equal(get(result.config, 'memory.enabled'), false)
})

await check('迁移：白名单既收数组也收换行分隔的文本，统一成数组', () => {
  assert.deepEqual(get(migrate({ net: { allowlist: ['a.com', 'b.com'] } }).config, 'net.allowlist'), ['a.com', 'b.com'])
  assert.deepEqual(get(migrate({ net: { allowlist: 'a.com\nb.com' } }).config, 'net.allowlist'), ['a.com', 'b.com'])
})

await check('改配置：只读项改不动', () => {
  const result = set(DEFAULTS, 'status.todayTokens', 100)
  assert.equal(result.ok, false)
  assert.match(result.error, /只读/)
})

await check('改配置：不存在的键明确报错', () => {
  const result = set(DEFAULTS, 'nope.nope', 1)
  assert.equal(result.ok, false)
  assert.match(result.error, /没有这一项/)
})

await check('改配置：越界被拦，边界值放行', () => {
  assert.equal(set(DEFAULTS, 'guard.perMinute', 0).ok, false)
  assert.equal(set(DEFAULTS, 'guard.perMinute', 61).ok, false)
  assert.equal(set(DEFAULTS, 'guard.perMinute', 1).ok, true)
  assert.equal(set(DEFAULTS, 'guard.perMinute', 60).ok, true)
})

await check('改配置：不改入参（面板回滚时还要用原值）', () => {
  const before = clone(DEFAULTS)
  const result = set(DEFAULTS, 'guard.perMinute', 20)
  assert.equal(result.ok, true)
  assert.deepEqual(DEFAULTS, before)
  assert.equal(get(result.config, 'guard.perMinute'), 20)
})

await check('改配置：标出「要不要重启」「要不要二次确认」', () => {
  const restart = set(DEFAULTS, 'channel.wsUrl', 'ws://127.0.0.1:3002')
  assert.equal(restart.needRestart, true)
  assert.equal(restart.needConfirm, false)

  const danger = set(DEFAULTS, 'sandbox.mode', 'ask')
  assert.equal(danger.needConfirm, true)

  const live = set(DEFAULTS, 'guard.perMinute', 20)
  assert.equal(live.needRestart, false)
  assert.equal(live.needConfirm, false)
})

await check('对比：改了什么、要不要重启，一眼能看出来', () => {
  // 用 wsUrl 当「重启项」的样本：log.level 在 0.30.1 接上了执行器，
  // 现在是即时项（改完下一条日志就按新门槛走），拿它验重启会验错。
  const before = DEFAULTS.channel.wsUrl
  const after = set(DEFAULTS, 'channel.wsUrl', 'ws://127.0.0.1:3002').config
  const result = diff(DEFAULTS, after)
  assert.equal(result.changed.length, 1)
  assert.equal(result.changed[0].key, 'channel.wsUrl')
  assert.equal(result.changed[0].before, before)
  assert.equal(result.changed[0].after, 'ws://127.0.0.1:3002')
  assert.equal(result.needRestart, true)

  // 反过来验：日志级别不该再要求重启（它每次打印都现读配置）
  assert.equal(diff(DEFAULTS, set(DEFAULTS, 'log.level', 'debug').config).needRestart, false)
})

await check('对比：敏感项只显示「有没有配」，永不回显原值', () => {
  const after = set(DEFAULTS, 'channel.token', 'super-secret-token').config
  const result = diff(DEFAULTS, after)
  const item = result.changed.find((one) => one.key === 'channel.token')
  assert.equal(item.after, '***')
  assert.ok(!JSON.stringify(result).includes('super-secret-token'))
})

await check('启动摘要：说清补了几个、丢了几个、修了几个', () => {
  const result = migrate({ legacy: 1, guard: { nightWindow: 'bad' } })
  const text = report(result)
  assert.match(text, /补了 \d+ 个新键/)
  assert.match(text, /丢弃 1 个旧键/)
  assert.match(text, /修好 1 个坏值/)
  assert.equal(report({ filled: [], dropped: [], repaired: [] }), '配置没有变化')
})

await check('只读状态项不进配置（配置里出现它们就是结构错误）', () => {
  const keys = new Set(defaultKeys())
  for (const item of readonlyItems()) {
    assert.ok(!keys.has(item.key), `${item.key} 是状态，不该出现在配置文件里`)
  }
})

// ── 这三条是自检第一轮的产物：脏值能悄悄溜进配置，然后在提示词里显形 ──

await check('计数类一律取整：3.7 条消息不存在，写进提示词会变成「分 2~3.7 条」', () => {
  const result = migrate({ persona: { maxParts: 3.7 } })
  assert.equal(get(result.config, 'persona.maxParts'), 4, '四舍五入到 4')
  assert.equal(validate('persona.maxParts', 3.7).value, 4)
  assert.equal(validate('guard.perMinute', 8.4).value, 8)
})

await check('小数类不取整：衰减系数 0.82 不能被抹成 1', () => {
  assert.equal(validate('memory.net.decay', 0.82).value, 0.82)
  assert.equal(validate('usage.inputPerM', 0.5).value, 0.5)
  assert.equal(validate('evolve.ema', 0.07).value, 0.07)
})

await check('布尔不能当数字：true 不等于「每分钟 1 条」', () => {
  const result = validate('guard.perMinute', true)
  assert.equal(result.ok, false)
  assert.match(result.error, /不是开关/)
  assert.equal(get(migrate({ guard: { perMinute: true } }).config, 'guard.perMinute'), 15, '应回默认值')
})

await check('文本字段传 undefined / null 不算「清空」，要被拒（清空请传空字符串）', () => {
  assert.equal(validate('guard.nightWindow', undefined).ok, false)
  assert.equal(validate('guard.nightWindow', null).ok, false)
  assert.equal(validate('guard.nightWindow', '').ok, true, '空字符串才是合法的清空')
})

await check('文本前后空格自动去掉（否则「 23:00-07:00 」会被格式校验拒掉）', () => {
  assert.deepEqual(validate('guard.nightWindow', ' 23:00-07:00 '), { ok: true, value: '23:00-07:00' })
  assert.equal(validate('persona.name', '  阿蓝  ').value, '阿蓝')
})

// ── 空转项：面板上说能改、其实没人读的那些，必须有一份对得上的名册 ──
await check('「还没接上」的名册与源码扫描结果完全一致', () => {
  const { idle } = scanIdle()
  const listed = [...PENDING_KEYS].sort()
  const actual = [...idle].sort()
  assert.deepEqual(listed.filter((key) => !actual.includes(key)), [], '名册里有、源码里已无引用的键')
  const implemented = actual.filter((key) => !listed.includes(key))
  if (implemented.length) console.log('  · 源码扫描未识别但已实现（不标暂不生效）：' + implemented.join(', '))
})

await check('配置消费者扫描必须覆盖所有已落地父模块，不能只扫 lib/', () => {
  const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const onlyLib = scanIdle([path.join(ROOT, 'lib')]).idle
  const all = scanIdle().idle
  // 这几个键的执行点在 base/log.mjs、facts/usage.mjs、channel/napcat.mjs ——
  // 都是前几批从 lib/ 搬出去的。只扫 lib/ 会把它们误报成「没人读」，
  // 用户就会以为面板上的开关是空的。这条钉住扫描范围不许缩回去。
  const moved = ['log.level', 'usage.inputPerM', 'channel.login.autoQr']
  for (const key of moved) {
    assert.ok(onlyLib.includes(key), `${key} 在只扫 lib/ 时应被误报（对照用）`)
    assert.ok(!all.includes(key), `${key} 的真实消费者在父模块目录里，不该判没人读`)
  }
  assert.ok(all.length <= onlyLib.length, '扫描范围扩大只会让「没人读」变少，不会变多')
})

await check('名册里的键都真的存在于配置（不能指着一个不存在的键说有 39 项）', () => {
  const keys = new Set(defaultKeys())
  for (const key of PENDING_KEYS) assert.ok(keys.has(key), `${key} 不在配置里`)
})

await check('名册里不出现只读状态项（状态本来就不能改，谈不上空转）', () => {
  for (const item of readonlyItems()) {
    assert.equal(isPending(item.key), false, `${item.key} 是状态项，不该算空转配置`)
  }
})

await check('isPending 与名册一致', () => {
  for (const key of PENDING_KEYS) assert.equal(isPending(key), true)
  assert.equal(isPending('persona.name'), false, '打标器读了名字，这一项是活的')
})

console.log(`\n${failed.length ? '✗' : '✓'} 配置用例：${passed} 项通过`)
if (failed.length) {
  for (const item of failed) console.log(`  ${item.name}: ${item.err?.message ?? item.err}`)
  process.exit(1)
}
