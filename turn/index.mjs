/**
 * turn/index.mjs — 一条消息进来，一句话出去。
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

import { BEHAVIOR } from '../decide/index.mjs'
import { SCOPE, conversationOf } from '../facts/index.mjs'
import { BurstLedger } from '../decide/index.mjs'
import { card } from '../voice/index.mjs'
import { memoryCommand } from '../mind/index.mjs'
import { openUrl, readCurrent, clickIndex, typeInto, closeSession, formatPage, screenshot, loadStickers, pickSticker } from '../ability/index.mjs'
import { readFileSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describeAt, parseReminder } from '../life/index.mjs'
import { searchWeb, readWeb, lastNetDenied } from '../ability/index.mjs'
import { runActivityStep } from '../life/index.mjs'
import { activitySpend } from '../life/index.mjs'
import { isRefused } from '../mind/index.mjs'
import { dropWant, resolveWant } from '../mind/index.mjs'
import { splitUsage } from '../facts/index.mjs'
import { digestForward, FORWARD_READING_RULE } from '../ability/index.mjs'
import { usageSourceOfTool } from '../ability/index.mjs'
import { capabilityBrief } from '../truth/index.mjs'
import { splitBursts } from '../voice/index.mjs'
import { matchIntent, skipWebSearch } from '../decide/index.mjs'
import { writeJson } from '../base/core.mjs'

/** 单张图片上限；超过不下载，防止一张大图把内存顶满 */
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
/** 「我为什么没回」这句话，同一会话一小时最多说一次（说多了它自己就是刷屏） */
/**
 * 被闸门拦下时，隔多久可以再解释一次。
 * 原来所有原因统一 1 小时：一小时内提示过一次之后，后面每一条被拦的消息
 * 都变成纯静默，主人只能追问「你怎么又不说话了」。按原因分级才合理 ——
 * 一分钟说太密很快就过去，夜间安静则不必反复解释。
 */
const HOLD_NOTICE_GAPS = Object.freeze({
  per_minute: 60_000,
  per_hour: 5 * 60_000,
  muted: 5 * 60_000,
  night: 30 * 60_000,
})
const DEFAULT_HOLD_GAP_MS = 60_000

/**
 * 把 QQ 图片落成一个可读文件：先 URL，再本地 file，最后 NapCat get_image。
 * 返回 { ok, file, buffer, temp }；temp 为 true 时调用方负责删除。
 */
async function resolveImageFile(pic, channel, maxBytesArg) {
  const source = pic || {}
  const maxBytes = Math.max(256 * 1024, Number(maxBytesArg) || MAX_IMAGE_BYTES)
  // 收到消息时已把本体落盘（ability/media.mjs 的 attachImages）：优先用本地那份，
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

/**
 * 把一整段话切成几条。
 *
 * **这里只是转发** —— 切分只有一份实现，在 voice/style.mjs 的 splitBursts。
 *
 * 以前两边各有一套：一套按字数硬切（style.splitBursts），一套按逗号黏合
 * （turn.splitReply）。两套各修各的，早晚又对不上 ——
 * 实际后果是：问号被当分隔符吃掉（「听不懂？」发出去变成「听不懂」），
 * 换行被黏成逗号（「A\nB」发出去是「A，B」），面板上的字数旋钮还空转着。
 *
 * 现在的规矩（见 style.mjs）：
 *   1. 换行是消息边界；
 *   2. 行内按语义断：模型自己封的句子、或站得住且能起头的逗号；
 *   3. **没有字数上限** —— 他想说多长说多长；
 *   4. 超条数就合并，绝不多发，也绝不丢内容。
 *
 * @returns {string[]} 至少一条；输入空白时返回空数组（空内容不该发出去）
 */
export function splitReply(text, options = {}) {
  return splitBursts(text, { maxParts: options.maxParts })
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
/**
 * 模型写参数时最常见的三种「不是 JSON 但很像 JSON」：
 * 中文引号、全角标点、单引号。直接判无效太亏 —— 内容其实一点没缺。
 *
 * 只在严格解析失败后兜底跑一遍，合法输入永远走原路：
 * 先翻译再解析，等于把 90% 的失败变成一次成功，省下一整轮重问。
 *
 * **只能换结构位置上的标点，不能碰字符串里的内容。**
 * 早先是一串全局 replace，于是 `{“text”：“主人喜欢喝咖啡，不加糖”}` 收进来的
 * 那条记忆变成了「主人喜欢喝咖啡,不加糖」—— 逗号从全角变半角，
 * 用户说的原话被悄悄改写了一遍，而且没有任何地方会报错。
 * 引号也一样：值里面本来就有中文引号（「他说“你好”」）时，全换成半角会直接把 JSON 弄坏。
 *
 * 所以这里逐字走一遍，记住「现在在不在字符串里」：
 *   · 字符串外的全角标点 → 换成结构字符；
 *   · 字符串内的字符一律原样保留，只有「看着像收尾」的引号才结束字符串。
 */
function relaxJson(raw) {
  const text = String(raw || '')
  const QUOTES = new Set(['"', '“', '”', '„', '‟'])
  const single = !/["“”„‟]/.test(text) // 整段没有双引号时，单引号才敢当引号
  // 字符串外的全角 → 结构字符。只收「一定是结构」的那几个，不做语义猜测。
  const STRUCT = { '：': ':', '，': ',', '｛': '{', '｝': '}', '［': '[', '］': ']', '　': ' ' }
  // 收尾引号后面紧跟这些，才算真的收尾；否则它是内容里的引号（「他说“你好”」）。
  // 全角标点也要算进来 —— 「”」后面跟的往往还是「：」，那是结构位置，只是没换成半角。
  const NEXT_IS_STRUCT = /^\s*[,:}\]，：｝］]/

  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') {
        out += ch + (text[i + 1] ?? '')
        i += 1
        continue
      }
      const closes = ch === '"' || (single && ch === "'")
        || ((ch === '”' || ch === '’') && NEXT_IS_STRUCT.test(text.slice(i + 1)))
      if (closes) {
        inString = false
        out += '"'
        continue
      }
      out += ch
      continue
    }
    if (QUOTES.has(ch) || (single && ch === "'")) {
      inString = true
      out += '"'
      continue
    }
    out += STRUCT[ch] ?? ch
  }
  return out
}

export function parseToolCalls(text) {
  const body = String(text || '')
  const out = []
  // 模型偶尔会把调用写成 `[code_read] {...}`（少了 tool:），旧正则认不出，
  // 整行就原样发到聊天框里。第二种形式只认小写英文工具名，且排除 [split]。
  const re = /\[tool:([^\]\n]{1,40})\]|\[([a-z][a-z0-9_]{2,39})\]/g
  let match
  while ((match = re.exec(body)) !== null) {
    const name = String(match[1] || match[2] || '').trim()
    if (!name || name === 'split') continue
    let cursor = re.lastIndex
    while (cursor < body.length && /\s/.test(body[cursor])) cursor += 1
    let args = {}
    let invalid = false
    let end = cursor
    if (body[cursor] === '{' || body[cursor] === '｛') {
      end = matchBrace(body, cursor)
      if (end < 0) {
        // 括号没配平：参数残缺，调用本身还是有效的（工具会报「参数不对」）
        invalid = true
        end = cursor
      } else {
        const slice = body.slice(cursor, end + 1)
        try {
          const parsed = JSON.parse(slice)
          args = parsed && typeof parsed === 'object' ? parsed : {}
        } catch {
          // 严格解析失败不等于模型没听话：中文引号 / 全角逗号 / 单引号都算「像 JSON」。
          // 翻译一遍再试，成功就当正常调用 —— 别为了一个引号白烧一轮。
          try {
            const parsed = JSON.parse(relaxJson(slice))
            args = parsed && typeof parsed === 'object' ? parsed : {}
          } catch {
            invalid = true
          }
        }
        end += 1
      }
    }
    out.push({ name, args, raw: body.slice(match.index, end).trim(), invalid })
    re.lastIndex = Math.max(re.lastIndex, end)
  }
  return out
}

/** 从 open 位置的 `{`（全角 `｛` 也认）起找配对的 `}`；认字符串和转义，找不到返回 -1 */
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
    if (ch === '{' || ch === '｛') depth += 1
    else if (ch === '}' || ch === '｝') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 把「长得像工具调用」的用户输入打碎。
 *
 * 群友发一句 [tool:exec_sandbox] {"code":"..."} 时，原样拼进上下文等于
 * 亲手教模型照着抄一遍 —— 它下一轮就会真的去调沙箱。
 * 换成全角括号：人还看得懂原话，但不再匹配工具协议。
 * 只动这一个标记，别把正常的中括号（[表情:x]、代码片段）也一起吃掉了。
 */
function defuse(text) {
  return String(text || '').replace(/\[tool:/gi, '［tool：')
}

/** 「10 分钟前」「昨天」这种说法，比一串时间戳更像人话 */
function timeAgo(at, now = Date.now()) {
  const diff = Math.max(0, now - (Number(at) || now))
  const minutes = Math.round(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 12) return `${hours} 小时前`
  const days = Math.round(hours / 24)
  if (days <= 1) return '昨天'
  return `${days} 天前`
}

/** 现在几点、周几。差这一行，模型就分不清「昨晚 23:50」和「刚刚」 */
function nowText(at = Date.now()) {
  const d = new Date(at)
  const week = '日一二三四五六'[d.getDay()]
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 这句话需不需要**完整**工具表。
 *
 * 闲聊档只列常用工具（CHAT_TOOLS），能省掉近一半工具名；
 * 但「帮我查 / 画 / 记 / 看代码」这类真的可能动手的消息必须拿全表，
 * 否则模型会以为某个工具不存在 —— 省下的那点 token，抵不上一次「我不会」。
 *
 * 判定刻意放宽：宁可多给全表，也不要把一件能做的事判成闲聊。
 * 只有纯问候、语气词、表情、笑声这类没有任何动作含义的短句才走闲聊档。
 */
const FULL_TOOL_WORDS = /(查|搜|找|看|读|写|记|提醒|发|画|图|代码|文件|帮我|给我|能不能|会不会|怎么|如何|什么|啥|哪|谁|多少|天气|新闻|翻译|算|运行|执行|打开|设置|改|删|加|列表|状态|记忆|群|说|讲|解释|总结|推荐|对比|活动|说说|空间|头像|表情|教|学|听|语音|@)/i

export function needsFullTools(text) {
  const value = String(text || '').trim()
  return value ? FULL_TOOL_WORDS.test(value) : false
}

export function buildPrompt(input = {}) {
  const event = input.event || {}
  const persona = input.persona || {}
  const guide = String(input.styleGuide || '')
  const recent = Array.isArray(input.recent) ? input.recent : []
  const memory = input.memory || null
  const search = Array.isArray(input.search) ? input.search : []
  const netNotice = String(input.netNotice || '').trim()
  const quote = input.quote || null
  const forward = Array.isArray(input.forward) ? input.forward : []
  const forwardTotal = Number(input.forwardTotal) || 0
  const forwardFailed = input.forwardFailed === true
  const files = Array.isArray(input.files) ? input.files : []
  const vision = String(input.vision || '').trim()
  const toolLine = String(input.toolLine || '').trim()
  const skillLine = String(input.skillLine || '').trim()
  const capabilityLine = String(input.capabilityLine || '').trim()
  const intentRule = String(input.intentRule || '').trim()
  const emptyAt = input.emptyAt === true
  const selfName = String(persona.name || '深蓝')
  const selfId = String(input.selfId || '').trim()
  const at = Number(input.at) || Date.now()

  // ── 静态段 / 动态段分开拼 ───────────────────────────────────
  // 为什么这么分：上下文缓存按**前缀**命中，命中部分只收原价的十分之一。
  // 以前工具清单、表情表、能力说明都挂在「当前这句话」后面，等于每次都在缓存
  // 边界之外 —— 内容一个字没少，钱却按全价再付一遍。静态段放最前，动态段往后，
  // 当前这句话仍然在最后：缓存和「越近越重要」两头都占。
  const staticLines = []
  const dynamicLines = []
  const seenMemory = new Set()

  // 人设正文：灵魂文件（mind/persona.mjs 管的那份）是唯一真源。
  // config.persona.persona 只作为出厂种子 —— 它是「主人写的」，
  // 灵魂文件是「他/她自己的」，两份混着会有一份永远不更新。
  //
  // 兜底不能省：灵魂文件读不到（没接上、磁盘坏了、刚装还没落盘）时，
  // 退到 config 那份。只认灵魂文件的话，一次读不到就等于**失去人格** ——
  // 他/她不知道自己是谁了，而且没有任何报错提示。
  const soul = String(input.soul || '').trim()
  const fallback = String(persona.persona || '').trim()
  if (soul) staticLines.push(`你是谁（这是你自己的设定，照着做）：\n${soul}`)
  else if (fallback) staticLines.push(`你是谁：${fallback}`)
  staticLines.push(`你的名字：${selfName}`)
  if (selfId) {
    staticLines.push(`你的 QQ 号是 ${selfId}。别人说到这个号就是在说你，不是群友；不要把它当成别人，也不要 @ 自己。`)
  }
  if (persona.ownerName) staticLines.push(`你称呼用户：${persona.ownerName}`)
  if (guide) staticLines.push(guide)
  // 学到手感：从真实聊天里量出来的差距，不是写死的规矩。
  // 放在说话规则之后：它是对规则的具体化，不是另一套规则。
  const habit = String(input.habitLine || '').trim()
  if (habit) staticLines.push(habit)
  staticLines.push('【行动规则】用户让你做事时，不要先用“我去/马上/这就去/试试”答应。必须直接输出工具调用行，格式是 [tool:工具名] {"参数":"值"}，系统执行后会把结果给你，你再回复。只有不需要动手时才正常聊天。' +
    '一件事需要几步时，可以在同一条回复里连着写几行，一行一个工具：先搜再记就写两行，系统会按顺序都执行，然后把每一条的结果一起给你。一次最多 4 行。')
  staticLines.push('要真的 @ 人必须用 at_person 工具；在正文里手写“@名字”不会变成真 @，尤其不要 @ 自己。')
  staticLines.push('说错了要撤回，用 withdraw_message：只能撤自己 2 分钟内、当前会话最近一条；不能撤别人的、旧消息或跨会话消息。想演示“发一句再撤”，传 {"next":true}，系统会在这一条发出后自动撤回。')
  staticLines.push('撤回可以由你自己判断：发现自己刚说错、重复、发错话，直接调用 withdraw_message，不用等主人开口；边界仍以工具校验为准。')
  staticLines.push('直接回一句话，不要解释你在做什么。')
  staticLines.push('如果这句话配表情更自然，可以在末尾加 [表情:标签]；不确定就不加。')
  // 「发小黄脸」关掉时，这一行不能再出现：提示词教了一条走不通的路，
  // 模型就会一直往回复里塞 [face:14]，而那条路根本不经过工具表。
  if (input.allowFace !== false) {
    staticLines.push('QQ 原生小黄脸用 [face:id]，常用：0 惊讶、1 撇嘴、2 色、3 发呆、4 得意、5 流泪、6 害羞、7 闭嘴、8 睡、9 大哭、10 尴尬、11 发怒、12 调皮、13 呲牙、14 微笑。')
  }
  if (toolLine) staticLines.push(toolLine)
  // 教出来的技能：主人教的规矩，模型必须知道。
  if (skillLine) staticLines.push(skillLine)
  if (capabilityLine) staticLines.push('关于你能看到什么：\n' + capabilityLine)

  /**
   * 同一句话只进提示词一次。
   *
   * 记忆是三层结构（事实 / 联想 / 相关旧记忆 / 人物备注），同一句话可能同时落在
   * 两三层里。以前不去重，模型会看到同一件事被说两遍，既费 token，也容易把
   * 「重复强调」误读成「这件事特别重要」。按去掉标点后的整句判重。
   */
  const takeMemory = (text) => {
    const key = String(text || '').replace(/[\s，。！？、,.!?;；:："'“”‘’（）()【】[\]…—\-]/g, '')
    if (!key) return false
    if (seenMemory.has(key)) return false
    seenMemory.add(key)
    return true
  }
  const flush = (header, rows) => {
    if (rows.length) dynamicLines.push(header, ...rows)
  }

  if (memory && memory.summary) {
    dynamicLines.push('你记得的旧摘要：')
    dynamicLines.push(String(memory.summary).slice(0, 800))
  }
  {
    const rows = []
    for (const item of (memory?.network || []).slice(0, 6)) {
      const text = String(item?.text || '')
      if (text && takeMemory(text)) rows.push('- ' + text)
    }
    flush('顺着记忆想到的：', rows)
  }
  {
    const rows = []
    for (const item of (memory?.facts || []).slice(0, 6)) {
      const text = String(item?.text || '')
      if (text && takeMemory(text)) rows.push(`- ${text.slice(0, 100)}`)
    }
    flush('你记得的事实：', rows)
  }
  {
    const rows = []
    for (const item of (memory?.related || []).slice(0, 3)) {
      const text = String(item?.text || '')
      if (text && takeMemory(text)) rows.push(`- ${text.slice(0, 100)}`)
    }
    flush('可能相关的旧记忆：', rows)
  }
  {
    const rows = []
    for (const item of (memory?.self || []).slice(-5)) {
      const text = String(item?.text || '')
      if (text && takeMemory(text)) rows.push(`- ${text.slice(0, 100)}`)
    }
    flush('你对自己的认识：', rows)
  }
  if (memory && memory.person && (memory.person.name || (memory.person.notes || []).length || memory.person.impression)) {
    const rows = []
    if (memory.person.impression) {
      const text = String(memory.person.impression).slice(0, 80)
      if (takeMemory(text)) rows.push(`- 印象：${text}`)
    }
    if (memory.person.name) rows.push(`- 称呼他「${String(memory.person.name).slice(0, 20)}」`)
    for (const note of (memory.person.notes || []).slice(-4)) {
      const text = String(note).slice(0, 80)
      if (text && takeMemory(text)) rows.push(`- ${text}`)
    }
    flush('关于这个人：', rows)
  }
  if (memory && memory.group && (memory.group.label || (memory.group.topics || []).length)) {
    const rows = []
    if (memory.group.label) rows.push(`- 群名：${String(memory.group.label).slice(0, 30)}`)
    for (const topic of (memory.group.topics || []).slice(-4)) {
      const text = String(topic).slice(0, 80)
      if (text && takeMemory(text)) rows.push(`- ${text}`)
    }
    flush('这个群最近：', rows)
  }

  if (search.length) {
    dynamicLines.push('刚查到的网上资料：')
    for (const item of search.slice(0, 5)) dynamicLines.push(`- ${String(item).slice(0, 220)}`)
    dynamicLines.push('直接根据上面的资料回答；不要只说“我去搜/稍等/查到了”而没有结论。资料不够就说明不够。')
  }
  // 「被白名单/次数拦下」不是「查到了资料」：单独一行，别混进上面那段，
  // 否则模型会把它当搜索结果，还会把这次记成用了 net.search 技能。
  if (netNotice) {
    dynamicLines.push(`【这次没联网】${netNotice}`)
    dynamicLines.push('照直把原因告诉用户，不要编网上资料，也不要说「我去查一下」。')
  }
  if (quote && (quote.text || (Array.isArray(quote.images) && quote.images.length))) {
    dynamicLines.push(quote.summary ? '对方引用了这条消息（只拿到摘要）：' : '对方正在回复这条消息：')
    dynamicLines.push(`- ${quote.sender ? quote.sender + '：' : ''}${String(quote.text || '[图片]').slice(0, 200)}`)
  }

  if (vision) {
    dynamicLines.push('对方发来一张图，看到的内容是：')
    dynamicLines.push(vision.slice(0, 1200))
  }

  if (forward.length) {
    // 整段读，不再只取前 5 条：转发记录的价值就在上下文，掐头去尾等于只剩半句话。
    // 排序/合并/标间隔都在 forward.mjs 里做，这里只负责放进去和说清怎么读。
    const digest = digestForward(forward, { maxChars: 3000, total: forwardTotal, truncated: input.forwardTruncated === true })
    if (digest.text) {
      dynamicLines.push(digest.text)
      dynamicLines.push(FORWARD_READING_RULE)
    }
  } else if (forwardFailed) {
    // 取不到就明说，别让模型拿一个空上下文去猜「里面说了什么」。
    dynamicLines.push('这条消息带着一段转发，但这次没读到内容（协议端没给正文，或读取失败）。' +
      '被问到里面有什么时，如实说「这段没读到，重发一次我再帮你看」，不要编内容，也不要说「我这边只拿到条数和时间」。')
  }

  if (files.length) {
    dynamicLines.push('对方发来了文件：')
    for (const row of files.slice(0, 3)) dynamicLines.push(`- ${row.name || '文件'}${row.text ? '：\n' + String(row.text).slice(0, 1200) : '（' + (row.note || '没有正文') + '）'}`)
  }

  if (recent.length) {
    dynamicLines.push('刚才的对话：')
    for (const row of recent) {
      // 群里不止一个人：只写「对方」会把三个人的话揉成一个人说的
      const who = row?.from === 'self' ? selfName : String(row?.name || '对方')
      const whoId = row?.from === 'self' ? '' : String(row?.uin || '')
      const whoLabel = who + (whoId ? `（QQ ${whoId}）` : '')
      const text = defuse(String(row?.text || '').slice(0, 120))
      // 带上「多久以前」：一句话是十分钟前还是昨晚说的，回法完全不一样
      const when = row?.at ? `[${timeAgo(row.at, at)}] ` : ''
      if (text) dynamicLines.push(`${when}${whoLabel}：${text}`)
      if (row?.image) dynamicLines.push(`${whoLabel}：[图片] ${String(row.image).slice(0, 200)}`)
    }
  }

  // 时间锚点放在最后一行之前：它每分钟都变，放前面会让整段前缀作废（缓存按前缀匹配）。
  // 内容一个字没少，只是从「开头」挪到「贴着用户这句话」——模型反而更容易把时间用上。
  dynamicLines.push(`现在是 ${nowText(at)}。`)
  const who = String(event.payload?.senderName || event.from || '')
  const whoId = String(event.from || '')
  const whoLabel = who + (whoId && whoId !== 'self' ? `（QQ ${whoId}）` : '')
  dynamicLines.push('')
  if (emptyAt) {
    dynamicLines.push(`${whoLabel || '对方'}只 @ 了你，没打字。结合上面的对话接一句自然的话，别问「怎么了」，也别复述刚才的话。`)
  } else {
    dynamicLines.push(who ? `${whoLabel}说：${defuse(event.payload?.text || '')}` : `对方说：${defuse(event.payload?.text || '')}`)
  }
  // 能力事实与本次任务规则放在最后：越靠近回答位置，越不容易被长上下文挤掉。
  // 以前这两块没有，模型只能凭「最近这段对话里有没有出现」判断自己能不能做事。
  if (intentRule) dynamicLines.push('这一句要按下面的规矩办：' + intentRule)
  return staticLines.concat(dynamicLines).join('\n')
}

/**
 * 工具结果进上下文时的最短写法。
 *
 * 以前一律 `JSON.stringify(result).slice(0, 1800)`：
 *   · 转义把换行写成 `\n`，一段 1600 字的结果平白多出几十个 token；
 *   · `{ ok: true, text: "...", data: {...} }` 里 data 常是给界面看的副本，
 *     模型要的正文已经在 text 里；
 *   · 每个结果各给 1800，四个就是 7200 —— 工具轮次的钱一半花在重复结构上。
 *
 * 现在：有 text 就只给 text（补几个标量元信息），没有 text 才退回 JSON；
 * 单个与总量都有上限。截断只影响「特别长的结果」，正常搜索/读文件够用。
 */
const TOOL_RESULT_CHARS = 1400
const TOOL_DIGEST_CHARS = 5600

function clampText(text, limit) {
  const chars = [...String(text || '')]
  if (chars.length <= limit) return chars.join('')
  return chars.slice(0, Math.max(0, limit - 1)).join('') + '…'
}

function toolResultText(called, limit) {
  if (called === undefined) return '（没有返回）'
  if (called === null) return 'null'
  if (typeof called !== 'object') return clampText(String(called), limit)
  if (called.ok === false) {
    const bits = ['失败']
    if (called.code) bits.push(`[${called.code}]`)
    const reason = called.error || called.message || called.detail || ''
    if (reason) bits.push(String(reason))
    return clampText(bits.join(' '), limit)
  }
  const text = typeof called.text === 'string' ? called.text.trim() : ''
  const meta = []
  const seenMeta = new Set()
  // 元信息允许从 data 里取标量（path / url / count 这类），但不把整个 data 抄一遍：
  // 长数组和给界面看的字段不进上下文。
  const sources = [called, called.data && typeof called.data === 'object' ? called.data : null].filter(Boolean)
  for (const key of ['title', 'path', 'url', 'name', 'file', 'count', 'total', 'page', 'lines', 'from']) {
    for (const source of sources) {
      const value = source[key]
      if (seenMeta.has(key)) break
      if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) {
        meta.push(`${key}=${value}`)
        seenMeta.add(key)
      }
    }
  }
  if (text) {
    const suffix = meta.length ? `\n(${meta.join(' · ')})` : ''
    return clampText(text + suffix, limit)
  }
  const { ok, ...rest } = called
  return clampText(JSON.stringify(rest), limit)
}

/**
 * 把一批工具结果压成一段给模型的回灌文本。
 * 保持「序号 + 调用 + 结果」的形状，模型仍能按顺序读；上限按整段算，不按条算。
 * @param {Array<{call:object, called:any}>} results
 */
export function toolResultDigest(results, options = {}) {
  const rows = Array.isArray(results) ? results : []
  const maxEach = Math.max(200, Number(options.maxEach) || TOOL_RESULT_CHARS)
  const maxTotal = Math.max(400, Number(options.maxTotal) || TOOL_DIGEST_CHARS)
  const out = []
  let used = 0
  for (const [index, row] of rows.entries()) {
    const call = row?.call || {}
    const head = `${index + 1}. ${call.name}(${String(call.raw || '').replace(/\s+/g, ' ').slice(0, 120)}) → `
    const left = maxTotal - used - head.length
    if (left < 80) {
      out.push(`${index + 1}. ${call.name}(…) → （后面还有 ${rows.length - index} 个结果，长度到上限，没展开）`)
      break
    }
    const body = toolResultText(row?.called, Math.min(maxEach, left))
    out.push(head + body)
    used += head.length + body.length + 1
  }
  return out.join('\n')
}

/**
 * 缺限流器时的替身：什么都不拦、什么都不延迟。
 *
 * 用它不是为了「放过限流」，而是为了让「没装配限流器」这件事
 * 表现为「不限流」而不是「整条消息崩掉」。限流是保护措施，
 * 保护措施缺席时放行，比「因为保护措施缺席所以服务不可用」合理得多。
 */
const PERMISSIVE_GUARD = Object.freeze({
  check: () => ({ ok: true, why: '', text: '' }),
  note: () => {},
  delay: () => 0,
  mute: () => {},
  unmute: () => {},
})

export class Turn {
  /**
   * @param {object} input
   * @param {object} input.runtime
   * @param {object} input.guard
   * @param {object} input.usage
   * @param {object} input.channel  需要 say(scope, target, text)
   * @param {object} [input.typing]   voice/typing.mjs 的打字台（缺了就退回旧的固定节奏）
   * @param {object} [input.attention] decide/attention.mjs 的注意力账本（缺了就当没有窗口）
   * @param {(prompt:string, meta:object)=>Promise<{text:string, usage?:{input:number,output:number}}>} [input.runner]
   * @param {(ms:number)=>Promise<void>} [input.sleep]
   */
  constructor(input = {}) {
    this.runtime = input.runtime
    // 限流器是可选的，但缺了不能崩。
    // 以前直接 `this.guard = input.guard`，后面 5 处（check / note / delay / mute / unmute）
    // 全是无保护调用：没装配 guard 时第一句回复就会抛
    // 「Cannot read properties of undefined (reading 'check')」，
    // 整条消息在 respond 阶段炸掉，用户看到的是「他/她突然不说话了」。
    // 用一份「什么都不拦、什么都不延迟」的替身顶上：行为退化成「不限流」，
    // 但消息能出去。真正的限流由 index.js 装配时传入。
    this.guard = input.guard || PERMISSIVE_GUARD
    this.usage = input.usage
    this.channel = input.channel || null
    this.typing = input.typing || null
    this.attention = input.attention || null
    this.runner = typeof input.runner === 'function' ? input.runner : null
    this.tools = input.tools || null
    // 「下一条发完就撤回」的一次性标记：模型先调 withdraw_message{next:true}，
    // 系统把当前这条最终回复发出去后，再按记录里的 messageId 撤回。
    // 不设这个，模型只能撤上一条，没法演示「发一句再撤」。
    this.recallNext = new Map()
    this.sleep = typeof input.sleep === 'function' ? input.sleep : (ms) => new Promise((r) => setTimeout(r, ms))
    // 连发合并的计时器。为什么要能注入：
    //   合并窗口是「等对方说完」的估计，真实运行时就是 setTimeout；
    //   但用例里不能真等 1.5 秒 —— 那会让整个测试套件变慢十几倍，
    //   而且断言会时快时慢、不稳定。
    //   注入之后，用例可以把窗口调成 0（立刻结算），
    //   也能精确控制「什么时候算说完」。
    this.setTimer = typeof input.setTimer === 'function'
      ? input.setTimer
      : (fn, ms) => {
        const t = setTimeout(fn, ms)
        t?.unref?.()
        return t
      }
    this.clearTimer = typeof input.clearTimer === 'function' ? input.clearTimer : (t) => clearTimeout(t)
    this.log = typeof input.log === 'function' ? input.log : () => {}
    this.visionNotes = new Map()
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()
    // 同一会话串行：两个人同时说话时，不该让两条回复交错着插进来
    this.queue = new Map()
    this.pendingLeave = new Map()
    // 会话 → 上次「我为什么没回」的说明时间。限流的活该被限，
    // 但这个为什么要单独记：见 #notifyHold —— 沉默是最难排查的故障。
    this.holdNotices = new Map()
    // 连发缓冲：把「谁说了什么」攒起来，等对方说完再一次性交出去。
    //
    // 为什么要有：一个人连着发三条「在吗 / 你还在不 / 说句话呀」，
    // 深蓝对每条都回一次，群里看到的就是「问三句答三遍」—— 刷屏。
    // 真人会等一下，看对方是不是还在说，说完了才回一句 ——
    // 这个「等一下」既是拟人，也是风控。详见 decide/burst.mjs。
    this.bursts = new BurstLedger({
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
    })
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
            // 群里同名/改昵称很常见；把 QQ 号带上，模型才能把「刚才 @ 的
            // 1737401656」和「现在说话的竹筒肥鱼二代」认成同一个人。
            uin: row?.from === 'self' ? '' : String(row?.from || ''),
            text: text || quote,
            image: this.visionNotes.get(row?.id) || '',
            // 时间要带出去：拼提示词时要用它算「多久以前」
            at: Number(row?.at) || 0,
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

    // ══════════════════════════════════════════════════════
    // 连发合并：一个人连着发好几条，当成一件事回。
    //
    // 为什么要等一个窗口才回：主人说「在吗」「在吗」「在吗」，
    // 逐条回就是三句「在」；攒一起回一句「在，怎么了」才是人话。
    // 而且真人本来也要等一下 —— 看对方是不是还在说，说完了再回。
    // 这个「等一下」既是拟人（不抢答），也是风控（一次回一条）。
    //
    // 三个判据（见 decide/burst.mjs）：
    //   · **同一个人** —— 群里 A 和 B 各说一句不合并，那是两件事；
    //   · **同一个会话**；
    //   · **时间挨得近**。
    //
    // 合并不是丢弃：内容用换行连起来，一条都不丢。
    //
    // ⚠️ 对外契约不变：handle 立刻返回「已接收」，
    //    回复在窗口结束后异步发出。合并是内部机制，
    //    不该让调用方（宿主、测试）多等一个窗口。
    // ══════════════════════════════════════════════════════
    const merged = this.#collectBurst(event, decision, at)
    // 被合并缓冲接住了：这一条不单独处理，等窗口到了合并成一条再回。
    // 对外仍然是「已接收」——回复稍后异步发出，不改调用方的契约。
    if (merged) {
      return { ok: true, skipped: true, reason: '等对方说完', event }
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
    return this.#runTurn(event, decision)
  }

  /**
   * 连发合并 —— **在拟人的前提下做风控**。
   *
   * ══════════════════════════════════════════════════════════════
   * 【要同时满足两件事】
   *
   *   风控那边要的是：别刷屏、别复读、别像程序一次性吐一堆。
   *   拟人那边要的是：别秒回、要看对方说完没有、回复要像「想了一下才说的」。
   *
   *   这两件事在这里**是同一件事**：
   *   真人在群里看到有人连着发三句，不会立刻回第一条 ——
   *   他会等一下，看对方是不是还在说，说完了才回一句。
   *   这个「等一下」既是拟人（不抢答、不打断），也是风控（一次回一条）。
   *
   *   所以做法是：**群消息先进缓冲，等一个窗口，窗口过了对方还在说就继续等，
   *   对方说完了才一次性回**。
   *
   * ══════════════════════════════════════════════════════════════
   * 【为什么私聊不这样】
   *
   *   私聊里对方是主人，一条一条问清楚，每一条都得单独答。
   *   攒着不答就变成「问了半天没人理」—— 那不是从容，是失功能。
   *   而且私聊的「等对方说完」天然由打字节奏承担了（打完才发）。
   *
   * 【为什么窗口到点还没人说话就回】
   *
   *   等太久就成了「明明看到了却不说话」。
   *   窗口是「对方大概说完没」的估计，不是无限等待。
   *
   * 【参考实现（deepseek_QQFish_Service）】
   *
   *   它也是「缓冲 + 窗口 + 同一个人才合并」，窗口 1500ms，
   *   上限 6 条。这里沿用同一套口径，窗口按深蓝自己的配置走。
   * ══════════════════════════════════════════════════════════════
   *
   * @returns {boolean} true = 这条已经被合并缓冲接住了（不该再单独处理）
   */
  #collectBurst(event, decision, at) {
    // 只对「回话」有意义。主动/管理类行为不该被攒着 ——
    // 攒着就意味着「等一会儿才做」，而那些事本来就该立刻做。
    if (decision.behavior !== BEHAVIOR.REPLY) return false
    // 私聊不攒：见上面的说明。
    if (event.scope !== SCOPE.GROUP) return false
    // 自己发的（自己分条发出去的东西）不合并
    if (String(event.from || '') === 'self') return false

    const windowMs = Math.max(0, Number(this.runtime.config?.guard?.mergeWindowMs) || 0)
    // 窗口是 0 就等于不合并 —— 面板上关掉就是关掉，不留后门
    if (!windowMs) return false
    // 窗口跟着配置走（配置能热改，这里每条消息都重新读一次）
    this.bursts.windowMs = windowMs

    // 缓冲按「会话 + 人」分：不同人说的不是一件事，不该并在一起。
    return this.bursts.collect(event, decision, (mergedEvent, mergedDecision) => {
      this.#runTurn(mergedEvent, mergedDecision)
    })
  }

  /**
   * 真正跑一回合（回复）。从 handle 里拆出来，好让连发合并能复用。
   */
  #runTurn(event, decision) {
    const at = this.now()
    // 同一个会话排队，避免两条回复交叉
    const key = event.conversation
    const prev = this.queue.get(key) || Promise.resolve()
    const task = prev.then(() => this.#respond(event, decision, at)).catch((error) => {
      const message = String(error?.message || error)
      // 还有没被分支接住的异常（例如发送层自己抛）：至少留下可查的一条，
      // 不能只把 Promise 收成一个没人看的对象。
      this.runtime.log('turn_failed', { conversation: event.conversation, error: message, stage: 'respond' })
      return { ok: false, stage: 'respond', error: message, event }
    })
    this.queue.set(key, task)
    task.finally(() => {
      if (this.queue.get(key) === task) this.queue.delete(key)
      // 回合结束就撤掉「正在核对数据」：结论已经出来了，状态不该一直挂着。
      this.runtime.clearProgress?.(event.conversation)
    })
    return task
  }

  async #respond(event, decision, at) {
    const started = this.now()
    // 上一轮如果登记了“发完再撤”却没发出去，不能让它落到这一轮头上。
    this.recallNext.delete(event.conversation)
    const isOwner = event.scope === 'private' && event.tags?.includes('is_owner')
    const isOwnerTag = event.tags?.includes('is_owner') === true
    // 主人明确要「发一句再撤回」的演示：即使模型忘了调工具，也保证这一条
    // 发出后被撤回；仍只作用于本轮最终回复，不碰历史消息、不跨会话。
    const recallDemoAsk = isOwnerTag && /(?:测试|试试|演示).{0,16}撤回|撤回功能|发.{0,8}(?:一句|一条|个).{0,20}撤回|发个.{0,12}(?:无意义|无关).{0,20}撤回/.test(String(event.payload?.text || ''))
    if (recallDemoAsk) {
      this.recallNext.set(event.conversation, { delayMs: 1500, at: this.now() })
      this.runtime.log?.('recall_demo_scheduled', { conversation: event.conversation })
    }
    const toolCtx = {
      event,
      forwardAll: [],
      quote: null,
      files: [],
      // 给 withdraw_message{next:true} 用：只登记「本会话下一条发完就撤」，
      // 不立刻动任何已有消息。
      scheduleRecall: (options = {}) => {
        this.recallNext.set(event.conversation, {
          delayMs: Math.max(500, Math.min(5000, Number(options.delayMs) || 1200)),
          at: this.now(),
        })
        return { ok: true }
      },
    }

    // 同一条对方消息不回复两遍。
    //
    // 入站那边（runtime.claimMessage）已经拦了「同一条消息被投递两次」，
    // 但那只管**收到**。这一层管的是**回复**：模型在工具环里多跑一轮、
    // 或者同一个消息 id 因为重连被重新投进另一条链路时，
    // 可能对同一条消息回两次 —— 对方看到的是同一句话连着出现两遍。
    // 那是风控最敏感的行为特征之一。
    const replyKey = String(event.payload?.messageId || '')
    if (replyKey && this.runtime.dedupe?.checkMessage(event.conversation, replyKey)?.duplicate) {
      this.runtime.dedupe?.markSkipped()
      this.runtime.log?.('reply_deduped', { conversation: event.conversation, messageId: replyKey })
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'dedupe', ok: false, reason: '这条消息已经回过了' })
      return { ok: true, skipped: true, reason: '这条消息已经回过了', event }
    }

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
          // 用自主活动自己的账本，而不是 #spend + 思维链：后者只在这条 cot 落下时才看得见。
          const spent = activitySpend(this.runtime, generated, { kind: 'proactive' })
          if (generated && generated.text) {
            this.runtime.logActivity?.({
              at: this.now(),
              kind: 'proactive',
              text: '主动说了一句：' + String(generated.text).slice(0, 120),
              source: 'auto',
              tokens: spent,
            })
            // 思维链先于发言：先想后说，哪怕只是一句主动开口
            this.runtime.logCot?.({
              conversation: event.conversation,
              kind: 'proactive',
              text: String(generated.reasoning || '（主动开口，没有单独输出思考过程）'),
              summary: '主动开口：' + String(generated.text).slice(0, 80),
              at: this.now(),
              source: 'auto',
              tokens: spent.tracked ? spent : null,
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
            // 写说说不是「回话」：这笔归自主活动自己的账本，不混进「对话」。
            // 以前只挂在那一条 cot 上，cot 没落下来时这笔就查无实据。
            wrote = activitySpend(this.runtime, generated, { kind: 'qzone' })
            content = String(generated?.text || '').trim()
          } catch {}
        }
        if (!content || content === '无' || content.length < 4) {
          await this.#say(event.scope, event, ['这次没什么想发的，算了。'], started)
          return { ok: true, stage: 'qzone_empty', event }
        }
        // 思维链先于发言：说说也是它写给人看的话，发出去前先落一条
        this.runtime.logActivity?.({
          at: this.now(),
          kind: 'qzone',
          text: '写了一条说说：' + String(content).slice(0, 120),
          source: 'auto',
          tokens: wrote || null,
        })
        this.runtime.logCot?.({
          conversation: 'qzone',
          kind: 'qzone',
          text: String(generated?.reasoning || '（写说说，没有单独输出思考过程）'),
          summary: '发说说：' + String(content).slice(0, 80),
          at: this.now(),
          source: 'auto',
          tokens: wrote?.tracked ? wrote : null,
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
        renderBrowserPath: String(this.runtime.config.browser?.path || ''),
        browserTimeoutMs: 12_000,
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
      // 「短一点 / 长一点」改的是**说话倾向**，不是字数上限 ——
      // 早先这里改的是 persona.maxReplyChars，于是「说话短一点」被翻译成
      // 「每条最多 12 字」，硬生生把人话变成了节拍器。
      const tune = /短一点|简短点/.test(tuneText)
        ? { key: 'persona.verbosity', value: 'brief', text: '好，以后说话短一点' }
        : /长一点|多说点/.test(tuneText)
          ? { key: 'persona.verbosity', value: 'chatty', text: '好，以后说话长一点' }
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
      // 指令必须从句子开头开始。旧写法 /发个表情|发表情/ 会命中
      // 「转发聊天记录和存表情包一样…」这种总结句，把它误当收藏指令
      // （线上就回过一句「这条消息里没有可收藏的图片」）。
      const isSendStickerCmd = /^(?:(?:给我|帮我)?(?:发个|发)表情)/.test(rawText.trim())
      if (isSendStickerCmd) {
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
      // 收藏也必须是指令句，不能再匹配「收藏」「存表情」出现在任何位置的句子。
      const isCollectStickerCmd = /^(?:(?:给我|帮我)?(?:收藏|存)(?:一下|这个|这张|这)?[^。！？\n]{0,16}?表情|把[^。！？\n]{0,20}?存(?:成|为)?表情)/.test(rawText.trim())
      if (isCollectStickerCmd) {
        const tags = rawText.replace(/^.*?(?:表情)/, '').replace(/^[，,：:\s]+/, '').replace(/^标签(?:是|为)?[：:\s]*/, '').trim()
        const result = this.tools ? await this.tools.call('save_sticker', { tags }, toolCtx) : null
        await this.#say(event.scope, event, [result?.ok ? result.text : (result?.error || '没存成')], started)
        return { ok: result?.ok === true, stage: 'sticker_collect', event }
      }
      const reminded = parseReminder(event.payload?.text || '', this.now())
      if (reminded && this.runtime.reminders) {
        const added = this.runtime.reminders.add({ at: reminded.at, text: reminded.text, to: event.from })
        if (added.ok) {
          const line = added.duplicated
            ? `这条已经记过了：${describeAt(added.item.at, this.now())} 提醒你「${reminded.text}」，不重复设。`
            : `好，${describeAt(reminded.at, this.now())} 提醒你：${reminded.text}`
          const sent = await this.#say(event.scope, event, [line], started)
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

    // 换人接话已经过一次「是不是在对我说话」的判定，不再拿概率二次淘汰；
    // 概率只留给同一个人的续聊。
    // 主人接着说话不掷骰子：他是在对深蓝说，不是在群里自言自语。
    // 线上已经出现过主人问「竹筒还会撤回消息？」被 follow_up 概率静默跳过，
    // 看起来就是「后续不说话了」。
    const ownerFollowUp = Array.isArray(event.tags) && event.tags.includes('is_owner')
    if (decision.trigger === 'follow_up' && decision.handoff !== true && !ownerFollowUp) {
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

    // 日预算闸：超了就停下，别再烧钱。
    //
    // 为什么以前不拦：usage.record() 只把超预算这件事**记**下来（overBudget），
    // 全项目没有任何地方读它。于是面板上写着「超过就会停下并提醒」，
    // 实际上超了照花不误 —— 一个明明白白承诺了却不生效的开关。
    // 用户能做的只有看着数字涨，等第二天自己发现。
    //
    // 主人豁免：超预算多半是主人自己要的活（让他查个东西、跑个脚本），
    // 拦下来反而是「我正跟你说话你就哑了」。预算拦的是**闲聊与自主活动**，
    // 不是拦主人。
    const budget = this.#budgetGate(event)
    if (budget && !budget.ok) {
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'over_budget', ok: false, reason: budget.text })
      // 说清为什么不说 —— 沉默在主人看来就是「坏了」
      await this.#say(event.scope, event, [budget.text], started)
      return { ok: true, skipped: true, reason: budget.text, event }
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
    let netNotice = ''
    const userText = String(event.payload?.text || '').trim()
    // 意图判定只在这一处。命中诊断类时会抬工具轮数、给能力事实、显示人话进度，
    // 并且把「查一下你代码」从联网兜底里摘出来 —— 以前它会被送去搜网页，
    // 而白名单默认空，结果就是静默失败、模型凭印象答「看不到」。
    const toolNames = this.tools && typeof this.tools.names === 'function' ? this.tools.names() : []
    const intent = matchIntent(userText, toolNames)
    if (intent?.progress && this.runtime.setProgress) {
      this.runtime.setProgress(intent.progress, event.conversation)
    }
    const link = (userText.match(/https?:\/\/\S+/) || [])[0]
    if (link) {
      try {
        const page = await readWeb(link)
        if (page.ok) search = [`${page.title ? page.title + '：' : ''}${page.text}`]
        // 白名单没放行时不能让模型「没读到就凭印象编」：把真实原因交给它照直说。
        else if (page.code === 'net_denied') netNotice = `这条链接没能打开：${page.error}。`
      } catch {}
    }
    if (!search.length && !skipWebSearch(userText) && /(搜一下|搜索|查一下|查查|最新|新闻|天气|发生什么)/.test(userText)) {
      try {
        search = await searchWeb(userText)
      } catch {}
      // 联网被闸拦下时会返回空数组。以前这就成了「没搜到」，模型接着凭印象答；
      // 现在把拒绝原因交给模型照直说，界面上拨的那个开关才看得见效果。
      const denied = lastNetDenied()
      if (denied && !search.length) netNotice = denied + '。'
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
      try { quote.forward = await this.channel.getForward(quote.forwardId, 50, 1) } catch {}
    }
    if (quote && !quote.text && !(quote.images?.length) && !quote.forwardId && !(quote.forward?.length)) quote = null
    let forwardAll = []
    let forwardFailed = false
    if (event.payload?.forwardId && this.channel && typeof this.channel.getForward === 'function') {
      try {
        forwardAll = await this.channel.getForward(event.payload.forwardId, 200, 1)
      } catch (error) {
        forwardFailed = true
        this.runtime.log('forward_fetch_failed', { eventId: event.id, error: String(error?.message || error).slice(0, 160) })
      }
      if (!forwardAll.length) {
        forwardFailed = true
        // 静默的空数组最坑：界面上什么都没发生，模型却拿着一个空上下文
        // 去回答「里面说了什么」。这里必须留痕，提示词里也要明说。
        this.runtime.log('forward_fetch_failed', { eventId: event.id, error: '协议端返回空转发' })
      }
    }
    if (!forwardAll.length && Array.isArray(quote?.forward)) { forwardAll = quote.forward; forwardFailed = false }
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
    // 首屏按字数自适应，不再固定前 5 条。以前 5 条短消息就占满首屏，
    // 明明还有十几条能一次放进预算，却非要模型多轮翻页 —— 用户感知就是「看不完」。
    const forward = []
    let forwardChars = 0
    for (const row of forwardAll) {
      forward.push(row)
      forwardChars += String(row?.text || '').length + 16
      if (forwardChars >= 3000) break
    }

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
    // 合并转发里的图片不在 event.payload.images 里；不读的话模型只看到
    // 一行「[图片]」，就会回「看不到图」。取前两张，连同发送者一起给视觉模型。
    if (typeof this.runtime.describeImageFile === 'function') {
      const forwardPics = []
      for (const row of forwardAll) {
        for (const pic of Array.isArray(row?.imageItems) ? row.imageItems : []) {
          if (!pic?.file && !pic?.url) continue
          forwardPics.push({ pic, sender: String(row?.sender || '') })
          if (forwardPics.length >= 2) break
        }
        if (forwardPics.length >= 2) break
      }
      const notes = []
      for (let i = 0; i < forwardPics.length; i += 1) {
        const { pic, sender } = forwardPics[i]
        let resolved = null
        try {
          resolved = await resolveImageFile(pic, this.channel, this.runtime.config.images?.maxBytes)
          if (!resolved.ok) continue
          const seen = await this.runtime.describeImageFile(resolved.file, userText || '描述这张转发里的图。')
          if (seen.ok) notes.push(`转发图${i + 1}${sender ? '（' + sender + '发）' : ''}：${seen.text}`)
        } catch {} finally {
          if (resolved?.temp) { try { unlinkSync(resolved.file) } catch {} }
        }
      }
      if (notes.length) vision = [vision, ...notes].filter(Boolean).join('\n')
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
      selfId: String(this.channel?.selfId || this.runtime.config.channel?.selfId || ''),
      allowFace,
      persona: { ...(this.runtime.config.persona || {}), ownerName: this.runtime.config.identity?.ownerName || '' },
      // 灵魂文件：他/她自己的那份设定。比 config 里的那份优先 ——
      // 因为那份是出厂种子，这份才是当前生效的。
      soul: this.runtime.personaText ? this.runtime.personaText() : '',
      // 学到手感：真实聊天量出来的差距。群里学群的，私聊学主人的。
      habitLine: this.runtime.habitLine ? this.runtime.habitLine(scope) : '',
      styleGuide: this.runtime.styleGuide(scope),
      recent: this.#recent(event),
      search,
      netNotice,
      vision,
      quote,
      forward,
      forwardTotal: Number(forwardAll.forwardTotal) || forwardAll.length,
      forwardTruncated: forwardAll.forwardTruncated === true,
      forwardFailed,
      files,
      emptyAt: event.tags?.includes('at_me') && !userText && !(event.payload?.images || []).length && !files.length,
      // 闲聊只列常用工具，动作类消息给全表：见 needsFullTools 的取舍说明。
      toolLine: this.tools && typeof this.tools.prompt === 'function'
        ? this.tools.prompt({ mode: intent || needsFullTools(userText) ? 'full' : 'chat' })
        : '',
      // 教出来的技能要进提示词，否则「教了等于没教」
      skillLine: this.runtime.skillPromptLine ? this.runtime.skillPromptLine() : '',
      capabilityLine: capabilityBrief({ config: this.runtime.config, toolNames, withTools: false }),
      intentRule: intent ? intent.rule : '',
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
    // tools.maxRounds = 0 表示不限。旧代码把它夹在 1~6，而默认又是 2：
    // 模型改提醒参数时第一步写错、第二步才改对，轮数已经用完，只能回
    // 「我明早再改」。这里保留一个很高的硬顶（防死循环），正常由预算和
    // 「同样的调用换同样的结果」判定收口。
    const HARD_ROUND_LIMIT = 24
    const configuredRounds = Number(this.runtime.config.tools?.maxRounds)
    const baseRounds = configuredRounds > 0
      ? Math.max(1, Math.min(HARD_ROUND_LIMIT, Math.floor(configuredRounds)))
      : HARD_ROUND_LIMIT
    // 诊断类任务要翻源码／查记录，按意图再抬到至少 minRounds 轮。
    const maxRounds = Math.max(baseRounds, Math.min(HARD_ROUND_LIMIT, Number(intent?.minRounds) || 1))
    const maxPerRound = Math.max(1, Math.min(8, Number(this.runtime.config.tools?.maxPerRound) || 4))
    let lastToolResult = null
    // 这一次推理先不记账：要等看清它「是为了调工具」还是「是为了回话」才能归到正确的档。
    // 以前这里是「整轮跑完把用量加一起记一笔」，于是账本只有一个总数 ——
    // 想知道「联网搜索花了多少、沙箱花了多少」时，答案永远是「查不出来」。
    let pending = result
    // 上一批工具。这次推理要是在读它们的结果，那这笔开销就该记在它们名下。
    let pendingSources = []
    // 同一个工具、同样的参数、**返回同样的结果**，就是「原地打转」。
    // 真见过：连续三轮 [tool:read_forward_more] {}，每轮拿到一页相同内容，
    // 轮数用完、正文被清成空，用户一个字都没收到。
    const seenCallResults = new Map()
    let repeatedTool = ''
    for (let round = 0; round < maxRounds && this.tools; round += 1) {
      const body = String(pending?.text || '')
      const calls = parseToolCalls(body)
      if (!calls.length) {
        this.#spend(pending, this.#causeSource(pendingSources), event)
        pending = null
        if (round === 0 && /(查一?下|搜一?下|搜索|打开|看看|收藏|发一?个|发出来|提醒|截图|运行|读一下|记住|上次|以前)/.test(userText)) {
          let pick
          try {
            pick = await this.runner('用户要求你做事：' + userText + '\n你刚才只说了：' + body + '\n现在只输出工具调用行，一行一个：[tool:工具名] {"参数":"值"}，要多步就写多行。' + (this.tools.prompt?.({ compact: true }) || '') + '不需要工具就只输出 [none]。', { event, conversation: event.conversation })
          } catch (error) {
            // 工具环里的模型失败以前会直接冲出 #respond：用户收不到任何话，
            // 审计里也没有 turn_failed，下一轮就像「上一条没发生过」。
            // 与首轮失败同一种收口：记行为、记审计、发一句人话（这句话也会进上下文）。
            const message = String(error?.message || error)
            this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'runner_error', ok: false, reason: message, ms: this.now() - started })
            this.runtime.log('turn_failed', { conversation: event.conversation, error: message, stage: 'tool_pick' })
            await this.#say(scope, event, card({ error: message }), started)
            return { ok: false, stage: 'generate', error: message, event }
          }
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
          // 参数解析失败时**不要去调工具**：工具只会回一句「参数不对」，
          // 模型并不知道自己错在哪（少引号？少括号？中文引号？），下一轮八成还错。
          // 当成一条工具结果喂回去，附上原文和改法 —— 模型看一眼就能自己修。
          this.runtime.log('tool_args_invalid', { conversation: event.conversation, tool: call.name, raw: String(call.raw || '').slice(0, 160) })
          called = {
            ok: false,
            error:
              '参数不是合法 JSON：' + String(call.raw || '').slice(0, 120) +
              '\n常见原因：缺右括号、用了单引号或中文引号、多了一个逗号。' +
              '请重写这一行，参数必须是严格 JSON（键和字符串都用双引号括起来）。',
          }
        } else {
          called = await Promise.resolve(this.tools.call(call.name, call.args, { ...toolCtx, byModel: true }))
            .catch((error) => ({ ok: false, error: String(error?.message || error) }))
        }
        // 「原地打转」判定：同样的调用换来同样的结果，再调一次也不会变。
        // 只认结果一致，不认调用一致 —— 翻页工具用同一行参数会换到新一页，那是正常推进。
        const callKey = `${call.name}|${JSON.stringify(call.args || {})}`
        const signature = JSON.stringify(called).slice(0, 500)
        const before = seenCallResults.get(callKey)
        if (before === signature && called?.ok !== false) {
          repeatedTool = call.name
          this.runtime.log('tool_repeat', {
            conversation: event.conversation,
            tool: call.name,
            round,
            args: String(call.raw || '').slice(0, 120),
          })
        }
        seenCallResults.set(callKey, signature)
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
      // 只写模型真正要读的正文，不再把整份 JSON（含给界面看的 data）原样塞回去；
      // 单个/整段都有上限，四个工具一起调也不会把这一轮撑成两倍。
      const digest = toolResultDigest(results)
      prompt += `\n\n你刚调用了 ${results.length} 个工具，按顺序执行的结果如下：\n${digest}\n请根据结果继续；还要动手就再输出工具调用行（可以多行），否则直接给最终回复。已经拿到的内容够回答时就直接回答，不要为了「看完」而反复调同一个工具。`
      // 已经在原地打转了，就不要再喂一轮：那一轮只会得到同一句「我还要再调一次」，
      // 白花一次推理，还把轮数吃干净。这一次推理的钱已经按调用摊过了，
      // 所以要把 pending 清掉，否则下面会照「最后一次没记账」再记一遍。
      if (repeatedTool) {
        pending = null
        break
      }
      let next
      try {
        next = await this.runner(prompt, { event, conversation: event.conversation, onThought: (text) => this.runtime.noteThought?.({ conversation: event.conversation, text }) })
      } catch (error) {
        const message = String(error?.message || error)
        this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'runner_error', ok: false, reason: message, ms: this.now() - started })
        this.runtime.log('turn_failed', { conversation: event.conversation, error: message, stage: 'tool_round' })
        await this.#say(scope, event, card({ error: message }), started)
        return { ok: false, stage: 'generate', error: message, event }
      }
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

    // 轮数用尽、或者工具在原地打转时，最后一次输出往往只剩一行 [tool:…]，
    // 被上面那句清完就是空 —— 用户那边一个字都收不到（线上真发生过：
    // 连续三轮 read_forward_more 之后，聊天框一片空白）。
    // 补一次「只准回答」的收尾推理，把已经拿到的工具结果变成人话。
    if (!text && parseToolCalls(String(result?.text || '')).length) {
      this.runtime.log('tool_loop_exhausted', { conversation: event.conversation, repeated: repeatedTool || '' })
      try {
        const closing = await this.runner(
          prompt + '\n\n（工具轮次已经用完，不要再输出任何 [tool:...]。就用上面已经拿到的内容，用一两句话直接回答用户：' + userText +
            '。资料确实不够就说清缺哪一部分，不要再说「我再查一下」。）',
          { event, conversation: event.conversation, onThought: (one) => this.runtime.noteThought?.({ conversation: event.conversation, text: one }) },
        )
        this.#spend(closing, 'chat', event)
        const cleaned = String(closing?.text || '').replace(/\[tool:[^\]\n]*\][^\n]*/g, '').trim()
        if (cleaned) {
          result = closing
          text = cleaned
        } else {
          this.runtime.log('tool_closing_empty', { conversation: event.conversation })
        }
      } catch (error) {
        this.runtime.log('tool_closing_failed', { conversation: event.conversation, error: String(error?.message || error).slice(0, 120) })
      }
      if (!text) {
        // 收尾这次也没给出正文：宁可说一句实话，也不能让对面干等一片空白
        text = forwardAll.length ? '这段转发我没能整理出来，你直接问我里面哪一句？' : '刚这句我没接上，你再说一遍？'
        this.runtime.log('empty_fallback', { conversation: event.conversation, kind: forwardAll.length ? 'forward' : 'generic' })
      }
    }
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
    // 自己拆的段之间留的缝比机器切的大（见 voice/typing.mjs），手感差别就在这儿。
    const marked = String(text || '')
    const selfSplit = /\[split\]/i.test(marked)
    const segments = selfSplit
      ? marked.split(/\[split\]/i).map((one) => one.trim()).filter(Boolean).slice(0, 2)
      : [marked]
    const parts = []
    for (const segment of segments) {
      for (const piece of splitReply(segment, { maxParts: options.maxParts })) parts.push(piece)
    }
    if (!parts.length) {
      this.runtime.outcome({ eventId: event.id, behavior: decision.behavior, trigger: 'empty', ok: false, reason: '拆完没有可发的内容' })
      return { ok: false, stage: 'empty', error: '拆完没有可发的内容', event }
    }
    const sent = await this.#say(scope, event, parts, started, { selfSplit })
    // 文字被复读拦下时，表情也别单独发。
    // 否则用户看到的是「连续两个一模一样的表情」—— 比整句复读更像卡死。
    if (stickerWanted && !(sent && Number(sent.lines) > 0)) {
      this.runtime.log('sticker_suppressed', { conversation: event.conversation, why: '这一条回复没发出去（复读或限流），表情跟着不发' })
    }
    if (stickerWanted && sent && Number(sent.lines) > 0 && this.channel && typeof this.channel.sendImage === 'function') {
      try {
        // 跟工具走同一套挑选/库存逻辑，不再直接读目录 + 自己 find。
        // 以前这里发了图既不留痕也不记账，下一轮上下文里完全没有「我发过图」，
        // 线上就出现「我没发图啊老大」——图已经到对面了，它自己不记得。
        const match = pickSticker(loadStickers(this.runtime.dir || ''), stickerTag)
        if (match) {
          await this.channel.sendImage(scope, scope === 'group' ? event.payload?.groupId : event.from, match.path)
          this.runtime.noteSelfMessage?.({
            conversation: event.conversation,
            scope,
            text: '[表情包：' + (match.labels.length ? match.labels.join('、') : match.file) + ']',
            at: this.now(),
          })
          this.runtime.log('sticker_sent', {
            conversation: event.conversation,
            file: match.file,
            labels: match.labels,
            tag: stickerTag,
          })
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
   * 日预算闸。
   *
   * @param {object} event
   * @returns {{ok:boolean, text?:string}|null} null 表示没设预算或没超，不必拦
   */
  #budgetGate(event) {
    const usage = this.runtime.usage
    if (!usage || typeof usage.overBudget !== 'function') return null
    let state
    try {
      state = usage.overBudget(this.now())
    } catch {
      return null
    }
    if (!state || !state.over) return null
    // 主人豁免：超预算多半是主人自己要的活。拦下来等于「我正跟你说话你就哑了」。
    const ownerId = String(this.runtime.config.identity?.ownerId || '')
    if (ownerId && String(event.from || '') === ownerId) return null
    const currency = String(this.runtime.config.usage?.currency || 'CNY')
    const sign = currency === 'USD' ? '$' : '¥'
    const spent = Number(state.cost) || 0
    const budget = Number(state.budget) || 0
    return {
      ok: false,
      text: `今天已经花到 ${sign}${spent.toFixed(2)} 了，${sign}${budget.toFixed(2)} 的日预算用完了，我先歇会儿`,
    }
  }

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
      const gap = Number(HOLD_NOTICE_GAPS[gate.why]) || DEFAULT_HOLD_GAP_MS
      // 每次被拦都留痕，哪怕这次不发提示：事后能查到「为什么那句话没出现」。
      this.runtime.log('reply_hold', { conversation: event.conversation, why: gate.why, text: String(gate.text || ''), notified: !last || at - last >= gap })
      if (last && at - last < gap) return

      const line = gate.why === 'per_minute'
        ? '刚才这一分钟我说得太密了，怕被当成刷屏，先停几秒再回你。'
        : '我这边有个闸门把这条话拦住了（' + String(gate.text || gate.why || '限流') + '）。'
      this.holdNotices.set(event.conversation, at)
      const target = event.scope === 'group' ? event.payload?.groupId : event.from
      if (!target) return
      // 这条本来就只发给主人，owner=true 让失败提示也能完整出现
      await this.channel.say(event.scope, target, this.runtime?.outbound ? this.runtime.outbound(card({ line }), 'qq', 'card', { owner: true }) : line)
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
    // 渲染与节奏分开，是为了「文案错了」和「节奏不对」不互相掩盖：
    // 以前两件事挤在一个循环里，分条发成一条时，查了半天才发现是空串被吞了。
    //
    // 这里**不去重、不合并**：一条一句、发成几条是深蓝的说话方式，
    // 「描述不同事实」的多条回复本来就该分开发 ——
    // 打字台会在每条之间留 0.5~1.4 秒的缝，节奏上已经是「陆续在说」了。
    const ownerId = String(this.runtime?.config?.identity?.ownerId || '')
    const toOwnerDm = scope === 'private' && Boolean(ownerId) && String(event.from || '') === ownerId
    const texts = []
    for (const part of parts) {
      // 字符串先包成卡片再出站：出站口只认卡片，通道不许自己拼句子
      const view = typeof part === 'string' ? card({ line: part }) : part
      const text = String(this.runtime.outbound(view, 'qq', 'card', { owner: toOwnerDm }) || '')
      if (text.trim()) texts.push(text)
    }
    if (!texts.length) return { ok: true, lines: 0, error: '' }

    // 本轮生成的标识：同一轮里分条发出去的几条共用它。
    //
    // 出口去重靠它区分「同一轮说两遍」（复读，该拦）
    // 和「主人再问一遍、深蓝再答一遍」（正常，不该拦）。
    // 跨轮换新的 key —— 这是保住拟人感的关键。
    const roundKey = `${event.id || ''}:${this.now()}:${Math.random().toString(36).slice(2, 8)}`

    // 发出去的话也是这段对话的一半。不记的话，QQ 界面里只剩对方在自说自话，
    // 拼上下文时也读不到自己上一句 —— 两处都会「看起来正常，其实缺了一半」。
    // 一句话拆成三条气泡，额度上只算一条回复：第一条记 1，后面记 0。
    // 但 lastAt 每条都更新 —— 条与条之间的间隔仍然按真实发送算。
    let quotaNoted = false
    const note = (text, messageId = '') => {
      const count = quotaNoted ? 0 : 1
      quotaNoted = true
      this.guard.note(this.now(), { scope, conversation: event.conversation, target }, count)
      this.runtime.noteSelfMessage?.({ conversation: event.conversation, scope, text, at: this.now(), messageId })
      // withdraw_message{next:true} 登记过：这一条真正拿到 messageId 后，
      // 延迟一下再撤。没有 messageId（排队中/发送失败）就放弃，不猜。
      const pending = this.recallNext.get(event.conversation)
      if (pending) {
        this.recallNext.delete(event.conversation)
        if (messageId) {
          const timer = setTimeout(async () => {
            try {
              await this.channel.recall(messageId)
              this.runtime.log?.('recall_message', {
                conversation: event.conversation,
                messageId: String(messageId),
                ageMs: pending.delayMs,
                autonomous: true,
              })
            } catch (error) {
              this.runtime.log?.('recall_failed', {
                conversation: event.conversation,
                messageId: String(messageId),
                error: String(error?.message || error).slice(0, 160),
              })
            }
          }, pending.delayMs)
          timer.unref?.()
        } else {
          this.runtime.log?.('recall_failed', { conversation: event.conversation, error: '发送后没有拿到 messageId' })
        }
      }
    }
    // 「这条消息已经回过了」要记在**真的发出去之后**。
    // 先记后发的话，万一发送失败，这条消息就成了一堵假门 ——
    // 后面再来的真消息会被误判成「已经回过」，对方就再也收不到回复了。
    const markReplied = () => {
      const replyKey = String(event.payload?.messageId || '')
      if (replyKey) this.runtime.dedupe?.noteMessage(event.conversation, replyKey)
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
          const sentOne = await this.channel.say(scope, target, text, { roundKey })
          note(text, sentOne?.message_id || sentOne?.data?.message_id || '')
          markReplied()
        },
      })
      return { ok: result.ok, lines: result.lines, error: result.error || '' }
    }

    let lines = 0
    for (const text of texts) {
      const wait = this.guard.delay(this.now())
      if (wait > 0) await this.sleep(wait)
      let sentOne = null
      try {
        if (this.channel) sentOne = await this.channel.say(scope, target, text, { roundKey })
      } catch (error) {
        return { ok: false, lines, error: String(error?.message || error) }
      }
      note(text, sentOne?.message_id || sentOne?.data?.message_id || '')
      markReplied()
      lines += 1
    }
    return { ok: true, lines, error: '' }
  }
}
