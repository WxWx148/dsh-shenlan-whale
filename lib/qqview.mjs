/**
 * lib/qqview.mjs — QQ 界面的数据：谁在跟谁聊、在哪聊、聊了什么。
 *
 * 数据只有一处来源：事件日志。因为收发两条都落在那里
 * （收到的由通道写，自己发的由 runtime.noteSelfMessage 写），
 * 界面不另存一份「聊天记录」—— 两份记录一旦不同步，
 * 屏幕上说的和实际发的就会对不上，而这种错最难被发现。
 *
 * 这一层只读：不改日志、不发消息。发消息在 index.js 的出站口。
 */

/** 会话 id 拆成范围与对方 */
export function peerOf(conversation) {
  const raw = String(conversation || '')
  const [scope, id = ''] = raw.split(':')
  return { scope: scope === 'group' ? 'group' : scope === 'panel' ? 'panel' : 'private', id }
}

/** 一行事件是不是一条「有内容的消息」 */
function isMessage(row) {
  const type = String(row?.type || row?.kind || '')
  if (type !== 'message' && type !== 'image') return false
  // 只发图也是一句话；以前要求必须有文字，聊天记录里整段图片全不见
  if (type === 'image') return true
  if (String(row?.text || '').trim().length > 0) return true
  // 只引用/只发文件的消息没有正文，但它是发生过的事：聊天记录里要留位置
  return Boolean(row?.replyId || row?.replySummary)
}

/** 界面上一行消息显示什么：没正文时给个占位，不要显示成空白 */
function textOf(row) {
  const text = String(row?.text || '').trim()
  if (text) return text
  if (String(row?.type || row?.kind || '') === 'image') return '[图片]'
  if (row?.replyId || row?.replySummary) return '（引用了一条消息）'
  return ''
}

/** 一页最多这么多：再大浏览器一次画不完，再小翻起来没完 */
const PAGE_MAX = 200
/** 打开一段会话默认加载多少条 */
export const THREAD_PAGE_SIZE = 100

/**
 * 会话列表：按最近说话时间倒序。
 *
 * 为什么要扫一批再聚合而不是一次全读：日志可能是几万行，
 * 面板每 20 秒刷一次，全量读会把磁盘吃满。这里只看最近 500 条消息，
 * 足够覆盖「正在发生的对话」—— 一个已经安静三天的群不该排在列表顶部。
 */
export function listConversations({ events, scan = 500, limit = 30, groupName = null } = {}) {
  if (!events || typeof events.read !== 'function') return { rows: [] }
  const slice = events.read({ limit: Math.max(50, Math.min(500, scan)), filter: isMessage })
  const map = new Map()

  for (const row of slice.rows) {
    const conversation = String(row?.conversation || '')
    if (!conversation) continue
    const at = Number(row?.at || 0)
    const text = textOf(row)
    const hit = map.get(conversation)
    if (!hit) {
      map.set(conversation, {
        conversation,
        count: 1,
        lastAt: at,
        lastText: text.slice(0, 80),
        lastFrom: row.from === 'self' ? 'self' : 'other',
        lastWho: String(row.sender || ''),
        // 标题要用「对方叫什么叫」，不是「最后一句谁说的」。
        // 混为一谈的话，我最后说一句，会话标题就变成「我」——列表里全是「我」。
        peerWho: row.from === 'self' ? '' : String(row.sender || ''),
      })
    } else {
      hit.count += 1
      // 只保留最新的那一条作为「最后一句」：事件是从新往旧读的
      if (at > hit.lastAt) {
        hit.lastAt = at
        hit.lastText = text.slice(0, 80)
        hit.lastFrom = row.from === 'self' ? 'self' : 'other'
        hit.lastWho = String(row.sender || '')
      }
      if (!hit.peerWho && row.from !== 'self' && row.sender) hit.peerWho = String(row.sender)
    }
  }

  const rows = [...map.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, Math.max(1, Math.min(100, limit)))
    .map((row) => {
      const peer = peerOf(row.conversation)
      // 群里显示群名，不显示群号：群号对人没有意义，还容易和 QQ 号搞混。
      // 拿不到名字（没连上、缓存还没刷）才退回「群 + 号」，让用户至少知道能点进去。
      const name = peer.scope === 'group' && typeof groupName === 'function' ? String(groupName(peer.id) || '') : ''
      const title = peer.scope === 'group' ? name || `群 ${peer.id || '未知'}` : row.peerWho || `QQ ${peer.id || '未知'}`
      return {
        groupName: name,
        conversation: row.conversation,
        scope: peer.scope,
        where: peer.scope === 'group' ? (name ? '群聊 · ' + peer.id : '群聊') : '私聊',
        title,
        subtitle: row.lastFrom === 'self' ? '最后一句是我说的' : row.lastWho ? `最后一句是${row.lastWho}说的` : '最后一句是对方说的',
        lastText: row.lastText,
        lastAt: row.lastAt,
        lastFrom: row.lastFrom,
        lastWho: row.lastWho,
        count: row.count,
      }
    })
  return { rows, scanned: slice.rows.length }
}

/**
 * 一段会话里的消息，按时间正序（老的在上），像聊天窗口那样读。
 *
 * 条数按「消息」算，不按日志行算：filter 交给 Journal 在扫描时就筛掉心跳，
 * 否则 500 行里只有 19 条真消息（实测），界面上看起来像只加载了几条。
 *
 * @param {{events:object, conversation:string, limit?:number, before?:string}} input
 */
export function thread({ events, conversation, limit = THREAD_PAGE_SIZE, before } = {}) {
  const want = String(conversation || '')
  if (!events || typeof events.read !== 'function' || !want) return { rows: [], nextBefore: null, hasMore: false, pageSize: 0 }
  const pageSize = Math.max(1, Math.min(PAGE_MAX, Number(limit) || THREAD_PAGE_SIZE))
  const collected = []
  const seen = new Set()
  let cursor = before
  let nextBefore = null
  let hasMore = false
  let guard = 0
  // 按「显示出来的消息」凑够一页：旧日志里有重复投递、连续图片，
  // 读 100 行可能只剩 47 条；不够就再往前读一页，别让用户以为只加载了 40 条。
  while (collected.length < pageSize && guard < 6) {
    guard += 1
    const slice = events.read({
      limit: pageSize,
      before: cursor,
      maxScan: 6000,
      filter: (row) => isMessage(row) && String(row?.conversation || '') === want,
    })
    hasMore = slice.hasMore
    nextBefore = slice.nextBefore
    for (const item of slice.rows) {
      const messageId = String(item?.messageId || '')
      // 同一条 message_id 只留一次：重连/重复投递/多实例都会把同一句写两遍
      if (messageId && seen.has(messageId)) continue
      if (messageId) seen.add(messageId)
      const row = {
        id: String(item?.id || ''),
        at: Number(item?.at || 0),
        self: item?.from === 'self',
        who: item?.from === 'self' ? '我' : String(item?.sender || peerOf(want).id || '对方'),
        text: textOf(item),
        messageId,
        replyId: String(item?.replyId || ''),
        replySummary: String(item?.replySummary || ''),
        reply: null,
        replyText: '',
        // 被引用的原话到底拿全了没有：true=本地能找到原文，false=只有摘要
        // 界面据此决定「展开」还是「查看原文」
        replyFound: false,
      }
      const prev = collected[collected.length - 1]
      // 老日志没有 message_id：保留原来的「5 秒内同人同文」去重，遮住旧重复；
      // 新日志按 id 去重，真正连发两遍的「哈哈哈哈」不会再被误删。
      if (!messageId && prev && !prev.messageId && !prev.replyId && !row.replyId && prev.text === row.text && prev.who === row.who && Math.abs(prev.at - row.at) < 5000) continue
      collected.push(row)
    }
    if (!slice.hasMore || !slice.rows.length || !slice.nextBefore) break
    cursor = slice.nextBefore
  }
  const rows = collected.sort((a, b) => a.at - b.at)
  attachQuotes(events, want, rows)
  return { rows, nextBefore, hasMore, pageSize }
}

/**
 * 给这一页里的引用补上「被引用的是谁、说了什么」。
 * 只查当前会话里、messageId 能对上的消息；对不上就退回 reply 段带的摘要。
 */
function attachQuotes(events, conversation, rows) {
  const wanted = new Set(rows.map((row) => row.replyId).filter(Boolean))
  if (!wanted.size) return
  let lookup = []
  try {
    // 窗口给宽一点：被引用的原话可能是一小时前的一句，落在这一页之外。
    // 上限仍在（2 万行），一页 100 条最多也就这么多次扫描。
    lookup = events.read({
      limit: 500,
      maxScan: 20000,
      filter: (row) => String(row?.conversation || '') === conversation
        && row?.messageId && wanted.has(String(row.messageId)),
    }).rows || []
  } catch {
    lookup = []
  }
  const map = new Map(lookup.map((row) => [String(row.messageId), row]))
  for (const row of rows) {
    const hit = row.replyId ? map.get(row.replyId) : null
    if (hit) {
      // 不再截 200 字：用户点开要能看到被引用的**原文**，
      // 截断只发生在界面上（默认两行 + 展开），不发生在数据层。
      const text = textOf(hit) || (String(hit?.type || '') === 'image' ? '[图片]' : '')
      row.reply = {
        who: hit.from === 'self' ? '我' : String(hit.sender || '对方'),
        text,
        at: Number(hit.at) || 0,
        messageId: String(hit.messageId || ''),
        found: true,
      }
      row.replyText = text
      row.replyFound = true
    } else if (row.replySummary) {
      // 只有摘要：界面会给一个「查看原文」，由 /message 再去翻日志与协议端
      row.replyText = row.replySummary
      row.replyFound = false
    }
  }
}

/** 一句话概括「现在有多少个会话还活着」，给模块卡片用 */
export function overviewOf({ events } = {}) {
  const list = listConversations({ events, scan: 500, limit: 100 })
  const dayAgo = Date.now() - 24 * 3600 * 1000
  const active = list.rows.filter((row) => row.lastAt >= dayAgo).length
  return {
    total: list.rows.length,
    active,
    line: list.rows.length ? `${list.rows.length} 个会话，今天还在说话的有 ${active} 个` : '还没有任何 QQ 会话',
  }
}
