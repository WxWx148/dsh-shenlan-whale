/**
 * 确认台用例。
 *
 * 这一份钉的是「弹窗背后那件事」：挂了多久、超时算不算拒绝、
 * 「记住」到底记住了什么、以及每一次决定有没有留下记录。
 * 界面怎么画不在这里测 —— 那是页面骨架用例的事。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ApprovalDesk, approvalText } from '../ability/index.mjs'

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

function makeDesk(over = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-approval-'))
  const logs = []
  const desk = new ApprovalDesk({
    dir,
    timeoutMs: 10_000,
    log: (kind, detail) => logs.push({ kind, detail }),
    ...over,
  })
  return { desk, dir, logs }
}

const ask = (desk, code = 'console.log(1)') => desk.request({ code, plan: ['算一下'], label: '测试' })
const readJournal = (dir) => readFileSync(path.join(dir, 'approvals.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

await check('同意：请求挂起 → 决定 → 放行，日志里先 asked 再 allow', async () => {
  const { desk, dir } = makeDesk()
  const pending = ask(desk)
  const list = desk.list()
  assert.equal(list.length, 1)
  assert.equal(list[0].plan[0], '算一下')
  assert.ok(list[0].leftMs > 0)
  const verdict = desk.decide(list[0].id, { allow: true })
  assert.equal(verdict.ok, true)
  const settled = await pending
  assert.equal(settled.allowed, true)
  assert.equal(settled.timedOut, false)
  assert.equal(desk.list().length, 0, '决定之后不该再挂在列表里')
  assert.deepEqual(readJournal(dir).map((row) => row.decision), ['asked', 'allow'])
  rmSync(dir, { recursive: true, force: true })
})

await check('超时：没人点就按拒绝收口，理由是明文写的', async () => {
  const { desk, dir } = makeDesk({ timeoutMs: 40, graceMs: 0, unref: false })
  const started = Date.now()
  const verdict = await ask(desk)
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.timedOut, true)
  assert.match(verdict.reason, /超时未确认/)
  assert.ok(Date.now() - started < 2000, '超时收口太慢：会把一轮对话吊在那儿')
  assert.equal(desk.list().length, 0)
  assert.deepEqual(readJournal(dir).map((row) => row.decision), ['asked', 'timeout'])
  rmSync(dir, { recursive: true, force: true })
})

await check('只能决定一次：第二次点返回「已经结束了」，不覆盖前一个结论', async () => {
  const { desk, dir } = makeDesk()
  const pending = ask(desk)
  const id = desk.list()[0].id
  assert.equal(desk.decide(id, { allow: false, reason: '不行' }).ok, true)
  const again = desk.decide(id, { allow: true })
  assert.equal(again.ok, false)
  assert.match(again.error, /已经结束/)
  const settled = await pending
  assert.equal(settled.allowed, false, '第二次点击把结论改掉了')
  rmSync(dir, { recursive: true, force: true })
})

await check('记住拒绝：之后连问都不问，但每次都要留一条 remembered', async () => {
  const { desk, dir } = makeDesk()
  const first = ask(desk)
  desk.decide(desk.list()[0].id, { allow: false, remember: true, reason: '别乱跑' })
  await first
  assert.deepEqual(desk.remember(), { allow: false, reason: '别乱跑', at: desk.remember().at })
  const second = await ask(desk, 'console.log(2)')
  assert.equal(second.allowed, false)
  assert.equal(second.remembered, true)
  assert.equal(second.reason, '别乱跑')
  assert.equal(desk.list().length, 0, '记住之后不该再挂起')
  const rows = readJournal(dir)
  assert.equal(rows.filter((row) => row.decision === 'remembered').length, 1)
  // 记住的结论要能跨实例活着（落盘，不是内存里的一个布尔）
  const again = new ApprovalDesk({ dir, timeoutMs: 1000 })
  assert.equal((await ask(again)).remembered, true)
  rmSync(dir, { recursive: true, force: true })
})

await check('忘记：清掉记住的结论，并且说清之前是什么', async () => {
  const { desk, dir } = makeDesk()
  const first = ask(desk)
  desk.decide(desk.list()[0].id, { allow: true, remember: true })
  await first
  const cleared = desk.forget()
  assert.equal(cleared.cleared, true)
  assert.equal(cleared.before.allow, true)
  assert.equal(desk.remember(), null)
  // 清掉之后要重新问，不能还是「记住」的结论
  const pending = ask(desk)
  assert.equal(desk.list().length, 1)
  desk.decide(desk.list()[0].id, { allow: true })
  assert.equal((await pending).allowed, true)
  assert.equal(desk.forget().cleared, false, '本来没记住时也要如实说')
  rmSync(dir, { recursive: true, force: true })
})

await check('堆太多：第 7 条不再排队，当场拒绝并说明', async () => {
  const { desk, dir } = makeDesk({ maxPending: 2 })
  ask(desk, 'console.log(1)')
  ask(desk, 'console.log(2)')
  const overflow = await ask(desk, 'console.log(3)')
  assert.equal(overflow.allowed, false)
  assert.match(overflow.reason, /堆太多/)
  assert.equal(desk.list().length, 2, '第 3 条不该挤进队列')
  // 收尾：把挂着的两条放掉，免得计时器留在后台
  for (const item of desk.list()) desk.decide(item.id, { allow: false })
  rmSync(dir, { recursive: true, force: true })
})

await check('统计：问了几次、同意几次、拒绝几次（含超时）', async () => {
  const { desk, dir } = makeDesk()
  const a = ask(desk)
  desk.decide(desk.list()[0].id, { allow: true })
  await a
  const b = ask(desk)
  desk.decide(desk.list()[0].id, { allow: false, reason: '不' })
  await b
  const stats = desk.stats()
  assert.equal(stats.asked, 2)
  assert.equal(stats.allowed, 1)
  assert.equal(stats.denied, 1)
  assert.equal(stats.timedOut, 0)
  rmSync(dir, { recursive: true, force: true })
})

await check('询问里带项目与目的：没有这两行的确认等于让人盲签', async () => {
  const { desk, dir } = makeDesk()
  const pending = desk.request({ code: 'console.log(1)', plan: ['算乘法', '打印结果'], project: '深蓝鲸', purpose: '算一次乘法' })
  const item = desk.list()[0]
  assert.equal(item.project, '深蓝鲸')
  assert.equal(item.purpose, '算一次乘法')
  const text = approvalText(item)
  assert.match(text, /项目：深蓝鲸/)
  assert.match(text, /目的：算一次乘法/)
  assert.match(text, /步骤：算乘法 → 打印结果/)
  assert.match(text, /同意/)
  desk.decide(item.id, { allow: false })
  await pending
  rmSync(dir, { recursive: true, force: true })
})

await check('问人时顺便通知渠道：回调拿到的是能直接发出去的一份快照', async () => {
  const seen = []
  const { desk, dir } = makeDesk({ notify: (record) => seen.push(record) })
  const pending = ask(desk)
  assert.equal(seen.length, 1, '渠道没收到通知')
  assert.equal(seen[0].project, '深蓝鲸')
  assert.ok(seen[0].purpose)
  assert.ok(seen[0].ref && seen[0].ref.length === 4, '编号要短到能口述')
  assert.equal(seen[0].waiting, 1)
  assert.equal(typeof seen[0].resolve, 'undefined', '快照里不该带 resolve 这种内部句柄')
  desk.decide(desk.list()[0].id, { allow: true })
  await pending
  rmSync(dir, { recursive: true, force: true })
})

await check('在 QQ 里回「同意」= 一次决定；回别的话不拦', async () => {
  const { desk, dir } = makeDesk()
  const pending = ask(desk, 'console.log(42)')
  assert.equal(desk.takeReply('今晚吃什么'), null, '普通聊天被当成指令了')
  const verdict = desk.takeReply('同意')
  assert.equal(verdict.handled, true)
  assert.equal(verdict.allowed, true)
  assert.match(verdict.message, /好/)
  assert.equal((await pending).allowed, true)
  rmSync(dir, { recursive: true, force: true })
})

await check('回「拒绝 理由」：理由进日志，也进给模型的下一句话', async () => {
  const { desk, dir } = makeDesk()
  const pending = ask(desk)
  const verdict = desk.takeReply('拒绝 这段别跑')
  assert.equal(verdict.allowed, false)
  const settled = await pending
  assert.equal(settled.reason, '这段别跑')
  const rows = readJournal(dir).filter((row) => row.decision === 'deny')
  assert.equal(rows[0].reason, '这段别跑')
  rmSync(dir, { recursive: true, force: true })
})

await check('多条在等时必须带编号：猜一条等于放行错的那段代码', async () => {
  const { desk, dir } = makeDesk()
  const first = ask(desk, 'console.log(1)')
  const second = ask(desk, 'console.log(2)')
  const vague = desk.takeReply('同意')
  assert.equal(vague.handled, true)
  assert.match(vague.message, /编号/)
  assert.equal(desk.list().length, 2, '含糊的回答不该放行任何一条')

  const ref = desk.list()[0].ref
  const hit = desk.takeReply('同意 ' + ref)
  assert.equal(hit.handled, true)
  assert.equal((await first).allowed, true)
  assert.equal(desk.list().length, 1)
  desk.decide(desk.list()[0].id, { allow: false })
  await second
  rmSync(dir, { recursive: true, force: true })
})

await check('没有等待项时说「同意」：不吞消息，交给正常聊天', async () => {
  const { desk, dir } = makeDesk()
  assert.equal(desk.takeReply('同意'), null)
  assert.equal(desk.takeReply('拒绝 不行'), null)
  rmSync(dir, { recursive: true, force: true })
})

await check('统计口径：一趟遍历算出来的四个数，和逐条数出来的一模一样', async () => {
  const { desk, dir } = makeDesk()
  // 造够多种记录：问过、同意、拒绝、记住后放行
  ask(desk, 'console.log(1)')
  const firstId = [...desk.pending.keys()][0]
  desk.decide(firstId, { allow: true })

  ask(desk, 'console.log(2)')
  desk.decide([...desk.pending.keys()][0], { allow: false, reason: '不行' })

  desk.decide('', { allow: true }) // 不存在的 id：不该改动任何计数

  desk.state.remember = { allow: true, reason: '信任', at: Date.now() }
  await desk.request({ code: 'console.log(3)' }) // 走「记住的结论」，只记一条 remembered

  const stats = desk.stats()
  const rows = readJournal(dir)
  const tally = (decision) => rows.filter((row) => row.decision === decision).length
  assert.equal(stats.asked, tally('asked'), 'asked 要等于日志里 asked 的条数')
  assert.equal(stats.allowed, tally('allow'))
  assert.equal(stats.denied, tally('deny'))
  assert.equal(stats.timedOut, tally('timeout'))
  assert.equal(stats.remembered, tally('remembered'), '「记住后直接放行」也要数得出来')
  assert.equal(stats.remembered, 1, '两次问只放行了一次，另一个是普通同意')
  desk.close()
  rmSync(dir, { recursive: true, force: true })
})

await check('close：放掉句柄之后还能继续记，记录一条不丢', async () => {
  const { desk, dir } = makeDesk()
  ask(desk) // 不 await：这是一条等着的请求，等它 settle 就是在等超时
  desk.close()
  ask(desk, 'console.log(9)')
  assert.equal(readJournal(dir).length, 2, '关句柄不等于关账本')
  desk.close()
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${failed.length ? '✗' : '✓'} 确认台用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
