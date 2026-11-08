/**
 * scripts/dump-manifest.mjs — 把「能改什么 / 能看什么」导成一份快照。
 *
 * 用途有三个，都不是「给人看着玩」：
 *   1. 发版前存档：两份快照 diff 为空 = 这一版没动用户的可见面；
 *   2. 面板「关于」页直接读它，避免界面自己拼一份；
 *   3. `--check` 进 CI：三份真源对不上就红，而不是等用户发现「改了没反应」。
 *
 * 用法：
 *   node scripts/dump-manifest.mjs           打到 stdout（JSON）
 *   node scripts/dump-manifest.mjs --out=x.json
 *   node scripts/dump-manifest.mjs --check   只跑对账，不打印快照
 *   node scripts/dump-manifest.mjs --brief   一行摘要（提交信息/日志用）
 */

import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifest } from '../truth/manifest.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const snapshot = manifest()

if (argv.includes('--check')) {
  if (!snapshot.check.ok) {
    console.error('✗ 三份真源对不上：')
    for (const problem of snapshot.check.problems) console.error('  - ' + problem)
    process.exit(1)
  }
  const { keys, items, groups, pages } = snapshot.check.counts
  console.log(`✓ 清单对账：${keys} 个配置键 / ${items} 个面板项 / ${groups} 个分组 / ${pages} 个页面，无缺口`)
  process.exit(0)
}

if (argv.includes('--brief')) {
  const { counts } = snapshot.derive
  console.log(`${counts.total} 项面板（可改 ${counts.editable}）· ${snapshot.check.counts.keys} 个配置键 · ${snapshot.check.counts.pages} 页`)
  process.exit(0)
}

const outArg = argv.find((one) => one.startsWith('--out='))
const text = JSON.stringify(snapshot, null, 2)

if (outArg) {
  const file = path.resolve(ROOT, outArg.slice('--out='.length))
  writeFileSync(file, text + '\n', 'utf8')
  console.log(`✓ 已写入 ${path.relative(ROOT, file)}`)
  if (!snapshot.check.ok) {
    console.error('⚠ 快照里有对不上的地方（见 check.problems）')
    process.exit(1)
  }
} else {
  console.log(text)
}
