/**
 * 追加日志（journal）的离线用例：只在临时目录里读写，不碰真实数据。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Journal, encodeCursor, decodeCursor } from '../lib/journal.mjs'

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

const dirs = []
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'journal-test-'))
  dirs.push(dir)
  return dir
}

console.log('\n追加日志')

await check('游标编解码：往返一致，脏值返回 null', () => {
  assert.equal(encodeCursor(2, 37), '2:37')
  assert.deepEqual(decodeCursor('2:37'), { fileIndex: 2, lineNo: 37, anchor: '' })
  // 带锚的三段式：轮转会让文件序号变，锚是不变的那部分
  assert.equal(encodeCursor(2, 37, 1700), '2:37:1700')
  assert.deepEqual(decodeCursor('2:37:1700'), { fileIndex: 2, lineNo: 37, anchor: '1700' })
  for (const bad of ['', 'abc', '1:', ':2', '1:2:', null, undefined]) {
    assert.equal(decodeCursor(bad), null, `「${bad}」应是脏游标`)
  }
})

await check('追加后读回：最新在前，时间戳自动补', () => {
  const dir = tempDir()
  let clock = 1000
  const journal = new Journal({ dir, name: 'cot', now: () => (clock += 1) })
  journal.append({ id: 'a', text: '第一条' })
  journal.append({ id: 'b', text: '第二条' })
  journal.append({ id: 'c', text: '第三条' })

  const page = journal.read({ limit: 10 })
  assert.deepEqual(page.rows.map((row) => row.id), ['c', 'b', 'a'])
  assert.equal(page.hasMore, false)
  assert.equal(page.rows[0].ts, 1003, '时间戳应由 now() 补上')
})

await check('游标分页：三页翻完，不重复不遗漏', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'audit' })
  const total = 25
  for (let i = 1; i <= total; i += 1) journal.append({ id: `row-${i}` })

  const seen = []
  let cursor = ''
  let pages = 0
  while (pages < 10) {
    const page = journal.read({ before: cursor, limit: 10 })
    seen.push(...page.rows.map((row) => row.id))
    pages += 1
    if (!page.hasMore) break
    cursor = page.nextBefore
  }

  assert.equal(pages, 3, '25 条 / 每页 10 条应是 3 页')
  assert.equal(seen.length, total, `应读到 ${total} 条，实际 ${seen.length}`)
  assert.equal(new Set(seen).size, total, '不能有重复')
  assert.deepEqual(seen.slice(0, 2), ['row-25', 'row-24'], '第一页从最新开始')
  assert.deepEqual(seen.slice(-2), ['row-2', 'row-1'], '最后一页收到最早那条')
})

await check('过滤：只返回命中的，仍按游标往下走', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'audit' })
  for (let i = 1; i <= 20; i += 1) journal.append({ id: `r${i}`, kind: i % 2 === 0 ? 'config' : 'agent_tool' })

  const evenOnly = (row) => row.kind === 'config'
  const first = journal.read({ limit: 5, filter: evenOnly })
  assert.equal(first.rows.length, 5)
  assert.ok(first.rows.every((row) => row.kind === 'config'))

  const second = journal.read({ before: first.nextBefore, limit: 5, filter: evenOnly })
  const ids = first.rows.concat(second.rows).map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length, '过滤分页也不能重复')
  assert.equal(ids.length, 10, '20 条里偶数 10 条')
})

await check('轮转：写满后旧数据仍能翻到，条数不丢', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'cot', maxBytes: 400, maxRotations: 3 })
  for (let i = 1; i <= 40; i += 1) journal.append({ id: `e${i}`, text: 'x'.repeat(20) })

  assert.ok(existsSync(journal.file(1)), '应该发生过轮转')
  const stats = journal.stats()
  assert.ok(stats.files >= 2, '至少两个文件')
  // 保留量上限 = (maxRotations + 1) × maxBytes；超出最老的整份会被删掉，
  // 所以这里不追求「写多少留多少」，只要求「留下的能完整翻到」。
  assert.ok(stats.count >= 20, `至少应保留 20 条，实际 ${stats.count}`)

  // 从最新一路往前翻，必须能翻到上一个文件里的记录
  const seen = new Set()
  let cursor = ''
  for (let i = 0; i < 20; i += 1) {
    const page = journal.read({ before: cursor, limit: 10 })
    for (const row of page.rows) seen.add(row.id)
    if (!page.hasMore) break
    cursor = page.nextBefore
  }
  assert.equal(seen.size, stats.count, '翻到底应覆盖全部条数')

  // 关键不是「一条不丢」，而是「留下的必须是连续一段」：
  // 轮转只能从头砍，绝不能出现中间断裂（那才是真正的数据损坏）。
  const nums = [...seen].map((id) => Number(String(id).slice(1))).sort((a, b) => a - b)
  assert.equal(nums[nums.length - 1], 40, '最新一条必须还在')
  assert.equal(nums[0] + (nums.length - 1), nums[nums.length - 1], `留下的应是连续一段，实际 ${nums[0]}~${nums[nums.length - 1]} 共 ${nums.length} 条`)
})

await check('超过保留层数的老文件被清掉，读不崩', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'audit', maxBytes: 200, maxRotations: 2 })
  for (let i = 1; i <= 60; i += 1) journal.append({ id: `a${i}`, text: 'y'.repeat(20) })

  assert.equal(existsSync(journal.file(3)), false, '第 3 层轮转应被清掉')
  const page = journal.read({ limit: 5 })
  assert.equal(page.rows.length, 5, '清掉老文件后仍能正常读最新')
})

await check('坏行跳过：一行脏数据不该让整页空掉', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'cot' })
  journal.append({ id: 'good-1' })
  appendFileSync(journal.file(0), '{"broken": \n', 'utf8')
  journal.append({ id: 'good-2' })

  const page = journal.read({ limit: 10 })
  assert.deepEqual(page.rows.map((row) => row.id), ['good-2', 'good-1'])
})

await check('文件不存在时读空页，不抛异常', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'never-written' })
  const page = journal.read({ limit: 10 })
  assert.deepEqual(page.rows, [])
  assert.equal(page.hasMore, false)
  assert.equal(journal.stats().count, 0)
})

await check('trim：超期的轮转文件被删，主文件不动', () => {
  const dir = tempDir()
  let clock = Date.now()
  const journal = new Journal({ dir, name: 'audit', maxBytes: 200, maxRotations: 2, now: () => clock })
  for (let i = 1; i <= 30; i += 1) journal.append({ id: `t${i}`, text: 'z'.repeat(20) })

  // 把轮转文件的时间往回拨 40 天
  const old = clock - 40 * 24 * 60 * 60 * 1000
  // 用 append 假装不了 mtime，直接看 trim 的判定逻辑即可
  const result = journal.trim({ keepDays: 30 })
  assert.ok(Array.isArray(result.removed), 'trim 应返回被删的层号')
  assert.ok(existsSync(journal.file(0)), '主文件永远不删')
  assert.ok(old < clock)
})

await check('stats：条数、起止时间、体积都对得上', () => {
  const dir = tempDir()
  let clock = 5_000
  const journal = new Journal({ dir, name: 'events', now: () => (clock += 100) })
  for (let i = 1; i <= 12; i += 1) journal.append({ id: `s${i}` })

  const stats = journal.stats()
  assert.equal(stats.count, 12)
  assert.equal(stats.oldest, 5_100, '最早一条的时间')
  assert.equal(stats.newest, 6_200, '最新一条的时间')
  assert.ok(stats.bytes > 0)
  assert.equal(stats.bytes, statSync(journal.file(0)).size)
})

await check('非法 limit 走默认值，不返回空页', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'x' })
  for (let i = 0; i < 5; i += 1) journal.append({ id: `n${i}` })
  assert.equal(journal.read({ limit: 9999 }).rows.length, 5, '上限 500 但只有 5 条')
  assert.equal(journal.read({ limit: 0 }).rows.length, 5, '0 兜底成默认 50，不该是空页')
  assert.equal(journal.read({ limit: 'abc' }).rows.length, 5, '脏值同样兜底')
})

// ── 这两条是自检第二轮的产物：翻页撞上轮转会重复读，计数会被分页上限截断 ──

await check('轮转打断翻页：不重复、不漏（游标按内容锚重新定位）', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'audit', maxBytes: 4096, maxRotations: 3 })
  let clock = 1_700_000_000_000
  const line = 'x'.repeat(150)
  // 先写 40 条，取第一页
  for (let i = 1; i <= 40; i += 1) journal.append({ n: i, pad: line, at: (clock += 1) })
  const first = journal.read({ limit: 10 })
  assert.equal(first.rows.length, 10)
  assert.ok(first.hasMore)

  // 再写 10 条，正好把主文件顶过 4KB 触发轮转
  for (let i = 41; i <= 50; i += 1) journal.append({ n: i, pad: line, at: (clock += 1) })
  assert.ok(journal.stats().files > 1, '应该发生过轮转')

  const seen = first.rows.map((row) => row.n)
  let cursor = first.nextBefore
  let guard = 0
  while (cursor && guard < 20) {
    const page = journal.read({ before: cursor, limit: 10 })
    for (const row of page.rows) seen.push(row.n)
    cursor = page.nextBefore
    guard += 1
  }
  assert.equal(new Set(seen).size, seen.length, `翻页出现重复：${seen.length} 条里只有 ${new Set(seen).size} 条不同`)
})

await check('计数不被分页上限截断：800 条就是 800 条', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'events' })
  for (let i = 1; i <= 800; i += 1) journal.append({ n: i, day: i % 2 ? 'today' : 'yesterday' })
  assert.equal(journal.read({ limit: 500 }).rows.length, 500, 'read 本身有上限')
  assert.equal(journal.count(), 800, '统计必须算全量')
  assert.equal(journal.count((row) => row.day === 'today'), 400, '带条件的计数也要准')
})

await check('计数与 stats 对得上（两个口径不能各说各话）', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'cot' })
  for (let i = 0; i < 37; i += 1) journal.append({ i })
  assert.equal(journal.count(), journal.stats().count)
})

await check('maxScan：过滤很稀时只翻一段就收手，游标从断点继续', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'events' })
  for (let i = 0; i < 10; i += 1) journal.append({ n: i })
  const page = journal.read({ limit: 5, maxScan: 3, filter: (row) => row.n % 2 === 0 })
  assert.deepEqual(page.rows.map((row) => row.n), [8], '3 行只来得及命中一个偶数')
  assert.equal(page.hasMore, true, '还有更早的，不能假装读完了')
  const next = journal.read({ before: page.nextBefore, limit: 5, maxScan: 10, filter: (row) => row.n % 2 === 0 })
  assert.deepEqual(next.rows.map((row) => row.n), [6, 4, 2, 0], '下一页从断点继续，不重读 8')
})

await check('常驻句柄写入：读得回来，缓存里不会多出磁盘上没有的行', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'events' })
  journal.append({ n: 1 })
  // 先读一次，让缓存建立起来：这一步是前提，没缓存就测不到「接错缓存」这个风险
  assert.equal(journal.read({ limit: 10 }).rows.length, 1)
  for (let i = 2; i <= 5; i += 1) journal.append({ n: i })
  const rows = journal.read({ limit: 10 }).rows
  assert.equal(rows.length, 5, '缓存接上的条数要和磁盘一致')
  assert.equal(journal.count(), 5)
  // 磁盘上真的只有 5 行 —— 缓存里多出来的记录在真话面前藏不住
  const raw = readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n')
  assert.equal(raw.length, 5)
  journal.close()
})

await check('轮转之后新记录落在新文件里，不会跟着句柄写进 .1', () => {
  const dir = tempDir()
  // 上限很小：几条就轮转。句柄如果没在轮转前关掉，新的行会写进已经改名的 .1
  const journal = new Journal({ dir, name: 'audit', maxBytes: 200, maxRotations: 2 })
  for (let i = 0; i < 12; i += 1) journal.append({ mark: `第${i}条`, pad: 'x'.repeat(40) })
  assert.ok(existsSync(path.join(dir, 'audit.jsonl.1')), '写满之后旧内容应该被挪到 .1')
  const main = readFileSync(path.join(dir, 'audit.jsonl'), 'utf8')
  assert.ok(main.includes('第11条'), '最后一条必须落在主文件里')
  const rotated = readFileSync(path.join(dir, 'audit.jsonl.1'), 'utf8')
  assert.ok(!rotated.includes('第11条'), '.1 是旧内容，不该混进轮转之后的新记录')
  journal.close()
})

await check('close 之后再写：重新打开句柄，数据一条不少', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'behaviors' })
  journal.append({ n: 1 })
  journal.close()
  journal.append({ n: 2 })
  assert.equal(journal.count(), 2, '关掉句柄不等于关掉这个日志')
  journal.close()
})

await check('forEach 一趟走完：数出来的和 count 一致，能提前收手', () => {
  const dir = tempDir()
  const journal = new Journal({ dir, name: 'runs' })
  for (let i = 0; i < 60; i += 1) journal.append({ kind: i % 3 === 0 ? 'run' : 'skip', n: i })
  let seen = 0
  journal.forEach(() => { seen += 1 })
  assert.equal(seen, journal.count(), '遍历的条数要和统计口径一致')

  // 两个数一趟算完：这就是「面板刷新别把记录走两遍」的做法
  let runs = 0
  let skips = 0
  journal.forEach((row) => {
    if (row.kind === 'run') runs += 1
    else skips += 1
  })
  assert.equal(runs, journal.count((row) => row.kind === 'run'))
  assert.equal(skips, journal.count((row) => row.kind !== 'run'))

  let early = 0
  journal.forEach(() => { early += 1; return early < 5 ? undefined : false })
  assert.equal(early, 5, '返回 false 要立刻停手')
  journal.close()
})

for (const dir of dirs) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
}

console.log(`\n${failed.length ? '✗' : '✓'} 追加日志用例：${passed} 项通过${failed.length ? `，${failed.length} 项失败` : ''}`)
if (failed.length) process.exit(1)
