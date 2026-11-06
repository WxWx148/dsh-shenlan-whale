/**
 * scripts/reconcile.mjs — 把深蓝鲸自己的账，和 DeepSeek 账户的真实余额对上。
 *
 * 为什么需要这个脚本：面板上「今天花了 ¥0.03」和充值后台「余额剩 ¥1.37」
 * 是两个不同口径的数字，直接相减必然对不上 —— 而说不清差在哪，
 * 就会得出「账本坏了」或「钱被吞了」这两种都不成立的结论。
 *
 * 这里做四件事，顺序不能换：
 *   1. 账实核对：审计里的每一条 usage 行 vs 账本上的汇总（同一个插件内部先自证）；
 *   2. 口径换算：把 token 按**真实**单价（分时 + 缓存命中）重算，给出金额区间；
 *   3. 余额锚点：查账户余额，并把这一次的数字存成基线，下次就能对「增量」；
 *   4. 差异归因：每一分钱的差额都落到一个可解释的类别上。
 *
 * 用法：
 *   node scripts/reconcile.mjs                 # 出对账单
 *   node scripts/reconcile.mjs --topup 2       # 声明账户累计充值，直接算出真实已用
 *   node scripts/reconcile.mjs --json          # 机器可读（给面板/自动化用）
 *   node scripts/reconcile.mjs --dir <数据目录> # 默认 ~/.dsh/shenlan-whale
 *
 * 不落任何密钥：Key 只在内存里用于一次余额查询，账本与基线里都不写。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const DIR = path.resolve(valueOf('dir', path.join(homedir(), '.dsh', 'shenlan-whale')))
const CREDENTIALS = path.join(homedir(), '.dsh', '.credentials.yaml')
const ANCHOR_FILE = path.join(DIR, 'reconcile.json')
const AS_JSON = flag('json')
const TOPUP = Number(valueOf('topup', '')) || 0

/**
 * 官方价（元 / 百万 token），2026-10 核对。
 *
 * 必须按「分时 + 缓存命中」两维拆开：只写一个均价，算出来的钱必然和账单差一截，
 * 而差的那一截恰好会被误判成「账本漏记」。
 * 高峰 = 周一至周五 09:00–12:00、14:00–18:00（北京时间），其余时段全价一半。
 */
const PRICES = {
  'deepseek-flash': {
    label: 'DeepSeek Flash',
    peak: { hit: 0.04, miss: 2, out: 8 },
    off: { hit: 0.02, miss: 1, out: 4 },
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro',
    peak: { hit: 0.3, miss: 9, out: 27 },
    off: { hit: 0.15, miss: 4.5, out: 13.5 },
  },
}

/** 插件配置里的固定单价（元/百万），账本上的 cost 就是按它算的 */
function configuredPrice(config) {
  return {
    input: Math.max(0, Number(config?.usage?.inputPerM) || 0),
    output: Math.max(0, Number(config?.usage?.outputPerM) || 0),
    currency: String(config?.usage?.currency || 'CNY'),
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function readJsonl(file) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

const dayKey = (at) => {
  const d = new Date(Number(at) || Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 北京时间的高峰时段：工作日 9–12、14–18。
 *
 * 必须按东八区算，不能按本机时区：官方价按北京时间分时，
 * 换一台设成 UTC 的机器跑这个脚本，峰谷就会整体错位 8 小时，
 * 算出来的钱会和账单对不上 —— 而这种错最难发现，因为数字看着都合理。
 */
function isPeak(at) {
  const bj = new Date((Number(at) || 0) + 8 * 3600_000)
  const weekday = bj.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = bj.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

const round = (value, digits = 6) => Number((Number(value) || 0).toFixed(digits))

/** 某次调用按官方价算：命中/未命中给出上下界 */
function officialCost(usage, model, at) {
  // 老账本里模型名被写成 "[object Object]"（模型对象没取到名字）。
  // 这些行的 token 是真的，不能因为标签坏了就不计价 —— 全站只用 Flash，
  // 就按 Flash 算，并单独标出「按默认模型推定」的次数，不冒充精确。
  const known = PRICES[model] ? model : 'deepseek-flash'
  const price = PRICES[known]
  if (!price) return null
  const table = isPeak(at) ? price.peak : price.off
  const input = Math.max(0, Number(usage.input) || 0)
  const output = Math.max(0, Number(usage.output) || 0)
  const outCost = (output * table.out) / 1_000_000
  return {
    low: (input * table.hit) / 1_000_000 + outCost,
    high: (input * table.miss) / 1_000_000 + outCost,
    peak: isPeak(at),
    assumed: known !== model,
    table,
  }
}

function main() {
  const config = readJson(path.join(DIR, 'config.json'), {})
  const ledger = readJson(path.join(DIR, 'usage.json'), { days: {}, total: null })
  const rows = readJsonl(path.join(DIR, 'audit.jsonl')).filter((row) => row?.kind === 'usage')
  const price = configuredPrice(config)

  // ── 1. 账实核对：审计逐行汇总 vs 账本 ──
  let auditInput = 0
  let auditOutput = 0
  let auditCost = 0
  const byDay = new Map()
  const byModel = new Map()
  const official = { low: 0, high: 0, peakCalls: 0, unknownModel: 0, priced: 0, assumed: 0 }
  for (const row of rows) {
    const input = Math.max(0, Number(row.input) || 0)
    const output = Math.max(0, Number(row.output) || 0)
    auditInput += input
    auditOutput += output
    auditCost += Number(row.cost) || 0
    const key = dayKey(row.at)
    const day = byDay.get(key) || { input: 0, output: 0, calls: 0, cost: 0 }
    day.input += input
    day.output += output
    day.calls += 1
    day.cost += Number(row.cost) || 0
    byDay.set(key, day)

    const model = String(row.model || '')
    byModel.set(model, (byModel.get(model) || 0) + 1)
    const priced = officialCost({ input, output }, model, row.at)
    if (!priced) official.unknownModel += 1
    else {
      official.low += priced.low
      official.high += priced.high
      official.priced += 1
      if (priced.assumed) official.assumed += 1
      if (priced.peak) official.peakCalls += 1
    }
  }

  const total = ledger.total || { input: auditInput, output: auditOutput, cost: auditCost, calls: rows.length, since: '' }
  const ledgerCalls = Number(total.calls) || 0

  // ── 2. 余额 ──
  const balance = readBalance()
  const anchor = readJson(ANCHOR_FILE, { baselines: [] })
  if (!Array.isArray(anchor.baselines)) anchor.baselines = []
  const previous = anchor.baselines[anchor.baselines.length - 1] || null

  // ── 3. 差异归因 ──
  // 充值额小于余额 = 输入的数不对（少填了、或期间又充过）。这时候算出负数比不给结果更糟：
  // 负数会被当成「真实消耗」，让整张表失去意义。
  const enoughTopup = TOPUP > 0 && balance.ok && TOPUP >= balance.total
  const realSpend = enoughTopup ? round(TOPUP - balance.total) : null
  const ledgerCost = round(Number(total.cost) || 0)
  const items = []

  items.push({
    id: 'scope',
    label: '范围差',
    amount: null,
    why: '余额是「账户剩余」，不是「插件花了」。两者之间还隔着 DSH 自己的调用（看图、其它会话）和历次充值 —— 不先把口径对齐，直接相减没有意义。',
  })
  if (official.priced) {
    items.push({
      id: 'price',
      label: '计价差',
      amount: round(ledgerCost - official.high),
      why: `账本用固定单价 ${price.input}/${price.output} 元每百万；官方是分时价 + 缓存命中价（Flash 闲时 ${PRICES['deepseek-flash'].off.miss}/${PRICES['deepseek-flash'].off.out}，高峰 ${PRICES['deepseek-flash'].peak.miss}/${PRICES['deepseek-flash'].peak.out}，命中仅 ${PRICES['deepseek-flash'].off.hit}/${PRICES['deepseek-flash'].peak.hit}）。同一批 token 换算法，金额最多能差一倍以上。`,
    })
  }
  const auditGap = rows.length - ledgerCalls
  if (auditGap !== 0) {
    items.push({
      id: 'ledger',
      label: '账实差',
      amount: round(auditCost - ledgerCost),
      why: `审计里有 ${rows.length} 条用量，账本记了 ${ledgerCalls} 次，差 ${auditGap} 次。账本按天切、只保留 90 天，且首次启用前没有本地账本（那段只留在审计里）—— 这段历史只能从审计补，不能从账本读。`,
    })
  }
  items.push({
    id: 'cache',
    label: '缓存口径',
    amount: null,
    why: 'DSH 的 usage 只给 input/output，不给「命中多少」。插件把 input 全按未命中价算，命中率高时必然高估 —— 这是当前最大的不可消除误差，要精确到分只能让宿主补 cacheReadTokens。',
  })

  const result = {
    at: Date.now(),
    dir: DIR,
    balance,
    ledger: {
      input: Number(total.input) || 0,
      output: Number(total.output) || 0,
      calls: ledgerCalls,
      cost: ledgerCost,
      since: String(total.since || ''),
      price,
    },
    audit: {
      rows: rows.length,
      input: auditInput,
      output: auditOutput,
      cost: round(auditCost),
      days: [...byDay.entries()].sort().map(([day, row]) => ({ day, ...row, cost: round(row.cost) })),
      models: [...byModel.entries()].map(([model, calls]) => ({ model, calls })),
    },
    official: {
      low: round(official.low),
      high: round(official.high),
      priced: official.priced,
      assumed: official.assumed,
      unknownModel: official.unknownModel,
      peakCalls: official.peakCalls,
    },
    real: {
      topup: TOPUP || null,
      spend: realSpend,
      warn: TOPUP > 0 && balance.ok && !enoughTopup ? `填的充值额 ${TOPUP} 小于当前余额 ${balance.total}，倒推不出消耗` : '',
      // 临界充值额：充值低于它，「已用 = 充值 − 余额」必然小于账本金额 ——
      // 也就是账本一定高估了。这个数不用知道充值额就能算出来。
      breakEven: balance.ok ? round(ledgerCost + balance.total) : null,
      pluginShare: realSpend && realSpend > 0 ? round(ledgerCost / realSpend, 4) : null,
    },
    previous,
    items,
  }

  // ── 4. 存基线：下次就能对「增量」，这是唯一能精确到分的对账方式 ──
  if (balance.ok) {
    const snapshot = {
      at: result.at,
      balance: balance.total,
      currency: balance.currency,
      ledgerCost,
      ledgerCalls,
      auditRows: rows.length,
    }
    const last = anchor.baselines[anchor.baselines.length - 1]
    // 同一分钟内重复跑不重复记；余额没变也不记 —— 基线要的是「有变化的点」
    if (!last || last.balance !== snapshot.balance || result.at - last.at > 6 * 3600_000) {
      anchor.baselines.push(snapshot)
      if (anchor.baselines.length > 500) anchor.baselines = anchor.baselines.slice(-500)
      try {
        const temp = ANCHOR_FILE + '.tmp'
        writeFileSync(temp, JSON.stringify(anchor, null, 2), 'utf8')
        renameSync(temp, ANCHOR_FILE)
      } catch {}
    }
  }

  result.baselines = anchor.baselines.length

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  print(result)
}

function readBalance() {
  const raw = existsSync(CREDENTIALS) ? readFileSync(CREDENTIALS, 'utf8') : ''
  const match = raw.match(/DEEPSEEK_API_KEY:\s*(sk-[A-Za-z0-9]+)/)
  if (!match) return { ok: false, error: '没找到 DEEPSEEK_API_KEY（~/.dsh/.credentials.yaml）' }
  // 同步查询：脚本要能一行跑完并直接打印，异步会让输出顺序乱掉。
  // curl 是 Windows 10+ / macOS / Linux 都自带的那个，不额外引依赖。
  try {
    const body = execFileSync('curl', ['-s', '-m', '20', 'https://api.deepseek.com/user/balance', '-H', `Authorization: Bearer ${match[1]}`], {
      encoding: 'utf8',
      timeout: 25_000,
    })
    const parsed = JSON.parse(body)
    const info = (parsed.balance_infos || [])[0] || {}
    return {
      ok: true,
      currency: String(info.currency || 'CNY'),
      total: Number(info.total_balance) || 0,
      granted: Number(info.granted_balance) || 0,
      toppedUp: Number(info.topped_up_balance) || 0,
      available: parsed.is_available !== false,
    }
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 120) }
  }
}

function money(value, currency = 'CNY') {
  const symbol = currency === 'USD' ? '$' : '¥'
  return `${symbol}${(Number(value) || 0).toFixed(4)}`
}

function print(result) {
  const { balance, ledger, audit, official, real, items } = result
  console.log('深蓝鲸 · 消耗对账')
  console.log('='.repeat(52))
  console.log(`数据目录   ${result.dir}`)
  console.log(`对账时间   ${new Date(result.at).toLocaleString('zh-CN', { hour12: false })}`)
  console.log('')
  console.log('【一】真实侧（DeepSeek 账户）')
  if (balance.ok) {
    console.log(`  当前余额 ${money(balance.total, balance.currency)}   （充值 ${money(balance.toppedUp)} / 赠送 ${money(balance.granted)}）`)
    console.log('  注意：这是「还剩多少」，不是「花了多少」。')
  } else {
    console.log(`  查不到余额：${balance.error}`)
  }
  console.log('')
  console.log('【二】插件侧（账本 vs 审计）')
  console.log(`  账本累计  ${ledger.input.toLocaleString()} in / ${ledger.output.toLocaleString()} out · ${ledger.calls} 次 · ${money(ledger.cost)}（起 ${ledger.since || '未知'}）`)
  console.log(`  审计逐行  ${audit.input.toLocaleString()} in / ${audit.output.toLocaleString()} out · ${audit.rows} 次 · ${money(audit.cost)}`)
  const modelText = audit.models.map((one) => `${one.model || '未标'}×${one.calls}`).join(' · ')
  if (modelText) console.log(`  实际模型  ${modelText}`)
  console.log('')
  console.log('【三】按官方价重算（同一批 token，换算法）')
  console.log(`  可计价 ${official.priced} 次，其中高峰 ${official.peakCalls} 次；按默认模型推定 ${official.assumed} 次（老账本没记到模型名）`)
  console.log(`  金额区间  ${money(official.low)} ～ ${money(official.high)}   （下界=全部命中缓存，上界=全部未命中）`)
  console.log(`  账面金额  ${money(ledger.cost)}（固定单价 ${ledger.price.input}/${ledger.price.output} 元每百万）`)
  if (real.warn) {
    console.log('')
    console.log(`【四】按充值额倒推   ${real.warn}`)
  } else if (real.spend !== null) {
    console.log('')
    console.log('【四】按充值额倒推')
    console.log(`  累计充值 ${money(real.topup)} − 余额 ${money(balance.total)} = 真实已用 ${money(real.spend)}`)
    console.log(`  其中插件账本占 ${(real.pluginShare * 100).toFixed(1)}%，其余 ${money(real.spend - ledger.cost)} 是插件之外的消耗`)
  } else {
    console.log('')
    console.log('【四】按充值额倒推   缺一个数：账户累计充了多少（--topup 2 就能算）')
    if (real.breakEven !== null) {
      console.log(`  临界值：充值低于 ${money(real.breakEven)} 时，账本金额必然高于真实消耗 —— 也就是账本一定高估。`)
    }
  }
  console.log('')
  console.log('【五】差异归因')
  for (const item of items) {
    const amount = item.amount === null ? '' : `  ${money(item.amount)}`
    console.log(`  · ${item.label}${amount}`)
    console.log(`    ${item.why}`)
  }
  console.log('')
  console.log('【结论】')
  const inRange = ledger.cost >= official.low && ledger.cost <= official.high
  console.log(`  1. 账本与审计${audit.rows === ledger.calls ? '条数一致' : `差 ${audit.rows - ledger.calls} 条（见「账实差」）`}，token 数量同源，可互相印证。`)
  console.log(`  2. 账本金额${inRange ? '落在官方价区间内' : '不在官方价区间内'}：插件记的是「按固定单价估的钱」，不是账单。`)
  console.log('  3. 要精确到分，只能对「增量」：从这次基线起，余额每降一次就和插件同时段的消耗对一次。')
  console.log(`  4. 基线已存：${path.basename(ANCHOR_FILE)}（现有 ${result.baselines} 个基线，下一次运行就能对增量）`)
}

main()
