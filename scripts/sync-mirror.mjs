/**
 * scripts/sync-mirror.mjs — 把 `E:\深蓝鲸`（唯一真源）单向同步到发布镜像。
 *
 * 背景：这个项目有两个目录。`E:\深蓝鲸` 是**唯一真源**（有 git、有 tests/scripts/probes），
 * `E:\深蓝` 是**发布镜像**（给别人看的、能直接装的那一份）。以前两者能各改各的，
 * 于是镜像停在 0.40.0、目录结构还是旧的 `lib/qq/` —— 有人照镜像读代码，读到的
 * 是十版之前的骨架。0.46.0 起只准单向：真源 → 镜像，镜像永远不许反向修改。
 *
 * 同步什么（运行时要用的 + 一份说明）：
 *   index.js / package.json / cordis.patch.yml / LICENSE / 启动NapCat.bat
 *   lib/ + 12 个父模块目录（从 blueprint.PARENTS 派生，不手写清单）
 *   sandbox/（沙箱进程那份脚本）
 *   CHANGELOG.md / ARCHITECTURE.md（读代码的人需要知道为什么长这样）
 *
 * 不同步什么：tests / scripts / probes / .git / 内部工作目录。镜像是给人读和装的，
 * 不是开发用的第二份工作区 —— 真源只有一个，这一点靠「镜像里没有这些目录」来保证。
 *
 * 旧文件怎么办：`lib/` 与父模块目录**整目录替换**（先删后拷），否则改名/搬走的旧文件
 * 会永远留在镜像里，而且看起来完全正常。镜像独有的历史文档先归档再移除，不硬删。
 *
 * 用法：
 *   node scripts/sync-mirror.mjs                    只看差异（不动磁盘）
 *   node scripts/sync-mirror.mjs --write            真的同步
 *   node scripts/sync-mirror.mjs --target=E:\深蓝    换目标
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const write = argv.includes('--write')
const targetArg = argv.find((one) => one.startsWith('--target='))
const TARGET = targetArg ? targetArg.slice('--target='.length) : 'E:\\深蓝'
const ARCHIVE = path.resolve(path.dirname(TARGET), `${path.basename(TARGET)}-archive`)

if (!existsSync(TARGET)) {
  console.error(`✗ 目标不存在：${TARGET}`)
  process.exit(1)
}
if (path.resolve(TARGET) === ROOT) {
  console.error('✗ 目标不能是真源自己')
  process.exit(1)
}

const { PARENTS } = await import(pathToFileURL(path.join(ROOT, 'lib', 'blueprint.mjs')).href)

/** 顶层文件：有就覆盖，没有就跳过（发了版才发现少文件，比多一份旧文件更难查） */
const FILES = ['index.js', 'package.json', 'cordis.patch.yml', 'LICENSE', '启动NapCat.bat', 'CHANGELOG.md', 'ARCHITECTURE.md']
/** 整目录替换：改名/搬走的旧文件必须跟着消失 */
const DIRS = ['lib', 'sandbox', ...PARENTS.map((one) => one.dir).filter((dir) => existsSync(path.join(ROOT, dir)))]

/** 镜像里早就该消失的东西：旧版结构产物与内部文档 */
// 只归档「讲了旧结构、现在会误导人」的文档。README / PUBLISH 留着 ——
// 那是别人第一次打开镜像时看的东西，与代码结构无关。
const STALE = ['dist', 'CONCEPTS.md', 'SCHEME.md', 'UX.md', 'STABILITY-0.42.0.md', 'UPGRADE-0.41.0.md', 'QQ群分享文案.md']
// 镜像里不该有的开发资产。0.40.0 那份镜像带着整套 tests/scripts/probes，
// 但它们引用的是旧 lib/ 路径 —— 留着只会让人在镜像里跑出一堆假失败。
const DEV_LEFTOVERS = ['tests', 'scripts', 'probes']

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function walk(dir, base = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
    else if (entry.isFile()) out.push(rel)
  }
  return out
}

// ── 差异 ────────────────────────────────────────────────────────────
const plan = { same: 0, add: [], change: [], remove: [] }
for (const dir of DIRS) {
  const src = path.join(ROOT, dir)
  const dst = path.join(TARGET, dir)
  const srcFiles = new Set(walk(src))
  const dstFiles = new Set(existsSync(dst) ? walk(dst) : [])
  for (const rel of srcFiles) {
    const full = path.join(src, rel)
    const other = path.join(dst, rel)
    if (!dstFiles.has(rel)) plan.add.push(`${dir}/${rel}`)
    else if (hash(full) !== hash(other)) plan.change.push(`${dir}/${rel}`)
    else plan.same += 1
  }
  for (const rel of dstFiles) if (!srcFiles.has(rel)) plan.remove.push(`${dir}/${rel}`)
}
for (const file of FILES) {
  const src = path.join(ROOT, file)
  if (!existsSync(src)) continue
  const dst = path.join(TARGET, file)
  if (!existsSync(dst)) plan.add.push(file)
  else if (hash(src) !== hash(dst)) plan.change.push(file)
  else plan.same += 1
}

const stalePresent = [...STALE, ...DEV_LEFTOVERS].filter((one) => existsSync(path.join(TARGET, one)))
const srcVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const dstVersion = existsSync(path.join(TARGET, 'package.json'))
  ? JSON.parse(readFileSync(path.join(TARGET, 'package.json'), 'utf8')).version
  : '(无)'

console.log(`真源  ${ROOT}  v${srcVersion}`)
console.log(`镜像  ${TARGET}  v${dstVersion}`)
console.log(`一致  ${plan.same} 个文件；新增 ${plan.add.length} / 变更 ${plan.change.length} / 多余 ${plan.remove.length}`)
if (plan.add.length) console.log(`  新增：${plan.add.slice(0, 6).join('、')}${plan.add.length > 6 ? ` …共 ${plan.add.length}` : ''}`)
if (plan.change.length) console.log(`  变更：${plan.change.slice(0, 6).join('、')}${plan.change.length > 6 ? ` …共 ${plan.change.length}` : ''}`)
if (plan.remove.length) console.log(`  多余（旧版残留，会删）：${plan.remove.slice(0, 6).join('、')}${plan.remove.length > 6 ? ` …共 ${plan.remove.length}` : ''}`)
if (stalePresent.length) console.log(`  该走的旧产物：${stalePresent.join('、')}`)

if (!write) {
  console.log('\n（只看不改。要真同步加 --write）')
  process.exit(0)
}

// ── 归档镜像独有的旧文档，然后同步 ──────────────────────────────────
const stamp = new Date().toISOString().slice(0, 10)
const archiveDir = path.join(ARCHIVE, `mirror-docs-${stamp}`)
const archived = []
for (const one of stalePresent) {
  mkdirSync(archiveDir, { recursive: true })
  renameSync(path.join(TARGET, one), path.join(archiveDir, one))
  archived.push(one)
}
if (archived.length) console.log(`  已归档 ${archived.length} 项到 ${archiveDir}`)

for (const dir of DIRS) {
  const src = path.join(ROOT, dir)
  const dst = path.join(TARGET, dir)
  execFileSync('rm', ['-rf', dst])
  execFileSync('cp', ['-r', src, dst])
}
for (const file of FILES) {
  const src = path.join(ROOT, file)
  if (!existsSync(src)) continue
  if (!statSync(src).isFile()) continue
  copyFileSync(src, path.join(TARGET, file))
}

// 同步完自己复核一遍：镜像里不许出现真源没有的运行时文件
const leftovers = []
for (const dir of DIRS) {
  const srcFiles = new Set(walk(path.join(ROOT, dir)))
  for (const rel of walk(path.join(TARGET, dir))) if (!srcFiles.has(rel)) leftovers.push(`${dir}/${rel}`)
}
if (leftovers.length) {
  console.error(`✗ 同步后仍有 ${leftovers.length} 个多余文件：${leftovers.slice(0, 8).join('、')}`)
  process.exit(1)
}

console.log(`\n✓ 镜像已更新到 v${srcVersion}（${DIRS.length} 个目录 / ${FILES.length} 个文件）`)
console.log('  镜像里的 git 提交请单独做：cd 到镜像目录 commit 一次')
