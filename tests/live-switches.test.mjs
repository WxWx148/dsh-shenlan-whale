/**
 * 「开关落到实处 + 自主活动独立计量」验收用例。
 *
 * 两件事以前都只能靠人眼在界面上看：
 *   · 自主活动的 token 挂在思维链上，不写 cot 的那几路永远看不见；
 *   · 界面上的联网白名单 / 每小时次数，代码里根本没有执行闸。
 * 这里把「改了值 → 行为真的变」和「每一笔自主推理都进独立账本」钉成断言。
 * 全部离线：不发网络、不开协议端、不调真实模型。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runtime } from '../app/index.mjs'
import { Usage } from '../facts/index.mjs'
import { createTools } from '../ability/index.mjs'
import { panelView, detailView } from '../view/index.mjs'
import { DEBUG_ITEMS, runDebug } from '../view/index.mjs'
import { runActivityStep } from '../life/index.mjs'
import { activitySpend, activityUsageView, usageOf, ACTIVITY_KINDS } from '../life/index.mjs'
import { configureNet, netStatus, checkNet, lastNetDenied, readWeb, searchWebDetailed } from '../ability/index.mjs'
import { BEHAVIOR_GATES, CRITICAL_SWITCHES, scanUngated } from '../scripts/check-config-consumers.mjs'
import { Turn } from '../turn/index.mjs'
import { Guard } from '../decide/index.mjs'

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
  const dir = mkdtempSync(path.join(tmpdir(), 'sl-live-'))
  const runtime = new Runtime({ dir })
  runtime.usage = new Usage({ config: runtime.config, journal: runtime.audit, file: path.join(dir, 'usage.json') })
  return { dir, runtime }
}

console.log('\n开关落实与自主活动独立计量')

// ── 一、自主活动自己的账本 ────────────────────────────────────────
await check('宿主六种 usage 字段名都认得；只给总数时不编数字', () => {
  assert.deepEqual(usageOf({ usage: { inputTokens: 100, outputTokens: 20 } }), { tracked: true, input: 100, output: 20, total: 120 })
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 7, completion_tokens: 3 } }), { tracked: true, input: 7, output: 3, total: 10 })
  assert.deepEqual(usageOf({ tokenUsage: { input: 5, output: 2 } }), { tracked: true, input: 5, output: 2, total: 7 })
  assert.equal(usageOf({ usage: { totalTokens: 99 } }).tracked, false, '只有总数不能拆成 in/out')
  assert.equal(usageOf({ text: '没有用量字段' }).tracked, false)
})

await check('每次自主推理都落独立账本：按天、按动作分类、写盘', () => {
  const { dir, runtime } = fresh()
  activitySpend(runtime, { text: '想查什么', usage: { input: 120, output: 30 } }, { kind: 'think' })
  activitySpend(runtime, { text: '查完想想', usage: { inputTokens: 80, outputTokens: 12 } }, { kind: 'reflect' })
  activitySpend(runtime, { text: '主动说一句', usage: { input: 40, output: 8 } }, { kind: 'proactive' })
  const view = activityUsageView(runtime)
  assert.equal(view.calls, 3)
  assert.equal(view.tokens, 120 + 30 + 80 + 12 + 40 + 8)
  assert.equal(view.byKind.find((one) => one.id === 'think').calls, 1)
  assert.equal(view.byKind.find((one) => one.id === 'interject').calls, 0)
  assert.equal(existsSync(path.join(dir, 'activity-usage.json')), true, '独立账本没落盘')
  const disk = JSON.parse(readFileSync(path.join(dir, 'activity-usage.json'), 'utf8'))
  assert.equal(Object.keys(disk.days).length, 1)
})

await check('宿主没给用量：记「一次调用·没拿到数字」并写审计，不是空白也不是 0 token', () => {
  const { runtime } = fresh()
  activitySpend(runtime, { text: '模型给了话，没给用量' }, { kind: 'proactive' })
  const view = activityUsageView(runtime)
  assert.equal(view.calls, 1)
  assert.equal(view.tokens, 0)
  assert.equal(view.untracked, 1)
  const audit = runtime.audit.read({ limit: 50 }).rows || []
  assert.ok(audit.some((row) => row.kind === 'activity_usage_missing'), '没留下可查的痕迹')
  assert.match(view.line, /没拿到 token 数/)
})

await check('独立账本与全局账本 auto 档对得上（不是双花，是同一笔的两个口径）', () => {
  const { runtime } = fresh()
  activitySpend(runtime, { usage: { input: 200, output: 50 }, model: 'deepseek' }, { kind: 'think' })
  const mine = activityUsageView(runtime)
  const global = runtime.usage.sourcesView()
  const auto = global.items.find((one) => one.id === 'auto')
  assert.equal(auto.tokens, mine.tokens, '总账本里「自主活动」这一档要和独立账本一致')
  assert.equal(auto.calls, mine.calls)
})

await check('runActivityStep 真链路：想查什么、查完反思两次都记，活动日志每条自带消耗', async () => {
  const { runtime } = fresh()
  let turn = 0
  const runner = async () => {
    turn += 1
    return { text: turn === 1 ? '裁员补偿 N+1 怎么算' : '跟之前聊的对得上 [[next: 30m]]', usage: { input: 100, output: 20 } }
  }
  const step = await runActivityStep({
    runtime, runner, config: runtime.config,
    search: async () => [{ title: '补偿细则', snippet: '按 N+1 计算', url: 'https://example.com/a' }],
    read: async () => ({ ok: false }),
  })
  assert.equal(step.ok, true)
  const view = activityUsageView(runtime)
  assert.equal(view.calls, 2, '两次推理都要进账')
  assert.equal(view.byKind.find((one) => one.id === 'think').calls, 1)
  assert.equal(view.byKind.find((one) => one.id === 'reflect').calls, 1)
  const rows = runtime.activities.read({ limit: 20 }).rows || []
  assert.ok(rows.length >= 2, '活动日志该有搜索与反思两条')
  assert.ok(rows.every((row) => row.tokens && row.tokens.input === 100), '每条正文都要带自己的 token')
  assert.equal(rows.every((row) => row.source === 'auto'), true)
})

await check('没想出搜索词那次推理也记账（以前提前 return 直接漏掉）', async () => {
  const { runtime } = fresh()
  const step = await runActivityStep({
    runtime, runner: async () => ({ text: '', usage: { input: 60, output: 0 } }), config: runtime.config,
    search: async () => [], read: async () => ({ ok: false }),
  })
  assert.equal(step.ok, false)
  assert.equal(activityUsageView(runtime).tokens, 60)
})

await check('主动开口 / 群里插话 / 写说说都有独立档位，不靠思维链也能看到', () => {
  assert.deepEqual(
    ['proactive', 'interject', 'qzone'].map((id) => ACTIVITY_KINDS[id]),
    ['主动开口', '群里插话', '写说说'],
  )
  const { runtime } = fresh()
  activitySpend(runtime, { usage: { input: 10, output: 2 } }, { kind: 'interject' })
  const view = activityUsageView(runtime)
  assert.equal(view.byKind.find((one) => one.id === 'interject').tokens, 12)
})

// ── 二、界面：自我活动里就能看到，不依赖思维链 ─────────────────────
await check('自主活动详情页：顶部独立汇总，每条正文旁有消耗标签', () => {
  const { runtime } = fresh()
  runtime.logActivity({ kind: 'search', text: '查了点东西', source: 'auto', tokens: { input: 100, output: 20, tracked: true } })
  activitySpend(runtime, { usage: { input: 100, output: 20 } }, { kind: 'think' })
  const detail = detailView({ runtime, at: Date.now(), id: 'process.activity' })
  assert.equal(detail.kind, 'rows')
  const summary = detail.rows[0]
  assert.match(summary.title, /今天的自主活动/)
  assert.match(summary.desc, /token/)
  assert.match(summary.aside, /token/)
  const body = detail.rows.find((one) => one.id !== 'activity-usage')
  assert.match(body.aside, /in · .* out/)
})

await check('没拿到数字的活动条目标「没拿到 token 数」，不写成 0 消耗', () => {
  const { runtime } = fresh()
  runtime.logActivity({ kind: 'proactive', text: '说了一句', source: 'auto', tokens: { input: 0, output: 0, tracked: false } })
  const detail = detailView({ runtime, at: Date.now(), id: 'process.activity' })
  const body = detail.rows.find((one) => one.id !== 'activity-usage')
  assert.equal(body.aside, '没拿到 token 数')
})

await check('概览卡上的自主活动数字来自独立账本，不是从思维链里数的', () => {
  const { runtime } = fresh()
  activitySpend(runtime, { usage: { input: 300, output: 40 } }, { kind: 'proactive' })
  const page = panelView({ runtime })
  const card = page.regions.process.modules.find((one) => one.detail === 'process.activity')
  assert.match(card.badge, /340 token/, `实际 badge：${card.badge}`)
})

await check('调试台：自主活动用量、联网开关试一次都有入口且跑得出结果', async () => {
  const { runtime } = fresh()
  assert.ok(DEBUG_ITEMS.some((one) => one.id === 'activity'))
  assert.ok(DEBUG_ITEMS.some((one) => one.id === 'net'))
  activitySpend(runtime, { usage: { input: 50, output: 5 } }, { kind: 'think' })
  configureNet({ net: { allowlist: [], quotaPerHour: 60 } })
  const a = await runDebug('activity', { runtime })
  const n = await runDebug('net', { runtime })
  assert.equal(a.ok, true)
  assert.ok(a.rows.some((one) => /55 token/.test(one.value)))
  assert.equal(n.ok, true)
  assert.ok(n.rows.some((one) => /不许|白名单/.test(one.value)))
  const c = await runDebug('config', { runtime })
  assert.ok(c.rows.some((one) => /执行中/.test(one.label)), '设置页要显示执行处的真实值，不只显示保存的值')
})

// ── 三、界面开关真的接到行为 ─────────────────────────────────────
await check('联网白名单留空＝全部不许，且拒绝原因看得懂', () => {
  configureNet({ net: { allowlist: [], quotaPerHour: 500 } })
  const hit = checkNet('https://cn.bing.com/search?q=x')
  assert.equal(hit.ok, false)
  assert.equal(hit.code, 'net_denied')
  assert.match(hit.error, /白名单/)
})

await check('加一个域名就只放行它和它的子域，别家照样拦', () => {
  configureNet({ net: { allowlist: ['cn.bing.com'], quotaPerHour: 500 } })
  assert.equal(checkNet('https://cn.bing.com/search?q=x').ok, true)
  assert.equal(checkNet('https://search.cn.bing.com/x').ok, true, '子域要跟着放行')
  assert.equal(checkNet('https://www.baidu.com/s?wd=x').ok, false)
  assert.equal(netStatus().allowlist.length, 1)
})

await check('每小时次数改小立即生效：到上限就拦，原因里带上次数', () => {
  configureNet({ net: { allowlist: ['cn.bing.com'], quotaPerHour: 2 } })
  const used = netStatus().used
  const quota = netStatus().quotaPerHour
  assert.equal(quota, 2)
  if (used <= quota) {
    for (let i = used; i < quota; i += 1) assert.equal(checkNet('https://cn.bing.com/x').ok, true)
  }
  const blocked = checkNet('https://cn.bing.com/y')
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /上限|次数/)
})

await check('次数设成 0 = 不许联网', () => {
  configureNet({ net: { allowlist: ['cn.bing.com'], quotaPerHour: 0 } })
  const hit = checkNet('https://cn.bing.com/x')
  assert.equal(hit.ok, false)
  assert.match(hit.error, /0|不许/)
})

await check('readWeb / searchWebDetailed 都过同一道闸，被拦时不发请求', async () => {
  configureNet({ net: { allowlist: [], quotaPerHour: 500 } })
  const page = await readWeb('https://example.com/never-fetched')
  assert.equal(page.ok, false)
  assert.equal(page.code, 'net_denied')
  const rows = await searchWebDetailed('随便搜点什么')
  assert.deepEqual(rows, [])
  assert.match(lastNetDenied(), /白名单/)
  // 只过闸、不真的发请求：放行与否由 checkNet 验证，保持用例离线
  configureNet({ net: { allowlist: ['cn.bing.com'], quotaPerHour: 500 } })
  assert.equal(checkNet('https://cn.bing.com/search?q=probe').ok, true, '放行后闸不再拦')
  assert.equal(checkNet('https://www.baidu.com/s?wd=x').ok, false, '没放行的域名依旧拦')
})

await check('工具把「被拦」说清，不再伪装成「没搜到」', async () => {
  configureNet({ net: { allowlist: [], quotaPerHour: 500 } })
  const { dir, runtime } = fresh()
  const tools = createTools({ runtime, channel: null, usage: runtime.usage, dir })
  const search = await tools.call('web_search', { query: '今天天气' })
  assert.equal(search.ok, false)
  assert.match(String(search.error), /白名单|不许联网/)
  assert.equal(search.code, 'net_denied')
  const fetch = await tools.call('web_fetch', { url: 'https://example.com/a' })
  assert.equal(fetch.ok, false)
  assert.match(String(fetch.error), /白名单/)
})

await check('配置变更后执行处的策略立刻变（不是只改了界面上的值）', () => {
  configureNet({ net: { allowlist: [], quotaPerHour: 60 } })
  assert.equal(checkNet('https://cn.bing.com/x').ok, false)
  configureNet({ net: { allowlist: ['cn.bing.com'], quotaPerHour: 60 } })
  assert.equal(checkNet('https://cn.bing.com/x').ok, true)
  configureNet({ net: { allowlist: [], quotaPerHour: 60 } })
  assert.equal(checkNet('https://cn.bing.com/x').ok, false)
})

await check('行为闸名册：关键开关全部登记执行处，审计脚本不再报「89/89 全绿」式的假绿', () => {
  assert.deepEqual(scanUngated(), [], '有关键开关没登记行为闸')
  assert.ok(CRITICAL_SWITCHES.includes('net.allowlist'))
  assert.ok(CRITICAL_SWITCHES.includes('net.quotaPerHour'))
  assert.match(BEHAVIOR_GATES['net.allowlist'], /checkNet/)
  assert.match(BEHAVIOR_GATES['net.quotaPerHour'], /takeSlot/)
  assert.ok(Object.keys(BEHAVIOR_GATES).length >= 30, '行为闸名册不该只剩几项')
})

await check('自主改人设：self.enabled 关掉就真的改不了，开了就能改', async () => {
  // 「自主维护自己人设」是这一轮新加的能力。它必须能被闸住 ——
  // 否则「关掉自主」这个开关对它就是空转的，跟面板上写的承诺不符。
  const dir = mkdtempSync(path.join(tmpdir(), 'persona-gate-'))
  const runtime = new Runtime({ dir, config: { identity: { ownerId: 'owner1' } } })
  const tools = createTools({ runtime: runtime, config: runtime.config, dir: runtime.dir })

  // 开着：改得动
  const before = runtime.personaText()
  assert.ok(before.length > 0, '出厂人设要先落盘')
  const ok = await tools.call('revise_persona', { section: '二、怎么说话', text: '一条一个念头，不超过二十字。' })
  assert.equal(ok.ok, true, '开着时应该改得动')
  assert.match(runtime.personaText(), /不超过二十字/)

  // 关掉：改不动，而且要说清为什么
  runtime.config.self.enabled = false
  const denied = await tools.call('revise_persona', { section: '二、怎么说话', text: '这一条不该写得进去。' })
  assert.equal(denied.ok, false, '关掉后必须拒绝')
  assert.match(denied.error, /关着/)
  assert.doesNotMatch(runtime.personaText(), /这一条不该写得进去/, '拒绝了就必须真没写进去')

  // 读自己的设定不受这个闸限制 —— 读不需要授权，改才需要
  const read = await tools.call('read_persona', {})
  assert.equal(read.ok, true, '关掉自主改人设后仍然要能读')
  rmSync(dir, { recursive: true, force: true })
})

await check('日预算：超了就真的停下，并且说清为什么', async () => {
  // 面板上写着「超过就会停下并提醒」，而代码里 overBudget 只被算、没人读 ——
  // 一个明明白白承诺了却不生效的开关。现在 turn.mjs 有 #budgetGate 真的拦。
  const NOON = new Date(2026, 10, 7, 12, 0, 0).getTime()
  const dir = mkdtempSync(path.join(tmpdir(), 'budget-'))
  const runtime = new Runtime({ dir, now: () => NOON, config: { identity: { ownerId: 'owner1' } } })
  runtime.setConfig('guard.mergeWindowMs', 0, { confirm: false })
  const usage = new Usage({ config: runtime.config, journal: runtime.audit, file: path.join(dir, 'usage.json'), now: () => NOON })
  runtime.usage = usage
  const guard = new Guard({ config: runtime.config, now: () => NOON })
  const tools = createTools({ runtime: runtime, config: runtime.config, dir: runtime.dir })
  const sent = []
  const turn = new Turn({
    runtime, guard, tools, usage, now: () => NOON,
    runner: async () => ({ text: '好' }),
    channel: { say: async (scope, target, text) => { sent.push(text) } },
    sleep: async () => {},
  })

  // 先看没超预算时：正常回复
  usage.record(1000, 200, { at: NOON, source: 'chat' })
  const before = await turn.handle({ source: 'channel', kind: 'message', scope: 'private', from: 'stranger', text: '在吗', messageId: 'b0', at: NOON })
  assert.ok(!before.skipped, '没超预算不该被拦')

  // 花到超过预算
  usage.record(100000, 100000, { at: NOON, source: 'chat' })
  runtime.setConfig('usage.budgetPerDay', 1, { confirm: true })
  assert.equal(usage.overBudget(NOON).over, true, '要真的算出超了')

  const after = await turn.handle({ source: 'channel', kind: 'message', scope: 'private', from: 'stranger', text: '在吗', messageId: 'b1', at: NOON })
  assert.equal(after.skipped, true, '超预算就该停下')
  assert.match(String(after.reason || ''), /预算/, '要说清是预算原因')

  // 主人豁免：主人自己的活不该被预算拦住
  const owner = await turn.handle({ source: 'channel', kind: 'message', scope: 'private', from: 'owner1', text: '在吗', messageId: 'b2', at: NOON })
  assert.ok(!owner.skipped, '主人不该被预算拦住')

  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

await check('外部传进来的配置也会补齐默认值，不是一份残缺的配置', () => {
  // 以前 Runtime 收到 input.config 就原样用，不走 migrate ——
  // 传一份 `{identity:{ownerId}}` 进来，整份配置里就没有 usage，
  // 单价全是 0，预算永远是 0，面板上显示「今天花了 ¥0.00」，看不出任何异常。
  const dir = mkdtempSync(path.join(tmpdir(), 'cfgfill-'))
  const runtime = new Runtime({ dir, config: { identity: { ownerId: 'owner1' } } })
  assert.ok(runtime.config.usage, 'usage 这一段要被补上')
  assert.equal(runtime.config.usage.inputPerM, 2, '单价要有默认值')
  assert.ok(runtime.config.guard, 'guard 这一段也要被补上')
  assert.equal(runtime.config.guard.perMinute, 15)
  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

await check('防复读：同一条消息不回两遍，但主人再问一遍必须能再答', () => {
  // 行为闸：这不是「配了个开关」，是「真的会拦、而且只拦该拦的」。
  const dir = mkdtempSync(path.join(tmpdir(), 'dedupe-'))
  const runtime = new Runtime({ dir })
  const conversation = 'private:owner1'
  const first = '这个功能怎么开我看看啊'

  // 一、同一轮里紧接着说同一句 → 拦（真复读）
  runtime.dedupe.noteText(conversation, first, 'round-1')
  assert.equal(runtime.dedupe.checkText(conversation, first, 'round-1').duplicate, true, '同一轮紧接着说同一句要被拦')

  // 二、跨轮说同一句 → 放行（主人再问一遍，深蓝得再答一遍）
  assert.equal(runtime.dedupe.checkText(conversation, first, 'round-2').duplicate, false, '跨轮不能拦')

  // 三、同一条消息 id → 拦（掉线补回复读）
  runtime.dedupe.noteMessage(conversation, 'msg-1')
  assert.equal(runtime.dedupe.checkMessage(conversation, 'msg-1').duplicate, true, '同一条消息不能回两遍')

  // 四、新的消息 id → 放行
  assert.equal(runtime.dedupe.checkMessage(conversation, 'msg-2').duplicate, false, '新消息必须能回')

  runtime.close()
  rmSync(dir, { recursive: true, force: true })
})

if (failed.length) {
  console.log(`\n✗ 开关落实与自主活动独立计量：${failed.length} 项失败`)
  for (const { name, err } of failed) console.log(`  · ${name}: ${err?.message ?? err}`)
  process.exit(1)
}
console.log(`\n✓ 开关落实与自主活动独立计量：${passed} 项通过`)
