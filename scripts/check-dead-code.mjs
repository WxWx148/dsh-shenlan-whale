/**
 * scripts/check-dead-code.mjs — 这份文件管「哪些公开的名字其实没人用」。
 *
 * 为什么需要它：
 *   一个模块导出十个名字，实际只有两个被外面用到，剩下八个就成了「公开面」——
 *   以后谁都不敢改它们，因为「看起来有人在用」。代码就这样越养越沉。
 *
 * 这里只做两件事，都很保守：
 *   1. **死导出**：在 lib/scripts/tests/probes 里一次都没出现过的导出名；
 *   2. **自用导出**：只在自己文件里出现的导出名（收成普通 const/function 就行）。
 *
 * 保守在哪：只要任一文件里出现过这个名字（哪怕在注释或字符串里）就不算死。
 * 宁可漏报，不要让人去删一个其实在用的东西。
 *
 * 退出码永远 0：这不是错误，是可优化空间的度量。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const SCAN_DIRS = ['lib', 'scripts', 'tests', 'probes']
const SKIP_DIRS = new Set(['node_modules', '.git', '.snapshots', '.work', 'plugin-backups', 'dist', 'coverage'])

function walk(dir, out = []) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

/** 一个文件里声明了哪些导出 */
function exportsOf(text) {
  const names = []
  const re = /^export\s+(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm
  let match
  while ((match = re.exec(text))) names.push(match[1])
  // export { a, b as c }
  const re2 = /^export\s*\{([^}]*)\}/gm
  while ((match = re2.exec(text))) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop().trim()
      if (name) names.push(name)
    }
  }
  return names
}

export function scanDeadCode(root = ROOT) {
  const files = SCAN_DIRS.flatMap((dir) => walk(path.join(root, dir)))
  // 根目录的 index.js 是宿主入口：它 import 的名字当然算「有人在用」。
  // 不把它算进来，workspaceOf 这种只被入口用一次的导出会永远挂在死导出里，
  // 报久了就没人看了 —— 一条永久误报会让整份报告失去意义。
  try {
    const entry = path.join(root, 'index.js')
    if (statSync(entry).isFile()) files.push(entry)
  } catch {}
  const sources = files.map((file) => ({
    file,
    rel: path.relative(root, file).replace(/\\/g, '/'),
    text: readFileSync(file, 'utf8'),
  }))

  const libFiles = sources.filter((s) => s.rel.startsWith('lib/'))
  const rows = []

  for (const source of libFiles) {
    for (const name of exportsOf(source.text)) {
      // 数一下这个名字在别处出现几次（全词匹配）
      const re = new RegExp(`\\b${name}\\b`, 'g')
      let outside = 0
      let inside = 0
      for (const other of sources) {
        const hits = (other.text.match(re) || []).length
        if (other.rel === source.rel) inside = hits
        else outside += hits
      }
      rows.push({
        name,
        file: source.rel,
        outside,
        // 声明本身算一次，所以自己文件里 >1 表示「除了声明还用过」
        selfUses: Math.max(0, inside - 1),
        dead: outside === 0 && Math.max(0, inside - 1) === 0,
        selfOnly: outside === 0 && Math.max(0, inside - 1) > 0,
      })
    }
  }

  return {
    files: sources.length,
    rows: rows.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)),
    dead: rows.filter((r) => r.dead),
    selfOnly: rows.filter((r) => r.selfOnly),
  }
}

function main() {
  const report = scanDeadCode()
  console.log(`公开面审计：${report.files} 个源文件，${report.rows.length} 个导出`)
  console.log(`  死导出 ${report.dead.length} 个（声明了，全工程没人用）`)
  console.log(`  自用导出 ${report.selfOnly.length} 个（只在本文件用，收成私有即可）`)

  if (report.dead.length) {
    console.log('\n死导出：')
    for (const row of report.dead) console.log(`  ${row.file} → ${row.name}`)
  }
  if (report.selfOnly.length) {
    console.log('\n自用导出（可以收掉 export）：')
    for (const row of report.selfOnly) console.log(`  ${row.file} → ${row.name}（本文件用了 ${row.selfUses} 次）`)
  }
  if (!report.dead.length && !report.selfOnly.length) console.log('\n公开面没有多余名字。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
void statSync
