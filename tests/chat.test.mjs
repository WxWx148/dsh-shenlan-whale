/**
 * 独立对话的用例。
 *
 * 重点不是「能不能聊天」，而是三件容易坏、坏了又看不出来的事：
 *   1. 没有生成器时**不许**伪造一条回复（那是最伤信任的一种「看起来能用」）；
 *   2. 用户说的和它回的都要落盘，顺序不能反（界面按顺序铺，反了就成对不上话）；
 *   3. 上一条没说完时不许接新的（并发会让两段回复交错）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Chat } from '../app/index.mjs'

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

const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-chat-'))

const runtime = {
  config: { persona: { name: '深蓝', persona: '说话短一点' } },
  styleOptions: () => ({ maxParts: 3 }),
  styleGuide: () => '语气自然',
}

/** 造一个可控的 runner：返回固定文本，或按脚本抛错/挂起 */
function makeRunner(script = {}) {
  const calls = []
  const runner = async (prompt, meta) => {
    calls.push({ prompt, meta })
    if (script.hang) await script.hang
    if (script.throw) throw new Error(script.throw)
    return { text: script.text === undefined ? '嗯，我在' : script.text, usage: { input: 12, output: 6 }, model: 'test' }
  }
  return { runner, calls }
}

const usage = {
  rows: [],
  record(input, output, meta) {
    this.rows.push({ input, output, meta })
  },
}

console.log('\n独立对话')

await check('没有生成器：ready=false，发出去会被明确拒绝，不伪造回复', async () => {
  const chat = new Chat({ dir: mkdtempSync(path.join(tmpdir(), 'shenlan-chat-')), runtime, usage, now: () => 1 })
  assert.equal(chat.ready, false)
  const result = await chat.send({ text: '在吗' })
  assert.equal(result.ok, false)
  assert.match(result.error, /生成能力还没接上/)
  assert.deepEqual(chat.history().rows, [], '拒绝时不该往历史里写东西')
  assert.equal(usage.rows.length, 0)
})

await check('有生成器：我说的和它回的按顺序落盘，回的分条也在', async () => {
  const box = makeRunner({ text: '在的。刚在整理东西。你说' })
  const chat = new Chat({ dir: mkdtempSync(path.join(tmpdir(), 'shenlan-chat-')), runtime, usage, runner: box.runner, now: () => 1000 })
  const result = await chat.send({ text: '在吗' })
  assert.equal(result.ok, true)
  assert.ok(Array.isArray(result.parts) && result.parts.length >= 1, '要返回分条结果')

  const rows = chat.history().rows
  assert.equal(rows.length, 2)
  assert.equal(rows[0].from, 'me')
  assert.equal(rows[0].text, '在吗')
  assert.equal(rows[1].from, 'self')
  assert.deepEqual(rows[1].parts, result.parts)
  assert.equal(box.calls.length, 1)
  assert.match(box.calls[0].prompt, /在吗/, 'prompt 里必须带上这句话')
  assert.match(box.calls[0].prompt, /说话短一点/, '人设要进 prompt')
})

await check('记账：每次生成都进账本，会话 id 固定（上下文才能连上）', async () => {
  usage.rows.length = 0
  const box = makeRunner({ text: '好' })
  const chat = new Chat({ dir: mkdtempSync(path.join(tmpdir(), 'shenlan-chat-')), runtime, usage, runner: box.runner, now: () => 2000 })
  await chat.send({ text: '一' })
  await chat.send({ text: '二' })
  assert.equal(usage.rows.length, 2)
  assert.equal(usage.rows[0].input, 12)
  assert.equal(usage.rows[0].meta.conversation, usage.rows[1].meta.conversation, '两次必须是同一个会话')
})

await check('空话不发：只有空白就直说，不浪费一次调用', async () => {
  const box = makeRunner({})
  const chat = new Chat({ dir: mkdtempSync(path.join(tmpdir(), 'shenlan-chat-')), runtime, usage, runner: box.runner, now: () => 3000 })
  const result = await chat.send({ text: '   ' })
  assert.equal(result.ok, false)
  assert.equal(box.calls.length, 0)
})

await check('上一条没说完：第二次直接拒绝，不并发', async () => {
  let release
  const hang = new Promise((resolve) => {
    release = resolve
  })
  const box = makeRunner({ hang, text: '慢一点' })
  const chat = new Chat({ dir: mkdtempSync(path.join(tmpdir(), 'shenlan-chat-')), runtime, usage, runner: box.runner, now: () => 4000 })
  const first = chat.send({ text: '一' })
  // 让第一条先进入 busy
  await new Promise((resolve) => setTimeout(resolve, 0))
  const second = await chat.send({ text: '二' })
  assert.equal(second.ok, false)
  assert.match(second.error, /还在说/)
  release()
  const done = await first
  assert.equal(done.ok, true)
  assert.equal(box.calls.length, 1)
})

await check('模型出错：回一条可读的错误，不把异常甩到页面上', async () => {
  const box = makeRunner({ throw: '接口 429' })
  const chat = new Chat({ dir: mkdtempSync(path.join(tmpdir(), 'shenlan-chat-')), runtime, usage, runner: box.runner, now: () => 5000 })
  const result = await chat.send({ text: '在吗' })
  assert.equal(result.ok, false)
  assert.match(result.error, /429/)
  const rows = chat.history().rows
  assert.equal(rows.length, 2, '我那句和一条占位都要留下')
  assert.equal(rows[1].tone, 'error')
})

await check('清屏：留一条分隔记录，不删历史（事实不删）', () => {
  const chat = new Chat({ dir: mkdtempSync(path.join(tmpdir(), 'shenlan-chat-')), runtime, usage, now: () => 6000 })
  assert.equal(chat.reset().ok, true)
  const rows = chat.history().rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].tone, 'reset')
})

await check('工具环：模型写 [tool:calc]，真的执行，结果喂回去，回复里不留标记', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-chat-'))
  let round = 0
  const calls = []
  const runner = async (prompt) => {
    calls.push(prompt)
    round += 1
    if (round === 1) return { text: '[tool:calc] {"expression":"6*7"}', usage: { input: 10, output: 4 } }
    return { text: '算出来了，是 42。', usage: { input: 8, output: 5 } }
  }
  const calcCalls = []
  const tools = {
    call(name, args) {
      calcCalls.push({ name, args })
      return { ok: true, text: '42' }
    },
  }
  const chat = new Chat({ dir, runtime, usage, runner, tools, now: () => 7000 })
  const result = await chat.send({ text: '六乘七是多少' })
  assert.equal(result.ok, true)
  assert.equal(result.text, '算出来了，是 42。')
  assert.doesNotMatch(result.text, /\[tool:/, '用户不该看到工具标记')
  assert.deepEqual(calcCalls, [{ name: 'calc', args: { expression: '6*7' } }])
  // 结果回灌改成「一批调用的结果清单」，措辞变了，但必须带上工具名和它跑出来的值
  assert.match(calls[1], /你刚调用了 1 个工具/, '第二次要把结果喂回去')
  assert.match(calls[1], /calc/, '回灌里要写明调的是哪个工具')
  assert.match(calls[1], /42/, '回灌里要有工具的真实结果')
  assert.match(calls[1], /42/)
  rmSync(dir, { recursive: true, force: true })
})

await check('工具环：工具失败也说人话，不把 [tool:…] 甩给用户', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-chat-'))
  const runner = async () => ({ text: '[tool:exec_sandbox] {"code":"x","plan":["试试"]}', usage: { input: 1, output: 1 } })
  const tools = { call: () => ({ ok: false, error: '跑出错了：ReferenceError: a is not defined' }) }
  const chat = new Chat({ dir, runtime, usage, runner, tools, now: () => 8000 })
  const result = await chat.send({ text: '跑段代码' })
  assert.equal(result.ok, true)
  assert.doesNotMatch(result.text, /\[tool:/)
  assert.match(result.text, /ReferenceError/, '跑失败时要把原因说出来')
  rmSync(dir, { recursive: true, force: true })
})

await check('没有工具表：不给它执行任何东西，也不会把标记当正文乱裁', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-chat-'))
  const box = makeRunner({ text: '这句里有个 [tool:calc] 的字样，但没工具可调' })
  const chat = new Chat({ dir, runtime, usage, runner: box.runner, now: () => 9000 })
  const result = await chat.send({ text: '在吗' })
  assert.equal(result.ok, true)
  assert.match(result.text, /\[tool:calc\]/, '没有工具表时不该假装执行，也不该吞掉原话')
  assert.equal(box.calls.length, 1)
  rmSync(dir, { recursive: true, force: true })
})

await check('思维链先于回复：落思维链时，回复还没写进历史', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'shenlan-chat-'))
  const cotRows = []
  let selfRowsAtCot = -1
  let chat = null
  const runtime2 = {
    ...runtime,
    logCot(row) {
      cotRows.push(row)
      selfRowsAtCot = chat.history().rows.filter((item) => item.from === 'self').length
    },
  }
  const runner = async () => ({ text: '在的', reasoning: '先确认他在不在', usage: null })
  chat = new Chat({ dir, runtime: runtime2, usage, runner, now: () => 10_000 })
  const result = await chat.send({ text: '在吗' })
  assert.equal(result.ok, true)
  assert.equal(cotRows.length, 1)
  assert.equal(cotRows[0].kind, 'reply')
  assert.match(cotRows[0].text, /先确认/)
  assert.equal(selfRowsAtCot, 0, '落思维链时回复不该已经写进历史')
  rmSync(dir, { recursive: true, force: true })
})

rmSync(dir, { recursive: true, force: true })
console.log(`\n${failed.length ? '✗' : '✓'} 独立对话用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
