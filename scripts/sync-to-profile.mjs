/**
 * scripts/sync-to-profile.mjs — 把 `E:\深蓝鲸` 的源码同步到宿主真正加载的那份副本。
 *
 * 为什么需要它（踩过一次的坑）：
 *   profile 的依赖写的是 `"dsh-shenlan-whale": "file:E:/深蓝鲸"`，
 *   pnpm 对 `file:` 依赖是**复制**，不是软链接。于是宿主加载的是
 *   `~/.dsh/profiles/<profile>/node_modules/dsh-shenlan-whale` 这一份快照。
 *   改 `E:\深蓝鲸` 改得再多，界面一个字都不动 —— 重启多少次都没用，
 *   因为重启只是重新加载那份 01:37 的旧快照。
 *
 * 所以改完源码必须同步一次，再重启宿主。这个脚本就是把这件事做成一条命令，
 * 顺带报告「副本现在和源码差多少」—— 不同步的话，界面永远停在旧版本上。
 *
 * 用法：node scripts/sync-to-profile.mjs [--check]
 *   --check   只比对不复制（退出码 1 = 不一致，需要先同步）
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.dirname(HERE)
const DSH = path.join(homedir(), '.dsh')
const PROFILES = path.join(DSH, 'profiles')
const NAME = 'dsh-shenlan-whale'

// 部署清单从结构派生，而不是手抄一份目录名
const { PARENTS } = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'blueprint.mjs')).href)

/** 宿主实际加载的副本们（可能不止一个 profile） */
function copiesOf() {
  const out = []
  if (!existsSync(PROFILES)) return out
  for (const profile of readdirSync(PROFILES)) {
    const dir = path.join(PROFILES, profile, 'node_modules', NAME)
    if (existsSync(dir)) out.push({ profile, dir })
  }
  return out
}

/**
 * 部署清单：宿主真正会加载/用到的东西。
 *
 * 以前是全量复制，副本 2.5 MB 里有一半是开发资产（tests / scripts / probes / docs）。
 * 宿主一个字节都用不到它们，却要跟着每次同步算哈希、占磁盘，升级包也被撑大。
 * 现在只部署运行时要用的文件；开发资产留在源码树里，`npm test` 照跑。
 *
 * 新增运行时文件时记得加进来 —— 漏了的表现是「源码改了、宿主还是旧行为」。
 */
const DEPLOY = new Set([
  'index.js',
  'lib',
  'package.json',
  'cordis.patch.yml',
  'LICENSE',
  '启动NapCat.bat',
  // 父模块目录跟着结构走：blueprint 里声明过、目录也确实存在，就必须部署。
  //
  // 以前这里是手写的六项，P1 把 core/journal 搬进 base/ 之后没人回来加这一行 ——
  // 副本里于是只有 lib/，宿主加载 app/runtime.mjs 时直接
  // ERR_MODULE_NOT_FOUND base/core.mjs，整个插件起不来。
  // 手写清单的问题不在于"会忘"，而在于**忘了没人能发现**：fingerprint 只比清单内的文件，
  // 缺一整个目录它照样说"一致"。所以清单改成派生，并且下面加了一道图完整性自检。
  ...PARENTS.map((one) => one.dir).filter((dir) => existsSync(path.join(PLUGIN_ROOT, dir))),
])

/** 副本里不该有的开发资产；同步时清掉，避免旧版本留下的垃圾继续占地方。 */
const DEV_ONLY = new Set([
  'tests', 'scripts', 'probes', 'docs', 'sandbox',
  '_archive', '.snapshots', 'node_modules', '.git',
  'CONCEPTS.md', 'SCHEME.md', 'UX.md', 'CHANGELOG.md', 'README.md',
  'OPTIMIZE.md', 'PARITY.md', 'PLAN.md', 'REWRITE.md', 'ARCHIVE.md',
])

function listFiles(root, base = '', out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!base && !DEPLOY.has(entry.name)) continue
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) listFiles(path.join(root, entry.name), rel, out)
    else out.push(rel)
  }
  return out
}

/**
 * 同一份文件清单，在两个目录里各算一次内容摘要。
 *
 * 为什么不再只比几个关键文件的**大小**：改的是 `lib/client.panel.js`（前端），
 * 它不在旧的那五个 key 里，于是脚本判「一致」→ 直接 continue →
 * 一个字都没复制。表现和「副本落后」一模一样：代码改了，界面不动。
 * 大小相同、内容不同的情况（等长替换）同样骗得过它，所以这里用内容哈希。
 */
function fingerprint(dir, files) {
  const hash = createHash('sha1')
  for (const rel of files) {
    hash.update(rel).update('\u0000')
    try {
      hash.update(readFileSync(path.join(dir, rel)))
    } catch {
      hash.update('\u0000missing')
    }
    hash.update('\u0000')
  }
  return `${files.length}:${hash.digest('hex')}`
}

function versionOf(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).version
  } catch {
    return '?'
  }
}

/**
 * 把 from 覆盖到 to（目录就递归）。
 *
 * 为什么不用 `cpSync`：这台机器上它两处都不靠谱 ——
 *   1. 对**文件**源传 `recursive: true`，会在 "\\?\" 长路径下报 ENOENT；
 *   2. 它带 force 时是「先删目标再复制」，一旦中途失败，目标就留在**已删**状态。
 *      同步 index.js 出过一次：副本里的 index.js 直接没了，宿主加载时起不来 ——
 *      比不同步严重得多。
 *   3. 对目录递归时进程会直接死掉（退出码 127），连 catch 都来不及。
 * 自己走 copyFileSync + mkdirSync 是覆盖写，没有「删了没写回」的中间态，也不会崩。
 */
function mirror(from, to) {
  const stat = statSync(from)
  if (stat.isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      mirror(path.join(from, entry.name), path.join(to, entry.name))
    }
    return
  }
  copyFileSync(from, to)
}

/**
 * 副本里比源码多出来的条目（源码已删、副本还留着）。
 *
 * 为什么必须查：`fingerprint` 只遍历**源码清单**，清单外的旧文件它一个都看不见。
 * 于是 sync 报「一致 ✓」，而 build-info 用包含副本全量的指纹报 `same:false`，
 * 面板上一直挂着「源码比副本新」，用户每次都被叫去同步一个已经同步过的版本。
 * 这类残留还会被模块图扫到、被误 import，属于「少扫一个目录不报错」的同一类病。
 */
function staleIn(from, to, base = '', out = []) {
  if (!existsSync(to)) return out
  for (const entry of readdirSync(to, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    const source = path.join(from, entry.name)
    if (!existsSync(source)) {
      out.push(rel)
      continue
    }
    if (entry.isDirectory()) staleIn(source, path.join(to, entry.name), rel, out)
  }
  return out
}

/** 整棵目录的实际体积，用来报告同步前后差多少。 */
function treeSize(dir) {
  let sum = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sum += treeSize(full)
    else {
      try { sum += statSync(full).size } catch {}
    }
  }
  return sum
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`

import { brokenImports } from '../app/index.mjs'

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')

let bad = 0
const targets = copiesOf()

if (!targets.length) {
  console.log(`✗ 没找到宿主加载的副本（${PROFILES}/*/node_modules/${NAME}）`)
  console.log('  插件可能没装进 profile，先跑一次 dsh 的插件安装')
  process.exit(1)
}

for (const { profile, dir } of targets) {
  const files = listFiles(PLUGIN_ROOT)
  const mine = fingerprint(PLUGIN_ROOT, files)
  const theirs = fingerprint(dir, files)
  const same = mine === theirs
  console.log('')
  console.log(`profile ${profile}`)
  console.log(`  源码  ${PLUGIN_ROOT}  v${versionOf(PLUGIN_ROOT)}`)
  console.log(`  副本  ${dir}  v${versionOf(dir)}`)
  const brokenNow = brokenImports(dir)
  // 指纹只看源码清单，副本里的旧残留它看不见；单独列出来。
  const staleNow = []
  for (const name of DEPLOY) {
    const from = path.join(PLUGIN_ROOT, name)
    const to = path.join(dir, name)
    try {
      if (existsSync(from) && statSync(from).isDirectory()) staleNow.push(...staleIn(from, to))
    } catch {}
  }
  console.log(`  一致：${same ? '是' : '否 ← 界面会停在旧版本上'}${staleNow.length ? '｜多出 ' + staleNow.length + ' 个残留文件' : ''}${brokenNow.length ? '｜模块图断 ' + brokenNow.length + ' 处 ← 起不来' : ''}`)
  if (brokenNow.length && checkOnly) {
    for (const one of brokenNow.slice(0, 8)) console.log(`    ✗ ${one}`)
  }
  if (staleNow.length && checkOnly) {
    for (const one of staleNow.slice(0, 8)) console.log(`    ✗ 源码里已没有：${one}`)
  }

  // 注意：这里不能只按 same 跳过。指纹只比清单内的文件，
  // 清单漏了目录时 same 仍然为 true，但副本根本跑不起来；残留文件同理。
  if (same && !brokenNow.length && !staleNow.length) continue
  bad += 1
  if (checkOnly) continue

  // 只同步运行时文件：index.js / lib / package.json / cordis.patch.yml / LICENSE / 启动脚本。
  // 副本里多出来的开发资产（旧版本留下的 tests / scripts / docs）一并清掉。
  const before = treeSize(dir)
  let copied = 0
  for (const name of DEPLOY) {
    const from = path.join(PLUGIN_ROOT, name)
    const to = path.join(dir, name)
    if (!existsSync(from)) {
      try { rmSync(to, { recursive: true, force: true }) } catch {}
      continue
    }
    try {
      mirror(from, to)
      copied += 1
      // 目录类条目同步后清掉源码里已经删掉的文件；只清部署面，不碰副本外的目录。
      if (statSync(from).isDirectory()) {
        const gone = staleIn(from, to)
        for (const rel of gone) {
          try { rmSync(path.join(to, rel), { recursive: true, force: true }) } catch {}
        }
        if (gone.length) console.log(`  清掉源码里已删除的：${gone.join('、')}`)
      }
    } catch (error) {
      console.log(`  ✗ 同步失败 ${name}：${error?.message || error}`)
    }
  }
  for (const name of DEV_ONLY) {
    const target = path.join(dir, name)
    if (!existsSync(target)) continue
    try { rmSync(target, { recursive: true, force: true }) } catch {}
  }
  const after = treeSize(dir)
  console.log(`  部署 ${copied} 项；副本 ${mb(before)} → ${mb(after)}`)

  const now = fingerprint(dir, files)
  const brokenAfter = brokenImports(dir)
  console.log(`  同步后：${now === mine ? '一致 ✓' : '仍不一致 ✗'}（副本 v${versionOf(dir)}，${files.length} 个运行时文件）`)
  if (brokenAfter.length) {
    console.log(`  ✗ 模块图仍断 ${brokenAfter.length} 处 —— 宿主会加载失败：`)
    for (const one of brokenAfter.slice(0, 8)) console.log(`    ✗ ${one}`)
    bad += 1
  }
}

console.log('')
if (checkOnly) {
  if (bad) {
    console.log(`✗ 有 ${bad} 份副本落后于源码：先跑 node scripts/sync-to-profile.mjs，再重启 DeepSeek Harness`)
    process.exit(1)
  }
  console.log('✓ 宿主加载的副本与源码一致')
  process.exit(0)
}

console.log('同步完成。**必须重启 DeepSeek Harness** —— 进程内存里还是旧模块。')
