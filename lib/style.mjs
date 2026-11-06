/**
 * lib/style.mjs — 说话手感：只留「实测跟模型默认不一样」的那几条
 *
 * 为什么单独一层：
 *   人设说的是「我是谁」，这里说的是「怎么开口」。两者混一起，人设越写越长、
 *   话越说越像文章：每条 30~50 字、逗号连成串、句号收尾、开头先复述对方。
 *
 * 收录标准（三条，缺一不收）：
 *   1. 有实测差距 —— 聊天记录里真人这么干，模型默认不这么干；
 *   2. 模型自己做不到 —— 不写「你要想清楚」这类它本来就在做的事；
 *   3. 一句话说得完 —— 不谈写作技巧，不枚举它早就会的词。
 *
 * 数据源（本机 2026-10-26 ~ 10-27，messages.jsonl + cot.json）：
 *   主人 214 条：p50 = 8 字，43% ≤ 6 字，68% ≤ 12 字，0% 句号结尾，
 *               30% 用逗号，22% 带语气词，一次回合平均连发 5.2 条（最长 23）
 *   同群 1553 条：p50 = 8 字，72% ≤ 12 字，2% 句号结尾
 *   他/她此前 824 条：p50 = 29 字，55% 出现「我」，93% 用逗号，24% 句号结尾，
 *               12% 以「…」收尾（截断留下的）
 *   他/她 CoT 99 段：p50 = 100 字，9% 整段英文提纲
 */

/** 实测口径：只给测试与文档对账，不进提示词（塞进去是纯浪费） */
export const STYLE_PROFILE = Object.freeze({
  source: 'messages.jsonl + cot.json, 2026-10-26 ~ 2026-10-27',
  human: Object.freeze({
    samples: 214,
    medianChars: 8,
    shortShare: 0.43,
    briefShare: 0.68,
    periodEndShare: 0,
    commaShare: 0.3,
    particleShare: 0.22,
    burstMedian: 5.2,
    burstMax: 23,
  }),
  others: Object.freeze({ samples: 1553, medianChars: 8, briefShare: 0.72, periodEndShare: 0.02 }),
  self: Object.freeze({
    samples: 824,
    medianChars: 29,
    periodEndShare: 0.24,
    commaShare: 0.93,
    ellipsisEndShare: 0.12,
    selfMentionShare: 0.55,
    burstMedian: 2,
  }),
  reasoning: Object.freeze({ samples: 99, medianChars: 100, englishShare: 0.09 }),
})

/** 一条消息的软上限（字） */
const PART_CHARS = 20
/** 一次回合的条数：真人平均 5 条，给模型一个更克制的目标 */
const BURST_MIN = 2
const BURST_MAX = 4
/** 规则块的字数预算：超了就是又把它写成文章了 */
const GUIDE_BUDGET = 220

/**
 * 「怎么说话」的规则块。
 * @param {object} options { channel: 'private'|'group', maxParts, maxChars }
 * @returns {string}
 */
export function styleGuide(options = {}) {
  const channel = String(options.channel || 'private')
  // 取整是硬要求：3.7 会在提示词里写出「分 2~3.7 条」，模型会照抄这个数
  const rawParts = Number(options.maxParts) || 3
  const maxParts = Math.max(2, Math.min(6, Math.floor(rawParts)))
  // 断句线跟随用户设置：填 150 就按 150 断，填 25 就按 25 断；只有越界值才夹回 12–150
  const maxChars = Math.max(12, Math.min(150, Math.floor(Number(options.maxChars) || PART_CHARS)))
  const burstMax = Math.min(BURST_MAX, maxParts)

  const lines = [
    '说话按聊天来，不按文章来：',
    `- 一条一个念头，2~15 字，超过 ${maxChars} 字断下一条；想说的多就分 ${BURST_MIN}~${burstMax} 条，一行一条，第一条先说结论。`,
    '- 句尾不加句号，逗号和连接词都少用，靠换行断气；不用「…」收尾。',
    '- 语气词该带就带：啊 吧 呢 嘛 呗 啦 哦 哈。',
    '- 别用「你说得对」「我记下了」开头，别解释自己为什么这么说；说完就停，不加客套收尾。',
  ]
  if (channel === 'group') lines.push('- 群里 1~2 条就够，别抢话，接不上就不接。')
  else if (channel === 'private') lines.push('- 私聊可以更松：损两句、开个玩笑、直接问都行。')

  const guide = lines.join('\n')
  return guide.length > GUIDE_BUDGET ? guide.slice(0, GUIDE_BUDGET) : guide
}

/**
 * 按人话习惯把模型输出切成若干条消息（纯函数）。
 *
 * 顺序：换行 > 句末标点 > 逗号 > 硬切。
 * 三条硬规矩：换行是消息边界；每条自己站得住；超条数时合并而不是甩「…」。
 *
 * @param {string} text
 * @param {object} options { maxChars, maxParts }
 * @returns {string[]}
 */
export function splitBursts(text, options = {}) {
  const maxChars = Math.max(8, Number(options.maxChars) || PART_CHARS)
  const maxParts = Math.max(1, Number(options.maxParts) || BURST_MAX)
  const source = String(text || '').replace(/\r/g, '').trim()
  if (!source) return []

  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  let parts = []
  for (const line of lines) parts.push(...chunkLine(line, maxChars))

  // 句号/逗号/分号是旧习惯留下的尾巴，抹掉；问号感叹号是语气，保留。
  parts = parts.map((part) => part.replace(/[。．.，,、；;：:…]+$/u, '').trim()).filter(Boolean)

  if (parts.length > maxParts) parts = mergeToLimit(parts, maxParts, maxChars)
  return parts
}

/** 一行 → 若干条：优先句末标点，其次逗号，最后硬切 */
function chunkLine(line, maxChars) {
  if (line.length <= maxChars) return [line]
  const sentences = splitKeep(line, /([。！？!?…]+)/u)
  const out = []
  for (const sentence of sentences) {
    if (sentence.length <= maxChars) {
      out.push(sentence)
      continue
    }
    const clauses = splitKeep(sentence, /([，,、；;：:]+)/u)
    let buf = ''
    for (const clause of clauses) {
      if (!buf) buf = clause
      else if ((buf + clause).length <= maxChars) buf += clause
      else {
        out.push(buf)
        buf = clause
      }
    }
    if (buf) {
      if (buf.length > maxChars) out.push(...hardWrap(buf, maxChars))
      else out.push(buf)
    }
  }
  return out.map((item) => item.trim()).filter(Boolean)
}

/** 按分隔符切开但保留分隔符 */
function splitKeep(text, re) {
  const pieces = []
  let last = 0
  const source = String(text || '')
  const pattern = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let match
  while ((match = pattern.exec(source))) {
    const end = match.index + match[0].length
    pieces.push(source.slice(last, end))
    last = end
  }
  if (last < source.length) pieces.push(source.slice(last))
  return pieces.filter((piece) => piece !== '')
}

/**
 * 硬切：一行实在没有标点可断时，按长度硬分。
 *
 * 为什么不能直接 `text.slice(i, i + n)`：`.length` 数的是 UTF-16 编码单元，
 * 而 emoji 占两个。切在中间就会把一个代理对劈成两半，发出去是半个字符 ——
 * QQ 上显示成方块或「�」，而且原文再也拼不回来（另一半在下一句里）。
 * 表情在聊天里出现频率太高，这不是边角情况。
 *
 * 所以按**码位**切；并且不在 emoji 的接缝上切：
 * 末尾是 ZWJ、下一个是 ZWJ / 变体选择符 / 肤色修饰符时，都往后吞一格 ——
 * 👨‍👩‍👦 这类由多个码位拼成的表情于是不会被拆散。
 */
const JOINERS = new Set(['\u200d']) // ZWJ
function isExtender(ch) {
  if (JOINERS.has(ch)) return true
  if (ch === '\ufe0f') return true // 变体选择符（把 ☺ 变成彩色 emoji）
  return /^[\u{1f3fb}-\u{1f3ff}]$/u.test(ch) // 肤色修饰符
}

function hardWrap(text, maxChars) {
  const chars = Array.from(String(text || ''))
  const limit = Math.max(1, Number(maxChars) || 1)
  const out = []
  let index = 0
  while (index < chars.length) {
    let end = Math.min(chars.length, index + limit)
    while (end < chars.length && (JOINERS.has(chars[end - 1]) || isExtender(chars[end]))) end += 1
    out.push(chars.slice(index, end).join(''))
    index = end
  }
  return out
}

/** 超出条数：尾巴并进最后一条，不丢内容也不加省略号 */
function mergeToLimit(parts, maxParts, maxChars) {
  const kept = parts.slice(0, maxParts - 1)
  let tail = parts.slice(maxParts - 1).join('，')
  if (tail.length > maxChars) {
    const cut = lastBreak(tail, maxChars)
    tail = cut > 0 ? tail.slice(0, cut) : tail.slice(0, maxChars)
  }
  kept.push(tail.replace(/[，,、；;]+$/u, '').trim())
  return kept.filter(Boolean)
}

function lastBreak(text, limit) {
  const window = text.slice(0, limit)
  for (let i = window.length - 1; i >= Math.floor(limit * 0.6); i -= 1) {
    if (/[。！？!?…，,、；;：:\s]/u.test(window[i])) return i + 1
  }
  return -1
}
