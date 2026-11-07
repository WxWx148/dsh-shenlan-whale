/**
 * voice/style.mjs — 说话手感：只留「实测跟模型默认不一样」的那几条
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
 * 数据源（本机 2026-10-26 ~ 11-07，messages.jsonl + cot.jsonl）：
 *   主人 214 条：p50 = 8 字，43% ≤ 6 字，68% ≤ 12 字，0% 句号结尾，
 *               30% 用逗号，22% 带语气词，一次回合平均连发 5.2 条（最长 23）
 *   同群 1553 条：p50 = 8 字，72% ≤ 12 字，2% 句号结尾
 *   他/她此前 824 条：p50 = 29 字，55% 出现「我」，93% 用逗号，24% 句号结尾，
 *               12% 以「…」收尾（截断留下的）
 *   他/她 CoT 99 段：p50 = 100 字，9% 整段英文提纲
 *
 *   模型**原始输出**（cot.jsonl 756 条）：
 *     单行 71% · 两行 19% · 三行 6%   ← 模型自己会分行，行就是它的分条意图
 *     p25=14 字 · p50=21 · p90=38 · p99=106 · 最长 160
 *     自带换行 29%
 *   真实群聊每轮气泡数：83% 一个 · 10% 两个
 *   群里他人 37/575 含问号（6.4%）· 他/她自己 0/616（问号被切分吃掉了）
 */

import { splitByMeaning } from './semantic.mjs'

/** 实测口径：只给测试与文档对账，不进提示词（塞进去是纯浪费） */
export const STYLE_PROFILE = Object.freeze({
  source: 'messages.jsonl + cot.jsonl, 2026-10-26 ~ 11-07',
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
  /** 模型原始输出的形状：行数与字数，用来定「不改它」的理由 */
  raw: Object.freeze({
    samples: 756,
    singleLineShare: 0.71,
    twoLineShare: 0.19,
    threeLineShare: 0.06,
    p50Chars: 21,
    p90Chars: 38,
    p99Chars: 106,
    maxChars: 160,
  }),
})

/**
 * 一次回合的条数上限（硬顶）：面板最多给到 4，到这儿就停。
 *
 * 没指定时的默认条数是 3 —— 主人口径是「1~3 条，少量用 3 条连发」。
 * 模型自己写出来的换行通常在 2 行以内（实测 71% 单行、19% 两行、6% 三行），
 * 上限只兜底，不去凑条数。
 */
const BURST_MAX = 4
const BURST_DEFAULT = 3

/**
 * 逗号处断开时的**下限**。
 *
 * 这两个数拦的是碎片（「的」「差」单独发一条），不是长度 ——
 * 整段话没有字数上限：他想说多长说多长。
 */
const MIN_HEAD = 4
const MIN_TAIL = 4

/**
 * 防呆线：模型偶尔会吐一整段没有标点的长文（比如把搜索结果整段粘回来）。
 * 超过这条才按码位切开 —— 平时一次都不会碰到（模型原始输出 p99 才 106 字，
 * 最长 160），所以它不是字数限制，是「别发一堵墙」的兜底。
 */
const HARD_LIMIT = 200

/**
 * 规则块的字数预算：超了就是又把它写成文章了。
 *
 * 260 而不是 220：把「断句线」和「每条多短」拆成两句之后，块长多了 40 字。
 * 预算卡太紧的话，最后一行（"别用「你说得对」开头"）会被砍掉 ——
 * 截掉的是最该留下的那句。宁可多花几十个 token，也别把规则砍半截。
 */
const GUIDE_BUDGET = 260

/**
 * 「怎么说话」的规则块。
 * @param {object} options { channel: 'private'|'group', maxParts, verbosity }
 * @returns {string}
 */
export function styleGuide(options = {}) {
  const channel = String(options.channel || 'private')
  // 取整是硬要求：3.7 会在提示词里写出「分 2~3.7 条」，模型会照抄这个数
  //
  // 上限跟面板（persona.maxParts，最大 4）和 splitBursts（最大 4）对齐。
  // 以前这里是 6 —— 面板写着 4，提示词能写 6，实际能发 6，三处不一致。
  const rawParts = Number(options.maxParts) || BURST_DEFAULT
  const maxParts = Math.max(1, Math.min(BURST_MAX, Math.floor(rawParts)))
  const burstMax = Math.min(BURST_MAX, maxParts)
  // 详略：只影响「想多少说多少」这个倾向，不设字数上限。
  // 详细 → 让他把话说完；简短 → 一句能说完就一句。
  const verbosity = String(options.verbosity || 'normal')

  const lines = [
    '说话按聊天来，不按文章来：',
    // 为什么这里不再写「每条多少字」：
    //   字数一旦写进提示词，模型就会去凑那个数 —— 变成节拍器，不是人。
    //   人说话长短看语境：想讲清楚就讲清楚，想怼一句就一句。
    //   实测（本机 756 条原始输出）p25=14 字、p50=21 字、p90=38 字，
    //   最长 160 字 —— 模型的自然形态本来就在聊天的范围里，
    //   不需要拿字数去掰它。
    '- 一条一个念头，别写长句子；想到哪儿说到哪儿，一行一条。',
    // 分条的口径按**实测**写，不按想当然写：
    //   本机真实发言 573 条 / 401 轮，按 5 秒窗口切轮：
    //     1 条 286 轮（71%）· 2 条 74 轮（18%）· 3 条 32 轮（8%）· 4 条以上 9 轮（2%）
    //   所以主流是**一条说完**，分条是偶尔的事。
    //   写「分 2~3 条」会让模型每次都想凑够条数 —— 那是刷屏的起点。
    //   写「多数时候一条就够」才是把实测的分布告诉它。
    //
    // 上限是 2 时不提 3 条 —— 上限之外的东西说出来只会让模型困惑。
    burstMax >= 3
      ? `- 想说的多就分开说，最多 ${burstMax} 条，一行一条，第一条先说结论；多数时候一条就够。`
      : `- 想说的多就分开说，最多 ${burstMax} 条，一行一条，第一条先说结论。`,
    '- 句尾不加句号，逗号和连接词都少用，靠换行断气；不用「…」收尾。',
    '- 语气词该带就带：啊 吧 呢 嘛 呗 啦 哦 哈。',
    '- 别用「你说得对」「我记下了」开头，别解释自己为什么这么说；说完就停，不加客套收尾。',
  ]
  if (verbosity === 'brief') lines.push('- 简短点：一句能说完就别两句，别铺开讲。')
  else if (verbosity === 'chatty') lines.push('- 想多说就说，别自己掐掉半句，说完了再停。')
  if (channel === 'group') lines.push('- 群里 1~2 条就够，别抢话，接不上就不接。')
  else if (channel === 'private') lines.push('- 私聊可以更松：损两句、开个玩笑、直接问都行。')

  const guide = lines.join('\n')
  if (guide.length <= GUIDE_BUDGET) return guide
  // 超预算就整行地砍，不要从中间切 —— 半句被切在提示词里，读起来像坏掉了
  let kept = ''
  for (const line of lines) {
    if (kept && kept.length + 1 + line.length > GUIDE_BUDGET) break
    kept = kept ? `${kept}\n${line}` : line
  }
  return kept
}

/**
 * 按人话习惯把模型输出切成若干条消息（纯函数）。
 *
 * 三条规矩，都是为了让它像人发的：
 *   1. **换行是消息边界** —— 模型自己写了分行，就是想分成两条说；
 *   2. **行内按语义断** —— 模型自己封的句子、或「站得住 + 能起头」的逗号处；
 *   3. **超条数时合并** —— 绝不超量，也绝不丢内容。
 *
 * **这里没有字数上限。**
 *   早先有一根「每条多少字」的断句线，到线就切 —— 那正是「真新 / 的」这种
 *   碎片出来的地方，也是「换行被黏成逗号」的来源。用户后来明确说过：
 *   「去掉字数限制，他想说多长说多长，只是尽量聊天拟人就好」。
 *   现在只有下限（别切出碎片），没有上限。
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxParts] 最多几条（硬顶 4）
 * @returns {string[]}
 */
export function splitBursts(text, options = {}) {
  const maxParts = Math.max(1, Math.min(BURST_MAX, Number(options.maxParts) || BURST_DEFAULT))
  const source = String(text || '').replace(/\r\n?/g, '\n').trim()
  if (!source) return []

  // 一行 = 模型自己写的一段话。行与行之间是硬边界。
  // 每一段都记住「它后面跟的是什么」：合并超量的尾巴时按原样接回去，
  // 不能一律换成逗号 —— 那正是「换行被黏成逗号」的病根。
  const pieces = []
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = splitByMeaning(trimmed, { minHead: MIN_HEAD, minTail: MIN_TAIL })
    for (const part of parts) pieces.push({ text: part, sep: '' })
    if (pieces.length) pieces[pieces.length - 1].sep = '\n'
  }
  if (!pieces.length) return []

  // 防呆：极长的整段（模型把一整块内容粘回来）按码位切开，别发一堵墙
  const flat = []
  for (const piece of pieces) {
    if (piece.text.length <= HARD_LIMIT) {
      flat.push(piece)
      continue
    }
    const chunks = hardWrap(piece.text, HARD_LIMIT)
    chunks.forEach((chunk, index) => {
      flat.push({ text: chunk, sep: index < chunks.length - 1 ? '' : piece.sep })
    })
  }

  // 超条数：尾巴并进最后一条，用原来的间隔接回去。内容一条都不丢。
  const selected = flat.length > maxParts ? mergeTail(flat, maxParts) : flat.map((one) => one.text)
  const out = selected.map((one) => cleanTail(one)).filter(Boolean)
  return out.length ? out : []
}

/**
 * 收尾的标点：句号、逗号这些在聊天里不留在句尾。
 *
 * 问号和感叹号**留着** —— 那是语气。
 * 早先把它们跟句号一起抹掉，于是「听不懂？」发出去变成「听不懂」，
 * 群里有 6.4% 的人会扣问号，他/她一条都不扣（实测 0/616）。
 */
function cleanTail(text) {
  return String(text || '')
    .trim()
    .replace(/[。．.，,、；;：:…]+$/u, '')
    .trim()
}

/** 超条数：尾巴并进最后一条，按**原来的间隔**接回去 */
function mergeTail(pieces, maxParts) {
  const head = pieces.slice(0, maxParts - 1).map((one) => one.text)
  const tail = pieces.slice(maxParts - 1)
  let merged = ''
  for (let i = 0; i < tail.length; i += 1) {
    merged += tail[i].text
    if (i < tail.length - 1) merged += tail[i].sep
  }
  return [...head, merged]
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

/**
 * 硬切：按码位（不是 UTF-16 码元）切，emoji 不会被劈成半个。
 *
 * 也不在 ZWJ 连接符、变体选择符、肤色修饰符之间断开 ——
 * 「👨‍👩‍👦」拆开就是三个不认得的东西。
 *
 * 这是**防呆**用的：正常聊天里几乎不会走到（模型原始输出最长 160 字），
 * 只有模型吐了一整段没标点的长文时才会用上。
 */
export function hardWrap(text, maxChars) {
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
