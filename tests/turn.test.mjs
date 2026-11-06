/**
 * 回合用例 —— 一条消息进来，一句话出去。
 *
 * 这份测的是「接起来对不对」，不是「每个函数对不对」：
 * 分条、限流、记账、落盘、出站，五件事必须在同一次调用里都发生。
 * 生成器是假的（不联网、不调模型），所以这条链可以在没有宿主的环境里完整验证。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runtime } from '../lib/runtime.mjs'
import { Guard } from '../lib/guard.mjs'
import { Usage } from '../lib/usage.mjs'
import { Turn, buildPrompt, splitReply } from '../lib/turn.mjs'
import { AttentionDesk } from '../lib/attention.mjs'
import { TypingDesk } from '../lib/typing.mjs'
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

const BASE = new Date(2026, 9, 29, 14, 0, 0).getTime()
const OWNER = '10001'
const dirs = []

function open() {
  const dir = mkdtempSync(path.join(tmpdir(), 'turn-'))
  dirs.push(dir)
  const runtime = new Runtime({ dir, now: () => BASE })
  runtime.setConfig('identity.ownerId', OWNER, { confirm: true })
  const guard = new Guard({ config: runtime.config, now: () => BASE })
  const usage = new Usage({ config: runtime.config, journal: runtime.audit, now: () => BASE })
  const sent = []
  const channel = {
    say: async (scope, target, text) => {
      sent.push({ scope, target, text })
      return { message_id: sent.length }
    },
  }
  return { runtime, guard, usage, channel, sent, dir }
}

/** 造一个回合。runner 默认说一句「嗯，知道了」 */
function makeTurn(ctx, over = {}) {
  const turn = new Turn({
    runtime: ctx.runtime,
    guard: ctx.guard,
    usage: ctx.usage,
    channel: ctx.channel,
    runner: async () => ({ text: '嗯，知道了', usage: { input: 1000, output: 200 } }),
    sleep: async () => {},
    now: () => BASE,
    ...over,
  })
  return turn
}

const raw = (over = {}) => ({
  source: SOURCE.CHANNEL,
  kind: KIND.MESSAGE,
  scope: SCOPE.PRIVATE,
  from: '20002',
  text: '在吗',
  at: BASE,
  ...over,
})

// ── 分条 ─────────────────────────────────────────────────────
await check('短句合并：一句话就是一条', () => {
  assert.deepEqual(splitReply('在的', { maxParts: 3, partChars: 20 }), ['在的'])
})

await check('分条不保留句号（说话不加句号）', () => {
  assert.deepEqual(splitReply('好的。', { maxParts: 3, partChars: 20 }), ['好的'])
})

await check('长内容按句末断开，不切在句子中间', () => {
  const parts = splitReply('今天有点忙。晚点再说。你先忙。', { maxParts: 3, partChars: 8 })
  assert.ok(parts.length >= 2)
  for (const part of parts) assert.ok(!part.includes('。'), '每条都不该带句号')
})

await check('超过上限就合并到最后一条，绝不多发', () => {
  const parts = splitReply('一。二。三。四。五。六。', { maxParts: 2, partChars: 2 })
  assert.equal(parts.length, 2)
})

await check('空内容返回空数组（空消息不该发出去）', () => {
  assert.deepEqual(splitReply('   ', { maxParts: 3, partChars: 20 }), [])
  assert.deepEqual(splitReply(null, { maxParts: 3, partChars: 20 }), [])
})

await check('maxParts=1 时整段只发一条', () => {
  assert.equal(splitReply('一。二。三。', { maxParts: 1, partChars: 5 }).length, 1)
})

// ── 上下文 ───────────────────────────────────────────────────
await check('给模型的上下文里带上了说话风格和对方原话', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '在吗', senderName: '老王' }, from: '20002' },
    persona: { name: '深蓝' },
    styleGuide: '一句一句说',
    recent: [{ from: 'self', text: '刚在' }],
  })
  assert.match(prompt, /一句一句说/)
  assert.match(prompt, /老王说：在吗/)
  assert.match(prompt, /深蓝：刚在/)
})

// ── 端到端 ───────────────────────────────────────────────────
await check('私聊进来 → 回一句 → 通道真的收到了', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.equal(ctx.sent.length, 1)
  assert.equal(ctx.sent[0].scope, SCOPE.PRIVATE)
  assert.equal(ctx.sent[0].target, '20002')
  assert.equal(ctx.sent[0].text, '嗯，知道了')
})

await check('群里没被 @：不回（这是设计，不是失灵）', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  const result = await turn.handle(raw({ scope: SCOPE.GROUP, text: '今天好热', payload: { groupId: '555' } }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.skipped, true)
  assert.equal(ctx.sent.length, 0)
})

await check('群里 @ 了：回，且发到群里不是私聊', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  await turn.handle(raw({ scope: SCOPE.GROUP, text: '在吗', atMe: true, payload: { groupId: '555' } }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(ctx.sent.length, 1)
  assert.equal(ctx.sent[0].scope, SCOPE.GROUP)
  assert.equal(ctx.sent[0].target, '555')
})

await check('夜间：不回，但事件照样落盘（事实不因为不回就丢掉）', async () => {
  const ctx = open()
  const night = new Date(2026, 9, 29, 23, 30, 0).getTime()
  const turn = makeTurn(ctx, { now: () => night })
  const result = await turn.handle(raw({ at: night }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.skipped, true)
  assert.equal(ctx.sent.length, 0)
  assert.ok(ctx.runtime.events.count() >= 1, '事件要留下')
})

await check('主人被限流时不沉默：说一句为什么没回，且同一个会话一小时只说一次', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  for (let i = 0; i < 15; i += 1) ctx.guard.note(BASE + i)
  const first = await turn.handle(raw({ from: OWNER, messageId: 'm-h1' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(first.skipped, true, '这一条确实被闸门拦了')
  assert.equal(ctx.sent.length, 1, '沉默是最难排查的故障：要告诉他/她为什么不回')
  assert.match(ctx.sent[0].text, /停|密|闸门|拦/)

  ctx.sent.length = 0
  const second = await turn.handle(raw({ from: OWNER, messageId: 'm-h2' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(second.skipped, true)
  assert.equal(ctx.sent.length, 0, '解释只能一次，否则它自己变成新的刷屏源')
})

await check('别人被限流：安静就好（对不相干的人解释反而是打扰）', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  for (let i = 0; i < 15; i += 1) ctx.guard.note(BASE + i)
  await turn.handle(raw({ messageId: 'm-o1' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(ctx.sent.length, 0)
})

await check('主人不会撞到「每小时总量」：这是上次「突然不理人」的根因', async () => {
  const ctx = open()
  ctx.runtime.setConfig('guard.replyQuotaPerHour', 2, { confirm: false })
  ctx.runtime.setConfig('guard.perMinute', 60, { confirm: false })
  ctx.guard.configure(ctx.runtime.config)
  const turn = makeTurn(ctx)
  for (let i = 0; i < 2; i += 1) ctx.guard.note(BASE + i * 20_000)
  const result = await turn.handle(raw({ from: OWNER, messageId: 'm-q1' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.skipped, undefined, '主人这条不被总量拦')
  assert.ok(ctx.sent.length >= 1, '主人问话必须有回')
})

await check('模型出错：回一句人话，不静默（静默会让人以为被无视）', async () => {
  const ctx = open()
  const turn = makeTurn(ctx, { runner: async () => { throw new Error('接口 401') } })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, false)
  assert.equal(ctx.sent.length, 1)
  assert.match(ctx.sent[0].text, /没做成|没成功|没通|登录|权限|额度|超时|网络|卡住|出错|失败/)
})

await check('模型返回空：不发空白消息', async () => {
  const ctx = open()
  const turn = makeTurn(ctx, { runner: async () => ({ text: '   ', usage: null }) })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, false)
  assert.equal(ctx.sent.length, 0)
})

await check('长回复会分多条发，条数与 splitReply 一致', async () => {
  const ctx = open()
  const long = '今天事情有点多。先是开会。然后改方案。最后还得回一堆消息。'
  const turn = makeTurn(ctx, { runner: async () => ({ text: long, usage: { input: 10, output: 10 } }) })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(ctx.sent.length >= 2)
  assert.equal(result.lines, ctx.sent.length)
})

await check('每回一次都记账：用量与次数都对得上', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  const today = ctx.usage.today(BASE)
  assert.equal(today.calls, 1)
  assert.equal(today.input, 1000)
  assert.equal(today.output, 200)
  assert.ok(today.cost > 0)
})

await check('行为结果落盘：behaviors 里能查到这次回复', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  const rows = ctx.runtime.behaviors.read({ limit: 10 }).rows
  assert.ok(rows.some((row) => row.behavior === 'reply' && row.ok !== false))
})

await check('没有生成器时：不硬发，如实说还没接上', async () => {
  const ctx = open()
  const turn = makeTurn(ctx, { runner: null })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, false)
  assert.match(result.error, /生成器/)
  assert.equal(ctx.sent.length, 0)
})

await check('空 @：回看上文接一句，不问「怎么了」', async () => {
  const ctx = open()
  let seen = ''
  const turn = makeTurn(ctx, {
    runner: async (prompt) => { seen = prompt; return { text: '在呢' } },
  })
  const result = await turn.handle(raw({ atMe: true, text: '' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.match(seen, /只 @ 了你/)
})

await check('提示词：文件正文、转发和工具清单都能进上下文', () => {
  const prompt = buildPrompt({
    event: { payload: { text: '看看这个', senderName: '老王' } },
    files: [{ name: '记录.txt', text: '第一行内容' }],
    forward: [{ sender: '小李', text: '转发的原话' }],
    toolLine: '可用工具：recall、send_sticker。',
  })
  assert.match(prompt, /第一行内容/)
  assert.match(prompt, /转发的原话/)
  assert.match(prompt, /send_sticker/)
})

await check('被 @ 时：心跳再多也不能把本群前文挤出上下文', async () => {
  const ctx = open()
  for (let i = 0; i < 3; i += 1) {
    ctx.runtime.events.append({
      kind: 'event', id: `his${i}`, type: 'message', scope: 'group', from: '20002',
      conversation: 'group:555', at: BASE - 10_000 + i, text: `前文${i}`, sender: '老王', group: '555', tags: [],
    })
  }
  // 心跳比历史「更新」：旧实现读全局 80 行时，前文会被它们挤没
  for (let i = 0; i < 100; i += 1) {
    ctx.runtime.events.append({
      kind: 'event', id: `hb${i}`, type: 'heartbeat', scope: 'private', from: 'self',
      conversation: 'private:999', at: BASE - 5_000 + i, tags: [],
    })
  }
  let seen = ''
  const turn = makeTurn(ctx, {
    runner: async (prompt) => { seen = prompt; return { text: '嗯', usage: null } },
  })
  await turn.handle(raw({ scope: SCOPE.GROUP, text: '在吗', atMe: true, payload: { groupId: '555' } }))
  await new Promise((r) => setTimeout(r, 30))
  assert.match(seen, /前文0/, '三句前文都要在')
  assert.match(seen, /前文2/)
  const start = seen.indexOf('刚才的对话：')
  assert.ok(start >= 0, '应该有「刚才的对话」段')
  const end = seen.indexOf('\n\n', start)
  const recent = seen.slice(start, end < 0 ? seen.length : end)
  assert.ok(!recent.includes('在吗'), '当前这条已经落盘，不能再算进 recent')
})

await check('引用取不到原文时，用 reply 段里的摘要兜底，并记一条审计', async () => {
  const ctx = open()
  ctx.channel.getMessage = async () => ({ ok: false, text: '', images: [] })
  let seen = ''
  const turn = makeTurn(ctx, {
    runner: async (prompt) => { seen = prompt; return { text: '嗯', usage: null } },
  })
  await turn.handle(raw({
    scope: SCOPE.GROUP,
    text: '你看这个',
    atMe: true,
    payload: { groupId: '555', replyId: '70001', replySummary: '被引用的原话' },
  }))
  await new Promise((r) => setTimeout(r, 30))
  assert.match(seen, /只拿到摘要/)
  assert.match(seen, /被引用的原话/)
  assert.ok(ctx.runtime.audit.read({ limit: 20 }).rows.some((row) => row.kind === 'quote_failed'), '取不到要留痕')
})

await check('同一条 messageId 重复投递：第二次跳过，不再回一遍', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  const first = await turn.handle(raw({ messageId: 'm-1' }))
  const second = await turn.handle(raw({ messageId: 'm-1' }))
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(first.ok, true)
  assert.equal(second.skipped, true)
  assert.equal(second.reason, '重复投递')
  assert.equal(ctx.sent.length, 1, '重复的那条不能再回一次')
  const rows = ctx.runtime.events.read({ limit: 20 }).rows.filter((row) => row.messageId === 'm-1')
  assert.equal(rows.length, 1, '日志里也只能有一条')
})

await check('脏事件不会把整条链打断', async () => {
  const ctx = open()
  const turn = makeTurn(ctx)
  const result = await turn.handle({ source: '不存在的来源', kind: 'message', scope: 'private' })
  assert.equal(result.ok, false)
  assert.equal(result.stage, 'decide')
  // 后面还能继续正常处理
  const next = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(next.ok, true)
})

// ── 思维链：先想，再做，后说 ─────────────────────────────────
await check('思维链先于回复：通道收到话时，cot 里已经有这一轮', async () => {
  const ctx = open()
  let cotAtSend = 0
  ctx.channel.say = async (scope, target, text) => {
    cotAtSend = ctx.runtime.cot.read({ limit: 10 }).rows.length
    ctx.sent.push({ scope, target, text })
    return { message_id: ctx.sent.length }
  }
  const turn = makeTurn(ctx, { runner: async () => ({ text: '在的', reasoning: '先看看他是不是在叫我', usage: null }) })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.ok(cotAtSend >= 1, '发送时思维链必须已经落盘')
  const rows = ctx.runtime.cot.read({ limit: 10 }).rows
  assert.equal(rows[0].kind, 'reply')
  assert.match(rows[0].text, /先看看/)
})

await check('模型没给思考：回复前也留一条，如实标注', async () => {
  const ctx = open()
  let cotAtSend = 0
  ctx.channel.say = async (scope, target, text) => {
    cotAtSend = ctx.runtime.cot.read({ limit: 10 }).rows.length
    ctx.sent.push({ scope, target, text })
    return { message_id: ctx.sent.length }
  }
  const turn = makeTurn(ctx, { runner: async () => ({ text: '嗯', usage: null }) })
  await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.ok(cotAtSend >= 1, '即使没有 reasoning 也要有记录')
  const rows = ctx.runtime.cot.read({ limit: 10 }).rows
  assert.match(rows[0].text, /没有单独输出思考/)
})

await check('调工具：先落 tool 思维链，再执行，最后回复前落 reply', async () => {
  const ctx = open()
  const order = []
  ctx.channel.say = async (scope, target, text) => {
    order.push('say')
    ctx.sent.push({ scope, target, text })
    return { message_id: ctx.sent.length }
  }
  const script = [
    { text: '[tool:web_search] {"query":"观鸟"}', reasoning: '他想知道鸟的事，先查一下', usage: null },
    { text: '查到了，是候鸟迁徙', reasoning: '查到了迁徙信息，可以回了', usage: null },
  ]
  const turn = makeTurn(ctx, {
    tools: {
      prompt: () => '可用工具：web_search。',
      call: async (name) => { order.push('tool:' + name); return { ok: true, text: '迁徙' } },
    },
    runner: async () => script.shift(),
  })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.deepEqual(order, ['tool:web_search', 'say'])
  const rows = ctx.runtime.cot.read({ limit: 10 }).rows
  assert.equal(rows.length, 2)
  assert.equal(rows[0].kind, 'reply')
  assert.equal(rows[1].kind, 'tool')
  assert.match(rows[1].summary, /web_search：观鸟/)
  assert.match(rows[1].text, /先查一下/)
})

await check('一件事分几步：一条回复里的多个工具按顺序都执行，结果一起回灌', async () => {
  const ctx = open()
  const order = []
  ctx.channel.say = async (scope, target, text) => {
    ctx.sent.push({ scope, target, text })
    return { message_id: ctx.sent.length }
  }
  const prompts = []
  const script = [
    // 模型一次写两行：先搜再记 —— 旧版只执行第一行，第二行被静默吞掉
    {
      text: '[tool:web_search] {"query":"观鸟"}\n[tool:remember_fact] {"text":"主人喜欢观鸟"}',
      reasoning: '先查再记',
      usage: null,
    },
    { text: '记下了，候鸟这阵子正过境', reasoning: '两件都做完了', usage: null },
  ]
  const turn = makeTurn(ctx, {
    tools: {
      prompt: () => '可用工具：web_search、remember_fact。',
      call: async (name, args) => { order.push(name + ':' + JSON.stringify(args)); return { ok: true, text: name + '完成' } },
    },
    runner: async (prompt) => { prompts.push(prompt); return script.shift() },
  })
  const result = await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(result.ok, true)
  assert.deepEqual(order, ['web_search:{"query":"观鸟"}', 'remember_fact:{"text":"主人喜欢观鸟"}'], '两行都要执行，且按写的顺序')
  assert.match(prompts[1], /你刚调用了 2 个工具/, '两个结果要一起回灌')
  assert.match(prompts[1], /web_search完成/)
  assert.match(prompts[1], /remember_fact完成/)
  // 一次调用一条思维链：面板上能看见「先想、再做」
  const rows = ctx.runtime.cot.read({ limit: 10 }).rows
  assert.equal(rows.filter((row) => row.kind === 'tool').length, 2)
})

await check('一次写太多行：只跑到上限，超出的记进审计（不静默丢）', async () => {
  const ctx = open()
  ctx.runtime.setConfig('tools.maxPerRound', 2, { confirm: false })
  const ran = []
  const script = [
    { text: '[tool:calc] {"expression":"1+1"}\n[tool:calc] {"expression":"2+2"}\n[tool:calc] {"expression":"3+3"}', reasoning: '算三个', usage: null },
    { text: '算完了', reasoning: '好了', usage: null },
  ]
  const turn = makeTurn(ctx, {
    tools: { prompt: () => '可用工具：calc。', call: async (name, args) => { ran.push(args.expression); return { ok: true, text: String(args.expression) } } },
    runner: async () => script.shift(),
  })
  await turn.handle(raw())
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(ran, ['1+1', '2+2'], '上限是 2，只跑前两个')
  const row = ctx.runtime.audit.read({ limit: 20 }).rows.find((item) => item.kind === 'tool_batch_truncated')
  assert.ok(row, '被丢掉的那一行要留痕，否则「说了三件事只做两件」永远查不出来')
  assert.equal(row.wanted, 3)
  assert.equal(row.ran, 2)
})

await check('调一次工具就记一笔：技能页的「级别」会从「没试过」动起来', async () => {
  // 这一条钉住的是根因：工具环以前只执行、不记账。
  // 审计里工具跑得好好的，技能页却全是「用过 0 次」——
  // 不是读错了，是根本没人写。
  const ctx = open()
  const script = [
    { text: '[tool:web_search] {"query":"观鸟"}', reasoning: '查一下', usage: null },
    { text: '查到了，候鸟正过境', reasoning: '有结果了', usage: null },
  ]
  const turn = makeTurn(ctx, {
    tools: { has: () => true, prompt: () => '可用工具：web_search。', call: async () => ({ ok: true, text: '候鸟过境' }) },
    runner: async () => script.shift(),
  })
  await turn.handle(raw())
  await new Promise((resolve) => setTimeout(resolve, 30))

  const row = ctx.runtime.skills().groups.flatMap((group) => group.items).find((item) => item.id === 'net.search')
  assert.equal(row.uses, 1, '工具名 web_search 要记到 net.search 头上')
  assert.equal(row.masteryLabel, '在学', '试过一次就不是「没试过」了')
  assert.notEqual(row.rate, null)
})

await check('工具调失败也记：次数要算，成功率要掉', async () => {
  const ctx = open()
  const script = [
    { text: '[tool:file_read] {"path":"x"}', reasoning: '读一下', usage: null },
    { text: '读不到', reasoning: '失败了', usage: null },
  ]
  const turn = makeTurn(ctx, {
    tools: { has: () => true, prompt: () => '可用工具：file_read。', call: async () => ({ ok: false, error: '沙箱没开' }) },
    runner: async () => script.shift(),
  })
  await turn.handle(raw())
  await new Promise((resolve) => setTimeout(resolve, 30))
  const row = ctx.runtime.skills().groups.flatMap((group) => group.items).find((item) => item.id === 'do.file')
  assert.equal(row.uses, 1)
  assert.equal(row.rate, 0, '失败一次的成功率就是 0，不能装作没发生')
})

await check('发小黄脸关掉：提示词不再教 [face:id]，回复里写的也不发出去', async () => {
  // 开关以前只挡 tools.call，而 [face:14] 是**发送层**解释的，
  // 所以关着照样能发 —— 用户看到的就是「开关没用」。
  const ctx = open()
  ctx.runtime.setSkill('media.face', 'off')
  const prompts = []
  const turn = makeTurn(ctx, {
    tools: { has: () => true, prompt: () => '可用工具：（无）。', call: async () => ({ ok: true }) },
    runner: async (prompt) => {
      prompts.push(prompt)
      return { text: '好呀[face:14]', reasoning: '回一句', usage: null }
    },
  })
  await turn.handle(raw())
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(/\[face:id\]/.test(prompts[0]), false, '关掉之后提示词不能再教一条走不通的路')
  assert.equal(ctx.sent.some((item) => /\[face:/.test(item.text)), false, '回复里的内联表情要剥掉')
  assert.equal(ctx.sent.some((item) => item.text.includes('好呀')), true, '文字部分照发，不许整条吞掉')
  const row = ctx.runtime.audit.read({ limit: 20 }).rows.find((item) => item.kind === 'media_suppressed')
  assert.ok(row, '剥掉了要留痕，否则「我明明让它发了」永远查不清')
  assert.deepEqual(row.skills, ['media.face'])
})

await check('发小黄脸开着：提示词里那行还在，表情照常发', async () => {
  const ctx = open()
  const prompts = []
  const turn = makeTurn(ctx, {
    tools: { has: () => true, prompt: () => '可用工具：（无）。', call: async () => ({ ok: true }) },
    runner: async (prompt) => {
      prompts.push(prompt)
      return { text: '好呀[face:14]', reasoning: '回一句', usage: null }
    },
  })
  await turn.handle(raw())
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.match(prompts[0], /\[face:id\]/, '开着就该教它怎么用')
  assert.equal(ctx.sent.some((item) => item.text.includes('[face:14]')), true, '开着就照发')
})

// ── 注意力与打字台（接上了才算数） ───────────────────────────
await check('群聊：窗口命中的人接着说，不用 @ 也回', async () => {
  const ctx = open()
  const attention = new AttentionDesk({ config: ctx.runtime.config, now: () => BASE })
  attention.open('group:30001', '20002')
  const turn = makeTurn(ctx, { attention })
  const result = await turn.handle(raw({ scope: SCOPE.GROUP, text: '那后来呢', payload: { groupId: '30001' } }))
  assert.equal(result.ok, true, '窗口里的话该回')
  assert.ok(ctx.sent.length >= 1)
  assert.equal(attention.hit('group:30001', '20002')?.rec.turns, 1, '回完要续一轮')
})

await check('群聊：窗口里是别人、这句又跟他无关 → 不回，窗口不动', async () => {
  const ctx = open()
  const attention = new AttentionDesk({ config: ctx.runtime.config, now: () => BASE })
  attention.open('group:30001', '30003')
  const turn = makeTurn(ctx, { attention })
  const result = await turn.handle(raw({ scope: SCOPE.GROUP, from: '20002', text: '今晚八点开黑来人', payload: { groupId: '30001' } }))
  assert.equal(result.skipped, true, '没点到就不该接')
  assert.equal(ctx.sent.length, 0)
  assert.ok(attention.hit('group:30001', '30003'), '旧目标的窗口要留着')
})

await check('打字台接上：发之前先亮「正在输入」，然后才出站', async () => {
  const ctx = open()
  const events = []
  const channel = {
    inputStatus: async () => events.push('typing'),
    say: async (scope, target, text) => {
      events.push('say:' + text)
      ctx.sent.push({ scope, target, text })
      return { message_id: ctx.sent.length }
    },
  }
  const typing = new TypingDesk({ channel, sleep: async () => {}, random: () => 0, log: () => {} })
  const turn = makeTurn({ ...ctx, channel }, { channel, typing })
  await turn.handle(raw())
  assert.equal(events[0], 'typing', '指示器必须排在第一条消息之前')
  assert.ok(events.some((one) => one.startsWith('say:')), '消息还是要发出去')
  // 提前亮过的那一次必须被 typeOut 认领：亮两次会闪，看起来像「打好了又删掉重打」
  assert.equal(events.filter((one) => one === 'typing').length, 1, '同一条回复只亮一次')
})

await check('先亮再发：early 一定在 typeOut 之前，且一条只亮一次', async () => {
  const ctx = open()
  const events = []
  const channel = {
    inputStatus: async () => events.push('typing'),
    say: async () => { events.push('say') },
  }
  const typing = new TypingDesk({ channel, sleep: async () => {}, random: () => 0, log: () => {} })
  const turn = makeTurn({ ...ctx, channel }, { channel, typing })
  // 登记「暂时不想理」走的是 runtime.dir 下的文件；用 turn 提供的接口能确认路径，
  // 这里直接验「判定在前、亮灯在后」这条顺序：把 typing 换成会计数的假对象。
  const order = []
  turn.typing = {
    early: async () => { order.push('early') },
    typeOut: async (input) => { order.push('typeOut'); await input.say('嗯'); return { ok: true, lines: 1 } },
  }
  await turn.handle(raw())
  assert.deepEqual(order, ['early', 'typeOut'], '先亮再发，且只亮一次')
})

for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
console.log(`\n${failed.length ? '✗' : '✓'} 回合用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error.stack || error.message}`)
  process.exit(1)
}
