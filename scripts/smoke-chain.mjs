/**
 * scripts/smoke-chain.mjs — 全链路自检：一条消息从进来到落库，中间每一节都得真的接上。
 *
 * 为什么要有它（静态守卫证明不了的那一半）：
 *   check-layers 能证明「import 没断」，audit:config 能证明「每个键有人读」，
 *   用例能证明「每个函数算得对」—— 但都证明不了「装配起来还能跑」。
 *   真出事往往是这一种：每个零件都对，接线顺序错了一处，于是消息进来了、回话没出去，
 *   日志里什么都没有。这类问题只能靠「跑一遍真的链路」抓。
 *
 * 跑法：node scripts/smoke-chain.mjs
 *   · 用临时目录，不碰真实数据；
 *   · 通道与模型是假的（不连 QQ、不花 token），其余全是真模块；
 *   · 每一步都断言「该落盘的东西真的落了盘」，失败退出码 1。
 *
 * 它审的不是「代码对不对」，是**关节通不通**：事件 → 路由 → 闸门 → 提示词 → 生成 →
 * 工具环 → 分条 → 打字台 → 出站 → 记账 → 面板。任何一节断开，这里都会红。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Runtime } from '../app/index.mjs'
import { Guard } from '../decide/index.mjs'
import { Usage } from '../facts/index.mjs'
import { Turn } from '../turn/index.mjs'
import { Sandbox } from '../ability/index.mjs'
import { approvalText } from '../ability/index.mjs'
import { TypingDesk } from '../voice/index.mjs'
import { AttentionDesk } from '../decide/index.mjs'
import { createTools } from '../ability/index.mjs'
import { panelView } from '../view/index.mjs'
import { implementedTools, allToolNames } from '../ability/index.mjs'
import { KIND, SCOPE, SOURCE } from '../facts/index.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = '10001'
const FRIEND = '20002'
const GROUP = '30001'

let passed = 0
const failed = []
const trace = []

function step(title) {
  console.log('')
  console.log('─ ' + title)
}

async function stage(name, fn) {
  const started = Date.now()
  try {
    const detail = await fn()
    passed += 1
    trace.push({ name, ok: true, ms: Date.now() - started, detail: detail || '' })
    console.log(`  ✓ ${name}${detail ? '：' + detail : ''}`)
  } catch (error) {
    failed.push({ name, error })
    trace.push({ name, ok: false, ms: Date.now() - started, detail: String(error?.message || error) })
    console.log(`  ✗ ${name}：${String(error?.message || error)}`)
  }
}

/** 读一份 jsonl，给断言用 */
function lines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((one) => JSON.parse(one))
  } catch {
    return []
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-smoke-'))
const sent = []
const typingShown = []

const channel = {
  async say(scope, target, text) {
    sent.push({ scope, target, text })
    return { message_id: 'm' + sent.length }
  },
  async inputStatus(scope, target) {
    typingShown.push(`${scope}:${target}`)
    return { ok: true }
  },
  async sendImage(scope, target) {
    sent.push({ scope, target, text: '[image]' })
    return { ok: true }
  },
  async getMessage() {
    return { ok: false, error: '冒烟环境没有历史消息' }
  },
}

/** 假模型：第一轮给一句带工具调用的回复，拿到工具结果后给最终回复 */
function makeRunner(log) {
  return async (prompt) => {
    log.push(prompt)
    if (/按顺序执行的结果如下/.test(prompt)) {
      return { text: '算好了，是 2', usage: { input: 120, output: 8 } }
    }
    if (/1\+1|算一下/.test(prompt)) {
      return { text: '[tool:calc] {"expr":"1+1"}', usage: { input: 100, output: 12 } }
    }
    return { text: '嗯，知道了', usage: { input: 90, output: 6 } }
  }
}

const prompts = []
let runtime = null
let turn = null
let tools = null
let typing
let guard = null
let usage = null
let attention = null

const raw = (over = {}) => ({
  source: SOURCE.CHANNEL,
  kind: KIND.MESSAGE,
  scope: SCOPE.PRIVATE,
  from: FRIEND,
  text: '在吗',
  at: Date.now(),
  ...over,
})

step(`装配（数据目录 ${dir}）`)

await stage('运行时 + 各层装配起来，没有一环抛错', () => {
  runtime = new Runtime({ dir })
  runtime.setConfig('identity.ownerId', OWNER, { confirm: true })
  // 关掉夜间静音：这份自检要验的是链路，不是「现在几点」。
  // 带着默认的 23:00-07:00 跑，凌晨三点执行会有一半用例红在「现在是夜间静音时段」——
  // 那是脚本依赖了墙上时钟，不是代码坏了。
  runtime.setConfig('guard.nightWindow', '', { confirm: true })
  // 连发合并窗口也关掉：这份自检验的是「收到就处理」，
  // 开着 1.5 秒窗口时群聊那几条会被缓冲接住，断言立刻检查 sent 必然是空的。
  runtime.setConfig('guard.mergeWindowMs', 0, { confirm: true })
  guard = new Guard({ config: runtime.config })
  usage = new Usage({ config: runtime.config, journal: runtime.audit, file: path.join(dir, 'usage.json') })
  runtime.usage = usage
  const sandbox = new Sandbox({ runtime, dir })
  runtime.sandbox = sandbox
  tools = createTools({ runtime, channel, usage, dir })
  attention = new AttentionDesk({ config: runtime.config })
  typing = new TypingDesk({ channel, log: () => {}, sleep: async () => {} })
  turn = new Turn({
    runtime,
    guard,
    usage,
    channel,
    tools,
    runner: makeRunner(prompts),
    typing,
    attention,
    sleep: async () => {},
    log: () => {},
  })
  assert.ok(turn.ready, '生成器没接上')
  return `工具 ${implementedTools().length} 项 / 出厂清单 ${allToolNames().length} 项`
})

await stage('能力清单没有缺口（除了要生成器的那四项）', () => {
  const impl = new Set(implementedTools())
  // reply / split / tone 由 index.js 在有生成器时补登；proactive 由入口登记。
  const gap = allToolNames().filter((name) => !impl.has(name) && !['reply', 'split', 'tone', 'proactive'].includes(name))
  assert.deepEqual(gap, [], '有工具声明了却没实现：' + gap.join(','))
  return '缺 0 项'
})

step('私聊：一条消息进来，一句话出去')

await stage('私聊消息被回话，事件与行为都落盘', async () => {
  const before = sent.length
  const result = await turn.handle(raw())
  assert.equal(result.ok, true, '没回话：' + JSON.stringify(result))
  assert.ok(sent.length > before, '通道没收到任何消息')
  const events = lines(path.join(dir, 'events.jsonl'))
  assert.ok(events.some((row) => row.conversation === `private:${FRIEND}`), '事件没落盘')
  const behaviors = lines(path.join(dir, 'behaviors.jsonl'))
  assert.ok(behaviors.some((row) => row.behavior === 'reply'), '行为记录没落盘')
  return `发出 ${sent.length - before} 条`
})

await stage('回复走的是打字台：亮过「正在输入」', () => {
  assert.ok(typingShown.length > 0, '没有亮过正在输入')
  return `${typingShown.length} 次`
})

await stage('用量记到了账本上', async () => {
  usage.record(100, 20, { at: Date.now(), model: 'smoke' })
  const file = path.join(dir, 'usage.json')
  assert.ok(existsSync(file), 'usage.json 没生成')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const days = saved?.days || {}
  const today = Object.values(days).reduce((sum, day) => sum + (Number(day?.calls) || 0), 0)
  assert.ok(today >= 1, '账本里没有调用次数：' + JSON.stringify(saved).slice(0, 120))
  return `今天 ${today} 次调用已入账`
})

step('工具环：模型要工具 → 真的执行 → 结果回灌 → 再出话')

await stage('calc 被真执行，结果回到第二轮提示词里', async () => {
  prompts.length = 0
  const result = await turn.handle(raw({ text: '帮我算一下 1+1' }))
  assert.equal(result.ok, true, '没回话：' + JSON.stringify(result))
  assert.ok(prompts.length >= 2, '只问了一次模型，工具结果没有回灌')
  assert.match(prompts[1], /按顺序执行的结果如下/)
  assert.match(prompts[1], /calc/)
  const behaviors = lines(path.join(dir, 'behaviors.jsonl'))
  assert.ok(behaviors.some((row) => row.trigger === 'tool'), '工具调用没有记账')
  return `问了 ${prompts.length} 次模型`
})

step('群聊：没点名不接，点名才接')

await stage('群里没 @ 也不在窗口里 → 按设计不接', async () => {
  const before = sent.length
  const result = await turn.handle(raw({ scope: SCOPE.GROUP, from: '40004', text: '今天好热', payload: { groupId: GROUP } }))
  assert.equal(result.skipped, true, '不该接却接了')
  assert.equal(sent.length, before, '居然发了消息')
  return result.reason
})

await stage('群里被 @ → 回话', async () => {
  const before = sent.length
  const result = await turn.handle(raw({ scope: SCOPE.GROUP, from: '40004', text: '在吗', atMe: true, payload: { groupId: GROUP } }))
  assert.equal(result.ok, true, '没回话：' + JSON.stringify(result))
  assert.ok(sent.length > before, '通道没收到消息')
  return '回了'
})

await stage('同一个人接着说（窗口内）→ 不用 @ 也接', async () => {
  const before = sent.length
  const result = await turn.handle(raw({ scope: SCOPE.GROUP, from: '40004', text: '那后来呢', payload: { groupId: GROUP } }))
  assert.equal(result.ok, true, '窗口里的话没接：' + JSON.stringify(result))
  assert.ok(sent.length > before)
  return '接了'
})

step('通知与请求：进事件流，但不回话')

await stage('入群申请进得来、落得下，且不会自己冒一句', async () => {
  const before = sent.length
  const result = await turn.handle(
    raw({
      kind: KIND.NOTICE,
      scope: SCOPE.GROUP,
      from: '50005',
      text: '',
      payload: { request: { flag: 'smoke-1', subType: 'group', groupId: GROUP, userId: '50005', comment: '拉你进群' } },
    }),
  )
  assert.equal(result.skipped, true, '通知类事件不该产生行为')
  assert.equal(sent.length, before, '居然回了一句')
  const events = lines(path.join(dir, 'events.jsonl'))
  assert.ok(events.some((row) => row.type === 'notice'), '通知没进事件流')
  return '记录在案，不打扰'
})

step('闸门：配置改一下，真的立刻生效')
await stage('把每分钟上限改成 1，第二条就被拦下', async () => {
  const result = runtime.setConfig('guard.perMinute', 1, { confirm: true })
  assert.equal(result.ok, true, '改配置失败：' + JSON.stringify(result))
  guard.configure(runtime.config)
  await turn.handle(raw({ text: '第一条' }))
  const blocked = await turn.handle(raw({ text: '第二条' }))
  assert.equal(blocked.skipped, true, '该被限流却没拦')
  assert.match(String(blocked.reason || ''), /上限|分钟/, '拦截原因不对：' + blocked.reason)
  const saved = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'))
  assert.equal(saved.guard.perMinute, 1, '配置没写回磁盘')
  return blocked.reason
})

step('沙箱「先问我」：挂起 → 有人点 → 才跑')

await stage('ask 档：确认台上挂起，同意之后才真跑', async () => {
  const sandbox = runtime.sandbox
  assert.ok(sandbox && sandbox.approvals, '执行器没接上确认台')
  const before = String(runtime.config.sandbox?.mode || 'free')
  assert.equal(runtime.setConfig('sandbox.mode', 'ask', { confirm: true }).ok, true)

  // 顺便验一遍渠道那条消息：没有「项目 / 目的」两行，收到的人只能盲签
  const asks = []
  sandbox.approvals.notify = (record) => asks.push(record)

  const running = sandbox.run({ code: 'console.log("确认之后才跑")', plan: ['冒烟'] })
  let item = null
  for (let i = 0; i < 100 && !item; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    item = sandbox.approvals.list()[0] || null
  }
  assert.ok(item, '请求没挂到确认台上，弹窗永远不会出现')
  assert.equal(asks.length, 1, '渠道没收到确认请求')
  const text = approvalText(asks[0])
  assert.match(text, /项目：/, '渠道消息里没写项目名')
  assert.match(text, /目的：/, '渠道消息里没写目的')
  // 用「同意」这两个字走一遍主人在 QQ 里回话的那条路，而不是直接调 decide
  assert.equal(sandbox.approvals.takeReply('同意').handled, true)
  const result = await running
  assert.equal(result.ok, true, result.error)

  const journal = lines(path.join(dir, 'sandbox', 'approvals.jsonl'))
  assert.deepEqual(journal.map((row) => row.decision), ['asked', 'allow'], '确认留档不对：' + JSON.stringify(journal))
  runtime.setConfig('sandbox.mode', before, { confirm: true })
  return '问了 1 次、同意 1 次、跑成了'
})

step('记忆：记下来的人和事，重启之后还在')

await stage('记一个人 + 一条事实，换一个 Runtime 读回来', () => {
  runtime.memory.rememberPerson(FRIEND, { name: '老王' })
  runtime.memory.rememberFact('老王家住杭州', { source: 'smoke' })
  const again = new Runtime({ dir })
  const dossier = again.memory.people?.() || again.memory.dossier?.(FRIEND) || null
  const text = JSON.stringify(dossier || again.memory.digest({ forUser: FRIEND }) || '')
  assert.match(text, /老王|杭州/, '重启后读不到：' + text.slice(0, 120))
  return '人物与事实都在'
})

step('面板：一页读完，分区齐、没有报错')

await stage('panelView 分区齐全（含节奏与注意力），notices 为空', () => {
  // 登录那一块读的是 NapCatLogin 的快照缓存（index.js 里挂在 runtime.napcat 上）。
  // 冒烟环境没有真登录，这里挂一份假快照 —— 挂上之后「登录」分区就该出现，
  // 这正是「关节」的证据：少这一颗钉子，面板上就永远少一块。
  runtime.napcat = {
    snapshot: () => ({ state: 'offline', label: '没连上', mode: 'ticket', autoQr: true, steps: [] }),
    startPolling: () => {},
  }
  const view = panelView({ runtime, chat: null, usage, guard, channel, typing, attention })
  assert.equal(view.ok, true)
  // 分区就是侧边栏那七块：概览 / 技能 / 学习 / 花费 / 通道 / 登录 / 设置。
  // 对话、记忆、过程是「详情页」不是分区 —— 它们的列表在详情里翻页，不在首页平铺。
  for (const key of ['overview', 'skills', 'evolve', 'usage', 'channel', 'login', 'settings']) {
    assert.ok(view.sections?.[key], '缺分区：' + key)
  }
  assert.deepEqual(view.notices, [], '面板里有分区报错：' + JSON.stringify(view.notices))
  return `分区 ${Object.keys(view.sections).length} 个，导航 ${view.nav?.length || 0} 项`
})

await stage('详情页：会话与设置能打开，未知 id 优雅降级', async () => {
  const { detailView } = await import('../view/index.mjs')
  const session = detailView({ runtime, chat: null, usage, guard, channel, id: `qq:private:${FRIEND}` })
  assert.equal(session.ok, true, '会话详情打不开')
  const setting = detailView({ runtime, chat: null, usage, guard, channel, id: 'settings.guard.perMinute' })
  assert.equal(setting.ok, true, '设置详情打不开')
  // 未知 id 不许抛：前端拿着旧链接点进来是常事，报错页面比空白页更糟
  const unknown = detailView({ runtime, chat: null, usage, guard, channel, id: 'settings.__nope' })
  assert.ok(unknown && typeof unknown === 'object', '未知 id 直接抛了')
  assert.ok('empty' in unknown || 'rows' in unknown, '未知 id 没给出可渲染的形状')
  // 新模块必须在面板上有一条真能点开的路：装了却没人看得见，等于没装
  const rhythm = detailView({ runtime, chat: null, usage, guard, channel, typing, attention, id: 'overview.rhythm' })
  assert.equal(rhythm.kind, 'cards', '节奏页打不开')
  assert.ok(rhythm.cards.some((one) => one.label === '已发出'), '节奏页没有打字台读数')
  const windows = detailView({ runtime, chat: null, usage, guard, channel, typing, attention, id: 'overview.attention' })
  assert.equal(windows.kind, 'rows', '注意力页打不开')
  return '两个真页 + 一个空页 + 两个新模块页'
})

step('落盘：事件、行为、审计三本账都在长')

await stage('三本账都有内容，且行数对得上', () => {
  const events = lines(path.join(dir, 'events.jsonl'))
  const behaviors = lines(path.join(dir, 'behaviors.jsonl'))
  const audit = lines(path.join(dir, 'audit.jsonl'))
  assert.ok(events.length >= 5, '事件太少：' + events.length)
  assert.ok(behaviors.length >= 5, '行为太少：' + behaviors.length)
  assert.ok(audit.length >= 3, '审计太少：' + audit.length)
  // 每条行为都得挂在一条事件上，否则事后回溯不了「这是回哪句」
  const ids = new Set(events.map((row) => row.id))
  const orphans = behaviors.filter((row) => row.eventId && !ids.has(row.eventId))
  assert.equal(orphans.length, 0, '有行为挂在不存在的事件上：' + orphans.length)
  return `事件 ${events.length} / 行为 ${behaviors.length} / 审计 ${audit.length}`
})

step('代码结构：没有断链、没有越层')

await stage('出站只有一个口：定时器不许直连通道', () => {
  // 这条规则只能静态看：index.js 的定时器不在冒烟链路里（它们要宿主 ctx 才起得来）。
  // 允许的两处是 outbound 自己，以及面板的「代发」（用户点了发送，等的是立刻发出去）。
  const src = readFileSync(path.join(ROOT, 'index.js'), 'utf8')
  const hits = src
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.includes('channel.say(') && !line.trim().startsWith('*'))
  assert.equal(hits.length, 2, '直连通道的地方应该是 2 处（outbound、面板代发），现在是 ' + hits.length + ' 处：' + hits.map((one) => one.index).join(','))
  return '2 处（其余全走 outbound）'
})

await stage('check-layers 与文案守卫一起跑一遍', async () => {
  const { execFileSync } = await import('node:child_process')
  for (const script of ['scripts/check-layers.mjs', 'scripts/check-copy.mjs', 'scripts/check-identity.mjs']) {
    execFileSync(process.execPath, [path.join(ROOT, script)], { cwd: ROOT, stdio: 'pipe' })
  }
  return '三个守卫全过'
})

console.log('')
console.log('─ 链路轨迹')
for (const one of trace) {
  console.log(`  ${one.ok ? '✓' : '✗'} ${one.name}（${one.ms}ms）${one.detail ? ' — ' + one.detail : ''}`)
}

rmSync(dir, { recursive: true, force: true })

console.log('')
if (failed.length) {
  console.log(`✗ 全链路自检：${failed.length} 处断开（通过 ${passed} 项）`)
  for (const one of failed) console.log(`  - ${one.name}：${one.error?.stack || one.error}`)
  process.exit(1)
}
console.log(`✓ 全链路自检：${passed} 项全通（私聊 / 群聊 / 窗口 / 工具环 / 限流 / 记忆 / 面板 / 三本账）`)
