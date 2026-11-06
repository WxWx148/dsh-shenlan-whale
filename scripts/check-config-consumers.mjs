/**
 * scripts/check-config-consumers.mjs — 这份文件管「哪些开关现在是空转的」。
 *
 * 为什么需要它：
 *   面板把每个配置键都摆出来让人改。只要有哪个键没有任何代码去读，
 *   用户改了就是白改 —— 界面上一切正常，行为上毫无变化。
 *   这是最难自查的一类问题：测试全绿（因为没测「改了会怎样」），
 *   用户也只是觉得「好像没什么用」，说不清哪里不对。
 *
 * 判定方法（刻意保守）：
 *   把 `guard.firstDelayMs` 这样的键拆成「父名 + 叶子名」，
 *   在除 config/panel 之外的源码里找 `guard?.firstDelayMs` 或 `guard.firstDelayMs`。
 *   找到就算有人读。宁可漏报（少列几个），不要误报（乱指一堆）。
 *
 * 输出分两类：
 *   · 有人读 —— 正常
 *   · 没人读 —— 功能还没接上，面板上应该标出来，而不是假装能用
 *
 * 退出码永远是 0：功能没接上不是错误，是需要被看见的事实。
 * 让构建失败的话，这个提示很快就会被人用 `|| true` 灭掉。
 */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULTS } from '../lib/config.mjs'
import { PENDING_KEYS } from '../lib/panel.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const LIB = path.join(ROOT, 'lib')

/**
 * 这三个文件不算「有人读」：
 *   config.mjs / panel.mjs —— 本来就只是把键列出来；
 *   panel-view.mjs —— 展示层，只把值取出来渲染成文字给人看，
 *                     不代表有代码照着这个值去执行。
 * 把展示层也算成「有人读」会骗人：沙箱那几个限额明明没有执行器去执行，
 * 却因为详情页读出来显示了一下，就被判成「改了有用」，界面便不再标
 * 「还没接上」。用户改完看到「已保存」就以为生效，实际风平浪静 ——
 * 这正是本脚本要抓的那类问题。展示读取必须排除。
 */
const SKIP = new Set(['config.mjs', 'panel.mjs', 'panel-view.mjs'])

/** 把 DEFAULTS 摊平成 a.b.c */
export function flattenKeys(input, prefix = '', out = []) {
  for (const [key, value] of Object.entries(input || {})) {
    const dotted = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenKeys(value, dotted, out)
    else out.push(dotted)
  }
  return out
}

/**
 * 扫出没人读的键。
 * 同时认三种写法：`a?.b`、`a.b`、`b:`（对象字面量）。注释先剥掉，
 * 否则「注释里提了一句」会被当成有人读。
 */
export function scanIdle(libDir = LIB) {
  // 递归收集，不能只看顶层：`lib/channel/onebot.mjs` 曾经整个是盲区，
  // 通道明明读了 wsUrl / token / selfId，扫描结果却说「没人读」。
  // 照着一份错清单去改代码，比没有清单更浪费时间。
  const collect = (dir, prefix = '') => {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        out.push(...collect(path.join(dir, entry.name), rel))
      } else if (entry.name.endsWith('.mjs') && !SKIP.has(entry.name)) {
        out.push({
          name: rel,
          code: readFileSync(path.join(dir, entry.name), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, ''),
        })
      }
    }
    return out
  }
  const sources = collect(libDir)
  // 入口文件也算「有人读」：很多键（掉线自愈、主动行为、日志脱敏）的消费者就在 index.js 里，
  // 只扫 lib/ 会把它们全判成空转 —— 照着一份偏大的清单去改代码，比没有清单更浪费时间。
  try {
    sources.push({
      name: 'index.js',
      code: readFileSync(path.join(ROOT, 'index.js'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    })
  } catch {
    // 入口读不到就按原来的口径报，不因此让审计失败
  }

  /**
   * 这些叶子名太常见，`enabled:` / `port:` 在任何对象字面量里都会出现，
   * 拿它当证据会把「没人读」误判成「有人读」。对它们只认父名限定的写法
   * （`channel.enabled` / `channel?.enabled`），宁可漏报也不误报。
   */
  const GENERIC_LEAVES = new Set([
    'enabled', 'disabled', 'port', 'token', 'mode', 'level', 'url', 'path', 'name',
    'text', 'value', 'size', 'file', 'host', 'type', 'key', 'id', 'min', 'max',
  ])

  /**
   * 「先把一组配置接出来，再按字段读」这种写法很常见：
   *     const cfg = runtime.config.proactive || {}
   *     if (cfg.hotNews === true) …
   * 上面那套按父名匹配只认 `proactive.hotNews`，于是这 7 个键全被判成「没人读」——
   * 可它们明明有人读。一份总是多报的清单，用久了就没人看。
   * 所以这里先扫出「别名 → 组名」，再把 `cfg.hotNews` 也算成证据。
   */
  const aliases = new Map()
  for (const source of sources) {
    const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[^\n=]*?config\??\.([A-Za-z_$][\w$]*)/g
    let match = re.exec(source.code)
    while (match) {
      const [, alias, group] = match
      if (group !== alias) {
        if (!aliases.has(group)) aliases.set(group, new Set())
        aliases.get(group).add(alias)
      }
      match = re.exec(source.code)
    }
  }

  const has = (key) => {
    const parts = key.split('.')
    const leaf = parts[parts.length - 1]
    const parent = parts.length > 1 ? parts[parts.length - 2] : ''
    const patterns = []
    if (parent) {
      patterns.push(new RegExp(`${parent}\\?\\.${leaf}\\b`))
      patterns.push(new RegExp(`${parent}\\.${leaf}\\b`))
      for (const alias of aliases.get(parent) || []) {
        // cfg.x / cfg?.x 两种都要认（`\??` 是「有没有问号都行」，
        // 写成 `\?{1,2}` 就变成「至少一个问号」，`cfg.x` 反而匹配不上）
        patterns.push(new RegExp(`\\b${alias}\\??\\.${leaf}\\b`))
      }
    }
    if (!GENERIC_LEAVES.has(leaf)) patterns.push(new RegExp(`\\b${leaf}\\s*:`))
    return sources.some((source) => patterns.some((re) => re.test(source.code)))
  }

  const keys = flattenKeys(DEFAULTS)
  return { keys, idle: keys.filter((key) => !has(key)) }
}

function main() {
  const { keys, idle } = scanIdle()
  console.log(`配置消费者：${keys.length} 个键，${keys.length - idle.length} 个有人读，${idle.length} 个没人读`)

  if (!idle.length) {
    console.log('\n每个开关都有人读，面板上没有空转项。')
    return
  }

  console.log('\n没人读（面板上改了也没反应，对应功能还没接上）：')
  const groups = new Map()
  for (const key of idle) {
    const top = key.split('.')[0]
    if (!groups.has(top)) groups.set(top, [])
    groups.get(top).push(key)
  }
  for (const [top, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${top} (${list.length})：${list.map((k) => k.split('.').slice(1).join('.') || k).join(' · ')}`)
  }
  console.log('\n处理原则：接了执行器就自然会有人读；在那之前，面板上要标「还没接上」，')
  console.log('不能让人以为改了有用。')
  // 面板口径与扫描口径**不要求完全一致**：扫描认不出 `cfg.watchdogEnabled` 这类写法，
  // 所以它只会多报、不会少报。把差异打出来，比让两边各说各话强。
  console.log(`\n面板口径：PENDING_KEYS 标了 ${PENDING_KEYS.length} 项（人工确认过）`)
  const idleSet = new Set(idle)
  const confirmed = new Set(PENDING_KEYS)
  const unmarked = idle.filter((key) => !confirmed.has(key))
  const overMarked = PENDING_KEYS.filter((key) => !idleSet.has(key))
  if (unmarked.length) console.log(`  扫描到但没标：${unmarked.join(' · ')}\n    （多数是 \`cfg.xxx\` 形式的读取，扫描认不出；确认有人读就不该标）`)
  if (overMarked.length) console.log(`  标了但扫描认为有人读：${overMarked.join(' · ')}\n    （多为 \`enabled:\` / \`port:\` 这种泛化字段名命中的假阳性；人工确认后以 PENDING_KEYS 为准）`)
}

// 用 pathToFileURL 而不是手拼：Windows 上手拼会少一个斜杠，导致直接运行时一声不响
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

