/**
 * lib/coding.mjs — 让深蓝能读、改、跑**自己这套代码**的那一层。
 *
 * 为什么单独一个文件（而不是在 tools.mjs 里塞几段）：
 *   这四个能力（看源码 / 搜源码 / 改源码 / 跑命令）共享同一套边界判断 ——
 *   「这个路径在不在插件目录里」「这是不是不能碰的启动文件」「改之前备份到哪儿」。
 *   边界一旦散落到各个工具里，总有一天某一个工具会漏判一次，
 *   而漏判一次的代价是插件起不来。把边界收在一处，工具只管翻译参数。
 *
 * 三条硬边界，改这个文件的人必须守：
 *   1. **路径不能出插件目录**。任何 ../ 、绝对路径、盘符都不算过关；
 *      不是「不许碰 C:\\Windows」这种列表，而是「除了插件目录，哪儿都不行」。
 *   2. **关键启动文件默认不让写**。index.js / package.json / cordis.patch.yml /
 *      runtime.mjs / sandbox.mjs / config.mjs / core.mjs 是「这东西还能不能起来」的地基，
 *      改坏一个整个插件消失。要改必须显式 force=true，且会写审计。
 *   3. **改写之前先备份**。备份落在数据目录（不是源码树）的 backups/code 下，
 *      带时间戳，按文件滚动保留 —— 源码树里堆 .bak 会把 listing 弄脏。
 *
 * 命令为什么不随便跑：允许的是 node / npm / npx 三个，且用 execFile（不经 shell），
 * 参数是数组一个个传进去，所以 `&&`、`|`、反引号这类拼接不会被执行。
 * 这不是「防黑客」，是「防模型手一滑」——它能做事，但不该能砸掉自己的运行环境。
 */

import { execFile } from 'node:child_process'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 插件自身代码根目录。从本文件往上两级，与「进程当前目录在哪里」无关 —— 宿主启动方式换一种也不会指错 */
const SELF_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 认得出的代码/文本后缀。认不出的一律不给读，避免拿二进制当文本啃 */
const READABLE_EXTS = new Set(['.mjs', '.js', '.cjs', '.json', '.md', '.yml', '.yaml', '.txt', '.bat', '.cmd', '.py', '.sh'])

/** 列目录/搜索时跳过的目录。node_modules 一进去就是几万行，搜什么都是噪音 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.snapshots', 'plugin-backups', 'media', 'out'])

/**
 * 不能碰的启动文件。正则匹配的是**相对插件根的路径**（分隔符统一 \ 或 / 都算）。
 *
 * 为什么是「名单」而不是「随便改」：这些文件的共同点是「改坏了不会报错，会直接起不来」。
 * 一般逻辑文件改错，跑测试会红；index.js 改错，宿主加载插件就失败，面板全消失。
 * 风险不对称，所以门槛不对称 —— 普通文件随便改，这些要显式 force。
 */
const PROTECTED = [
  /^index\.js$/,
  /^package\.json$/,
  /^cordis\.patch\.yml$/,
  /^lib[\\/]runtime\.mjs$/,
  /^lib[\\/]sandbox\.mjs$/,
  /^lib[\\/]config\.mjs$/,
  /^lib[\\/]core\.mjs$/,
  /^lib[\\/]coding\.mjs$/,
]

/** 允许跑的程序。Windows 下要给 cmd 后缀，否则 execFile 找不到 */
const BIN_NAME = process.platform === 'win32'
  ? { node: 'node', npm: 'npm.cmd', npx: 'npx.cmd' }
  : { node: 'node', npm: 'npm', npx: 'npx' }

/**
 * npm / npx 的真正入口（cli.js 磁盘路径）。
 *
 * 为什么不能直接起 `npm.cmd`：Node 从 18.20.2 / 20.12.0 起，为了缓解 CVE-2024-27980，
 * **禁止不带 shell 直接 spawn .bat / .cmd** —— 表现就是 `spawn EINVAL`。
 * 而这一层承诺过「能跑 node / npm / npx」（改完代码跑一遍测试就是它存在的理由），
 * 实际只有 node 能用：命令跑不起来，报错还是一句 EINVAL，看不出是功能坏了。
 *
 * 解法不是打开 shell —— 那等于把「不经 shell、参数数组直传」这条硬边界拆了。
 * npm 的 .cmd 本来就是一层壳，最后执行的也是 `node "...\npm-cli.js"`；
 * 那就直接起 node：权限、cwd、超时、输出上限全部沿用同一条路。
 *
 * 找不到 cli.js 就如实说找不到，而不是丢一个 EINVAL 上去让人猜。
 */
function cliEntry(name) {
  const bin = path.dirname(process.execPath)
  const file = name === 'npx' ? 'npx-cli.js' : 'npm-cli.js'
  const candidates = [
    // 官方安装包 / nvm-windows / 便携版：node.exe 旁边就是 node_modules
    path.join(bin, 'node_modules', 'npm', 'bin', file),
    // Linux 发行版与部分 macOS 布局：node 在 bin/，npm 在 ../lib/node_modules
    path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', file),
    path.join(bin, '..', 'node_modules', 'npm', 'bin', file),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

/** 单文件读写上限。再大的源码文件基本是 client.js 这种打包产物，整份读没有意义 */
const MAX_READ_BYTES = 400_000
const MAX_WRITE_BYTES = 400_000
/** 每个文件保留多少份备份 */
const KEEP_BACKUPS = 20
/** 命令多久算跑不完 */
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_OUTPUT_BYTES = 6000

export const LIMITS = Object.freeze({
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  KEEP_BACKUPS,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
})

export function rootOf(input = {}) {
  return path.resolve(String(input.root || SELF_ROOT))
}

/**
 * 把「外面的相对路径」变成插件内的绝对路径，**出界返回 null**。
 *
 * 判定用 path.resolve + 前缀比较，而不是字符串里找 `..`：
 * 后者能被 `..\.\..`、绝对路径绕过去。前缀比较只对**算完之后的真实路径**生效，拼接骗不了它。
 *
 * 一个写明在案的限制：**不解析符号链接**（没有用 realpathSync）。
 * 插件目录内若有人放一个指向外面的链接，它会通过前缀检查并被读写到链接的目标。
 * 不补 realpathSync 是权衡：这一层面对的是模型写错路径，不是对抗本地恶意链接；
 * 而 realpath 会给每次读写多加一次 IO，且会改变「链接文件」的既有行为。
 * 真要收紧，只需在这里加一次 realpathSync —— 但那会改变对外行为，要单独决定。
 */
export function resolveInside(root, rel) {
  const raw = String(rel ?? '').trim()
  if (!raw) return null
  // 绝对路径、盘符、UNC 一律不要：只接受「从插件根往下」的写法
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw) || raw.startsWith('\\\\')) return null
  const target = path.resolve(root, raw)
  const base = path.resolve(root)
  if (target !== base && !target.startsWith(base + path.sep)) return null
  return target
}

/** 相对插件根的路径（用于展示与禁区匹配） */
function relativeOf(root, full) {
  return path.relative(path.resolve(root), path.resolve(full)).split(path.sep).join('/')
}

export function isProtected(root, full) {
  const rel = relativeOf(root, full)
  return PROTECTED.some((re) => re.test(rel) || re.test(rel.replace(/\//g, '\\')))
}

function readable(full) {
  return READABLE_EXTS.has(path.extname(full).toLowerCase())
}

function trimText(text, limit) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}\n…（已截断，原文 ${value.length} 字符）` : value
}

// ── 备份 ────────────────────────────────────────────────────────

/**
 * 改文件之前留一份。落点是**数据目录**而不是源码树：
 * 源码树里放 .bak 会被列目录、被搜索、被 ESLint 扫，改一次多一个垃圾。
 */
function backupTo(backupDir, root, full) {
  const rel = relativeOf(root, full).replace(/[\\/:]/g, '__')
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\..+$/, '')
  const file = path.join(backupDir, `${rel}.${stamp}.bak`)
  try {
    // mkdirSync 也必须在这道 try 里：备份目录建不出来（比如那个路径被一个文件占了）
    // 同样属于「备份没做成」，该由调用方拿到 null 去决定，而不是把异常抛上去
    // 让上层误判成一次普通的写入失败。
    mkdirSync(backupDir, { recursive: true })
    writeFileSync(file, readFileSync(full))
  } catch {
    return null
  }
  pruneBackups(backupDir, rel)
  return file
}

/** 同一个人 @ 同一个文件只留最近 KEEP_BACKUPS 份 */
function pruneBackups(backupDir, prefix) {
  let names = []
  try {
    names = readdirSync(backupDir).filter((name) => name.startsWith(`${prefix}.`) && name.endsWith('.bak')).sort()
  } catch {
    return
  }
  for (const name of names.slice(0, Math.max(0, names.length - KEEP_BACKUPS))) {
    try { rmSync(path.join(backupDir, name), { force: true }) } catch {}
  }
}

// ── 四个能力 ────────────────────────────────────────────────────

/**
 * 列目录。默认一层，给 dots 时可以递归。
 * 输出里目录带 `/`，方便模型一眼分清该往哪儿读。
 */
export function listTree(root, input = {}) {
  const base = resolveInside(root, input.path || '.')
  if (!base) return { ok: false, code: 'outside', error: '只能列插件目录里的东西' }
  if (!existsSync(base)) return { ok: false, code: 'missing', error: '没有这个目录' }
  if (!statSync(base).isDirectory()) return { ok: false, code: 'not_dir', error: '这不是一个目录' }

  const maxEntries = Math.max(1, Math.min(400, Number(input.max) || 120))
  const rows = []
  const walk = (dir, depth) => {
    if (rows.length >= maxEntries) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      if (rows.length >= maxEntries) return
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        rows.push(`${relativeOf(root, path.join(dir, entry.name))}/`)
        if (depth > 0) walk(path.join(dir, entry.name), depth - 1)
      } else {
        rows.push(relativeOf(root, path.join(dir, entry.name)))
      }
    }
  }
  const depth = Math.max(0, Math.min(3, Number(input.recursive) || 0))
  walk(base, depth)
  return { ok: true, text: rows.length ? rows.join('\n') : '（空目录）', data: { root: relativeOf(root, base), entries: rows } }
}

/** 读一份源码。可以只取一段行号 —— 大文件整份读会把上下文挤光 */
export function readSource(root, input = {}) {
  const full = resolveInside(root, input.path || '')
  if (!full) return { ok: false, code: 'outside', error: '只能读插件目录里的文件' }
  if (!existsSync(full)) return { ok: false, code: 'missing', error: '没有这个文件' }
  if (!statSync(full).isFile()) return { ok: false, code: 'not_file', error: '这不是文件' }
  if (!readable(full)) return { ok: false, code: 'binary', error: '这个文件不是文本，读不了' }
  let size = 0
  try { size = statSync(full).size } catch {}
  if (size > MAX_READ_BYTES) return { ok: false, code: 'too_big', error: `文件太大（${Math.round(size / 1024)}KB），用 start/count 分段读` }

  let text = ''
  try { text = readFileSync(full, 'utf8') } catch (error) { return { ok: false, code: 'io', error: String(error?.message || error) } }
  const lines = text.split('\n')
  const total = lines.length
  const start = Math.max(1, Number(input.start) || 1)
  const count = Math.max(1, Math.min(400, Number(input.count) || 120))
  const slice = lines.slice(start - 1, start - 1 + count)
  const numbered = slice.map((line, index) => `${String(start + index).padStart(5, ' ')} | ${line}`).join('\n')
  const head = start > 1 || start - 1 + count < total
    ? `文件 ${relativeOf(root, full)}（共 ${total} 行，这里是第 ${start}–${Math.min(total, start - 1 + count)} 行）\n`
    : `文件 ${relativeOf(root, full)}（共 ${total} 行）\n`
  return {
    ok: true,
    text: trimText(head + numbered, MAX_OUTPUT_BYTES),
    data: { path: relativeOf(root, full), lines: total, from: start, taken: slice.length },
  }
}

/**
 * 在源码里搜关键词。纯 Node 行扫描，不依赖 grep/rg ——
 * 沙箱里本来就不许起子进程，这里更不能自己破自己的规矩。
 */
export function searchSource(root, input = {}) {
  const keyword = String(input.keyword ?? input.query ?? '').trim()
  if (!keyword) return { ok: false, code: 'empty', error: '搜什么？' }
  const maxHits = Math.max(1, Math.min(60, Number(input.max) || 20))
  const context = Math.max(0, Math.min(6, Number(input.context) || 2))
  const ignoreCase = input.ignoreCase !== false
  const needle = ignoreCase ? keyword.toLowerCase() : keyword
  const only = String(input.path || '.').trim()
  const base = resolveInside(root, only)
  if (!base) return { ok: false, code: 'outside', error: '只能搜插件目录里的东西' }

  const files = []
  const walk = (dir) => {
    if (files.length > 1200) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(path.join(dir, entry.name))
      } else if (readable(entry.name)) {
        files.push(path.join(dir, entry.name))
      }
    }
  }
  // 这里必须有 existsSync 守卫：readSource / listTree 都有，就它没有。
  // 缺了它，路径不存在时 statSync 直接抛 ENOENT 冒出函数，
  // 上层只能兜成一个通用的 tool_failed —— 同组工具的错误码就对不齐了。
  if (!existsSync(base)) return { ok: false, code: 'missing', error: '没有这个路径' }
  if (statSync(base).isDirectory()) walk(base)
  else files.push(base)

  const hits = []
  for (const file of files) {
    if (hits.length >= maxHits) break
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (hits.length >= maxHits) break
      const line = lines[i]
      if (!(ignoreCase ? line.toLowerCase() : line).includes(needle)) continue
      const from = Math.max(0, i - context)
      hits.push({
        path: relativeOf(root, file),
        line: i + 1,
        code: lines.slice(from, i + context + 1).join('\n'),
      })
    }
  }
  if (!hits.length) return { ok: false, code: 'none', error: `源码里没找到「${keyword}」` }
  const text = hits.map((hit) => `${hit.path}:${hit.line}\n${hit.code}`).join('\n---\n')
  return { ok: true, text: trimText(`找到 ${hits.length} 处：\n\n${text}`, MAX_OUTPUT_BYTES), data: { hits } }
}

/**
 * 原子写：临时文件 → fsync → rename。
 *
 * 为什么源码尤其需要它：`writeFileSync` 是「先截断再写」。
 * 进程在写一半时被杀（重启、断电、宿主崩了），磁盘上就留下**半个源码文件** ——
 * 而这里写的正是「承载插件自己的代码」，下一次启动直接 Import 失败，插件整个消失。
 * 备份是有的，但恢复要人手动做，而用户看到的只是「插件不见了」。
 * rename 在同一分区上是原子的：要么旧内容，要么新内容，没有第三种。
 *
 * rename 失败（目标被别的程序独占）时退回直接写：
 * 原子性是「更好」，写进去是「必须」。
 */
function writeAtomic(file, content) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, content, null, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
    return
  } catch {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch {}
    writeFileSync(file, content, 'utf8')
  }
}

/**
 * 写一份源码（新增或整份覆盖）。
 *
 * 顺序：判路径 → 判禁区 → 备份 → 写 → 留写入事实。
 * 备份**必须在写之前成功**（备份失败就整体失败），否则「有备份」这句话是假的。
 */
export function writeSource(root, input = {}) {
  const backupDir = String(input.backupDir || '')
  const full = resolveInside(root, input.path || '')
  if (!full) return { ok: false, code: 'outside', error: '只能写插件目录里的文件' }

  const rel = relativeOf(root, full)
  const existed = existsSync(full)
  if (existed && !readable(full)) return { ok: false, code: 'binary', error: '这个文件不是文本，写不了' }

  const content = String(input.content ?? '')
  if (!content.trim()) return { ok: false, code: 'empty', error: '内容是空的，不写' }
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > MAX_WRITE_BYTES) return { ok: false, code: 'too_big', error: `内容太大（${Math.round(bytes / 1024)}KB，上限 ${Math.round(MAX_WRITE_BYTES / 1024)}KB）` }

  const guarded = isProtected(root, full)
  if (guarded && input.force !== true) {
    return {
      ok: false,
      code: 'protected',
      error: `${rel} 是关键启动文件，默认不让改。确定要改就在参数里带 force=true —— 但改坏了插件会起不来。`,
    }
  }

  let backup = null
  try {
    mkdirSync(path.dirname(full), { recursive: true })
    if (existed && backupDir) {
      backup = backupTo(backupDir, root, full)
      // 备份没做成就不要动原文件。
      // 本文件开头写着「备份必须在写之前成功，否则『有备份』这句话是假的」，
      // 而 backupTo 内部是吞异常的（失败返回 null）—— 这里不判 null，那句约定就只是注释。
      if (!backup) return { ok: false, code: 'no_backup', error: '改之前的备份没做成，所以这个文件一个字都没动' }
    }
    writeAtomic(full, content)
  } catch (error) {
    return { ok: false, code: 'io', error: `没写成：${error?.message || error}` }
  }
  return {
    ok: true,
    text: [existed ? `改好了：${rel}` : `新建了：${rel}`, backup ? `改之前备份在 ${backup}` : '', guarded ? '（这是关键启动文件，你带了 force）' : ''].filter(Boolean).join('\n'),
    data: { path: rel, bytes, backup, protected: guarded, created: !existed },
  }
}

/** restore：把最近一份备份放回去。写崩了自己之后唯一的后悔药必须能用 */
export function restoreBackup(root, input = {}) {
  const backupDir = String(input.backupDir || '')
  const full = resolveInside(root, input.path || '')
  if (!full) return { ok: false, code: 'outside', error: '只能还原插件目录里的文件' }
  if (!backupDir || !existsSync(backupDir)) return { ok: false, code: 'no_backup', error: '还没有任何备份' }
  const prefix = relativeOf(root, full).replace(/[\\/:]/g, '__')
  let names = []
  try { names = readdirSync(backupDir).filter((name) => name.startsWith(`${prefix}.`) && name.endsWith('.bak')).sort() } catch { names = [] }
  if (!names.length) return { ok: false, code: 'no_backup', error: `这个文件没有备份：${relativeOf(root, full)}` }
  const file = path.join(backupDir, names[names.length - 1])
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, code: 'io', error: `备份读不动：${error?.message || error}` }
  }
  try {
    // 还原同样要原子：还原到一半被杀，等于把「唯一的后悔药」和原文件一起弄坏
    writeAtomic(full, text)
  } catch (error) {
    return { ok: false, code: 'io', error: `没还原成功：${error?.message || error}` }
  }
  return { ok: true, text: `还原好了：${relativeOf(root, full)} ← ${path.basename(file)}`, data: { path: relativeOf(root, full), from: file } }
}

/**
 * 跑一条命令。白名单 node / npm / npx，参数数组直传（不经 shell）。
 *
 * 为什么要白名单而不是「什么都能跑」：这里是让模型**验证**自己的改动能不能成立
 * （跑测试、跑一下某个文件、看版本号），不是给它一台终端。
 * 一个 `rm -rf` 或者一次 `npm publish` 都不是「调试」，也绝不该发生在这条路上。
 */
export async function runCommand(root, input = {}) {
  const bin = String(input.bin || 'node').toLowerCase()
  if (!BIN_NAME[bin]) return { ok: false, code: 'bin', error: `只能跑 ${Object.keys(BIN_NAME).join(' / ')}` }
  const args = Array.isArray(input.args) ? input.args.map((item) => String(item)) : []
  if (args.length > 12) return { ok: false, code: 'args', error: '参数最多 12 个' }
  for (const arg of args) {
    // 不经 shell 也就不会有 shell 行为，这些符号出现说明有人在试图拼接命令 —— 当成危险品挡掉
    if (/[;&|`$><\n\r]/.test(arg)) return { ok: false, code: 'unsafe', error: '参数里不能有 ; & | ` $ < > 这些符号' }
  }
  const cwdRel = String(input.cwd || '.').trim()
  const cwd = resolveInside(root, cwdRel)
  if (!cwd) return { ok: false, code: 'outside', error: '只能在插件目录里跑' }

  /**
   * 真正起哪个可执行文件。
   * node 直接起；npm / npx 换成 `node "<cli.js>"` —— 原因见 cliEntry 上方的说明。
   */
  let launcher = { file: BIN_NAME.node, prefix: [] }
  if (bin !== 'node') {
    const cli = cliEntry(bin)
    if (!cli) {
      return {
        ok: false,
        code: 'bin_missing',
        error: `这台机器上找不到 ${bin} 的入口（npm-cli.js）。先确认 Node 是完整安装包而不是精简版；临时也可以用 node 直接跑脚本。`,
      }
    }
    launcher = { file: process.execPath, prefix: [cli] }
  }

  const timeoutMs = Math.max(1000, Math.min(120_000, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS))
  const started = Date.now()
  try {
    const { stdout, stderr } = await execFileAsync(launcher.file, [...launcher.prefix, ...args], {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: process.env.PATH || '',
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        TZ: 'Asia/Shanghai',
        // 不给 HOME/USERPROFILE 指回用户目录：命令只应该在插件目录里活动
        NODE_ENV: '',
        // npm 内部要起 cmd 跑脚本、要按后缀找程序；少了这两个，
        // `npm test` 会在「明明跑得起来」的地方报一个看不懂的错
        ComSpec: process.env.ComSpec || 'C:\\Windows\\system32\\cmd.exe',
        PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      },
    })
    const out = trimText(String(stdout || '').trim(), MAX_OUTPUT_BYTES)
    const err = trimText(String(stderr || '').trim(), 2000)
    return {
      ok: true,
      text: [out, err ? `stderr:\n${err}` : ''].filter(Boolean).join('\n') || '跑完了，没有输出',
      data: { bin, args, ms: Date.now() - started, cwd: relativeOf(root, cwd), exit: 0 },
    }
  } catch (error) {
    const killed = error?.killed === true || /timed out/i.test(String(error?.message || ''))
    const out = trimText(String(error?.stdout || '').trim(), MAX_OUTPUT_BYTES)
    const err = trimText(String(error?.stderr || error?.message || '').trim(), 2000)
    return {
      ok: false,
      code: killed ? 'timeout' : 'failed',
      text: [killed ? `超过 ${Math.round(timeoutMs / 1000)} 秒没跑完，已经掐掉` : `退出码 ${error?.code ?? '非 0'}`, out, err].filter(Boolean).join('\n'),
      data: { bin, args, ms: Date.now() - started, exit: Number(error?.code) || -1, timedOut: killed },
    }
  }
}

/** 面板/调试用：这一层当前认定的根目录与禁区清单 */
export function describe(root) {
  return {
    root: path.resolve(root),
    readableExts: [...READABLE_EXTS],
    skipDirs: [...SKIP_DIRS],
    protected: PROTECTED.map((re) => String(re)),
    bins: Object.keys(BIN_NAME),
    limits: { ...LIMITS },
  }
}
