/**
 * 沙箱执行器用例。
 *
 * 这一份测的不是「代码跑得对不对」，而是**面板上那七个数字是不是真的在执行**：
 * 档位、熔断、计划、静态闸门、每小时 / 每天上限、超时、越界。
 * 每一条都拿一个真实子进程验证 —— 只测返回值、不测真跑，等于自己骗自己。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { Sandbox, runnerPlan } from '../ability/index.mjs'
import { createTools } from '../ability/index.mjs'

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

/** 一个最小运行时：配置 + 审计收件箱，够执行器用了 */
function makeDir() {
  return mkdtempSync(path.join(tmpdir(), 'whale-sandbox-'))
}

function makeSandbox(dir, overrides = {}, sourceRoot = '') {
  const logs = []
  const runtime = {
    dir,
    config: {
      sandbox: {
        mode: 'free',
        hourlyMax: 10,
        dailyMax: 40,
        timeoutMs: 5000,
        memMb: 128,
        maxCodeBytes: 4096,
        fuseAfter: 2,
        fuseHours: 2,
        ...overrides,
      },
    },
    log: (kind, detail) => logs.push({ kind, detail }),
  }
  return { sandbox: new Sandbox({ dir, runtime, sourceRoot }), runtime, logs }
}

await check('跑一段真的代码：输出原样回来，记录写进 runs.jsonl', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir)
  const result = await sandbox.run({ code: 'console.log("六乘七", 6 * 7)', plan: ['算个乘法'] })
  assert.equal(result.ok, true, result.error)
  assert.match(result.text, /六乘七 42/)
  assert.ok(result.runId)
  const file = path.join(dir, 'sandbox', 'runs.jsonl')
  assert.equal(existsSync(file), true, '跑过就该有记录')
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.at(-1).kind, 'run')
  assert.equal(rows.at(-1).ok, true)
  assert.deepEqual(rows.at(-1).plan, ['算个乘法'])
  rmSync(dir, { recursive: true, force: true })
})

await check('没有计划就不执行：计划闸门在前，代码根本没起进程', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir)
  const result = await sandbox.run({ code: 'console.log(1)' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sandbox_plan')
  assert.equal(readdirSync(path.join(dir, 'sandbox')).filter((name) => name.startsWith('s')).length, 0, '被拒的运行不该留下运行目录')
  rmSync(dir, { recursive: true, force: true })
})

await check('静态闸门：起子进程的直接拒，并记一次越界', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { fuseAfter: 5 })
  const result = await sandbox.run({ code: 'require("child_process").execSync("whoami")', plan: ['起进程'] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sandbox_gate')
  assert.equal(sandbox.status().violations, 1)
  rmSync(dir, { recursive: true, force: true })
})

await check('连续越界到阈值就熔断：之后连正常代码也拒', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { fuseAfter: 2, fuseHours: 2 })
  await sandbox.run({ code: 'require("child_process").execSync("whoami")', plan: ['一次'] })
  await sandbox.run({ code: 'require("child_process").execSync("whoami")', plan: ['两次'] })
  const state = sandbox.status()
  assert.ok(state.fuseLeftMs > 0, '两次越界之后应该熔断')
  const blocked = await sandbox.run({ code: 'console.log(1)', plan: ['正常代码'] })
  assert.equal(blocked.code, 'sandbox_fuse')
  rmSync(dir, { recursive: true, force: true })
})

await check('越界读写：只读自己的运行目录，读 C:/Windows 被挡住', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { fuseAfter: 5 })
  const result = await sandbox.run({
    code: 'console.log(require("node:fs").readFileSync("C:/Windows/win.ini", "utf8"))',
    plan: ['读外面的文件'],
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sandbox_denied')
  assert.equal(sandbox.status().violations, 1, '越界读写要算一次越界')
  rmSync(dir, { recursive: true, force: true })
})

await check('联网被挡：fetch 拿到的只有拒绝', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { fuseAfter: 5 })
  const result = await sandbox.run({
    code: 'fetch("https://example.com").then((r) => console.log("通了", r.status)).catch((e) => console.log("被挡", e.code))',
    plan: ['试着联网'],
  })
  assert.equal(result.ok, true, result.error)
  assert.match(result.text, /被挡 ECONNREFUSED/)
  rmSync(dir, { recursive: true, force: true })
})

await check('超时：死循环被掐掉，不是一直等下去', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { timeoutMs: 1000 })
  const started = Date.now()
  const result = await sandbox.run({ code: 'while (true) {}', plan: ['转圈'] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sandbox_timeout')
  assert.ok(Date.now() - started < 6000, '超时之后要立刻收尾')
  rmSync(dir, { recursive: true, force: true })
})

await check('代码太长、代码是空的：都拒绝，且说清原因', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { maxCodeBytes: 512 })
  const long = await sandbox.run({ code: `console.log("${'x'.repeat(600)}")`, plan: ['太长'] })
  assert.equal(long.code, 'sandbox_too_long')
  const empty = await sandbox.run({ code: '   ', plan: ['空的'] })
  assert.equal(empty.code, 'sandbox_empty')
  rmSync(dir, { recursive: true, force: true })
})

/** 等一个条件成立，最多等 1 秒。用来等「请求已经登记到确认台」 */
async function waitFor(fn, ms = 1000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fn()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

await check('档位：off 一条不跑', async () => {
  const dir = makeDir()
  const off = makeSandbox(dir, { mode: 'off' })
  assert.equal((await off.sandbox.run({ code: 'console.log(1)', plan: ['x'] })).code, 'sandbox_off')
  rmSync(dir, { recursive: true, force: true })
})

await check('ask 档：点了同意才真的跑，记录里先有「问过」再有「同意」', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { mode: 'ask', confirmSeconds: 10 })
  const running = sandbox.run({ code: 'console.log("同意之后", 6 * 7)', plan: ['算个乘法'] })
  const listed = await waitFor(() => sandbox.approvals.list().length > 0)
  assert.ok(listed, '确认台上没有挂起项，弹窗永远不会出现')
  const item = sandbox.approvals.list()[0]
  assert.match(item.code, /6 \* 7/)
  assert.deepEqual(item.plan, ['算个乘法'])
  // 问人的时候必须带上「哪个项目、要干什么」，否则同意的人是在盲签
  assert.equal(item.project, '深蓝鲸')
  assert.equal(item.purpose, '算个乘法')
  assert.ok(item.ref && item.ref.length === 4, '渠道上要有一个能口述的编号')
  const verdict = sandbox.approvals.decide(item.id, { allow: true })
  assert.equal(verdict.ok, true)
  const result = await running
  assert.equal(result.ok, true, result.error)
  assert.match(result.text, /42/)
  const rows = readFileSync(path.join(dir, 'sandbox', 'approvals.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(rows.map((row) => row.decision), ['asked', 'allow'])
  rmSync(dir, { recursive: true, force: true })
})

await check('ask 档：拒绝的理由会回到模型手上，代码一次都没跑', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { mode: 'ask', confirmSeconds: 10 })
  const running = sandbox.run({ code: 'console.log("不该出现")', plan: ['试一下'] })
  assert.ok(await waitFor(() => sandbox.approvals.list().length > 0))
  const item = sandbox.approvals.list()[0]
  sandbox.approvals.decide(item.id, { allow: false, reason: '这段我不想跑' })
  const result = await running
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sandbox_ask')
  assert.match(result.error, /这段我不想跑/)
  // 没跑过：runs.jsonl 里不该有 run 记录，只有一条 deny
  const rows = readFileSync(path.join(dir, 'sandbox', 'runs.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(rows.some((row) => row.kind === 'run'), false)
  assert.equal(rows[0].kind, 'deny')
  rmSync(dir, { recursive: true, force: true })
})

await check('ask 档：勾了「记住拒绝」之后不再弹窗，直接按结论拒绝', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { mode: 'ask', confirmSeconds: 10 })
  const first = sandbox.run({ code: 'console.log(1)', plan: ['第一次'] })
  assert.ok(await waitFor(() => sandbox.approvals.list().length > 0))
  sandbox.approvals.decide(sandbox.approvals.list()[0].id, { allow: false, remember: true, reason: '这台机器别乱跑代码' })
  assert.equal((await first).code, 'sandbox_ask')

  const second = await sandbox.run({ code: 'console.log(2)', plan: ['第二次'] })
  assert.equal(second.code, 'sandbox_ask')
  // 第二次没有弹窗，但必须说清「为什么连问都不问」
  assert.match(second.error, /记住/)
  assert.match(second.error, /这台机器别乱跑代码/)
  assert.equal(sandbox.approvals.list().length, 0, '记住之后不该再有挂起项')
  rmSync(dir, { recursive: true, force: true })
})

await check('桌面端：子进程要以 Node 模式起来，不能拿应用 exe 当 node 用', async () => {
  // 线上真实故障：打包后 process.execPath 是「DeepSeek Harness.exe」。
  // 不带 ELECTRON_RUN_AS_NODE 就直接 spawn，等于再开一个应用实例，
  // 单实例锁让它既不执行也不退出 —— 执行器只能等到 30 秒超时。
  const plan = runnerPlan({ electron: true, env: { DSH_DESKTOP_NODE_EXECUTABLE: 'C:/app.exe' } })
  assert.equal(plan.execPath, 'C:/app.exe')
  assert.equal(plan.asNode, true, '桌面端必须带 ELECTRON_RUN_AS_NODE')
  assert.equal(runnerPlan({ electron: false, execPath: 'C:/node.exe' }).asNode, false, '普通 node 不该带这个开关')

  const dir = makeDir()
  const calls = []
  const runtime = { dir, config: { sandbox: { mode: 'free', timeoutMs: 3000 } }, log: () => {} }
  const sandbox = new Sandbox({
    dir,
    runtime,
    electron: true,
    execPath: 'C:/app.exe',
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts })
      const child = new EventEmitter()
      child.exitCode = null
      child.signalCode = null
      child.kill = () => {}
      setImmediate(() => {
        child.exitCode = 0
        child.emit('exit', 0, null)
      })
      return child
    },
  })
  const result = await sandbox.run({ code: 'console.log(1)', plan: ['跑一下'] })
  assert.equal(result.ok, true, result.error)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cmd, 'C:/app.exe')
  assert.equal(calls[0].opts.env.ELECTRON_RUN_AS_NODE, '1', '环境变量里没有这个开关，子进程会按应用启动')
  rmSync(dir, { recursive: true, force: true })
})

await check('自由档与关闭档都不问：只有「先问我」才弹窗', async () => {
  const dir = makeDir()
  const seen = []
  const free = makeSandbox(dir, { mode: 'free' })
  free.sandbox.approvals.notify = (record) => seen.push(record)
  const ok = await free.sandbox.run({ code: 'console.log(1)', plan: ['随便跑'] })
  assert.equal(ok.ok, true, ok.error)
  assert.equal(free.sandbox.approvals.list().length, 0, '自由档不该挂起任何确认')
  assert.equal(seen.length, 0, '自由档不该去问人')

  const off = makeSandbox(dir, { mode: 'off' })
  off.sandbox.approvals.notify = (record) => seen.push(record)
  assert.equal((await off.sandbox.run({ code: 'console.log(2)', plan: ['不许跑'] })).code, 'sandbox_off')
  assert.equal(seen.length, 0, '关闭档更不该问：问完也是拒绝，只会白等')
  rmSync(dir, { recursive: true, force: true })
})

await check('每小时上限：到了就拒，不让「再跑一次」偷偷溜过去', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { hourlyMax: 1 })
  assert.equal((await sandbox.run({ code: 'console.log(1)', plan: ['第一次'] })).ok, true)
  const second = await sandbox.run({ code: 'console.log(2)', plan: ['第二次'] })
  assert.equal(second.code, 'sandbox_quota_hour')
  rmSync(dir, { recursive: true, force: true })
})

await check('产物：写进 out/ 的文件会被点名，不写进的地方写不了', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir)
  const result = await sandbox.run({ code: 'require("node:fs").writeFileSync("a.csv", "a,b\\n1,2")', plan: ['写个表'] })
  assert.equal(result.ok, true, result.error)
  assert.match(result.text, /产物：a\.csv/)
  assert.equal(result.data.artifacts[0].title, 'a.csv')
  rmSync(dir, { recursive: true, force: true })
})

await check('状态：今天几次、这一小时几次、上次什么结果，都算得出来', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir)
  await sandbox.run({ code: 'console.log(1)', plan: ['一次'] })
  await sandbox.run({ code: 'console.log(2)', plan: ['两次'] })
  const state = sandbox.status()
  assert.equal(state.today, 2)
  assert.equal(state.hour, 2)
  assert.equal(state.last.kind, 'run')
  assert.equal(state.last.ok, true)
  rmSync(dir, { recursive: true, force: true })
})

await check('工具表：exec_sandbox 交给执行器，执行器不在时如实说没接上', async () => {
  const dir = makeDir()
  const { sandbox, runtime } = makeSandbox(dir)
  const tools = createTools({ runtime: { ...runtime, sandbox } })
  const ok = await tools.call('exec_sandbox', { code: 'console.log(2 + 3)', plan: ['算个数'] })
  assert.equal(ok.ok, true, ok.error)
  assert.match(ok.text, /5/)

  const bare = createTools({ runtime: { ...runtime } })
  const missing = await bare.call('exec_sandbox', { code: 'console.log(1)', plan: ['x'] })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'not_wired')
  rmSync(dir, { recursive: true, force: true })
})

await check('模型写 Python：不硬跑，直接说清这里只跑 JavaScript', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir)
  const result = await sandbox.run({ code: 'a = 123\nprint(a * 456)', plan: ['算一下'] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sandbox_lang')
  assert.match(result.error, /JavaScript/)
  assert.match(result.error, /console\.log/)
  rmSync(dir, { recursive: true, force: true })
})

await check('两种写法都认：顶层 import 按 ESM 跑，普通脚本按 CJS 跑', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir)
  const esm = await sandbox.run({ code: "import { join } from 'node:path'\nconsole.log(join('a', 'b'))", plan: ['拼路径'] })
  assert.equal(esm.ok, true, esm.error)
  assert.match(esm.text, /a[\\/]b/)
  const cjs = await sandbox.run({ code: 'x = 6\nconsole.log(x * 7)', plan: ['算一下'] })
  assert.equal(cjs.ok, true, cjs.error)
  assert.match(cjs.text, /42/)
  rmSync(dir, { recursive: true, force: true })
})

await check('源码目录：只读挂进来 —— 能翻自己的实现，改一个字都不行', async () => {
  const dir = makeDir()
  const src = makeDir()
  const file = path.join(src, 'answer.mjs')
  writeFileSync(file, 'export const answer = 42\n')

  const { sandbox } = makeSandbox(dir, {}, src)
  const read = await sandbox.run({
    plan: ['读一份源码'],
    code: `const { readFileSync } = require('node:fs')\nconsole.log(readFileSync(${JSON.stringify(file)}, 'utf8').trim())`,
  })
  assert.equal(read.ok, true, read.error)
  assert.match(read.text, /answer = 42/, '给了 sourceRoot，就要能读')

  const write = await sandbox.run({
    plan: ['试着改源码'],
    code: `const { writeFileSync } = require('node:fs')\ntry { writeFileSync(${JSON.stringify(file)}, 'boom\\n'); console.log('WRITTEN') } catch (e) { console.log('DENIED:' + e.code) }`,
  })
  assert.equal(write.ok, true, write.error)
  assert.match(write.text, /DENIED/, '读权力和写权力必须分开收紧：能看不能改')
  assert.equal(readFileSync(file, 'utf8'), 'export const answer = 42\n', '源码一个字都不能被改动')
  rmSync(dir, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

await check('源码目录没给就是没给：不挂载时依然读不到', async () => {
  const dir = makeDir()
  const src = makeDir()
  writeFileSync(path.join(src, 'secret.mjs'), 'x')
  const { sandbox } = makeSandbox(dir, {})
  const result = await sandbox.run({
    plan: ['读一份外面的源码'],
    code: `const { readFileSync } = require('node:fs')\ntry { console.log('READ:' + readFileSync(${JSON.stringify(path.join(src, 'secret.mjs'))}, 'utf8')) } catch (e) { console.log('DENIED:' + e.code) }`,
  })
  assert.equal(result.ok, true, result.error)
  assert.match(result.text, /DENIED/, 'sourceRoot 为空就不该有任何额外授权')
  rmSync(dir, { recursive: true, force: true })
  rmSync(src, { recursive: true, force: true })
})

await check('工作区：构造时就建出来，不用等到第一次跑代码', () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, {}, '')
  assert.ok(existsSync(sandbox.workspace), '构造完目录就该存在')
  assert.equal(sandbox.status().workspaceReady, true, '状态里要如实说「准备好了」')
  // 以前这个目录从来没人创建，于是读文件的工具永远读一个不存在的路径，
  // 报错还写成「只能读工作目录里的文件」—— 看着像权限问题，其实是没人 mkdir。
  rmSync(dir, { recursive: true, force: true })
})

await check('工作区：能读能写，且写完不会被回收（下一次跑还在）', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, {})
  const file = path.join(sandbox.workspace, 'note.txt')
  const writer = `const fs = require('node:fs')\nfs.writeFileSync(${JSON.stringify(file)}, '留下来')\nconsole.log(fs.readFileSync(${JSON.stringify(file)}, 'utf8'))`

  const first = await sandbox.run({ plan: ['在工作区写个文件'], code: writer })
  assert.equal(first.ok, true, first.error)
  assert.match(first.text, /留下来/)
  assert.equal(readFileSync(file, 'utf8'), '留下来', '内容要真的落在磁盘上')

  const again = await sandbox.run({
    plan: ['把上次写的东西读回来'],
    code: `const fs = require('node:fs')\nconsole.log(fs.readFileSync(${JSON.stringify(file)}, 'utf8'))`,
  })
  assert.equal(again.ok, true, again.error)
  assert.match(again.text, /留下来/, '第二次运行还能读到 —— 这就是「不必每次从零开始」')
  rmSync(dir, { recursive: true, force: true })
})

await check('清理老目录时不会带走正在跑的那一份', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, {})
  const root = path.join(dir, 'sandbox')
  // 预建 45 份「老运行目录」，逼出清理逻辑（KEEP_RUNS 是 40）。
  // 时间戳必须比真实 runId（当前毫秒时间戳，约 1.79e12）**大**：
  // 清理删的是排序后最靠前的那几份，只有这样真正的运行目录才会排在前面被选中 ——
  // 否则这个用例无论有没有保护都会过，等于没测。
  for (let i = 0; i < 45; i += 1) {
    mkdirSync(path.join(root, `s${String(9_000_000_000_000 + i).padStart(13, '0')}-01`), { recursive: true })
  }
  const slow = sandbox.run({
    plan: ['跑慢一点'],
    code: 'const t = Date.now(); while (Date.now() - t < 700) {}\nconsole.log("SLOW_DONE")',
  })
  // 等它真的跑起来，再让另一次运行触发清理
  await new Promise((resolve) => setTimeout(resolve, 150))

  // 断言点选「登记」而不是「目录还在」，是因为后者在本机测不出东西：
  // Windows 上 stdout.log 被父进程 fd 与子进程同时持有，rmSync 删它会 EBUSY 静默失败 ——
  // 于是「没有保护」和「有保护」在这台机器上表现一模一样，用例恒绿。
  // 保护的实质是「清理时知道哪几份在飞」，这个在哪个平台都一样，且能真被断言。
  const inFlight = [...sandbox.active]
  assert.equal(inFlight.length, 1, `在飞应当只有一份，实际 ${inFlight.length} 份`)
  const slowId = inFlight[0]

  const other = await sandbox.run({ plan: ['再跑一次'], code: 'console.log("OTHER")' })
  const slowResult = await slow
  assert.equal(other.ok, true, other.error)
  assert.equal(slowResult.ok, true, `慢的那次不该被清理带走：${slowResult.error}`)
  assert.match(slowResult.text, /SLOW_DONE/, '没有它，前一次会读到空输出并报成「跑完了，没有输出」')
  // 跑完必须注销：漏了会让 active 越攒越多，最后所有目录都被当成「在飞」，清理彻底失效
  assert.equal(sandbox.active.has(slowId), false, '跑完还留在在飞名单里，清理会永久失灵')
  rmSync(dir, { recursive: true, force: true })
})

await check('清理挑的不是在飞的那几份：候选里不能出现在飞目录', () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, {})
  // 直接检验清理的**挑选规则**：这条不依赖能否真删得掉，所以任何平台都成立
  const source = readFileSync(new URL('../ability/sandbox.mjs', import.meta.url), 'utf8')
  assert.match(source, /\.sort\(\)\.filter\(\(name\) => !this\.active\.has\(name\)\)/, '清理必须把在飞的从候选里剔掉')
  assert.match(source, /this\.active\.add\(runId\)\s*\n\s*this\.#prune\(\)/, '必须先登记再清理，顺序反了等于没保护')
  rmSync(dir, { recursive: true, force: true })
})

await check('沙箱整个关掉时：工作区的读写权限也一起收回', async () => {
  const dir = makeDir()
  const { sandbox } = makeSandbox(dir, { mode: 'off' })
  const result = await sandbox.run({ plan: ['试着写'], code: 'console.log(1)' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'sandbox_off')
  rmSync(dir, { recursive: true, force: true })
})

console.log(`\n${failed.length ? '✗' : '✓'} 沙箱用例：${passed} 项通过`)
if (failed.length) {
  for (const { name, error } of failed) console.log(`  ${name}: ${error?.message || error}`)
  process.exit(1)
}
