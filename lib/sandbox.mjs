/**
 * lib/sandbox.mjs — 管「在沙箱里跑代码」这一件事：能不能跑、跑多久、写到哪儿、越界之后怎么办。
 *
 * 为什么值得单独一个文件：面板上那七个数字（每小时 / 每天 / 超时 / 内存 / 代码长度 /
 * 熔断阈值 / 熔断时长）如果只由调用方「记得检查」，它们就只是装饰。这一层把
 * **规则和执行放在一起**，谁想在沙箱里跑都得先过它，数字才不是空话。
 *
 * 闸门，顺序固定（先说的先发生，用户看到的第一个原因才是真原因）：
 *   1. 档位   off 一律不跑
 *   2. 熔断   连续越界到阈值就停一段时间，期间一条都不跑
 *   3. 计划   跑之前先交人话计划（1–5 步、每步 ≤60 字），没有计划不执行
 *   4. 静态   命中危险写法（起子进程、反射、遍历环境变量…）直接拒
 *   5. 确认   ask 档在这里问人：确认 / 拒绝 / 超时（默认拒绝）/ 记住过的结论
 * 过了这些闸，才轮到预算与执行：
 *   预算   每小时 / 每天次数上限，超了拒绝
 *   执行   独立进程 + Node 权限模型：只读自己的运行目录、只写 out/、不联网、到点就杀
 *
 * 关于「独立进程 + 权限模型」：这不是装饰性的隔离。代码拿不到宿主的 fs 权限，
 * 读 `config.json`、`*.key` 会得到 ERR_ACCESS_DENIED；起子进程会被 Node 直接拒绝；
 * 联网被启动前的 shim 挡掉。它仍不是虚拟机 —— 真正的内核级隔离要等宿主提供 ——
 * 所以面板文案只说「独立进程 + 只读自己的临时目录」，不说「绝对安全」。
 *
 * 记录：每次尝试（跑了的、拒了的）都写 `sandbox/runs.jsonl`，面板能按条翻；
 * 每次「问人」写 `sandbox/approvals.jsonl`（问了、同意、拒绝、超时、记住、忘记六种）。
 * 熔断与拒绝同时进审计。自由的前提是可追溯。
 */

import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readJson, writeJson } from './core.mjs'
import { Journal } from './journal.mjs'
import { ApprovalDesk } from './approvals.mjs'
import { guardPlan } from './say.mjs'

/** 运行时目录名。产物与记录都落在这里，删掉它等于清空沙箱历史 */
const ROOT_NAME = 'sandbox'
/**
 * 工作区目录名（放在运行时目录下，即 `<数据目录>/sandbox/workspace`）。
 *
 * 为什么必须有它：以前每跑一次都新建一次性目录，写完、跑完、被 #prune 回收，
 * 于是深蓝每一次都得从零开始 —— 上一次写的脚本、跑出来的中间文件、攒了一半的稿子，
 * 全都不在。**「会话扣」和「草稿纸」是两件事**，以前只有前者。
 *
 * 这里就是那张草稿纸：计划可以锚在上面（同一个脚本反复改、反复跑），
 * 写出来的文件与脚本会留下来，不会每次重来。
 *
 * 为什么挂在 ROOT_NAME 下面而不是数据目录根部：它是沙箱的一部分，跟着沙箱一起被理解、
 * 一起被备份；而 #prune 只清理名字像 `s1743...-01` 的运行目录，永远不会误删它。
 */
const WORKSPACE_NAME = 'workspace'
/** 保留多少次运行的产物。再多就删最老的 —— 记录留着，文件不必留 */
const KEEP_RUNS = 40
/** 输出上限：给模型看的东西，不是给它灌一整个日志 */
const STDOUT_LIMIT = 4000
const STDERR_LIMIT = 1200
/** 单次运行最多收几个产物 */
const ARTIFACT_LIMIT = 8
/** 等子进程收尾的宽限：杀掉之后最多再等这么久，避免一个僵住的进程卡住整轮 */
const KILL_GRACE_MS = 2000

/**
 * 静态闸门。命中即拒绝，原因写审计，不问用户也不问模型。
 *
 * 这些写法在「算个数、画个图、写个一次性脚本」里都用不到，而在「干坏事」里
 * 全都能用到。宁可误伤，不可放过 —— 误伤的代价是换一种写法，放过的代价不是。
 */
const GATE = Object.freeze([
  { key: 'process.binding', why: '底层绑定', re: /\bprocess\s*\.\s*binding\b/ },
  { key: 'child_process', why: '起子进程', re: /child_process|node:child_process/ },
  { key: 'worker_threads', why: '起线程', re: /worker_threads|node:worker_threads/ },
  { key: 'vm', why: '动态执行代码', re: /['"]node:vm['"]|require\(\s*['"]vm['"]\s*\)/ },
  { key: 'dgram', why: '发 UDP 包', re: /['"]node:dgram['"]|require\(\s*['"]dgram['"]\s*\)/ },
  { key: 'atob-eval', why: '解码后执行', re: /\beval\s*\(\s*atob\s*\(|new\s+Function\s*\(\s*atob\s*\(/ },
  { key: 'env-dump', why: '翻环境变量', re: /(?:Object\s*\.\s*(?:keys|values|entries|assign)\s*\(\s*process\s*\.\s*env|JSON\s*\.\s*stringify\s*\(\s*process\s*\.\s*env|for\s*\([^)]*\bin\s+process\s*\.\s*env)/ },
])

/**
 * 启动前注入的守卫（CommonJS，`--require` 加载）。
 *
 * 为什么静态闸门之外还要它：正则永远能被绕过（拼接、编码、间接引用）。
 * 这里直接把出口焊死 —— 网络模块的入口、process.binding、fetch 全部换成抛错。
 * 它挡不住内核级的把戏，但把「顺手试一下」这一类挡在了门外。
 */
const GUARD = `'use strict'
const blocked = (what) => {
  const error = new Error('SANDBOX_NET: 沙箱里不许联网（' + what + '）')
  error.code = 'ECONNREFUSED'
  return error
}
const refuse = (what) => { throw blocked(what) }
try { const net = require('node:net'); net.Socket.prototype.connect = () => refuse('net.connect'); net.connect = () => refuse('net.connect'); net.createConnection = () => refuse('net.createConnection') } catch {}
try { const tls = require('node:tls'); tls.connect = () => refuse('tls.connect') } catch {}
try { const dgram = require('node:dgram'); dgram.createSocket = () => refuse('dgram.createSocket') } catch {}
try { const http = require('node:http'); http.request = () => refuse('http.request'); http.get = () => refuse('http.get') } catch {}
try { const https = require('node:https'); https.request = () => refuse('https.request'); https.get = () => refuse('http.get') } catch {}
try { globalThis.fetch = () => Promise.reject(blocked('fetch')) } catch {}
try { process.binding = () => { throw blocked('process.binding') } } catch {}
`

/**
 * 建一个目录。失败返回 false，**不往外抛**。
 *
 * 为什么不抛：这一层是在插件启动时被调用的（index.js 建 Sandbox 的地方没有包 try）。
 * 数据目录不可写时，抛异常会让整个插件消失 —— 面板都打不开，远比「沙箱不可用」糟。
 * 项目里其他地方也是这个规矩：少一个能力最坏是不能用的容器，插件崩了是整个应用起不来。
 * 建没建成由 status().workspaceReady 如实反映，别装作成功。
 */
function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch {
    return false
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 用哪个可执行文件、要不要带 ELECTRON_RUN_AS_NODE，才能真的跑起一段 Node 代码。
 *
 * 为什么必须单独算一次：**打包后的桌面端里 `process.execPath` 是应用自己**
 * （`DeepSeek Harness.exe`），不是 node。直接拿它配 `--permission` 起子进程，
 * 等于又拉起一个应用实例；单实例锁一拦，子进程既不干活也不退出 ——
 * 执行器等满 30 秒，报「超时」，而那段 `console.log(6*7)` 本来一秒就结束了。
 * 线上表现是「沙箱永远超时」，很难从「代码有问题」这个方向查出来。
 *
 * 宿主已经准备好了这个环境：`DSH_DESKTOP_NODE_EXECUTABLE`（同一个 exe）
 * 配 `ELECTRON_RUN_AS_NODE=1`，Electron 就以纯 Node 模式跑，参数照单全收。
 */
export function runnerPlan(input = {}) {
  const env = input.env || process.env
  const versions = input.versions || process.versions || {}
  const explicit = String(input.execPath || '')
  const electron = input.electron === undefined ? Boolean(versions.electron) : input.electron === true
  if (explicit) return { execPath: explicit, asNode: electron }
  if (!electron) return { execPath: process.execPath, asNode: false }
  // 宿主没给这个变量就退回自己的 exe —— 至少和「不给」是同一个行为，不会更糟
  return { execPath: String(env.DSH_DESKTOP_NODE_EXECUTABLE || process.execPath), asNode: true }
}

/** 今天零点（本地时区）—— 与 runtime 里同一套算法，避免面板与执行器跨天不一致 */
function startOfDay(at) {
  const date = new Date(Number(at) || Date.now())
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 750 → "0.8 秒"，90_000 → "1 分 30 秒"。这里只需要「多久」，不需要精确到毫秒 */
function spanText(ms) {
  const n = Math.max(0, Number(ms) || 0)
  const sec = Math.round(n / 1000)
  if (sec < 60) return `${sec} 秒`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} 分钟`
  const hour = Math.floor(min / 60)
  return min % 60 ? `${hour} 小时 ${min % 60} 分` : `${hour} 小时`
}

function bytesText(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export class Sandbox {
  /**
   * @param {object} input
   * @param {object} [input.runtime] 运行时：读配置、写审计
   * @param {string} [input.dir]     数据目录（默认取 runtime.dir）
   * @param {() => number} [input.now]
   * @param {string} [input.execPath] 用哪个 node 在沙箱里跑代码（测试可替换）
   * @param {Function} [input.spawn]  测试注入用；默认 child_process.spawn
   * @param {string} [input.sourceRoot] 自己的源码根目录；默认就是本插件目录（从本文件往上两级）
   */
  constructor(input = {}) {
    this.runtime = input.runtime || null
    this.dir = String(input.dir || this.runtime?.dir || '.')
    this.now = input.now || (() => Date.now())
    const plan = runnerPlan({ execPath: input.execPath, electron: input.electron, env: input.env })
    this.execPath = plan.execPath
    // 在桌面端里这个开关必须带下去，否则子进程会以「应用」的身份起来，见 runnerPlan
    this.asNode = plan.asNode
    this.spawn = typeof input.spawn === 'function' ? input.spawn : spawn
    this.root = path.join(this.dir, ROOT_NAME)
    this.workspace = path.join(this.root, WORKSPACE_NAME)
    // 目录在构造时就建，不等到第一次跑。
    // 「交给别处顺便创建」的下场是：谁都没建 —— 于是读文件永远读到一个不存在的目录，
    // 而提示只会说「只能读工作目录里的文件」，看着像权限问题，其实是没人 mkdir。
    this.rootReady = ensureDir(this.root)
    this.workspaceReady = ensureDir(this.workspace)
    // 正在跑的 runId。清理老目录时要跳过它们 —— 见 #prune。
    this.active = new Set()
    // 源码根目录取本文件往上两级（lib/ → 插件根），不依赖「进程在哪儿启动」。
    // 宿主换个方式加载插件也不会指错地方。
    this.sourceRoot = input.sourceRoot !== undefined
      ? String(input.sourceRoot || '')
      : path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    this.journal = new Journal({ dir: this.root, name: 'runs', now: this.now })
    /**
     * 「先问我」档问人的那一层。它自己管挂起、超时、记住的结论与留档。
     * 独立成对象是为了能被单独测试 —— 弹窗逻辑混进执行器里，就只能靠手工点。
     *
     * `projectName` 会出现在弹窗和渠道消息里：问人的时候必须说清「这是哪个项目的代码」。
     */
    this.projectName = String(input.projectName || '深蓝鲸')
    this.approvals = input.approvals || new ApprovalDesk({
      dir: this.root,
      now: this.now,
      project: this.projectName,
      notify: input.notify,
      log: (kind, detail) => this.runtime?.log?.(kind, detail),
    })
    this.stateFile = path.join(this.root, 'state.json')
    this.seq = 0

    const saved = readJson(this.stateFile, null)
    const value = saved.ok && saved.value && typeof saved.value === 'object' ? saved.value : {}
    this.state = {
      violations: Math.max(0, Number(value.violations) || 0),
      fuseUntil: Math.max(0, Number(value.fuseUntil) || 0),
    }
  }

  /** 读一次配置。**每次调用都现读** —— 面板上改完要立刻生效，不能等重启 */
  config() {
    const raw = this.runtime?.config?.sandbox || {}
    const mode = String(raw.mode || 'free')
    const codeMode = String(raw.codeMode || 'write')
    return {
      mode: ['free', 'ask', 'off'].includes(mode) ? mode : 'free',
      codeMode: ['off', 'read', 'write'].includes(codeMode) ? codeMode : 'write',
      hourlyMax: clamp(raw.hourlyMax, 0, 100, 10),
      dailyMax: clamp(raw.dailyMax, 0, 500, 40),
      timeoutMs: clamp(raw.timeoutMs, 1000, 120_000, 30_000),
      memMb: clamp(raw.memMb, 64, 2048, 256),
      maxCodeBytes: clamp(raw.maxCodeBytes, 512, 65_536, 8192),
      fuseAfter: clamp(raw.fuseAfter, 1, 10, 2),
      fuseHours: clamp(raw.fuseHours, 1, 168, 24),
      // 「先问我」等人等多久。太短会让手慢的人一直在超时，太长会把一轮对话吊在那儿
      confirmSeconds: clamp(raw.confirmSeconds, 10, 300, 60),
    }
  }

  /** 面板要的现状：今天跑了几次、这一小时几次、熔断了没有、上一次什么结果 */
  status() {
    const at = this.now()
    const cfg = this.config()
    if (this.state.fuseUntil && this.state.fuseUntil <= at) {
      this.state.fuseUntil = 0
      this.#save()
    }
    const since = startOfDay(at)
    const hourFrom = at - 3_600_000
    // 「这一小时」「今天」一次遍历算完：分别 count 两遍等于把整份记录走两遍，
    // 而面板每 2.5 秒刷新一次，这个时间是同步花掉的（阻塞收消息）。
    let hourCount = 0
    let todayCount = 0
    this.journal.forEach((row) => {
      if (!row || row.kind !== 'run') return
      const ts = Number(row.at || row.ts) || 0
      if (ts >= hourFrom) hourCount += 1
      if (ts >= since) todayCount += 1
    })
    const last = this.journal.read({ limit: 1 }).rows[0] || null
    const fuseLeftMs = Math.max(0, this.state.fuseUntil - at)
    const approvals = this.approvals.stats()
    return {
      wired: true,
      mode: cfg.mode,
      codeMode: cfg.codeMode,
      workspace: this.workspace,
      workspaceReady: this.workspaceReady === true,
      hourlyMax: cfg.hourlyMax,
      dailyMax: cfg.dailyMax,
      hour: hourCount,
      today: todayCount,
      fuseUntil: fuseLeftMs ? this.state.fuseUntil : 0,
      fuseLeftMs,
      violations: this.state.violations,
      confirmSeconds: cfg.confirmSeconds,
      // 面板要显示「有几条在等人点」。pending 是实时值，不算历史
      approvals: {
        pending: this.approvals.pending.size,
        asked: approvals.asked,
        allowed: approvals.allowed,
        denied: approvals.denied,
        timedOut: approvals.timedOut,
        remember: approvals.remember,
      },
      last: last
        ? {
          kind: String(last.kind || ''),
          at: Number(last.at || last.ts) || 0,
          ok: last.ok === true,
          reason: String(last.reason || ''),
          message: String(last.message || ''),
          ms: Number(last.ms) || 0,
        }
        : null,
    }
  }

  /**
   * 跑一段代码。**唯一入口** —— 别处不许自己 spawn。
   *
   * @param {object} input
   * @param {string} input.code
   * @param {string[]|string} [input.plan] 人话计划，必须有
   * @returns {Promise<{ok:boolean, text?:string, error?:string, code?:string, runId?:string, ms?:number, data?:object}>}
   */
  async run(input = {}) {
    const at = this.now()
    const cfg = this.config()
    const code = String(input.code || '')
    const bytes = Buffer.byteLength(code, 'utf8')

    if (cfg.mode === 'off') {
      return this.#deny('off', '沙箱是关着的（设置 → 沙箱 → 自治档位）。', { at })
    }

    const fuseLeftMs = Math.max(0, this.state.fuseUntil - at)
    if (fuseLeftMs) {
      return this.#deny('fuse', `沙箱熔断了，还有 ${spanText(fuseLeftMs)}，先停一停。`, { at })
    }

    const planned = guardPlan(input.plan)
    if (!planned.ok) return this.#deny('plan', planned.reason, { at, bytes })

    if (!code.trim()) return this.#deny('empty', '代码是空的。', { at })
    if (bytes > cfg.maxCodeBytes) {
      return this.#deny('too_long', `代码太长（${bytes} 字节，上限 ${cfg.maxCodeBytes} 字节）。`, { at, bytes })
    }

    // 模型很爱写 Python。沙箱跑的是 Node —— 与其让它跑出一个看不懂的 ReferenceError，
    // 不如在这里就说清楚该改什么（这句话也会被喂回给模型，它会照着改）。
    if (/(?:^|\n)\s*(?:def\s+\w+\s*\(|print\s*\(|from\s+\w+\s+import\s|import\s+\w+\s*$)/m.test(code)) {
      return this.#deny('lang', '沙箱跑的是 JavaScript（Node），不是 Python：把 print(...) 换成 console.log(...)，别用 def / import 语句。', { at, bytes, plan: planned.plan })
    }

    const hit = GATE.find((rule) => rule.re.test(code))
    if (hit) {
      this.#violate(hit.key, at)
      return this.#deny('gate', `这段代码碰到了不允许的写法（${hit.why}），没有执行。`, { at, bytes, plan: planned.plan })
    }

    // 「先问我」：到这里才问。前面几道闸都是「问也不该跑」的情况 ——
    // 先弹窗、点同意、再告诉他「没交计划」，等于让人白点一次。
    //
    // 只有 ask 档才问：free 是「不用问」，off 是「不准跑」，两者都不该弹窗。
    // 这一段必须留在 door 之后再判一次，因为它读的是**当前**配置：
    // 面板上把档位从 ask 改成 free 的那一刻起，排队中的下一次就不该再问。
    if (cfg.mode === 'ask') {
      this.approvals.configure({ timeoutMs: cfg.confirmSeconds * 1000 })
      const verdict = await this.approvals.request({
        kind: 'sandbox',
        code,
        plan: planned.plan,
        label: String(input.label || ''),
        project: String(input.project || this.projectName),
        // 目的优先用调用方给的；没给就退到 label / 第一步计划 —— 三者都是人话
        purpose: String(input.purpose || input.label || planned.plan[0] || '跑一段代码'),
      })
      if (!verdict.allowed) {
        // 四种拒绝各有各的说法：模型看到的下一句话决定它会不会立刻重试
        let why
        if (verdict.timedOut) why = `等了 ${cfg.confirmSeconds} 秒没人确认，按拒绝处理。别重试，等主人主动叫你。`
        else if (verdict.remembered) {
          why = `主人之前记住过「拒绝」${verdict.reason ? `（理由：${verdict.reason}）` : ''}，这次直接不跑。要改这个结论，得去面板「过程 → 沙箱确认」清掉。`
        } else why = `主人拒绝了这段代码${verdict.reason ? `：${verdict.reason}` : '。'}别重试，换个办法或者先问一句。`
        return this.#deny('ask', why, { at, bytes, plan: planned.plan })
      }
    }

    const hour = this.journal.count((row) => row.kind === 'run' && Number(row.at || row.ts) >= at - 3_600_000)
    if (hour >= cfg.hourlyMax) return this.#deny('quota_hour', '这一小时跑得够多了，先歇歇。', { at, bytes, plan: planned.plan })
    const today = this.journal.count((row) => row.kind === 'run' && Number(row.at || row.ts) >= startOfDay(at))
    if (today >= cfg.dailyMax) return this.#deny('quota_day', '今天跑得够多了，明天再来。', { at, bytes, plan: planned.plan })

    const runId = this.#nextId(at)
    let result
    try {
      result = await this.#execute({ runId, code, cfg })
    } catch (error) {
      result = {
        dir: '',
        exit: -1,
        signal: '',
        ms: 0,
        stdout: '',
        stderr: String(error?.message || error),
        timedOut: false,
        artifacts: [],
      }
    }

    const outcome = classify(result, cfg)
    this.journal.append({
      kind: 'run',
      id: runId,
      at,
      ms: result.ms,
      ok: outcome.ok,
      reason: outcome.code || '',
      bytes,
      label: String(input.label || '').slice(0, 120),
      plan: planned.plan,
      code: code.slice(0, cfg.maxCodeBytes),
      exit: result.exit,
      signal: result.signal,
      timedOut: result.timedOut === true,
      artifacts: result.artifacts.map((item) => ({ title: item.title, bytes: item.bytes })),
      // 错误原文留在记录里（面板第三层 / 事后排查），但不进聊天
      error: outcome.ok ? '' : String(result.stderr || '').slice(0, 800),
    })

    if (outcome.ok) {
      if (this.state.violations) {
        this.state.violations = 0
        this.#save()
      }
      const files = result.artifacts.map((item) => `${item.title}（${bytesText(item.bytes)}）`)
      let text = outcome.text
      if (files.length) text += `\n产物：${files.join('、')}`
      return {
        ok: true,
        text,
        runId,
        ms: result.ms,
        data: { runId, ms: result.ms, artifacts: result.artifacts },
      }
    }

    if (outcome.violation) this.#violate(outcome.code, at)
    return { ok: false, code: `sandbox_${outcome.code}`, error: outcome.error, text: outcome.error, runId, ms: result.ms }
  }

  // ── 内部 ──────────────────────────────────────────────────────

  /** 记一条拒绝。拒绝也是事实，必须落盘 —— 「为什么没跑」和「跑了什么」一样重要 */
  #deny(reason, message, extra = {}) {
    this.journal.append({
      kind: 'deny',
      reason,
      message,
      at: Number(extra.at) || this.now(),
      bytes: Number(extra.bytes) || 0,
      plan: Array.isArray(extra.plan) ? extra.plan : [],
    })
    this.runtime?.log?.('sandbox_denied', { reason, message })
    return { ok: false, code: `sandbox_${reason}`, error: message, text: message }
  }

  /** 记一次越界。到阈值就熔断：连续越界说明「不是手滑」，停一段时间比继续试更稳 */
  #violate(reason, at) {
    const cfg = this.config()
    this.state.violations += 1
    let fused = false
    if (this.state.violations >= cfg.fuseAfter) {
      this.state.violations = 0
      this.state.fuseUntil = at + cfg.fuseHours * 3_600_000
      fused = true
    }
    this.#save()
    if (fused) {
      this.runtime?.log?.('sandbox_fuse', { reason, hours: cfg.fuseHours, until: this.state.fuseUntil })
    }
  }

  #save() {
    writeJson(this.stateFile, { violations: this.state.violations, fuseUntil: this.state.fuseUntil })
  }

  #nextId(at) {
    this.seq = (this.seq + 1) % 1296
    return `s${String(at).padStart(13, '0')}-${this.seq.toString(36).padStart(2, '0')}`
  }

  /**
   * 真正起进程。分三件事：准备目录 → 起 → 收尸（读输出、收产物、清老目录）。
   * 失败一律转成结果对象，不往外抛 —— 调用方要的是「怎么失败的」，不是异常。
   */
  async #execute({ runId, code, cfg }) {
    // 先登记再清理：清理会跳过在飞的，否则可能删掉并发中另一次运行正在用的目录
    this.active.add(runId)
    this.#prune()
    const dir = path.join(this.root, runId)
    const outDir = path.join(dir, 'out')
    mkdirSync(outDir, { recursive: true })
    // 模型两种写法都会写：顶层 import/export 就用 .mjs（ESM），否则 .js（CommonJS，
    // 顺带允许 `a = 1` 这种没声明的写法）。后缀选错的表现是「语法错误」，很难查。
    const esm = /(?:^|\n)\s*(?:import\s|export\s)/.test(code)
    const file = path.join(dir, esm ? 'main.mjs' : 'main.js')
    const guard = path.join(dir, 'guard.cjs')
    const outFile = path.join(dir, 'stdout.txt')
    const errFile = path.join(dir, 'stderr.txt')
    writeFileSync(file, code, 'utf8')
    writeFileSync(guard, GUARD, 'utf8')

    // 只给它读自己的运行目录、写 out/；不给 child-process / worker / addons 权限
    const flags = [
      '--permission',
      `--allow-fs-read=${dir}`,
      `--allow-fs-write=${outDir}`,
      `--max-old-space-size=${cfg.memMb}`,
    ]
    // 源码目录**只读**挂载：跑起来的代码要能翻自己的实现，但不能顺手改它。
    // 写仍然只有 out/ 一个出口 —— 「能读嘛地方」和「能写嘛地方」必须分开收紧。
    if (this.sourceRoot && cfg.codeMode !== 'off') flags.push(`--allow-fs-read=${this.sourceRoot}`)
    // 工作区是唯一「既能读又能写」的地方，也是唯一跨运行留存的地方：
    // 一次跑出来的中间文件，下一次还在。没有它，深蓝每跑一次都得从零开始。
    if (this.workspaceReady && cfg.mode !== 'off') {
      flags.push(`--allow-fs-read=${this.workspace}`, `--allow-fs-write=${this.workspace}`)
    }
    flags.push('--require', guard, file)
    // 环境变量白名单：宿主里那些 *KEY / *TOKEN / *SECRET 一个都不进去
    const env = {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      TZ: 'Asia/Shanghai',
      HOME: outDir,
      USERPROFILE: outDir,
      TEMP: outDir,
      TMP: outDir,
      // 告诉代码「草稿纸在哪」：相对路径默认落在 outDir（跟着这次运行走），
      // 想留下一次能接着用的东西，就写这个变量指的地方。
      SANDBOX_WORKSPACE: this.workspaceReady ? this.workspace : '',
    }
    // 桌面端里 execPath 是应用本身：不带这个开关，子进程会按「应用」启动，
    // 撞上单实例锁后既不执行也不退出，最后只能等到超时。
    if (this.asNode) env.ELECTRON_RUN_AS_NODE = '1'

    const started = Date.now()
    const outFd = openSync(outFile, 'w')
    const errFd = openSync(errFile, 'w')
    let child = null
    try {
      child = this.spawn(this.execPath, flags, {
        cwd: outDir,
        env,
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
      })
      const exit = await waitFor(child, cfg.timeoutMs)
      const stdout = readCapped(outFile, STDOUT_LIMIT)
      const stderr = readCapped(errFile, STDERR_LIMIT)
      return {
        dir,
        // 被信号杀掉时 code 是 null —— 别让 Number(null) 变成 0，那是「成功」的意思
        exit: exit.code === null || exit.code === undefined ? -1 : Number(exit.code),
        signal: String(exit.signal || ''),
        ms: Date.now() - started,
        stdout,
        stderr,
        timedOut: exit.timedOut === true,
        artifacts: listArtifacts(outDir),
      }
    } finally {
      closeQuietly(outFd)
      closeQuietly(errFd)
      if (child && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch {}
      }
      this.active.delete(runId)
    }
  }

  /**
   * 只留最近 KEEP_RUNS 份产物。记录不删 —— 删了就没法解释「上次为什么失败」。
   *
   * **正在跑的那几份必须跳过**：`run()` 是异步的，两次并发调用（工具环里连着写两行
   * 跑代码的调用）时，后一次在 `#execute` 开头就会走到这里。若把前一次还在用的目录删了，
   * 前一次随后读 stdout / 收产物都读到空，`classify()` 会给出一个 exit=0 的
   * 「跑完了，没有输出」—— 不是报错，是**静默的错误结果**，比报错更难发现。
   */
  #prune() {
    let entries = []
    try {
      entries = readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^s\d{13}-[0-9a-z]+$/.test(entry.name))
    } catch {
      return
    }
    if (entries.length < KEEP_RUNS) return
    const names = entries.map((entry) => entry.name).sort().filter((name) => !this.active.has(name))
    for (const name of names.slice(0, Math.max(0, names.length - KEEP_RUNS + 1))) {
      try { rmSync(path.join(this.root, name), { recursive: true, force: true }) } catch {}
    }
  }

  /**
   * 放掉记录文件的写句柄（插件卸载 / 进程退出前调）。
   *
   * 沙箱自己占着两份：跑批记录`runs`和确认台的`approvals`。常量句柄的好处见 journal.mjs，
   * 代价是必须有人放 —— 不放的话，热重载之后旧句柄还压着那两份文件，
   * 备份和搬目录都会撞上「文件正在使用」。
   */
  close() {
    try { this.journal?.close?.() } catch {}
    try { this.approvals?.close?.() } catch {}
  }
}

/** 等子进程结束；超时就杀，杀了再等一小会儿，绝不让一轮对话卡死在一个死循环上 */
function waitFor(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    let killed = false
    let grace = null
    const timer = setTimeout(() => {
      killed = true
      try { child.kill('SIGKILL') } catch {}
      grace = setTimeout(() => finish({ code: -1, signal: 'SIGKILL', timedOut: true }), KILL_GRACE_MS)
    }, Math.max(1000, Number(timeoutMs) || 30_000))
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      resolve({ ...value, timedOut: killed || value.timedOut === true })
    }
    child.once('error', (error) => finish({ code: -1, signal: '', timedOut: false, error }))
    child.once('exit', (code, signal) => finish({ code, signal, timedOut: false }))
  })
}

function readCapped(file, limit) {
  try {
    const text = readFileSync(file, 'utf8')
    return text.length > limit ? `${text.slice(0, limit)}\n…（截断）` : text
  } catch {
    return ''
  }
}

function closeQuietly(fd) {
  try { closeSync(fd) } catch {}
}

/** 产物：只报文件，不报目录；最多 ARTIFACT_LIMIT 个，按名字排，结果稳定 */
function listArtifacts(outDir) {
  let names = []
  try {
    names = readdirSync(outDir, { withFileTypes: true }).filter((entry) => entry.isFile() && !entry.name.startsWith('.')).map((entry) => entry.name).sort()
  } catch {
    return []
  }
  return names.slice(0, ARTIFACT_LIMIT).map((name) => {
    let bytes = 0
    try { bytes = statSync(path.join(outDir, name)).size } catch {}
    return { title: name, bytes }
  })
}

/** 把「怎么结束的」翻译成给人看的一句话。顺序敏感：具体的在前 */
function classify(result, cfg) {
  const stderr = String(result.stderr || '')
  if (result.timedOut) {
    return { ok: false, code: 'timeout', error: `超过 ${spanText(cfg.timeoutMs)}还没跑完，已经掐掉。` }
  }
  if (Number(result.exit) === -1 && result.signal) {
    return { ok: false, code: 'killed', error: '进程被系统停掉了，没跑完。' }
  }
  if (/SANDBOX_NET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND/.test(stderr)) {
    return { ok: false, code: 'net', error: '沙箱里不许联网，这段代码要联网才能跑。' }
  }
  if (/ERR_ACCESS_DENIED|Access to this API has been restricted|Access denied/i.test(stderr)) {
    return { ok: false, code: 'denied', error: '代码想读写沙箱外的位置，被挡住了。', violation: true }
  }
  if (/heap out of memory|JavaScript heap out of memory|ENOMEM/i.test(stderr)) {
    return { ok: false, code: 'memory', error: `内存超过 ${cfg.memMb}MB，被停掉了。` }
  }
  if (Number(result.exit) !== 0) {
    const first = stderr.split('\n').map((line) => line.trim()).find(Boolean) || '没有给出原因'
    return { ok: false, code: 'failed', error: `跑出错了：${first.slice(0, 160)}` }
  }
  const out = String(result.stdout || '').trim()
  return { ok: true, code: '', text: out ? out.slice(0, STDOUT_LIMIT) : '跑完了，没有输出。' }
}
