/**
 * lib/turn.mjs — 一条消息进来，一句话出去。
 *
 * 这是整条链上唯一「会产生副作用」的环节：调模型、记账、发送。
 * 所以它被压得尽量薄 —— 所有判断都已经在 behavior / guard 里做完，
 * 这里只按顺序执行，且每一步都能单独失败、单独留痕。
 *
 * 顺序（不要改，每一步都依赖前一步的事实）：
 *   decide → 落事件 → 该不该动 → 限流 → 拼上下文 → 生成 → 记账 → 分条 → 出站 → 记结果
 *
 * 「生成」被抽成可注入的 runner：生产是宿主里的 agent，测试是一个假函数。
 * 这样这条链在没有模型、没有网络的情况下也能完整验证 —— 旧版正是因为把两者焊死，
 * 才只能靠「真跑起来看看」来测。
 */

import { BEHAVIOR } from './behavior.mjs'
import { conversationOf } from './event.mjs'
import { card } from './say.mjs'
import { memoryCommand } from './memory.mjs'
import { openUrl, readCurrent, clickIndex, typeInto, closeSession, formatPage, screenshot } from './browser.mjs'
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { parseReminder } from './reminders.mjs'
import { searchWeb, readWeb } from './web.mjs'
import { runActivityStep } from './activity.mjs'
import { isRefused } from './refusals.mjs'
import { dropWant, resolveWant } from './wants.mjs'
import { splitUsage } from './usage.mjs'
import { usageSourceOfTool } from './tools.mjs'
import { writeJson } from './core.mjs'

/** 单张图片上限；超过不下载，防止一张大图把内存顶满 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
/** 「我为什么没回」这句话，同一会话一小时最多说一次（说多了它自己就是刷屏） */
const NOTIFY_GAP_MS = 3_600_000

/**
 * 把 QQ 图片落成一个可读文件：先 URL，再本地 file，最后 NapCat get_image。
 * 返回 { ok, file, buffer, temp }；temp 为 true 时调用方负责删除。
 */
async function resolveImageFile(pic, channel, maxBytesArg) {
  const source = pic || {}
  const maxBytes = Math.max(256 * 1024, Number(maxBytesArg) || MAX_IMAGE_BYTES)
  // 收到消息时已把本体落盘（lib/media.mjs 的 attachImages）：优先用本地那份，
  // 这样「关掉窗口十分钟后再看图」也还能看到，不用赌 CDN 还没过期。
  if (source.persist) {
    const cached = await Promise.resolve(source.persist).catch(() => null)
    if (cached?.path && existsSync(cached.path)) return { ok: true, file: cached.path, buffer: null, temp: false }
  }
  let file = String(source.file || '').replace(/^file:\/\//, '')
  if (file && existsSync(file) && statSync(file).size <= maxBytes) {
    return { ok: true, file, buffer: null, temp: false }
  }
  const save = (buffer) => {
    if (!buffer || buffer.length > maxBytes) return null
    const head = buffer.length > 12 ? buffer : Buffer.alloc(0)
    const png = head[0] === 0x89 && head[1] === 0x50
    const gif = head[0] === 0x47 && head[1] === 0x49
    const webp = head[0] === 0x52 && head[1] === 0x49
    const ext = png ? 'png' : gif ? 'gif' : webp ? 'webp' : 'jpg'
    const out = path.join(tmpdir(), 'whale-image-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.' + ext)
    writeFileSync(out, buffer)
    return out
  }
  const download = async (url) => {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://qq.com/' } })
      const type = String(res.headers.get('content-type') || '')
      if (!res.ok || (type && !type.startsWith('image/'))) return null
      return Buffer.from(await res.arrayBuffer())
    } catch {
      return null
    }
  }
  let buffer = null
  if (/^https?:/i.test(source.url || '')) buffer = await download(source.url)
  if (!buffer && channel && typeof channel.getImage === 'function') {
    const got = await channel.getImage(source.file || source.url || '')
    if (got.base64) buffer = Buffer.from(got.base64, 'base64')
    else if (got.url && /^https?:/i.test(got.url)) buffer = await download(got.url)
    else if (got.file && existsSync(got.file) && statSync(got.file).size <= maxBytes) {
      return { ok: true, file: got.file, buffer: null, temp: false }
    }
  }
  const out = save(buffer)
  return out ? { ok: true, file: out, buffer, temp: true } : { ok: false, error: '图片超过大小上限或下载失败' }
}

const SENTENCE_END = /[。！？!?…]+/

/**
 * 把一整段话切成几条。
 *
 * 三条规矩，都是为了让它像人发的：
 *   1. 优先在段落和句末断，不在句子中间断；
 *   2. 短的合并到一条里，别一句一条刷屏；
 *   3. 超过上限就合并到最后一条，宁可最后一条长，也不要多发一条。
 *
 * @returns {string[]} 至少一条；输入空白时返回空数组（空内容不该发出去）
 */
export function splitReply(text, options = {}) {
  const raw = String(text || '').trim()
  if (!raw) return []
  const maxParts = Math.max(1, Math.min(8, Number(options.maxParts) || 3))
  // 断句线由用户设置决定：150 就在 150 里断，25 就在 25 里断
  const partChars = Math.max(4, Math.min(150, Number(options.partChars) || 20))

  if (maxParts === 1) return [raw.replace(SENTENCE_END, '')]

  // 先按行切；一行里再按句末切。短句保留，空段丢掉
  const pieces = []
  for (const line of raw.split(/\n+/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const sentences = trimmed.split(SENTENCE_END).map((x) => x.trim()).filter(Boolean)
    if (!sentences.length) continue
    for (const sentence of sentences) pieces.push(sentence)
  }
  if (!pieces.length) return []

  // 合并：能塞进一条就塞，超出 partChars 才新起一条
  const merged = [pieces[0]]
  for (let i = 1; i < pieces.length; i += 1) {
    const last = merged[merged.length - 1]
    const joined = `${last}${last.endsWith('，') ? '' : '，'}${pieces[i]}`
    if (joined.length <= partChars) merged[merged.length - 1] = joined
    else merged.push(pieces[i])
  }

  // 条数超了就并到最后一条：多发一条比最后一条长更烦人
  if (merged.length > maxParts) {
    const head = merged.slice(0, maxParts - 1)
    head.push(merged.slice(maxParts - 1).join('，'))
    return head
  }
  return merged
}

/**
 * 拼给模型的上下文。
 *
 * 只给「最近同一个会话里的几条」，不给全量历史 —— 全量既贵又会让模型抓错重点。
 * 自己的旧话也放进去，但要标明是谁说的，否则它会把上下文当成独白。
 */
/**
 * 从一段回复里认出「[tool:名字] {…}」。
 *
 * 模型偶尔会把这行当成正文说出来（尤其是没人接的一侧）。识别只做一件事：
 * 名字 + 参数，解析不出来就给空参数 —— 让工具自己去报「参数不对」，
 * 好过这里静默丢掉一次调用。
 */
export function parseToolCall(text) {
  const all = parseToolCalls(text)
  return all.length ? all[0] : null
}

/**
 * 从一段回复里认出**全部**「[tool:名字] {…}」。
 *
 * 为什么不能再用一个贪婪正则：`\{[\s\S]*\}` 会把第二个调用的参数一起吞进第一段，
 * JSON.parse 失败 → 参数变 {} → 第一次调用带着空参数去撞墙，第二次调用直接消失。
 * 模型想「先搜再记」时就会静默丢一半活。
 *
 * 这里做的是真正的切分：找到标记，再从 `{` 起按括号配对（认字符串与转义），
 * 每段参数各自解析。解析失败的调用也留着（args 标记 invalid），
 * 让上层能记一笔账，而不是假装没发生过。
 *
 * @returns {Array<{name:string, args:object, raw:string, invalid?:boolean}>}
 */
export function parseToolCalls(text) {
  const body = String(text || '')
  const out = []
  const re = /\[tool:([^\]\n]{1,40})\]/g
  let match
  while ((match = re.exec(body)) !== null) {
    const name = String(match[1] || '').trim()
    if (!name) continue
    let cursor = re.lastIndex
    while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1
    let args = {}
    let invalid = false
    let end = cursor
    if (body[cursor] === '{') {
      end = matchBrace(body, cursor)
      if (end < 0) {
        // 括号没配平：参数残缺，调用本身还是有效的（工具会报「参数不对」）
        invalid = true
        end = cursor
      } else {
        try {
          const parsed = JSON.parse(body.slice(cursor, end + 1))
          args = parsed && typeof parsed === 'object' ? parsed : {}
        } catch {
          invalid = true
        }
        end += 1
      }
    }
    out.push({ name, args, raw: body.slice(match.index, end).trim(), invalid })
    re.lastIndex = Math.max(re.lastIndex, end)
  }
  return out
}

/** 从 open 位置的 `{` 起找配对的 `}`；认字符串和转义，找不到返回 -1 */
function matchBrace(text, open) {
  let depth = 0
  let quote = ''
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

export function buildPrompt(input = {}) {
  const event = input.event || {}
  const persona = input.persona || {}
  const guide = String(input.styleGuide || '')
  const recent = Array.isArray(input.recent) ? input.recent : []
  const memory = input.memory || null
  const search = Array.isArray(input.search) ? input.search : []
  const quote = input.quote || null
  const forward = Array.isArray(input.forward) ? input.forward : []
  const files = Array.isArray(input.files) ? input.files : []
  const vision = String(input.vision || '').trim()
  const toolLine = String(input.toolLine || '').trim()
  const emptyAt = input.emptyAt === true
  const selfName = String(persona.name || '深蓝')

  const lines = []
  if (persona.persona) lines.push(`你是谁：${persona.persona}`)
  lines.push(`你的名字：${selfName}`)
  if (persona.ownerName) lines.push(`你称呼用户：${persona.ownerName}`)
  if (guide) lines.push(guide)
  lines.push('【行动规则】用户让你做事时，不要先用“我去/马上/这就去/试试”答应。必须直接输出工具调用行，格式是 [tool:工具名] {"参数":"值"}，系统执行后会把结果给你，你再回复。只有不需要动手时才正常聊天。' +
    '一件事需要几步时，可以在同一条回复里连着写几行，一行一个工具：先搜再记就写两行，系统会按顺序都执行，然后把每一条的结果一起给你。一次最多 4 行。')

  if (memory && memory.summary) {
    lines.push('你记得的旧摘要：')
    lines.push(String(memory.summary).slice(0, 800))
  }
  if (memory && Array.isArray(memory.network) && memory.network.length) {
    lines.push('顺着记忆想到的：')
    for (const item of memory.network.slice(0, 6)) lines.push('- ' + String(item.text || ''))
  }
  if (memory && Array.isArray(memory.facts) && memory.facts.length) {
    lines.push('你记得的事实：')
    for (const item of memory.facts.slice(0, 6)) lines.push(`- ${String(item.text || '').slice(0, 100)}`)
  }
  if (memory && Array.isArray(memory.related) && memory.related.length) {
    lines.push('可能相关的旧记忆：')
    for (const item of memory.related.slice(0, 3)) lines.push(`- ${String(item.text || '').slice(0, 100)}`)
  }
  if (memory && Array.isArray(memory.self) && memory.self.length) {
    lines.push('你对自己的认识：')
    for (const item of memory.self.slice(-5)) lines.push(`- ${String(item.text || '').slice(0, 100)}`)
  }
  if (memory && memory.person && (memory.person.name || (memory.person.notes || []).length || memory.person.impression)) {
    lines.push('关于这个人：')
    if (memory.person.impression) lines.push(`- 印象：${String(memory.person.impression).slice(0, 80)}`)
    if (memory.person.name) lines.push(`- 称呼他「${String(memory.person.name).slice(0, 20)}」`)
    for (const note of (memory.person.notes || []).slice(-4)) lines.push(`- ${String(note).slice(0, 80)}`)
  }
  if (memory && memory.group && (memory.group.label || (memory.group.topics || []).length)) {
    lines.push('这个群最近：')
    if (memory.group.label) lines.push(`- 群名：${String(memory.group.label).slice(0, 30)}`)
    for (const topic of (memory.group.topics || []).slice(-4)) lines.push(`- ${String(topic).slice(0, 80)}`)
  }

  if (search.length) {
    lines.push('刚查到的网上资料：')
    for (const item of search.slice(0, 5)) lines.push(`- ${String(item).slice(0, 220)}`)
    lines.push('直接根据上面的资料回答；不要只说“我去搜/稍等/查到了”而没有结论。资料不够就说明不够。')
  }
  if (quote && (quote.text || (Array.isArray(quote.images) && quote.images.length))) {
    lines.push(quote.summary ? '对方引用了这条消息（只拿到摘要）：' : '对方正在回复这条消息：')
    lines.push(`- ${quote.sender ? quote.sender + '：' : ''}${String(quote.text || '[图片]').slice(0, 200)}`)
  }

  if (vision) {
    lines.push('对方发来一张图，看到的内容是：')
    lines.push(vision.slice(0, 1200))
  }

  if (forward.length) {
    lines.push('有人转发了一段聊天记录：')
    for (const row of forward.slice(0, 5)) lines.push(`- ${row.sender ? row.sender + '：' : ''}${String(row.text).slice(0, 160)}`)
  }

  if (files.length) {
    lines.push('对方发来了文件：')
    for (const row of files.slice(0, 3)) lines.push(`- ${row.name || '文件'}${row.text ? '：\n' + String(row.text).slice(0, 1200) : '（' + (row.note || '没有正文') + '）'}`)
  }

  if (recent.length) {
    lines.push('刚才的对话：')
    for (const row of recent) {
      // 群里不止一个人：只写「对方」会把三个人的话揉成一个人说的
      const who = row?.from === 'self' ? selfName : String(row?.name || '对方')
      const text = String(row?.text || '').slice(0, 120)
      if (text) lines.push(`${who}：${text}`)
      if (row?.image) lines.push(`${who}：[图片] ${String(row.image).slice(0, 200)}`)
    }
  }

  const who = String(event.payload?.senderName || event.from || '')
  lines.push('')
  if (emptyAt) {
    lines.push(`${who || '对方'}只 @ 了你，没打字。结合上面的对话接一句自然的话，别问「怎么了」，也别复述刚才的话。`)
  } else {
    lines.push(who ? `${who}说：${event.payload?.text || ''}` : `对方说：${event.payload?.text || ''}`)
  }
  lines.push('直接回一句话，不要解释你在做什么。')
  lines.push('如果这句话配表情更自然，可以在末尾加 [表情:标签]；不确定就不加。')
  // 「发小黄脸」关掉时，这一行不能再出现：提示词教了一条走不通的路，
  // 模型就会一直往回复里塞 [face:14]，而那条路根本不经过工具表。
  if (input.allowFace !== false) {
    lines.push('QQ 原生小黄脸用 [face:id]，常用：0 惊讶、1 撇嘴、2 色、3 发呆、4 得意、5 流泪、6 害羞、7 闭嘴、8 睡、9 大哭、10 尴尬、11 发怒、12 调皮、13 呲牙、14 微笑。')
  }
  if (toolLine) lines.push(toolLine)
  return lines.join('\n')
}

export class Turn {
  /**
   * @param {object} input
   * @param {object} input.runtime
   * @param {object} input.guard
   * @param {object} input.usage
   * @param {object} input.channel  需要 say(scope, target, text)
   * @param {object} [input.typing]   lib/typing.mjs 的打字台（缺了就退回旧的固定节奏）
   * @param {object} [input.attention] lib/attention.mjs 的注意力账本（缺了就当没有窗口）
   * @param {(prompt:string, meta:object)=>Promise<{text:string, usage?:{input:number,output:number}}>} [input.runner]
   * @param {(ms:number)=>Promise<void>} [input.sleep]
   */
  constructor(input = {}) {
    this.runtime = input.runtime
    this.guard = input.guard
    this.usage = input.usage
    this.channel = input.channel || null
    this.typing = input.typing || null
    this.attention = input.attention || null
    this.runner = typeof input.runner === 'function' ? input.runner : null
    this.tools = input.tools || null
    this.sleep = typeof input.sleep === 'function' ? input.sleep : (ms) => new Promise((r) => setTimeout(r, ms))
    this.log = typeof input.log === 'function' ? input.log : () => {}
    this.visionNotes = new Map()
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()
    // 同一会话串行：两个人同时说话时，不该让两条回复交错着插进来
    this.queue = new Map()
    this.pendingLeave = new Map()
    // 会话 → 上次「我为什么没回」的说明时间。限流的活该被限，
    // 但这个为什么要单独记：见 #notifyHold —— 沉默是最难排查的故障。
    this.holdNotices = new Map()
  }

  /** 有没有能用的生成器。没有的话「接话」不算能用，技能页也不该说会 */
  get ready() {
    return typeof this.runner === 'function'
  }

  /**
   * 最近同一会话的记录，给上下文用。
   *
   * 两个坑都在这里踩过：
   *   1. 不能拿「全局最近 80 行」再过滤 —— 心跳占日志八成，本群几句真话
   *      会被挤到窗口外面（实测被叫时经常一条都读不到）；
   *   2. 当前这条在 #respond 之前就落盘了，必须按 id 排掉，否则提示词里
   *      同一句会出现两次（recent 一次、最后一行一次）。
   */
  #recent(event, limit = 20) {
    try {
      const rows = this.runtime.events.read({
        limit,
        maxScan: 2000,
        filter: (row) => row?.conversation === event.conversation
          && row.id !== event.id
          && (row.type === 'message' || row.type === 'image'),
      }).rows
      return rows
        // 补回的消息是「后写进来、时间更早」，不能按落盘顺序当新旧
        .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0))
        .slice(0, limit)
        .reverse()
        .map((row) => {
          const text = String(row?.payload?.text || row?.text || '')
          // 只引用的消息没有正文，但「谁引用了什么」本身就是上下文
          const quote = row?.replySummary ? `（引用：${String(row.replySummary).slice(0, 120)}）` : ''
          return {
            from: row?.from === 'self' ? 'self' : 'other',
            name: String(row?.sender || ''),
            text: text || quote,
            image: this.visionNotes.get(row?.id) || '',
          }
        })
        .filter((row) => row.text || row.image)
    } catch {
      return []
    }
  }

  /**
   * 注意力预判：这条群消息是不是在「接着说」。
   *
   * 放在 decide 之前，是因为它要影响路由（窗口里的话不用 @ 也算被点到）；
   * 但**开窗关窗的副作用留在这里**，decide 拿到的只是一个普通对象 ——
   * 同一个 raw 判两次结果必须一致，否则「为什么这条回了、那条没回」永远说不清。
   *
   * 被明确 @ 的不走这条路：@ 已经是更强的事实，再判一次反而会把
   * 「被点名」记成「窗口命中」，统计里两类混在一起。
   */
  #attention(raw) {
    if (!this.attention || String(raw?.scope || '') !== 'group') return null
    if (raw?.atMe === true) return null
    const text = String(raw?.payload?.text || raw?.text || '')
    if (!text.trim()) return null
    try {
      return this.attention.consider({
        conversation: conversationOf(raw),
        from: String(raw?.from || ''),
        text,
      })
    } catch (error) {
      this.log('[whale] 注意力判定没做成：' + String(error?.message || error))
      return null
    }
  }

  /**
   * 处理一条 raw。返回处理结果（测试和面板都用得上）。
   * 任何一步失败都不抛到外面：一条消息处理不了，不该让整个通道停摆。
   */
  async handle(raw) {
    const at = this.now()
    let decision
    try {
      decision = this.runtime.decide(raw, { config: this.runtime.config, attention: this.#attention(raw) })
    } catch (error) {
      this.runtime.log('invalid_event', { error: String(error?.message || error) })
      return { ok: false, stage: 'decide', error: String(error?.message || error) }
    }

    const { event } = decision
    // decide 对脏事件是「兜底返回」而不是抛异常（通道送来半个包时不能让循环停摆）。
    // 所以这里必须判空：拿到 null 就直接收场，别往下走 —— 后面每一行都在用 event.id。
    if (!event) {
      return { ok: false, stage: 'decide', error: decision.reason || '事件不合法' }
    }
    // 同一条 QQ 消息重复投递（重连补回、多连接、协议端重放）：只处理一次。
    // 放在落盘之前：否则日志里会先多出一行，再谈去重就晚了。
    const messageId = String(event.payload?.messageId || '')
    if (messageId && typeof this.runtime.claimMessage === 'function' && !this.runtime.claimMessage(messageId)) {
      return { ok: true, skipped: true, reason: '重复投递', event }
    }
    // 先落事件再判断：回不回是行为，收没收到是事实，事实不能因为「不回」就丢掉
    this.runtime.logEvent(event)
    if (this.runtime.memory && event.scope === 'group' && event.payload?.groupId && event.payload?.text) {
      try {
        this.runtime.memory.rememberGroup(event.payload.groupId, {
          label: event.payload.groupName || event.group || '',
          topic: event.payload.text,
        })
      } catch {}
    }

    if (!decision.behavior) {
      this.runtime.outcome({ eventId: event.id, behavior: 'reply', trigger: decision.trigger, ok: false, reason: decision.reason })
      return { ok: true, skipped: true, reason: decision.reason, event }
    }

    // 目前只接「回话」。主动开口与自主活动由定时器驱动，不在这条链上
    if (decision.behavior !== BEHAVIOR.REPLY && decision.behavior !== BEHAVIOR.ADMIN) {
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: decision.trigger, ok: false, reason: '这条链只处理回话' })
      return { ok: true, skipped: true, reason: decision.reason, event }
    }

    if (!this.ready) {
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: decision.trigger, ok: false, reason: '还没有可用的生成器' })
      return { ok: false, stage: 'runner', error: '还没有可用的生成器', event }
    }

    // 同一个会话排队，避免两条回复交叉
    const key = event.conversation
    const prev = this.queue.get(key) || Promise.resolve()
    const task = prev.then(() => this.#respond(event, decision, at)).catch((error) => ({
      ok: false,
      stage: 'respond',
      error: String(error?.message || error),
      event,
    }))
    this.queue.set(key, task)
    task.finally(() => {
      if (this.queue.get(key) === task) this.queue.delete(key)
    })
    return task
  }

  async #respond(event, decision, at) {
    const started = this.now()
    const isOwner = event.scope === 'private' && event.tags?.includes('is_owner')
    const isOwnerTag = event.tags?.includes('is_owner') === true
    const toolCtx = { event, forwardAll: [], quote: null, files: [] }

    // 被登记「暂时不想理」的人：直接跳过，主人除外。
    // 这里不发任何提示 —— 不理就是不理，回一句「我不想理你」反而还在理。
    if (!isOwnerTag && event.from && isRefused(this.runtime.dir || '', event.from, started)) {
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'refused', ok: false, reason: '登记过暂时不想理' })
      return { ok: true, skipped: true, reason: '登记过暂时不想理', event }
    }

    // 决定要回的那一刻就亮「正在输入」，不等生成完。
    // 模型跑 3~10 秒，这段时间对方看到的是一个完全静止的窗口 —— 那是整段体验里最长的空白。
    // 亮了之后，typeOut 会把这段已花掉的时间从打字时长里扣掉，总等待不再等于「生成 + 打字」。
    // 放在「不理」判定之后：不该回的人不许看到它在那儿打字。
    if (this.typing && typeof this.typing.early === 'function') {
      const scope = event.scope === 'group' ? 'group' : 'private'
      const target = scope === 'group' ? event.payload?.groupId : event.from
      try {
        await this.typing.early(scope, target, event.conversation)
      } catch {}
    }

    if (event.scope === 'private' && isOwner) {
      try {
        if (this.runtime.memory && event.from) this.runtime.memory.rememberPerson(event.from, { name: event.sender || event.payload?.senderName || '' })
      } catch {}
      if (/主动说一句|主动开口/.test(String(event.payload?.text || '')) && typeof this.runner === 'function') {
        try {
          const generated = await this.runner('你现在主动跟主人说一句短话，20-50字，像真人随手发的，不要提问。', { conversation: event.conversation })
          // 这一句不是在回答谁，是它自己要说的话 —— 记「自主活动」，不混进「对话」。
          const spent = this.#spend(generated, 'auto', event)
          if (generated && generated.text) {
            // 思维链先于发言：先想后说，哪怕只是一句主动开口
            this.runtime.logCot?.({
              conversation: event.conversation,
              kind: 'proactive',
              text: String(generated.reasoning || '（主动开口，没有单独输出思考过程）'),
              summary: '主动开口：' + String(generated.text).slice(0, 80),
              at: this.now(),
              source: 'auto',
              tokens: spent,
            })
            await this.#say(event.scope, event, [generated.text], started)
            this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'proactive_manual', ok: true, lines: 1 })
            return { ok: true, stage: 'proactive', text: generated.text, event }
          }
        } catch (error) {
          await this.#say(event.scope, event, ['这次没想出来：' + String(error?.message || error).slice(0, 60)], started)
          return { ok: false, stage: 'proactive', error: String(error?.message || error), event }
        }
      }
      const briefText = String(event.payload?.text || '').trim()
      if (/^(帮助|你会什么|你能做什么|有什么功能|指令|指令表)$/.test(briefText)) {
        const caps = this.tools ? await this.tools.call('my_capabilities', {}, toolCtx) : null
        const cmds = this.tools ? await this.tools.call('owner_commands', {}, toolCtx) : null
        await this.#say(event.scope, event, [caps?.ok ? caps.text : '工具清单还读不出来。', cmds?.ok ? cmds.text : ''], started)
        return { ok: true, stage: 'help', event }
      }
      if (/^(状态|现在状态|看看状态|运行状态)$/.test(briefText)) {
        const status = this.tools ? await this.tools.call('my_status', {}, toolCtx) : null
        await this.#say(event.scope, event, [status?.ok ? status.text : '状态还读不出来。'], started)
        return { ok: true, stage: 'status', event }
      }
      if (/^(说说|发条说说|写条说说)/.test(briefText)) {
        if (!this.channel || typeof this.channel.sendQzone !== 'function') {
          await this.#say(event.scope, event, ['现在发不了说说：通道没接上这个接口'], started)
          return { ok: false, stage: 'qzone', event }
        }
        const stateFile = path.join(this.runtime.dir || '', 'qzone-state.json')
        let state = { day: '', count: 0 }
        try { state = { ...state, ...JSON.parse(readFileSync(stateFile, 'utf8')) } } catch {}
        const day = new Date().toDateString()
        if (state.day !== day) state = { day, count: 0 }
        if (state.count >= 2) {
          await this.#say(event.scope, event, ['今天已经发过两条了，留点话明天说'], started)
          return { ok: true, stage: 'qzone_limit', event }
        }
        const given = briefText.replace(/^(说说|发条说说|写条说说)[：:，,\s]*/, '').trim()
        let content = given
        let generated = null
        let wrote = null
        if (!content) {
          try {
            generated = await this.runner('用你自己的口吻写一条 QQ 空间说说，40-120 字，像随手写的，不要标题、不要解释、不要复述任何人的原话。', { conversation: 'qzone' })
            // 写说说不是「回话」：这笔同样归「自主活动」，否则对话那档会把它的自言自语也算进去
            wrote = this.#spend(generated, 'auto', event)
            content = String(generated?.text || '').trim()
          } catch {}
        }
        if (!content || content === '无' || content.length < 4) {
          await this.#say(event.scope, event, ['这次没什么想发的，算了。'], started)
          return { ok: true, stage: 'qzone_empty', event }
        }
        // 思维链先于发言：说说也是它写给人看的话，发出去前先落一条
        this.runtime.logCot?.({
          conversation: 'qzone',
          kind: 'qzone',
          text: String(generated?.reasoning || '（写说说，没有单独输出思考过程）'),
          summary: '发说说：' + String(content).slice(0, 80),
          at: this.now(),
          source: wrote ? 'auto' : '',
          tokens: wrote,
        })
        try {
          await this.channel.sendQzone(content.slice(0, 300), 1)
          writeJson(stateFile, { day, count: state.count + 1 })
          await this.#say(event.scope, event, ['已发：' + content.slice(0, 120)], started)
          return { ok: true, stage: 'qzone', event }
        } catch (error) {
          await this.#say(event.scope, event, ['发说说失败了：' + String(error?.message || error).slice(0, 80)], started)
          return { ok: false, stage: 'qzone', event }
        }
      }
      const muteMatch = briefText.match(/^(?:闭嘴|安静|安静点|消停点|先别说了)(?:[，,\s]*(\d+)\s*(分钟|个小时|小时))?/)
      if (muteMatch) {
        const span = muteMatch[1] ? Number(muteMatch[1]) * (muteMatch[2] === '分钟' ? 1 : 60) : 30
        this.guard.mute(span)
        await this.#say(event.scope, event, [`好，我安静 ${span} 分钟。想说「恢复说话」就叫我。`], started)
        return { ok: true, stage: 'mute', event }
      }
      if (/^(恢复说话|解除静音|不用安静了|出来吧|可以说话了)$/.test(briefText)) {
        this.guard.unmute()
        await this.#say(event.scope, event, ['好，我回来了。'], started)
        return { ok: true, stage: 'unmute', event }
      }
      const riskMatch = briefText.match(/^风控(?:模式)?\s*(开|关|开启|关闭|打开)?/)
      if (riskMatch) {
        const current = Number(this.runtime.config.guard?.perMinute) <= 2
        const on = riskMatch[1] ? /开|开启|打开/.test(riskMatch[1]) : !current
        const values = on
          ? { 'guard.perMinute': 2, 'guard.replyQuotaPerHour': 8, 'group.followUpSeconds': 20, 'proactive.perDay': 2 }
          : { 'guard.perMinute': 15, 'guard.replyQuotaPerHour': 60, 'group.followUpSeconds': 180, 'proactive.perDay': 3 }
        for (const [key, value] of Object.entries(values)) this.runtime.setConfig(key, value, { confirm: false })
        await this.#say(event.scope, event, [on
          ? '风控模式已开：每分钟最多 2 条、每小时 8 条，续聊窗口 20 秒，主动开口减半。'
          : '风控模式已关：恢复原来的节奏。'], started)
        return { ok: true, stage: 'risk', event }
      }
      if (/^(别主动了|不要主动了|安静一阵|消停一阵)$/.test(briefText)) {
        this.runtime.setConfig('proactive.enabled', false, { confirm: false })
        await this.#say(event.scope, event, ['好，我不再自己找话题了。想恢复就说「可以主动了」。'], started)
        return { ok: true, stage: 'proactive_off', event }
      }
      if (/^(可以主动了|恢复主动|主动一点吧)$/.test(briefText)) {
        this.runtime.setConfig('proactive.enabled', true, { confirm: false })
        await this.#say(event.scope, event, ['好，恢复主动了。'], started)
        return { ok: true, stage: 'proactive_on', event }
      }
      const limitMatch = briefText.match(/(?:限流改成|每分钟(?:最多)?)\s*(\d+)\s*条/)
      if (limitMatch) {
        const value = Math.max(1, Math.min(60, Number(limitMatch[1]) || 15))
        const done = this.runtime.setConfig('guard.perMinute', value, { confirm: false })
        await this.#say(event.scope, event, [done.ok ? `好，每分钟最多 ${value} 条。` : '没改成：' + (done.error || '不知道原因')], started)
        return { ok: done.ok, stage: 'rate', event }
      }
      const nameMatch = briefText.match(/^以后(?:就)?叫我\s*(.{1,12})$/)
      if (nameMatch) {
        const name = nameMatch[1].trim()
        const done = this.runtime.setConfig('identity.ownerName', name, { confirm: false })
        await this.#say(event.scope, event, [done.ok ? `好，以后叫你「${name}」。` : '没改成：' + (done.error || '不知道原因')], started)
        return { ok: done.ok, stage: 'owner_name', event }
      }
      if (/^(各个群的印象|群印象|群的印象)$/.test(briefText)) {
        const result = this.tools ? await this.tools.call('group_impressions', {}, toolCtx) : null
        await this.#say(event.scope, event, [result?.ok ? result.text : '还读不出来。'], started)
        return { ok: true, stage: 'impressions', event }
      }
      if (/^(需求清单|看看需求|需求本|我的需求)$/.test(briefText)) {
        const result = this.tools ? await this.tools.call('my_wants', {}, toolCtx) : null
        await this.#say(event.scope, event, [result?.ok ? result.text : '需求本读不出来。'], started)
        return { ok: true, stage: 'wants', event }
      }
      const grant = briefText.match(/^(?:给\s*TA|给\u5979|答应)\s*(\d+)/i)
      if (grant) {
        const done = resolveWant(this.runtime.dir || '', grant[1], this.now())
        await this.#say(event.scope, event, [done.ok ? '好，这条算达成了：' + String(done.item.text).slice(0, 80) : '没有这条需求。'], started)
        return { ok: done.ok, stage: 'want_done', event }
      }
      const drop = briefText.match(/^(?:算了|不要了|删掉需求)\s*(\d+)/)
      if (drop) {
        const done = dropWant(this.runtime.dir || '', drop[1])
        await this.#say(event.scope, event, [done.ok ? '删掉了：' + String(done.item.text).slice(0, 80) : '没有这条需求。'], started)
        return { ok: done.ok, stage: 'want_drop', event }
      }
      if (/^(全部想法|所有想法|你的想法)$/.test(briefText) || /^(全部自省|所有自省)$/.test(briefText)) {
        const which = /自省/.test(briefText) ? 'reflections' : 'views'
        const result = this.tools ? await this.tools.call('my_thoughts', { which, limit: 50 }, toolCtx) : null
        const lines = String(result?.text || '').split('\n').filter(Boolean)
        const chunks = []
        for (let i = 0; i < lines.length; i += 12) chunks.push(lines.slice(i, i + 12).join('\n'))
        await this.#say(event.scope, event, chunks.length ? chunks : ['还没有记下什么。'], started)
        return { ok: true, stage: 'thoughts', event }
      }
      if (/^(停下|打断|别忙了)$/.test(briefText)) {
        this.guard.mute(2)
        await this.#say(event.scope, event, ['好，先停一下。'], started)
        return { ok: true, stage: 'stop', event }
      }
      if (/^(现在几点|现在时间|今天几号|今天日期|星期几)/.test(briefText) && this.tools) {
        const now = await this.tools.call('time', {})
        if (now && now.ok) {
          await this.#say(event.scope, event, [now.text], started)
          return { ok: true, stage: 'time', event }
        }
      }
      const activityMatch = briefText.match(/^(活动一下|自己找点事|自由活动|去探险|读点书|玩会儿|想想事|回忆一下|憧憬一下)/)
      if (activityMatch && typeof this.runner === 'function') {
        try {
          // 真的去查一圈再回话：不再让模型「写一句打算怎么做」。
          // 原文由 activity 模块落进活动日志，回复只转述真切发生的事。
          const step = await runActivityStep({ runtime: this.runtime, runner: this.runner, config: this.runtime.config })
          if (!step.ok) {
            await this.#say(event.scope, event, ['这次没想出来做什么：' + String(step.error || '没有结果').slice(0, 60)], started)
            return { ok: false, stage: 'activity', error: step.error, event }
          }
          await this.#say(event.scope, event, [String(step.text || '').slice(0, 220)], started)
          return { ok: true, stage: 'activity', event }
        } catch (error) {
          await this.#say(event.scope, event, ['这次没做成：' + String(error?.message || error).slice(0, 60)], started)
          return { ok: false, stage: 'activity', error: String(error?.message || error), event }
        }
      }
      if (/^(最近在想什么|你的活动)/.test(briefText) && this.runtime.activities) {
        const rows = this.runtime.activities.read({ limit: 5 }).rows || []
        const text = rows.length ? rows.map((row) => '- ' + String(row.text || '').slice(0, 100)).join('\n') : '最近还没想什么'
        await this.#say(event.scope, event, [text], started)
        return { ok: true, stage: 'activity_list', event }
      }
      if (/^(群列表|看看群)$/.test(briefText) && this.channel && typeof this.channel.groupList === 'function') {
        const groups = await this.channel.groupList()
        const text = groups.length
          ? groups.slice(0, 30).map((g) => `${g.group_id || g.groupId || ''} · ${g.group_name || g.groupName || ''}`).join('\n')
          : '没有拿到群列表'
        await this.#say(event.scope, event, [text], started)
        return { ok: true, stage: 'group_list', event }
      }
      const groupSay = briefText.match(/^在群\s*(\d+)\s*说\s*([\s\S]+)/)
      if (groupSay && this.channel) {
        try {
          await this.channel.say('group', groupSay[1], groupSay[2])
          await this.#say(event.scope, event, ['发出去了'], started)
          return { ok: true, stage: 'group_say', event }
        } catch (error) {
          await this.#say(event.scope, event, ['没发出去：' + String(error?.message || error).slice(0, 80)], started)
          return { ok: false, stage: 'group_say', event }
        }
      }
      const membersMatch = briefText.match(/^群成员\s*(\d+)/)
      if (membersMatch && this.channel && typeof this.channel.groupMembers === 'function') {
        const members = await this.channel.groupMembers(membersMatch[1])
        const text = members.length
          ? members.slice(0, 40).map((m) => `${m.user_id || m.uin || ''} · ${m.card || m.nickname || ''}`).join('\n')
          : '没有拿到群成员'
        await this.#say(event.scope, event, [text], started)
        return { ok: true, stage: 'group_members', event }
      }
      const leaveMatch = briefText.match(/^退群\s*(\d+)/)
      if (leaveMatch && this.channel && typeof this.channel.leaveGroup === 'function') {
        this.pendingLeave.set(leaveMatch[1], this.now())
        await this.#say(event.scope, event, [`要退群 ${leaveMatch[1]} 吗？60 秒内发「确认退群 ${leaveMatch[1]}」才会真的退`], started)
        return { ok: true, stage: 'group_leave_ask', event }
      }
      const leaveConfirm = briefText.match(/^确认退群\s*(\d+)/)
      if (leaveConfirm && this.channel && typeof this.channel.leaveGroup === 'function') {
        const at = this.pendingLeave.get(leaveConfirm[1]) || 0
        if (!at || this.now() - at > 60_000) {
          await this.#say(event.scope, event, ['确认过期了，请重新发「退群 ' + leaveConfirm[1] + '」'], started)
          return { ok: false, stage: 'group_leave', event }
        }
        this.pendingLeave.delete(leaveConfirm[1])
        try {
          await this.channel.leaveGroup(leaveConfirm[1])
          await this.#say(event.scope, event, ['已经退群 ' + leaveConfirm[1]], started)
          return { ok: true, stage: 'group_leave', event }
        } catch (error) {
          await this.#say(event.scope, event, ['退群失败：' + String(error?.message || error).slice(0, 80)], started)
          return { ok: false, stage: 'group_leave', event }
        }
      }
      if (/^记住你自己[，,：:]?/.test(briefText) && this.runtime.memory) {
        const note = briefText.replace(/^记住你自己[，,：:]?\s*/, '')
        const saved = this.runtime.memory.rememberSelf(note)
        await this.#say(event.scope, event, [saved.ok ? '好，我记住自己是这样的人' : saved.error], started)
        return { ok: saved.ok, stage: 'self_memory', event }
      }
      if (/^(你对自己的认识|你的自我记忆)/.test(briefText) && this.runtime.memory) {
        const notes = this.runtime.memory.selfNotes()
        await this.#say(event.scope, event, [notes.length ? notes.map((item) => '- ' + item.text).join('\n') : '我还没记下关于自己的事'], started)
        return { ok: true, stage: 'self_memory', event }
      }
      if (/看这张图|图里是什么|描述.*图/.test(briefText) && event.payload?.images?.length) {
        const pic = event.payload.images[0]
        let resolved = null
        try {
          resolved = await resolveImageFile(pic, this.channel, this.runtime.config.images?.maxBytes)
          if (!resolved.ok) throw new Error(resolved.error)
          const seen = await this.runtime.describeImageFile(resolved.file, briefText)
          await this.#say(event.scope, event, [seen.ok ? seen.text : '看不到这张图：' + seen.error], started)
          this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'vision', ok: seen.ok, lines: 1, tool: 'media.image' })
          return { ok: seen.ok, stage: 'vision', event }
        } catch (error) {
          await this.#say(event.scope, event, ['看图失败：' + String(error?.message || error).slice(0, 80)], started)
          return { ok: false, stage: 'vision', error: String(error?.message || error), event }
        } finally {
          if (resolved?.temp) { try { unlinkSync(resolved.file) } catch {} }
        }
      }
      if (/听语音|语音.*说什么|转成文字/.test(event.payload?.text || '') && event.payload?.voices?.length) {
        const voice = event.payload.voices[0]
        try {
          const rec = await this.channel.getRecord(voice.file || voice.url)
          let file = String(rec.file || '')
          if (rec.base64) {
            file = path.join(tmpdir(), 'whale-voice-' + Date.now() + '.wav')
            writeFileSync(file, Buffer.from(rec.base64, 'base64'))
          } else if (/^https?:/i.test(rec.url || '')) {
            const res = await fetch(rec.url)
            if (!res.ok) throw new Error('语音下载失败 HTTP ' + res.status)
            file = path.join(tmpdir(), 'whale-voice-' + Date.now() + '.wav')
            writeFileSync(file, Buffer.from(await res.arrayBuffer()))
          }
          if (!file || !existsSync(file)) throw new Error('没有拿到语音文件')
          const heard = await this.runtime.transcribeFile(file)
          await this.#say(event.scope, event, [heard.ok ? '听到的是：' + heard.text : '没听清：' + heard.error], started)
          return { ok: heard.ok, stage: 'voice', event }
        } catch (error) {
          await this.#say(event.scope, event, ['听语音失败：' + String(error?.message || error).slice(0, 80)], started)
          return { ok: false, stage: 'voice', error: String(error?.message || error), event }
        }
      }
      const bcfg = {
        browserHeadless: this.runtime.config.browser?.headless !== false,
        browserCdpUrl: String(this.runtime.config.browser?.cdpUrl || ''),
        browserAllowPrivate: this.runtime.config.browser?.allowPrivate === true,
        browserIdleMinutes: Number(this.runtime.config.browser?.idleMinutes) || 10,
        browserMaxPerHour: Number(this.runtime.config.browser?.maxPerHour) || 60,
        browserProfileDir: path.join(this.runtime.dir || '', 'browser-profile'),
        browserTimeoutMs: 25_000,
        browserMaxChars: 3000,
      }
      const openMatch = briefText.match(/^打开\s+(https?:\/\/\S+)/i)
      if (openMatch) {
        const result = await openUrl(openMatch[1], bcfg)
        await this.#say(event.scope, event, [result.ok ? formatPage(result.page, { maxChars: 1500 }) : '打不开：' + (result.why || result.error || '未知原因')], started)
        return { ok: result.ok, stage: 'browser_open', event }
      }
      if (/^(看看|读一下页面|读页面)/.test(briefText)) {
        const result = await readCurrent(bcfg)
        await this.#say(event.scope, event, [result.ok ? formatPage(result.page, { maxChars: 1500 }) : '读不到：' + (result.error || '未知原因')], started)
        return { ok: result.ok, stage: 'browser_read', event }
      }
      const clickMatch = briefText.match(/^点\s*(\d+)/)
      if (clickMatch) {
        const result = await clickIndex(Number(clickMatch[1]), bcfg)
        await this.#say(event.scope, event, [result.ok ? formatPage(result.page, { maxChars: 1200 }) : '点不了：' + (result.error || '未知原因')], started)
        return { ok: result.ok, stage: 'browser_click', event }
      }
      const typeMatch = briefText.match(/^输入\s*(\d+)\s*([\s\S]+)/)
      if (typeMatch) {
        const result = await typeInto(Number(typeMatch[1]), typeMatch[2], bcfg)
        await this.#say(event.scope, event, [result.ok ? '输入好了' : '输入失败：' + (result.error || '未知原因')], started)
        return { ok: result.ok, stage: 'browser_type', event }
      }
      if (/^(截图|截个图|截屏)/.test(briefText)) {
        const file = path.join(tmpdir(), 'whale-shot-' + Date.now() + '.png')
        const shot = await screenshot(file, bcfg)
        if (!shot.ok) {
          await this.#say(event.scope, event, ['截图失败：' + (shot.error || '未知原因')], started)
          return { ok: false, stage: 'screenshot', event }
        }
        try {
          await this.channel.sendImage(event.scope, event.scope === 'group' ? event.payload?.groupId : event.from, file)
          return { ok: true, stage: 'screenshot', event }
        } catch (error) {
          await this.#say(event.scope, event, ['截图发出失败：' + String(error?.message || error).slice(0, 80)], started)
          return { ok: false, stage: 'screenshot', event }
        }
      }
      if (/^(关浏览器|关闭浏览器)/.test(briefText)) {
        await closeSession()
        await this.#say(event.scope, event, ['浏览器关了'], started)
        return { ok: true, stage: 'browser_close', event }
      }
      if (/^(提醒列表|我的提醒|查看提醒)/.test(briefText) && this.runtime.reminders) {
        const rows = this.runtime.reminders.list().filter((item) => !item.to || item.to === event.from)
        const text = rows.length
          ? ['还没到点的提醒：', ...rows.map((item) => `- ${new Date(item.at).toLocaleString('zh-CN', { hour12: false })}：${item.text}`)].join('\n')
          : '现在没有未到点的提醒。'
        await this.#say(event.scope, event, [text], started)
        return { ok: true, stage: 'reminder_list', event }
      }
      if (/^(取消提醒|清空提醒|取消全部提醒)/.test(briefText) && this.runtime.reminders) {
        const count = this.runtime.reminders.cancelAll(event.from)
        await this.#say(event.scope, event, [count ? `取消了 ${count} 条提醒` : '没有可取消的提醒'], started)
        return { ok: true, stage: 'reminder_cancel', event }
      }
      if (/^(简报|今日简报|今天简报)/.test(briefText) && typeof this.runtime.dailyDigest === 'function') {
        const sent = await this.#say(event.scope, event, [this.runtime.dailyDigest()], started)
        this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'digest', ok: sent.ok, lines: sent.lines, tool: 'care.digest' })
        return { ok: true, stage: 'digest', event }
      }
      const tuneText = String(event.payload?.text || '').trim()
      const tune = /短一点|简短点/.test(tuneText)
        ? { key: 'persona.maxReplyChars', value: 12, text: '好，以后说话短一点' }
        : /长一点|多说点/.test(tuneText)
          ? { key: 'persona.maxReplyChars', value: 40, text: '好，以后说话长一点' }
          : /少分几条|少说几条/.test(tuneText)
            ? { key: 'persona.maxParts', value: 1, text: '好，以后尽量一条说完' }
            : /多分几条|多说几条/.test(tuneText)
              ? { key: 'persona.maxParts', value: 4, text: '好，以后可以多分几条' }
              : null
      if (tune && typeof this.runtime.setConfig === 'function') {
        const selfCfg = this.runtime.config.self || {}
        if (selfCfg.enabled === false) {
          await this.#say(event.scope, event, ['我现在不能自己改自己'], started)
          return { ok: true, stage: 'self_tune_blocked', event }
        }
        const cooldownHours = Number(selfCfg.rewriteCooldownHours) || 0
        const stateFile = path.join(this.runtime.dir || '', 'self-state.json')
        let lastAt = 0
        try { lastAt = Number(JSON.parse(readFileSync(stateFile, 'utf8')).lastAt) || 0 } catch {}
        if (cooldownHours > 0 && Date.now() - lastAt < cooldownHours * 3_600_000) {
          await this.#say(event.scope, event, ['刚改过，过一会儿再说'], started)
          return { ok: true, stage: 'self_tune_cooldown', event }
        }
        const result = this.runtime.setConfig(tune.key, tune.value, { confirm: false })
        if (result.ok) {
          try { writeJson(stateFile, { lastAt: Date.now() }) } catch {}
          const sent = await this.#say(event.scope, event, [tune.text], started)
          this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'self_tune', ok: sent.ok, lines: sent.lines })
          return { ok: true, stage: 'self_tune', text: tune.text, event }
        }
      }
      const rawText = String(event.payload?.text || '')
      if (/发个表情|发表情/.test(rawText)) {
        const mood = rawText.replace(/^.*?(?:发个表情|发表情)/, '').replace(/^[，,：:\s]+/, '').trim()
        const result = this.tools ? await this.tools.call('send_sticker', { mood }, toolCtx) : null
        if (result?.ok) {
          this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'sticker', ok: true, lines: 1, tool: 'media.sticker' })
          return { ok: true, stage: 'sticker', event }
        }
        await this.#say(event.scope, event, [result?.error || '表情没发出去'], started)
        return { ok: false, stage: 'sticker', event }
      }
      if (/^(看看收藏|表情收藏|收藏列表|表情包列表|表情列表|看看表情包)$/.test(rawText.trim())) {
        const result = this.tools ? await this.tools.call('list_stickers', {}, toolCtx) : null
        await this.#say(event.scope, event, [result?.ok ? result.text : '表情库读不出来'], started)
        return { ok: true, stage: 'sticker_list', event }
      }
      if (/收藏.*表情|存表情/.test(rawText)) {
        const tags = rawText.replace(/^.*?(?:表情)/, '').replace(/^[，,：:\s]+/, '').replace(/^标签(?:是|为)?[：:\s]*/, '').trim()
        const result = this.tools ? await this.tools.call('save_sticker', { tags }, toolCtx) : null
        await this.#say(event.scope, event, [result?.ok ? result.text : (result?.error || '没存成')], started)
        return { ok: result?.ok === true, stage: 'sticker_collect', event }
      }
      const reminded = parseReminder(event.payload?.text || '', this.now())
      if (reminded && this.runtime.reminders) {
        const added = this.runtime.reminders.add({ at: reminded.at, text: reminded.text, to: event.from })
        if (added.ok) {
          const minutes = Math.max(1, Math.round(reminded.ms / 60_000))
          const sent = await this.#say(event.scope, event, [`好，${minutes >= 60 ? Math.round(minutes / 60) + ' 小时' : minutes + ' 分钟'}后提醒你：${reminded.text}`], started)
          this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'reminder', ok: sent.ok, lines: sent.lines, tool: 'care.remind' })
          return { ok: true, stage: 'reminder', text: reminded.text, event }
        }
      }
      const direct = memoryCommand(event.payload?.text || '', this.runtime.memory)
      if (direct) {
        const sent = await this.#say(event.scope, event, [direct.text], started)
        this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'memory_command', ok: sent.ok, lines: sent.lines })
        return { ok: true, stage: 'memory', text: direct.text, event }
      }
    }

    if (decision.trigger === 'follow_up') {
      const chance = Math.max(0, Math.min(100, Number(this.runtime.config.group?.followUpChance) || 0))
      if (chance < 100 && Math.random() * 100 >= chance) {
        this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'follow_up_skip', ok: false, reason: '接话概率没中' })
        return { ok: true, skipped: true, reason: '接话概率没中', event }
      }
    }
    if (decision.trigger === 'follow_up' && typeof this.runtime.canFollowUp === 'function' && !this.runtime.canFollowUp(event.conversation)) {
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'follow_up_limit', ok: false, reason: '连续对话轮数到上限' })
      return { ok: true, skipped: true, reason: '连续对话轮数到上限', event }
    }

    const gate = this.guard.check(at, { event })
    if (!gate.ok) {
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: gate.why, ok: false, reason: gate.text })
      await this.#notifyHold(event, gate, at)
      return { ok: true, skipped: true, reason: gate.text, event }
    }

    const scope = event.scope
    const options = this.runtime.styleOptions(scope)
    try {
      if (this.runtime.memory && event.from) this.runtime.memory.rememberPerson(event.from, { name: event.sender || event.payload?.senderName || '' })
      const text = String(event.payload?.text || '').trim()
      if (this.runtime.memory && event.scope === 'private' && event.tags?.includes('is_owner') && /^记住[，,：:]?/.test(text)) {
        this.runtime.memory.rememberFact(text.replace(/^记住[，,：:]?\s*/, ''), { source: 'owner' })
      }
      if (this.runtime.memory && event.scope === 'group' && event.payload?.groupId && text) {
        this.runtime.memory.rememberGroup(event.payload.groupId, {
          label: event.payload.groupName || event.group || '',
          topic: text,
        })
      }
    } catch {}
    let search = []
    const userText = String(event.payload?.text || '').trim()
    const link = (userText.match(/https?:\/\/\S+/) || [])[0]
    if (link) {
      try {
        const page = await readWeb(link)
        if (page.ok) search = [`${page.title ? page.title + '：' : ''}${page.text}`]
      } catch {}
    }
    if (!search.length && /(搜一下|搜索|查一下|查查|最新|新闻|天气|发生什么)/.test(userText)) {
      try {
        search = await searchWeb(userText)
      } catch {}
    }
    let quote = null
    const replyId = String(event.payload?.replyId || '')
    if (replyId && this.channel && typeof this.channel.getMessage === 'function') {
      try {
        quote = await this.channel.getMessage(replyId)
      } catch (error) {
        quote = { ok: false, error: String(error?.message || error) }
      }
      // get_msg 取不到（消息太旧/协议端不支持/返回空）时退回 reply 段里的摘要。
      // 没有这层兜底，引用会在提示词里静默消失 —— 旧版踩过，这次不能丢。
      if (!quote || (!quote.text && !(quote.images?.length) && !quote.forwardId)) {
        const summary = String(event.payload?.replySummary || '').trim()
        // 取不到原文本身要留痕：否则「引用丢了」永远查不到原因
        if (quote && quote.ok === false) {
          this.runtime.log('quote_failed', { eventId: event.id, replyId, error: String(quote.error || '').slice(0, 160), hasSummary: !!summary })
        }
        if (summary) {
          quote = { text: summary, sender: '', images: [], summary: true }
        }
      }
    } else if (String(event.payload?.replySummary || '').trim()) {
      // 少数协议端只给摘要、不给 id：也算一条引用
      quote = { text: String(event.payload.replySummary).trim(), sender: '', images: [], summary: true }
    }
    // 引用里如果是转发，也要把被引用那段展开（旧版只能展开直接发的转发）
    if (quote?.forwardId && this.channel && typeof this.channel.getForward === 'function') {
      try { quote.forward = await this.channel.getForward(quote.forwardId, 10) } catch {}
    }
    if (quote && !quote.text && !(quote.images?.length) && !quote.forwardId && !(quote.forward?.length)) quote = null
    let forwardAll = []
    if (event.payload?.forwardId && this.channel && typeof this.channel.getForward === 'function') {
      try { forwardAll = await this.channel.getForward(event.payload.forwardId, 30) } catch {}
    }
    if (!forwardAll.length && Array.isArray(quote?.forward)) forwardAll = quote.forward
    toolCtx.forwardAll = forwardAll
    toolCtx.quote = quote

    // 文本文件：只读前 1000 字，超 1MB 直接不读。
    // 读文件是「顺手看一眼」，不是「把整个附件搬进上下文」。
    const files = []
    for (const item of (event.payload?.files || []).slice(0, 3)) {
      const name = String(item.name || item.file || '文件')
      const ext = (name.split('.').pop() || '').toLowerCase()
      if (!/^(txt|md|log|json|csv|yml|yaml|ini|conf)$/.test(ext)) {
        files.push({ name, note: '不是文本格式，没有展开' })
        continue
      }
      if (Number(item.size) > 1_048_576) {
        files.push({ name, note: '文件太大（超过 1MB），没有整份读' })
        continue
      }
      let text = ''
      try {
        if (!this.channel || typeof this.channel.fileUrl !== 'function') {
          files.push({ name, note: '通道读不了文件' })
          continue
        }
        const got = await this.channel.fileUrl({ fileId: item.file, groupId: event.payload?.groupId, userId: event.from, busid: item.busid })
        if (got.base64) text = Buffer.from(got.base64, 'base64').toString('utf8')
        else if (got.file && existsSync(got.file)) text = readFileSync(got.file, 'utf8')
        else if (got.url) {
          const res = await fetch(got.url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12_000) })
          if (res.ok) text = Buffer.from(await res.arrayBuffer()).toString('utf8')
        }
      } catch {}
      files.push(text ? { name, text: text.slice(0, 1000) } : { name, note: '读取失败' })
    }
    toolCtx.files = files
    const forward = forwardAll.slice(0, 5)

    let vision = ''
    const images = [...(event.payload?.images || []), ...(quote?.images || [])].slice(0, Math.max(1, Number(this.runtime.config.images?.maxPerMessage) || 2))
    if (images.length && typeof this.runtime.describeImageFile === 'function') {
      const parts = []
      for (const image of images) {
        let resolved = null
        try {
          resolved = await resolveImageFile(image, this.channel, this.runtime.config.images?.maxBytes)
          if (!resolved.ok) continue
          const seen = await this.runtime.describeImageFile(resolved.file, userText || '描述这张图，并给最多 5 个标签。')
          if (seen.ok) parts.push(seen.text)
        } catch {} finally {
          if (resolved?.temp) { try { unlinkSync(resolved.file) } catch {} }
        }
      }
      vision = parts.map((text, index) => `图${index + 1}：${text}`).join('\n')
    }
    if (vision) {
      this.visionNotes.set(event.id, vision)
      while (this.visionNotes.size > 60) this.visionNotes.delete(this.visionNotes.keys().next().value)
    }
    // 内联指令（[face:1] / [表情:标签]）走的是发送层，不是工具表 ——
    // 所以技能开关必须在**这里**再判一次，否则关掉照样发得出去。
    const allowFace = this.#allows('send_face')
    const allowSticker = this.#allows('send_sticker')
    let prompt = buildPrompt({
      event,
      allowFace,
      persona: { ...(this.runtime.config.persona || {}), ownerName: this.runtime.config.identity?.ownerName || '' },
      styleGuide: this.runtime.styleGuide(scope),
      recent: this.#recent(event),
      search,
      vision,
      quote,
      forward,
      files,
      emptyAt: event.tags?.includes('at_me') && !userText && !(event.payload?.images || []).length && !files.length,
      toolLine: this.tools && typeof this.tools.prompt === 'function' ? this.tools.prompt() : '',
      memory: this.runtime.memory
        ? this.runtime.memory.digest({ forUser: event.from, query: event.payload?.text || '', groupId: event.payload?.groupId || '' })
        : null,
    })

    let result
    try {
      result = await this.runner(prompt, { event, conversation: event.conversation, onThought: (text) => this.runtime.noteThought?.({ conversation: event.conversation, text }) })
    } catch (error) {
      const message = String(error?.message || error)
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'runner_error', ok: false, reason: message, ms: this.now() - started })
      this.runtime.log('turn_failed', { conversation: event.conversation, error: message })
      // 失败也要说一句：静默失败会让人以为「他/她不搭理我」
      await this.#say(scope, event, card({ error: message }), started)
      return { ok: false, stage: 'generate', error: message, event }
    }

    // 工具环：模型用 [tool:名称] {...} 请求，执行后把结果喂回去。
    // 一轮可以写多行 —— 「先搜再记」「同时发表情和 @ 人」这种一件事多步的活，
    // 以前只执行第一行、其余静默丢掉，模型看到的只是「工具没生效」。
    const maxRounds = Math.max(1, Math.min(6, Number(this.runtime.config.tools?.maxRounds) || 2))
    const maxPerRound = Math.max(1, Math.min(8, Number(this.runtime.config.tools?.maxPerRound) || 4))
    let lastToolResult = null
    // 这一次推理先不记账：要等看清它「是为了调工具」还是「是为了回话」才能归到正确的档。
    // 以前这里是「整轮跑完把用量加一起记一笔」，于是账本只有一个总数 ——
    // 想知道「联网搜索花了多少、沙箱花了多少」时，答案永远是「查不出来」。
    let pending = result
    // 上一批工具。这次推理要是在读它们的结果，那这笔开销就该记在它们名下。
    let pendingSources = []
    for (let round = 0; round < maxRounds && this.tools; round += 1) {
      const body = String(pending?.text || '')
      const calls = parseToolCalls(body)
      if (!calls.length) {
        this.#spend(pending, this.#causeSource(pendingSources), event)
        pending = null
        if (round === 0 && /(查一?下|搜一?下|搜索|打开|看看|收藏|发一?个|发出来|提醒|截图|运行|读一下|记住|上次|以前)/.test(userText)) {
          const pick = await this.runner('用户要求你做事：' + userText + '\n你刚才只说了：' + body + '\n现在只输出工具调用行，一行一个：[tool:工具名] {"参数":"值"}，要多步就写多行。' + (this.tools.prompt?.() || '') + '不需要工具就只输出 [none]。', { event, conversation: event.conversation })
          if (pick?.text && /\[tool:/.test(pick.text)) {
            pending = pick
            continue
          }
          // 没挑出工具也是一次真花钱的推理，而且目的就是「找工具」——
          // 记进对话会让对话的数字虚高，工具那档永远偏低。
          this.#spend(pick, 'tool', event)
        }
        break
      }
      const picked = calls.slice(0, maxPerRound)
      if (calls.length > picked.length) {
        // 超出的不执行，但要留痕：不记的话「模型写了 8 个、只跑了 4 个」永远查不出来
        this.runtime.log('tool_batch_truncated', {
          conversation: event.conversation,
          wanted: calls.length,
          ran: picked.length,
          dropped: calls.slice(picked.length).map((call) => call.name).join(','),
        })
      }
      // 这次推理是为了「调这几个工具」：按调用数把用量摊开，每项自己带一份。
      // 摊开而不是复制到每一项：复制会让各项相加是总数的三倍，账单立刻失真。
      const shares = splitUsage(pending?.usage, picked.length)
      const sources = picked.map((call) => usageSourceOfTool(call.name))
      picked.forEach((call, index) => this.#spendShare(shares[index], sources[index], pending, event, index === 0))
      lastToolResult = pending
      const results = []
      for (const [index, call] of picked.entries()) {
        // 思维链先于工具调用：为什么调、调什么、这一步花了多少 token，先落一条再执行
        const detail = String(call.args.query ?? call.args.text ?? '').trim().slice(0, 40)
        this.#logCot(pending, event, 'tool', `调用 ${call.name}${detail ? '：' + detail : ''}`, [`${call.name}：${String(call.raw || '').slice(0, 160)}`], {
          source: sources[index],
          tokens: shares[index],
        })
        let called
        if (call.invalid) {
          // 参数没解析出来也要执行：工具自己会说「要什么参数」，比这里编一句更准
          this.runtime.log('tool_args_invalid', { conversation: event.conversation, tool: call.name })
        }
        called = await Promise.resolve(this.tools.call(call.name, call.args, { ...toolCtx, byModel: true }))
          .catch((error) => ({ ok: false, error: String(error?.message || error) }))
        // 记一笔：这是「技能级别的证据」唯一来源。
        // 以前工具环只执行不记账，于是「知道」那组永远显示「没试过」——
        // 不是没读对，是根本没人写。outcome 会把工具名翻成技能 id 再累加。
        this.runtime.outcome({
          eventId: event.id,
          behavior: decision.behavior,
          trigger: 'tool',
          ok: called?.ok !== false,
          lines: 0,
          tool: call.name,
          reason: called?.ok === false ? String(called.error || '').slice(0, 120) : '',
        })
        results.push({ call, called })
      }
      // 一串调用的结果一次性回灌：分几次问会让模型以为「上一件事还没做完」。
      const digest = results
        .map(({ call, called }, index) => `${index + 1}. ${call.name}(${String(call.raw || '').replace(/\s+/g, ' ').slice(0, 120)}) → ${JSON.stringify(called).slice(0, 1800)}`)
        .join('\n')
      prompt += `\n\n你刚调用了 ${results.length} 个工具，按顺序执行的结果如下：\n${digest}\n请根据结果继续；还要动手就再输出工具调用行（可以多行），否则直接给最终回复。`
      const next = await this.runner(prompt, { event, conversation: event.conversation, onThought: (text) => this.runtime.noteThought?.({ conversation: event.conversation, text }) })
      pending = next
      pendingSources = sources
      result = next
    }
    // 轮数用完了还有一次没记账的推理：它读的是最后那批工具的结果，就还记在它们名下。
    if (pending) {
      this.#spend(pending, this.#causeSource(pendingSources), event)
      pending = null
    }

    let text = String(result?.text || '').trim()
    // 清掉没执行完的工具标记行（连同同一行后面残留的解释），别让用户看见 [tool:…]
    text = text.replace(/\[tool:[^\]\n]*\][^\n]*/g, '').trim()
    let stickerWanted = false
    let stickerTag = ''
    const stickerMark = text.match(/\[表情(?::([^\]]+))?\]/)
    if (stickerMark) {
      stickerWanted = true
      stickerTag = String(stickerMark[1] || '').trim()
      text = text.replace(stickerMark[0], '').trim()
    }
    // 技能关掉 = 真的不发。这两条内联指令绕过了 tools.call，
    // 之前「发小黄脸」关着还能发出去，就是因为判定只做在工具那一层。
    const suppressed = []
    if (!allowFace && /\[face:\d+\]/.test(text)) {
      text = text.replace(/\[face:\d+\]/g, '').replace(/[ \t]{2,}/g, ' ').trim()
      suppressed.push('media.face')
    }
    if (stickerWanted && !allowSticker) {
      stickerWanted = false
      stickerTag = ''
      suppressed.push('media.sticker')
    }
    if (suppressed.length) {
      this.runtime.log('media_suppressed', { conversation: event.conversation, skills: suppressed, why: '这两项被关掉了，内联指令不执行' })
    }
    // 思维链先于回复：最后一轮的思考在「发出去」之前落盘；
    // 若这一轮已经作为工具调用记过，就不重复记成 reply。
    if (result && result !== lastToolResult) {
      this.#logCot(result, event, 'reply', result.text, [])
    }
    // 账已经在每一次推理落地时按来源记过了（#spend / #spendShare）。
    // 这里再记一次总额就等于把同一笔钱记两遍 —— 以前正是「整轮加一起记一笔」，
    // 所以既算不准来源，也说不清「这一轮问了几次模型」。

    if (!text && !stickerWanted) {
      // 只剩一个被关掉的表情时，说「模型没给内容」是错的 ——
      // 模型给了，是那一项被关了。两种空回复的处置方式完全不同。
      const reason = suppressed.length ? `只说了一个表情，而「${suppressed.includes('media.face') ? '发小黄脸' : '发表情'}」被关掉了` : '模型没给内容'
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'empty', ok: false, reason, ms: this.now() - started })
      return { ok: false, stage: 'empty', error: reason, event }
    }

    // 模型自己写的 [split]：意思是「这两句要分开说」，不是同一条里的一口气。
    // 自己拆的段之间留的缝比机器切的大（见 lib/typing.mjs），手感差别就在这儿。
    const marked = String(text || '')
    const selfSplit = /\[split\]/i.test(marked)
    const segments = selfSplit
      ? marked.split(/\[split\]/i).map((one) => one.trim()).filter(Boolean).slice(0, 2)
      : [marked]
    const parts = []
    for (const segment of segments) {
      for (const piece of splitReply(segment, { maxParts: options.maxParts, partChars: options.partChars })) parts.push(piece)
    }
    if (!parts.length) {
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'empty', ok: false, reason: '拆完没有可发的内容' })
      return { ok: false, stage: 'empty', error: '拆完没有可发的内容', event }
    }
    const sent = await this.#say(scope, event, parts, started, { selfSplit })
    if (stickerWanted && this.channel && typeof this.channel.sendImage === 'function') {
      try {
        const dirs = [path.join(this.runtime.dir || '', 'stickers'), path.join(homedir(), '.dsh', 'qq-fish', 'stickers')]
        for (const dir of dirs) {
          let idx = []
          try { idx = JSON.parse(readFileSync(path.join(dir, 'index.json'), 'utf8')).items || [] } catch {}
          const match = stickerTag
            ? idx.find((item) => item.file && (item.labels || []).some((label) => String(label).includes(stickerTag)))
            : idx[Math.floor(Math.random() * Math.max(1, idx.length))]
          if (match) {
            await this.channel.sendImage(scope, scope === 'group' ? event.payload?.groupId : event.from, path.join(dir, match.file))
            break
          }
        }
      } catch {}
    }

    this.runtime.outcome({
      eventId: event.id,
      behavior: decision.behavior,
      trigger: decision.trigger,
      ok: sent.ok,
      lines: sent.lines,
      ms: this.now() - started,
      reason: sent.error || '',
      tool: search.length ? 'net.search' : '',
    })

    if (sent.ok) {
      const direct = (event.tags || []).some((tag) => ['at_me', 'mentioned_name', 'called'].includes(tag)) || decision.trigger === 'interest'
      this.runtime.markActive(event.conversation, undefined, direct)
      // 注意力账本跟着更新：说出去的话要留一句（换人判定拿它比重合），
      // 窗口要么续一轮、要么开一个新的。这一步失败不该影响已经发出去的回复。
      try {
        this.attention?.noteReply({
          conversation: event.conversation,
          from: event.from,
          scope,
          text: parts.join(' '),
        })
      } catch (error) {
        this.log('[whale] 注意力账本没更新：' + String(error?.message || error))
      }
    }
    return { ok: sent.ok, event, parts, lines: sent.lines, ms: this.now() - started, error: sent.error }
  }

  /**
   * 这一项现在能不能用 —— 和 tools.call() 同一套判定，但不执行。
   *
   * 用途有两个：提示词里教不教、回复里的内联指令认不认。
   * 「教了却调不到」是最坏的一种：模型会反复重试，用户只看到它在瞎忙。
   */
  #allows(tool) {
    try {
      if (!this.tools || typeof this.tools.has !== 'function') return false
      if (!this.tools.has(tool)) return false
      // 白名单也要算：「允许调用的工具」里没写它，调了也是白调
      const list = this.runtime?.config?.tools?.whitelist
      if (Array.isArray(list) && list.length && !list.includes(tool)) return false
      const blocked = this.runtime?.blockedTools?.()
      return !(blocked instanceof Set && blocked.has(tool))
    } catch {
      // 判定失败就当能用：宁可多发一个表情，也不能让整轮回复因为一张开关表发不出去
      return true
    }
  }

  /**
   * 思维链落盘。调用位置比写法更重要：
   * 工具调用前写一次，回复发出前写一次 —— 顺序反了，面板上就成了先看到话、后看到想。
   * 模型这一轮没给 reasoning 也要留一条（如实标注），不能因为「没什么可写」就跳过。
   */
  #logCot(result, event, kind, summary, steps, extra = {}) {
    if (!result || typeof this.runtime.logCot !== 'function') return
    const reasoning = String(result.reasoning || '').trim()
    const fallback = String(summary || '').trim()
    const text = reasoning || (kind === 'reply' ? '（这一轮没有单独输出思考过程，直接回复）' : fallback)
    if (!text) return
    // 这一步花了多少：调用方摊过就用手上的那份，没摊就整笔算 —— 两种都要能读，
    // 因为工具那一批是「一次推理摊给多个调用」，回复那条是「一次推理就是一条」。
    const spent = extra.tokens || result.usage
    this.runtime.logCot({
      at: this.now(),
      conversation: event.conversation,
      from: event.from,
      kind,
      text,
      summary: String(summary || result.text || '').slice(0, 160),
      steps: Array.isArray(steps) ? steps : [],
      source: String(extra.source || ''),
      tokens: spent ? { input: Number(spent.input) || 0, output: Number(spent.output) || 0 } : null,
    })
  }

  /**
   * 一次推理的账，按来源记。
   *
   * 记账点必须贴着模型调用走，不能等到一轮结束再补：
   * 一轮里可能问了三四次模型，来源还不一样，事后想从文本里反推是推不出来的。
   */
  #spend(result, source, event) {
    const spent = result?.usage
    if (!spent) return null
    const input = Math.max(0, Number(spent.input) || 0)
    const output = Math.max(0, Number(spent.output) || 0)
    // 0/0 不记：宿主偶尔回一个空用量，记成一次调用会让「调用次数」虚高
    if (!input && !output) return null
    const payload = { input, output }
    this.usage?.record?.(input, output, {
      at: this.now(),
      model: result?.model || '',
      conversation: event?.conversation || '',
      source,
    })
    return payload
  }

  /** 摊开后的那一份（工具批里的一项） */
  #spendShare(share, source, result, event, isFirst = false) {
    const input = Math.max(0, Number(share?.input) || 0)
    const output = Math.max(0, Number(share?.output) || 0)
    if (!input && !output) return
    this.usage?.record?.(input, output, {
      at: this.now(),
      model: result?.model || '',
      conversation: event?.conversation || '',
      source,
      // 一批工具来自同一次推理：次数记在第一项上，其余记 0
      calls: isFirst ? 1 : 0,
    })
  }

  /**
   * 「这次推理是为谁服务的」。
   * 一批工具里混了搜索和沙箱时，归不出唯一来源 —— 记成「工具调用」这档综合值，
   * 而不是随手挑一个：挑错了就再也发现不了，而「工具调用」至少不会把账算到别人头上。
   */
  #causeSource(sources = []) {
    const unique = new Set(sources.filter(Boolean))
    if (unique.size === 1) return [...unique][0]
    if (unique.size === 0) return 'chat'
    return 'tool'
  }

  /**
   * 发出去。
   * 每条都过 runtime.outbound：截断、防空、脱敏都在那里，
   * 通道自己不许拼字符串 ——「出站必过 say」这句话只有在结构上成立才算数。
   */
  /**
   * 主人问过来、却被闸门拦住时，说一句「我为什么没回」。
   *
   * 为什么必须有它：**沉默是最难排查的故障。**
   * 通道在线、消息收得到、面板一切正常，就是对面不答话 —— 日志里躺着 `per_hour`，
   * 可人只看得见一个没有回声的对话框，唯一能想到的办法是重启。
   * 说一句原因，人立刻知道发生了什么，还能顺手把额度调大。
   *
   * 三条克制：
   *   1. 只对主人说。别人被限流，安静就是正确反应，多说一句反而是打扰；
   *   2. 同一会话一小时最多一次 —— 否则它自己成了新的刷屏源，还占额度；
   *   3. 不再过一遍限流（直接走通道），否则「说明为什么被拦」会再被拦一次，
   *      两句话互相锁死，最后仍然是沉默。
   */
  async #notifyHold(event, gate, at) {
    try {
      if (!this.channel || typeof this.channel.say !== 'function') return
      const ownerId = String(this.runtime?.config?.identity?.ownerId || '')
      if (!ownerId || String(event.from || '') !== ownerId) return
      const last = Number(this.holdNotices.get(event.conversation) || 0)
      if (last && at - last < NOTIFY_GAP_MS) return

      const line = gate.why === 'per_minute'
        ? '刚才这一分钟我说得太密了，怕被当成刷屏，先停几秒再回你。'
        : '我这边有个闸门把这条话拦住了（' + String(gate.text || gate.why || '限流') + '）。'
      this.holdNotices.set(event.conversation, at)
      const target = event.scope === 'group' ? event.payload?.groupId : event.from
      if (!target) return
      await this.channel.say(event.scope, target, this.runtime?.outbound ? this.runtime.outbound(card({ line }), 'qq') : line)
      // 发出去的话也是这段对话的一半：不记的话界面里只剩主人在自言自语
      this.runtime.noteSelfMessage?.({ conversation: event.conversation, scope: event.scope, text: line, at })
    } catch {
      // 说明失败就算了 —— 它本来就只是为了不再沉默，不该反过来把流程搞挂
    }
  }

  async #say(scope, event, content, started, options = {}) {
    const parts = Array.isArray(content) ? content : [content]
    const target = scope === 'group' ? event.payload?.groupId : event.from
    if (!target) return { ok: false, lines: 0, error: '不知道发给谁' }

    // 先把每一段渲染成文字，再交给打字台按人的节奏发。
    // 渲染与节奏分开，是为了「文案错了」和「节奏错了」不互相掩盖：
    // 以前两件事挤在一个循环里，分条发成一条时，查了半天才发现是空串被吞了。
    const texts = []
    for (const part of parts) {
      // 字符串先包成卡片再出站：出站口只认卡片，通道不许自己拼句子
      const view = typeof part === 'string' ? card({ line: part }) : part
      const text = String(this.runtime.outbound(view, 'qq') || '')
      if (text.trim()) texts.push(text)
    }
    if (!texts.length) return { ok: true, lines: 0, error: '' }

    // 发出去的话也是这段对话的一半。不记的话，QQ 界面里只剩对方在自说自话，
    // 拼上下文时也读不到自己上一句 —— 两处都会「看起来正常，其实缺了一半」。
    const note = (text) => {
      this.guard.note(this.now())
      this.runtime.noteSelfMessage?.({ conversation: event.conversation, scope, text, at: this.now() })
    }

    // 有打字台就走人的节奏：单线程排队 → 亮「正在输入」→ 按字数等 → 分条留缝。
    // 没有（用例、或宿主没装配）就退回旧路径，行为与以前一致，绝不因为新模块缺席而发不出去。
    if (this.typing && typeof this.typing.typeOut === 'function') {
      const result = await this.typing.typeOut({
        parts: texts,
        scope,
        target,
        // 会话键：认领 #respond 开头提前亮过的「正在输入」，避免同一句话亮两次
        key: event.conversation,
        // 生成 + 工具环已经花掉的时间。打字台会把它从等待里扣掉 ——
        // 不扣的话，长回复要等「模型想完」再「按字数等一遍」，两段相加像掉线
        elapsedMs: Math.max(0, this.now() - (Number(started) || this.now())),
        selfSplit: options.selfSplit === true,
        pace: () => this.guard.delay(this.now()),
        say: async (text) => {
          await this.channel.say(scope, target, text)
          note(text)
        },
      })
      return { ok: result.ok, lines: result.lines, error: result.error || '' }
    }

    let lines = 0
    for (const text of texts) {
      const wait = this.guard.delay(this.now())
      if (wait > 0) await this.sleep(wait)
      try {
        if (this.channel) await this.channel.say(scope, target, text)
      } catch (error) {
        return { ok: false, lines, error: String(error?.message || error) }
      }
      note(text)
      lines += 1
    }
    return { ok: true, lines, error: '' }
  }
}
