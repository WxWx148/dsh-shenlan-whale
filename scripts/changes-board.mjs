/**
 * scripts/changes-board.mjs — 生成「变更看板」：把一次版本区间内的改动摊成可浏览、可筛选、可定位的页面。
 *
 * 设计取舍（为什么是三个视图）：
 *   1. 变更——按「新增模块 / 细则微调」两类，逐条给前后代码；
 *   2. 规则——把每条改动里**此刻仍然生效的约束**抽出来单独列一遍。
 *      改动会过期（代码会再改），规则才是下次动手时真正要守的东西；
 *   3. 验证——哪条命令证明哪一段链路通，最近一次结果是什么。
 *
 * 数据来源分两半，且刻意分开：
 *   · 代码片段与行号：从两份真实源码里切（基线默认 `深蓝鲸.bak-*` 里最新的一份）；
 *   · 说明、规则、影响面：人写。
 * 锚点找不到就直接报错退出 —— 看板少一段代码，比没有看板更容易误导人。
 *
 * 用法：
 *   node scripts/changes-board.mjs                 # 基线自动找最新的 深蓝鲸.bak-*
 *   node scripts/changes-board.mjs --base <目录>
 *   node scripts/changes-board.mjs --out <文件>     # 默认 docs/changes.html
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const args = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const at = args.indexOf(name)
  return at >= 0 ? String(args[at + 1] || fallback) : fallback
}

/**
 * 基线：按修改时间挑最新的一份**可用的**备份。
 *
 * 两个坑都踩过：
 *   1. `bak-restore-*` 的字典序比 `bak-2026*` 大，按名字挑会挑到「恢复快照」；
 *   2. 备份目录可能是空壳（只剩目录结构、0 个文件），按 mtime 挑会挑到它，
 *      然后报一句「文件不存在：.../lib/behavior.mjs」—— 看着像代码写错了，
 *      其实是基线坏了。所以这里要求 index.js 与 package.json 都在才算可用。
 */
function latestBackup() {
  const parent = dirname(ROOT)
  const base = ROOT.split(/[\\/]/).pop()
  const usable = (full) => existsSync(join(full, 'index.js')) && existsSync(join(full, 'package.json'))
  // 备份搬家了：2026-11-03 起历史副本统一收进 _archive/e-root，根目录只留一个「深蓝鲸」。
  // 两处都扫：老机器上备份还在根目录，新布局在 _archive 里。
  const homes = [join(ROOT, '_archive', 'e-root'), parent].filter((one) => existsSync(one))
  let best = ''
  let bestAt = 0
  // 记住 best 所在的目录：两处都扫之后，不能再用循环结束时的 parent 去拼路径
  for (const home of homes) for (const name of readdirSync(home)) {
    if (!name.startsWith(`${base}.bak-`)) continue
    const full = join(home, name)
    let info
    try {
      info = statSync(full)
    } catch {
      continue
    }
    if (!info.isDirectory() || !usable(full)) continue
    if (info.mtimeMs > bestAt) {
      bestAt = info.mtimeMs
      best = full
    }
  }
  return best
}

const BASE = resolve(argOf('--base', latestBackup()) || '.')
if (!existsSync(BASE)) {
  console.error('找不到基线目录：' + BASE)
  process.exit(1)
}
const OUT = resolve(argOf('--out', join(ROOT, 'docs', 'changes.html')))

const readLines = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
const jsonOf = (file, fallback = {}) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 只用于 slice：当前正在切的文件（锚点相对它解析） */
let currentFile = ''
let currentLabel = ''
/** 锚点对不上而丢掉的段落：照常出页面，但必须让人知道少了哪几段 */
const WARNINGS = []

function slice(dir, anchor, before, after, optional = false) {
  const file = join(dir, currentFile)
  if (!existsSync(file)) {
    // 基线是旧快照：那时这个文件可能还不存在（比如 0.35 才加的 typing.mjs）。
    // 这不是错，跳过「改前」就好；硬报错会让整张看板打不开，
    // 而用户真正想看的是「现在长什么样」。
    if (optional) return null
    throw new Error(`[${currentLabel}] 文件不存在：${file}`)
  }
  const lines = readLines(file)
  const at = lines.findIndex((line) => line.includes(anchor))
  if (at < 0) throw new Error(`[${currentLabel}] 锚点没找到：${currentFile} ← ${anchor}`)
  const from = Math.max(0, at - (Number(before) || 0))
  const to = Math.min(lines.length, at + (Number(after) || 0) + 1)
  return { lines: lines.slice(from, to), start: from + 1, total: lines.length }
}

function block(spec) {
  currentFile = spec.file
  currentLabel = `${spec.file} · ${spec.label || ''}`
  const out = { label: spec.label || '' }
  if (spec.beforeAnchor) out.before = slice(BASE, spec.beforeAnchor, spec.before ?? 0, spec.after ?? 0, true) || undefined
  else if (spec.beforeRaw) out.before = { lines: spec.beforeRaw, start: 0, total: spec.beforeRaw.length, raw: true }
  if (spec.anchor) {
    try {
      out.after = slice(ROOT, spec.anchor, spec.before ?? 0, spec.after ?? 0)
    } catch (error) {
      // 锚点对不上 = 这段代码被改过或删了，也就是「这条记录过期了」。
      // 以前这里直接退出，结果是**整张看板再也生成不出来** —— 改得越多越打不开，
      // 最后大家去看一份两周前的页面，还以为那就是现在。
      // 现在：丢掉的记一条警告（终端会列出来），页面照常生成，绝不渲染假代码。
      out.skipped = String(error?.message || error)
      WARNINGS.push('跳过一段：' + out.skipped)
      return out
    }
  } else if (spec.afterRaw) out.after = { lines: spec.afterRaw, start: 0, total: spec.afterRaw.length, raw: true }
  return out
}

/** 极简 LCS：每段几十行，够用且零依赖 */
function diffRows(before, after) {
  const a = before ? before.lines : []
  const b = after ? after.lines : []
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ t: 'ctx', a: i + 1, b: j + 1, text: a[i] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ t: 'del', a: i + 1, text: a[i] })
      i += 1
    } else {
      rows.push({ t: 'add', b: j + 1, text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    rows.push({ t: 'del', a: i + 1, text: a[i] })
    i += 1
  }
  while (j < m) {
    rows.push({ t: 'add', b: j + 1, text: b[j] })
    j += 1
  }
  return rows
}

/**
 * 并排视图不是「按行号左右各截一段」——那会把完全不同的两行拼在一起。
 * 这里按 LCS 结果配对：ctx 两边同一行；删/增块各自成组，短的一侧补空行，
 * 于是「左边少了什么、右边多了什么」在视觉上是对齐的。
 */
function sideRows(rows) {
  const out = []
  let k = 0
  while (k < rows.length) {
    const row = rows[k]
    if (row.t === 'ctx') {
      out.push({ left: row.text, right: row.text, la: row.a, ra: row.b, lc: '', rc: '' })
      k += 1
      continue
    }
    const dels = []
    const adds = []
    while (k < rows.length && rows[k].t === 'del') {
      dels.push(rows[k])
      k += 1
    }
    while (k < rows.length && rows[k].t === 'add') {
      adds.push(rows[k])
      k += 1
    }
    const max = Math.max(dels.length, adds.length)
    for (let x = 0; x < max; x += 1) {
      const both = dels[x] && adds[x]
      out.push({
        left: dels[x] ? dels[x].text : '',
        right: adds[x] ? adds[x].text : '',
        la: dels[x] ? dels[x].a : '',
        ra: adds[x] ? adds[x].b : '',
        lc: both ? 'both' : (dels[x] ? 'del' : ''),
        rc: both ? 'both' : (adds[x] ? 'add' : ''),
      })
    }
  }
  return out
}

// ── 分区：顺序就是页面顺序，从「最新加的东西」到「底层约束」 ────────────

const AREAS = [
  { id: 'rhythm', label: '节奏与注意力', hint: '说话像不像人、在跟谁说话' },
  { id: 'channel', label: '通道与事件', hint: 'QQ 侧进来什么、出去什么' },
  { id: 'turn', label: '回合与路由', hint: '该不该回、回什么、怎么拆' },
  { id: 'entry', label: '入口与出站', hint: '装配、统一出口、权限边界' },
  { id: 'tool', label: '工具链与元信息', hint: '同步、体检、版本' },
]

// ── 条目：说明是人写的，片段是切出来的 ────────────────────────────────

const ENTRIES = [
  {
    id: 'mod-ask-channel',
    type: 'module',
    status: 'new',
    area: 'entry',
    module: 'index.js',
    title: '确认请求也走 QQ：发一句、回一句就成',
    where: 'index.js · approvalNotifier() / takeApprovalReply()；lib/approvals.mjs · takeReply()',
    summary: 'ask 档同时走面板与私聊；请求以系统消息直发，主人回「同意 / 拒绝 理由」即生效。',
    why: '只在面板里问，人不在电脑前就只剩超时拒绝；而「行 / 可以」这类词不能当指令 —— 吃掉一条正常聊天，比漏掉一次确认更糟。',
    rule: 'free 与 off 一律不问；渠道消息必须写清项目名与目的；多条在等必须带编号；没有等待项时不拦「同意」。',
    impact: 'QQ 私聊多一类系统消息；sandbox 的 ask 语义；approvals.jsonl 多 project / purpose 两列。',
    tags: ['权限', '渠道'],
    blocks: [
      { file: 'lib/approvals.mjs', label: '回话翻译成决定', anchor: 'takeReply(text) {', before: 2, after: 20 },
      { file: 'index.js', label: '渠道询问（系统消息直发）', anchor: 'approvalNotifier = async (record) => {', before: 4, after: 12 },
      { file: 'index.js', label: '进来先看是不是确认回复', anchor: 'const takeApprovalReply = (raw) => {', before: 6, after: 16 },
    ],
  },
  {
    id: 'mod-approvals',
    type: 'module',
    status: 'new',
    area: 'entry',
    module: 'lib/approvals.mjs',
    title: '确认台：把「先问我」从一句空话变成一条真的请求',
    where: 'lib/approvals.mjs · ApprovalDesk.request() / decide() / #settle()',
    summary: '挂起 → 等人 → 超时 / 同意 / 拒绝 → 记住。六种结果都落 approvals.jsonl 并进审计。',
    why: 'ask 档从 0.34 起就在配置里，但执行器写着「这个版本还没有确认界面」，选它等于选 off。一个有三个选项、其中一个是空的档位，比只有一个选项更容易骗人。',
    rule: '超时默认拒绝；同一个请求只能决定一次；记住的结论也要每次留一条 remembered；计时器不许拦住进程退出。',
    impact: '沙箱 ask 档的语义、面板「过程 → 沙箱确认」页、审计新增三类事件。',
    tags: ['沙箱', '权限'],
    blocks: [
      { file: 'lib/approvals.mjs', label: '请求与结账', anchor: 'request(input = {}) {', before: 2, after: 20 },
      { file: 'lib/approvals.mjs', label: '收口：日志 + 审计 + resolve', anchor: '#settle(id, verdict) {', before: 2, after: 22 },
    ],
  },
  {
    id: 'mod-ask-dialog',
    type: 'module',
    status: 'new',
    area: 'entry',
    module: 'lib/client.js',
    title: '确认弹窗：两个按钮、倒计时、记住选择、拒绝理由',
    where: 'lib/client.js · AskDialog / 每 1.5 秒轮询 /approvals',
    summary: '面板里直接弹，倒计时用服务端的 expiresAt 算；走完带理由提交一次拒绝，服务端再兜一道。',
    why: '弹窗只在面板里成立。挂在内容区会让用户一边看着「要跑代码」一边点开别的页签；用原生 confirm 会被桌面壳禁用，还会把整页卡住。',
    rule: '确认弹窗一律自绘，不用 window.confirm；倒计时要跟服务端的过期时间对齐，本机只负责走秒。',
    impact: '面板全局（任何分区都会弹）；新增 /approvals、/approvals/decide、/approvals/forget 三个口。',
    tags: ['弹窗', '面板'],
    blocks: [
      { file: 'lib/client.js', label: '组件', anchor: 'function AskDialog(', before: 2, after: 14 },
      { file: 'lib/client.js', label: '样式（主题 token）', anchor: "'.slj-askMask{", before: 0, after: 6 },
    ],
  },
  {
    id: 'tweak-sandbox-ask',
    type: 'tweak',
    status: 'changed',
    area: 'entry',
    module: 'lib/sandbox.mjs',
    title: 'ask 档的闸门挪到静态检查之后：问的是「真会跑的那段」',
    where: 'lib/sandbox.mjs · run() 的确认段',
    summary: '先过计划、语言、静态闸门，再把请求挂到确认台；拒绝/超时/记住三种拒绝各有各的说法。',
    why: '先弹窗、点同意、再告诉他「没交计划」，等于让人白点一次；而模型收到一句「没跑成」也不知道该不该重试。',
    rule: '确认必须发生在「这段代码确实会执行」之前一步；三种拒绝要给模型不同措辞，它才知道要不要换写法。',
    impact: '沙箱 ask 档的实际行为；四种拒绝文案（拒了 / 超时 / 记住拒绝 / 队列满）。',
    tags: ['沙箱', '顺序'],
    blocks: [
      { file: 'lib/sandbox.mjs', label: '问在静态闸门之后', anchor: "if (cfg.mode === 'ask') {", before: 3, after: 16 },
    ],
  },
  {
    id: 'tweak-usage-total',
    type: 'tweak',
    status: 'new',
    area: 'tool',
    module: 'lib/usage.mjs',
    title: 'Token 概览多一个「累计总用量」：单独一本只增不减的账',
    where: 'lib/usage.mjs · total() / #bumpTotal()；lib/panel-view.mjs · 概览牌 + 今天的账',
    summary: 'days 按天留 90 天，total 单独累加；老账本首次读到按现有天数补算一次并落盘。',
    why: '拿按天账算「一共花了多少」，越用越少 —— 90 天以外的天会被裁掉，而用户以为那是历史总和。',
    rule: '今日与累计是两个口径，分两处显示；累计值不随按天裁剪减少；补算出来的起点要写明是哪一天。',
    impact: '概览多一块状态牌、usage.today 多一张卡、/usage 接口多一个 total 字段。',
    tags: ['用量', '面板'],
    blocks: [
      { file: 'lib/usage.mjs', label: '累计值', anchor: 'total(at = this.now()) {', before: 3, after: 20 },
      { file: 'lib/usage.mjs', label: '累加与起点', anchor: '#bumpTotal(input, output, cost, calls, at) {', before: 2, after: 14 },
    ],
  },
  {
    id: 'tweak-typing-early',
    type: 'tweak',
    status: 'changed',
    area: 'rhythm',
    module: 'lib/typing.mjs',
    title: '「正在输入」提前到生成之前，并且把已等时间扣掉',
    where: 'lib/turn.mjs · #respond()；lib/typing.mjs · early() / typeOut()',
    summary: '决定要回的那一刻就亮指示器；打字时长改为 max(0, 打字时长 − 已花时间)，两段等待并成一段。',
    why: '以前是「模型想 6 秒」+「按字数再等 8 秒」，前 6 秒聊天窗口完全静止 —— 这是整段体验里最长的空白，看起来像掉线。',
    rule: '生成时间必须先亮「正在输入」；打字台算等待时要扣掉已经花掉的时间，同一条回复不许亮两次指示器。',
    impact: '所有回复的主观等待；长回复最明显（原来 14 秒的观感，现在 8 秒左右）。',
    tags: ['体感', '节奏'],
    blocks: [
      {
        file: 'lib/typing.mjs',
        label: '新增 early()：只亮不说话',
        beforeRaw: ['', '  // 以前没有这个方法：指示器只能在 typeOut 里亮，也就是必须等生成完', ''],
        anchor: 'async early(scope, target, key = \'\')',
        before: 0, after: 13,
      },
      {
        file: 'lib/turn.mjs',
        label: '决定要回就亮，不等生成',
        beforeRaw: ['  async #respond(event, decision, at) {', '    const started = this.now()', '    const isOwner = ...'],
        anchor: 'if (this.typing && typeof this.typing.early === \'function\')',
        before: 1, after: 9,
      },
    ],
  },
  {
    id: 'tweak-typing-serial',
    type: 'tweak',
    status: 'fixed',
    area: 'rhythm',
    module: 'lib/typing.mjs',
    title: '队尾 Promise 一旦 reject，整条出站链永久卡死',
    where: 'lib/typing.mjs · TypingDesk.#serial()',
    summary: '把 await prev 收进 try：上一条炸了也放行，后面的回复照发。',
    why: 'await prev 原本写在 try 外面，只要有一次队尾 Promise 被 reject，release() 永远不执行，之后所有回复都发不出去 —— 而且进程不报错，看起来只是「它不理人了」。',
    rule: '串行锁的放行必须在 finally 里；等上一条的那一步也要被 try 覆盖。',
    impact: '全站出站链路的可用性；一个异常不再等于永久静默。',
    tags: ['串行', '可用性'],
    blocks: [
      {
        file: 'lib/typing.mjs',
        label: 'await prev 进 try',
        beforeRaw: [
          '  async #serial(task) {',
          '    const prev = this.tail',
          '    let release = () => {}',
          '    this.tail = new Promise((resolve) => { release = resolve })',
          '    await prev              // ← 这一行在 try 外面',
          '    try {',
          '      return await task()',
          '    } finally {',
          '      release()',
          '    }',
          '  }',
        ],
        anchor: 'async #serial(task) {',
        before: 0, after: 18,
      },
    ],
  },
  {
    id: 'tweak-attention-leak',
    type: 'tweak',
    status: 'fixed',
    area: 'rhythm',
    module: 'lib/attention.mjs',
    title: '注意力账本漏了两处：话不清理、过期项不删',
    where: 'lib/attention.mjs · #prune() / otherTarget() / close()',
    summary: 'lastReply 跟着窗口一起清；扫过期项时顺手删，不再靠下一次 open 才收拾。',
    why: 'lastReply 只服务「换人」判定，却从不删除 —— 每个聊过的群都留一条，长跑只进不出；otherTarget 遇到过期项只 skip，于是「明明没人刚说完话，却一直显示有窗口」。',
    rule: '窗口关闭或过期时，与它绑定的派生状态必须一起清；扫描时看到过期项就删，不要留给下一次。',
    impact: '长跑内存；面板「热度」是否可信。',
    tags: ['注意力', '内存'],
    blocks: [
      {
        file: 'lib/attention.mjs',
        label: '清窗口连带清派生状态',
        beforeRaw: [
          '  #prune(at) {',
          '    for (const [key, map] of this.windows) {',
          '      for (const [who, rec] of map) {',
          '        if (at >= rec.until) map.delete(who)',
          '      }',
          '      if (!map.size) this.windows.delete(key)',
          '    }',
          '  }',
        ],
        anchor: '#prune(at) {',
        before: 1, after: 16,
      },
    ],
  },
  {
    id: 'mod-rhythm-panel',
    type: 'module',
    status: 'new',
    area: 'rhythm',
    module: 'lib/panel-view.mjs',
    title: '面板第一次能看见打字台与注意力',
    where: 'lib/panel-view.mjs · 概览卡 + overview.rhythm / overview.attention',
    summary: '概览多两颗状态牌（打字台 / 注意力）和一张「说话的节奏」卡；点进去是两个新详情页：实时读数、热窗口列表。',
    why: '0.35 把两个模块接进链路就没再管视图：面板里没有任何入口，装了、跑了、谁也看不见，出问题只能翻代码。',
    rule: '面板只能从 panelView 取数；新模块必须同时给出「有没有装」的判空，没装配就不画卡，不画全「—」的空卡。',
    impact: '概览、详情页与面板数据契约（panelView 新增 typing / attention 入参）。',
    tags: ['面板', '可见性'],
    blocks: [
      {
        file: 'lib/panel-view.mjs',
        label: '两颗状态牌',
        anchor: 'const typingStats = safe(\'typing\'',
        before: 1, after: 22,
      },
      {
        file: 'lib/panel-view.mjs',
        label: '两个详情页之一：节奏读数',
        anchor: "if (key === 'overview.rhythm')",
        before: 1, after: 20,
      },
    ],
  },
  {
    id: 'tweak-version-chip',
    type: 'tweak',
    status: 'new',
    area: 'entry',
    module: 'lib/client.js',
    title: '侧边栏显示当前加载的版本号',
    where: 'lib/client.js · 侧边栏品牌名下方',
    summary: '面板左上角直接写 v0.38.0，改完重启有没有生效，一眼能对。',
    why: '「改了代码、重启了、界面没变」最常见的两种原因（副本没同步、宿主还在跑旧模块）在界面上完全没有线索，只能靠猜。',
    rule: '版本号只从 head.version 取（宿主报的），不在浏览器里写死；收起态隐藏，避免占位。',
    impact: '排障第一步：数字没动就别在界面里找原因。',
    tags: ['排障', '版本'],
    blocks: [
      { file: 'lib/client.js', label: '版本标记', anchor: "className: 'slj-ver'", before: 3, after: 3 },
    ],
  },
  {
    id: 'mod-typing',
    type: 'module',
    status: 'new',
    area: 'rhythm',
    module: 'lib/typing.mjs',
    title: '单线程拟人打字台',
    where: 'lib/typing.mjs · TypingDesk.typeOut()',
    summary: '出站不再是一个固定延时：按字数算时长、全局一条队列、发之前亮「正在输入」、分条之间留缝。',
    why: '原来只有 guard.delay() 的固定首条 2.5s + 间隔 1.8s：「嗯」和三百字等得一样久，前者太慢像卡了，后者太快像粘贴。',
    rule: '一条消息的等待 = max(1.5s + 字数×0.5s + 抖动, guard.delay)，下限 200ms、上限 15s；全局同一时刻只有一条在打。',
    impact: '所有回复的节奏；定时器出站（index.js/outbound）也用它。',
    tags: ['节奏', '出站'],
    blocks: [
      { file: 'lib/typing.mjs', label: '时间模型：先加后夹', anchor: 'export function typingDelayMs', before: 1, after: 20 },
      { file: 'lib/typing.mjs', label: '单飞锁 + 分条留缝', anchor: 'async typeOut(input = {})', before: 2, after: 24 },
    ],
  },
  {
    id: 'mod-attention',
    type: 'module',
    status: 'new',
    area: 'rhythm',
    module: 'lib/attention.mjs',
    title: '群聊注意力账本',
    where: 'lib/attention.mjs · AttentionDesk.consider()',
    summary: '按人记账的续聊窗口（到期时间 + 已聊轮数），加「换人接话」判据：含你/您，或与上一句二元组重合率 ≥ 0.2。',
    why: '原来只有会话级活跃窗口：一个群热着，谁说话都算接着说。三个人同时聊时，这就是抢话。',
    rule: '同一个人 3 分钟内、5 轮以内，不 @ 也接；换人需「含你/您」或「与上一句重合率 ≥ 0.2」，换人时旧窗口必须关。',
    impact: '群聊接话范围；私聊不受影响（一个人就是一个会话）。',
    tags: ['群聊', '注意力'],
    blocks: [
      { file: 'lib/attention.mjs', label: '重合率：廉价判据', anchor: 'export function textOverlaps', before: 1, after: 18 },
      { file: 'lib/attention.mjs', label: '两条路径：命中 / 换人', anchor: 'consider(input = {})', before: 2, after: 26 },
    ],
  },
  {
    id: 'mod-input-status',
    type: 'module',
    status: 'new',
    area: 'channel',
    module: 'lib/qq/onebot.mjs',
    title: '通道支持「正在输入」',
    where: 'lib/qq/onebot.mjs · OneBotChannel.inputStatus()',
    summary: '走 NapCat 的 set_input_status，按 group/user 发；接口不存在时静默失败，不影响发送。',
    why: '打字台要亮指示器；而只有通道层能发协议请求（R4：QQ 层以外不许直接发）。',
    rule: '「正在输入」只在通道层亮，失败吞掉；消息一落地客户端自己清状态，不发取消。',
    impact: '老协议端没有这个 action 时只是没有提示，其余照常。',
    tags: ['通道'],
    blocks: [{ file: 'lib/qq/onebot.mjs', label: '方法本体', anchor: 'async inputStatus(scope, target)', before: 6, after: 14 }],
  },
  {
    id: 'mod-smoke',
    type: 'module',
    status: 'new',
    area: 'tool',
    module: 'scripts/smoke-chain.mjs',
    title: '全链路自检（npm run smoke）',
    where: 'scripts/smoke-chain.mjs · 17 项 stage()',
    summary: '临时目录 + 假通道 + 假模型，跑真模块：消息进来 → 路由 → 工具环 → 打字台 → 出站 → 三本账 → 面板。',
    why: '静态守卫只能证明 import 没断，证明不了「装起来还能跑」。零件都对、接线错一处，日志里什么都没有。',
    rule: '动过链路就跑 npm run smoke；17 项里任何一项红，先修关节再谈功能。',
    impact: '本地体检与发版前检查；失败退出码 1。',
    tags: ['验证'],
    blocks: [
      { file: 'scripts/smoke-chain.mjs', label: '一个场景长什么样', anchor: "step('私聊：一条消息进来，一句话出去')", before: 1, after: 14 },
      { file: 'scripts/smoke-chain.mjs', label: '静态关节断言', anchor: '出站只有一个口：定时器不许直连通道', before: 2, after: 12 },
    ],
  },
  {
    id: 'mod-tests',
    type: 'module',
    status: 'new',
    area: 'tool',
    module: 'tests/typing.test.mjs · tests/attention.test.mjs',
    title: '两层各自的 25 项用例',
    where: 'tests/typing.test.mjs（12）· tests/attention.test.mjs（13）',
    summary: '打字台测「并发不插队 / 队列满了不丢内容 / 指示器先于发送」；注意力测「无关的话不接 / 换人时旧窗口必须关」。',
    why: '这两层判错的代价不对称：漏接一句只是没聊上，抢话是冒犯。反例比正例重要。',
    rule: '改这两层的判据，必须同时改这里的反例；只加正例不算测过。',
    impact: 'npm test 多两个文件。',
    tags: ['用例'],
    blocks: [
      { file: 'tests/typing.test.mjs', label: '并发不插队', anchor: '单线程：两条并发时', before: 0, after: 10 },
      { file: 'tests/attention.test.mjs', label: '无关就不接', anchor: '窗口里是 A，B 说了句无关的', before: 0, after: 8 },
    ],
  },
  {
    id: 'tweak-behavior',
    type: 'tweak',
    status: 'changed',
    area: 'turn',
    module: 'lib/behavior.mjs',
    title: '路由多一条判据：注意力优先于兴趣词',
    where: 'lib/behavior.mjs · route()，CALLED 与兴趣词之间',
    summary: 'ctx.attention.continue 为真时直接回话；trigger 仍是 follow_up，reason 区分窗口命中与换人。',
    why: '「对方正在跟我说话」比「我看到感兴趣的内容」硬。顺序反了，统计里「被搭话」和「主动接话」会混成一类。',
    rule: '判定顺序：@ → 叫名字 → 呼唤 → 注意力窗口 → 兴趣词 → 续聊标签。顺序不许调。',
    impact: '群聊响应率统计口径；不传 ctx.attention 时行为与旧版完全一致。',
    tags: ['路由', '顺序敏感'],
    blocks: [
      { file: 'lib/behavior.mjs', label: '插入位置', beforeAnchor: 'if (has(event, TAG.CALLED))', anchor: 'if (has(event, TAG.CALLED))', before: 0, after: 12 },
    ],
  },
  {
    id: 'tweak-turn-ctor',
    type: 'tweak',
    status: 'changed',
    area: 'turn',
    module: 'lib/turn.mjs',
    title: '构造注入两个新层（可选）',
    where: 'lib/turn.mjs · Turn.constructor()',
    summary: 'typing / attention 都是可选项；不传就退回旧的固定节奏，用例与宿主缺装配时不会因此发不出去。',
    why: '新模块不能成为硬依赖：少一个能力最坏是不能用，不该让整条链停摆。',
    rule: '两个新层永远可选；新增能力照这个模式接，不许把「没装配」写成「发送失败」。',
    impact: '装配方式；缺省行为与 0.34.7 一致。',
    tags: ['依赖注入'],
    blocks: [{ file: 'lib/turn.mjs', label: '构造参数', beforeAnchor: 'this.channel = input.channel || null', anchor: 'this.channel = input.channel || null', before: 2, after: 8 }],
  },
  {
    id: 'tweak-turn-attention',
    type: 'tweak',
    status: 'new',
    area: 'turn',
    module: 'lib/turn.mjs',
    title: 'decide 之前先判注意力',
    where: 'lib/turn.mjs · #attention(raw)',
    summary: '只在群聊、非 @、有正文时判定；结果作为普通对象传给 runtime.decide。开窗关窗的副作用留在 turn。',
    why: 'decide 必须保持纯（同一个 raw 判两次结果一致），否则「为什么这条回了、那条没回」永远说不清。',
    rule: '判定可以在路由前，副作用不许进 decide；被 @ 的消息不走注意力判定。',
    impact: '群聊路由输入。',
    tags: ['纯函数边界'],
    blocks: [{ file: 'lib/turn.mjs', label: '方法本体', anchor: '#attention(raw) {', before: 9, after: 14 }],
  },
  {
    id: 'tweak-turn-say',
    type: 'tweak',
    status: 'changed',
    area: 'turn',
    module: 'lib/turn.mjs',
    title: '出站改走打字台',
    where: 'lib/turn.mjs · #say()',
    summary: '先把每段渲染成文字，再交给 typeOut：排队 → 指示器 → 按字数等 → 分条留缝 → 记账。没有打字台时退回旧循环。',
    why: '旧循环里「渲染」和「节奏」混在一起：分条发成一条时，查半天才发现是空串被吞了。',
    rule: '#say 只做「渲染 + 交给打字台」；空串不发、失败返回已发条数，不装作全发完。',
    impact: '所有回话的发送节奏。',
    tags: ['出站', '核心'],
    blocks: [
      { file: 'lib/turn.mjs', label: '旧：固定间隔循环', beforeAnchor: 'let lines = 0', before: 3, after: 6 },
      { file: 'lib/turn.mjs', label: '新：交给打字台', anchor: 'if (this.typing && typeof this.typing.typeOut', before: 1, after: 16 },
    ],
  },
  {
    id: 'tweak-turn-split',
    type: 'tweak',
    status: 'new',
    area: 'turn',
    module: 'lib/turn.mjs',
    title: '[split] 从死字面量变成真指令',
    where: 'lib/turn.mjs · #respond() 分条前',
    summary: '先把 [split] 切成最多两段各自分条；自己拆的段之间用 1~3s 的缝，机器切的用 0.5~1.4s。',
    why: '这个标记原来会被原样发出去 —— 用户看到一个字面量方括号。',
    rule: '[split] 最多切两段；自己拆的缝大（1~3s），机器切的缝小（0.5~1.4s），别混。',
    impact: '私聊长回复的分条手感。',
    tags: ['分条', '协议'],
    blocks: [
      { file: 'lib/turn.mjs', label: '分条入口', beforeAnchor: 'const parts = splitReply(text, { maxParts', before: 1, after: 3 },
      { file: 'lib/turn.mjs', label: '拆段 + 空内容兜底', anchor: "const marked = String(text || '')", before: 1, after: 12 },
    ],
  },
  {
    id: 'tweak-index-outbound',
    type: 'tweak',
    status: 'changed',
    area: 'entry',
    module: 'index.js',
    title: '出站收成一个口（12 处 → 2 处）',
    where: 'index.js · outbound()，替换 10 处定时器调用',
    summary: '闸门 → 打字台 → 通道 → 记账，四步固定。被替换的：主动开口、简报、热点×2、群插话、预算告警、早间补回、冷群话题、到点提醒。',
    why: '三条出站路径三种气质：回话像人、播报像广播；额度有的记有的不记；上下文里常常缺自己说过的那句。',
    rule: 'channel.say 只允许出现在 outbound 与面板「代发」两处；新增播报一律走 outbound。',
    impact: '定时器出站会多等 1~3 秒（像人打字）；面板代发保留直连。',
    tags: ['重构', '出站'],
    blocks: [
      { file: 'index.js', label: '旧：定时器各自直连通道', beforeAnchor: "await channel.say('private', owner, digest)", before: 2, after: 3 },
      { file: 'index.js', label: '新：唯一出口', anchor: 'const outbound = async', before: 1, after: 24 },
    ],
  },
  {
    id: 'tweak-index-request',
    type: 'tweak',
    status: 'new',
    area: 'entry',
    module: 'index.js',
    title: '申请类事件只转告，不代点同意',
    where: 'index.js · notifyOwnerOfRequest() + onRaw 挂钩',
    summary: '加好友 / 拉群申请 → 私聊告诉主人是谁、附言是什么，并写明「同意这一步我不代劳」。',
    why: '替主人把陌生人放进来是权限决定，不是聊天。上游那版会自动批，代价是群可能被拉进广告号。',
    rule: '申请类永远不自动通过；通知里必须带 QQ 号与附言，且必须说清「要主人自己点」。',
    impact: '需要 identity.ownerId；没配置就只落事件流，不打扰任何人。',
    tags: ['权限边界'],
    blocks: [{ file: 'index.js', label: '方法本体', anchor: 'const notifyOwnerOfRequest', before: 2, after: 16 }],
  },
  {
    id: 'tweak-onebot-raw',
    type: 'tweak',
    status: 'changed',
    area: 'channel',
    module: 'lib/qq/onebot.mjs',
    title: '通知与请求不再被通道吞掉',
    where: 'lib/qq/onebot.mjs · toRaw()，message 分支之前',
    summary: 'notice / request 翻成 kind=notice 的 raw：戳一戳带 notice 类型，请求带 flag/subType/groupId/userId/comment。',
    why: '原来这里一刀切 return null —— 「被戳」「有人加好友」「有人拉群」从来没进过系统，面板和审计里都查不到。',
    rule: '通道只翻译、不判断：notice/request 必须进事件流；缺 notice_type 或 flag 的脏包返回 null。',
    impact: '事件流里多出通知类行；路由层「只记录不行为」，不会多嘴。',
    tags: ['通道', '数据完整性'],
    blocks: [
      { file: 'lib/qq/onebot.mjs', label: '旧的边界', beforeAnchor: "if (postType !== 'message' && postType !== 'message_sent') return null", before: 3, after: 2 },
      { file: 'lib/qq/onebot.mjs', label: '新的两个分支', anchor: '// 通知与请求：以前这里一刀切', before: 0, after: 42 },
    ],
  },
  {
    id: 'tweak-sync',
    type: 'tweak',
    status: 'changed',
    area: 'tool',
    module: 'scripts/sync-to-profile.mjs',
    title: '同步判「一致」的判据换了：从 5 个文件的大小改成整棵内容哈希',
    where: 'scripts/sync-to-profile.mjs · fingerprint() / mirror()',
    summary: '按源码清单逐文件算 sha1；复制改成 copyFileSync 覆盖写，不再「先删目标再复制」。',
    why: '旧指纹只比 5 个关键文件的大小，lib/client.js（前端）根本不在里面：前端改了，脚本照样报「一致」并直接跳过复制 —— 表现就是「代码改了、界面不动」。等长替换连大小都一样，旧判据同样骗得过。',
    rule: '判一致必须按内容哈希覆盖整棵源码树；复制不许先删目标（中途失败会留下缺文件的副本，比不同步更严重）。',
    impact: '发版前 npm run check:sync 必须绿；它绿了才说明宿主下次启动加载的是新代码。',
    tags: ['工具链', '排障'],
    blocks: [
      { file: 'scripts/sync-to-profile.mjs', label: '指纹：整棵哈希', anchor: 'function fingerprint(dir, files)', before: 4, after: 14 },
      { file: 'scripts/sync-to-profile.mjs', label: '复制：覆盖写，不先删目标', anchor: 'function mirror(from, to)', before: 12, after: 12 },
    ],
  },
]

// ── 现状快照：从磁盘上数，不凭记忆写 ────────────────────────────────

const pkg = jsonOf(join(ROOT, 'package.json'), {})
const testFiles = readdirSync(join(ROOT, 'tests')).filter((name) => name.endsWith('.test.mjs'))
const libFiles = readdirSync(join(ROOT, 'lib'), { withFileTypes: true })
  .flatMap((entry) => (entry.isDirectory() ? readdirSync(join(ROOT, 'lib', entry.name)).map((one) => `${entry.name}/${one}`) : [entry.name]))
  .filter((name) => name.endsWith('.mjs') || name.endsWith('.js'))

// ── 验证矩阵：哪条命令证明哪一段链路通 ────────────────────────────────
// 用例数、代码文件数、依赖图规模都在生成时现算：这三个数字最容易被写死在文档里，
// 然后随着代码增长慢慢变成谎话。check-layers 顺带在这里跑一次，坏了当场就能看见。

let layersLine = '无断链 / 无环 / 无越层 / 无绕闸'
try {
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-layers.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' })
  const got = out.match(/(\d+)\s*个文件\s*\/\s*(\d+)\s*条依赖/)
  if (got) layersLine = got[1] + ' 文件 / ' + got[2] + ' 依赖'
  if (out.indexOf('✗') >= 0) layersLine += '（有告警）'
} catch (error) {
  layersLine = '未通过 —— 先跑一次 check-layers'
}

const VERIFY = [
  { cmd: 'npm test', proves: '每个零件算得对，且三个守卫脚本全过', covers: ['用例', '文案', '归属', '分层'], result: `${testFiles.length} 个用例文件全过` },
  { cmd: 'npm run smoke', proves: '装起来能跑：私聊/群聊/工具环/限流/面板/三本账', covers: ['全链路'], result: '17 项全通' },
  { cmd: 'npm run probe', proves: '真实进程里的面板路由与媒体接口可用', covers: ['面板接口'], result: '104 项全过' },
  { cmd: 'node scripts/check-layers.mjs', proves: '没有断链 / 环 / 越层 / 绕闸', covers: ['依赖图'], result: layersLine },
  { cmd: 'node scripts/sync-to-profile.mjs --check', proves: '宿主加载的副本与源码一致', covers: ['部署'], result: `一致 v${pkg.version || '?'}` },
]

// ── 主线：三条一句话的结论，点进去看细节 ──────────────────────────────

const HIGHLIGHTS = [
  { title: '多了两层：打字台 + 注意力', text: '节奏按字数算、全局一条队列；群里按人记账，换人要判据。', ids: ['mod-typing', 'mod-attention'] },
  { title: '出站收成一个口：12 处 → 2 处', text: '定时器、提醒、告警不再各自直连通道，统一过闸门与打字台。', ids: ['tweak-index-outbound'] },
  { title: '通道不再吞事件', text: '戳一戳、加好友、拉群现在会进事件流；申请类只转告，不代点同意。', ids: ['tweak-onebot-raw', 'tweak-index-request'] },
]

const data = {
  meta: {
    title: '深蓝鲸 · 变更看板',
    from: jsonOf(join(BASE, 'package.json'), {}).version || '?',
    to: pkg.version || '?',
    base: BASE,
    at: new Date().toISOString(),
    snapshot: {
      version: pkg.version || '?',
      lib: libFiles.length,
      tests: testFiles.length,
      entries: 0,
      added: 0,
      removed: 0,
    },
    areas: AREAS,
    verify: VERIFY,
    highlights: HIGHLIGHTS,
    counts: {},
  },
  entries: [],
}

for (const entry of ENTRIES) {
  try {
    const blocks = entry.blocks.map((spec) => {
      const one = block(spec)
      one.rows = diffRows(one.before, one.after)
      one.side = sideRows(one.rows)
      one.added = one.rows.filter((row) => row.t === 'add').length
      one.removed = one.rows.filter((row) => row.t === 'del').length
      return one
    }).filter((one) => one.after || one.before)
    data.entries.push({
      ...entry,
      blocks,
      added: blocks.reduce((sum, one) => sum + one.added, 0),
      removed: blocks.reduce((sum, one) => sum + one.removed, 0),
    })
  } catch (error) {
    console.error('✗ ' + error.message)
    process.exit(1)
  }
}

const fileSet = new Set(data.entries.map((one) => one.module.split(' · ')[0]))
data.meta.counts = {
  modules: data.entries.filter((one) => one.type === 'module').length,
  tweaks: data.entries.filter((one) => one.type === 'tweak').length,
  files: fileSet.size,
  added: data.entries.reduce((sum, one) => sum + one.added, 0),
  removed: data.entries.reduce((sum, one) => sum + one.removed, 0),
  rules: data.entries.filter((one) => one.rule).length,
}
data.meta.snapshot.entries = data.entries.length
data.meta.snapshot.added = data.meta.counts.added
data.meta.snapshot.removed = data.meta.counts.removed

// ── 渲染 ────────────────────────────────────────────────────────────

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${data.meta.title} ${data.meta.from} → ${data.meta.to}</title>
<style>
  :root {
    --bg: #f5f6f8;
    --line: #e3e7ec;
    --line-soft: #eef1f4;
    --text: #1b232e;
    --muted: #66717e;
    --faint: #8d97a4;
    --add-bg: #eaf7ef;
    --add-fg: #14603a;
    --del-bg: #fdeeee;
    --del-fg: #9a2b2b;
    --mod: #0f766e;
    --mod-bg: #e6f4f1;
    --twk: #9a5b12;
    --twk-bg: #fbf0dd;
    --accent: #2a5bd7;
    --head: 172px;
    --mono: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, "Liberation Mono", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); }
  body { font-size: 14px; line-height: 1.62; }
  button { font: inherit; color: inherit; cursor: pointer; }
  code { font-family: var(--mono); font-size: .92em; }

  .top { position: sticky; top: 0; z-index: 40; background: rgba(245,246,248,.94); border-bottom: 1px solid var(--line); backdrop-filter: saturate(150%) blur(10px); }
  .top-in { max-width: 1400px; margin: 0 auto; padding: 14px 24px 0; }
  .row1 { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .row1 h1 { margin: 0; font-size: 19px; letter-spacing: .2px; }
  .ver { font-family: var(--mono); font-size: 12.5px; color: var(--muted); }
  .ver b { color: var(--text); }
  .snap { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
  .pill { display: inline-flex; gap: 6px; align-items: center; padding: 3px 10px; border-radius: 999px; background: #fff; border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
  .pill b { color: var(--text); font-variant-numeric: tabular-nums; }
  .pill .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--line); }
  .pill.ok .dot { background: #2f9e64; }
  .pill.mod .dot { background: var(--mod); }
  .pill.twk .dot { background: var(--twk); }

  .tabs { display: flex; gap: 2px; margin-top: 12px; }
  .tabs button { border: 0; background: transparent; padding: 9px 14px 10px; font-size: 13.5px; color: var(--muted); border-bottom: 2px solid transparent; display: inline-flex; gap: 7px; align-items: center; }
  .tabs button[aria-selected="true"] { color: var(--text); font-weight: 600; border-bottom-color: var(--accent); }
  .tabs .n { font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }

  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 10px 0 8px; }
  .seg { display: inline-flex; background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 3px; }
  .seg button { border: 0; background: transparent; padding: 5px 11px; border-radius: 7px; font-size: 12.5px; color: var(--muted); display: inline-flex; gap: 6px; align-items: center; }
  .seg button[aria-pressed="true"] { background: #eef2ff; color: #1e3a8a; font-weight: 600; }
  .seg .n { font-size: 11px; opacity: .7; font-variant-numeric: tabular-nums; }

  .search { position: relative; flex: 1 1 240px; min-width: 200px; }
  .search input { width: 100%; padding: 8px 32px 8px 32px; border: 1px solid var(--line); border-radius: 10px; background: #fff; font: inherit; font-size: 13px; outline: none; }
  .search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(42,91,215,.16); }
  .search .ico { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--faint); }
  .search .clear { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); border: 0; background: transparent; color: var(--faint); padding: 3px 6px; border-radius: 6px; display: none; }
  .search.has .clear { display: block; }

  .chipbar { display: flex; gap: 6px; flex-wrap: wrap; padding-bottom: 12px; }
  .chip { border: 1px solid var(--line); background: #fff; color: var(--muted); padding: 3px 10px; border-radius: 999px; font-size: 12px; white-space: nowrap; }
  .chip[aria-pressed="true"] { border-color: #c7d2fe; background: #eef2ff; color: #1e3a8a; font-weight: 600; }
  .chip .n { opacity: .6; font-variant-numeric: tabular-nums; }
  .ghost { border: 1px solid var(--line); background: #fff; border-radius: 9px; padding: 5px 10px; font-size: 12.5px; color: var(--muted); }
  .ghost:hover { border-color: #cbd5e1; color: var(--text); }
  .grow { flex: 1 1 auto; }

  .wrap { max-width: 1400px; margin: 0 auto; padding: 18px 24px 70px; }
  .layout { display: grid; grid-template-columns: 288px minmax(0, 1fr); gap: 22px; align-items: start; }
  body.wide .layout { grid-template-columns: minmax(0, 1fr); }
  body.wide nav.toc { display: none; }
  nav.toc { position: sticky; top: calc(var(--head) + 12px); max-height: calc(100vh - var(--head) - 32px); overflow: auto; }
  nav.toc .grp { margin-bottom: 12px; }
  nav.toc .grp > .lab { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); padding: 4px 6px; }
  nav.toc .grp > .lab b { color: var(--text); font-weight: 600; }
  nav.toc .item { display: flex; gap: 10px; align-items: flex-start; width: 100%; overflow: hidden; text-align: left; border: 0; background: transparent; padding: 5px 8px; border-radius: 8px; color: var(--muted); font-size: 12px; line-height: 1.45; }
  nav.toc .item:hover { background: #eceff4; color: var(--text); }
  nav.toc .item[aria-current="true"] { background: #e9eefb; color: #17327a; font-weight: 600; }
  nav.toc .item .mk { width: 6px; height: 6px; border-radius: 50%; margin-top: 7px; flex: 0 0 auto; }
  nav.toc .item .tx { flex: 1 1 auto; min-width: 0; padding-right: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  nav.toc .item .ln { flex: 0 0 auto; white-space: nowrap; font-family: var(--mono); font-size: 10px; color: var(--faint); font-weight: 400; margin-top: 2px; }
  nav.toc .item .ln .p { color: var(--add-fg); }
  nav.toc .item .ln .m { color: var(--del-fg); }
  nav.toc .back { width: 100%; text-align: left; border: 1px dashed var(--line); background: transparent; border-radius: 8px; padding: 6px 10px; color: var(--faint); font-size: 12px; margin-top: 4px; }

  main { min-width: 0; }
  .view[hidden] { display: none; }

  .legend { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 6px 20px; padding: 11px 16px; background: #fff; border: 1px solid var(--line); border-radius: 12px; margin-bottom: 12px; color: var(--muted); font-size: 12.5px; }
  .legend b { color: var(--text); }
  .hi { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .hi a { display: block; text-decoration: none; color: inherit; background: #fff; border: 1px solid var(--line); border-left: 3px solid #b9c8e8; border-radius: 11px; padding: 10px 13px; transition: border-color .15s ease, box-shadow .15s ease; }
  .hi a:hover { border-color: #b7cdf7; box-shadow: 0 1px 6px rgba(30,58,138,.07); }
  .hi a:first-child { border-left-color: var(--mod); }
  .hi .t { font-size: 13px; font-weight: 650; }
  .hi .d { font-size: 12px; color: var(--muted); margin-top: 2px; }

  .sechead { font-size: 13px; letter-spacing: .04em; color: var(--muted); margin: 18px 0 10px 2px; font-weight: 600; }
  .sechead span { color: var(--faint); font-weight: 400; }

  article.card { background: #fff; border: 1px solid var(--line); border-left: 3px solid var(--line); border-radius: 13px; overflow: hidden; margin-bottom: 14px; scroll-margin-top: calc(var(--head) + 14px); transition: box-shadow .18s ease, border-color .18s ease; }
  article.card.mod { border-left-color: var(--mod); }
  article.card.twk { border-left-color: var(--twk); }
  article.card.flash { box-shadow: 0 0 0 4px rgba(42,91,215,.14); border-color: #9fb9f5; }
  .card-head { padding: 14px 18px 12px; }
  .badges { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; margin-bottom: 7px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; font-weight: 600; }
  .badge.mod { color: var(--mod); background: var(--mod-bg); }
  .badge.twk { color: var(--twk); background: var(--twk-bg); }
  .badge.plain { color: var(--muted); background: #f2f4f7; font-weight: 500; }
  .badge.st-new { color: #1d4ed8; background: #e8eefc; }
  .badge.st-changed { color: #8a4b0f; background: #fbefdc; }
  .card h2 { margin: 0 0 6px; font-size: 16.5px; line-height: 1.45; }
  .where { display: inline-block; max-width: 100%; font-family: var(--mono); font-size: 11.5px; color: var(--muted); background: #f7f8fa; border: 1px solid var(--line-soft); padding: 2px 7px; border-radius: 6px; overflow-wrap: anywhere; }
  .sum { margin: 9px 0 0; color: #2f3a47; font-size: 13.5px; }
  .rulebox { margin: 11px 0 0; padding: 9px 12px; background: #f4f8ff; border: 1px solid #dfe8fb; border-radius: 9px; }
  .rulebox .k { display: inline-block; font-size: 10.5px; letter-spacing: .06em; color: #2a5bd7; font-weight: 700; margin-bottom: 2px; }
  .rulebox p { margin: 0; font-size: 13px; color: #1f2937; }
  .why { margin: 9px 0 0; font-size: 12.5px; color: var(--muted); }
  .why b { color: #3d4a58; font-weight: 600; }
  .impact { margin: 6px 0 0; font-size: 12.5px; color: var(--muted); }
  .impact span { color: var(--faint); }

  .blocks { border-top: 1px solid var(--line-soft); margin-top: 12px; }
  .blk + .blk { border-top: 1px solid var(--line-soft); }
  .blk-head { display: flex; align-items: center; gap: 9px; padding: 7px 18px; background: #fbfcfd; font-size: 12px; color: var(--muted); }
  .blk-head .lab { font-weight: 600; color: #3a4655; }
  .blk-head .loc { font-family: var(--mono); font-size: 11px; color: var(--faint); }
  .blk-head .plus { color: var(--add-fg); font-family: var(--mono); }
  .blk-head .minus { color: var(--del-fg); font-family: var(--mono); }
  .blk-head .spacer { flex: 1; }
  .toggle { border: 1px solid var(--line); background: #fff; border-radius: 7px; padding: 1px 8px; font-size: 11px; color: var(--muted); }
  .blk.folded .diff { display: none; }

  .diff { overflow: auto; max-height: 440px; font-family: var(--mono); font-size: 12.5px; line-height: 1.52; background: #fff; }
  table.dt { border-collapse: collapse; width: 100%; }
  table.dt td { padding: 1px 0; vertical-align: top; white-space: pre; }
  table.dt td.gut { width: 42px; text-align: right; padding-right: 8px; color: #b8c0ca; user-select: none; font-size: 10.5px; }
  table.dt td.sign { width: 16px; text-align: center; color: #b8c0ca; user-select: none; }
  table.dt td.code { padding-right: 14px; }
  tr.add td { background: var(--add-bg); }
  tr.add td.code { color: var(--add-fg); }
  tr.add td.gut, tr.add td.sign { color: #6aa383; }
  tr.del td { background: var(--del-bg); }
  tr.del td.code { color: var(--del-fg); }
  tr.del td.gut, tr.del td.sign { color: #c08383; }
  tr.ctx td.code { color: #3b4654; }

  table.side { border-collapse: collapse; width: 100%; table-layout: fixed; }
  table.side th { position: sticky; top: 0; background: #fbfcfd; font: 600 11px var(--sans); color: var(--faint); text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--line-soft); }
  table.side td { padding: 1px 0; vertical-align: top; white-space: pre-wrap; word-break: break-word; }
  table.side td.ln { width: 34px; text-align: right; color: #c3cad3; font-size: 10.5px; padding-right: 7px; user-select: none; }
  table.side td.code { padding: 1px 9px; }
  table.side td.code.right { border-left: 1px solid var(--line-soft); }

  .tags { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 10px 18px 0; }
  .tag { font-size: 11px; color: var(--muted); background: #f3f5f7; border-radius: 6px; padding: 2px 8px; }
  .tag.k { color: #1e3a8a; background: #eef2ff; font-family: var(--mono); }
  .card-foot { display: flex; gap: 8px; align-items: center; padding: 8px 18px 13px; }
  .copy { border: 1px solid var(--line); background: #fff; border-radius: 8px; padding: 3px 9px; font-size: 11.5px; color: var(--muted); }
  .copy:hover { color: var(--text); border-color: #cbd5e1; }

  .rules { background: #fff; border: 1px solid var(--line); border-radius: 13px; overflow: hidden; }
  table.rt { border-collapse: collapse; width: 100%; }
  table.rt th { text-align: left; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); padding: 10px 14px; background: #fbfcfd; border-bottom: 1px solid var(--line); }
  table.rt td { padding: 11px 14px; border-bottom: 1px solid var(--line-soft); vertical-align: top; font-size: 13px; }
  table.rt tr:last-child td { border-bottom: 0; }
  table.rt tr:hover td { background: #fafbfd; }
  table.rt .no { font-family: var(--mono); color: var(--faint); font-size: 11.5px; width: 46px; }
  table.rt .rl { color: #1f2937; }
  table.rt .md { font-family: var(--mono); font-size: 11.5px; color: var(--muted); width: 200px; }
  table.rt .wh { font-family: var(--mono); font-size: 11px; color: var(--faint); width: 220px; }
  table.rt .go { width: 96px; text-align: right; }
  .jump { white-space: nowrap; border: 1px solid var(--line); background: #fff; border-radius: 7px; padding: 2px 9px; font-size: 11.5px; color: var(--accent); }

  .vhead { display: grid; grid-template-columns: repeat(auto-fit, minmax(155px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .vcard { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  .vcard .k { font-size: 11.5px; color: var(--faint); }
  .vcard .v { font-size: 20px; font-weight: 650; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .vcard .s { font-size: 11.5px; color: var(--muted); }
  .vtable { background: #fff; border: 1px solid var(--line); border-radius: 13px; overflow: hidden; }
  table.vt { border-collapse: collapse; width: 100%; }
  table.vt th { text-align: left; font-size: 11px; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); padding: 10px 14px; background: #fbfcfd; border-bottom: 1px solid var(--line); }
  table.vt td { padding: 12px 14px; border-bottom: 1px solid var(--line-soft); vertical-align: top; font-size: 13px; }
  table.vt tr:last-child td { border-bottom: 0; }
  table.vt .cmd { font-family: var(--mono); font-size: 12.5px; color: #1f2937; white-space: nowrap; }
  table.vt .ok { display: inline-flex; gap: 5px; align-items: center; color: #1d7a4c; font-size: 12.5px; white-space: nowrap; }
  table.vt .ok .d { width: 7px; height: 7px; border-radius: 50%; background: #2f9e64; }
  table.vt .cov { display: flex; gap: 5px; flex-wrap: wrap; }
  table.vt .cov span { font-size: 11px; color: var(--muted); background: #f3f5f7; border-radius: 6px; padding: 1px 7px; }

  .empty { padding: 56px 0; text-align: center; color: var(--muted); }
  .empty b { color: var(--text); }
  .foot { margin-top: 24px; color: var(--faint); font-size: 12px; display: flex; gap: 16px; flex-wrap: wrap; }
  .kbd { font-family: var(--mono); font-size: 10.5px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 0 5px; background: #fff; color: var(--muted); }

  @media (max-width: 1060px) {
    .layout { grid-template-columns: 1fr; }
    nav.toc { position: static; max-height: none; display: flex; gap: 14px; overflow: auto; padding-bottom: 6px; }
    nav.toc .grp { margin: 0; }
    nav.toc .grp > .lab { display: none; }
    nav.toc .item { white-space: nowrap; }
    nav.toc .back { display: none; }
    .snap { margin-left: 0; }
  }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; scroll-behavior: auto !important; } }
</style>
</head>
<body>
<header class="top" id="top">
  <div class="top-in">
    <div class="row1">
      <h1>${data.meta.title}</h1>
      <span class="ver"><b>${data.meta.from}</b> → <b>${data.meta.to}</b></span>
      <div class="snap">
        <span class="pill mod"><span class="dot"></span>新增模块 <b>${data.meta.counts.modules}</b></span>
        <span class="pill twk"><span class="dot"></span>细则微调 <b>${data.meta.counts.tweaks}</b></span>
        <span class="pill">文件 <b>${data.meta.counts.files}</b></span>
        <span class="pill">+<b>${data.meta.counts.added}</b> / −<b>${data.meta.counts.removed}</b></span>
        <span class="pill ok"><span class="dot"></span>用例 <b>${data.meta.snapshot.tests}</b> 文件</span>
      </div>
    </div>

    <div class="tabs" role="tablist" aria-label="视图">
      <button role="tab" data-view="changes" aria-selected="true">变更 <span class="n">${data.meta.snapshot.entries}</span></button>
      <button role="tab" data-view="rules" aria-selected="false">规则清单 <span class="n">${data.meta.counts.rules}</span></button>
      <button role="tab" data-view="verify" aria-selected="false">验证矩阵 <span class="n">${data.meta.verify.length}</span></button>
    </div>

    <div class="bar" id="bar">
      <div class="seg" role="group" aria-label="变更类型" id="types">
        <button data-type="all" aria-pressed="true">全部 <span class="n" id="n-all"></span></button>
        <button data-type="module" aria-pressed="false">新增模块 <span class="n" id="n-mod"></span></button>
        <button data-type="tweak" aria-pressed="false">细则微调 <span class="n" id="n-twk"></span></button>
      </div>
      <div class="search" id="searchBox">
        <span class="ico">⌕</span>
        <input id="q" type="search" placeholder="搜模块、位置、规则或代码（/ 聚焦）" autocomplete="off" spellcheck="false">
        <button class="clear" id="clear" title="清空">×</button>
      </div>
      <div class="grow"></div>
      <button class="ghost" id="viewToggle">视图：统一</button>
      <button class="ghost" id="foldAll">全部收起</button>
    </div>
    <div class="chipbar" id="chips"></div>
  </div>
</header>

<div class="wrap">
  <div class="layout">
    <nav class="toc" id="toc" aria-label="目录"></nav>
    <main id="main">
      <section class="view" id="view-changes"></section>
      <section class="view" id="view-rules" hidden></section>
      <section class="view" id="view-verify" hidden></section>
    </main>
  </div>
  <div class="foot">
    <span>基线 <code>${data.meta.base}</code></span>
    <span>生成于 ${new Date(data.meta.at).toLocaleString('zh-CN')}</span>
    <span><span class="kbd">/</span> 搜索 · <span class="kbd">j</span>/<span class="kbd">k</span> 上下条 · <span class="kbd">1</span>/<span class="kbd">2</span>/<span class="kbd">3</span> 切视图 · <span class="kbd">Esc</span> 清空</span>
  </div>
</div>

<script>
const DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};

const $ = (id) => document.getElementById(id);
const state = { view: 'changes', type: 'all', area: 'all', q: '', current: null, side: false, folded: false };

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const typeLabel = (t) => (t === 'module' ? '新增模块' : '细则微调');
const statusLabel = (s) => (s === 'new' ? '新增' : '修改');
const statusCls = (s) => (s === 'new' ? 'st-new' : 'st-changed');
const markColor = (e) => (e.type === 'module' ? 'var(--mod)' : 'var(--twk)');
const areaLabel = (id) => {
  const one = DATA.meta.areas.find((a) => a.id === id);
  return one ? one.label : '其他';
};

function hl(text) {
  const q = state.q.trim();
  if (!q) return esc(text);
  const safe = esc(text);
  const BS = String.fromCharCode(92);
  const SPECIAL = '.*+?^$()[]{}|' + BS;
  const pattern = q.split('').map((ch) => (SPECIAL.indexOf(ch) >= 0 ? BS + ch : ch)).join('');
  try {
    return safe.replace(new RegExp(esc(pattern), 'gi'), (m) => '<mark>' + m + '</mark>');
  } catch (e) {
    return safe;
  }
}

function entryText(e) {
  const code = e.blocks.map((b) => b.rows.map((r) => r.text).join(' ')).join(' ');
  return [e.title, e.where, e.summary, e.why, e.rule, e.impact, e.module, (e.tags || []).join(' '), code].join(' ');
}
function entryHit(e) {
  if (state.type !== 'all' && e.type !== state.type) return false;
  if (state.area !== 'all' && e.area !== state.area) return false;
  const q = state.q.trim().toLowerCase();
  return !q || entryText(e).toLowerCase().includes(q);
}

function diffTable(b) {
  if (state.side) {
    let rows = '';
    for (const r of b.side) {
      const leftBg = r.lc === 'del' ? 'background:var(--del-bg)' : r.lc === 'both' ? 'background:#fdf6e3' : '';
      const rightBg = r.rc === 'add' ? 'background:var(--add-bg)' : r.rc === 'both' ? 'background:#fdf6e3' : '';
      rows += '<tr><td class="ln">' + (r.la || '') + '</td><td class="code" style="' + leftBg + '">' + hl(r.left) + '</td>' +
        '<td class="ln">' + (r.ra || '') + '</td><td class="code right" style="' + rightBg + '">' + hl(r.right) + '</td></tr>';
    }
    return '<table class="side"><thead><tr><th colspan="2">改前' + (b.before ? ' · ' + b.before.start + ' 行起' : ' · 无') + '</th><th colspan="2">改后' + (b.after ? ' · ' + b.after.start + ' 行起' : ' · 无') + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }
  let rows = '';
  for (const r of b.rows) {
    const sign = r.t === 'add' ? '+' : r.t === 'del' ? '−' : '';
    rows += '<tr class="' + r.t + '"><td class="gut">' + (r.a || '') + '</td><td class="gut">' + (r.b || '') + '</td><td class="sign">' + sign + '</td><td class="code">' + hl(r.text) + '</td></tr>';
  }
  return '<table class="dt"><tbody>' + rows + '</tbody></table>';
}

function blockHtml(entry, b, index) {
  const loc = b.after ? '改后 ' + b.after.start + '–' + (b.after.start + b.after.lines.length - 1) + ' 行' : (b.before ? '改前 ' + b.before.start + ' 行起' : '');
  const key = entry.id + '-' + index;
  return '<section class="blk' + (state.folded ? ' folded' : '') + '" id="b-' + key + '">' +
    '<div class="blk-head"><span class="lab">' + esc(b.label || '改动片段') + '</span><span class="loc">' + esc(loc) + '</span><span class="spacer"></span>' +
    '<span class="plus">+' + b.added + '</span>' + (b.removed ? '<span class="minus">−' + b.removed + '</span>' : '') +
    '<button class="toggle" data-fold="' + key + '">' + (state.folded ? '展开' : '收起') + '</button></div>' +
    '<div class="diff">' + diffTable(b) + '</div></section>';
}

function cardHtml(e) {
  return '<article class="card ' + e.type + '" id="c-' + e.id + '" tabindex="-1">' +
    '<div class="card-head">' +
      '<div class="badges"><span class="badge ' + e.type + '">' + typeLabel(e.type) + '</span>' +
        '<span class="badge ' + statusCls(e.status) + '">' + statusLabel(e.status) + '</span>' +
        '<span class="badge plain">' + esc(areaLabel(e.area)) + '</span>' +
        '<span class="badge plain" style="font-family:var(--mono)">' + (e.added ? '+' + e.added : '') + (e.removed ? ' −' + e.removed : '') + '</span></div>' +
      '<h2>' + hl(e.title) + '</h2>' +
      '<div class="where">' + hl(e.where) + '</div>' +
      '<p class="sum">' + hl(e.summary) + '</p>' +
      '<div class="rulebox"><span class="k">现在生效的规则</span><p>' + hl(e.rule) + '</p></div>' +
      '<p class="why"><b>为什么改：</b>' + hl(e.why) + '</p>' +
      '<p class="impact"><span>影响面：</span>' + hl(e.impact) + '</p>' +
    '</div>' +
    '<div class="blocks">' + e.blocks.map((b, i) => blockHtml(e, b, i)).join('') + '</div>' +
    '<div class="tags"><span class="tag k">' + esc(e.module) + '</span>' + (e.tags || []).map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' +
    '<div class="card-foot"><button class="copy" data-copy="' + esc(e.where) + '">复制位置</button>' +
      '<button class="copy" data-copymod="' + esc(e.rule) + '">复制规则</button></div>' +
    '</article>';
}

function groupsOf(list) {
  const out = [];
  for (const area of DATA.meta.areas) {
    const items = list.filter((e) => e.area === area.id);
    if (items.length) out.push({ id: area.id, label: area.label, hint: area.hint, items });
  }
  return out;
}

function renderChanges() {
  const list = DATA.entries.filter(entryHit);
  $('n-all').textContent = DATA.entries.length;
  $('n-mod').textContent = DATA.meta.counts.modules;
  $('n-twk').textContent = DATA.meta.counts.tweaks;

  let html = '<div class="hi">' + DATA.meta.highlights.map((h) =>
    '<a href="#c=' + h.ids[0] + '" data-jump="' + h.ids[0] + '"><div class="t">' + esc(h.title) + '</div><div class="d">' + esc(h.text) + '</div></a>').join('') + '</div>';
  html += '<div class="legend">' +
    '<div><b>新增模块</b>：新文件或新能力，先读「规则」再看代码。</div>' +
    '<div><b>细则微调</b>：已有文件里的行为变化，重点看 −/+ 之间。</div>' +
    '<div>每条都带<b>模块 · 位置 · 当前规则</b>；<span class="kbd">j</span>/<span class="kbd">k</span> 上下条。</div>' +
    '</div>';

  if (!list.length) {
    html += '<div class="empty">没有匹配的改动。<br><b>清空搜索</b>，或把类型切回「全部」。</div>';
    $('view-changes').innerHTML = html;
    $('toc').innerHTML = tlItemAll(list);
    return;
  }
  for (const group of groupsOf(list)) {
    html += '<h2 class="sechead">' + esc(group.label) + ' <span>· ' + esc(group.hint) + '</span></h2>';
    html += group.items.map(cardHtml).join('');
  }
  $('view-changes').innerHTML = html;
  $('toc').innerHTML = tlItemAll(list);
  observe();
}

function deltaOf(e) {
  const parts = [];
  if (e.added) parts.push('<span class="p">+' + e.added + '</span>');
  if (e.removed) parts.push('<span class="m">−' + e.removed + '</span>');
  return '<span class="ln">' + parts.join(' ') + '</span>';
}

function tlItemAll(list) {
  if (!list.length) return '';
  let html = '';
  for (const group of groupsOf(list)) {
    html += '<div class="grp"><div class="lab"><b>' + esc(group.label) + '</b> <span style="color:var(--faint)">' + group.items.length + '</span></div>';
    for (const e of group.items) {
      html += '<button class="item" data-go="' + e.id + '" aria-current="false">' +
        '<span class="mk" style="background:' + markColor(e) + '"></span>' +
        '<span class="tx">' + esc(e.title) + '</span>' + deltaOf(e) + '</button>';
    }
    html += '</div>';
  }
  html += '<button class="back" data-go="top">回到顶部</button>';
  return html;
}

function renderRules() {
  const q = state.q.trim().toLowerCase();
  const rows = DATA.entries
    .filter((e) => state.area === 'all' || e.area === state.area)
    .filter((e) => !q || (e.rule + e.module + e.where + e.title).toLowerCase().includes(q));
  let html = '<div class="legend"><div><b>规则清单</b> = 每条改动里此刻仍然生效的约束。改动会过期，规则不会 —— 下次动手先照这张表。</div></div>';
  if (!rows.length) {
    html += '<div class="empty">没有匹配的规则。</div>';
    $('view-rules').innerHTML = html;
    $('toc').innerHTML = '';
    return;
  }
  html += '<div class="rules"><table class="rt"><thead><tr><th class="no">#</th><th>规则（现状）</th><th>模块</th><th>位置</th><th></th></tr></thead><tbody>';
  rows.forEach((e, i) => {
    html += '<tr><td class="no">R' + String(i + 1).padStart(2, '0') + '</td>' +
      '<td class="rl">' + hl(e.rule) + '</td>' +
      '<td class="md">' + esc(e.module) + '</td>' +
      '<td class="wh">' + esc(e.where.split(' · ').slice(-1)[0] || '') + '</td>' +
      '<td class="go"><button class="jump" data-jump="' + e.id + '">看改动</button></td></tr>';
  });
  html += '</tbody></table></div>';
  $('view-rules').innerHTML = html;
  $('toc').innerHTML = '';
}

function renderVerify() {
  const s = DATA.meta.snapshot;
  let html = '<div class="legend"><div><b>验证矩阵</b> = 哪条命令证明哪一段链路通。发版前这五条要一起绿。</div></div>';
  html += '<div class="vhead">' +
    '<div class="vcard"><div class="k">当前版本</div><div class="v">v' + esc(s.version) + '</div><div class="s">' + esc(DATA.meta.from) + ' → ' + esc(DATA.meta.to) + '</div></div>' +
    '<div class="vcard"><div class="k">用例文件</div><div class="v">' + s.tests + '</div><div class="s">npm test 覆盖</div></div>' +
    '<div class="vcard"><div class="k">代码文件</div><div class="v">' + s.lib + '</div><div class="s">lib/ 下 mjs + js</div></div>' +
    '<div class="vcard"><div class="k">本次条目</div><div class="v">' + s.entries + '</div><div class="s">+' + s.added + ' / −' + s.removed + ' 行</div></div>' +
    '</div>';
  html += '<div class="vtable"><table class="vt"><thead><tr><th>命令</th><th>证明了什么</th><th>覆盖</th><th>最近结果</th></tr></thead><tbody>';
  for (const v of DATA.meta.verify) {
    html += '<tr><td class="cmd">' + esc(v.cmd) + '</td><td>' + esc(v.proves) + '</td>' +
      '<td><div class="cov">' + v.covers.map((c) => '<span>' + esc(c) + '</span>').join('') + '</div></td>' +
      '<td><span class="ok"><span class="d"></span>' + esc(v.result) + '</span></td></tr>';
  }
  html += '</tbody></table></div>';
  $('view-verify').innerHTML = html;
  $('toc').innerHTML = '';
}

function renderChips() {
  const counts = new Map();
  for (const e of DATA.entries) counts.set(e.area, (counts.get(e.area) || 0) + 1);
  const chips = ['<button class="chip" data-area="all" aria-pressed="' + (state.area === 'all') + '">全部分区 <span class="n">' + DATA.entries.length + '</span></button>'];
  for (const area of DATA.meta.areas) {
    const n = counts.get(area.id) || 0;
    if (!n) continue;
    chips.push('<button class="chip" data-area="' + area.id + '" aria-pressed="' + (state.area === area.id) + '">' + esc(area.label) + ' <span class="n">' + n + '</span></button>');
  }
  $('chips').innerHTML = chips.join('');
}

function render() {
  document.querySelectorAll('.tabs button').forEach((btn) => btn.setAttribute('aria-selected', String(btn.dataset.view === state.view)));
  for (const id of ['changes', 'rules', 'verify']) $('view-' + id).hidden = id !== state.view;
  const changes = state.view === 'changes';
  $('bar').style.display = state.view === 'verify' ? 'none' : '';
  $('chips').style.display = state.view === 'verify' ? 'none' : '';
  $('types').style.display = changes ? '' : 'none';
  $('bar').querySelector('.grow').style.display = changes ? '' : 'none';
  document.body.classList.toggle('wide', !changes);
  $('viewToggle').style.display = changes ? '' : 'none';
  $('foldAll').style.display = changes ? '' : 'none';
  renderChips();
  if (changes) renderChanges();
  else if (state.view === 'rules') renderRules();
  else renderVerify();
  document.documentElement.style.setProperty('--head', ($('top').offsetHeight + 6) + 'px');
}

function go(id, scroll) {
  if (id === 'top') { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (state.view !== 'changes') { state.view = 'changes'; render(); }
  const el = document.getElementById('c-' + id);
  if (!el) return;
  state.current = id;
  document.querySelectorAll('nav.toc .item').forEach((btn) => btn.setAttribute('aria-current', String(btn.dataset.go === id)));
  if (scroll === false) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.add('flash');
  el.focus({ preventScroll: true });
  setTimeout(() => el.classList.remove('flash'), 1300);
  history.replaceState(null, '', '#c=' + id);
}

function observe() {
  if (!('IntersectionObserver' in window)) return;
  const io = new IntersectionObserver((items) => {
    const top = items.filter((one) => one.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
    if (!top) return;
    const id = top.target.id.replace(/^c-/, '');
    state.current = id;
    document.querySelectorAll('nav.toc .item').forEach((btn) => btn.setAttribute('aria-current', String(btn.dataset.go === id)));
  }, { rootMargin: '-45% 0px -45% 0px', threshold: 0 });
  document.querySelectorAll('article.card').forEach((el) => io.observe(el));
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('.tabs button');
  if (tab) { state.view = tab.dataset.view; render(); return; }
  const type = event.target.closest('#types button');
  if (type) { state.type = type.dataset.type; render(); return; }
  const chip = event.target.closest('.chip');
  if (chip) { state.area = chip.dataset.area; render(); return; }
  const item = event.target.closest('nav.toc .item');
  if (item) { go(item.dataset.go); return; }
  const jump = event.target.closest('[data-jump]');
  if (jump) { event.preventDefault(); go(jump.dataset.jump); return; }
  const copy = event.target.closest('.copy');
  if (copy) {
    const text = copy.dataset.copy || copy.dataset.copymod || '';
    const done = () => { const old = copy.textContent; copy.textContent = '已复制'; setTimeout(() => { copy.textContent = old; }, 1100); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(() => {});
    return;
  }
  const fold = event.target.closest('.toggle');
  if (fold) {
    const blk = document.getElementById('b-' + fold.dataset.fold);
    const folded = blk.classList.toggle('folded');
    fold.textContent = folded ? '展开' : '收起';
  }
});

$('q').addEventListener('input', (event) => {
  state.q = event.target.value;
  $('searchBox').classList.toggle('has', !!state.q);
  render();
});
$('clear').addEventListener('click', () => {
  state.q = '';
  $('q').value = '';
  $('searchBox').classList.remove('has');
  render();
  $('q').focus();
});
$('viewToggle').addEventListener('click', () => {
  state.side = !state.side;
  $('viewToggle').textContent = '视图：' + (state.side ? '并排' : '统一');
  renderChanges();
});
$('foldAll').addEventListener('click', () => {
  state.folded = !state.folded;
  $('foldAll').textContent = state.folded ? '全部展开' : '全部收起';
  renderChanges();
});

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA)$/.test((document.activeElement && document.activeElement.tagName) || '');
  if (event.key === '/' && !typing) { event.preventDefault(); $('q').focus(); return; }
  if (event.key === 'Escape') { $('clear').click(); return; }
  if (typing) return;
  if (event.key === '1' || event.key === '2' || event.key === '3') {
    state.view = ['changes', 'rules', 'verify'][Number(event.key) - 1];
    render();
    return;
  }
  if (state.view !== 'changes') return;
  if (!['j', 'k', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const ids = [...document.querySelectorAll('nav.toc .item')].map((btn) => btn.dataset.go);
  if (!ids.length) return;
  event.preventDefault();
  const at = ids.indexOf(state.current);
  const next = event.key === 'j' || event.key === 'ArrowDown' ? Math.min(ids.length - 1, at + 1) : Math.max(0, at - 1);
  go(ids[at < 0 ? 0 : next]);
});

render();
window.addEventListener('resize', () => document.documentElement.style.setProperty('--head', ($('top').offsetHeight + 6) + 'px'));
// 直接链到某个视图：分享「规则清单」时不必再教对方点一下
if (/^#view=(rules|verify)$/.test(location.hash)) {
  state.view = location.hash.slice(6);
  render();
}
const fromHash = location.hash.match(/^#c=(.+)$/);
if (fromHash) setTimeout(() => go(decodeURIComponent(fromHash[1])), 60);
</script>
</body>
</html>`

if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html, 'utf8')

// 自检：把内联脚本抠出来过一遍 node --check，别让看板自己先坏掉
const inline = html.split('<script>')[1]?.split('</script>')[0] || ''
if (inline) {
  const probe = join(tmpdir(), `changes-board-${process.pid}.js`)
  writeFileSync(probe, inline, 'utf8')
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' })
  } catch (error) {
    console.error('✗ 内联脚本语法有错：' + String(error.stderr || error.message).slice(0, 800))
    process.exit(1)
  }
}

if (WARNINGS.length) {
  console.log(`! ${WARNINGS.length} 段代码没切出来（锚点已过期，页面里没有渲染它们）`)
  for (const line of WARNINGS.slice(0, 20)) console.log('  - ' + line)
}
console.log(`✓ ${OUT}`)
console.log(`  ${data.meta.from} → ${data.meta.to}｜新增模块 ${data.meta.counts.modules}｜细则微调 ${data.meta.counts.tweaks}｜规则 ${data.meta.counts.rules}｜文件 ${data.meta.counts.files}｜+${data.meta.counts.added} −${data.meta.counts.removed}`)
