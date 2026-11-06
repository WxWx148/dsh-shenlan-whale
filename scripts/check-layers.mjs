/**
 * 调用链守卫 —— 保证「谁调谁」这件事在结构上不会烂掉。
 *
 * 测试能证明「函数算得对」，但证明不了「它被接上了」。旧版就是这样烂的：
 *   63 条后端路由，面板只接了 38 条 —— 剩下 25 条代码完好、测试全绿、就是没人调。
 *
 * 四条规则，全是静态的（不真的运行代码）：
 *   R1 断链   import 的相对路径必须真的存在（改名/搬文件后最常见）
 *   R2 成环   模块之间不许循环依赖（旧版 core ↔ runtime ↔ behaviors 三角循环，
 *             导致加载顺序一变就 undefined，报错还指不到源头）
 *   R3 越层   QQ 层（lib/qq/）只能被 index.js、它自己的兄弟模块、以及用例引用
 *   R4 绕闸   QQ 层以外谁都不许直接调 OneBot 的发送接口（出站必须过 say.mjs）
 *
 * 规则按**目录**判，不按文件名白名单：白名单每加一个文件就要改一次守卫，
 * 迟早有人嫌麻烦直接把新文件塞进去 —— 那不是守卫，是记账。
 *
 * 另外报告一件事：lib 里哪些模块还没有任何运行时文件引用它
 * （只被测试引用也算没接上 —— 那是「写好了但没装上去」）。
 *
 * 用法：node scripts/check-layers.mjs [--json]
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.snapshots', '.work', 'plugin-backups', 'dist', 'coverage', 'probes', '_archive'])
const CODE_EXT = /\.(mjs|js|cjs)$/

/** QQ 层目录：通道、登录、群视图、掉线补回都归这里 */
const QQ_LAYER = 'lib/qq/'
const isQQ = (name) => String(name).startsWith(QQ_LAYER)
/**
 * 允许直接发 OneBot 请求的，只有 QQ 层自己。
 * 它是唯一该知道「send_private_msg 长什么样」的地方 ——
 * 别的模块要发话，必须走 runtime.outbound，那里有防空、截断、脱敏。
 */
/** 这些不在「运行时装配」范畴，不参与孤立模块统计 */
const NOT_RUNTIME = /^(tests|scripts)\//
/** 已声明但还没到接线阶段的模块（写清等谁，别让它变成一张永远没人看的告警） */
const PENDING = {
  // 浏览器侧的代码不由 import 图加载：宿主按 package.json 的 dsh.client 直接喂给前端。
  // 所以它永远「没人 import」，这不是没接上，是另一条装配路径。
  'lib/client.js': '浏览器入口，由宿主静态加载（dsh.client），不走 import 图',
}

const SENDS = /\b(sendPrivateMsg|sendGroupMsg|send_msg|send_private_msg|send_group_msg)\b/
/** 文件级豁免：声明 `layers-guard: ignore` 的文件不参与 R4（守卫自己、以及解释这张表的地方） */
const SELF = fileURLToPath(import.meta.url)
const EXEMPT = /layers-guard:\s*ignore/

function rel(full) {
  return path.relative(ROOT, full).split(path.sep).join('/')
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
    } else if (entry.isFile() && CODE_EXT.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** 把 import 说明符解析成仓库内的真实文件；解析不到返回 null */
function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return { external: true }
  const base = path.resolve(path.dirname(fromFile), spec)
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')]
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return { file: candidate }
    } catch {}
  }
  return { file: null }
}

const FROM_RE = /\bfrom\s*['"]([^'"]+)['"]/g
const DYN_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

function importsOf(text) {
  const out = []
  for (const re of [FROM_RE, DYN_RE]) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(text))) out.push(match[1])
  }
  return out
}

const files = walk(ROOT)
const graph = new Map()
const broken = []
const layerBreach = []
const outboundBreach = []
const importedBy = new Map()

for (const file of files) {
  const name = rel(file)
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const deps = []
  for (const spec of importsOf(text)) {
    const resolved = resolveSpec(file, spec)
    if (resolved.external) continue
    if (!resolved.file) {
      broken.push({ file: name, spec })
      continue
    }
    const depName = rel(resolved.file)
    deps.push(depName)
    if (!importedBy.has(depName)) importedBy.set(depName, [])
    importedBy.get(depName).push(name)

    if (isQQ(depName) && !(name === 'index.js' || isQQ(name) || NOT_RUNTIME.test(name))) {
      layerBreach.push({ file: name, dep: depName })
    }
  }
  graph.set(name, deps)

  if (!isQQ(name) && file !== SELF && !EXEMPT.test(text.slice(0, 2000)) && SENDS.test(text)) {
    outboundBreach.push({ file: name, hit: text.match(SENDS)[0] })
  }
}

/** R2：环检测（三色标记，报出完整环路径） */
function findCycles() {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map([...graph.keys()].map((key) => [key, WHITE]))
  const stack = []
  const cycles = []

  const visit = (node) => {
    color.set(node, GRAY)
    stack.push(node)
    for (const dep of graph.get(node) || []) {
      if (!graph.has(dep)) continue
      const state = color.get(dep)
      if (state === GRAY) {
        const start = stack.indexOf(dep)
        cycles.push([...stack.slice(start), dep])
        continue
      }
      if (state === WHITE) visit(dep)
    }
    stack.pop()
    color.set(node, BLACK)
  }

  for (const node of graph.keys()) {
    if (color.get(node) === WHITE) visit(node)
  }
  return cycles
}

const cycles = findCycles()

/** 装配入口：从这些文件出发能走到的模块才算「接上了」 */
const ENTRIES = ['index.js', 'lib/runtime.mjs']

/** 从入口开始做可达性遍历 */
function reachableFrom(entries) {
  const seen = new Set()
  const queue = [...entries.filter((entry) => graph.has(entry))]
  while (queue.length) {
    const node = queue.shift()
    if (seen.has(node)) continue
    seen.add(node)
    for (const dep of graph.get(node) || []) {
      if (!seen.has(dep) && graph.has(dep)) queue.push(dep)
    }
  }
  return seen
}

/** 没有人能从入口走到的 lib 模块（只被测试引用也算没接上） */
const reachable = reachableFrom(ENTRIES)
const orphans = [...graph.keys()]
  .filter((name) => name.startsWith('lib/'))
  .filter((name) => !PENDING[name])
  .filter((name) => {
    if (reachable.has(name)) return false
    const users = (importedBy.get(name) || []).filter((user) => !NOT_RUNTIME.test(user))
    // 被另一个同样走不到的模块引用，仍然算没接上
    return users.length === 0 || users.every((user) => !reachable.has(user))
  })
  .sort()

const edges = [...graph.values()].reduce((sum, deps) => sum + deps.length, 0)
const result = {
  ok: broken.length === 0 && cycles.length === 0 && layerBreach.length === 0 && outboundBreach.length === 0,
  files: files.length,
  edges,
  broken,
  cycles,
  layerBreach,
  outboundBreach,
  orphans,
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (!result.ok) {
  if (broken.length) {
    console.error(`✗ 断链 ${broken.length} 处（import 指向不存在的文件）：`)
    for (const item of broken.slice(0, 20)) console.error(`  ${item.file} → ${item.spec}`)
  }
  if (cycles.length) {
    console.error(`✗ 循环依赖 ${cycles.length} 处：`)
    for (const cycle of cycles.slice(0, 10)) console.error(`  ${cycle.join(' → ')}`)
  }
  if (layerBreach.length) {
    console.error(`✗ 越层 ${layerBreach.length} 处（只有通道自己能碰通道层）：`)
    for (const item of layerBreach.slice(0, 20)) console.error(`  ${item.file} → ${item.dep}`)
  }
  if (outboundBreach.length) {
    console.error(`✗ 绕过人话层 ${outboundBreach.length} 处（出站必须走 say.mjs）：`)
    for (const item of outboundBreach.slice(0, 20)) console.error(`  ${item.file} 直接调了 ${item.hit}`)
  }
  process.exit(1)
}

if (files.length < 20) {
  console.log(`✗ 调用链守卫只扫到 ${files.length} 个文件（至少应有 20 个），遍历可能坏了`)
  process.exit(1)
}
console.log(`✓ 调用链：${files.length} 个文件 / ${edges} 条依赖，无断链、无环、无越层、无绕闸`)
if (orphans.length) {
  console.log(`  提示：${orphans.length} 个模块还没有被运行时文件引用（写完还没装上去）：`)
  for (const name of orphans) console.log(`    ${name}`)
}
const pending = Object.keys(PENDING).filter((name) => !reachable.has(name))
if (pending.length) {
  for (const name of pending) console.log(`  待接：${name} —— ${PENDING[name]}`)
}
