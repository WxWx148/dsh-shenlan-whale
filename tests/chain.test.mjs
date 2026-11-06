/**
 * 串联用例（chain）—— 这一份才是「模块都对，但连起来不对」的照妖镜。
 *
 * 别的测试各测一个函数；这里只测一件事：
 *   一条原始消息进来，能不能一路走到出站那句话，并且**中间每一步都留得下痕迹**。
 *
 * 路径：raw → decide（打标 + 路由）→ logEvent → outcome → reflect（归纳 + 权重）
 *       → styleOptions → say.card → outbound
 *
 * 每一段都断言「上一步的产物被下一步真的用上了」（id 能对上、数字能算出来），
 * 而不是各跑各的。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runtime } from '../lib/runtime.mjs'
import { BEHAVIOR } from '../lib/behavior.mjs'
import { KIND, SCOPE, SOURCE, TAG } from '../lib/event.mjs'
import { defaultKeys } from '../lib/config.mjs'
import { PENDING_KEYS, find } from '../lib/panel.mjs'
import { allToolNames, registerTools } from '../lib/skill.mjs'

// 串联用例关心的是「链路通不通」，不是「执行器写没写」，所以先假定工具都已接上。
// 「一项都没接」时技能页该说什么，在 skill.test.mjs 里单独测。
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

const OWNER = '10001'
const AT = new Date(2026, 9, 29, 14, 0, 0).getTime()

const dirs = []
function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'chain-test-'))
  dirs.push(dir)
  return dir
}

/**
 * 起一个运行时。主人号是**必须显式配**的：
 * 空着就谁都不是主人，指令一律不执行 —— 宁可一开始不能用，也不能默认把
 * 「第一个找他/她说话的人」当成主人。
 */
function open(dir, at = AT) {
  const runtime = new Runtime({ dir, now: () => at })
  runtime.setConfig('identity.ownerId', OWNER, { confirm: true })
  return runtime
}

function message(extra = {}) {
  return { source: SOURCE.CHANNEL, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, from: OWNER, text: '在吗', at: AT, ...extra }
}

console.log('\n串联')

await check('空目录起得来：没有配置也是全套默认值，不是崩在启动', () => {
  const dir = sandbox()
  const runtime = new Runtime({ dir, now: () => AT })
  assert.equal(runtime.config.sandbox.mode, 'free')
  assert.equal(runtime.config.identity.ownerId, '', '没配主人号就是空，不能瞎猜')
  assert.deepEqual(Object.keys(flattenKeys(runtime.config)).sort(), defaultKeys(), '内存里的配置形状要与默认值一致')
})

await check('一条私聊走完全程：事件 → 回话 → 行为记录，id 对得上', () => {
  const dir = sandbox()
  const runtime = open(dir)

  const decision = runtime.decide(message())
  assert.equal(decision.behavior, BEHAVIOR.REPLY, '私聊应该回话')
  assert.equal(decision.event.kind, KIND.MESSAGE)
  assert.ok(decision.event.tags.includes(TAG.IS_OWNER))

  assert.equal(runtime.logEvent(decision.event).ok, true)
  const outcome = runtime.outcome({ eventId: decision.event.id, behavior: decision.behavior, trigger: decision.trigger, lines: 2, ms: 1200 })
  assert.equal(outcome.ok, true)

  const behaviors = runtime.behaviors.read({ limit: 10 }).rows
  assert.equal(behaviors.length, 1)
  assert.equal(behaviors[0].eventId, decision.event.id, '行为必须指回那条事件')
  assert.equal(behaviors[0].behavior, 'reply')

  const events = runtime.events.read({ limit: 10 }).rows
  assert.equal(events.length, 1)
  assert.equal(events[0].id, decision.event.id)
  assert.equal(events[0].type, 'message', '落盘要保留原类型，否则归纳层认不出消息')
})

await check('群里没点到的：进事件流、不产生行为（这是统计能对上的前提）', () => {
  const dir = sandbox()
  const runtime = open(dir)

  const decision = runtime.decide(message({ scope: SCOPE.GROUP, groupId: '900', from: '20002', text: '今晚吃啥' }))
  assert.equal(decision.behavior, null)
  assert.equal(decision.trigger, 'group_not_addressed')

  runtime.logEvent(decision.event)
  assert.equal(runtime.events.read({ limit: 10 }).rows.length, 1, '事件要留')
  assert.equal(runtime.behaviors.read({ limit: 10 }).rows.length, 0, '行为不该有')
})

await check('陌生人发指令：不执行，但也不假装没看见（事件仍然落盘）', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const decision = runtime.decide(message({ kind: KIND.COMMAND, from: '99999', text: '/restart' }))
  assert.equal(decision.behavior, null)
  assert.equal(decision.trigger, 'command_not_owner')
  assert.equal(runtime.logEvent(decision.event).ok, true)
})

await check('归纳读得到刚落的两类记录：响应率算得出来', () => {
  const dir = sandbox()
  const runtime = open(dir)

  const replied = runtime.decide(message())
  runtime.logEvent(replied.event)
  runtime.outcome({ eventId: replied.event.id, behavior: 'reply', trigger: 'private', lines: 2, ms: 1000 })

  const silent = runtime.decide(message({ scope: SCOPE.GROUP, groupId: '900', from: '20002', text: '随便聊聊' }))
  runtime.logEvent(silent.event)

  const { stats } = runtime.reflect({ reason: '手动跑一次归纳', sample: ['manual'] })
  assert.equal(stats.sample, 2, '两条消息都要数进来')
  assert.equal(stats.replyRate, 1, '需要回的只有私聊那一条，回了')
  assert.equal(stats.avgMs, 1000)
  assert.match(stats.line, /回了 1 次/)
})

await check('归纳落盘：induction.json 里就是刚才那份', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const decision = runtime.decide(message())
  runtime.logEvent(decision.event)
  runtime.outcome({ eventId: decision.event.id, behavior: 'reply', ms: 500 })
  const { stats } = runtime.reflect({})
  const file = path.join(dir, 'induction.json')
  assert.ok(existsSync(file), '归纳结果要落盘，面板才读得到')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.sample, stats.sample)
  assert.equal(saved.line, stats.line)
})

await check('反思带奖励 → 权重真的动了，且带得出证据', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const decision = runtime.decide(message())
  runtime.logEvent(decision.event)
  runtime.outcome({ eventId: decision.event.id, behavior: 'reply', ms: 900 })

  const { evolve } = runtime.reflect({
    reason: '私聊被连续追问',
    sample: [decision.event.id],
    rewards: { behavior: { reply: 1 } },
  })
  assert.equal(evolve.ok, true)
  assert.equal(evolve.changes.length, 1)
  assert.equal(runtime.evolver.current().behaviorWeight.reply > 1, true)

  const audit = runtime.audit.read({ limit: 10 }).rows
  assert.ok(audit.some((row) => row.kind === 'evolve'), '进化要留审计')
})

await check('反思没给奖励时只归纳、不动权重（看和动分开）', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const before = runtime.evolver.current()
  const { evolve } = runtime.reflect({})
  assert.equal(evolve.ok, false)
  assert.deepEqual(runtime.evolver.current(), before)
})

await check('说话参数：进化值被用户配置封顶，规则块直接可用', () => {
  const dir = sandbox()
  const runtime = open(dir)
  runtime.config.persona.maxParts = 2
  runtime.config.persona.maxReplyChars = 16

  const options = runtime.styleOptions('group')
  assert.equal(options.maxParts, 2)
  assert.equal(options.maxChars, 16)
  assert.equal(options.channel, 'group')

  const guide = runtime.styleGuide('group')
  assert.match(guide, /2~2 条/, '规则块要用进化后的条数')
  assert.match(guide, /群里 1~2 条/)
  assert.ok(guide.length <= 220, `规则块不能写成文章，实际 ${guide.length} 字`)
})

await check('出站：QQ 只给一句话，代码和链接一律不出门', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const view = runtime.card({
    label: '算了一下你俩这周的聊天密度',
    ms: 800,
    facts: ['语言：Python', '联网：否'],
    code: 'print(1)',
    artifact: { kind: 'chart', title: '本周消息量', url: 'file:///D:/secret/a.png' },
  })
  const qq = runtime.outbound(view, 'qq')
  assert.match(qq, /做好了/)
  assert.ok(!qq.includes('print'), 'QQ 里不该有代码')
  assert.ok(!qq.includes('语言：'), 'QQ 里不该有细节事实')
  assert.ok(!qq.includes('file:///'), 'QQ 里点不开本地文件，别甩地址')

  const panel = runtime.outbound(view, 'panel', 'detail')
  assert.match(panel, /语言：Python/)
  assert.ok(!panel.includes('print'), '细节层仍然不给源码')

  const source = runtime.outbound(view, 'panel', 'source')
  assert.match(source, /print\(1\)/, '只有源码层才给代码')
})

await check('失败也走同一条出站：错误被翻成人话，不甩堆栈', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const view = runtime.card({ label: '读文件', error: 'ENOENT: no such file or directory' })
  const qq = runtime.outbound(view, 'qq')
  assert.match(qq, /没做成：文件不存在/)
  assert.ok(!qq.includes('ENOENT'))
})

await check('改配置：危险项要确认，不确认就不写盘', () => {
  const dir = sandbox()
  const runtime = open(dir)

  const refused = runtime.setConfig('identity.ownerId', '1234567890')
  assert.equal(refused.ok, false)
  assert.equal(refused.needConfirm, true)
  assert.equal(runtime.config.identity.ownerId, '10001', '没确认就不许动')

  const ok = runtime.setConfig('identity.ownerId', '1234567890', { confirm: true })
  assert.equal(ok.ok, true)
  assert.equal(runtime.config.identity.ownerId, '1234567890')
  assert.ok(runtime.audit.read({ limit: 10 }).rows.some((row) => row.kind === 'config'))
})

await check('改配置：重启项标出来，即时项立刻生效（含打标器）', () => {
  const dir = sandbox()
  const runtime = open(dir)

  // 通道层写完之后，wsUrl 是真的有人读了，所以它现在是「重启后生效」，不再是空转。
  const restart = runtime.setConfig('channel.wsUrl', 'ws://127.0.0.1:3002')
  assert.equal(restart.needRestart, true)
  assert.equal(restart.pending, false, '有人读的项不该再被标成空转')
  assert.equal(runtime.dirtyRestart, true)
  assert.match(restart.message, /重启后生效/)

  // 日志级别 0.30.1 起是即时项：每次打印都现读配置，所以不该让人去重启
  const level = runtime.setConfig('log.level', 'debug')
  assert.equal(level.ok, true)
  assert.equal(level.pending, false)
  assert.equal(level.needRestart, false, '级别是每次打印现读的，不需要重启')

  // 已接上的即时项：改完立刻生效
  const live = runtime.setConfig('persona.name', '阿蓝')
  assert.equal(live.needRestart, false)
  assert.equal(live.pending, false)
  assert.match(live.message, /下一条消息就生效/)
  const decision = runtime.decide(message({ scope: SCOPE.GROUP, groupId: '900', from: '20002', text: '阿蓝在吗' }))
  assert.equal(decision.trigger, 'name_called', '改了名字，打标器要立刻认新名字')
})

await check('改配置留痕：审计里写清当时生没生效、要不要重启', () => {
  const runtime = open(sandbox())
  const result = runtime.setConfig('log.level', 'debug')
  assert.equal(result.ok, true)
  const row = runtime.audit.read({ limit: 10 }).rows.find((item) => item.kind === 'config')
  assert.ok(row, '改设置必须留一条审计')
  assert.equal(row.pending, false, '这一项真生效了，不能写「没接上」')
  assert.equal(row.needRestart, false, '即时项不该被记成重启项')
})

await check('日志级别真的管用：调高门槛后低级别不再输出，调回来就恢复', () => {
  const runtime = open(sandbox())
  const seen = []
  runtime.setTracer((level, text) => seen.push(`${level}:${text}`))
  assert.equal(runtime.trace('info', '常规一行'), true, '默认 info 门槛，info 应该出来')
  assert.equal(seen.length, 1)

  runtime.setConfig('log.level', 'error')
  assert.equal(runtime.trace('info', '常规一行'), false)
  assert.equal(runtime.trace('warn', '警告一行'), false)
  assert.equal(runtime.trace('error', '错误一行'), true)
  assert.deepEqual(seen.slice(1), ['error:错误一行'], '只放行 error')

  // 级别只管「打印」，不管「落盘」：调成只记错误之后，审计照样记
  const before = runtime.audit.read({ limit: 200 }).rows.length
  runtime.log('channel_state', { after: 'online' })
  const after = runtime.audit.read({ limit: 200 }).rows.length
  assert.equal(after, before + 1, '审计不受级别影响 —— 调级别不会少记一条')
})

await check('状态页的「还没接上」数量与 PENDING_KEYS 一致（现在应为 0）', () => {
  const runtime = open(sandbox())
  assert.equal(runtime.status()['status.pendingConfig'], PENDING_KEYS.length)
  // 0.30.1 起这一栏是空的：最后一个空转项 log.level 也接上了。
  // 以后要是再加「先摆着」的开关，必须先登记进 PENDING_KEYS —— 这条断言会提醒你。
  assert.equal(PENDING_KEYS.length, 0, '有开关回到清单里了，去面板确认它是不是真的能生效')
})

await check('改配置：非法值被拦，并且留下「为什么拒」的审计', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const result = runtime.setConfig('guard.perMinute', 0)
  assert.equal(result.ok, false)
  const audit = runtime.audit.read({ limit: 10 }).rows
  assert.ok(audit.some((row) => row.kind === 'config_reject'), '拒绝也要留痕')
})

await check('落盘再开：配置与权重都还在（重启不丢学习成果）', () => {
  const dir = sandbox()
  const first = open(dir)
  first.setConfig('guard.perMinute', 9)
  first.reflect({ reason: '第一轮', sample: ['e1'], rewards: { behavior: { reply: 1 } } })
  const savedVersion = first.evolver.summary(AT).version
  const savedReply = first.evolver.current().behaviorWeight.reply
  first.save()

  const second = open(dir)
  assert.equal(second.config.guard.perMinute, 9)
  assert.equal(second.evolver.summary(AT).version, savedVersion)
  assert.equal(second.evolver.current().behaviorWeight.reply, savedReply)
})

await check('配置文件只有登记的键，没有野键（结构上不可能「有配置没面板」）', () => {
  const dir = sandbox()
  const runtime = open(dir)
  runtime.save()
  const saved = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'))
  const expected = new Set(defaultKeys())
  const actual = new Set(Object.keys(flattenKeys(saved)))
  assert.deepEqual([...actual].filter((key) => !expected.has(key)), [], '写出去的键必须都登记过')
  assert.deepEqual([...expected].filter((key) => !actual.has(key)), [], '登记的键必须都写出去')
})

await check('状态面板取得到数：键都是面板登记过的只读项', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const decision = runtime.decide(message())
  runtime.logEvent(decision.event)
  runtime.outcome({ eventId: decision.event.id, behavior: 'reply' })

  const status = runtime.status()
  assert.equal(status['status.version'], JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version)
  assert.equal(status['status.todayMessages'], 1)
  assert.equal(status['status.auditCount'] >= 0, true)
  assert.equal(status['status.behaviorCount'], 1)
  assert.equal(typeof status['status.uptime'], 'number')
  for (const key of Object.keys(status)) {
    assert.ok(key.startsWith('status.'), `${key} 应是 status.* 的只读项`)
  }
})

await check('同一个运行时连跑 3 条：计数器、归纳、状态三处数字一致', () => {
  const dir = sandbox()
  const runtime = open(dir)

  const one = runtime.decide(message())
  runtime.logEvent(one.event)
  runtime.outcome({ eventId: one.event.id, behavior: 'reply', ms: 300 })

  const two = runtime.decide(message({ at: AT + 5000 }))
  runtime.logEvent(two.event)
  runtime.outcome({ eventId: two.event.id, behavior: 'reply', ms: 500 })

  const three = runtime.decide(message({ scope: SCOPE.GROUP, groupId: '901', from: '20002', text: '路过' }))
  runtime.logEvent(three.event)

  assert.equal(runtime.events.read({ limit: 10 }).rows.length, 3)
  assert.equal(runtime.behaviors.read({ limit: 10 }).rows.length, 2)
  const { stats } = runtime.reflect({})
  assert.equal(stats.sample, 3)
  assert.equal(stats.replyRate, 1, '两次需要回，回了两条（第三条群里没点到）')
  assert.equal(stats.avgMs, 400)
  assert.equal(runtime.status()['status.behaviorCount'], 2)
})

function flattenKeys(input, prefix = '', out = {}) {
  for (const [key, value] of Object.entries(input || {})) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenKeys(value, dotted, out)
    else out[dotted] = value
  }
  return out
}

// ── 这一条是自检第三轮的产物：坏文件能回退到默认值，但原件被静默覆盖了 ──

await check('配置坏掉：能起来、能留原件、能追溯（不是悄悄盖掉）', () => {
  const dir = sandbox()
  const file = path.join(dir, 'config.json')
  writeFileSync(file, '{"guard":{"perMinute":30},"persona":{"name":"阿蓝"')

  const runtime = open(dir)
  assert.equal(runtime.config.guard.perMinute, 15, '读不动就回默认值，不能崩')
  assert.equal(runtime.configIssues.recovered, true)

  const files = readdirSync(dir)
  const backup = files.find((name) => name.startsWith('config.json.bad-'))
  assert.ok(backup, `坏配置必须留备份，实际目录里只有：${files.join(', ')}`)
  assert.match(readFileSync(path.join(dir, backup), 'utf8'), /"perMinute":30/, '备份里要是原件内容')

  const audit = runtime.audit.read({ limit: 10 }).rows
  assert.ok(audit.some((row) => row.kind === 'recovered'), '恢复这件事本身要写审计')
})

await check('权重文件坏掉：同样留原件，学习历史不会被一启动就抹掉', () => {
  const dir = sandbox()
  const first = open(dir)
  first.evolver.apply({ reason: 'a', sample: ['1'], rewards: { behavior: { reply: 1 } } })
  first.save()
  writeFileSync(path.join(dir, 'evolve.json'), '{oops')

  const second = open(dir)
  assert.equal(second.evolver.summary(AT).version, 0, '坏了就回到第 0 版')
  assert.ok(readdirSync(dir).some((name) => name.startsWith('evolve.json.bad-')), '原件要留下')
})

// ── 跨模块契约：上游的产物，下游到底有没有用上 ──

await check('改设置要留下「原来是多少」：只记新值，事后无法撤销也无法追责', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const before = runtime.config.guard.perMinute
  runtime.setConfig('guard.perMinute', 5)
  const row = runtime.audit.read({ limit: 20 }).rows.find((r) => r.kind === 'config' && r.key === 'guard.perMinute')
  assert.ok(row, '要写一条 config 审计')
  assert.equal(row.before, before, `before 要是原值 ${before}，实际 ${row.before}`)
  assert.equal(row.after, 5)
})

await check('敏感项的前后值都不进审计', () => {
  const dir = sandbox()
  const runtime = open(dir)
  runtime.setConfig('channel.token', 'secret-abc', { confirm: true })
  const row = runtime.audit.read({ limit: 20 }).rows.find((r) => r.kind === 'config' && r.key === 'channel.token')
  assert.equal(row.before, '***')
  assert.equal(row.after, '***')
})

await check('通道状态由通道层报告，未报告时是「未知」而不是假装在线', () => {
  const dir = sandbox()
  const runtime = open(dir)
  runtime.setConfig('channel.enabled', true)
  assert.equal(runtime.status()['status.channel'], 'unknown', '没报告之前不能说在线')
  runtime.markChannel('online')
  assert.equal(runtime.status()['status.channel'], 'online')
  assert.equal(runtime.markChannel('已连接').ok, false, '词表外的状态要拒，否则面板会出现三种说法')
  assert.equal(runtime.status()['status.channel'], 'online', '拒绝后不能被污染')
})

await check('关掉通道立刻变 off，不留下一次过期的「在线」', () => {
  const dir = sandbox()
  const runtime = open(dir)
  runtime.setConfig('channel.enabled', true)
  runtime.markChannel('online')
  runtime.setConfig('channel.enabled', false)
  assert.equal(runtime.status()['status.channel'], 'off')
})

await check('今日收发只数消息，不把心跳和通知算成聊天', () => {
  const dir = sandbox()
  const runtime = open(dir)
  runtime.logEvent({ id: 'h1', kind: KIND.HEARTBEAT, scope: SCOPE.PRIVATE, tags: [], at: AT })
  runtime.logEvent({ id: 'n1', kind: KIND.NOTICE, scope: SCOPE.GROUP, tags: [], at: AT })
  runtime.logEvent({ id: 'm1', kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, tags: [], at: AT })
  assert.equal(runtime.status()['status.todayMessages'], 1, '只有那条 message 算收发')
})

await check('归纳的结果真的会推动权重：不传 rewards 也动', () => {
  const dir = sandbox()
  const runtime = open(dir)
  // 造 10 条「该回却没回」的消息：5 条私聊 + 5 条群里被 @，一条回复都不记
  for (let i = 0; i < 5; i += 1) {
    runtime.logEvent({ id: `p${i}`, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, tags: [], at: AT + i })
    runtime.logEvent({ id: `g${i}`, kind: KIND.MESSAGE, scope: SCOPE.GROUP, tags: [TAG.AT_ME], at: AT + i })
  }
  const result = runtime.reflect()
  assert.equal(result.stats.replyRate, 0, '一条都没回')
  assert.ok(result.evolve.ok, `该扣就扣，实际：${JSON.stringify(result.evolve)}`)
  assert.ok(
    runtime.evolver.current().behaviorWeight.reply < 1,
    `reply 权重该降下来，实际 ${runtime.evolver.current().behaviorWeight.reply}`,
  )
})

await check('调用方给的奖励优先于统计派生的（人比统计更懂现场）', () => {
  const dir = sandbox()
  const runtime = open(dir)
  for (let i = 0; i < 10; i += 1) {
    runtime.logEvent({ id: `p${i}`, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, tags: [], at: AT + i })
  }
  // 统计会说「该回没回」→ 扣分；调用方明确说这次回得好 → 以调用方为准
  runtime.reflect({ rewards: { behavior: { reply: 1 } } })
  assert.ok(
    runtime.evolver.current().behaviorWeight.reply > 1,
    `应以调用方的 +1 为准（权重上升），实际 ${runtime.evolver.current().behaviorWeight.reply}`,
  )
})

await check('同一批记录不会被反复学：群安静三天，权重不该被同一批数据扣到下限', () => {
  const dir = sandbox()
  const runtime = open(dir)
  for (let i = 0; i < 10; i += 1) {
    runtime.logEvent({ id: `p${i}`, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, tags: [], at: AT + i })
  }
  const first = runtime.reflect()
  const w1 = runtime.evolver.current().behaviorWeight.reply
  const second = runtime.reflect()
  const w2 = runtime.evolver.current().behaviorWeight.reply
  assert.equal(first.evolve.ok, true, '第一轮该学')
  assert.equal(second.evolve.ok, false, `第二轮没有新记录，不该学：${JSON.stringify(second.evolve)}`)
  assert.equal(w2, w1, `权重不该再动：${w1} → ${w2}`)
})

await check('学过之后来了新记录，只拿新的当样本', () => {
  const dir = sandbox()
  const runtime = open(dir)
  for (let i = 0; i < 10; i += 1) {
    runtime.logEvent({ id: `p${i}`, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, tags: [], at: AT + i })
  }
  runtime.reflect()
  for (let i = 10; i < 15; i += 1) {
    runtime.logEvent({ id: `p${i}`, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, tags: [], at: AT + 1000 + i })
  }
  const next = runtime.reflect()
  assert.equal(next.scanned, 5, `只该处理 5 条新记录，实际 ${next.scanned}`)
})

await check('学习进度文件坏掉：当没学过，不崩、也不悄悄跳过', () => {
  const dir = sandbox()
  const first = open(dir)
  for (let i = 0; i < 8; i += 1) {
    first.logEvent({ id: `p${i}`, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, tags: [], at: AT + i })
  }
  first.reflect()
  writeFileSync(path.join(dir, 'reflect-cursor.json'), '{broken')
  const second = open(dir)
  const result = second.reflect()
  assert.equal(result.evolve.ok, true, '读不出进度就重新学一遍，比漏学安全')
})

await check('学习进度停在「未来」时会自我修正，不会永久停学', () => {
  const dir = sandbox()
  writeFileSync(path.join(dir, 'reflect-cursor.json'), JSON.stringify({ at: AT + 365 * 24 * 3600 * 1000, id: 'z' }))
  const runtime = open(dir)
  for (let i = 0; i < 10; i += 1) {
    runtime.logEvent({ id: `p${i}`, kind: KIND.MESSAGE, scope: SCOPE.PRIVATE, tags: [], at: AT + i })
  }
  const result = runtime.reflect()
  assert.equal(result.scanned, 10, '系统时间被调回去之后，仍要能学到东西')
  assert.equal(result.evolve.ok, true)
  const audit = runtime.audit.read({ limit: 20 }).rows
  assert.ok(audit.some((row) => row.kind === 'reflect_cursor_future'), '这种异常要留痕')
})

await check('面板允许的范围就是真能生效的范围', () => {
  const dir = sandbox()
  const runtime = open(dir)
  for (const key of ['persona.maxParts', 'persona.maxReplyChars']) {
    const item = find(key)
    runtime.setConfig(key, item.max)
    const got = key.endsWith('maxParts') ? runtime.styleOptions().maxParts : runtime.styleOptions().maxChars
    assert.equal(got, item.max, `${key} 填面板上限 ${item.max}，实际应也是 ${item.max}，得到 ${got}`)
    runtime.setConfig(key, item.min)
    const low = key.endsWith('maxParts') ? runtime.styleOptions().maxParts : runtime.styleOptions().maxChars
    assert.equal(low, item.min, `${key} 填面板下限 ${item.min}，实际应也是 ${item.min}，得到 ${low}`)
  }
})

await check('出站空内容直接拒，不发出空白消息', () => {
  const dir = sandbox()
  const runtime = open(dir)
  assert.throws(() => runtime.outbound({ ok: true, line: '   ' }), /空/)
})

await check('出站超长会截断并留痕（否则这个 bug 永远查不到）', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const text = runtime.outbound(runtime.card({ line: '啊'.repeat(3000) }))
  assert.ok(text.length <= 1001, `实际 ${text.length} 字`)
  const audit = runtime.audit.read({ limit: 10 }).rows
  assert.ok(audit.some((row) => row.kind === 'outbound_too_long'), '超长要记一条审计')
})

await check('整份日志坏掉：挪走原件、从干净文件重来、留痕', () => {
  const dir = sandbox()
  writeFileSync(path.join(dir, 'events.jsonl'), '\u0000\u0001garbage\n{broken\n')
  const runtime = open(dir)
  assert.ok(readdirSync(dir).some((name) => name.startsWith('events.jsonl.bad-')), '原件要留下')
  assert.equal(runtime.events.append({ id: 'n1', kind: KIND.MESSAGE }).ok, true, '挪走后要能继续写')
  assert.equal(runtime.events.read({ limit: 3 }).rows.length, 1, '新记录要读得出来')
  const audit = runtime.audit.read({ limit: 10 }).rows
  assert.ok(audit.some((row) => row.kind === 'journal_quarantined'), '这件事要留痕')
})

await check('审计记录的 kind 不会被原始事件的类型顶掉', () => {
  const dir = sandbox()
  const runtime = open(dir)
  runtime.decide({ source: 'napcat', kind: 'message', scope: 'private', from: '9', text: 'x', at: AT })
  const row = runtime.audit.read({ limit: 10 }).rows[0]
  assert.equal(row.kind, 'invalid_event', `审计要按自己的类型存，实际 ${row.kind}`)
  assert.equal(row.eventKind, 'message', '原始事件的类型放在另一个字段')
})

// ── 技能：清单 → 鉴权 → 证据 → 落盘，全程串一条 ─────────────────
await check('技能页一次拿全：分组、计数、能说清的一句话', () => {
  const runtime = open(sandbox())
  const view = runtime.skills()
  assert.ok(view.groups.length > 0, '要有分组')
  assert.ok(view.counts.total > 0)
  assert.match(view.line, /会 \d+ 项/)
  assert.equal(view.autoLearn, undefined, '没有实际作用的开关不该留在视图里')
})

await check('默认配置下上网类技能是「用不了」，原因指向白名单', () => {
  const runtime = open(sandbox())
  const item = runtime.skills().groups.flatMap((g) => g.items).find((row) => row.id === 'net.search')
  assert.equal(item.state, 'blocked')
  assert.match(item.why, /白名单/)
})

await check('放开白名单后，同一项立刻变成能用（状态是现场算的，不是写死的）', () => {
  const runtime = open(sandbox())
  assert.equal(runtime.setConfig('net.allowlist', 'api.qq.com').ok, true)
  const item = runtime.skills().groups.flatMap((g) => g.items).find((row) => row.id === 'net.search')
  assert.equal(item.state, 'on')
})

await check('关一个技能会写审计，重启后还是关着', () => {
  const dir = sandbox()
  const runtime = open(dir)
  assert.equal(runtime.setSkill('talk.reply', 'off').ok, true)
  assert.ok(runtime.audit.read({ limit: 10 }).rows.some((row) => row.kind === 'skill_state'))
  const again = open(dir)
  const item = again.skills().groups.flatMap((g) => g.items).find((row) => row.id === 'talk.reply')
  assert.equal(item.state, 'off', '重启后不该自己又打开')
})

await check('教一个新技能：默认关着、重启还在、能点开', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const taught = runtime.teachSkill({ name: '记住车牌号', what: '看到车牌就记下来' })
  assert.ok(taught.ok)
  assert.match(taught.message, /关着的/)

  const reopened = open(dir)
  const found = reopened.skills().groups.flatMap((g) => g.items).find((row) => row.id === taught.id)
  assert.ok(found, '重启后教过的技能还在')
  assert.equal(found.state, 'off')

  assert.equal(reopened.setSkill(taught.id, 'on').ok, true)
  const after = reopened.skills().groups.flatMap((g) => g.items).find((row) => row.id === taught.id)
  assert.equal(after.state, 'on')
})

await check('教得太多会被拦住，并说明先忘掉几个', () => {
  const runtime = open(sandbox())
  runtime.setConfig('skills.maxTaught', 1)
  assert.equal(runtime.teachSkill({ name: '第一个' }).ok, true)
  const second = runtime.teachSkill({ name: '第二个' })
  assert.equal(second.ok, false)
  assert.match(second.error, /上限/)
})

await check('忘掉教过的：从清单消失，也落盘', () => {
  const dir = sandbox()
  const runtime = open(dir)
  const taught = runtime.teachSkill({ name: '临时本事' })
  assert.equal(runtime.forgetSkill(taught.id).ok, true)
  assert.equal(runtime.forgetSkill('talk.reply').ok, false, '出厂技能忘不掉')
  const reopened = open(dir)
  assert.equal(reopened.skills().groups.flatMap((g) => g.items).some((row) => row.id === taught.id), false)
})

await check('记成功不刷审计；第一次成功要留痕（那是「学会」的起点）', () => {
  const runtime = open(sandbox())
  runtime.recordSkill('net.search', true)
  const rows = runtime.audit.read({ limit: 10 }).rows
  assert.ok(rows.some((row) => row.kind === 'skill_use' && row.id === 'net.search'), '首次成功要留一条')
  const afterFirst = runtime.audit.stats().count
  runtime.recordSkill('net.search', true)
  runtime.recordSkill('net.search', true)
  assert.equal(runtime.audit.stats().count, afterFirst, '之后每次成功不该继续刷审计')
  assert.equal(runtime.skillBook.stats['net.search'].uses, 3, '但次数要记全')
})

await check('连续失败会自动关掉，并在审计里说清是哪一项', () => {
  const runtime = open(sandbox())
  const last = runtime.recordSkill('talk.reply', false)
  runtime.recordSkill('talk.reply', false)
  const third = runtime.recordSkill('talk.reply', false)
  assert.equal(last.autoOff, false)
  assert.equal(third.autoOff, true)
  const item = runtime.skills().groups.flatMap((g) => g.items).find((row) => row.id === 'talk.reply')
  assert.equal(item.state, 'off')
  const rows = runtime.audit.read({ limit: 10 }).rows
  assert.ok(rows.some((row) => row.kind === 'skill_use' && row.autoOff === true))
})

await check('状态页三个技能数接得上技能页的计数', () => {
  const runtime = open(sandbox())
  const view = runtime.skills()
  const status = runtime.status()
  assert.equal(status['status.skillOn'], view.counts.on)
  assert.equal(status['status.skillLearned'], view.counts.learned)
  assert.equal(status['status.skillBlocked'], view.counts.blocked)
})

await check('权重按技能名归位：对不上的单独报出来，不静默丢', () => {
  const runtime = open(sandbox())
  runtime.evolver.state.weights.toolWeight = { web_search: 1.4, mystery: 1.1 }
  const view = runtime.skills()
  assert.equal(view.weights[0].name, '上网搜一下')
  assert.equal(view.orphanWeights[0].tool, 'mystery')
})

await check('坏掉的 skills.json 先备份再重来，用户教的不会无声消失', () => {
  const dir = sandbox()
  writeFileSync(path.join(dir, 'skills.json'), '{坏掉的', 'utf8')
  const runtime = open(dir)
  assert.ok(readdirSync(dir).some((name) => name.startsWith('skills.json.bad-')), '原件要留下')
  assert.ok(runtime.skills().counts.total > 0, '备份后仍能正常用')
  const rows = runtime.audit.read({ limit: 20 }).rows
  assert.ok(rows.some((row) => row.kind === 'recovered' && row.skills))
})

await check('行为里带 tool 时，技能使用自动落账（接缝在 outcome）', () => {
  const runtime = open(sandbox())
  const result = runtime.outcome({ behavior: 'reply', eventId: 'e1', ok: true, tool: 'talk.reply', lines: 2, ms: 900 })
  assert.ok(result.ok, '行为本身要能落盘')
  assert.equal(runtime.skillBook.stats['talk.reply'].uses, 1, '技能次数应被顺手记上')
  assert.equal(runtime.skillBook.stats['talk.reply'].ok, 1)
})

await check('行为没带 tool 时不去动技能账本（不能凭空记一笔）', () => {
  const runtime = open(sandbox())
  runtime.outcome({ behavior: 'reply', eventId: 'e2', ok: true, lines: 1, ms: 500 })
  assert.equal(Object.keys(runtime.skillBook.stats).length, 0)
})

await check('技能账本里的失败与行为结果对齐', () => {
  const runtime = open(sandbox())
  runtime.outcome({ behavior: 'reply', eventId: 'e3', ok: false, tool: 'net.search' })
  assert.equal(runtime.skillBook.stats['net.search'].fail, 1)
})

await check('「你会什么」能直接走出站口（不再逼通道自己拼字符串）', () => {
  const runtime = open(sandbox())
  runtime.setConfig('net.allowlist', 'api.qq.com')
  const text = runtime.outbound(runtime.skillBriefing())
  assert.match(text, /会 \d+ 项/)
  assert.ok(text.split('\n').length <= 5, `行数 ${text.split('\n').length}，超过 5 行`)
})

await check('空的技能直答会被挡住，不发空白', () => {
  const runtime = open(sandbox())
  assert.throws(() => runtime.outbound(['', '   ']), /空的/)
})

await check('两条出站路径共用同一套超长截断', () => {
  const runtime = open(sandbox())
  const long = runtime.outbound([`x`.repeat(1200)])
  assert.equal(long.length, 1001, '截到 1000 加一个省略号')
  assert.ok(runtime.audit.read({ limit: 5 }).rows.some((row) => row.kind === 'outbound_too_long'))
})

await check('配置改自动关阈值，运行时的技能簿立刻跟上', () => {
  const runtime = open(sandbox())
  runtime.setConfig('skills.autoOffAfterFails', 1)
  assert.equal(runtime.skillBook.failStreakLimit, 1, '改完要马上生效，不能等重启')
  const r = runtime.recordSkill('talk.reply', false)
  assert.equal(r.autoOff, true)
})

// ── 实现检查：面板说「会」之前，先确认底下真的有东西 ──────────
// 这一组是这次补的最后一道闸门。它管的问题很朴素：
// 清单说会 18 项，可执行器一个都还没写，用户照着用会一无所获。

await check('执行器一个都没接时，状态页如实显示「还没接上」而不是「会 18 项」', () => {
  const runtime = open(sandbox())
  runtime.impl.clear() // 模拟通道、生成、沙箱都还没写
  const status = runtime.status()
  assert.equal(status['status.skillOn'], 0, '一项都不该算「会用」')
  assert.equal(status['status.skillNotWired'], status['status.skillBlocked'], '全部归到「还没接上」')
  assert.ok(status['status.skillNotWired'] > 0)

  const view = runtime.skills()
  assert.equal(view.counts.on, 0)
  assert.ok(view.unwired.length > 0, '要能列出还差哪些工具')
})

await check('接上一个工具，面板当场跟着变（不用改任何判定代码）', () => {
  const runtime = open(sandbox())
  runtime.impl.clear()
  // 两道闸门都要过才算能用：底层接上了，通道也得开着。
  // 只接工具不开通道仍然是 blocked —— 这不是测试的麻烦，而是真实的语义。
  runtime.setConfig('channel.enabled', true)
  const before = runtime.skills().counts.on

  const added = runtime.registerTools(['reply'])
  assert.deepEqual(added, ['reply'], '返回新接上的名字，装配处能打日志')

  const after = runtime.skills()
  assert.ok(after.counts.on > before, '接上 reply 之后，说话类技能应当立刻可用')
  assert.ok(!after.unwired.includes('reply'), '已接上的不该再出现在待接清单里')
})

await check('重复注册不重复记、不重复审计（每次启动都会跑一遍）', () => {
  const runtime = open(sandbox())
  runtime.impl.clear()
  runtime.registerTools(['reply'])
  const audited = () => runtime.audit.read({ limit: 50 }).rows.filter((row) => row.kind === 'tools_wired').length
  const first = audited()
  assert.equal(runtime.registerTools(['reply']).length, 0, '第二次没有新东西')
  assert.equal(audited(), first, '没有新接入就不该再写一条审计')
})

await check('「你会什么」在什么都没接时，说的是实话', () => {
  const runtime = open(sandbox())
  runtime.impl.clear()
  const lines = runtime.skillBriefing()
  const text = lines.join('')
  assert.ok(!/会 [1-9]/.test(text), '不能声称会任何一项')
  assert.match(text, /都还用不了/)
})

await check('知识白名单/权限都放开，也不掩盖「没接上」这个事实', () => {
  const runtime = open(sandbox())
  runtime.impl.clear()
  runtime.setConfig('channel.enabled', true)
  runtime.setConfig('net.allowlist', 'a.com')
  runtime.setConfig('memory.enabled', true)
  runtime.setConfig('activity.enabled', true)
  runtime.setConfig('sandbox.mode', 'free')
  const view = runtime.skills()
  assert.equal(view.counts.on, 0, '开关全开也没用，底层还没有实现')
  const row = view.groups.flatMap((g) => g.items).find((item) => item.id === 'net.search')
  assert.match(row.why, /还没接上/)
})

for (const dir of dirs) rmSync(dir, { recursive: true, force: true })

console.log(`\n${failed.length ? '✗' : '✓'} 串联用例：${passed} 项通过`)
if (failed.length) {
  for (const item of failed) console.log(`  ${item.name}: ${item.err?.message ?? item.err}`)
  process.exit(1)
}
