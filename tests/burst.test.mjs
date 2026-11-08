/**
 * tests/burst.test.mjs — 连发合并
 *
 * 这一层同时扛两件事，所以用例也要同时盯两头：
 *
 *   · **拟人**：真人看到有人连着发三句，不会立刻回第一条 ——
 *     他会等一下，看对方是不是还在说，说完了才回一句。
 *     这个「等一下」是拟人的一部分。
 *   · **风控**：一次回复覆盖多条，群里就不会出现「问三句答三遍」的刷屏。
 *
 * 最要紧的一条：**合并不能吞掉内容**。
 * 丢了内容比刷屏难看得多 —— 刷屏难看，丢内容是失功能。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Runtime } from '../app/index.mjs'
import { Guard } from '../decide/index.mjs'
import { Usage } from '../facts/index.mjs'
import { Turn } from '../turn/index.mjs'
import { KIND, SCOPE, SOURCE } from '../facts/index.mjs'

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
    console.log(`    ${String(error?.message || error).split('\n').slice(0, 3).join('\n    ')}`)
  }
}

const BASE = new Date(2026, 9, 29, 14, 0, 0).getTime()
const dirs = []

function open() {
  const dir = mkdtempSync(path.join(tmpdir(), 'burst-'))
  dirs.push(dir)
  const runtime = new Runtime({ dir, now: () => BASE })
  runtime.setConfig('identity.ownerId', '200000001', { confirm: true })
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

/**
 * 造一个回合，计时器由用例控制。
 *
 * 为什么要自己控制计时器：
 *   合并窗口的真实值是 1.5 秒（等对方说完）。用例里真等 1.5 秒，
 *   整个套件会慢十几倍，而且断言会时快时慢。
 *   这里让用例能**精确控制「什么时候算对方说完了」**，
 *   于是能验证「在窗口内又发一条 → 会被并进去」这种时序。
 *
 * runner 会把**收到的提示词**记下来 —— 合并的内容要能被模型看到，
 * 所以要验证的是「提示词里有没有那几条」，而不是「发出去的话里有没有」
 * （发出去的话是模型写的，跟合并无关）。
 */
function makeTurn(ctx, timers) {
  const prompts = []
  return {
    prompts,
    turn: new Turn({
      runtime: ctx.runtime,
      guard: ctx.guard,
      usage: ctx.usage,
      channel: ctx.channel,
      runner: async (prompt) => {
        prompts.push(String(prompt || ''))
        return { text: '在，怎么了', usage: { input: 100, output: 20 } }
      },
      sleep: async () => {},
      now: () => BASE,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    }),
  }
}

/** 手动计时的器：用例自己决定「对方说完」的时刻 */
function manualTimers() {
  const pending = new Map()
  let seq = 0
  return {
    pending,
    setTimer(fn) {
      seq += 1
      const id = seq
      pending.set(id, fn)
      return id
    },
    clearTimer(id) {
      pending.delete(id)
    },
    /** 让所有待触发的计时器都触发（模拟「窗口到了」） */
    flush() {
      const list = [...pending.values()]
      pending.clear()
      for (const fn of list) fn()
    },
  }
}

const raw = (over = {}) => ({
  source: SOURCE.CHANNEL,
  kind: KIND.MESSAGE,
  scope: SCOPE.GROUP,
  from: '20002',
  text: '在吗',
  at: BASE,
  // 群消息必须带 groupId：不知道发给谁，回话那一步会直接收场。
  payload: { groupId: '555' },
  ...over,
})

async function settle(ms = 20) {
  await new Promise((r) => setTimeout(r, ms))
}

// ── 合并本身 ─────────────────────────────────────────────────
await check('连发：一个人连着发三条 → 只回一次，一次把三条都答了', async () => {
  const ctx = open()
  const timers = manualTimers()
  const { turn, prompts } = makeTurn(ctx, timers)

  await turn.handle(raw({ text: '在吗', atMe: true }))
  await turn.handle(raw({ text: '你还在不', atMe: true }))
  await turn.handle(raw({ text: '说句话呀', atMe: true }))
  await settle()
  assert.equal(ctx.sent.length, 0, '窗口没到之前不该回（真人会等对方说完）')

  timers.flush()
  await settle(120)
  assert.equal(ctx.sent.length, 1, '三条并成一次回复，不该回三遍')
  assert.equal(prompts.length, 1, '只该推理一次 —— 三条一起想完再回')
  // 三条的内容都要在提示词里 —— 丢内容比刷屏难看得多
  assert.match(prompts[0], /在吗/, '第一条的内容要能看到')
  assert.match(prompts[0], /你还在不/, '中间那条也要能看到')
  assert.match(prompts[0], /说句话呀/, '最后一条的内容也要能看到')
})

await check('连发：不同的人说的不合并（那是两件事）', async () => {
  const ctx = open()
  const timers = manualTimers()
  const { turn, prompts } = makeTurn(ctx, timers)

  await turn.handle(raw({ from: '20002', text: 'A 在吗', atMe: true }))
  await turn.handle(raw({ from: '20003', text: 'B 说句话', atMe: true }))
  timers.flush()
  await settle(120)

  assert.equal(ctx.sent.length, 2, '两个人各问各的，该各回一次')
  assert.equal(prompts.length, 2, '两个人该各想一次')
  // 上下文里本来就会带最近几条消息（含别人的），
  // 所以这里要看的不是「有没有 B 的话」，而是「有没有被当成一件事想」。
  // 判据：两次推理各自只对着一条说话的人 —— 合并的话会是「A 在吗\nB 说句话」。
  assert.ok(!prompts[0].includes('A 在吗\nB 说句话'), '不能把两个人的话拼成一次想')
})

await check('连发：只回一条的时间（窗口到了才发，不抢答）', async () => {
  const ctx = open()
  const timers = manualTimers()
  const { turn } = makeTurn(ctx, timers)

  const result = await turn.handle(raw({ text: '在吗', atMe: true }))
  await settle()
  // 对外契约不变：立刻返回「已接收」，不占着调用方等一个窗口
  assert.equal(result.ok, true, 'handle 要立刻返回，不能让调用方等窗口')
  assert.equal(ctx.sent.length, 0, '窗口没到不该发')

  timers.flush()
  await settle(120)
  assert.equal(ctx.sent.length, 1, '窗口到了才发')
})

await check('连发：窗口开着时又来一条 → 并进去，不会各回一次', async () => {
  const ctx = open()
  const timers = manualTimers()
  const { turn, prompts } = makeTurn(ctx, timers)

  await turn.handle(raw({ text: '第一条', atMe: true }))
  // 窗口还没到，第二条来了
  await turn.handle(raw({ text: '第二条', atMe: true }))
  timers.flush()
  await settle(120)

  assert.equal(ctx.sent.length, 1, '两条并成一次')
  assert.equal(prompts.length, 1, '只该想一次')
  assert.match(prompts[0], /第一条/)
  assert.match(prompts[0], /第二条/)
})

await check('连发：私聊不合并（主人一条条问，每条都要单独答）', async () => {
  const ctx = open()
  const timers = manualTimers()
  const { turn, prompts } = makeTurn(ctx, timers)

  await turn.handle(raw({ scope: SCOPE.PRIVATE, text: '在吗' }))
  await turn.handle(raw({ scope: SCOPE.PRIVATE, text: '在吗' }))
  timers.flush()
  await settle(120)

  assert.equal(ctx.sent.length, 2, '私聊要逐条答 —— 攒着不答像怠慢')
  assert.equal(prompts.length, 2, '私聊要逐条想')
})

await check('连发：窗口是 0 就等于关掉合并', async () => {
  const ctx = open()
  const set = ctx.runtime.setConfig('guard.mergeWindowMs', 0)
  assert.equal(set.ok, true, '窗口要能设成 0（关掉合并）—— ' + (set.error || ''))
  const timers = manualTimers()
  const { turn, prompts } = makeTurn(ctx, timers)

  await turn.handle(raw({ text: '在吗', atMe: true }))
  await turn.handle(raw({ text: '在吗', atMe: true }))
  await settle(120)

  assert.equal(ctx.sent.length, 2, '关了合并就该逐条回')
  assert.equal(prompts.length, 2, '关了合并就该逐条想')
})

// ── 收尾 ─────────────────────────────────────────────────────
for (const dir of dirs) {
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
}
if (failed.length) {
  console.log(`\n✗ 连发合并：${failed.length} 项失败`)
  for (const { name, err } of failed) console.log(`  · ${name}: ${err?.message ?? err}`)
  process.exit(1)
}
console.log(`\n✓ 连发合并：${passed} 项通过`)
