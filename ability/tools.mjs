/**
 * ability/tools.mjs — 工具表：真的能调的那几个，以及怎么调。
 *
 * 这份文件的规矩只有一条，但它比功能重要：
 *   **只有真的能跑出结果的工具才登记。**
 *
 * 为什么这么死板：技能页会说「会 N 项」，那个 N 是从这张表算出来的。
 * 如果为了好看把没实现的工具也登记进去，技能页就会说「会」，然后一调就报错 ——
 * 那是把清单当能力，用户照着用会一无所获。宁可显示「还没接上」。
 *
 * 未实现的工具不在这里「占位」，而是由 skill.mjs 的 missingImpl() 直接算出来：
 * 清单里写了、但表里没有，就是没接上。少一处登记，就少一处谎。
 *
 * 两类工具的区别（调用时必须分清楚）：
 *   - 不依赖会话的：算数、搜网、查记忆。参数够了就能跑；
 *   - 依赖会话的：发表情、@人、展开转发、收藏图片。需要 ctx.event 与 ctx.target，
 *     没有会话上下文时给的是「现在不在聊天里」，而不是「参数错了」。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolve, sep } from 'node:path'
import { readWeb, searchWeb, searchWebDetailed, lastNetDenied, netStatus } from './web.mjs'
import { digestForward } from './forward.mjs'
import { capabilityBrief } from '../truth/index.mjs'
import { listStickers, loadStickers, pickSticker, resolveSticker, saveSticker } from './stickers.mjs'
import { listTree, readSource, restoreBackup, rootOf, runCommand, searchSource, writeSource } from './coding.mjs'
import { openUrl, readCurrent, formatPage } from './browser.mjs'

/**
 * 本文件**不 import 任何父模块**（truth 除外：那层是纯真源，只有常量与形状）。
 *
 * 以前这里直接 import `../mind/index.mjs` 与 `../life/reminders.mjs`，
 * 靠「指向叶子文件」绕开了一个环；绕开是能跑，但方向还是反的：
 * 能力层替心智层决定了「需求本怎么读」。0.46.0 起改成装配层注入 ——
 * `createTools({ mind, life })`，谁装配谁决定给什么。
 *
 * 注入的三个后果，都是想要的：
 *   1. `ability/` 的依赖图里再没有 `mind/` `life/`（R3 判据）；
 *   2. 工具表可以在没有心智层的环境里被构造（基准脚本、只读诊断）；
 *   3. 少一份「工具偷偷写需求本、调用方不知道」的隐式副作用 —— 现在缺了就是缺了，
 *      返回 `not_wired`，和「参数写错」分开报。
 */

/**
 * 安全四则运算。手写递归下降，不用 eval、不用 new Function。
 *
 * 为什么不用 eval：表达式来自聊天内容，eval 等于把执行权交给说话的人。
 * 四则运算这点需求，手写 80 行就够，不值得开那个口子。
 *
 * 支持：+ - * / % ( ) 与小数、正负号、空格。除零给 null，不抛异常。
 */
export function calc(expression) {
  const text = String(expression || '').trim()
  if (!text) return { ok: false, error: '要算的式子空着' }
  if (text.length > 200) return { ok: false, error: '式子太长了（上限 200 字）' }

  let pos = 0
  const fail = (why) => {
    const error = new Error(why)
    error.code = 'calc'
    throw error
  }
  const skip = () => {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1
  }
  const peek = () => {
    skip()
    return text[pos]
  }

  function parseExpr() {
    let value = parseTerm()
    for (;;) {
      const op = peek()
      if (op !== '+' && op !== '-') return value
      pos += 1
      const rhs = parseTerm()
      value = op === '+' ? value + rhs : value - rhs
    }
  }

  function parseTerm() {
    let value = parseFactor()
    for (;;) {
      const op = peek()
      if (op !== '*' && op !== '/' && op !== '%') return value
      pos += 1
      const rhs = parseFactor()
      if ((op === '/' || op === '%') && rhs === 0) fail('不能除以 0')
      if (op === '*') value *= rhs
      else if (op === '/') value /= rhs
      else value %= rhs
    }
  }

  function parseFactor() {
    const ch = peek()
    if (ch === '+' || ch === '-') {
      pos += 1
      const value = parseFactor()
      return ch === '-' ? -value : value
    }
    if (ch === '(') {
      pos += 1
      const value = parseExpr()
      if (peek() !== ')') fail('括号没配对')
      pos += 1
      return value
    }
    const start = pos
    while (pos < text.length && /[0-9.]/.test(text[pos])) pos += 1
    if (pos === start) fail(`第 ${start + 1} 个字符看不懂：${text[start] || '（到头了）'}`)
    const value = Number(text.slice(start, pos))
    if (!Number.isFinite(value)) fail('这个数字不对劲')
    return value
  }

  try {
    const value = parseExpr()
    skip()
    if (pos < text.length) fail(`第 ${pos + 1} 个字符多出来了：${text[pos]}`)
    if (!Number.isFinite(value)) fail('结果不是一个正常数字')
    const rounded = Math.round(value * 1e10) / 1e10
    return { ok: true, value: rounded, text: String(rounded) }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  }
}

/** 工具的中文名；内部仍用英文 key，模型写中文也能映射回来 */
const TOOL_LABELS = Object.freeze({
  time: '当前时间',
  calc: '算数',
  web_search: '联网搜索',
  web_fetch: '读网页',
  browser: '浏览器',
  digest: '每日简报',
  exec_sandbox: '沙箱',
  self_tune: '调整自己',
  voice_to_text: '语音转文字',
  image_read: '看图',
  file_read: '读文件',
  code_list: '列代码',
  code_read: '看代码',
  code_search: '搜代码',
  code_write: '改代码',
  code_restore: '还原代码',
  run_command: '跑命令',
  audit_self: '核对自己的记录',
  my_patch_proposals: '看自查结论',
  propose_patch: '记下结论',
  close_patch: '标记处理完了',
  remind: '到点提醒',
  set_reminder: '设提醒',
  memory_search: '查记忆',
  people_lookup: '查人物',
  thread_summary: '总结群聊',
  send_sticker: '发表情',
  list_stickers: '表情列表',
  save_sticker: '收藏表情',
  send_face: '发小黄脸',
  at_person: '群里@人',
  read_forward_more: '展开转发',
  withdraw_message: '撤回消息',
  recall: '回忆旧话',
  remember_fact: '记住事实',
  remember_self: '记住自己',
  revise_self: '改写自己',
  forget_self: '忘掉想法',
  remember_person: '记住某人',
  my_memory: '我的记忆',
  my_digest: '近期摘要',
  my_status: '我的状态',
  person_dossier: '某人档案',
  group_recap: '群聊回顾',
  who_said: '谁说过',
  my_activities: '我的活动',
  my_thoughts: '我的想法',
  my_capabilities: '我会什么',
  my_schedule: '我的排期',
  group_impressions: '群印象',
  note_want: '记需求',
  my_wants: '需求本',
  resolve_want: '需求达成',
  drop_want: '删需求',
  view_avatar: '看头像',
  draw_image: '画一张图',
  news_now: '看热榜',
  hot_news: '看热点',
  owner_commands: '指令表',
  write_notebook: '写本子',
  read_notebook: '看本子',
  read_persona: '读人设',
  revise_persona: '改人设',
  absorb_habit: '记手感',
  persona_versions: '人设版本',
  rollback_persona: '退回人设',
  refuse_person: '不想理他',
})

/**
 * 最简单的编辑距离（只用来猜「模型拼错的工具名」）。
 * 不值得引入依赖：候选集只有几十个短名字，两层循环足够快。
 */
function editDistance(a, b) {
  const m = a.length
  const n = b.length
  if (!m || !n) return Math.max(m, n)
  let prev = Array.from({ length: n + 1 }, (_, index) => index)
  for (let i = 1; i <= m; i += 1) {
    const cur = [i]
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

/**
 * 工具名拆成词：`web_search` / `web-search` / `webSearch` 都得到同一组词。
 * 用来认「词都对，就是顺序不一样」这种拼写 —— 模型最常犯的一类。
 */
function tokensOf(name) {
  return String(name || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5]+/)
    .filter(Boolean)
    .sort()
    .join('|')
}

/**
 * 猜模型想调的是哪个工具。
 * 先看包含关系（web_search / search），再看词集合（search_web / web_search），
 * 最后看编辑距离（remind / reminer）。
 * 只给 3 个以内的候选：给一整张表等于让它再猜一次。
 */
function nearestTools(name, names, limit = 3) {
  const raw = String(name || '').toLowerCase()
  if (!raw) return []
  const rawTokens = tokensOf(raw)
  return names
    .map((one) => {
      const key = String(one).toLowerCase()
      if (key === raw) return { one, score: 0 }
      if (key.includes(raw) || raw.includes(key)) return { one, score: 1 }
      // 词都对、顺序不对（search_web ↔ web_search）：这不是笔误，是同一句话的两种排列，
      // 编辑距离会把它算成 8，于是最该被认出来的一种反而落到「没猜出来」。
      if (rawTokens && rawTokens === tokensOf(key)) return { one, score: 1 }
      return { one, score: editDistance(raw, key) }
    })
    .filter((row) => row.score <= 3)
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((row) => row.one)
}

const TOOL_ALIASES = Object.freeze(Object.fromEntries(
  Object.entries(TOOL_LABELS).map(([key, label]) => [label, key]),
))

/**
 * 这个工具花的 token 算哪一档。
 *
 * 为什么放在工具表旁边：工具名叫什么、属于哪一档，是同一件事的两面，
 * 分两个文件写迟早会出现「新加了搜索工具，账却记进『工具调用』」。
 * 也认中文别名 —— 模型被教过写中文名，账单不能因为写法不同就分错档。
 *
 * 沙箱与跑命令归 'sandbox'：它们真正贵的是「为它写代码」和「读它的输出」，
 * 执行本身吃 CPU 不吃 token。单独一档才能回答「沙箱是不是在烧钱」。
 */
const TOOL_SOURCES = Object.freeze({
  web_search: 'search',
  web_fetch: 'search',
  news_now: 'search',
  hot_news: 'search',
  exec_sandbox: 'sandbox',
  run_command: 'sandbox',
})

/** @returns {'search'|'sandbox'|'tool'} */
export function usageSourceOfTool(name) {
  const key = TOOL_ALIASES[String(name || '').trim()] || String(name || '').trim()
  return TOOL_SOURCES[key] || 'tool'
}

/**
 * 闲聊档保留的工具。
 *
 * 为什么要有这一档：工具名清单是提示词里最大的一块静态文本（65 个名字 ≈ 750 字），
 * 而大部分 QQ 消息只是「在吗 / 哈哈 / 晚安」，根本不会调工具。把它们全列出来，
 * 每轮都在为「可能要做的事」付一遍钱。
 *
 * 取舍：**动作类消息仍然拿全表**（见 turn.mjs 的 needsFullTools），这里只收
 * 聊天里真会用到的那一组：时间、算数、联网、记忆、表情、提醒、看图、看文件。
 * `my_capabilities` 留在里面 —— 模型不确定自己会不会时，可以先查一遍再答。
 */
const CHAT_TOOLS = Object.freeze(new Set([
  'time', 'calc', 'web_search', 'web_fetch', 'browser',
  'recall', 'remember_fact', 'remember_person', 'remember_self', 'my_memory', 'my_digest',
  'my_status', 'my_capabilities', 'owner_commands',
  'send_sticker', 'send_face', 'at_person', 'read_forward_more', 'withdraw_message',
  'draw_image', 'news_now', 'hot_news',
  'remind', 'set_reminder', 'note_want', 'my_wants',
  'file_read', 'image_read',
]))

/** 提示词里只给一行；太长会挤掉真正的上下文 */
const TOOL_HINTS = Object.freeze({
  code_search: '{"keyword":"Sandbox","max":10}',
  code_read: '{"path":"lib/sandbox.mjs","start":1,"count":60}',
  code_write: '{"path":"lib/demo.mjs","content":"整份文件内容"}',
  code_list: '{"path":"lib","recursive":0}',
  run_command: '{"bin":"node","args":["scripts/check-layers.mjs"]}',
  recall: '{"query":"上次说的那个"}',
  browser: '{"action":"open","url":"https://example.com"}',
  send_sticker: '{"mood":"无语"}',
  withdraw_message: '{"next":true}',
  at_person: '{"qq":"10001","text":"在呢"}',
  news_now: '{"source":"weibo"}',
  note_want: '{"what":"想看某本书"}',
  person_dossier: '{"qq":"10001"}',
  group_recap: '{"groupId":"123456"}',
  save_sticker: '{"tags":"无语,猫"}',
  remind: '{"at":"明天早上9点","text":"喝水"}',
  set_reminder: '{"at":"2026-11-08 09:00","text":"要提醒的事"}',
  draw_image: '{"prompt":"一只蓝色鲸鱼在云里"}',
  exec_sandbox: '{"code":"console.log(1)","plan":["算一下"]}',
  who_said: '{"word":"裁员"}',
  read_forward_more: '{"from":6,"count":12}',
  my_status: '{}',
  audit_self: '{}',
  my_patch_proposals: '{}',
  read_persona: '{}',
  revise_persona: '{"section":"五、眼光与分寸","text":"新的这一条规矩","reason":"为什么改"}',
  absorb_habit: '{"text":"听不懂就扣一个问号"}',
})

/**
 * 哪几个示例进提示词。以前是 Object.entries().slice(0,10)，
 * 前十个恰好被 code_* 与表情相关占满，跨会话与自查工具一个例子都没有 ——
 * 模型知道有 group_recap，却不知道它长什么样，于是被问到别的群时
 * 只会答「看不到」。这里按「主人最常问什么」排，而不是按登记顺序。
 */
const HINT_ORDER = Object.freeze([
  'code_search', 'code_read', 'code_list',
  'remind', 'revise_persona', 'group_recap',
  'who_said', 'person_dossier', 'my_memory',
  'browser', 'recall', 'withdraw_message', 'read_forward_more', 'my_status',
  'audit_self', 'my_patch_proposals',
])

/** QQ 小黄脸：只列常用的，其余按数字 id 也能发 */
const FACE_NAMES = Object.freeze({
  微笑: 14, 呲牙: 13, 偷笑: 12, 得意: 4, 害羞: 6, 流泪: 5, 大哭: 9, 睡: 8,
  惊讶: 0, 撇嘴: 1, 色: 2, 发呆: 3, 闭嘴: 7, 尴尬: 10, 发怒: 11, 调皮: 12,
  白眼: 20, 鼓掌: 99, 握手: 124, 强: 76, 弱: 77, 抱拳: 118, 玫瑰: 63,
})

/** 热榜来源；查不到就如实说查不到，不编标题 */
const NEWS_SOURCES = Object.freeze({
  weibo: { label: '微博热搜', query: '微博热搜榜 今天' },
  zhihu: { label: '知乎热榜', query: '知乎热榜 今天' },
  baidu: { label: '百度热搜', query: '百度热搜榜 今天' },
  toutiao: { label: '头条热榜', query: '今日头条热榜 今天' },
  douyin: { label: '抖音热榜', query: '抖音热榜 今天' },
  bilibili: { label: 'B站热门', query: 'B站热门视频 今天' },
  ithome: { label: 'IT之家', query: 'IT之家 最新科技新闻' },
  thepaper: { label: '澎湃新闻', query: '澎湃新闻 今天' },
  cls: { label: '财联社', query: '财联社 今日财经' },
  github: { label: 'GitHub 趋势', query: 'GitHub trending 今日热门项目' },
  sspai: { label: '少数派', query: '少数派 最新文章' },
  v2ex: { label: 'V2EX', query: 'V2EX 热门 今天' },
  juejin: { label: '掘金', query: '掘金 前端 热门文章' },
  '36kr': { label: '36氪', query: '36氪 今日科技商业' },
  hackernews: { label: 'Hacker News', query: 'Hacker News top today' },
})

/** 写进长期记忆前必须挡住的：QQ 号、密钥、服务器路径、口令 */
const SENSITIVE = /(\b\d{6,12}\b)|sk-[A-Za-z0-9]{10,}|\/root\/|token|password|密码|口令|api[_-]?key/i

const MAX_IMAGE_BYTES = 2 * 1024 * 1024

function brief(value, max = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function stamp(at) {
  const date = new Date(Number(at) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function todayKey(at = Date.now()) {
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 临时图片的扩展名要跟内容一致；写死 .jpg 会让视觉接口按错误的 mediaType 读图 */
function imageExt(buffer) {
  const head = buffer && buffer.length > 12 ? buffer : Buffer.alloc(0)
  if (head[0] === 0x89 && head[1] === 0x50) return 'png'
  if (head[0] === 0x47 && head[1] === 0x49) return 'gif'
  if (head[0] === 0x52 && head[1] === 0x49) return 'webp'
  return 'jpg'
}

function scopeName(row) {
  if (row?.scope === 'group') return `群 ${row.group || String(row.conversation || '').replace(/^group:/, '')}`
  return '私聊'
}

/** 事件的说话人；自己的话标「我」 */
function whoOf(row) {
  if (row?.from === 'self' || row?.sender === '我') return '我'
  return String(row?.sender || row?.from || '某人')
}

/**
 * 建工具表。
 *
 * @param {object} input
 * @param {object} input.runtime 运行时
 * @param {object} [input.channel] 通道；发表情、@人、看头像要用
 * @param {object} [input.usage]   用量；状态工具要用
 * @param {string} [input.dir]     数据目录；不传用 runtime.dir
 * @param {object} [input.mind]    心智层：`{ addWant, dropWant, listWants, resolveWant, wantStats, refuse }`
 * @param {object} [input.life]    生活层：`{ parseWhen, parseReminder, describeAt }`
 */
export function createTools(input = {}) {
  const runtime = input.runtime || null
  const channel = input.channel || null
  const usage = input.usage || null
  const mind = input.mind || null
  const life = input.life || null
  const dir = String(input.dir || runtime?.dir || process.cwd())
  const registry = new Map()
  const buckets = new Map()
  let lastFaceAt = 0

  const needMind = () => (mind ? null : { ok: false, error: '心智层没接上（需求本 / 拒聊名单）', code: 'not_wired' })
  const needLife = () => (life ? null : { ok: false, error: '生活层没接上（提醒时间解析）', code: 'not_wired' })

  const add = (name, handler) => {
    registry.set(name, handler)
    // 登记到技能层：从此技能页会把用到它的那几项算成「能用」
    if (runtime && typeof runtime.registerTools === 'function') runtime.registerTools([name])
  }

  /** 频率闸：同一件事一小时最多几次。返回 false 表示这次不给 */
  const allow = (key, max, windowMs) => {
    const now = Date.now()
    const list = (buckets.get(key) || []).filter((at) => now - at < windowMs)
    if (list.length >= max) {
      buckets.set(key, list)
      return false
    }
    list.push(now)
    buckets.set(key, list)
    return true
  }

  const needChannel = () => {
    if (!channel) return { ok: false, error: '通道没接上，发不出去', code: 'not_wired' }
    return null
  }

  /** 浏览器工具和主人命令共用同一份配置，避免两套默认值 */
  const browserConfig = () => ({
    browserHeadless: runtime?.config?.browser?.headless !== false,
    browserCdpUrl: String(runtime?.config?.browser?.cdpUrl || ''),
    browserAllowPrivate: runtime?.config?.browser?.allowPrivate === true,
    browserIdleMinutes: Number(runtime?.config?.browser?.idleMinutes) || 10,
    browserMaxPerHour: Number(runtime?.config?.browser?.maxPerHour) || 60,
    browserProfileDir: path.join(runtime?.dir || '', 'browser-profile'),
    renderBrowserPath: String(runtime?.config?.browser?.path || ''),
    browserTimeoutMs: 12_000,
    browserMaxChars: 3000,
  })

  /** 当前会话的发送目标；没有会话上下文就返回 null */
  const targetOf = (ctx = {}) => {
    const event = ctx.event
    if (!event) return null
    const scope = event.scope === 'group' ? 'group' : 'private'
    const target = scope === 'group' ? event.payload?.groupId : event.from
    if (!target) return null
    return { scope, target: String(target), conversation: event.conversation }
  }

  /**
   * 最近的消息（不含心跳/通知）。所有「读 N 条」都必须走这里：
   * 直接拿原始事件行会读到 80% 的心跳，名义 12 条实际只剩两三条。
   */
  const messages = (limit = 1500) => {
    try {
      return runtime?.events?.read({
        limit,
        maxScan: 6000,
        filter: (row) => row?.type === 'message' || row?.type === 'image',
      })?.rows || []
    } catch {
      return []
    }
  }

  /** 把一张聊天图片落成 Buffer：本地文件 → URL → 协议端 get_image */
  const imageBuffer = async (pic = {}) => {
    // 收消息时已经把本体存下来了（lib/media.mjs），这里优先用本地那份：
    // 既省一次下载，也不怕 CDN 链接过期 —— 收藏失败的根因就在过期链接上。
    if (pic && pic.persist) {
      const saved = await Promise.resolve(pic.persist).catch(() => null)
      if (saved?.path) {
        try {
          if (existsSync(saved.path) && statSync(saved.path).size <= MAX_IMAGE_BYTES) return readFileSync(saved.path)
        } catch {}
      }
    }
    const raw = String(pic.file || '')
    const local = raw.replace(/^file:\/\//, '')
    try {
      if (local && existsSync(local) && statSync(local).size <= MAX_IMAGE_BYTES) return readFileSync(local)
    } catch {}
    const download = async (url) => {
      if (!/^https?:/i.test(String(url || ''))) return null
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://qq.com/' },
          signal: AbortSignal.timeout(12_000),
        })
        const type = String(res.headers.get('content-type') || '')
        if (!res.ok || (type && !type.startsWith('image/'))) return null
        const buffer = Buffer.from(await res.arrayBuffer())
        return buffer.length && buffer.length <= MAX_IMAGE_BYTES ? buffer : null
      } catch {
        return null
      }
    }
    let buffer = await download(pic.url)
    if (buffer) return buffer
    if (channel && typeof channel.getImage === 'function') {
      const got = await channel.getImage(raw || pic.url || '')
      if (got.base64) {
        const data = Buffer.from(got.base64, 'base64')
        return data.length <= MAX_IMAGE_BYTES ? data : null
      }
      if (got.url) {
        buffer = await download(got.url)
        if (buffer) return buffer
      }
      if (got.file && existsSync(got.file)) {
        try {
          if (statSync(got.file).size <= MAX_IMAGE_BYTES) return readFileSync(got.file)
        } catch {}
      }
    }
    return null
  }

  // ── 基础 ──────────────────────────────────────────────────────

  /**
   * 草稿纸：沙箱工作区。
   *
   * 和源码目录的分工 —— **源码是身家，工作区是稿纸**：
   * 源码那边每改一笔都要备份、关键文件还要点头；工作区这边怎么写都不伤筋动骨，
   * 而且写完不会随一次运行被回收 —— 上一次写的脚本下一次还在，
   * 计划可以锚在同一个地方，不必每次都从零开始。
   *
   * 目录由 Sandbox 负责创建；这里兜底再建一次，是因为工具表可能先于沙箱装配
   * （也可能沙箱压根没接上）—— 那样会让「我的文件」永远是个不存在的目录。
   */
  const workRoot = String(input.workspace || runtime?.sandbox?.workspace || path.join(dir, 'sandbox', 'workspace'))
  try {
    mkdirSync(workRoot, { recursive: true })
  } catch {}

  add('time', () => {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(new Date())
    const get = (type) => parts.find((part) => part.type === type)?.value || ''
    return {
      ok: true,
      text: `现在是 ${get('year')}年${get('month')}月${get('day')}日 ${get('weekday')} ${get('hour')}:${get('minute')}:${get('second')}（北京时间）`,
    }
  })

  add('calc', (args) => {
    const value = calc(args?.expression ?? args?.text ?? '')
    if (!value.ok) return { ok: false, error: value.error }
    return { ok: true, text: value.text, data: { value: value.value } }
  })

  add('web_search', async (args = {}) => {
    const query = String(args.query ?? args.text ?? '').trim()
    if (!query) return { ok: false, error: '要搜什么？' }
    const rowsFound = await searchWeb(query)
    if (rowsFound.length) return { ok: true, text: rowsFound.join('\n') }
    // 闸门在 web.mjs 统一过：白名单空、域名没放行、次数到上限，都要说清是「被拦」
    // 而不是「没搜到」—— 不然用户会以为网络坏了，其实只是设置没开。
    return { ok: false, error: lastNetDenied() || '没搜到结果', code: lastNetDenied() ? 'net_denied' : '' }
  })

  add('web_fetch', async (args = {}) => {
    const url = String(args.url ?? args.href ?? '').trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '要一个 http(s) 网址' }
    const result = await readWeb(url)
    return result.ok
      ? { ok: true, text: `${result.title ? result.title + '\n' : ''}${result.text}` }
      : { ok: false, error: result.error, code: result.code || '' }
  })

  add('digest', () => ({ ok: true, text: runtime && typeof runtime.dailyDigest === 'function' ? runtime.dailyDigest() : '还没有简报' }))

  // 沙箱不在这里实现：闸门、预算、熔断、隔离全在 lib/sandbox.mjs，
  // 这一行只负责「把一段代码交给执行器，再把结果翻译成工具结果」。
  add('exec_sandbox', async (args = {}) => {
    const sandbox = runtime?.sandbox
    if (!sandbox || typeof sandbox.run !== 'function') {
      return { ok: false, error: '执行器没有接上本次运行', code: 'not_wired' }
    }
    const result = await sandbox.run({
      code: String(args.code || ''),
      plan: args.plan,
      label: String(args.label || ''),
    })
    return result.ok
      ? { ok: true, text: result.text, data: result.data || {} }
      : { ok: false, error: result.error, code: result.code || 'sandbox_denied' }
  })

  add('self_tune', (args = {}) => {
    if (!runtime || typeof runtime.setConfig !== 'function') return { ok: false, error: '运行时不支持改配置' }
    const key = String(args.key || '')
    if (!['persona.verbosity', 'persona.maxParts', 'tools.maxRounds'].includes(key)) {
      return { ok: false, error: '只能调话多话少、分条数、工具轮次上限（tools.maxRounds）' }
    }
    let value
    if (key === 'tools.maxRounds') {
      value = Math.max(0, Math.min(24, Math.floor(Number(args.value) || 0)))
    } else if (key === 'persona.verbosity') {
      // 话多话少是枚举，不是数字 —— 早先这里是「每条多少字」，
      // 于是「说话短一点」被翻译成「每条最多 12 字」，把语气改成了节拍器。
      const wanted = String(args.value || '')
      if (!['brief', 'normal', 'chatty'].includes(wanted)) {
        return { ok: false, error: '话多话少只能是 brief（简短）/ normal（正常）/ chatty（爱聊）' }
      }
      value = wanted
    } else {
      value = Math.max(1, Math.min(4, Number(args.value) || 0))
    }
    const result = runtime.setConfig(key, value, { confirm: false })
    return result.ok ? { ok: true, text: '改好了：' + key + ' = ' + value } : { ok: false, error: result.message || result.error }
  })

  add('voice_to_text', async (args = {}) => {
    if (!runtime || typeof runtime.transcribeFile !== 'function') return { ok: false, error: '语音识别还没接上' }
    const result = await runtime.transcribeFile(String(args.path || args.file || ''))
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error }
  })

  add('image_read', async (args = {}, ctx = {}) => {
    if (!runtime || typeof runtime.describeImageFile !== 'function') return { ok: false, error: '看图能力还没接上' }
    const file = String(args.path || args.file || '')
    if (!file) {
      // 图片和「看看这图里的字」经常是两条消息：当前这条只有文字。
      // 先看当前/引用，再往这个会话最近的事件里找带图的，不能直接让用户重发。
      let pic = ctx.event?.payload?.images?.[0] || ctx.quote?.images?.[0] || null
      if (!pic && Array.isArray(ctx.forwardAll)) {
        for (const row of ctx.forwardAll) {
          const one = Array.isArray(row?.imageItems) ? row.imageItems[0] : null
          if (one?.file || one?.url) { pic = one; break }
        }
      }
      if (!pic && runtime?.events?.read) {
        try {
          const rows = runtime.events.read({
            limit: 60,
            maxScan: 3000,
            filter: (row) => (!ctx.event?.conversation || row?.conversation === ctx.event.conversation)
              && ((Array.isArray(row?.images) && row.images.length > 0)
                || (Array.isArray(row?.payload?.images) && row.payload.images.length > 0)),
          })?.rows || []
          pic = rows[0]?.images?.[0] || rows[0]?.payload?.images?.[0] || null
        } catch {}
      }
      if (!pic) return { ok: false, error: '要给我一张图（文件路径或聊天里的图）' }
      const buffer = await imageBuffer(pic)
      if (!buffer) return { ok: false, error: '这张图取不到' }
      const temp = path.join(tmpdir(), `whale-see-${Date.now()}.${imageExt(buffer)}`)
      writeFileSync(temp, buffer)
      try {
        const result = await runtime.describeImageFile(temp, String(args.question || ''))
        return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error }
      } finally {
        try { unlinkSync(temp) } catch {}
      }
    }
    const result = await runtime.describeImageFile(file, String(args.question || ''))
    return result.ok ? { ok: true, text: result.text } : { ok: false, error: result.error }
  })

  // 读的根就是沙箱工作区。以前这里拼的是 `<数据目录>/workspace` ——
  // 那个目录从来没有人创建过，于是这个工具永远只能回「只能读工作目录里的文件」，
  // 看着像权限问题，实际是没人 mkdir。现在两边收敛到同一个位置。
  add('file_read', (args = {}) => {
    try {
      const root = workRoot
      const target = resolve(root, String(args.path || args.file || ''))
      if (target !== root && !target.startsWith(root + sep)) return { ok: false, error: '只能读工作目录里的文件' }
      if (statSync(target).size > 200_000) return { ok: false, error: '文件太大，先别整份读' }
      return { ok: true, text: readFileSync(target, 'utf8').slice(0, 4000) }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  })

  // ── 改自己的代码 ──────────────────────────────────────────────
  // 这一组的边界**全在 lib/coding.mjs**，tools.mjs 一行判都不判：
  // 「路径不许出插件目录」「关键启动文件不许随便改」「改之前先备份」三件事，
  // 分散到每个工具里各判一次，迟早有一个工具漏判一次；漏判一次的代价是插件起不来。
  // 这里只做两件事：按档位决定给不给用，再把结果翻译成有 ok/text 的工具结果。
  const codeRoot = String(input.sourceRoot || process.env.SHENLAN_SRC_DIR || rootOf())
  const backupRoot = path.join(dir, 'backups', 'code')
  const areaRoot = (args = {}) => (String(args.area || '').trim() === 'work' ? workRoot : codeRoot)
  /** 改代码这件事的整体档位。运行时不在（离线/测试）时按 write 处理，方便单独验证 */
  const codeMode = () => {
    const raw = String(runtime?.config?.sandbox?.codeMode || 'write')
    return ['off', 'read', 'write'].includes(raw) ? raw : 'write'
  }
  const MODE_TEXT = Object.freeze({
    off: '动自己代码这一项是关着的（设置 → 沙箱 → 改代码档位）。',
    read: '现在只能看代码、不能改（设置 → 沙箱 → 改代码档位）。',
  })
  /** 读类工具：off 之外都给 */
  const readGate = (modeNow) => (modeNow === 'off' ? { ok: false, code: 'code_off', error: MODE_TEXT.off } : null)
  /** 写类工具：只有 write 档给。off 与 read 的错误码要分开 —— 都叫 code_readonly 的话，
   *  模型会以为「改个配置就能写」，而 off 是「压根不许碰」两种不同的处境。 */
  const writeGate = (modeNow) => {
    if (modeNow === 'write') return null
    return modeNow === 'off'
      ? { ok: false, code: 'code_off', error: MODE_TEXT.off }
      : { ok: false, code: 'code_readonly', error: MODE_TEXT.read }
  }

  add('code_list', (args = {}) => {
    const gate = readGate(codeMode())
    return gate || listTree(areaRoot(args), args)
  })

  add('code_read', (args = {}) => {
    const gate = readGate(codeMode())
    return gate || readSource(areaRoot(args), args)
  })

  add('code_search', (args = {}) => {
    const gate = readGate(codeMode())
    return gate || searchSource(areaRoot(args), args)
  })

  add('code_write', (args = {}) => {
    const gate = writeGate(codeMode())
    if (gate) return gate
    const result = writeSource(areaRoot(args), { ...args, backupDir: backupRoot })
    // 每一次落笔都留痕：改了哪个文件、多少字节、有没有动保护名单。
    // 事后要能把「它到底动了什么」回答出来，这是让自主成立的前提。
    runtime?.log?.('code_write', {
      file: result.data?.path || String(args.path || ''),
      bytes: result.data?.bytes || 0,
      ok: result.ok === true,
      protected: result.data?.protected === true,
      code: result.code || '',
    })
    return result
  })

  add('code_restore', (args = {}) => {
    const gate = writeGate(codeMode())
    if (gate) return gate
    const result = restoreBackup(codeRoot, { ...args, backupDir: backupRoot })
    runtime?.log?.('code_restore', { file: result.data?.path || String(args.path || ''), ok: result.ok === true })
    return result
  })

  add('run_command', (args = {}) => {
    const gate = writeGate(codeMode())
    if (gate) return gate
    return runCommand(areaRoot(args), args)
  })

  /**
   * 设提醒。参数名要宽容：模型最常写的是 content/time，而内部一直只认
   * minutes/text —— 线上就是这样把「明天 9 点」落成 5 分钟、把内容丢成
   * 「时间到了」的。这里同时接受绝对时间和相对分钟数；**给了时间却解析
   * 不出来时必须报错，绝不能再悄悄退回 5 分钟**。
   */
  const setReminder = (args = {}, ctx = {}) => {
    if (!runtime || !runtime.reminders) return { ok: false, error: '提醒存储不可用' }
    const noLife = needLife()
    if (noLife) return noLife
    const pick = (...keys) => {
      for (const key of keys) {
        const value = args[key]
        if (value !== undefined && value !== null && String(value).trim() !== '') return value
      }
      return undefined
    }
    const now = Date.now()
    const timeRaw = pick('at', 'time', 'when', 'datetime', 'date', 'remind_at', 'remindAt')
    const minutesRaw = pick('minutes', 'min', 'delayMinutes', 'inMinutes', 'afterMinutes')
    let when
    if (timeRaw !== undefined) {
      when = life.parseWhen(timeRaw, now)
      if (!when.ok) {
        return {
          ok: false,
          error: `${when.error}。可以用「明天早上 9 点」「2026-11-08 09:00」，或者 minutes 写几分钟后。`,
        }
      }
    } else if (minutesRaw !== undefined) {
      const minutes = Number(minutesRaw)
      if (!Number.isFinite(minutes) || minutes <= 0) return { ok: false, error: 'minutes 要是大于 0 的数字' }
      when = life.parseWhen(`${minutes} 分钟后`, now)
      if (!when.ok) return { ok: false, error: when.error }
    } else {
      return {
        ok: false,
        error: '没说什么时候提醒。给 time（例如「明天早上 9 点」）或 minutes（例如 30）。',
      }
    }

    let text = String(pick('text', 'content', 'message', 'what', 'note', 'body', 'reminder') ?? '').trim().slice(0, 180)
    if (!text) {
      // 模型只给了时间时，从当前这条消息里抽内容；抽不到就报错，
      // 不要用「时间到了」冒充用户要提醒的事。
      const raw = String(ctx.event?.payload?.text || '')
      const fromMessage = raw ? life.parseReminder(raw, now)?.text : ''
      if (fromMessage && fromMessage !== '时间到了') text = fromMessage.slice(0, 180)
    }
    if (!text) return { ok: false, error: '没说提醒什么内容。把要提醒的事写在 text 里。' }

    const to = String(args.to || runtime.config?.identity?.ownerId || '')
    if (!to) return { ok: false, error: '不知道提醒谁：主人号还没配置' }
    const result = runtime.reminders.add({ at: when.at, text, to })
    if (!result.ok) return { ok: false, error: result.error }
    const label = life.describeAt(result.item.at, now)
    if (result.duplicated) {
      return { ok: true, text: `这条已经记过了：${label} 提醒你「${text}」，不重复设。`, data: { at: result.item.at, text, to, duplicated: true } }
    }
    return { ok: true, text: `好，${label} 提醒你：${text}`, data: { at: result.item.at, text, to } }
  }
  add('remind', setReminder)
  add('set_reminder', setReminder)

  add('memory_search', (args = {}) => {
    const memory = runtime && runtime.memory
    const query = String(args.query ?? args.text ?? '').trim()
    if (!memory || !query) return { ok: false, error: '没有可查的记忆' }
    const facts = memory.facts().filter((item) => String(item.text || '').includes(query)).slice(-8)
    const people = Object.values(memory.data.people || {}).filter((item) => String(item.name || '').includes(query) || String(item.uin || '').includes(query)).slice(-5)
    const self = memory.selfNotes().filter((item) => String(item.text || '').includes(query)).slice(-5)
    const lines = [
      ...facts.map((item) => '事实：' + item.text),
      ...self.map((item) => '想法：' + item.text),
      ...people.map((item) => `${item.name || item.uin}`),
    ]
    return lines.length ? { ok: true, text: lines.join('\n') } : { ok: false, error: '没找到相关记忆' }
  })

  add('people_lookup', (args = {}) => {
    const memory = runtime && runtime.memory
    const key = String(args.uin ?? args.qq ?? args.name ?? args.query ?? '').trim()
    if (!memory || !key) return { ok: false, error: '没有可查的人' }
    const person = Object.values(memory.data.people || {}).find((item) => String(item.uin) === key || String(item.name || '').includes(key))
    return person ? { ok: true, text: `${person.name || person.uin}（${person.uin}）\n${(person.notes || []).join('；')}` } : { ok: false, error: '没有这个人的档案' }
  })

  add('thread_summary', (args = {}, ctx = {}) => {
    if (!runtime || !runtime.events) return { ok: false, error: '没有事件记录' }
    const conversation = String(args.conversation || ctx.event?.conversation || '').trim()
    const list = messages(2000)
      .filter((row) => row.scope === 'group' && (!conversation || row.conversation === conversation))
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
      .slice(0, Math.max(3, Math.min(30, Number(args.limit) || 12)))
      .reverse()
    const lines = list
      .map((row) => `${whoOf(row)}：${brief(row.text, 100)}`)
      .filter((line) => !line.endsWith('：'))
    return lines.length ? { ok: true, text: lines.join('\n') } : { ok: false, error: '最近没有可总结的群聊' }
  })

  // ── QQ 会话内动作 ─────────────────────────────────────────────

  add('send_sticker', async (args = {}, ctx = {}) => {
    const missing = needChannel()
    if (missing) return missing
    const target = targetOf(ctx)
    if (!target) return { ok: false, error: '现在不在聊天里，不知道发给谁' }
    const items = loadStickers(dir)
    if (!items.length) return { ok: false, error: '表情包库还是空的，先收藏几张' }
    const key = args.name ?? args.index ?? args.no
    const tag = String(args.mood ?? args.tag ?? args.label ?? '').trim()
    const item = key !== undefined && key !== null && String(key).trim()
      ? resolveSticker(items, key)
      : pickSticker(items, tag)
    if (!item) return { ok: false, error: tag ? `库里没有「${tag}」这种情绪的表情` : '没有找到那张表情' }
    try {
      await channel.sendImage(target.scope, target.target, item.path)
    } catch (error) {
      return { ok: false, error: '表情没发出去：' + brief(error?.message || error, 80) }
    }
    return { ok: true, text: `发了一张表情${item.labels.length ? '（' + item.labels.join('、') + '）' : ''}`, data: { file: item.file, labels: item.labels } }
  })

  add('list_stickers', (args = {}) => {
    const items = loadStickers(dir)
    if (!items.length) return { ok: true, text: '表情包库还是空的。' }
    const tag = String(args.tag ?? args.mood ?? '').trim().toLowerCase()
    const filtered = tag
      ? items.filter((item) => item.labels.some((label) => label.toLowerCase().includes(tag) || tag.includes(label.toLowerCase())))
      : items
    if (!filtered.length) return { ok: true, text: `没有带「${tag}」标签的表情。` }
    const lines = listStickers(filtered, { limit: Math.max(1, Math.min(40, Number(args.limit) || 30)) })
    return { ok: true, text: `共 ${filtered.length} 张\n${lines.join('\n')}` }
  })

  add('save_sticker', async (args = {}, ctx = {}) => {
    const pics = ctx.event?.payload?.images || []
    const which = Math.max(1, Number(args.which || args.index) || 1) - 1
    let pic = pics[which]
    if (!pic) {
      // 最常见的用法是「先发一张图，再补一句『收藏这个表情』」—— 那是两条消息，
      // 收藏时这条里当然没有图。往上翻最近一条带图的，才算真的能用。
      try {
        const found = runtime.events.read({
          limit: 60,
          maxScan: 3000,
          filter: (row) => (!ctx.event?.conversation || row?.conversation === ctx.event.conversation)
            && ((Array.isArray(row?.images) && row.images.length > 0)
              || (Array.isArray(row?.payload?.images) && row.payload.images.length > 0)),
        })?.rows || []
        const latest = found[0]?.images || found[0]?.payload?.images || []
        pic = latest[0] || null
      } catch {}
    }
    if (!pic) return { ok: false, error: '这条消息里没有可收藏的图片，先发一张图给我' }
    if (!allow('save_sticker', 5, 3_600_000)) return { ok: false, error: '这一小时存得够多了，先攒着' }
    // 落盘过的直接读本地：不再依赖那张早就过期的 CDN 链接
    if (pic.cached && pic.localPath) {
      try {
        if (existsSync(pic.localPath)) {
          const buffer = readFileSync(pic.localPath)
          return saveStickerResult(buffer)
        }
      } catch {}
    }
    const buffer = await imageBuffer(pic)
    if (!buffer) return { ok: false, error: '这张图取不到（可能已经过期，或者超出大小上限），你重发一张' }
    return saveStickerResult(buffer)

    function saveStickerResult(buffer) {
      const raw = String(args.tags ?? args.labels ?? '')
      const fromText = raw || String(ctx.event?.payload?.text || '').replace(/^.*?(?:表情|收藏)/, '').replace(/^[，,：:\s]+/, '')
      const result = saveSticker({
        dir,
        buffer,
        labels: fromText,
        from: ctx.event?.from || '',
        source: ctx.event?.scope || '',
        now: Date.now(),
      })
      if (!result.ok) return { ok: false, error: result.error }
      return {
        ok: true,
        text: result.duplicated
          ? '这张已经有了，标签补上了' + (result.item.labels.length ? '：' + result.item.labels.join('、') : '')
          : '存好了' + (result.item.labels.length ? '，标签：' + result.item.labels.join('、') : '，还没打标签'),
        data: { file: result.item.file, labels: result.item.labels },
      }
    }
  })

  add('send_face', async (args = {}, ctx = {}) => {
    const missing = needChannel()
    if (missing) return missing
    const target = targetOf(ctx)
    if (!target) return { ok: false, error: '现在不在聊天里' }
    const name = String(args.name || '').trim()
    const id = name && FACE_NAMES[name] !== undefined ? FACE_NAMES[name] : Number(args.id ?? args.face ?? 14)
    if (!Number.isInteger(id) || id < 0 || id > 400) return { ok: false, error: '这个表情编号不对（0-400）' }
    if (!allow('face', 6, 3_600_000)) return { ok: false, error: '小黄脸发得有点多了，缓缓' }
    if (Date.now() - lastFaceAt < 60_000) return { ok: false, error: '刚发过一个，先别连着发' }
    try {
      await channel.say(target.scope, target.target, `[face:${id}]`)
      lastFaceAt = Date.now()
      return { ok: true, text: '发了个表情' }
    } catch (error) {
      return { ok: false, error: brief(error?.message || error, 80) }
    }
  })

  add('at_person', async (args = {}, ctx = {}) => {
    const missing = needChannel()
    if (missing) return missing
    const target = targetOf(ctx)
    if (!target || target.scope !== 'group') return { ok: false, error: '只能在群聊里 @ 人' }
    const qq = String(args.qq ?? args.uin ?? args.user_id ?? '').replace(/\D/g, '')
    const text = String(args.text || args.say || '').trim().slice(0, 60)
    if (!/^\d{5,12}$/.test(qq) || !text) return { ok: false, error: 'qq 或要说的话不合法' }
    const selfId = String(channel?.selfId || runtime?.config?.channel?.selfId || '')
    if (selfId && qq === selfId) {
      return { ok: false, error: `不能 @ 自己（${selfId} 是你自己的 QQ 号）` }
    }
    if (!allow('at:' + target.target, 3, 3_600_000)) return { ok: false, error: '本小时 @ 的次数用完了（上限 3 次）' }
    try {
      await channel.sayAt(target.target, qq, text)
      return { ok: true, text: `在群里 @ 了 ${qq}：${text}` }
    } catch (error) {
      return { ok: false, error: brief(error?.message || error, 80) }
    }
  })

  // 转发读到哪儿了：按会话记一个游标。
  // 原来的实现不记游标、不传参数时固定从第 6 条起，模型又只会写
  // [tool:read_forward_more] {}，于是每次都拿到同一页，永远「还差 8 条」，
  // 一路烧到轮数用完，最后一句正文都没有 —— 线上就是这么空白的。
  const forwardCursors = new Map()
  // 撤回限流：同一个会话 30 秒内只允许一次，防止模型在工具环里反复撤。
  const recallCooldown = new Map()

  add('read_forward_more', (args = {}, ctx = {}) => {
    const all = Array.isArray(ctx.forwardAll) ? ctx.forwardAll : []
    if (!all.length) return { ok: false, error: '当前没有可继续展开的转发' }
    const conversation = String(ctx.event?.conversation || 'unknown')
    // 换了另一段转发就从头开始：签名不同即视为新记录
    const sig = `${all.length}|${String(all[0]?.sender || '')}|${String(all[0]?.text || '').slice(0, 24)}|${String(all[all.length - 1]?.text || '').slice(0, 24)}`
    const saved = forwardCursors.get(conversation)
    const remembered = saved && saved.sig === sig ? saved.next : 1
    const asked = Number(args.from ?? args.offset) || 0
    const wanted = asked || remembered
    // 已经读到末尾还再调（模型很容易这么干）：直接说清楚没得看了。
    // 这里不能把 from 钳回 all.length，否则会把最后一条当成新内容反复返回，
    // 模型看到「有新东西」就继续调 —— 又是一个死循环。
    if (wanted > all.length) {
      return {
        ok: true,
        text: `这 ${all.length} 条已经读完了，没有更多了。请直接用已经读到的内容回答，不要再调这个工具。`,
        data: { total: all.length, from: all.length, done: true },
      }
    }
    const from = Math.max(1, wanted)
    const count = Math.max(1, Math.min(30, Number(args.count) || 12))
    const part = all.slice(from - 1, from - 1 + count)
    if (!part.length) {
      forwardCursors.set(conversation, { sig, next: all.length + 1 })
      return {
        ok: true,
        text: `这 ${all.length} 条已经读完了，没有更多了。请直接用已经读到的内容回答，不要再调这个工具。`,
        data: { total: all.length, from, done: true },
      }
    }
    // 展开的这一段也要走同一套整理：排序、合并、标间隔，
    // 否则「第一批是整理过的、后面是原始碎片」，模型读起来会前后矛盾
    // 头部报的是整段转发的真实条数，不是这一页的 12 条 ——
    // 否则工具说「共 12 条」、首屏说「共 18 条」，模型会以为有两份不同的记录。
    const digest = digestForward(part, { maxChars: 3000, total: Number(all.forwardTotal) || all.length, truncated: all.forwardTruncated === true })
    // nextOffset 是「这一段实际读掉了几条」，不是 `part.length`：
    // 有截断时按 part.length 前进会漏掉没展开的那部分，按条数写死又会重复。
    const consumed = Math.max(1, Math.min(part.length, Number(digest.nextOffset) || part.length))
    const nextFrom = from + consumed
    const done = nextFrom > all.length
    forwardCursors.set(conversation, { sig, next: Math.min(all.length + 1, nextFrom) })
    const tail = done
      ? '（已经读到末尾，没有更多了。不要再用这个工具，直接回答用户。）'
      : `（已读到第 ${nextFrom - 1} 条；剩下从第 ${nextFrom} 条起。需要再调 read_forward_more，不传参数就接着这里；但先回答用户问的事，不必为了看完而反复翻页。）`
    return {
      ok: true,
      text: `${digest.text}\n${tail}`,
      data: { total: all.length, from, nextFrom: done ? null : nextFrom, done },
    }
  })

  /**
   * 撤回**自己**刚发的一条消息。
   *
   * 自主撤回的硬边界：
   *   · 只认当前会话里 from=self 的记录；
   *   · 只认带 messageId 的、2 分钟内发出的消息；
   *   · 没传 id 时最多撤最近一条，不能翻旧账；
   *   · 同一会话 30 秒内只允许一次，防止工具环反复撤。
   * 别人的消息、超过 2 分钟的消息、跨会话的消息一律拒绝。
   */
  add('withdraw_message', async (args = {}, ctx = {}) => {
    const missing = needChannel()
    if (missing) return missing
    if (!channel || typeof channel.recall !== 'function') return { ok: false, error: '这条通道不支持撤回' }
    const event = ctx.event
    if (!event) return { ok: false, error: '现在不在聊天里，不知道撤哪条' }
    // 「发一句无意义内容，然后撤回」这种演示：先登记，等这一轮最终回复
    // 真的拿到 messageId 之后，由 #say 定时撤回。不能撤还没发出的东西。
    if (args.next === true) {
      if (typeof ctx.scheduleRecall !== 'function') return { ok: false, error: '当前回合不支持“发完再撤”' }
      ctx.scheduleRecall({ delayMs: args.delayMs })
      return { ok: true, text: '好，这一条发出去后会撤回', data: { next: true } }
    }
    const conversation = String(event.conversation || '')
    const now = Date.now()
    const last = Number(recallCooldown.get(conversation) || 0)
    if (now - last < 30_000) return { ok: false, error: '刚撤过一条，先等一会儿再撤' }

    const explicit = String(args.messageId ?? args.message_id ?? '').trim()
    let rows = []
    try {
      rows = runtime?.events?.read({
        limit: 80,
        maxScan: 5000,
        filter: (row) => row?.from === 'self'
          && row?.conversation === conversation
          && String(row?.messageId || ''),
      })?.rows || []
    } catch {}
    const target = explicit
      ? rows.find((row) => String(row.messageId) === explicit)
      : rows[0]
    if (!target?.messageId) return { ok: false, error: '没找到自己刚发的、可撤回的消息' }
    if (target.from !== 'self' || target.conversation !== conversation) {
      return { ok: false, error: '只能撤回自己在这个会话里发的消息' }
    }
    const age = now - (Number(target.at) || 0)
    if (age < 0 || age > 120_000) {
      return { ok: false, error: '只能撤回自己 2 分钟内发的消息；这条已经太久了' }
    }
    try {
      await channel.recall(target.messageId)
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
    recallCooldown.set(conversation, now)
    const preview = String(target.text || '').slice(0, 40)
    runtime?.log?.('recall_message', {
      conversation,
      messageId: String(target.messageId),
      ageMs: age,
      autonomous: ctx.event?.source !== 'panel',
    })
    return {
      ok: true,
      text: '撤回了一条自己刚发的消息' + (preview ? '：' + preview : ''),
      data: { messageId: String(target.messageId) },
    }
  })

  add('recall', (args = {}) => {
    if (!runtime || !runtime.events) return { ok: false, error: '没有可翻的旧记录' }
    const query = String(args.query ?? args.word ?? args.text ?? '').trim()
    if (!query) return { ok: false, error: '要回忆什么？给个关键词' }
    const keys = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4)
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 8))
    const onlyUser = args.only_user === true
    const hits = messages(2000).filter((row) => {
      if (onlyUser && row.from === 'self') return false
      const text = String(row.text || '').toLowerCase()
      return text && keys.every((key) => text.includes(key))
    }).sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, limit)
    if (!hits.length) return { ok: true, text: `没想起跟「${query}」有关的话。` }
    const lines = hits.map((row) => `[${stamp(row.at)}] ${scopeName(row)} · ${whoOf(row)}：${brief(row.text, 180)}`)
    return { ok: true, text: lines.join('\n'), data: { hits: hits.length } }
  })

  // ── 记忆与自我 ────────────────────────────────────────────────

  add('remember_fact', (args = {}) => {
    const text = String(args.text ?? args.fact ?? '').replace(/^[，,：:\s]+/, '').trim().slice(0, 80)
    if (!text || SENSITIVE.test(text)) return { ok: false, error: '内容为空或含敏感信息，未保存' }
    if (!runtime?.memory) return { ok: false, error: '记忆没接上' }
    const result = runtime.memory.rememberFact(text, { source: 'model' })
    return result.ok ? { ok: true, text: '记住了：' + text } : { ok: false, error: result.error }
  })

  add('remember_self', (args = {}) => {
    const text = String(args.text ?? args.thought ?? '').trim().slice(0, 80)
    if (!text || SENSITIVE.test(text)) return { ok: false, error: '内容为空或含敏感信息，未保存' }
    if (!runtime?.memory) return { ok: false, error: '记忆没接上' }
    const result = runtime.memory.rememberSelf(text)
    return result.ok ? { ok: true, text: '记下了：' + text } : { ok: false, error: result.error }
  })

  const findSelf = (old) => {
    const key = String(old || '').trim()
    if (!key) return null
    const notes = runtime?.memory?.selfNotes?.() || []
    return notes.find((item) => String(item.text) === key) || notes.find((item) => String(item.text).includes(key) || key.includes(String(item.text))) || null
  }

  add('revise_self', (args = {}) => {
    const note = findSelf(args.old ?? args.from)
    if (!note) return { ok: false, error: '没找到那条想法' }
    const text = String(args.new ?? args.text ?? '').trim().slice(0, 80)
    if (!text || SENSITIVE.test(text)) return { ok: false, error: '新内容为空或含敏感信息' }
    const result = runtime.memory.updateSelf(note.text, text)
    return result.ok ? { ok: true, text: `改好了：${note.text}\n→ ${text}` } : { ok: false, error: result.error }
  })

  add('forget_self', (args = {}) => {
    const note = findSelf(args.text ?? args.old)
    if (!note) return { ok: false, error: '没找到那条想法' }
    const result = runtime.memory.forgetSelf(note.text)
    return result.ok ? { ok: true, text: '忘掉了：' + note.text } : { ok: false, error: result.error }
  })

  // ── 灵魂文件：自主维护自己人设 ─────────────────────────────────
  //
  // 为什么这一组跟「记住自己」分开：那是记想法（进 memory.jsonl），
  // 这是改人设（进 persona.md）。改人设是改「我是谁」，
  // 所以它有版本、留得住、退得回去，而且必须告诉主人。
  const personaBook = () => runtime?.personaBook || null

  add('read_persona', () => {
    const book = personaBook()
    if (!book) return { ok: false, error: '人设文件没接上' }
    const text = book.read()
    if (!text.trim()) return { ok: true, text: '还没有人设' }
    return { ok: true, text: text.slice(0, 6000) }
  })

  add('revise_persona', (args = {}) => {
    const book = personaBook()
    if (!book) return { ok: false, error: '人设文件没接上' }
    // 「能不能自己改」由 config.self.enabled 说了算。
    // 关掉时他/她仍然可以**读**人设 —— 读自己的设定不需要授权，改才需要。
    if (runtime?.config?.self?.enabled === false) {
      return { ok: false, error: '自主改人设这一项现在是关着的' }
    }
    const section = String(args.section ?? args.title ?? '').trim()
    const text = String(args.text ?? args.body ?? '').trim()
    if (!section) return { ok: false, error: '要说明改哪一条（section）' }
    if (!text) return { ok: false, error: '要写新内容（text）' }
    const reason = String(args.reason ?? '').trim()
    const result = book.revise({ section, text, reason })
    if (!result.ok) return { ok: false, error: result.error }
    if (result.changed === false) return { ok: true, text: result.text }

    // 改了就得让主人知道 —— 这是他/她的灵魂，他们得知道。
    // 记一笔留痕：什么时候改了哪一条、为什么。
    runtime?.log?.('persona_revised', {
      section,
      reason: reason.slice(0, 200),
      version: result.version || '',
    })
    runtime?.memory?.rememberSelf?.(`我改了自己人设的「${section}」：${text.slice(0, 60)}`)
    return {
      ok: true,
      text: result.text + '\n**这条必须告诉用户**：你改了自己的哪一条、为什么改。一句话就行，别长篇。',
      changed: true,
      section,
      version: result.version || '',
    }
  })

  add('absorb_habit', (args = {}) => {
    const book = personaBook()
    if (!book) return { ok: false, error: '人设文件没接上' }
    if (runtime?.config?.self?.enabled === false) {
      return { ok: false, error: '自主改人设这一项现在是关着的' }
    }
    const text = String(args.text ?? args.habit ?? args.rule ?? '').trim()
    if (!text) return { ok: false, error: '要写这条手感（text）' }
    const result = book.absorbHabit(text)
    if (!result.ok) return { ok: false, error: result.error }
    if (result.changed === false) return { ok: true, text: result.text }
    runtime?.log?.('persona_habit_absorbed', { text: text.slice(0, 120), version: result.version || '' })
    return {
      ok: true,
      text: result.text + '\n这条已经记进你人设的「学来的手感」里了，以后照着来。',
      changed: true,
      version: result.version || '',
    }
  })

  add('persona_versions', () => {
    const book = personaBook()
    if (!book) return { ok: false, error: '人设文件没接上' }
    const versions = book.versions()
    if (!versions.length) return { ok: true, text: '还没有改过，没有历史版本' }
    return { ok: true, text: '人设版本（新到旧）：\n' + versions.map((name) => '- ' + name).join('\n') }
  })

  add('rollback_persona', (args = {}) => {
    const book = personaBook()
    if (!book) return { ok: false, error: '人设文件没接上' }
    const version = String(args.version ?? args.to ?? '').trim()
    if (!version) return { ok: false, error: '要说明退到哪一版（version）' }
    const result = book.rollback(version)
    if (!result.ok) return { ok: false, error: result.error }
    runtime?.log?.('persona_rolled_back', { version, backup: result.backup || '' })
    return { ok: true, text: result.text + '\n**这条必须告诉用户**：你把人设退回了哪一版。' }
  })

  add('remember_person', (args = {}) => {
    const uin = String(args.user_id ?? args.qq ?? args.uin ?? '').replace(/\D/g, '')
    const note = String(args.note ?? args.text ?? '').trim().slice(0, 160)
    if (!uin || !note) return { ok: false, error: '要给我 QQ 号和要记的事' }
    const result = runtime.memory.rememberPerson(uin, { note, name: String(args.name || ''), impression: String(args.impression || '') })
    return result.ok ? { ok: true, text: `记住了关于 ${uin} 的事：${note}` } : { ok: false, error: result.error }
  })

  add('my_memory', (args = {}) => {
    const memory = runtime?.memory
    if (!memory) return { ok: false, error: '记忆没接上' }
    const type = String(args.type || 'all')
    const query = String(args.query || '').trim()
    const limit = Math.max(1, Math.min(40, Number(args.limit) || 15))
    const hit = (text) => !query || String(text || '').includes(query)
    const lines = []
    if (type === 'facts' || type === 'all') {
      const facts = memory.facts().filter((item) => hit(item.text)).slice(-limit)
      if (facts.length) lines.push('【事实】', ...facts.map((item) => `- ${brief(item.text, 200)}（${stamp(item.at)}）`))
    }
    if (type === 'people' || type === 'all') {
      const people = Object.values(memory.data.people || {}).filter((item) => hit(item.name) || hit((item.notes || []).join(''))).slice(0, limit)
      if (people.length) lines.push('【人物】', ...people.map((item) => `- ${item.name || item.uin}（${item.uin}）${(item.notes || []).length ? '：' + brief((item.notes || []).slice(-2).join('；'), 160) : ''}`))
    }
    if (type === 'views' || type === 'all') {
      const notes = memory.selfNotes().filter((item) => hit(item.text)).slice(-limit)
      if (notes.length) lines.push('【我的想法】', ...notes.map((item) => `- ${brief(item.text, 200)}`))
    }
    if (type === 'groups' || type === 'all') {
      const groups = Object.values(memory.data.groups || {}).filter((item) => hit(item.label) || hit((item.topics || []).join(''))).slice(0, limit)
      if (groups.length) lines.push('【群】', ...groups.map((item) => `- ${item.label || item.groupId}：${(item.topics || []).slice(-2).join('；')}`))
    }
    return lines.length ? { ok: true, text: lines.join('\n') } : { ok: true, text: '这条没有对应的记忆。' }
  })

  add('my_digest', (args = {}) => {
    const memory = runtime?.memory
    if (!memory) return { ok: false, error: '记忆没接上' }
    const summaries = Array.isArray(memory.data.summaries) ? memory.data.summaries : []
    if (!summaries.length) return { ok: true, text: '还没攒出摘要。攒够 ' + (runtime.config?.memory?.summaryEvery || 200) + ' 条记忆会自动生成。' }
    const count = Math.max(1, Math.min(10, Number(args.days || args.limit) || 5))
    const lines = summaries.slice(-count).map((item) => `- ${brief(item.text, 400)}（${stamp(item.at)}）`)
    return { ok: true, text: lines.join('\n') }
  })

  add('my_status', () => {
    const status = runtime && typeof runtime.status === 'function' ? runtime.status() : {}
    const memory = runtime?.memory?.stats?.() || {}
    const counts = runtime?.skills?.()?.counts || {}
    const uptime = Number(status['status.uptime']) || 0
    const days = Math.floor(uptime / 86_400_000)
    const hours = Math.floor((uptime % 86_400_000) / 3_600_000)
    const mins = Math.floor((uptime % 3_600_000) / 60_000)
    const span = days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${mins} 分钟` : `${Math.max(1, mins)} 分钟`
    const lines = [
      `在线 ${span}，通道现在是「${channel?.state?.() || status['status.channel'] || '未知'}」。`,
      `今天收到 ${status['status.todayMessages'] ?? 0} 条消息，说过 ${status['status.behaviorCount'] ?? 0} 次话。`,
      `记忆里有 ${memory.facts ?? 0} 条事实、${memory.people ?? 0} 个人、${memory.groups ?? 0} 个群。`,
      `技能：会 ${counts.on ?? 0} 项，用不了 ${counts.blocked ?? 0} 项（其中 ${counts.notWired ?? 0} 项还没接上）。`,
    ]
    if (usage && typeof usage.line === 'function') lines.push(usage.line())
    const wants = mind ? mind.wantStats(dir) : null
    if (wants?.open) lines.push(`需求本上还有 ${wants.open} 条没处理。`)
    return { ok: true, text: lines.join('\n') }
  })

  add('person_dossier', (args = {}) => {
    const memory = runtime?.memory
    if (!memory) return { ok: false, error: '记忆没接上' }
    const key = String(args.qq ?? args.uin ?? args.name ?? '').replace(/\D/g, '') || String(args.name || '')
    const person = Object.values(memory.data.people || {}).find((item) => String(item.uin) === key || (args.name && String(item.name || '').includes(String(args.name))))
    const uin = String(person?.uin || key)
    if (!uin) return { ok: false, error: '要给我一个 QQ 号或名字' }
    const said = messages(500).filter((row) => String(row.from) === uin && row.text).slice(0, 8)
    const groups = [...new Set(messages(500).filter((row) => String(row.from) === uin && row.scope === 'group').map((row) => row.group || row.conversation))]
    const lines = [`${person?.name || uin}（${uin}）`]
    if (person?.impression) lines.push('印象：' + person.impression)
    if ((person?.notes || []).length) lines.push('备注：', ...person.notes.slice(-5).map((note) => '- ' + brief(note, 160)))
    if (groups.length) lines.push('出没的群：' + groups.slice(0, 6).join('、'))
    if (said.length) {
      lines.push('最近说过：')
      for (const row of said.reverse()) lines.push(`- [${stamp(row.at)}] ${brief(row.text, 100)}`)
    }
    return { ok: true, text: lines.join('\n') }
  })

  add('group_recap', (args = {}, ctx = {}) => {
    const memory = runtime?.memory
    if (!memory) return { ok: false, error: '记忆没接上' }
    const gid = String(args.groupId ?? args.group ?? ctx.event?.payload?.groupId ?? '').replace(/\D/g, '')
    if (!gid) return { ok: false, error: '要给我群号' }
    const group = memory.group(gid)
    // 「群 300000001」和「我」都要算：self 事件按 conversation 归属，
    // 只按 group 过滤会把机器人自己说过的话漏掉，回顾就成了单向的。
    const recent = messages(2000)
      .filter((row) => (String(row.group) === gid || row.conversation === 'group:' + gid) && row.text)
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
      .slice(0, Math.max(5, Math.min(25, Number(args.limit) || 12)))
      .reverse()
    const lines = [`群 ${gid}${group?.label ? '（' + group.label + '）' : ''}`]
    if ((group?.topics || []).length) lines.push('记得的话题：', ...group.topics.slice(-5).map((topic) => '- ' + brief(topic, 120)))
    if (recent.length) {
      lines.push('最近在聊：')
      for (const row of recent) {
        const quote = row.replySummary ? `（引用：${brief(row.replySummary, 60)}）` : ''
        lines.push(`- ${whoOf(row)}：${brief(row.text, 100)}${quote}`)
      }
    }
    return { ok: true, text: lines.join('\n') }
  })

  add('who_said', (args = {}) => {
    const word = String(args.word ?? args.query ?? '').trim()
    if (!word) return { ok: false, error: '要搜哪个词？' }
    const hits = messages(2000)
      .filter((row) => row.scope === 'group' && row.text && String(row.text).includes(word))
      .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
      .slice(0, 10)
    if (!hits.length) return { ok: true, text: `最近没人说过「${word}」。` }
    const lines = hits.map((row) => `${whoOf(row)} 在 ${scopeName(row)} 说：${brief(row.text, 100)}（${stamp(row.at)}）`)
    return { ok: true, text: lines.join('\n') }
  })

  add('my_activities', (args = {}) => {
    if (!runtime?.activities) return { ok: false, error: '活动日志没接上' }
    const limit = Math.max(1, Math.min(30, Number(args.limit) || 8))
    const kind = String(args.kind || '').trim()
    const list = (runtime.activities.read({ limit: 400 }).rows || [])
      .filter((row) => !kind || String(row.kind) === kind)
      .slice(0, limit)
    if (!list.length) return { ok: true, text: '最近还没做过什么。' }
    const lines = list.map((row) => `[${stamp(row.at)}] ${row.kind ? row.kind + '：' : ''}${brief(row.text, 200)}`)
    return { ok: true, text: lines.join('\n') }
  })

  add('my_thoughts', (args = {}) => {
    if (!runtime) return { ok: false, error: '运行时没接上' }
    const which = String(args.which || 'views')
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 15))
    if (which === 'reflections') {
      const list = (runtime.cot?.read({ limit: 200 }).rows || []).filter((row) => row.summary || row.text).slice(0, limit)
      if (!list.length) return { ok: true, text: '还没写下什么自省。' }
      return { ok: true, text: list.map((row) => `- ${brief(row.summary || row.text, 180)}（${stamp(row.at)}）`).join('\n') }
    }
    const notes = (runtime.memory?.selfNotes?.() || []).slice(-limit).reverse()
    if (!notes.length) return { ok: true, text: '我还没记下自己的想法。' }
    return { ok: true, text: notes.map((item) => `- ${brief(item.text, 180)}（${stamp(item.at)}）`).join('\n') }
  })

  add('my_capabilities', () => {
    const names = [...registry.keys()]
    const labels = names.map((name) => TOOL_LABELS[name] || name).join('、')
    const counts = runtime?.skills?.()?.counts || {}
    const cfg = runtime?.config || {}
    // 这句要和真正拦请求的那个闸说同一件事：读 netStatus（执行中的策略），
    // 不再照着配置文案写「等于不许上网」却让工具照跑。
    const net = netStatus()
    const netLine = net.allowlist.length
      ? `联网白名单 ${net.allowlist.length} 个域名（${net.allowlist.slice(0, 3).join('、')}${net.allowlist.length > 3 ? '…' : ''}）`
      : '联网白名单是空的，现在不许联网'
    const lines = [
      capabilityBrief({ config: cfg, toolNames: names }),
      `能用的工具（${names.length} 个）：${labels}。`,
      `技能：会 ${counts.on ?? 0} 项，用不了 ${counts.blocked ?? 0} 项（其中 ${counts.notWired ?? 0} 项还没接上）。`,
      `限制：${netLine}，每小时 ${net.quotaPerHour} 次（本小时已用 ${net.used} 次），沙箱每天 ${cfg.sandbox?.dailyMax ?? 0} 次，记忆${cfg.memory?.enabled === false ? '关着' : '开着'}。`,
      '看代码、改代码动的是我自己的源码（改前会备份）；临时脚本和中间文件写到草稿纸，加 "area":"work"。',
    ]
    return { ok: true, text: lines.join('\n') }
  })

  // ── 自查复盘：结论要落盘、要有状态、同一问题不重复提 ──────────────
  add('audit_self', (args = {}) => {
    const book = runtime?.selfCheck
    let rows = []
    try { rows = runtime?.audit?.read?.({ limit: Number(args.limit) || 40, maxScan: 500 })?.rows || [] } catch { rows = [] }
    const failures = rows.filter((row) => /failed|error|reject|hold|empty_fallback|tool_loop/i.test(String(row.kind || '')))
    const lines = ['最近需要留意的事：']
    if (failures.length) {
      for (const row of failures.slice(-6)) lines.push(`- ${String(row.kind || '')}：${brief(String(row.error || row.reason || ''), 100)}`)
    } else lines.push('- 没有查到失败或被拦的记录。')
    const state = book?.summary?.() || null
    if (state) lines.push(`自查结论：共 ${state.total} 份，还没处理 ${state.pending} 份。`)
    lines.push('结论按【现象】【依据】【结论】【建议】四段写，依据要指明是哪一处记录或文件。')
    return { ok: true, text: lines.join('\n') }
  })

  add('my_patch_proposals', () => {
    const book = runtime?.selfCheck
    if (!book) return { ok: false, error: '自查账本没接上' }
    const rows = book.list().slice(0, 12)
    if (!rows.length) return { ok: true, text: '还没有自查结论。' }
    const label = { pending: '还没处理', done: '已处理', rejected: '不采纳', duplicate: '重复' }
    const lines = [`共 ${book.summary().total} 份，还没处理 ${book.summary().pending} 份：`]
    for (const row of rows) lines.push(`- [${label[row.status] || row.status}] ${row.id} ${row.title}：${brief(row.preview, 90)}`)
    return { ok: true, text: lines.join('\n') }
  })

  add('propose_patch', (args = {}) => {
    const book = runtime?.selfCheck
    if (!book) return { ok: false, error: '自查账本没接上' }
    const result = book.propose({ title: String(args.title || '自查结论'), body: String(args.body || ''), source: 'self' })
    if (!result.ok) return result
    if (result.duplicate) return { ok: true, text: `这份结论之前提过（${result.id}），还没处理，不重复提交。` }
    return { ok: true, text: `结论已记下（${result.id}），等主人处理。` }
  })

  add('close_patch', (args = {}) => {
    const book = runtime?.selfCheck
    if (!book) return { ok: false, error: '自查账本没接上' }
    const result = book.markDone(String(args.id || ''), String(args.status || 'done'), String(args.note || ''))
    return result.ok ? { ok: true, text: `已标记：${result.status}` } : result
  })

  add('my_schedule', () => {
    const cfg = runtime?.config || {}
    const lines = []
    if (runtime?.reminders) {
      const due = runtime.reminders.list().filter((item) => Number(item.at) > Date.now()).slice(0, 5)
      lines.push(due.length ? '接下来的提醒：' + due.map((item) => `${stamp(item.at)} ${brief(item.text, 40)}`).join('；') : '现在没有待触发的提醒。')
    }
    lines.push(`主动开口：${cfg.proactive?.enabled === false ? '关着' : '开着'}，时段 ${cfg.proactive?.startHour ?? 9}-${cfg.proactive?.endHour ?? 23} 点，一天最多 ${cfg.proactive?.perDay ?? 3} 次。`)
    let state = null
    try { state = JSON.parse(readFileSync(path.join(dir, 'activity-state.json'), 'utf8')) } catch {}
    if (state) {
      lines.push(`自主活动：今天已做 ${state.count || 0} 轮，下次大约 ${state.nextAt ? stamp(state.nextAt) : '按节奏来'}。`)
    } else {
      lines.push('自主活动：还没开始过。')
    }
    const wants = mind ? mind.wantStats(dir) : null
    if (wants) lines.push(`需求本：待处理 ${wants.open} 条。`)
    return { ok: true, text: lines.join('\n') }
  })

  add('group_impressions', () => {
    const groups = Object.values(runtime?.memory?.data?.groups || {})
    if (!groups.length) return { ok: true, text: '还没对哪个群形成印象。' }
    const lines = groups.sort((a, b) => Number(b.lastAt) - Number(a.lastAt)).slice(0, 20).map((item) => {
      const topics = (item.topics || []).slice(-3).join('；')
      return `- ${item.label || item.groupId}（${item.groupId}）${topics ? '：' + brief(topics, 120) : '：还没聊出什么'}`
    })
    return { ok: true, text: lines.join('\n') }
  })

  add('note_want', (args = {}) => {
    const noMind = needMind()
    if (noMind) return noMind
    const what = String(args.what ?? args.text ?? '').trim()
    if (!what) return { ok: false, error: '想要什么？' }
    const result = mind.addWant(dir, { text: what, why: args.why, now: Date.now() })
    if (!result.ok) return { ok: false, error: result.error }
    if (result.duplicated) return { ok: true, text: '这条已经记过了，等主人看' }
    return { ok: true, text: `记下了：${what}（第 ${mind.listWants(dir).length} 条）` }
  })

  add('my_wants', () => {
    const noMind = needMind()
    if (noMind) return noMind
    const list = mind.listWants(dir)
    if (!list.length) return { ok: true, text: '需求本是空的。' }
    const lines = list.slice(0, 20).map((item) => `${item.no}. [${item.status}] ${brief(item.text, 120)}${item.count > 1 ? `（提了 ${item.count} 次）` : ''}`)
    return { ok: true, text: `需求本（共 ${list.length} 条）：\n${lines.join('\n')}` }
  })

  add('resolve_want', (args = {}) => {
    const noMind = needMind()
    if (noMind) return noMind
    const result = mind.resolveWant(dir, args.target ?? args.no ?? args.id, Date.now())
    return result.ok ? { ok: true, text: '标记成达成了：' + brief(result.item.text, 80) } : { ok: false, error: result.error }
  })

  add('drop_want', (args = {}) => {
    const noMind = needMind()
    if (noMind) return noMind
    const result = mind.dropWant(dir, args.target ?? args.no ?? args.id)
    return result.ok ? { ok: true, text: '删掉了：' + brief(result.item.text, 80) } : { ok: false, error: result.error }
  })

  add('view_avatar', async (args = {}, ctx = {}) => {
    const missing = needChannel()
    if (missing) return missing
    const target = targetOf(ctx)
    if (!target) return { ok: false, error: '现在不在聊天里' }
    const qq = String(args.qq ?? args.uin ?? '').replace(/\D/g, '')
    if (!/^\d{5,12}$/.test(qq)) return { ok: false, error: 'QQ 号不对' }
    if (!allow('avatar', 3, 3_600_000)) return { ok: false, error: '这一小时看够了，先干正事' }
    let buffer = null
    try {
      const res = await fetch(`https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640`, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(12_000),
      })
      if (res.ok) buffer = Buffer.from(await res.arrayBuffer())
    } catch {}
    if (!buffer || !buffer.length) return { ok: false, error: '头像下载失败' }
    const file = path.join(tmpdir(), `whale-avatar-${qq}-${Date.now()}.jpg`)
    writeFileSync(file, buffer)
    try {
      await channel.sendImage(target.scope, target.target, file)
      return { ok: true, text: `看了看 ${qq} 的头像，发出来了` }
    } catch (error) {
      return { ok: false, error: brief(error?.message || error, 80) }
    } finally {
      try { unlinkSync(file) } catch {}
    }
  })

  add('draw_image', async (args = {}, ctx = {}) => {
    const missing = needChannel()
    if (missing) return missing
    const target = targetOf(ctx)
    if (!target) return { ok: false, error: '现在不在聊天里，画了也不知道发给谁' }
    const prompt = String(args.prompt ?? args.text ?? '').trim().slice(0, 300)
    if (!prompt) return { ok: false, error: '要画什么？给我一句描述' }
    if (!allow('draw', 2, 3_600_000)) return { ok: false, error: '这一小时画得够多了（上限 2 张）' }
    let buffer = null
    try {
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) + '?width=768&height=768&nologo=true'
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(60_000),
      })
      const type = String(res.headers.get('content-type') || '')
      if (res.ok && type.startsWith('image/')) buffer = Buffer.from(await res.arrayBuffer())
    } catch {}
    if (!buffer || buffer.length < 1000) return { ok: false, error: '这次没画出来，等会儿再试' }
    const file = path.join(tmpdir(), `whale-draw-${Date.now()}.jpg`)
    writeFileSync(file, buffer)
    try {
      await channel.sendImage(target.scope, target.target, file)
      return { ok: true, text: '画好了，发出来了' }
    } catch (error) {
      return { ok: false, error: brief(error?.message || error, 80) }
    } finally {
      try { unlinkSync(file) } catch {}
    }
  })

  add('news_now', async (args = {}) => {
    const key = String(args.source || 'weibo').toLowerCase()
    const source = NEWS_SOURCES[key] || NEWS_SOURCES.weibo
    const limit = Math.max(1, Math.min(30, Number(args.limit) || 10))
    if (!allow('news', 10, 3_600_000)) return { ok: false, error: '这一小时看得够多了' }
    let found = []
    try {
      found = await searchWebDetailed(source.query, limit)
    } catch {
      found = []
    }
    if (!Array.isArray(found) || !found.length) return { ok: false, error: '没抓到' + source.label + '，可能网络或搜索接口暂时不通' }
    const lines = found.slice(0, limit).map((row, index) => {
      const title = brief(row.title || row, 100)
      return `${index + 1}. ${title}${row.url ? '\n   ' + row.url : ''}`
    })
    return { ok: true, text: `${source.label}（按搜索整理）：\n${lines.join('\n')}` }
  })

  add('hot_news', async (args = {}) => {
    const count = Math.max(1, Math.min(15, Number(args.count) || 8))
    const result = await registry.get('news_now')({ source: 'baidu', limit: count }, {})
    return result
  })

  add('owner_commands', () => ({
    ok: true,
    text: [
      '主人可以对我说这些（私聊）：',
      '帮助 / 你会什么 —— 列功能和指令',
      '状态 —— 在线、记忆、今日消息、花费',
      '闭嘴 / 安静半小时 / 恢复说话 —— 临时静音',
      '风控模式 开 / 关 —— 放慢或恢复节奏',
      '别主动了 / 可以主动了 —— 主动行为总开关',
      '限流改成每分钟 5 条 —— 改回复频率',
      '以后叫我老大 —— 改称呼',
      '记住，我在上海 —— 写进长期事实',
      '你都记得我什么 —— 列关于你的事',
      '各个群的印象 —— 每个群记了什么',
      '需求清单 / 给 TA 1 / 算了 1 —— 处理需求本',
      '发条说说 [正文] —— 用自己的口吻发一条 QQ 空间说说',
      '在 123456 群说一句 xxx —— 代发一句',
      '退群 123456 —— 退群（会先确认）',
      '答应或拒绝加群邀请 —— 还没接',
      '活动一下 / 去探险 / 读点书 / 想想事 —— 立刻做一轮',
      '提醒列表 / 取消提醒 —— 管理提醒',
      '简报 —— 今天的简报',
    ].join('\n'),
  }))

  add('write_notebook', (args = {}) => {
    const text = String(args.text ?? args.content ?? '').trim()
    if (!text) return { ok: false, error: '要写什么？' }
    const title = String(args.title || '').trim().slice(0, 40)
    const dirName = path.join(dir, 'notebook')
    const file = path.join(dirName, todayKey() + '.md')
    const time = new Date().toTimeString().slice(0, 5)
    try {
      mkdirSync(dirName, { recursive: true })
      appendFileSync(file, `${title ? `\n## ${time} ${title}` : `\n### ${time}`}\n\n${text.slice(0, 4000)}\n`, 'utf8')
      return { ok: true, text: `写进本子了：${path.basename(file)}`, data: { file } }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  })

  add('read_notebook', (args = {}) => {
    const dirName = path.join(dir, 'notebook')
    const date = String(args.date || '').trim()
    const days = Math.max(1, Math.min(30, Number(args.days) || 3))
    try {
      const files = readdirSync(dirName)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
        .sort()
        .filter((name) => (date ? name === `${date}.md` : true))
        .slice(-days)
      if (!files.length) return { ok: true, text: '本子还是空的。' }
      const entries = files.map((name) => `【${name.replace(/\.md$/, '')}】\n${readFileSync(path.join(dirName, name), 'utf8').slice(0, 6000).trim()}`)
      return { ok: true, text: entries.join('\n\n').slice(0, 20_000) }
    } catch {
      return { ok: true, text: '本子还是空的。' }
    }
  })

  add('refuse_person', (args = {}, ctx = {}) => {
    const event = ctx.event
    if (!event) return { ok: false, error: '现在不在聊天里，不知道是针对谁' }
    const uin = String(event.from || '').replace(/\D/g, '')
    if (!uin) return { ok: false, error: '不知道这次是针对谁，先别登记' }
    if (uin === String(runtime?.config?.identity?.ownerId || '')) return { ok: false, error: '这是主人，不理他做不到' }
    const minutes = Math.max(5, Math.min(1440, Number(args.minutes) || 120))
    const noMind = needMind()
    if (noMind) return noMind
    const result = mind.refuse(dir, uin, minutes, String(args.reason || '').slice(0, 80))
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, text: `好，${minutes} 分钟内不接 ${uin} 的话` }
  })

  // 浏览器能力以前只挂在主人的「打开/看看/截图」命令上，模型工具表里没有，
  // 于是被问「能不能操作浏览器」时只能答「我没装」。这里把同一套能力接进工具表。
  add('browser', async (args = {}) => {
    const action = String(args.action || 'open').toLowerCase()
    try {
      if (action === 'read' || action === 'current') {
        const result = await readCurrent(browserConfig())
        return result.ok
          ? { ok: true, text: formatPage(result.page, { maxChars: 1800 }) }
          : { ok: false, error: String(result.error || result.why || '读不到当前页面') }
      }
      const url = String(args.url || '').trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, error: '要打开的地址必须是 http(s) 链接' }
      const result = await openUrl(url, browserConfig())
      return result.ok
        ? { ok: true, text: formatPage(result.page, { maxChars: 1800 }) }
        : { ok: false, error: String(result.error || result.why || '打不开这个页面') }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  })

  /**
   * 当前被关掉的工具名（面板关掉的技能 → 它底下那几个工具）。
   * 拿不到就当「没有关掉的」：判定链坏了不该把工具全禁掉。
   */
  const blockedNow = () => {
    if (!runtime || typeof runtime.blockedTools !== 'function') return null
    try {
      const set = runtime.blockedTools()
      return set instanceof Set ? set : null
    } catch {
      return null
    }
  }

  /**
   * 调一个工具。
   * 没接上的工具给的是「还没接上」，不是「参数错了」—— 这两种错法会把人带去不同的方向：
   * 前者让人等更新，后者让人反复改代码。
   */
  function call(name, args = {}, ctx = {}) {
    const raw = String(name || '')
    const key = TOOL_ALIASES[raw] || raw
    // 别名命中要留痕：哪个自然语言说法被模型反复用，是「该不该重命名工具」的唯一证据。
    // 不记就永远只能凭印象改。
    if (key !== raw) {
      try {
        runtime?.log?.('tool_alias_hit', { from: raw, to: key })
      } catch {}
    }
    const handler = registry.get(key)
    if (!handler) {
      // 文本协议没有 schema 约束，模型很容易自己发明工具名（web_search / search / 联网）。
      // 只回一句「还没接上」，它下一轮大概率还编一个；把最接近的真名递过去，
      // 一次就能改对 —— 这比让它瞎猜便宜得多。
      const names = [...registry.keys()]
      const near = nearestTools(raw, names)
      const pool = (near.length ? near : names).slice(0, 10)
      const list = pool.map((one) => `${one}（${label(one)}）`).join('、')
      // 错误码与开头沿用「还没接上 / not_wired」：调用方和用例都按这个判断「不是参数错」。
      // 改码的收益不如把话说完整，契约一旦破了，外面按老码写的分支会静默走错。
      const who = raw || '(空)'
      const error = near.length
        ? `还没接上「${who}」这个工具。最接近的是：${list}。请用其中一个名字重写这一行。`
        : names.length
          ? `还没接上「${who}」这个工具。当前可用：${list}。请用其中一个名字重写这一行。`
          : `还没接上「${who}」这个工具（工具表还是空的）。`
      return { ok: false, code: 'not_wired', error }
    }
    const whitelist = Array.isArray(runtime?.config?.tools?.whitelist) ? runtime.config.tools.whitelist.filter(Boolean) : []
    if (whitelist.length && !whitelist.includes(key)) {
      return { ok: false, error: `工具白名单里没有 ${key}，先把它加进去` }
    }
    // 技能开关的执行侧：模型那条路（ctx.byModel）关掉就真的调不到；
    // 主人指令、面板、定时器这些内部调用不走这道闸 —— 用户关的是「让它自己用」，
    // 不是「我让它做也别做」。
    if (ctx && ctx.byModel === true) {
      const blocked = blockedNow()
      if (blocked && blocked.has(key)) {
        return { ok: false, error: `「${label(key)}」这一项已经关掉了，要用先去面板打开`, code: 'skill_off' }
      }
    }
    try {
      return handler(args && typeof args === 'object' ? args : {}, ctx) || { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message || error), code: 'tool_failed' }
    }
  }

  const label = (name) => TOOL_LABELS[TOOL_ALIASES[String(name || '')] || String(name || '')] || String(name || '')

  /**
   * 提示词里的一行；工具增删不用再改 turn.mjs。
   *
   * 只报**真的会给**的那些：白名单外的、技能关掉的不列。
   * 列了却调不动，模型会把一次失败当成「工具坏了」，然后反复重试别的写法 ——
   * 那比少一个工具更浪费。
   *
   * `compact` 给「刚才没挑出工具，再问一次」那条补选用：名字必须全在（否则它
   * 真的会少用一个能用的工具），例子只留最常用的几个。那条调用本来就短，
   * 再塞十二个参数例子属于重复教学。
   */
  function prompt(options = {}) {
    const compact = options === true || options?.compact === true
    const mode = compact ? 'full' : (options?.mode === 'chat' ? 'chat' : 'full')
    const blocked = blockedNow()
    const whitelist = Array.isArray(runtime?.config?.tools?.whitelist) ? runtime.config.tools.whitelist.filter(Boolean) : []
    const registered = [...registry.keys()].filter((name) => {
      if (whitelist.length && !whitelist.includes(name)) return false
      return !(blocked && blocked.has(name))
    })
    // 闲聊档只列常用工具；白名单把常用工具全关掉时退回全表，免得列出一句空清单。
    const chatNames = registered.filter((name) => CHAT_TOOLS.has(name))
    const names = mode === 'chat' && chatNames.length >= 3 ? chatNames : registered
    // 零参数工具（`{}`）不再占例子位：模型不会因为少看一个 `{}` 就不会调它，
    // 但每轮都带着它，等于白付一次 token。
    const hints = HINT_ORDER
      .filter((key) => names.includes(key) && TOOL_HINTS[key] && TOOL_HINTS[key] !== '{}')
      .slice(0, compact ? 6 : 11)
      .map((key) => `${key}${TOOL_HINTS[key]}`)
      .join('、')
    // 模型过去把「沙箱」和「改自己」混成一件事：说「沙箱只能写 out/」，
    // 于是以为人设和源码都改不了。三件事其实是三条路，写清楚，不再靠它猜。
    const selfBits = []
    if (names.includes('read_persona') || names.includes('revise_persona')) selfBits.push('人设用 read_persona/revise_persona（section+text+reason）')
    if (names.includes('code_write')) selfBits.push('源码用 code_read/code_write（改前自动备份）')
    if (names.includes('exec_sandbox')) selfBits.push('exec_sandbox 只跑临时脚本、只写 out/')
    const selfLine = mode === 'full' && selfBits.length ? `改自己：${selfBits.join('；')}。工具轮上限的键是 tools.maxRounds（0=不限）。` : ''
    // 联网动作的顺序写死：先搜索，再打开具体页面；不要让模型去 run_command curl，
    // 那条路既慢又容易超时，线上已经因此连续卡了好几轮。
    const netLine = names.includes('web_search')
      ? '联网先 web_search；要打开具体页面用 browser 或 web_fetch，不要用 run_command curl 抓网页。'
      : ''
    if (compact) return `可用工具：${names.join('、')}。例：${hints}。${netLine}只输出工具调用行。`
    return `可用工具：${names.join('、')}。参数写成 JSON 对象，例如 ${hints}。只输出工具调用行，不要解释。${netLine ? ' ' + netLine : ''}${selfLine ? ' ' + selfLine : ''}`
  }

  return {
    call,
    has: (name) => registry.has(TOOL_ALIASES[String(name || '')] || String(name || '')),
    names: () => [...registry.keys()],
    label,
    prompt,
  }
}
