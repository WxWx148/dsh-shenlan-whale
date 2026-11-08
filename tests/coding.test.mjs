/**
 * 改代码这一层的用例。
 *
 * 这一份测的不是「文件能不能读写」——那是 Node 自己的事，用不着测。
 * 测的是**三条边界有没有真的生效**：
 *   1. 路径出不出插件目录（../ 、绝对路径、盘符都得出不去）；
 *   2. 关键启动文件是不是默认改不了；
 *   3. 每次改写前有没有真的留下能用的备份。
 * 这三条里任何一条失效，「让他/她自己改代码」就从能力变成了事故。
 *
 * 全部用临时目录当「假插件根」，不碰真实源码。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, isProtected, listTree, readSource, resolveInside, restoreBackup, runCommand, searchSource, writeSource } from '../ability/index.mjs'
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

/** 一个假插件目录：有入口、有 lib、有一份普通模块 */
function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'whale-code-'))
  mkdirSync(path.join(root, 'lib'), { recursive: true })
  mkdirSync(path.join(root, 'node_modules'), { recursive: true })
  writeFileSync(path.join(root, 'index.js'), 'export const name = "whale"\n')
  writeFileSync(path.join(root, 'package.json'), '{"name":"whale"}\n')
  writeFileSync(path.join(root, 'lib', 'demo.mjs'), 'export const alpha = 1\n// 一处标记\nexport const beta = 2\n')
  // node_modules 里的同名内容：搜索必须搜不到它，否则一搜全是依赖的噪音
  writeFileSync(path.join(root, 'node_modules', 'junk.mjs'), 'export const alpha = 999\n')
  return root
}

const backups = () => mkdtempSync(path.join(tmpdir(), 'whale-backup-'))

await check('路径不可越界：../、绝对路径、盘符一律出不去', () => {
  const root = makeRoot()
  assert.equal(resolveInside(root, '../outside.txt'), null, '../ 必须出不去')
  assert.equal(resolveInside(root, 'lib/../../../x'), null, '多重 ../ 也要出不去')
  assert.equal(resolveInside(root, 'C:\\Windows\\win.ini'), null, '绝对路径不要')
  assert.equal(resolveInside(root, '\\\\server\\share'), null, 'UNC 不要')
  assert.equal(resolveInside(root, ''), null, '空路径不要')
  const inside = resolveInside(root, 'lib/demo.mjs')
  assert.ok(inside && inside.startsWith(path.resolve(root)), '正常相对路径要能进')
  rmSync(root, { recursive: true, force: true })
})

await check('禁区判定：入口与地基文件一眼在列，普通文件不在', () => {
  const root = makeRoot()
  assert.equal(isProtected(root, path.join(root, 'index.js')), true, 'index.js 是启动入口')
  assert.equal(isProtected(root, path.join(root, 'package.json')), true, 'package.json 改坏就装不上')
  assert.equal(isProtected(root, path.join(root, 'cordis.patch.yml')), true, 'patch 文件改坏宿主加载失败')
  assert.equal(isProtected(root, path.join(root, 'lib', 'runtime.mjs')), true, '运行时是地基')
  assert.equal(isProtected(root, path.join(root, 'lib', 'demo.mjs')), false, '普通模块可以改')
  rmSync(root, { recursive: true, force: true })
})

await check('列目录：node_modules 不出现在结果里', () => {
  const root = makeRoot()
  const result = listTree(root, { path: '.', recursive: 1 })
  assert.equal(result.ok, true)
  assert.ok(result.text.includes('index.js'), '入口要列出来')
  assert.ok(result.text.includes('lib/demo.mjs'), '递归要进到子目录')
  assert.ok(!result.text.includes('node_modules'), '依赖目录必须跳过')
  rmSync(root, { recursive: true, force: true })
})

await check('读源码：带行号，能按段取；整份超出上限要给提示而不是硬读', () => {
  const root = makeRoot()
  const whole = readSource(root, { path: 'lib/demo.mjs' })
  assert.equal(whole.ok, true)
  // 三行内容加一个结尾换行，split 出来是 4 段（末尾空串也算一行）
  assert.equal(whole.data.lines, 4)
  assert.ok(whole.text.includes('   1 |'), '要带行号，模型才知道该改第几行')

  const part = readSource(root, { path: 'lib/demo.mjs', start: 2, count: 1 })
  assert.equal(part.ok, true)
  assert.ok(part.text.includes('一处标记'), '要的是第 2 行')
  assert.ok(!part.text.includes('alpha'), '第 2 段不该带第 1 行')

  const missing = readSource(root, { path: 'lib/nope.mjs' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'missing')

  const outside = readSource(root, { path: '../../etc/passwd' })
  assert.equal(outside.ok, false)
  assert.equal(outside.code, 'outside')
  rmSync(root, { recursive: true, force: true })
})

await check('搜源码：命中行与上下文都回来，依赖目录不被搜出来', () => {
  const root = makeRoot()
  const result = searchSource(root, { keyword: 'alpha' })
  assert.equal(result.ok, true)
  assert.equal(result.data.hits.length, 1, '只该命中 lib/demo.mjs 一处')
  assert.equal(result.data.hits[0].path, 'lib/demo.mjs')
  assert.equal(result.data.hits[0].line, 1)

  const none = searchSource(root, { keyword: '这个词一定不存在zzz' })
  assert.equal(none.ok, false)
  assert.equal(none.code, 'none')

  const empty = searchSource(root, { keyword: '  ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'empty')
  rmSync(root, { recursive: true, force: true })
})

await check('改普通文件：写进去，并且备份先落地', () => {
  const root = makeRoot()
  const backupDir = backups()
  const before = readFileSync(path.join(root, 'lib', 'demo.mjs'), 'utf8')
  const result = writeSource(root, { path: 'lib/demo.mjs', content: 'export const alpha = 42\n', backupDir })
  assert.equal(result.ok, true, result.error)
  assert.equal(readFileSync(path.join(root, 'lib', 'demo.mjs'), 'utf8'), 'export const alpha = 42\n')
  assert.ok(result.data.backup && existsSync(result.data.backup), '必须给出真的存在的备份路径')
  assert.equal(readFileSync(result.data.backup, 'utf8'), before, '备份里得是**改之前**的内容')
  rmSync(root, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

await check('新建文件：目录不存在会先建，且没有备份（本来就没有旧内容）', () => {
  const root = makeRoot()
  const backupDir = backups()
  const result = writeSource(root, { path: 'lib/deep/new.mjs', content: 'export const fresh = 1\n', backupDir })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.data.created, true)
  assert.equal(readFileSync(path.join(root, 'lib', 'deep', 'new.mjs'), 'utf8'), 'export const fresh = 1\n')
  rmSync(root, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

await check('关键启动文件默认改不了，带 force 才放行', () => {
  const root = makeRoot()
  const backupDir = backups()
  const refused = writeSource(root, { path: 'index.js', content: 'boom\n', backupDir })
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'protected')
  assert.equal(readFileSync(path.join(root, 'index.js'), 'utf8'), 'export const name = "whale"\n', '拒绝时一个字都不能动')

  const forced = writeSource(root, { path: 'index.js', content: 'boom\n', backupDir, force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.data.protected, true, '要标注「这次动的是保护名单里的文件」，审计才找得到')
  assert.ok(existsSync(forced.data.backup), 'force 也要备份，风险高才更不能省')
  rmSync(root, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

await check('备份做不出来就别动原文件（不是「照写，然后说没备份」）', () => {
  const root = makeRoot()
  const backupDir = mkdtempSync(path.join(tmpdir(), 'whale-backup-'))
  const file = path.join(root, 'lib', 'demo.mjs')
  const before = readFileSync(file, 'utf8')
  // 把备份目录换成一个**已存在的普通文件**：mkdirSync 会失败，backupTo 只能返回 null
  const blocker = path.join(backupDir, 'taken')
  writeFileSync(blocker, 'x')

  const result = writeSource(root, { path: 'lib/demo.mjs', content: 'export const broken = true\n', backupDir: blocker })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no_backup')
  assert.equal(readFileSync(file, 'utf8'), before, '备份失败时一个字都不许动 —— 否则「改前会备份」就是空话')
  rmSync(root, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

await check('搜索路径不存在：给 missing，不许抛异常冒出去', () => {
  const root = makeRoot()
  const result = searchSource(root, { keyword: 'alpha', path: 'lib/没有这个目录' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'missing', '缺了 existsSync 守卫会变成 statSync 抛 ENOENT，错误码就对不齐了')
  rmSync(root, { recursive: true, force: true })
})

await check('写操作的三道小拒绝：空内容、出界、超大', () => {
  const root = makeRoot()
  const backupDir = backups()
  assert.equal(writeSource(root, { path: 'lib/x.mjs', content: '   ', backupDir }).code, 'empty')
  assert.equal(writeSource(root, { path: '../escape.mjs', content: 'x', backupDir }).code, 'outside')
  const huge = writeSource(root, { path: 'lib/x.mjs', content: 'x'.repeat(500_000), backupDir })
  assert.equal(huge.ok, false)
  assert.equal(huge.code, 'too_big')
  rmSync(root, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

await check('还原：改崩了能把上一次的备份放回去', () => {
  const root = makeRoot()
  const backupDir = backups()
  const file = path.join(root, 'lib', 'demo.mjs')
  const before = readFileSync(file, 'utf8')
  writeSource(root, { path: 'lib/demo.mjs', content: 'export const broken = true\n', backupDir })
  assert.notEqual(readFileSync(file, 'utf8'), before)
  const back = restoreBackup(root, { path: 'lib/demo.mjs', backupDir })
  assert.equal(back.ok, true, back.error)
  assert.equal(readFileSync(file, 'utf8'), before, '还原后必须和改之前一字不差')

  const none = restoreBackup(root, { path: 'lib/index.js', backupDir })
  assert.equal(none.ok, false)
  assert.equal(none.code, 'no_backup')
  rmSync(root, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

await check('跑命令：能真的跑 node，输出原样回来', async () => {
  const root = makeRoot()
  const result = await runCommand(root, { bin: 'node', args: ['-e', 'console.log("hi " + (1+1))'] })
  assert.equal(result.ok, true, result.error)
  assert.ok(result.text.includes('hi 2'), `stdout 要回来，实际：${result.text}`)
  assert.equal(result.data.exit, 0)
  rmSync(root, { recursive: true, force: true })
})

await check('跑命令：白名单外的程序不跑，shell 符号不会被当命令执行', async () => {
  const root = makeRoot()
  const bad = await runCommand(root, { bin: 'powershell', args: ['Remove-Item', '/'] })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'bin')

  const evil = await runCommand(root, { bin: 'node', args: ['-e', 'console.log(1)'] , cwd: root })
  assert.equal(evil.ok, false, 'cwd 给绝对路径（不在插件目录内）要被拒')
  assert.equal(evil.code, 'outside')

  const semi = await runCommand(root, { bin: 'node', args: ['-e', '1', '&& echo hacked'] })
  assert.equal(semi.ok, false)
  assert.equal(semi.code, 'unsafe')
  rmSync(root, { recursive: true, force: true })
})

await check('跑命令：cwd 只能在插件目录里，超时会被掐掉而不是一直等', async () => {
  const root = makeRoot()
  const slow = await runCommand(root, { bin: 'node', args: ['-e', 'while(true){}'], timeoutMs: 1500 })
  assert.equal(slow.ok, false)
  assert.equal(slow.code, 'timeout')
  assert.ok(slow.data.timedOut === true)
  rmSync(root, { recursive: true, force: true })
})

await check('工具档位：off 连看都不给看，read 能看不能改', () => {
  const root = makeRoot()
  const backupDir = mkdtempSync(path.join(tmpdir(), 'whale-tools-'))
  const build = (codeMode) => createTools({ sourceRoot: root, dir: backupDir, runtime: { dir: backupDir, config: { sandbox: { codeMode } }, log: () => {} } })

  const off = build('off')
  assert.equal(off.call('code_read', { path: 'lib/demo.mjs' }).code, 'code_off')
  assert.equal(off.call('code_search', { keyword: 'alpha' }).code, 'code_off')
  assert.equal(off.call('code_write', { path: 'lib/x.mjs', content: 'x' }).code, 'code_off')

  const read = build('read')
  assert.equal(read.call('code_read', { path: 'lib/demo.mjs' }).ok, true)
  assert.equal(read.call('code_search', { keyword: 'alpha' }).ok, true)
  const denied = read.call('code_write', { path: 'lib/demo.mjs', content: 'export const hacked = 1\n' })
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'code_readonly')
  assert.equal(readFileSync(path.join(root, 'lib', 'demo.mjs'), 'utf8').includes('hacked'), false, '拒了就不能落盘')
  rmSync(root, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

await check('工具层：write 档通过 tools.call 走完整一条链路（含备份审计）', () => {
  const root = makeRoot()
  const dataDir = mkdtempSync(path.join(tmpdir(), 'whale-tools-'))
  const logs = []
  const runtime = { dir: dataDir, config: { sandbox: { codeMode: 'write' } }, log: (kind, detail) => logs.push({ kind, detail }) }
  const tools = createTools({ sourceRoot: root, dir: dataDir, runtime })

  assert.equal(tools.has('code_write'), true)
  assert.equal(tools.has('run_command'), true)
  assert.equal(tools.label('code_write'), '改代码')

  const done = tools.call('code_write', { path: 'lib/demo.mjs', content: 'export const alpha = 7\n' })
  assert.equal(done.ok, true, done.error)
  assert.equal(readFileSync(path.join(root, 'lib', 'demo.mjs'), 'utf8'), 'export const alpha = 7\n')
  assert.ok(existsSync(path.join(dataDir, 'backups', 'code')), '备份落在数据目录下，不脏源码树')
  assert.ok(readdirSync(path.join(dataDir, 'backups', 'code')).length >= 1, '至少一份备份')
  assert.ok(logs.some((row) => row.kind === 'code_write'), '改写要进审计，事后才答得出「它动过什么」')
  rmSync(root, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

await check('草稿纸（area=work）：写进去的东西留在工作区，不落在源码树里', () => {
  const root = makeRoot()
  const dataDir = mkdtempSync(path.join(tmpdir(), 'whale-work-'))
  const runtime = { dir: dataDir, config: { sandbox: { codeMode: 'write' } }, log: () => {} }
  const tools = createTools({ sourceRoot: root, dir: dataDir, runtime })
  const workDir = path.join(dataDir, 'sandbox', 'workspace')

  assert.ok(existsSync(workDir), '工具表接上就要有地方放东西')

  const done = tools.call('code_write', { area: 'work', path: 'scratch.mjs', content: 'console.log(1)\n' })
  assert.equal(done.ok, true, done.error)
  assert.equal(readFileSync(path.join(workDir, 'scratch.mjs'), 'utf8'), 'console.log(1)\n')
  assert.equal(existsSync(path.join(root, 'scratch.mjs')), false, '草稿写进源码树里就污染了')

  const back = tools.call('code_read', { area: 'work', path: 'scratch.mjs' })
  assert.equal(back.ok, true, back.error)
  assert.match(back.text, /console\.log\(1\)/)

  const found = tools.call('code_search', { area: 'work', keyword: 'console.log' })
  assert.equal(found.ok, true)
  assert.equal(found.data.hits[0].path, 'scratch.mjs')

  // 不写 area 就是「看源码」这条老路，行为必须和以前完全一样
  const sourceSide = tools.call('code_read', { path: 'lib/demo.mjs' })
  assert.equal(sourceSide.ok, true)
  assert.match(sourceSide.text, /lib\/demo\.mjs/)

  const escaped = tools.call('code_write', { area: 'work', path: '../escape.mjs', content: 'x' })
  assert.equal(escaped.ok, false)
  assert.equal(escaped.code, 'outside', '草稿纸也有边界，不是法外之地')
  rmSync(root, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

await check('describe：把边界讲清楚，面板与排障才不用猜', () => {
  const info = describe(makeRoot())
  assert.ok(info.bins.includes('node'))
  assert.ok(info.protected.length >= 6)
  assert.ok(Array.isArray(info.readableExts) && info.readableExts.includes('.mjs'))
})

await check('npm / npx 真的能跑起来：不能被一行 spawn EINVAL 挡在门外', async () => {
  const root = makeRoot()
  // 这条用例守的是一个「功能整体失效但没人发现」的坑：
  // Node 18.20.2+ 禁止不带 shell 直接 spawn .cmd，npm / npx 于是全部报 EINVAL。
  // 表面看只是「跑命令失败」，实际是「改完代码没法自己跑测试」——这层的一半意义没了。
  for (const bin of ['npm', 'npx']) {
    const result = await runCommand(root, { bin, args: ['--version'], timeoutMs: 60_000 })
    if (!result.ok) {
      // 机器上真的没装 npm（精简版 Node）可以接受，但必须说清是没找到，而不是 EINVAL
      assert.equal(result.code, 'bin_missing', `${bin} 失败时要么跑通，要么说清「找不到入口」，不能是 ${result.code}`)
      assert.ok(String(result.text).includes('cli.js'), '说「找不到入口」时要指出找的是什么')
    } else {
      assert.match(String(result.text), /\d+\.\d+/, `${bin} 要能报出版本号`)
      assert.ok(!/EINVAL/.test(String(result.text)), '不该再出现 spawn EINVAL')
    }
  }
  rmSync(root, { recursive: true, force: true })
})

await check('写源码是原子的：改完不留临时文件残渣，内容一次到位', () => {
  const root = makeRoot()
  const backupDir = backups()
  const result = writeSource(root, { path: 'lib/demo.mjs', content: 'export const alpha = 42\n', backupDir })
  assert.equal(result.ok, true)
  assert.equal(readFileSync(path.join(root, 'lib', 'demo.mjs'), 'utf8'), 'export const alpha = 42\n')
  // 原子写的中间文件必须自己收干净：留一堆 .xxx.tmp 在源码树里，
  // 下次列目录、搜索、跑守卫全都会被它们干扰
  const leftovers = readdirSync(path.join(root, 'lib')).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [], '源码目录里不该留下临时文件')
  rmSync(root, { recursive: true, force: true })
  rmSync(backupDir, { recursive: true, force: true })
})

console.log('')
if (failed.length) {
  console.log(`✗ 改代码用例：${passed} 项通过，${failed.length} 项失败`)
  process.exit(1)
}
console.log(`✓ 改代码用例：${passed} 项通过`)
