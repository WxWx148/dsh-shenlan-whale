/**
 * scripts/gen-structure.mjs — 把「设计声明」和「代码事实」合成一份快照。
 *
 * 为什么需要它：
 *   界面要显示的很多东西，本质是**结构事实**：这条规则落在哪个文件、这个页面属于哪个域、
 *   有多少模块、接口前缀是什么。以前这些是手抄进代码和文档的，结构一动就失真。
 *   现在只在这里生成一次，界面读 `lib/structure.generated.json`，不许自己拼。
 *
 * 分工：
 *   lib/blueprint.mjs        设计（父模块、域映射、别名、前缀）—— 人写的
 *   truth/taxonomy.mjs      页面与域（已有真源，不复制）
 *   本脚本                    扫描（目录、导出符号、路由、行数）—— 机器算的
 *
 * 用法：
 *   node scripts/gen-structure.mjs           写 lib/structure.generated.json
 *   node scripts/gen-structure.mjs --check   只比对；不一致退出码 1
 *   node scripts/gen-structure.mjs --print   打一份摘要，不写文件
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'lib', 'structure.generated.json')
const rel = (full) => path.relative(ROOT, full).split(path.sep).join('/')

// 扫描目录已改为从 blueprint.PARENTS 派生（见 build() 里的 parents 循环），
// 不再手写清单：P1 每落地一个父模块，手写清单忘加一行就少扫一整个目录。

/** 这些文件不参与「导出符号」统计：入口会执行装配，浏览器入口不是模块 */
const SKIP_IMPORT = new Set(['index.js', 'lib/client.panel.js'])

/**
 * 结构工具自己不算业务模块。
 * 否则每加一个生成/查询脚本，"有多少模块"就跟着涨一次 —— 那个数字就不该被看了。
 */
const NON_BUSINESS = new Set(['structure.mjs', 'blueprint.mjs'])

/** 抽样读源码抓导出名：import() 失败时的兜底（比如模块需要环境变量才能加载） */
function regexExports(src) {
  const names = new Set()
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const one of m[1].split(',')) {
      const name = one.trim().split(/\s+as\s+/).pop()
      if (name) names.add(name)
    }
  }
  return [...names].sort()
}

/**
 * 取一个文件的导出名。先真的 import（最准），失败再退回正则。
 *
 * 为什么不一律用正则：星号转发（export * from …）、重命名导出、默认导出这些写法
 * 正则总会漏；而 import 拿到的是运行时真相。代价是慢一点、可能触发顶层副作用，
 * 所以构建期做，并且失败有兜底。
 */
async function exportsOf(abs, relPath) {
  if (SKIP_IMPORT.has(relPath)) {
    const src = readFileSync(abs, 'utf8')
    return { exports: regexExports(src), via: 'regex' }
  }
  try {
    const mod = await import(pathToFileURL(abs).href)
    return { exports: Object.keys(mod).sort(), via: 'import' }
  } catch {
    const src = readFileSync(abs, 'utf8')
    return { exports: regexExports(src), via: 'regex' }
  }
}

/**
 * 扫一个父模块目录。
 *
 * **必须递归**：设计里的第二批拆分（`mind/learn/`、`ability/tools|exec|media/`、
 * `turn/stages/`）都在父模块内部再分一层。0.46.0 拆 `mind/learn/` 时踩到了这个坑 ——
 * 生成器只扫一层，子目录里的 5 个文件在快照里凭空消失：文件数从 73 掉到 69，
 * 而 R2「规则的 symbol 必须真的被导出」却照样全绿，因为规则查的符号恰好都在
 * 门面里还有一份。**少扫一个目录不报错，这才是最危险的失真**。
 *
 * 现在：先文件、后子目录，逐层递归。`file` 是相对父模块的路径（含子目录），
 * `path` 是相对仓库根的路径。界面和审计都按 `file` 显示，一眼看得出它在哪一层。
 */
async function scanDir(dirName, base = '') {
  const dir = path.join(ROOT, dirName, base)
  if (!existsSync(dir)) return []
  const files = []
  const subdirs = []
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.mjs') && !name.endsWith('.js')) {
      // 不是代码文件：只有目录值得继续往下走
      if (statSync(path.join(dir, name)).isDirectory()) subdirs.push(name)
      continue
    }
    if (NON_BUSINESS.has(name)) continue
    const abs = path.join(dir, name)
    if (!statSync(abs).isFile()) {
      subdirs.push(name)
      continue
    }
    const relPath = rel(abs)
    const { exports, via } = await exportsOf(abs, relPath)
    files.push({
      file: base ? `${base}/${name}` : name,
      path: relPath,
      dir: base || '.',
      lines: readFileSync(abs, 'utf8').split('\n').length,
      exports,
      via,
    })
  }
  for (const sub of subdirs) files.push(...(await scanDir(dirName, base ? `${base}/${sub}` : sub)))
  return files
}

/**
 * 从入口抓路由表与前缀。
 *
 * 这是**唯一允许读源码文本**的地方，而且只在构建期。
 * 理由：路由是 `index.js` 里的 if 链，没有可 import 的注册表（P2 会重构成注册表）。
 * 在此之前，抓比手工维护一份清单可靠 —— 至少不会漏。
 */
function scanRoutes() {
  const src = readFileSync(path.join(ROOT, 'index.js'), 'utf8')
  const prefix = (src.match(/const ROUTE_PREFIX = '([^']+)'/) || [])[1] || ''
  const routes = new Set()
  for (const m of src.matchAll(/route === '([^']+)'/g)) routes.add(m[1])
  for (const m of src.matchAll(/route\.startsWith\('([^']+)'\)/g)) routes.add(m[1] + '*')
  return { prefix, routes: [...routes].sort() }
}

async function build() {
  const blueprint = await import(pathToFileURL(path.join(ROOT, 'lib', 'blueprint.mjs')).href)
  const taxonomy = await import(pathToFileURL(path.join(ROOT, 'truth', 'taxonomy.mjs')).href)

  const { PARENTS, DOMAIN_PARENTS, ALIASES, API_BASE, SCHEMA } = blueprint
  const domainIds = new Set(taxonomy.DOMAINS.map((one) => one.id))
  const problems = []

  // 域映射必须与 taxonomy 一致 —— 不一致就当场说，别生成一份自相矛盾的快照
  for (const id of Object.keys(DOMAIN_PARENTS)) {
    if (!domainIds.has(id)) problems.push(`DOMAIN_PARENTS 里的 ${id} 不在 taxonomy.DOMAINS 里`)
  }
  for (const id of domainIds) {
    if (!DOMAIN_PARENTS[id]) problems.push(`taxonomy 的域 ${id} 没有在 DOMAIN_PARENTS 里声明归属`)
  }

  const parents = []
  for (const one of PARENTS) {
    const dirExists = existsSync(path.join(ROOT, one.dir))
    const files = dirExists ? await scanDir(one.dir) : []
    const facade = one.facade ? path.join(ROOT, one.dir, one.facade) : null
    let exported = []
    if (facade && existsSync(facade)) {
      const { exports } = await exportsOf(facade, rel(facade))
      exported = exports
    } else {
      // 没有门面：把成员文件的导出并起来（base 就是这种）
      exported = [...new Set(files.flatMap((f) => f.exports))].sort()
    }
    parents.push({
      id: one.id,
      label: one.label,
      dir: one.dir,
      status: dirExists ? 'landed' : 'planned',
      facade: one.facade,
      desc: one.desc,
      files,
      exports: exported,
    })
  }

  // lib/ 里还没归到父模块的散装模块。它们不是"没用的东西"，是"下一批要搬的"：
  // 单独列出来，界面和审计才有地方说"这个文件将来归哪个父模块"。
  const flat = await scanDir('lib')

  const routed = scanRoutes()
  const pages = taxonomy.REGIONS.map((one) => ({
    id: one.id,
    label: one.label,
    hint: one.hint,
    icon: one.icon,
    domain: one.domain,
  }))
  const pageIds = new Set(pages.map((one) => one.id))
  const aliases = {}
  for (const [from, to] of Object.entries(ALIASES)) {
    if (!pageIds.has(to)) problems.push(`别名 ${from} → ${to}：目标页面不存在`)
    aliases[from] = to
  }

  const domains = taxonomy.DOMAINS.map((one) => ({
    id: one.id,
    label: one.label,
    hint: one.hint,
    parents: DOMAIN_PARENTS[one.id] || [],
  }))

  const entryLines = readFileSync(path.join(ROOT, 'index.js'), 'utf8').split('\n').length
  const stats = {
    parentsLanded: parents.filter((p) => p.status === 'landed').length,
    parentsPlanned: parents.filter((p) => p.status === 'planned').length,
    files: parents.reduce((n, p) => n + p.files.length, 0) + flat.length + 1,
    lines: parents.reduce((n, p) => n + p.files.reduce((m, f) => m + f.lines, 0), 0)
      + flat.reduce((m, f) => m + f.lines, 0) + entryLines,
    pages: pages.length,
    routes: routed.routes.length,
    flatModules: flat.length,
    exports: parents.reduce((n, p) => n + p.exports.length, 0) + flat.reduce((n, f) => n + f.exports.length, 0),
  }

  return {
    schema: SCHEMA,
    api: { base: API_BASE || routed.prefix, prefix: routed.prefix, routes: routed.routes },
    pages,
    aliases,
    domains,
    parents,
    // 还没搬进父模块的模块。`dir` 是它们现在待的地方；将来归哪个父模块由 P1 决定。
    flat: { dir: 'lib', modules: flat },
    stats,
    problems,
  }
}

/** 去掉易变字段后再比较：generatedAt 每次都不同，不该让 --check 永远红 */
function stable(value) {
  const copy = JSON.parse(JSON.stringify(value))
  delete copy.generatedAt
  return JSON.stringify(copy, null, 2)
}

const args = new Set(process.argv.slice(2))
const next = await build()

if (next.problems.length) {
  console.error('✗ 结构声明有矛盾：')
  for (const one of next.problems) console.error('  - ' + one)
  process.exit(1)
}

if (args.has('--print')) {
  console.log(JSON.stringify(next, null, 2))
  process.exit(0)
}

const payload = { generatedAt: new Date().toISOString(), ...next }

if (args.has('--check')) {
  if (!existsSync(OUT)) {
    console.error('✗ 没有 lib/structure.generated.json：先跑 npm run structure')
    process.exit(1)
  }
  const current = JSON.parse(readFileSync(OUT, 'utf8'))
  if (stable(current) !== stable(payload)) {
    console.error('✗ 结构快照落后于源码：跑 npm run structure 重新生成')
    // 只报差异的顶层块，不刷整份 JSON
    const keys = new Set([...Object.keys(current), ...Object.keys(payload)])
    for (const key of keys) {
      if (stable({ [key]: current[key] }) !== stable({ [key]: payload[key] })) console.error('  差异：' + key)
    }
    process.exit(1)
  }
  console.log(`✓ 结构快照与源码一致（${payload.stats.parentsLanded} 个父模块落地 / ${payload.stats.files} 个文件 / ${payload.stats.routes} 条路由）`)
  process.exit(0)
}

writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8')
console.log(`✓ 已生成 lib/structure.generated.json`)
console.log(`  父模块 ${payload.stats.parentsLanded} 落地 / ${payload.stats.parentsPlanned} 计划`)
console.log(`  文件 ${payload.stats.files} 个（lib 散装 ${payload.stats.flatModules}）/ 路由 ${payload.stats.routes} 条 / 页面 ${payload.stats.pages} 个 / 导出 ${payload.stats.exports} 个`)
