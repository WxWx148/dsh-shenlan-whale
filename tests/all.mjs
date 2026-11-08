/**
 * tests/all.mjs — 跑 tests/ 下所有 `*.test.mjs`，一个不漏。
 *
 * 为什么不再在 package.json 里手写一长串：
 * 那个列表是加法，加新用例要记得去改，改了还得保证顺序 —— 而忘了加的表现是
 * 「全绿」，不是「少一条」。这个项目的用例已经 60 多个文件，
 * 「新写的用例没接进 npm test」迟早会发生，且不会有人发现。
 *
 * 现在：扫目录、按名字排序、逐个 spawn。新加一个 `xxx.test.mjs` 自动就跑了。
 * 每个文件仍然独立进程 —— 用例之间不共享内存，一个崩了不会污染下一个。
 *
 * 用法：
 *   node tests/all.mjs              跑全部
 *   node tests/all.mjs turn tools   只跑名字里含 turn / tools 的（调试用）
 */

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const filters = process.argv.slice(2).map((one) => one.toLowerCase())

const files = readdirSync(HERE)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .filter((name) => !filters.length || filters.some((one) => name.toLowerCase().includes(one)))

if (!files.length) {
  console.error('✗ 没找到匹配的用例文件')
  process.exit(1)
}

const failed = []
const started = Date.now()

for (const name of files) {
  const at = Date.now()
  const result = spawnSync(process.execPath, [path.join(HERE, name)], { encoding: 'utf8' })
  const ms = Date.now() - at
  const out = `${result.stdout || ''}${result.stderr || ''}`
  if (result.status === 0) {
    // 每个文件自己会打「✓ …：N 项通过」，这里只回显最后一行结论 + 耗时
    const last = out.trim().split('\n').filter(Boolean).pop() || '通过'
    console.log(`  ✓ ${name.padEnd(32)} ${String(ms).padStart(5)}ms  ${last.slice(0, 40)}`)
  } else {
    failed.push({ name, out })
    console.log(`  ✗ ${name}`)
  }
}

const total = Date.now() - started
console.log(`\n${failed.length ? '✗' : '✓'} 用例 ${files.length - failed.length}/${files.length} 个文件通过（${(total / 1000).toFixed(1)}s）`)
if (failed.length) {
  for (const one of failed) {
    console.error(`\n── ${one.name} ──`)
    console.error(one.out.trim().split('\n').slice(-25).join('\n'))
  }
  process.exit(1)
}
