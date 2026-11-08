/**
 * 文案守卫 —— 指代这个角色时统一写「他/她」，不允许单独写「她」。
 *
 * copy-guard: ignore  ← 本文件自己就含这个字的字面量（正则与提示语），必须先声明豁免
 *
 * 为什么要有脚本而不是靠记性：
 *   面板文案里「让他/她拆成几步」「他/她自己会换个做法」这类句子，
 *   一旦漏改就前后不一致；而这类文案散在 say / style / panel / webui 里，
 *   人工过一遍必然漏，而且下次动文案又会漏回来。
 *
 * 用法：
 *   node scripts/check-copy.mjs            人读格式，有命中则 exit 1
 *   node scripts/check-copy.mjs --json     给 CI / 编辑器用
 *
 * 豁免两档：
 *   文件级 —— 文件头写一行 `copy-guard: ignore`（守卫自身、需要匹配这个字的解析器）
 *   目录级 —— node_modules / plugin-backups / .git / fixtures
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 至少该扫到这么多文件。低于这个数说明遍历出问题，不是「代码很干净」 */
const MIN_FILES = 20

const SKIP_DIRS = new Set(['node_modules', 'plugin-backups', '.git', 'fixtures', 'dist', 'coverage', '.snapshots', '.work', 'probes', '_archive'])
const EXT = /\.(mjs|js|cjs|ts|md|html|css)$/

/** 单独一个「她」：前面不是「他/」或「她/」，后面不接「/」 */
const LONE_SHE = /(?<!他\/)(?<!她\/)她(?!\/)/
const LONE_SHE_ALL = /(?<!他\/)(?<!她\/)她(?!\/)/g

/** 指代别人时不改：句子里已经有明确第三人称主体 */
const ALLOW = [
  /她们/, // 复数，指一群女性，不是这个角色
  // 被引号括起来的单个字：这是在「谈论这个字」，不是用它指代谁
  // （比如文档里写「单独『她』已清零」）
  /[「『“"']她[」』”"']/,
]

/** 文件级豁免：文件头写了 copy-guard: ignore 就整份跳过 */
const EXEMPT = /copy-guard:\s*ignore/
const EXEMPT_SCAN_CHARS = 2000

function skipLine(line) {
  return ALLOW.some((re) => re.test(line))
}

/**
 * 正则里的斜杠要转义成 `\/`，于是「他\/她」在文本里不是「他/她」——
 * 守卫会把它当成单独一个「她」误报。判之前先还原转义：
 * 这里关心的是字符序列，不是 JS 的转义写法。
 */
function unescapeSlash(text) {
  return String(text).replace(/\\\//g, '/')
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.isFile() && EXT.test(entry.name)) {
      try {
        if (statSync(full).size > 2 * 1024 * 1024) continue // 超大文件跳过
      } catch {
        continue
      }
      out.push(full)
    }
  }
  return out
}

const files = existsSync(ROOT) ? walk(ROOT) : []
const hits = []

for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  // 文件级豁免写在头部，只看前 2000 字，避免正文里偶然提到就整份跳过
  if (EXEMPT.test(text.slice(0, EXEMPT_SCAN_CHARS))) continue
  if (!LONE_SHE.test(unescapeSlash(text))) continue

  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const probe = unescapeSlash(line)
    if (!LONE_SHE.test(probe) || skipLine(probe)) return
    hits.push({
      file: path.relative(ROOT, file),
      line: index + 1,
      text: line.trim().slice(0, 120),
      count: (probe.match(LONE_SHE_ALL) || []).length,
    })
  })
}

const total = hits.reduce((sum, hit) => sum + hit.count, 0)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: hits.length === 0, total, files: files.length, hits }, null, 2))
  process.exit(hits.length ? 1 : 0)
}

if (hits.length === 0) {
  // 下界断言：守卫「什么都没扫到」时会以 0 处违规通过，看起来比真检查还绿。
  // 遍历逻辑一旦坏掉（改错 SKIP_DIRS、路径拼错），表现就是这种沉默 ——
  // 宁可报错，也不要一个不检查的守卫。
  if (files.length < MIN_FILES) {
    console.log(`✗ 文案守卫只扫到 ${files.length} 个文件（至少应有 ${MIN_FILES} 个），遍历可能坏了`)
    process.exit(1)
  }
  console.log(`✓ 文案守卫：${files.length} 个文件，单独「她」0 处`)
  process.exit(0)
}

console.log(`✗ 文案守卫：${hits.length} 行 / ${total} 处还在单独用「她」，应写成「他/她」\n`)
for (const hit of hits) {
  console.log(`  ${hit.file}:${hit.line}`)
  console.log(`    ${hit.text}`)
}
console.log('\n改法：把单独的她替换成「他/她」（已是「他/她」的不会被重复替换）')
process.exit(1)
