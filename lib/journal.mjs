/**
 * lib/journal.mjs — 所有「时间序 append-only 记录」的唯一底座。
 *
 * 谁用它：思维链（cot）、审计（audit）、事件（events）、行为（behaviors）、
 * 沙箱运行（runs）。这五份记录形态完全一样：一行一条 JSON，只会越写越长，
 * 用户会想往回翻。
 *
 * 为什么要统一（旧版的两个真实毛病）：
 *   1. cot.json 存成一个数组，配置上限 100 条 —— 满了就挤掉最老的。
 *      于是「他/她为什么这么回」看完就永久没了，想翻昨天的也翻不到。
 *   2. audit.jsonl 是追加文件，但读取只支持「尾部 N 条」，没有游标，
 *      1781 条记录里只能看到最新 200 条，再往前一步都走不了。
 *   两者本该是同一种东西。
 *
 * 契约（五个方法）：
 *   append(record)                    追加一条
 *   read({ before, limit, filter })   按游标往回翻
 *   count(filter)                     数一遍（统计用，不能被分页上限截断）
 *   stats()                           条数 / 起止时间 / 体积
 *   trim()                            清掉超过保留期的轮转文件
 *
 * 游标设计：`<fileIndex>:<lineNo>:<anchor>`。
 *   fileIndex 0 = 当前主文件，1 = 上一个轮转文件，2 = 更老的。
 *   append-only 文件里行号是稳定的，所以游标永远指向同一条记录，
 *   哪怕这中间又追加了几百条。这比「用时间戳当游标」可靠——
 *   同一个毫秒内可能写进好几条，时间戳会翻页翻漏。
 *
 *   但**文件序号会变**：轮转发生时，file0 改名成 file1，所有序号整体后移。
 *   实测：翻页翻到一半撞上轮转，会重复读到 20 条 —— 因为游标里的 fileIndex
 *   还指着轮转前的那个编号。所以游标额外带一个 anchor：那一层文件**第一条记录的
 *   时间戳**。它是内容的一部分，会跟着文件一起搬家，翻页时用它重新定位，
 *   序号怎么变都能找回来。找不到（文件已被清掉）就明确返回空页，
 *   而不是猜一个位置接着读 —— 宁可说「没有更早的了」。
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'

/** 单个文件上限。8MB ≈ 一万多条审计，够翻很久也不会一次读爆内存 */
const MAX_BYTES = 8 * 1024 * 1024
/** 保留几个轮转文件（.1 / .2 / .3）。4 份 × 8MB ≈ 两三个月 */
const MAX_ROTATIONS = 3

export class Journal {
  /**
   * 已解析的行按「文件序号」缓存。
   *
   * 为什么必须缓存：面板每开一次要走 status() / stats() / read() / count()，
   * 每次都会把同一个 jsonl 整份读出来再 JSON.parse —— 一份 60 万事件的事件流
   * 被解析四五遍，用户看到的是「点开面板卡一下」。它是只追加文件，内容不会变，
   * 唯一会变的信号是文件大小与修改时间；用这两个数当指纹，变了才重读。
   *
   * 上限是刻意的：缓存的是解析后的对象，比原文占内存得多。
   * 超过预算就丢最老的一份（轮转文件序号大 = 更老），宁可重读也不把内存吃满。
   */
  #cache = new Map()
  static #ROW_BUDGET = 60_000
  static #FILE_ROW_CAP = 25_000

  /**
   * 主文件的常驻写句柄。`-1` = 还没打开 / 已关闭。
   *
   * 为什么值得留一个句柄：`appendFileSync` 每写一行都要 open + write + close，
   * 本机实测 **0.573 ms/条**；同一个文件用常驻句柄 `writeSync` 是 **0.014 ms/条**，
   * 差 40 倍。而这份底座被五份记录共用（事件 / 审计 / 行为 / 思维链 / 沙箱运行），
   * 一轮对话要写五六条 —— 一次回复光记账就花掉两三毫秒，全花在开关文件上。
   *
   * 为什么敢常驻：这几份文件是 **append-only**，不存在「读到别人写了一半的位置」；
   * 追加语义（O_APPEND）由 openSync 的 'a' 保证，两个进程同时写也不会互相截断。
   * 轮转时必须先关掉再改名 —— 句柄跟着 inode 走，改名之后继续写会把新记录写进
   * 已经变成 `.1` 的旧文件里。
   */
  #fd = -1
  /** 主文件的当前体积（自己记账）。-1 = 未知（句柄没开、或刚轮转过还没问过） */
  #size = -1

  /**
   * @param {object} options
   * @param {string} options.dir        数据目录
   * @param {string} options.name       文件名（不带扩展名），如 'cot' / 'audit'
   * @param {() => number} [options.now]
   * @param {number} [options.maxBytes]
   * @param {number} [options.maxRotations]
   */
  constructor(options = {}) {
    this.dir = String(options.dir || '.')
    this.name = String(options.name || 'journal')
    this.now = options.now || (() => Date.now())
    this.maxBytes = Number(options.maxBytes) || MAX_BYTES
    this.maxRotations = Math.max(1, Number(options.maxRotations) || MAX_ROTATIONS)
  }

  file(index = 0) {
    const base = path.join(this.dir, `${this.name}.jsonl`)
    return index === 0 ? base : `${base}.${index}`
  }

  ensureDir() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    } catch {}
  }

  /** 追加一条。写失败不抛：审计写不进去不该让主流程崩 */
  append(record) {
    this.ensureDir()
    const row = { ts: this.now(), ...record }
    const line = `${JSON.stringify(row)}\n`
    const bytes = Buffer.byteLength(line, 'utf8')
    try {
      let fd = this.#handle()
      // 写之前的体积：既用来判轮转，也用来判断「缓存和磁盘还是同一份」。
      // 用自己记的数（打开句柄时 fstat 过一次，之后每写一行加上去），不再每次 fstat ——
      // 每次 append 少一次系统调用，3000 条实测能再省三成。
      // 万一有别的进程也在写，这个数会偏小：偏小的后果只是轮转晚一点、
      // 以及缓存指纹对不上（下次读整份重解析一遍），不会写坏任何东西。
      let size = this.#size

      let rotated = false
      if (size >= 0 && size >= this.maxBytes) {
        // 必须先关句柄再改名：句柄跟着文件走，改名之后继续写，新记录会落进 .1
        this.#closeHandle()
        rotated = this.#rotateIfNeeded(true)
        fd = this.#handle()
        size = this.#size
      }

      if (fd >= 0) {
        writeSync(fd, line, null, 'utf8')
        this.#size = (size < 0 ? 0 : size) + bytes
      } else {
        // 句柄打不开（目录不可写、被别的进程独占…）：退回逐次开关的老路。
        // 慢一点，但「能写进去」比「快」要紧 —— 审计写不进去等于这件事没发生过。
        if (size < 0) {
          try { size = existsSync(this.file(0)) ? statSync(this.file(0)).size : 0 } catch { size = 0 }
        }
        appendFileSync(this.file(0), line, 'utf8')
        this.#size = size + bytes
      }

      // 只有「写之前缓存与磁盘确实是同一份」才敢把新行直接接上。
      // 接错的代价比不接大得多：不接只是下次读整份重解析一遍，
      // 接错会让缓存里多出一条磁盘上不存在的记录 —— 面板上直接多一行假账。
      const cached = this.#cache.get(0)
      if (cached && !rotated && cached.stamp === String(size)) {
        cached.rows.push(row)
        cached.stamp = String(size + bytes)
      }
      return { ok: true, row }
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) }
    }
  }

  /** 打开（或复用）主文件的写句柄。打不开返回 -1，调用方退回 appendFileSync */
  #handle() {
    if (this.#fd >= 0) return this.#fd
    try {
      this.#fd = openSync(this.file(0), 'a')
      this.#size = fstatSync(this.#fd).size
    } catch {
      this.#fd = -1
      this.#size = -1
    }
    return this.#fd
  }

  #closeHandle() {
    if (this.#fd < 0) return
    try { closeSync(this.#fd) } catch {}
    this.#fd = -1
    this.#size = -1
  }

  /**
   * 放掉常驻句柄。用例收尾、以及「要搬走数据目录」之前必须调：
   * 句柄开着时，别的进程（备份、同步、杀毒）可能读得到写不到。
   * 生产路径不强制调 —— 进程退出时由系统回收。
   */
  close() {
    this.#closeHandle()
  }

  /**
   * @param {boolean} [checked] 调用方已经确认「该轮转了」。
   *        自己判的话要多两次系统调用（existsSync + statSync），
   *        而 append 手里已经有一个 fstat 出来的体积 —— 别重复问一遍。
   * @returns {boolean} 这次是否发生了轮转。
   * 轮转会让「文件序号 → 文件」整体错位，缓存随之作废；调用方据此决定还能不能接着用旧缓存。
   */
  #rotateIfNeeded(checked = false) {
    const main = this.file(0)
    if (!checked) {
      try {
        if (!existsSync(main)) return false
        if (statSync(main).size < this.maxBytes) return false
      } catch {
        return false
      }
    }
    // 先作废缓存：下面每一步都可能失败，缓存不能停留在错位的序号上
    this.#cache.clear()
    // 从最老的开始挪：先删尾，再逐个改名，最后把主文件挪到 .1
    try {
      const oldest = this.file(this.maxRotations)
      if (existsSync(oldest)) unlinkSync(oldest)
    } catch {}
    for (let i = this.maxRotations - 1; i >= 1; i -= 1) {
      const from = this.file(i)
      const to = this.file(i + 1)
      try {
        if (existsSync(from)) renameSync(from, to)
      } catch {}
    }
    try {
      renameSync(main, this.file(0 + 1))
    } catch {}
    return true
  }

  /**
   * 文件的「内容指纹」。
   *
   * 只用体积，不用「体积 + 修改时间」：这些文件是 append-only，
   * 内容变化必然伴随体积变化；而体积有个额外的好处 —— 追加完之后
   * 调用方**算得出来**（写之前多大 + 这一行多少字节），不必再 stat 一次。
   * 带上 mtime 就必须回磁盘问一遍，那条「写完直接接上缓存」的快路径也就没了。
   */
  #stamp(index) {
    try {
      const info = statSync(this.file(index))
      return String(info.size)
    } catch {
      return ''
    }
  }

  /** 缓存一份解析结果；超预算时先丢更老的轮转文件（序号大 = 更老） */
  #remember(index, stamp, rows) {
    if (!rows.length) return
    if (rows.length > Journal.#FILE_ROW_CAP) return
    let total = 0
    for (const entry of this.#cache.values()) total += entry.rows.length
    const older = [...this.#cache.keys()].filter((key) => key !== index).sort((a, b) => b - a)
    for (const key of older) {
      if (total + rows.length <= Journal.#ROW_BUDGET) break
      total -= (this.#cache.get(key)?.rows.length || 0)
      this.#cache.delete(key)
    }
    if (total + rows.length > Journal.#ROW_BUDGET) return
    this.#cache.set(index, { stamp, rows })
  }

  /** 读成行数组（已解析）。坏行跳过，不因为一行脏数据整页空掉 */
  #lines(index) {
    const stamp = this.#stamp(index)
    if (!stamp) return []
    const cached = this.#cache.get(index)
    if (cached && cached.stamp === stamp) return cached.rows
    let raw = ''
    try {
      raw = readFileSync(this.file(index), 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {}
    }
    this.#remember(index, stamp, out)
    return out
  }

  /**
   * 已有的最大轮转层。
   *
   * 从 0 号往上找，第一个「不存在」就停：绝大多数数据目录里只有主文件，
   * 这样两三次系统调用就够。老写法是从最老的一层往下找，无论有几个文件
   * 都要问满 maxRotations + 1 次 —— 而 count / stats / read 每次都要调它，
   * 面板刷新一次就问好几遍。Windows 上「问一个不存在的文件」并不便宜（约 40µs）。
   */
  #depth() {
    if (!existsSync(this.file(0))) return 0
    let last = 0
    for (let i = 1; i <= this.maxRotations; i += 1) {
      if (!existsSync(this.file(i))) break
      last = i
    }
    return last
  }

  /** 一层文件的「内容锚」：第一条记录的时间戳。轮转时它跟着文件走，序号不跟 */
  #anchorOf(index) {
    const first = this.#lines(index)[0]
    return first && first.ts !== undefined && first.ts !== null ? String(first.ts) : ''
  }

  /** 按锚找现在这一层是第几号文件；找不到返回 -1 */
  #findByAnchor(anchor, depth) {
    for (let i = 0; i <= depth; i += 1) {
      if (this.#anchorOf(i) === String(anchor)) return i
    }
    return -1
  }

  /**
   * 按游标往回翻。
   * @param {object} [options]
   * @param {string} [options.before]  上一页返回的 nextBefore；不传 = 从最新开始
   * @param {number} [options.limit]
   * @param {(row: object) => boolean} [options.filter]
   * @param {number} [options.maxScan] 最多翻多少行就收手（过滤条件很稀时必须给，否则等于扫全表）
   * @returns {{ rows: object[], nextBefore: string, hasMore: boolean }}
   */
  read(options = {}) {
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 50))
    const filter = typeof options.filter === 'function' ? options.filter : null
    const maxScan = Number.isFinite(Number(options.maxScan)) ? Math.max(1, Number(options.maxScan)) : Infinity
    const start = decodeCursor(options.before)
    const depth = this.#depth()

    // 起点：没给游标就从最新文件的末尾开始
    let fileIndex = start ? start.fileIndex : 0
    let lineNo = start ? start.lineNo : Infinity

    // 游标带锚时，按锚重新定位：轮转会让文件序号整体后移，序号不可信，内容可信
    if (start && start.anchor) {
      const moved = this.#findByAnchor(start.anchor, depth)
      if (moved < 0) {
        // 那一层已经被 trim 掉了：比它更早的记录不复存在，如实说「没有了」
        return { rows: [], nextBefore: null, hasMore: false }
      }
      fileIndex = moved
    }

    if (fileIndex > depth) {
      // 游标指向的文件已经被轮转清掉了：从最老的一份开头重新开始
      fileIndex = depth
      lineNo = Infinity
    }

    const rows = []
    let hasMore = false
    let cursorFile = 0
    let cursorLine = 0
    let scanned = 0

    // 标签跳出：需要在循环外拿到「下一条还没读的行号」，
    // 直接用 loop 变量会在块作用域外失效（这里出过一次死循环的坑）。
    scan: while (fileIndex <= depth) {
      const lines = this.#lines(fileIndex)
      // 第一次用 Infinity 表示「从尾部开始」
      if (lineNo === Infinity) lineNo = lines.length
      lineNo = Math.min(lineNo, lines.length)
      for (let i = lineNo - 1; i >= 0; i -= 1) {
        const row = lines[i]
        scanned += 1
        if (filter && !filter(row)) {
          // 扫到头了但一条都没匹配上：把游标停在下一行，别让下次从同一段重扫
          if (scanned >= maxScan) {
            hasMore = true
            cursorFile = fileIndex
            cursorLine = i
            break scan
          }
          continue
        }
        if (rows.length >= limit) {
          // 这一条这次读不下了：下一页从它开始，而不是从本轮起点重读
          hasMore = true
          cursorFile = fileIndex
          cursorLine = i + 1
          break scan
        }
        rows.push(row)
        if (scanned >= maxScan) {
          // 已经读够扫描上限：本条算本页，下一条开始下一页
          hasMore = true
          cursorFile = fileIndex
          cursorLine = i
          break scan
        }
      }
      fileIndex += 1
      lineNo = Infinity
    }

    // 没有下一页时游标必须是 null，不能给 "0:0" ——
    // 前端只要把 "0:0" 回传，就会从最老的文件重新读一遍，出现重复行。
    const next = hasMore ? encodeCursor(cursorFile, cursorLine, this.#anchorOf(cursorFile)) : null
    return { rows, nextBefore: next, hasMore }
  }

  /**
   * 数一遍（可以带条件）。统计必须走这里，不能拿 read({limit:500}).rows.length 顶替 ——
   * 那样「今天 800 条」会显示成 500 条，面板上的数字就开始骗人。
   *
   * @param {(row: object) => boolean} [filter]
   * @returns {number}
   */
  count(filter) {
    const depth = this.#depth()
    let total = 0
    for (let i = 0; i <= depth; i += 1) {
      const lines = this.#lines(i)
      if (!filter) {
        total += lines.length
        continue
      }
      for (const row of lines) if (filter(row)) total += 1
    }
    return total
  }

  /**
   * 把每一行过一遍（不构造数组、不分页）。
   *
   * 为什么要有它：面板上「今天跑了几次 / 这一小时几次」这种统计，以前是
   * 分别调 `count(filter)` 两三次 —— 每次都要把整份记录从头走到尾。
   * 2 万条记录时，两次就是 2ms，而这个时间是**同步**花掉的：
   * Node 只有一个线程，面板在算账的那几毫秒里，收消息、发消息全都停着。
   * 一次遍历算完所有数，就把这笔钱省下来了。
   *
   * fn 返回 false 可以提前收手（统计到上限就不必再数）。
   */
  forEach(fn) {
    const depth = this.#depth()
    for (let i = 0; i <= depth; i += 1) {
      for (const row of this.#lines(i)) {
        if (fn(row) === false) return
      }
    }
  }

  /** 统计：条数、起止时间、体积。给总览页与「能翻多久」提示用 */
  stats() {
    const depth = this.#depth()
    let count = 0
    let oldest = null
    let newest = null
    let bytes = 0
    for (let i = 0; i <= depth; i += 1) {
      const lines = this.#lines(i)
      count += lines.length
      if (lines.length) {
        // 文件从旧到新：i 越大越旧
        const first = lines[0]
        const last = lines[lines.length - 1]
        if (first && first.ts) oldest = oldest === null ? first.ts : Math.min(oldest, first.ts)
        if (last && last.ts) newest = newest === null ? last.ts : Math.max(newest, last.ts)
      }
      try {
        bytes += statSync(this.file(i)).size
      } catch {}
    }
    return { count, oldest, newest, bytes, files: depth + 1 }
  }

  /** 按天清理：轮转文件超过保留天数就删掉（主文件不删，只靠 maxBytes 轮转） */
  trim(options = {}) {
    const keepDays = Math.max(1, Number(options.keepDays) || 30)
    const cutoff = this.now() - keepDays * 24 * 60 * 60 * 1000
    const removed = []
    for (let i = 1; i <= this.maxRotations; i += 1) {
      const file = this.file(i)
      try {
        if (!existsSync(file)) continue
        if (statSync(file).mtimeMs < cutoff) {
          unlinkSync(file)
          removed.push(i)
        }
      } catch {}
    }
    return { removed }
  }
}

export function encodeCursor(fileIndex, lineNo, anchor) {
  const base = `${Math.max(0, Number(fileIndex) || 0)}:${Math.max(0, Number(lineNo) || 0)}`
  const tag = anchor === undefined || anchor === null || anchor === '' ? '' : `:${String(anchor)}`
  return `${base}${tag}`
}

export function decodeCursor(value) {
  if (!value) return null
  const match = /^(\d+):(\d+)(?::([^:]+))?$/.exec(String(value))
  if (!match) return null
  return { fileIndex: Number(match[1]), lineNo: Number(match[2]), anchor: match[3] || '' }
}
