/**
 * 归属守卫：全仓不允许出现旧署名。命中即失败，挂进 npm test。
 * 自己这个文件里的模式串不算（按文件名跳过）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SELF = fileURLToPath(import.meta.url)
// .snapshots / .work 是自检快照与临时副本，扫进去等于「一备份就报错」
const SKIP_DIRS = new Set(['node_modules', '.git', 'plugin-backups', 'sandbox', 'webui-dist', '.snapshots', '.work', 'probes', '_archive'])

/**
 * 文件级豁免：`identity-guard: ignore`
 *
 * 只有迁移/归档记录该用它 —— 那类文档必须写出旧包名（回滚命令要用），
 * 藏起来反而没法照着操作。除此之外一律不许豁免：署名清理是硬要求，
 * 一旦允许随手豁免，这个守卫就等于没有。
 */
const EXEMPT = /identity-guard:\s*ignore/
const EXTS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.html', '.css', '.txt'])

// 用编码拼出来，避免本文件自身被扫中
const BANNED = [String.fromCharCode(120, 105, 110, 103, 122, 104, 117), '星' + '竹', '归属：', '归属:']

const hits = []
let scanned = 0

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      walk(full)
      continue
    }
    if (!EXTS.has(extname(name).toLowerCase())) continue
    if (full === SELF) continue
    const head = readFileSync(full, 'utf8').slice(0, 2000)
    if (EXEMPT.test(head)) continue
    scanned += 1
    const text = readFileSync(full, 'utf8')
    for (const word of BANNED) {
      if (!text.includes(word)) continue
      const line = text.split('\n').findIndex((l) => l.includes(word)) + 1
      hits.push({ file: full.slice(ROOT.length + 1), line, word })
    }
  }
}

walk(ROOT)

if (hits.length) {
  console.error(`✗ 发现旧署名 ${hits.length} 处：`)
  for (const h of hits.slice(0, 20)) console.error(`  ${h.file}:${h.line}  ${h.word}`)
  if (hits.length > 20) console.error(`  ……还有 ${hits.length - 20} 处`)
  process.exit(1)
}
// 同 check-copy：扫不到文件就等于没在检查，必须报错而不是报绿
if (scanned < 20) {
  console.log(`✗ 归属守卫只扫到 ${scanned} 个文件（至少应有 20 个），遍历可能坏了`)
  process.exit(1)
}
console.log(`✓ 归属守卫：0 处旧署名（${scanned} 个文件）`)
