/**
 * lib/tools.mjs — 工具表：真的能调的那几个，以及怎么调。
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
import { readWeb, searchWeb, searchWebDetailed } from './web.mjs'
import { listStickers, loadStickers, pickSticker, resolveSticker, saveSticker } from './stickers.mjs'
import { addWant, dropWant, listWants, resolveWant, wantStats } from './wants.mjs'
import { refuse as refuseUin } from './refusals.mjs'
import { listTree, readSource, restoreBackup, rootOf, runCommand, searchSource, writeSource } from './coding.mjs'

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
  refuse_person: '不想理他',
})

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

/** 提示词里只给一行；太长会挤掉真正的上下文 */
const TOOL_HINTS = Object.freeze({
  // 「改自己的代码」这一组刻意排在最前：prompt() 只把前 10 个 hint 交给模型，
  // 而这几个工具的参数形状最需要用例子说清 —— 尤其 code_write 传的是**整份文件内容**，
  // 不给例子，模型会以为能传「改几行」这种增量写法。
  code_search: '{"keyword":"Sandbox","max":10}',
  code_read: '{"path":"lib/sandbox.mjs","start":1,"count":60}',
  code_write: '{"path":"lib/demo.mjs","content":"整份文件内容"}',
  code_list: '{"path":"lib","recursive":0}',
  run_command: '{"bin":"node","args":["scripts/check-layers.mjs"]}',
  recall: '{"query":"上次说的那个"}',
  send_sticker: '{"mood":"无语"}',
  at_person: '{"qq":"10001","text":"在呢"}',
  news_now: '{"source":"weibo"}',
  note_want: '{"what":"想看某本书"}',
  person_dossier: '{"qq":"10001"}',
  group_recap: '{"groupId":"123456"}',
  save_sticker: '{"tags":"无语,猫"}',
  remind: '{"minutes":30,"text":"喝水"}',
  draw_image: '{"prompt":"一只蓝色鲸鱼在云里"}',
  exec_sandbox: '{"code":"console.log(1)","plan":["算一下"]}',
})

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
 */
export function createTools(input = {}) {
  const runtime = input.runtime || null
  const channel = input.channel || null
  const usage = input.usage || null
  const dir = String(input.dir || runtime?.dir || process.cwd())
  const registry = new Map()
  const buckets = new Map()
  let lastFaceAt = 0

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
    if (!allow('web_search', 30, 3_600_000)) return { ok: false, error: '这一小时搜得够多了，先凭印象回答或直说不知道' }
    const rowsFound = await searchWeb(query)
    return rowsFound.length ? { ok: true, text: rowsFound.join('\n') } : { ok: false, error: '没搜到结果' }
  })

  add('web_fetch', async (args = {}) => {
    const url = String(args.url ?? args.href ?? '').trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, error: '要一个 http(s) 网址' }
    const result = await readWeb(url)
    return result.ok ? { ok: true, text: `${result.title ? result.title + '\n' : ''}${result.text}` } : { ok: false, error: result.error }
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
    if (!['persona.maxReplyChars', 'persona.maxParts'].includes(key)) return { ok: false, error: '只能调回复长度或分条数' }
    const value = Math.max(key.endsWith('maxParts') ? 1 : 4, Math.min(key.endsWith('maxParts') ? 8 : 120, Number(args.value) || 0))
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
      const pic = ctx.event?.payload?.images?.[0]
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

  const setReminder = (args = {}) => {
    if (!runtime || !runtime.reminders) return { ok: false, error: '提醒存储不可用' }
    const minutes = Math.max(1, Number(args.minutes) || 5)
    const to = String(args.to || runtime.config?.identity?.ownerId || '')
    const text = String(args.text || args.what || '时间到了').slice(0, 180)
    const result = runtime.reminders.add({ at: Date.now() + minutes * 60_000, text, to })
    return result.ok ? { ok: true, text: `好，${minutes} 分钟后提醒：${text}` } : { ok: false, error: result.error }
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
          filter: (row) => Array.isArray(row?.payload?.images) && row.payload.images.length > 0,
        })?.rows || []
        const latest = found[0]?.payload?.images || []
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
    if (!allow('at:' + target.target, 3, 3_600_000)) return { ok: false, error: '本小时 @ 的次数用完了（上限 3 次）' }
    try {
      await channel.sayAt(target.target, qq, text)
      return { ok: true, text: `在群里 @ 了 ${qq}：${text}` }
    } catch (error) {
      return { ok: false, error: brief(error?.message || error, 80) }
    }
  })

  add('read_forward_more', (args = {}, ctx = {}) => {
    const all = Array.isArray(ctx.forwardAll) ? ctx.forwardAll : []
    if (!all.length) return { ok: false, error: '当前没有可继续展开的转发' }
    const from = Math.max(1, Number(args.offset || args.from) || 6)
    const count = Math.max(1, Math.min(20, Number(args.count) || 10))
    const part = all.slice(from - 1, from - 1 + count)
    if (!part.length) return { ok: true, text: `转发一共 ${all.length} 条，后面没有了` }
    const lines = part.map((row, index) => `${from + index}. ${row.sender ? row.sender + '：' : ''}${brief(row.text, 140)}${row.images ? '［附图］' : ''}`)
    return { ok: true, text: `转发共 ${all.length} 条，这是第 ${from} 条起：\n${lines.join('\n')}`, data: { total: all.length, from } }
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
    const wants = wantStats(dir)
    if (wants.open) lines.push(`需求本上还有 ${wants.open} 条没处理。`)
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
    // 「群 100000001」和「我」都要算：self 事件按 conversation 归属，
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
    const lines = [
      `我能用的工具（${names.length} 个）：${labels}。`,
      `技能：会 ${counts.on ?? 0} 项，用不了 ${counts.blocked ?? 0} 项（其中 ${counts.notWired ?? 0} 项还没接上）。`,
      `限制：联网白名单${(cfg.net?.allowlist || []).length ? '已设' : '是空的（等于不许上网）'}，沙箱每天 ${cfg.sandbox?.dailyMax ?? 0} 次，记忆${cfg.memory?.enabled === false ? '关着' : '开着'}。`,
      // 这句必须说：不说的话，模型会把「看代码」和「写草稿」当成一回事，
      // 于是临时脚本一股脑写进源码树（每次还要备份），或者反过来把正经改动写到会被回收的地方。
      `看代码、改代码默认动的是我自己的源码（改前会备份）；临时脚本和中间文件写到草稿纸：同一批工具加 "area":"work"，那里写完会留着，下次接着用。`,
    ]
    return { ok: true, text: lines.join('\n') }
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
    const wants = wantStats(dir)
    lines.push(`需求本：待处理 ${wants.open} 条。`)
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
    const what = String(args.what ?? args.text ?? '').trim()
    if (!what) return { ok: false, error: '想要什么？' }
    const result = addWant(dir, { text: what, why: args.why, now: Date.now() })
    if (!result.ok) return { ok: false, error: result.error }
    if (result.duplicated) return { ok: true, text: '这条已经记过了，等主人看' }
    return { ok: true, text: `记下了：${what}（第 ${listWants(dir).length} 条）` }
  })

  add('my_wants', () => {
    const list = listWants(dir)
    if (!list.length) return { ok: true, text: '需求本是空的。' }
    const lines = list.slice(0, 20).map((item) => `${item.no}. [${item.status}] ${brief(item.text, 120)}${item.count > 1 ? `（提了 ${item.count} 次）` : ''}`)
    return { ok: true, text: `需求本（共 ${list.length} 条）：\n${lines.join('\n')}` }
  })

  add('resolve_want', (args = {}) => {
    const result = resolveWant(dir, args.target ?? args.no ?? args.id, Date.now())
    return result.ok ? { ok: true, text: '标记成达成了：' + brief(result.item.text, 80) } : { ok: false, error: result.error }
  })

  add('drop_want', (args = {}) => {
    const result = dropWant(dir, args.target ?? args.no ?? args.id)
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
    const result = refuseUin(dir, uin, minutes, String(args.reason || '').slice(0, 80))
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, text: `好，${minutes} 分钟内不接 ${uin} 的话` }
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
    const handler = registry.get(key)
    if (!handler) return { ok: false, error: `还没接上：${raw || '(空)'}`, code: 'not_wired' }
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
   */
  function prompt() {
    const blocked = blockedNow()
    const whitelist = Array.isArray(runtime?.config?.tools?.whitelist) ? runtime.config.tools.whitelist.filter(Boolean) : []
    const names = [...registry.keys()].filter((name) => {
      if (whitelist.length && !whitelist.includes(name)) return false
      return !(blocked && blocked.has(name))
    })
    const hints = Object.entries(TOOL_HINTS)
      .filter(([key]) => names.includes(key))
      .slice(0, 10)
      .map(([key, value]) => `${key}${value}`)
      .join('、')
    return `可用工具：${names.join('、')}。参数一律写成 JSON 对象，例如 ${hints}。不要同时写解释。`
  }

  return {
    call,
    has: (name) => registry.has(TOOL_ALIASES[String(name || '')] || String(name || '')),
    names: () => [...registry.keys()],
    label,
    prompt,
  }
}
