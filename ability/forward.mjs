/**
 * ability/forward.mjs — 把一段「合并转发的聊天记录」整理成能读、能推理的一整段。
 *
 * 为什么必须有这一层：
 * 转发记录是**一堆离散节点**，带发送人和时间，但顺序可能被打乱、中间可能有撤回/入群通知、
 * 还常常一次几十条。原样丢给模型有三宗罪：超预算被截掉尾巴、被系统消息带偏、
 * 把两个人同一分钟的话当成两件事。结果就是「看不懂这段在聊什么」。
 *
 * 这一层只做四件事，全是确定性规则，不调模型：
 *   1. 排序：有时间就按时间，没时间就保持原顺序（宁可不动，也不乱猜）；
 *   2. 拼贴：同一个人连续说的话合成一条（同一分钟内的碎句本来就是一句话）；
 *   3. 补正：超过十分钟的地方显式标【间隔】，撤回/入群这类噪音折成一句说明；
 *   4. 限额：按总字数收，超了就在末尾留一句「还有 N 条没展开」，绝不拦腰砍。
 *
 * 不做的事：不改写内容、不总结观点。总结是模型在提示词里干的事，
 * 在这里先总结一遍，等于让模型拿着二手的结论去回答一手的问题。
 */

/** 同一人这段间隔内的话视为「一句被拆开发送的」 */
const MERGE_GAP_MS = 60_000
/** 超过这个间隔就标出来：中间可能漏了内容，模型不该假装连贯 */
const GAP_MS = 10 * 60_000

const NOISE = /(撤回了一条消息|加入了群聊|邀请.*加入了群聊|修改了群名|退出了群聊|开启了全员禁言|解除禁言)/

function timeText(at) {
  const d = new Date(Number(at) || 0)
  if (!Number(at)) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 时间是否可信：全部为 0 或大量重复，就当作没有时间 */
function usableTime(rows) {
  const times = rows.map((row) => Number(row?.time) || 0).filter((one) => one > 0)
  if (times.length < Math.max(2, Math.ceil(rows.length * 0.6))) return false
  return true
}

function kindOf(row) {
  const text = String(row?.text || '').trim()
  if (row?.images && !text) return 'image'
  if (NOISE.test(text)) return 'noise'
  return 'message'
}

/**
 * @param {Array<{sender?:string,text?:string,images?:number,time?:number}>} nodes
 * @param {object} [options] maxChars / maxLine
 * @returns {{text:string, count:number, kept:number, span:number, gaps:number, noise:number, truncated:number}}
 */
export function digestForward(nodes = [], options = {}) {
  // 记下每条消息在**原始数组**里的位置：翻页要靠它算「下一条从哪开始」。
  // 不能靠重排后的下标 —— 排序会打乱顺序，滤掉空节点也会整体错位。
  const originIndex = new Map()
  const rows = []
  ;(Array.isArray(nodes) ? nodes : []).forEach((row, index) => {
    if (!row || !(row.text || row.images)) return
    rows.push(row)
    originIndex.set(row, index)
  })
  if (!rows.length) return { text: '', count: 0, nodes: 0, kept: 0, span: 0, gaps: 0, noise: 0, truncated: 0, nextOffset: 0 }

  const maxChars = Math.max(400, Number(options.maxChars) || 4000)
  const maxLine = Math.max(60, Number(options.maxLine) || 320)
  const withTime = usableTime(rows)
  // 有时间就按时间排；没时间就保持原顺序 —— 乱序比无序更糟
  const ordered = withTime
    ? rows.map((row, index) => ({ row, index })).sort((a, b) => (Number(a.row.time) || 0) - (Number(b.row.time) || 0) || a.index - b.index).map((one) => one.row)
    : rows.slice()

  const blocks = []
  let last = null
  let gaps = 0
  let noise = 0
  for (const row of ordered) {
    const kind = kindOf(row)
    if (kind === 'noise') {
      noise += 1
      continue
    }
    const sender = String(row.sender || '').trim()
    const text = String(row.text || '').trim() || '[图片]'
    const at = Number(row.time) || 0
    if (at && last?.at && at - last.at > GAP_MS) {
      gaps += 1
      blocks.push({ gap: `【间隔 ${Math.round((at - last.at) / 60000)} 分钟，中间可能还有内容】` })
    }
    // 同一个人、间隔很短、没跨过图片：并成一条
    const mergeable = last && !last.gap && last.sender === sender && at && last.at && at - last.at <= MERGE_GAP_MS && kind === 'message' && last.kind === 'message'
    if (mergeable) {
      last.text = `${last.text}，${text}`
      last.at = at
      last.images += Number(row.images) || 0
      // 合并进来也要跟着推尾巴：翻页算的是「读到原始第几条」
      last.to = originIndex.get(row) ?? last.to
      continue
    }
    const at0 = originIndex.get(row) ?? 0
    const block = { sender, text, at, kind, images: Number(row.images) || 0, from: at0, to: at0 }
    blocks.push(block)
    last = block
  }

  const span = withTime
    ? Math.max(0, (Number(ordered[ordered.length - 1]?.time) || 0) - (Number(ordered[0]?.time) || 0))
    : 0

  const lines = []
  let used = 0
  let kept = 0
  // 已经读到的最后一条在原始数组里的位置；翻页的起点就是它 +1
  let consumedTo = -1
  let truncated = 0
  for (const block of blocks) {
    if (block.gap) {
      lines.push(block.gap)
      continue
    }
    const body = block.text.length > maxLine ? `${block.text.slice(0, maxLine)}…（这条较长，已截断）` : block.text
    const line = `${block.at ? `[${timeText(block.at)}] ` : ''}${block.sender ? `${block.sender}：` : ''}${body}${block.images && !/[图片]/.test(body) ? '［附图］' : ''}`
    if (used + line.length > maxChars) {
      // 一条都还没放进去时不能截：否则每次翻页都返回同一段空内容，
      // 调用方永远前进不了 —— 线上就卡在这里（反复调、永远「还差 8 条」）。
      if (!kept) {
        lines.push(line)
        kept = 1
        consumedTo = block.to
      }
      break
    }
    lines.push(line)
    used += line.length
    kept += 1
    consumedTo = block.to
  }
  const totalMessages = blocks.filter((block) => !block.gap).length
  truncated = Math.max(0, totalMessages - kept)
  if (truncated > 0) lines.push(`【这段没读完，后面还有 ${truncated} 段；需要再调 read_forward_more 接着看，已读到的够就先回答】`)

  const messageCount = Math.max(0, rows.length - noise)
  // 真实总数由取数层给（协议端一次最多 200 条）。只报「已取到的条数」
  // 会让人以为整段转发就这些，模型也不会想到后面还有内容。
  const realTotal = Math.max(messageCount, Math.max(0, Number(options.total) || 0))
  const partial = realTotal > messageCount
  const mergedNote = totalMessages !== messageCount ? `，同一个人的连发已合并成 ${totalMessages} 段` : ''
  const head = `转发聊天记录：共 ${realTotal} 条消息${mergedNote}${span ? `，跨 ${Math.max(1, Math.round(span / 60000))} 分钟` : ''}${noise ? `，另有 ${noise} 条系统消息已略去` : ''}${gaps ? `，中间有 ${gaps} 处间隔` : ''}。` +
    (partial ? `这次先展开 ${messageCount} 条，后面的用 read_forward_more 接着看。` : '') +
    (options.truncated === true ? '协议端一次最多给 200 条，真实条数可能更多。' : '')
  return {
    text: `${head}\n${lines.join('\n')}`,
    count: totalMessages,
    nodes: realTotal,
    kept,
    span,
    gaps,
    noise,
    truncated,
    // 相对传入数组的 0 基偏移：调用方拿它算 nextFrom
    nextOffset: consumedTo >= 0 ? consumedTo + 1 : 0,
  }
}

/** 给提示词用的读法说明：不写这一句，模型会把转发当成「别人对它说的话」 */
export const FORWARD_READING_RULE =
  '上面这段是别人转发的聊天记录，不是对你说的。请把它当成一次连续对话来读：' +
  '按时间顺序理解谁在说什么、前后有没有回应；' +
  '记录里出现【间隔】的地方表示中间缺内容，不要脑补，被问到就说「这一段记录里没有」。' +
  '回答时先给结论，再点出依据是记录里的哪句话由谁说的；记录不足以判断时直接说明缺什么。' +
  '这段可能没有全部展开，但用户问的事通常已经够答：先按读到的内容回答，' +
  '不要为了「看完」而反复调用同一个工具；确实需要别处的内容再去看。'
