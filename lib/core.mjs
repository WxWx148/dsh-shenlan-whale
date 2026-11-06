/**
 * lib/core.mjs — 磁盘这一层：读配置、原子写、开日志。
 *
 * 为什么「原子写」要单独一层：
 *   旧版直接 writeFileSync(config.json)。进程在写一半时被杀（重启、崩溃、断电），
 *   文件就剩下半个 JSON —— 下次启动读不动，插件直接起不来，用户只能手删重配。
 *   这里一律「写临时文件 → fsync → rename」，rename 在同一分区上是原子的，
 *   要么是旧内容，要么是新内容，不会出现第三种。
 *
 * 纪律：本模块只碰磁盘，不做业务判断；业务逻辑在 runtime.mjs。
 */

import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import path from 'node:path'
import { Journal } from './journal.mjs'
import { DEFAULTS, clone, migrate, report } from './config.mjs'

/**
 * 把读不动的文件留一份原件。
 *
 * 为什么必须有：能「回退到默认值启动」不等于「没损失」。
 * 用户手改过的 60 个键、攒了三个月的权重历史，只要下一次 save 一写，
 * 原件就永久没了，而且没有任何痕迹说明它曾经存在过。
 * 备份放同目录，名字带时间戳，出事时能直接拿回来比对。
 */
export function backupCorrupt(file, at = Date.now()) {
  try {
    if (!existsSync(file)) return ''
    const stamp = new Date(Number(at) || Date.now()).toISOString().replace(/[:.]/g, '-')
    const target = `${file}.bad-${stamp}`
    copyFileSync(file, target)
    return target
  } catch {
    return ''
  }
}

/**
 * 整份日志读不动时，把它挪走，让新记录能从干净的文件重新开始。
 *
 * 为什么必须"挪走"而不只是"备份"：
 *   append 是往文件末尾追加。文件里全是二进制垃圾时，新写进去的每一行
 *   都排在垃圾后面 —— 读的时候一路跳过，等于从此彻底失聪，而且一句报错都没有。
 *   挪走原件（不删）之后，下次 append 会建新文件，历史还能人工翻。
 *
 * 只处理「一行都读不出、但文件非空」这一种。部分坏行的文件照旧跳过坏行继续用。
 *
 * @returns {string} 挪到哪了；没挪返回空串
 */
export function quarantineIfCorrupt(journal, at = Date.now()) {
  try {
    if (!journal || typeof journal.stats !== 'function' || typeof journal.file !== 'function') return ''
    const stats = journal.stats()
    if (!(stats.count === 0 && stats.bytes > 0)) return ''
    const file = journal.file(0)
    if (!existsSync(file)) return ''
    const stamp = new Date(Number(at) || Date.now()).toISOString().replace(/[:.]/g, '-')
    const target = `${file}.bad-${stamp}`
    renameSync(file, target)
    return target
  } catch {
    return ''
  }
}

/** 缺文件 / 坏 JSON 一律回退，不抛 —— 一个坏文件不该让插件起不来 */export function readJson(file, fallback = null) {
  try {
    if (!existsSync(file)) return { ok: true, value: clone(fallback), missing: true }
    const text = readFileSync(file, 'utf8')
    if (!text.trim()) return { ok: true, value: clone(fallback), missing: true }
    return { ok: true, value: JSON.parse(text), missing: false }
  } catch (error) {
    return { ok: false, value: clone(fallback), error: error?.message || String(error) }
  }
}

/** 原子写：临时文件 → fsync → rename */
export function writeJson(file, value) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`)
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const text = `${JSON.stringify(value, null, 2)}\n`
    const fd = openSync(tmp, 'w')
    try {
      writeSync(fd, text, null, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
    return { ok: true }
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {}
    return { ok: false, error: error?.message || String(error) }
  }
}

/** 数据目录里的标准路径，别在十个地方各拼一次字符串 */
export function paths(dir) {
  const root = String(dir || '.')
  return {
    root,
    config: path.join(root, 'config.json'),
    evolve: path.join(root, 'evolve.json'),
    health: path.join(root, 'health.json'),
    induction: path.join(root, 'induction.json'),
    // 「学到哪了」。单独一个文件，因为它管的是**进度**，不是结果：
    // 和 induction.json（最近怎么样）混在一起，两边都会变得难解释。
    reflectCursor: path.join(root, 'reflect-cursor.json'),
    // 技能簿：开关状态、教过的、各自的成功次数。
    // 单独一个文件，因为它记的是**能力清单**，和权重（学得好不好）是两件事：
    // 权重可以回滚重学，教过的技能丢了就要用户再说一遍。
    skills: path.join(root, 'skills.json'),
    events: path.join(root, 'events.jsonl'),
    behaviors: path.join(root, 'behaviors.jsonl'),
    cot: path.join(root, 'cot.jsonl'),
    audit: path.join(root, 'audit.jsonl'),
    runs: path.join(root, 'sandbox', 'runs.jsonl'),
  }
}

/** 五份 append-only 记录共用同一个底座 */
export function openJournal(dir, name, options = {}) {
  return new Journal({ dir, name, ...options })
}

/**
 * 读配置：读 → 迁移 → （调用方决定要不要落盘）。
 * 迁移结果里带着 filled / dropped / repaired，启动时写一条审计。
 */
export function loadConfig(dir) {
  const file = paths(dir).config
  const read = readJson(file, DEFAULTS)
  // 读不动就先留原件，再谈回退 —— 顺序反了就等于把原件盖掉
  const backup = read.ok ? '' : backupCorrupt(file)
  const result = migrate(read.value)
  return {
    config: result.config,
    report: report(result),
    filled: result.filled,
    dropped: result.dropped,
    repaired: result.repaired,
    recovered: read.ok === false,
    readError: read.ok ? '' : read.error,
    backup,
    file,
  }
}

/** 保存配置（先和默认值对齐，再原子写） */
export function saveConfig(dir, config) {
  const { config: normalized } = migrate(config)
  return writeJson(paths(dir).config, normalized)
}

export { DEFAULTS }
