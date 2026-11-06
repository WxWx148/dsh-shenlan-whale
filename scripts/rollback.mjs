/**
 * 回滚工具 —— 让「可以回滚」这句话能被验证，而不是一句安慰。
 *
 * 自检发现的每类 bug 都可能把人带进一个更差的版本。所以每修完一轮就存一个快照，
 * 并且**验证这个快照真的能退回去跑通**：退不回去的快照等于没有。
 *
 * 用法：
 *   node scripts/rollback.mjs list                 看有哪些回滚点
 *   node scripts/rollback.mjs verify               逐个校验（复制到临时目录跑全量测试）
 *   node scripts/rollback.mjs verify r1-xxx        只校验一个
 *   node scripts/rollback.mjs restore r1-xxx --yes 真的退回去（会覆盖 lib / tests / package.json）
 *
 * 为什么校验要复制到临时目录：直接在当前目录跑，等于用「回滚后的代码」去跑
 * 「回滚前的测试」以外的所有东西，还会被 .snapshots 干扰。隔离着跑才说明问题。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SNAP_DIR = path.join(ROOT, '.snapshots')
// index.js 与 cordis.patch.yml 也是运行必须的：少了它们，退回去的版本装不上
const RESTORE_ITEMS = ['lib', 'scripts', 'tests', 'probes', 'package.json', 'index.js', 'cordis.patch.yml']

function snapshots() {
  if (!existsSync(SNAP_DIR)) return []
  return readdirSync(SNAP_DIR)
    .filter((name) => {
      // 下划线开头的是工具自己的东西（比如 _rollback-backups），不是回滚点。
      // 不排除的话，它会出现在列表里被当成一个可以退回去的版本。
      if (name.startsWith('_')) return false
      try {
        return statSync(path.join(SNAP_DIR, name)).isDirectory()
      } catch {
        return false
      }
    })
    .sort()
}

/**
 * 自己走目录复制，不用 fs.cpSync：
 * 实测 cpSync 在本机会让进程静默中止（退出码 127、没有任何报错），
 * 排查成本极高；递归 copyFile 慢一点但行为确定。
 *
 * 必须同时支持**单个文件**：快照里既有目录（lib / tests），也有文件（package.json）。
 * 早先只写了目录分支，还原到 package.json 时先 mkdir 出一个同名空目录、再 readdir 崩掉，
 * 结果是 package.json 被删成空目录 —— 回滚工具自己把工程弄坏了。
 * 这个坑只有真正跑一次 restore 才会踩到，verify 永远发现不了。
 */
function copyTree(from, to) {
  if (existsSync(from) && statSync(from).isFile()) {
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(from, to)
    return
  }
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else copyFileSync(src, dest)
  }
}

function countFiles(dir) {
  let total = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(current, entry.name))
      else total += 1
    }
  }
  try {
    walk(dir)
  } catch {}
  return total
}

function command(name) {
  return String(name || '').trim()
}

const [action = 'list', target, ...flags] = process.argv.slice(2)
const all = snapshots()

if (action === 'list') {
  if (!all.length) {
    console.log('还没有快照。修完一轮 bug 后：cp -r lib scripts tests package.json .snapshots/<名字>/')
    process.exit(0)
  }
  console.log(`回滚点（${all.length} 个）：`)
  for (const name of all) {
    const dir = path.join(SNAP_DIR, name)
    const files = countFiles(dir)
    let stamp = ''
    try {
      const pkg = path.join(dir, 'package.json')
      if (existsSync(pkg)) stamp = ` v${JSON.parse(readFileSync(pkg, 'utf8')).version}`
    } catch {}
    console.log(`  ${name.padEnd(28)} ${String(files).padStart(3)} 个文件${stamp}`)
  }
  process.exit(0)
}

if (action === 'verify') {
  const targets = target ? [target] : all
  if (!targets.length) {
    console.log('没有可校验的快照')
    process.exit(1)
  }
  let bad = 0
  for (const name of targets) {
    const dir = path.join(SNAP_DIR, name)
    if (!existsSync(dir)) {
      console.log(`✗ ${name}：没有这个回滚点`)
      bad += 1
      continue
    }
    const work = mkdtempSync(path.join(tmpdir(), `rollback-${name}-`))
    try {
      copyTree(dir, work)
      const result = spawnSync('npm', ['test'], { cwd: work, shell: true, encoding: 'utf8' })
      const output = `${result.stdout || ''}${result.stderr || ''}`
      const passed = (output.match(/✓/g) || []).length
      if (result.status === 0) {
        console.log(`✓ ${name}：退回去能跑通（${passed} 个 ✓）`)
      } else {
        bad += 1
        console.log(`✗ ${name}：退回去跑不通`)
        const tail = output.trim().split('\n').slice(-8).join('\n')
        console.log(tail.replace(/^/gm, '    '))
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  console.log(bad ? `\n✗ ${bad} 个回滚点不可用` : `\n✓ ${targets.length} 个回滚点全部可用`)
  process.exit(bad ? 1 : 0)
}

if (action === 'restore') {
  if (!target || !existsSync(path.join(SNAP_DIR, target))) {
    console.log(`没有这个回滚点：${target || '(空)'}`)
    process.exit(1)
  }
  if (!flags.includes('--yes')) {
    console.log(`这会覆盖 lib / scripts / tests / package.json，当前内容将被 ${target} 替换。`)
    console.log('确认要退，就在命令末尾加 --yes。')
    process.exit(1)
  }
  const dir = path.join(SNAP_DIR, target)
  let ok = 0
  for (const item of RESTORE_ITEMS) {
    const from = path.join(dir, item)
    if (!existsSync(from)) continue
    const to = path.join(ROOT, item)
    // 先备份当前，再覆盖：回滚本身也可能是错的，得能再退回来。
    // 备份必须放进 .snapshots 里，不能扔在工程根 ——
    // 扔在根上的话，`scripts.before-rollback-*` 会被文案守卫与归属守卫当成源码扫，
    // 于是「回滚一次」就等于「工程里多两份违规代码」。这个坑是真踩过的。
    if (existsSync(to)) {
      const keep = path.join(SNAP_DIR, '_rollback-backups', `${path.basename(to)}-${Date.now()}`)
      try {
        mkdirSync(path.dirname(keep), { recursive: true })
        copyTree(to, keep)
      } catch {}
    }
    rmSync(to, { recursive: true, force: true })
    copyTree(from, to)
    ok += 1
  }
  writeFileSync(path.join(ROOT, '.snapshots', 'LAST-ROLLBACK.txt'), `${target} @ ${new Date().toISOString()}\n`, 'utf8')
  console.log(`✓ 已回滚到 ${target}（${ok} 项）。当前状态另存在 .snapshots/_rollback-backups/，回滚错了还能再退回来。`)
  process.exit(0)
}

console.log(`不认识的命令：${command(action)}`)
console.log('可用：list / verify / restore')
process.exit(1)
