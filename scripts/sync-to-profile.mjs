/**
 * scripts/sync-to-profile.mjs — 把 `D:\dsh-shenlan-whale` 的源码同步到宿主真正加载的那份副本。
 *
 * 为什么需要它（踩过一次的坑）：
 *   profile 的依赖写的是 `"dsh-shenlan-whale": "file:D:/dsh-shenlan-whale"`，
 *   pnpm 对 `file:` 依赖是**复制**，不是软链接。于是宿主加载的是
 *   `~/.dsh/profiles/<profile>/node_modules/dsh-shenlan-whale` 这一份快照。
 *   改 `D:\dsh-shenlan-whale` 改得再多，界面一个字都不动 —— 重启多少次都没用，
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
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.dirname(HERE)
const DSH = path.join(homedir(), '.dsh')
const PROFILES = path.join(DSH, 'profiles')
const NAME = 'dsh-shenlan-whale'

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
 * 源码树里的所有文件（相对路径，排序后）。
 *
 * 只以源码清单为准：副本里宿主自己生成的东西（沙箱产物、状态标记）不参与比对，
 * 否则每次都会「不一致」，白复制一遍。
 */
/**
 * 不参与同步的目录。
 *
 * `_archive` 是本地归档（历史备份、老工作副本，几十 MB）：它是给人查的，
 * 不是给宿主加载的。同步进去只会让副本变胖，还会让每次 check 都算一遍大文件哈希。
 *
 * `.snapshots` 同理，而且更该排除：那是回滚点（每轮存一份 lib/tests/index.js 的完整副本），
 * 十几 MB。它只服务「改坏了能退回去」这件事，宿主一个字节都用不到。
 * 实测漏排一次：副本从 2.0 MB 涨到 14.9 MB，涨的全是回滚点。
 */
const SKIP = new Set(['node_modules', '.git', '_archive', '.snapshots'])

function listFiles(root, base = '', out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) listFiles(path.join(root, entry.name), rel, out)
    else out.push(rel)
  }
  return out
}

/**
 * 同一份文件清单，在两个目录里各算一次内容摘要。
 *
 * 为什么不再只比几个关键文件的**大小**：改的是 `lib/client.js`（前端），
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
  console.log(`  一致：${same ? '是' : '否 ← 界面会停在旧版本上'}`)

  if (same) continue
  bad += 1
  if (checkOnly) continue

  // 逐项同步：lib / scripts / tests / probes 与根目录的文件。
  // 副本里多出来的文件（宿主生成的）留着不动。
  for (const entry of readdirSync(PLUGIN_ROOT, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    try {
      mirror(path.join(PLUGIN_ROOT, entry.name), path.join(dir, entry.name))
    } catch (error) {
      console.log(`  ✗ 同步失败 ${entry.name}：${error?.message || error}`)
    }
  }
  // 源码里删掉的文件，副本里也要跟着删（只处理 lib 一级，避免误伤）
  try {
    const gone = readdirSync(path.join(dir, 'lib')).filter((name) => !existsSync(path.join(PLUGIN_ROOT, 'lib', name)))
    for (const name of gone) rmSync(path.join(dir, 'lib', name), { recursive: true, force: true })
    if (gone.length) console.log(`  清掉源码里已删除的：${gone.join('、')}`)
  } catch {}

  const now = fingerprint(dir, files)
  console.log(`  同步后：${now === mine ? '一致 ✓' : '仍不一致 ✗'}（副本 v${versionOf(dir)}）`)
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
