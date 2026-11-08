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
 * 局限（必须说清，否则这份报告会骗人）：
 *   「有人读」只证明代码里出现过这个键，**不能证明改了它行为会变**。
 *   net.allowlist 以前只被 skill.mjs 的能力声明和 tools.mjs 的自述文案读过，
 *   扫描照样报「有人读」，可界面拨了白名单，联网请求一个都没被拦；
 *   net.quotaPerHour 同理，界面写 60，工具里写死 30。
 *   所以另有一张「行为闸名册」（BEHAVIOR_GATES）：记的是真正拦请求、改节奏、
 *   切分支的那个执行处，由 tests/live-switches.test.mjs 逐项跑「改值 → 行为变」。
 *   静态扫描 + 行为闸名册，两样都看，才敢说「这个开关落到实处了」。
 *
 * 退出码永远是 0：功能没接上不是错误，是需要被看见的事实。
 * 让构建失败的话，这个提示很快就会被人用 `|| true` 灭掉。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULTS, PENDING_KEYS } from '../truth/index.mjs'
import { PARENTS } from '../lib/blueprint.mjs'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 扫描根目录从结构派生，不再手写 `lib/` 一个。
 *
 * 以前 channel/ base/ voice/ facts/ 里的消费者全都不在视野里 —— 通道明明
 * 读了 wsUrl / token / selfId，扫描结果却会说没人读。P1 每搬一个父模块，
 * 手写清单就要回来加一行，忘了没人发现。现在「目录存在就扫」，
 * 加父模块自动纳入，搬走模块也不会静默丢掉。
 */
const SCAN_DIRS = [
  'lib',
  ...PARENTS.filter((one) => existsSync(path.join(ROOT, one.dir))).map((one) => one.dir),
].filter((dir, index, all) => all.indexOf(dir) === index).map((dir) => path.join(ROOT, dir))

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
export function scanIdle(dirs = SCAN_DIRS) {
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
  const list = Array.isArray(dirs) ? dirs : [dirs]
  const sources = list.flatMap((dir) => collect(dir))
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
    } else {
      // 顶层键（例如 `modelProvider`）：没有父名可拼，只认 `config.modelProvider`。
      // 少了这一条，顶层键会被判成「没人读」—— 而它明明在 host 里被读了。
      patterns.push(new RegExp(`(?:config|cfg)\\??\\.${leaf}\\b`))
    }
    if (!GENERIC_LEAVES.has(leaf)) patterns.push(new RegExp(`\\b${leaf}\\s*:`))
    return sources.some((source) => patterns.some((re) => re.test(source.code)))
  }

  const keys = flattenKeys(DEFAULTS)
  return { keys, idle: keys.filter((key) => !has(key)) }
}

/**
 * 行为闸名册：这个键**真正改变行为**的地方在哪儿。
 *
 * 和 scanIdle() 的区别：那边是静态扫描，只要代码里出现过就算数；
 * 这边是人工核实过「读了以后真的拦了 / 真的换了分支」，并由
 * tests/live-switches.test.mjs 逐项跑「改值 → 行为变」。
 * 两张表要一起看：静态全绿 + 行为闸没登记 = 界面拨了开关，行为照旧。
 */
export const BEHAVIOR_GATES = Object.freeze({
  'memory.enabled': 'mind/memory.mjs enabled 闸（digest 与全部写入）',
  'memory.maxEntries': 'mind/memory.mjs configure / #trim',
  'net.allowlist': 'ability/web.mjs checkNet / domainAllowed（真实拦住每一次联网请求）',
  'net.quotaPerHour': 'ability/web.mjs takeSlot（替换掉原来写死的 30 次/小时）',
  'tools.whitelist': 'ability/tools.mjs call / prompt 的工具白名单',
  'tools.maxRounds': 'turn/index.mjs 工具环 maxRounds',
  'tools.maxPerRound': 'turn/index.mjs 工具环 picked.slice',
  'persona.verbosity': 'app/runtime.mjs styleOptions → voice/style.mjs styleGuide 语气分支',
  'persona.maxParts': 'mind/evolve.mjs styleParamsFor → splitBursts maxParts',
  'guard.perMinute': 'decide/guard.mjs check 每分钟闸',
  'guard.nightWindow': 'decide/guard.mjs quiet 夜间闸',
  'guard.replyQuotaPerHour': 'decide/guard.mjs check 每小时闸',
  'group.followUpMaxTurns': 'decide/attention.mjs maxTurns',
  'activity.enabled': 'index.js activityTimer 总开关',
  'activity.maxPerDay': 'index.js activityTimer 每日上限',
  'proactive.enabled': 'index.js proactiveTimer / digestTimer 总开关',
  'proactive.perDay': 'index.js proactiveTimer 每日上限',
  'proactive.minGapMinutes': 'index.js proactiveCadence 主动开口间隔下限',
  'proactive.maxGapMinutes': 'index.js proactiveCadence 主动开口间隔上限',
  'self.enabled': 'turn/index.mjs self_tune 自改闸 + ability/tools.mjs revise_persona 自主改人设闸',
  'self.rewriteCooldownHours': 'turn/index.mjs self_tune 冷却',
  'sandbox.mode': 'ability/sandbox.mjs 档位闸',
  'sandbox.dailyMax': 'ability/sandbox.mjs 每日限额',
  'sandbox.hourlyMax': 'ability/sandbox.mjs 每小时限额',
  'browser.maxPerHour': 'ability/browser.mjs browserQuota',
  'browser.allowPrivate': 'ability/browser.mjs checkTargetUrl',
  'images.maxPerMessage': 'turn/index.mjs 图片识别条数',
  'skills.autoOffAfterFails': 'ability/skill.mjs 连续失败自动关闭',
  'usage.inputPerM': 'facts/usage.mjs cost 单价',
  'usage.outputPerM': 'facts/usage.mjs cost 单价',
  'usage.budgetPerDay': 'turn/index.mjs #budgetGate（超预算真的停下）+ facts/usage.mjs overBudget（算超没超）',
  'log.redact': 'index.js 审计脱敏',
  'channel.enabled': 'index.js /config 变更后通道重连',
})

/** 这些是主人最常拨、也最容易「看着能改其实空转」的开关，必须都有行为闸 */
export const CRITICAL_SWITCHES = Object.freeze([
  'memory.enabled', 'net.allowlist', 'net.quotaPerHour', 'tools.whitelist',
  'tools.maxRounds', 'tools.maxPerRound', 'persona.maxParts', 'persona.verbosity',
  'guard.perMinute', 'guard.nightWindow', 'proactive.enabled', 'activity.enabled',
  'self.enabled', 'sandbox.mode', 'usage.budgetPerDay',
])

export function scanUngated() {
  return CRITICAL_SWITCHES.filter((key) => !BEHAVIOR_GATES[key])
}

function main() {
  const { keys, idle } = scanIdle()
  console.log(`配置消费者：${keys.length} 个键，${keys.length - idle.length} 个有人读，${idle.length} 个没人读`)
  console.log('注意：「有人读」只证明代码里出现过，不等于改了行为会变。')

  if (idle.length) {
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
  } else {
    console.log('静态扫描没发现「完全没人读」的键 —— 但请看下面的行为闸核实，别把这句当成全绿。')
  }
  // 面板口径与扫描口径**不要求完全一致**：扫描认不出 `cfg.watchdogEnabled` 这类写法，
  // 所以它只会多报、不会少报。把差异打出来，比让两边各说各话强。
  console.log(`\n面板口径：PENDING_KEYS 标了 ${PENDING_KEYS.length} 项（人工确认过）`)
  const idleSet = new Set(idle)
  const confirmed = new Set(PENDING_KEYS)
  const unmarked = idle.filter((key) => !confirmed.has(key))
  const overMarked = PENDING_KEYS.filter((key) => !idleSet.has(key))
  if (unmarked.length) console.log(`  扫描到但没标：${unmarked.join(' · ')}\n    （多数是 \`cfg.xxx\` 形式的读取，扫描认不出；确认有人读就不该标）`)
  if (overMarked.length) console.log(`  标了但扫描认为有人读：${overMarked.join(' · ')}\n    （多为 \`enabled:\` / \`port:\` 这种泛化字段名命中的假阳性；人工确认后以 PENDING_KEYS 为准）`)

  // 行为闸：这份才是「界面拨了开关，行为真的变」的依据
  const ungated = scanUngated()
  console.log(`\n行为闸核实：${Object.keys(BEHAVIOR_GATES).length} 项已登记执行处，${CRITICAL_SWITCHES.length} 项关键开关中 ${CRITICAL_SWITCHES.length - ungated.length} 项有闸`)
  if (ungated.length) console.log(`  缺闸：${ungated.join(' · ')}`)
  else console.log('  关键开关全部有闸；改值 → 行为变的断言见 tests/live-switches.test.mjs。')
  console.log('  本轮补上的两个空转项：net.allowlist（以前没有任何执行闸）、net.quotaPerHour（以前写死 30 次/小时）。')
}

// 用 pathToFileURL 而不是手拼：Windows 上手拼会少一个斜杠，导致直接运行时一声不响
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}

