/**
 * scripts/audit-all.mjs — 一条命令跑完全部对账。
 *
 * 清单在 `truth/audit.mjs`（该查什么），这里只负责「怎么跑」：
 * 逐个 spawn 子进程、失败就停在那一道、最后给一张总表。
 *
 * 为什么不是 npm 的 `a && b && c`：那样失败时只看到第一个非零退出码，
 * 看不到「哪几道过了、哪一道在第几秒炸的」；而且清单会散在 package.json 里，
 * 与 truth/audit.mjs 分叉。
 *
 * 用法：
 *   node scripts/audit-all.mjs                 全部
 *   node scripts/audit-all.mjs --fast          只跑提交前那几道
 *   node scripts/audit-all.mjs --only=layers,ui  指定几道
 *   node scripts/audit-all.mjs --keep-going    失败也继续跑完（默认遇到失败就停）
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDITS } from '../truth/audit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const onlyArg = argv.find((one) => one.startsWith('--only='))
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((one) => one.trim()).filter(Boolean) : null
const fastOnly = argv.includes('--fast')
const keepGoing = argv.includes('--keep-going')

let plan = AUDITS
if (only) plan = plan.filter((one) => only.includes(one.id))
if (fastOnly) plan = plan.filter((one) => one.speed === 'fast')

if (!plan.length) {
  console.error('✗ 没有匹配的对账项')
  process.exit(1)
}

console.log(`对账 ${plan.length} 道（${keepGoing ? '失败继续' : '遇到失败就停'}）\n`)

const results = []
const started = Date.now()

for (const audit of plan) {
  const at = Date.now()
  process.stdout.write(`  … ${audit.label}  `)
  const result = spawnSync(process.execPath, [path.join(ROOT, audit.script), ...audit.args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0' },
  })
  const ms = Date.now() - at
  const out = `${result.stdout || ''}${result.stderr || ''}`.trim()
  const ok = result.status === 0
  results.push({ audit, ok, ms, out })
  process.stdout.write(`${ok ? '✓' : '✗'} ${(ms / 1000).toFixed(1)}s\n`)
  if (!ok) {
    console.error(`\n── ${audit.id}：${audit.proves}\n`)
    console.error(out.split('\n').slice(-25).join('\n'))
    console.error('')
    if (!keepGoing) break
  }
}

const passed = results.filter((one) => one.ok)
const failed = results.filter((one) => !one.ok)
const skipped = plan.length - results.length
const total = ((Date.now() - started) / 1000).toFixed(1)

console.log(`\n${failed.length ? '✗' : '✓'} ${passed.length}/${plan.length} 通过${skipped ? `（${skipped} 道未跑）` : ''}，用时 ${total}s`)
if (failed.length) {
  console.error(`  失败：${failed.map((one) => one.audit.id).join('、')}`)
  process.exit(1)
}
