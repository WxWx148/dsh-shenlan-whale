/**
 * lib/channel/onebot.mjs — OneBot 11（NapCat）通道。
 *
 * 这一层只做三件事，别的都不做：
 *   1. 连上去、断了重连；
 *   2. 把 OneBot 的事件**翻译**成内部 raw（格式转换，不含任何判断）；
 *   3. 把一句话发出去。
 *
 * 为什么翻译要单独成函数（toRaw）：格式错是最难查的一类问题 ——
 * 程序不报错，只是「他/她好像没听见」。抽成纯函数就能拿真实样例喂它，一眼看出字段对不对。
 *
 * 不发消息的判断（该不该回、回什么）全在 behavior / turn 里，这里不许有 if 业务逻辑。
 * 旧版把「群里要不要接话」写在通道层，导致换通道就等于换了一套行为，这个坑不重踩。
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KIND, SCOPE, SOURCE } from '../event.mjs'
import { writeJson } from '../core.mjs'

/** 90 秒一个帧都没有，就当这条连接死了（NapCat 心跳 30 秒一次，留三倍余量） */
const STALE_MS = 90_000
/** 连上满 30 秒才算「稳了」；只有稳过的断开才允许把退避清零 */
const STABLE_MS = 30_000

/** CQ 码 → 段。NapCat 默认发数组，但字符串模式也常见，两种都得认 */
function parseCqString(text) {
  const segments = []
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g
  let last = 0
  let match
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) segments.push({ type: 'text', data: { text: text.slice(last, match.index) } })
    const data = {}
    for (const pair of (match[2] || '').replace(/^,/, '').split(',')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      if (eq > 0) data[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    segments.push({ type: match[1], data })
    last = re.lastIndex
  }
  if (last < text.length) segments.push({ type: 'text', data: { text: text.slice(last) } })
  return segments
}

/** 把消息体统一成段数组 */
function segmentsOf(message) {
  if (Array.isArray(message)) return message
  if (typeof message === 'string') return parseCqString(message)
  return []
}

/**
 * 历史消息（get_*_msg_history 的返回项）→ 归一化形状。
 * 只解析，不判断该不该记：掉线补回由 backfill 决定。
 */
function historyItem(item, { scope, id, selfId } = {}) {
  if (!item || typeof item !== 'object') return null
  const from = String(item.user_id ?? item.sender?.user_id ?? '')
  if (selfId && from === selfId) return null
  const segments = segmentsOf(item.message ?? item.raw_message)
  const texts = []
  const images = []
  let replyId = ''
  let replySummary = ''
  let forwardId = ''
  for (const seg of segments) {
    const type = String(seg?.type || '')
    if (type === 'text') texts.push(String(seg?.data?.text || ''))
    else if (type === 'face') texts.push(`[face:${String(seg?.data?.id || '')}]`)
    else if (type === 'at') {
      const qq = String(seg?.data?.qq || '')
      if (qq) texts.push(qq === 'all' ? '@全体成员' : `@${qq}`)
    } else if (type === 'file') texts.push(`[文件:${String(seg?.data?.name || seg?.data?.file || '')}]`)
    else if (type === 'record') texts.push('[语音]')
    else if (type === 'image') {
      images.push({
        file: String(seg?.data?.file || ''),
        url: String(seg?.data?.url || ''),
        summary: String(seg?.data?.summary || ''),
      })
    } else if (type === 'reply') {
      replyId = String(seg?.data?.id ?? seg?.data?.message_id ?? '')
      replySummary = String(seg?.data?.content ?? seg?.data?.summary ?? '').trim().slice(0, 300)
    } else if (type === 'forward') {
      forwardId = String(seg?.data?.id ?? seg?.data?.resid ?? '')
    }
  }
  const at = Number(item.time) * 1000 || 0
  const text = texts.join('').trim()
  if (!at || (!text && !images.length && !replyId && !forwardId)) return null
  return {
    messageId: String(item.message_id ?? ''),
    at,
    from,
    sender: String(item.sender?.card || item.sender?.nickname || ''),
    text,
    images,
    replyId,
    replySummary,
    forwardId,
    scope: scope === 'group' ? SCOPE.GROUP : SCOPE.PRIVATE,
    groupId: scope === 'group' ? String(id || '') : '',
  }
}

/**
 * OneBot 事件 → 内部 raw。
 *
 * 返回 null 表示「这条不该进流程」（自己发的、不认识的类型），调用方直接丢。
 * 注意自己发的话必须丢：不丢的话，他/她会把自己的话当成别人说的，然后自己回自己。
 */
export function toRaw(ev, options = {}) {
  if (!ev || typeof ev !== 'object') return null
  const selfId = String(options.selfId || '')
  const postType = String(ev.post_type || '')

  if (postType === 'meta_event') {
    if (String(ev.meta_event_type || '') !== 'heartbeat') return null
    return {
      source: SOURCE.CHANNEL,
      kind: KIND.HEARTBEAT,
      scope: SCOPE.PRIVATE,
      from: selfId,
      text: '',
      at: Number(ev.time) * 1000 || Date.now(),
      payload: { status: ev.status, online: ev.status?.online !== false },
    }
  }

  // 通知与请求：以前这里一刀切 `return null`，于是「有人加好友」「有人拉它进群」
  // 「有人戳它一下」这三件事**根本没进过系统** —— 面板、日志、记忆里都查不到，
  // 主人只能自己去 QQ 里发现。通道层的职责只是翻译，翻不翻得全，直接决定后面
  // 有没有这条数据可判；判不判由 behavior 决定（通知一律只记录，不产生行为）。
  if (postType === 'notice') {
    const notice = String(ev.notice_type || ev.sub_type || '')
    // 没有类型的通知是脏包，不是「未知事件」—— 放进去只会在事件流里堆无意义的行
    if (!notice) return null
    return {
      source: SOURCE.CHANNEL,
      kind: KIND.NOTICE,
      scope: ev.group_id ? SCOPE.GROUP : SCOPE.PRIVATE,
      from: String(ev.user_id ?? ''),
      text: '',
      at: Number(ev.time) * 1000 || Date.now(),
      payload: {
        notice,
        groupId: ev.group_id === undefined ? null : ev.group_id,
        operatorId: ev.operator_id === undefined ? null : String(ev.operator_id),
        targetId: ev.target_id === undefined ? null : String(ev.target_id),
      },
    }
  }

  if (postType === 'request') {
    // flag 是回执要用回的凭据；没有它这条请求既不能同意也不能拒绝，等于废数据
    if (!ev.flag) return null
    const subType = String(ev.sub_type || '')
    const isGroup = subType.startsWith('group') || ev.group_id !== undefined
    return {
      source: SOURCE.CHANNEL,
      kind: KIND.NOTICE,
      scope: isGroup ? SCOPE.GROUP : SCOPE.PRIVATE,
      from: String(ev.user_id ?? ''),
      text: '',
      at: Number(ev.time) * 1000 || Date.now(),
      payload: {
        // 一条 request 就是一个「等着人点头」的请求：flag 是回执时要带回去的凭据
        request: {
          flag: String(ev.flag ?? ''),
          subType,
          groupId: ev.group_id === undefined ? null : ev.group_id,
          userId: String(ev.user_id ?? ''),
          comment: String(ev.comment ?? ''),
        },
        groupId: ev.group_id === undefined ? null : ev.group_id,
      },
    }
  }

  if (postType !== 'message' && postType !== 'message_sent') return null

  const from = String(ev.user_id ?? ev.sender?.user_id ?? '')
  if (selfId && from === selfId) return null // 自己说的，丢掉

  const isGroup = String(ev.message_type || '') === 'group' || ev.group_id !== undefined
  const segments = segmentsOf(ev.message ?? ev.raw_message)
  const texts = []
  let atMe = false
  let atAll = false
  let hasImage = false
  let replyId = ''
  let replySummary = ''
  let forwardId = ''
  const voices = []
  const images = []
  const files = []

  for (const seg of segments) {
    const type = String(seg?.type || '')
    if (type === 'text') texts.push(String(seg?.data?.text ?? ''))
    else if (type === 'at') {
      const qq = String(seg?.data?.qq ?? '')
      if (qq === 'all') atAll = true
      else if (selfId && qq === selfId) atMe = true
    } else if (type === 'image') {
      hasImage = true
      images.push({
        file: String(seg?.data?.file || ''),
        url: String(seg?.data?.url || ''),
        summary: String(seg?.data?.summary || ''),
      })
    } else if (type === 'reply') {
      replyId = String(seg?.data?.id ?? seg?.data?.message_id ?? '')
      // 有的协议端会把被引用内容的摘要塞在 reply 段里；有就先留着，
      // get_msg 取不到原文时它就是唯一的上下文（旧版就是靠这个兜底的）。
      replySummary = String(seg?.data?.content ?? seg?.data?.summary ?? '').trim().slice(0, 300)
    } else if (type === 'forward') {
      forwardId = String(seg?.data?.id ?? seg?.data?.resid ?? '')
      if (!replySummary) replySummary = String(seg?.data?.content ?? seg?.data?.summary ?? '').trim().slice(0, 300)
    } else if (type === 'face') {
      texts.push(`[face:${String(seg?.data?.id || '')}]`)
    } else if (type === 'record') {
      voices.push({ file: String(seg?.data?.file || ''), url: String(seg?.data?.url || '') })
    } else if (type === 'file') {
      // 群文件/私聊文件：文件名和大小先记下来，正文要不要读由 turn 决定
      files.push({
        file: String(seg?.data?.file || seg?.data?.file_id || ''),
        name: String(seg?.data?.name || seg?.data?.file_name || ''),
        size: Number(seg?.data?.file_size || seg?.data?.size) || 0,
        busid: Number(seg?.data?.busid) || 0,
      })
    }
  }

  const text = texts.join('').trim()
  const hasAt = atMe || atAll
  // 纯 @ 没有正文时，也要把这件事记下来（否则「被 @ 了却没内容」会被当成没发生）。
  // 只引用、只转发、只发文件/语音同样是「发生过的事」：旧版只看文字/图片/@，
  // 这类消息整条进不了日志，面板和上下文都查不到，引用也就永远补不回来。
  if (!text && !hasImage && !hasAt && !replyId && !replySummary && !forwardId && !files.length && !voices.length) return null

  return {
    source: SOURCE.CHANNEL,
    kind: hasImage && !text ? KIND.IMAGE : KIND.MESSAGE,
    scope: isGroup ? SCOPE.GROUP : SCOPE.PRIVATE,
    from,
    text,
    at: Number(ev.time) * 1000 || Date.now(),
    atMe,
    atAll,
    hasImage,
    messageId: ev.message_id,
    payload: {
      groupId: isGroup ? String(ev.group_id ?? '') : '',
      senderName: String(ev.sender?.card || ev.sender?.nickname || ''),
      images,
      replyId,
      replySummary,
      forwardId,
      voices,
      files,
      selfId,
    },
  }
}

/**
 * 通道本体。
 *
 * 状态机很小：offline → connecting → online → （断了）→ 退避重连。
 * 每次状态变化都告诉 runtime，面板才看得见「现在到底连上没有」。
 */
export class OneBotChannel {
  constructor(input = {}) {
    this.config = input.config || {}
    this.runtime = input.runtime || null
    this.log = typeof input.log === 'function' ? input.log : () => {}
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()

    this.ws = null
    this.stopped = true
    this.connected = false
    this.retries = 0
    this.echoSeq = 0
    this.pending = new Map()
    this.onRaw = null // 由 turn 设置：拿到 raw 之后干什么
    this.onReconnect = null // 由 index 设置：连上后补掉线期间漏掉的消息
    this.downAt = 0 // 这次掉线是从什么时候开始的（0 = 没掉过）
    this.lastReconnectAt = 0 // 上一次补回是什么时候（2 秒内抖出来的重复 open 不再补）
    this.retryTimer = null // 待触发的重连定时器；有它就说明退避还在跑，外部别插一脚
    this.everConnected = false
    this.lastError = ''
    // 连接健康度的三个时间戳。没有它们，就只能等 TCP 自己超时：
    // 网线掉了、Wi-Fi 换了、NapCat 假死，socket 都还「开着」，房间静悄悄但谁都不知道。
    this.openedAt = 0 // 这次连接是什么时候开的（用来判断「稳了没有」）
    this.lastFrameAt = 0 // 最近一次收到任何帧（心跳也算）
    this.livenessTimer = null
    this.closedCode = 0 // 上一次 close 的码，排查时唯一能看的线索
    // 群号 → 群名。OneBot 的群消息事件里没有群名，只能靠 get_group_list 问一次；
    // 面板是同步渲染的，所以这里做成「缓存 + 后台刷新」，并把结果落盘，
    // 这样刚启动、还没连上时也能把名字显示出来（而不是先给用户看一串数字）。
    this.groups = new Map()
    this.groupsAt = 0
    this.groupsFile = this.runtime?.dir ? path.join(String(this.runtime.dir), 'groups.json') : ''
    this.#loadGroups()
    // 建连接的方式做成可注入：生产用全局 WebSocket，测试塞一个假的。
    // 不开这个口子，通道层就只能「真的连一个 NapCat」才能测 —— 那等于不测。
    this.openSocket = typeof input.open === 'function' ? input.open : (url) => new WebSocket(url)
  }

  state() {
    if (!this.config.channel?.enabled) return 'off'
    // 主动停掉的要报 off，不能报 unknown —— unknown 的意思是「开着但还没消息」，
    // 用户看到它会把「我关了」误当成「还没连上」，然后再去点一次。
    if (this.stopped) return 'off'
    if (this.connected) return 'online'
    return this.retries > 0 ? 'offline' : 'unknown'
  }

  #url() {
    const raw = String(this.config.channel?.wsUrl || '')
    if (!raw) return null
    try {
      const url = new URL(raw)
      const token = String(this.config.channel?.token || '')
      if (token) url.searchParams.set('access_token', token)
      return url
    } catch {
      return null
    }
  }

  start() {
    if (this.stopped === false) {
      this.#ensureLiveness()
      return { ok: true, state: this.state() }
    }
    this.stopped = false
    // 手动开一次才说「正在连」：这是用户动作，写一行状态是对的。
    // 自动重连不走这里 —— 否则会变成每次退避都刷两条状态。
    this.#mark('unknown')
    this.#ensureLiveness()
    return this.#connect()
  }

  stop() {
    this.stopped = true
    this.connected = false
    this.downAt = 0
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.livenessTimer) clearInterval(this.livenessTimer)
    this.livenessTimer = null
    try {
      this.ws?.close()
    } catch {
      // 关不掉就算了，进程退出时自然会断
    }
    this.ws = null
    for (const [, entry] of this.pending) clearTimeout(entry.timer)
    this.pending.clear()
    this.#mark('off')
    return { ok: true }
  }

  #mark(state) {
    try {
      this.runtime?.markChannel?.(state)
    } catch {
      // 状态报不上去不该影响收发
    }
  }

  /**
   * 发送失败留痕。
   *
   * 面板上那条红字一闪就没了，事后要回答「什么时候开始发不出去的、是所有群还是某一个群、
   * 报的是哪个码」就只能靠审计。这一笔不写，等于每次都要用户复现一遍。
   */
  #noteSendFailure(action, target, error) {
    try {
      const raw = String((error && error.message) || error || '').replace(/\s+/g, ' ').trim()
      const code = (raw.match(/"result"\s*:\s*(-?\d+)/) || [])[1] || ''
      this.runtime?.log?.('send_failed', {
        action: String(action || ''),
        target: String(target || ''),
        code,
        // 原文只留前 200 字：够定位就行，别把一大段堆进审计
        raw: raw.slice(0, 200),
      })
    } catch {
      // 记不上账不能连带把发送失败的返回也弄丢
    }
  }

  /**
   * 这条连接多久没说话就当它死了。
   *
   * NapCat 每 30 秒推一次心跳；90 秒一个帧都没收到，说明这条 TCP 已经不可用 ——
   * 换网、掉线、协议端假死都长这样：socket 不 close，只是永远不再来消息。
   * 以前只能等 TCP 自己超时，快则几分钟，慢则永不，
   * 面板上就一直显示「在线」，而所有发送都超时。
   */
  #ensureLiveness() {
    if (this.livenessTimer || this.stopped) return
    this.livenessTimer = setInterval(() => this.#checkLiveness(), 15_000)
    this.livenessTimer.unref?.()
  }

  /**
   * 体检一次（公开给看门狗与用例用）：
   * 静默超时就断开重连；没连上又没有待重连定时器，就补一脚。
   * @returns {{state:string, silentMs:number, action:'ok'|'dropped'|'reconnecting'}}
   */
  checkHealth() {
    const before = this.connected
    this.#checkLiveness()
    const silentMs = this.connected ? Math.max(0, this.now() - (this.lastFrameAt || this.openedAt || this.now())) : 0
    return {
      state: this.state(),
      silentMs,
      action: before && !this.connected ? 'dropped' : this.retryTimer ? 'reconnecting' : 'ok',
    }
  }

  #checkLiveness() {
    if (this.stopped) return
    const now = this.now()
    if (this.connected) {
      const last = this.lastFrameAt || this.openedAt || now
      if (now - last > STALE_MS) {
        this.lastError = '连接静默 ' + Math.round((now - last) / 1000) + ' 秒，判定已断'
        this.log('[channel] ' + this.lastError + '，主动断开重连')
        this.#dropSocket()
        return
      }
    }
    // 没连上、也没有待重连的定时器 —— 这才是「真卡住」，补一脚
    if (!this.connected && !this.retryTimer) this.#connect()
  }

  /** 主动扔掉当前 socket：先摘掉引用，迟到的事件就不会再被当真 */
  #dropSocket() {
    const ws = this.ws
    this.ws = null
    this.connected = false
    try {
      ws?.close()
    } catch {}
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('连接已断开'))
    }
    this.pending.clear()
    if (this.stopped) return
    this.#mark('offline')
    this.#scheduleReconnect()
  }

  #connect() {
    const url = this.#url()
    if (!url) {
      this.lastError = '通道地址没填，或者不是合法的 ws:// 地址'
      this.#mark('offline')
      return { ok: false, error: this.lastError }
    }

    // 已经有一条在连（0）或在用（1）就别再造一条。
    // 旧 socket 迟到的 close 会把状态打成 offline 并触发重连，
    // 于是越连越多 —— 面板上看起来就是「一会儿在线一会儿掉线」。
    const state = this.ws?.readyState
    if (state === 0 || state === 1) return { ok: true, state: this.state() }

    // 这里不再每次尝试都报「还没连上」。
    // 报一次 unknown 就会在状态机上留下一对 unknown → offline，
    // 退避重连一天下来写两万多行通道状态（实测 22377/23953 行），把审计页淹掉，
    // 面板上也会把「掉线」闪成「还没连上」。重连期间保持 offline 才是事实；
    // 用户手动 start() 时由 start() 自己报一次 unknown。
    let ws
    try {
      ws = this.openSocket(url)
    } catch (error) {
      this.lastError = String(error?.message || error)
      this.#scheduleReconnect()
      return { ok: false, error: this.lastError }
    }
    this.ws = ws
    /** 只认当前这条 socket 的事件：旧 socket 迟到的 open/close 一律不当真 */
    const mine = () => this.ws === ws

    ws.addEventListener('open', () => {
      if (!mine()) return
      const since = this.downAt
      const first = !this.everConnected
      this.connected = true
      this.lastError = ''
      this.everConnected = true
      this.downAt = 0
      this.openedAt = this.now()
      this.lastFrameAt = this.openedAt
      this.closedCode = 0
      this.#mark('online')
      this.log('[channel] 已连上 ' + String(this.config.channel?.wsUrl || ''))
      // 同一段空档只补一次：协议端刚起来、或者本机同时开了两份 NapCat 时，
      // open 会在两三秒里连抖好几下，每一下都去挨个会话拉历史（实测 1.3 秒补了 11 次）。
      // 补回是「补事实」，重复补既没用又白打一串接口。
      const at = this.now()
      if (this.lastReconnectAt && at - this.lastReconnectAt < 5000) return
      this.lastReconnectAt = at
      // 掉线期间的消息不会自己回来：连上后让上层按 since ~ now 去补。
      // 第一次连上也通知一次（since = 0），上层用「最后一条事件的时间」兜底。
      try {
        const result = this.onReconnect?.({ since, until: at, first, ms: since ? Math.max(0, at - since) : 0 })
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch {
        // 补回失败不该影响收发
      }
    })

    ws.addEventListener('message', (frame) => {
      if (!mine()) return
      // 任何一帧都算「这条连接还活着」—— 心跳、事件、echo 回执都算
      this.lastFrameAt = this.now()
      let payload
      try {
        payload = JSON.parse(typeof frame.data === 'string' ? frame.data : String(frame.data))
      } catch {
        return // 半个包、脏包直接丢，不能让一行坏数据打断循环
      }
      this.#handle(payload)
    })

    ws.addEventListener('error', () => {
      if (!mine()) return
      // 具体原因在 close 里给，这里只记一笔，避免重复刷屏
      this.lastError = '连接出错'
    })

    ws.addEventListener('close', (event) => {
      // 旧 socket 的迟到事件：不许改状态、不许触发重连
      if (!mine()) return
      const wasOnline = this.connected
      const code = Number(event?.code) || 0
      const reason = String(event?.reason || '').slice(0, 80)
      this.closedCode = code
      this.ws = null
      // 稳过 30 秒才算「真的连上过」。连上就断的抖动不清零退避 ——
      // 否则退避永远压在 1 秒，变成高频重连，对协议端和自己都是负担。
      const stable = this.openedAt > 0 && this.now() - this.openedAt >= STABLE_MS
      if (wasOnline && !this.stopped) this.downAt = this.now()
      this.connected = false
      if (this.stopped) return
      if (stable) this.retries = 0
      this.#mark('offline')
      if (wasOnline || code) {
        this.log('[channel] 连接断了（code ' + code + (reason ? '：' + reason : '') + '），准备重连')
      }
      this.#scheduleReconnect()
    })

    return { ok: true, state: this.state() }
  }

  /**
   * 退避重连：1s、2s、4s…最多 60s，带一点随机抖动。
   * 不做「立刻重连」——NapCat 刚崩的时候，立刻重连会把日志刷满、也拖慢它恢复。
   * 抖动是为了别在两份实例/两个进程同时掉线时踩同一个节拍。
   */
  #scheduleReconnect() {
    if (this.stopped) return
    this.retries += 1
    const base = Math.min(60_000, 1000 * 2 ** Math.min(6, this.retries - 1))
    const wait = Math.round(base * (0.85 + Math.random() * 0.3))
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.#connect()
    }, wait)
    this.retryTimer.unref?.()
  }

  /**
   * 看门狗用的一脚：确认「还在重连」这件事没停，而不是把它打断重来。
   *
   * 以前看门狗是 `stop(); start()` —— 每分钟强行断一次，退避永远清零，
   * 而且每次断连都要写 off / unknown / offline 三条状态（实测一天四千多条审计）。
   * 通道自己本来就在按 1→30 秒退避重连，外部只需要在**没有待重连定时器**时补一脚。
   *
   * @returns {{ok:boolean, action:'idle'|'connecting'|'waiting'|'stopped'}}
   */
  ensureRetrying() {
    if (this.stopped) return { ok: false, action: 'stopped' }
    if (this.connected) return { ok: true, action: 'idle' }
    if (this.retryTimer) return { ok: true, action: 'waiting' }
    this.#connect()
    return { ok: true, action: 'connecting' }
  }

  #handle(payload) {
    // 先处理「谁在等这个响应」
    if (payload && payload.echo && this.pending.has(String(payload.echo))) {
      const entry = this.pending.get(String(payload.echo))
      this.pending.delete(String(payload.echo))
      clearTimeout(entry.timer)
      if (payload.status === 'ok' || payload.retcode === 0) entry.resolve(payload.data)
      else entry.reject(new Error(String(payload.wording || payload.message || 'OneBot 返回失败')))
      return
    }

    // 心跳里带 self_id，顺手记下来：配置里没填也能工作
    if (payload?.post_type === 'meta_event' && payload.self_id) {
      this.selfId = String(payload.self_id)
    }

    if (String(payload?.post_type || '') === 'message') {
      if (!this.seenMessages) this.seenMessages = new Map()
      const fingerprint = [
        payload.message_type, payload.group_id || '', payload.user_id || '',
        payload.time || '', payload.raw_message || JSON.stringify(payload.message || ''),
      ].join('|')
      const lastAt = this.seenMessages.get(fingerprint) || 0
      const now = Date.now()
      if (now - lastAt < 15_000) return
      this.seenMessages.set(fingerprint, now)
      while (this.seenMessages.size > 300) this.seenMessages.delete(this.seenMessages.keys().next().value)
    }

    const raw = toRaw(payload, { selfId: String(this.config.channel?.selfId || '') || this.selfId || '' })
    if (!raw) return
    try {
      this.onRaw?.(raw)
    } catch (error) {
      this.lastError = String(error?.message || error)
      this.log('[channel] 处理事件出错：' + this.lastError)
    }
  }

  /** 发一个 OneBot 动作，带超时。返回值是 data，失败抛错 */
  sendRaw(action, params = {}, timeoutMs = 8000) {
    if (!this.connected || !this.ws) return Promise.reject(new Error('还没连上通道'))
    // connected 只是「我们认为连着」；socket 自己可能已经在 CLOSING/CLOSED 了。
    // 不查这一下，消息会安静地写进一个死 socket，然后等 8 秒超时 —— 用户看到的是「卡住了」。
    const ready = this.ws.readyState
    if (ready !== undefined && ready !== 1) return Promise.reject(new Error('通道正在断开，这条没发出去'))
    this.echoSeq += 1
    const echo = `e${this.echoSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error('等通道回应超时'))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(echo, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(error)
      }
    })
  }

  /** 机器人当前加入的群；拿不到就返回空数组（调用方不要因此拒绝发送） */
  async groupList() {
    try {
      const data = await this.sendRaw('get_group_list', {}, 8000)
      const list = Array.isArray(data) ? data : []
      if (list.length) this.#rememberGroups(list)
      return list
    } catch {
      return []
    }
  }

  /**
   * 刷新群名缓存。面板要显示群名，但 get_group_list 是异步的，
   * 所以「谁在联网时顺手刷一次」由上层决定（连上、定时、打开群列表）。
   * @param {{force?: boolean, maxAgeMs?: number}} [options]
   */
  async refreshGroups(options = {}) {
    const maxAge = Math.max(60_000, Number(options.maxAgeMs) || 30 * 60_000)
    if (!options.force && this.groupsAt && Date.now() - this.groupsAt < maxAge) {
      return { ok: true, cached: true, count: this.groups.size }
    }
    if (this.state() !== 'online') return { ok: false, error: '通道不在线，问不到群列表', count: this.groups.size }
    const list = await this.groupList()
    if (!list.length) return { ok: false, error: '协议端没给出群列表', count: this.groups.size }
    return { ok: true, count: this.groups.size }
  }

  /** 同步取群名：面板每帧都要用，不能等网络 */
  groupNameOf(groupId) {
    const id = String(groupId || '').replace(/\D/g, '')
    if (!id) return ''
    const hit = this.groups.get(id)
    return hit ? String(hit.name || '') : ''
  }

  #rememberGroups(list) {
    const at = this.now()
    let changed = false
    for (const item of list) {
      const id = String(item?.group_id ?? item?.groupId ?? '').replace(/\D/g, '')
      if (!id) continue
      const name = String(item?.group_name ?? item?.groupName ?? '').trim()
      const prev = this.groups.get(id)
      if (!prev || (name && prev.name !== name)) {
        this.groups.set(id, { id, name: name || (prev ? prev.name : ''), at })
        changed = true
      }
    }
    this.groupsAt = at
    if (changed) this.#saveGroups()
  }

  #loadGroups() {
    if (!this.groupsFile || !existsSync(this.groupsFile)) return
    try {
      const raw = JSON.parse(readFileSync(this.groupsFile, 'utf8'))
      const rows = raw && typeof raw.groups === 'object' ? raw.groups : {}
      for (const [id, value] of Object.entries(rows)) {
        const key = String(id).replace(/\D/g, '')
        if (!key) continue
        this.groups.set(key, { id: key, name: String(value?.name || ''), at: Number(value?.at) || 0 })
      }
      this.groupsAt = Number(raw.at) || 0
    } catch {
      // 缓存坏了就当没有：下次连上会重新问一遍，不影响收发
    }
  }

  #saveGroups() {
    if (!this.groupsFile) return
    try {
      const groups = {}
      for (const [id, value] of this.groups) groups[id] = { name: value.name, at: value.at }
      writeJson(this.groupsFile, { at: this.groupsAt, groups })
    } catch {
      // 写不进去只影响「下次启动时的显示」，不值得让调用方失败
    }
  }

  /** 取一条被引用的消息正文；失败返回 ok:false，不让引用拖垮整轮 */
  async getMessage(id) {
    try {
      // 各协议端对 message_id 的类型要求不同：先按字符串，再按数字，别一次失败就放弃
      let data
      try {
        data = await this.sendRaw('get_msg', { message_id: String(id) }, 8000)
      } catch {
        data = await this.sendRaw('get_msg', { message_id: Number(id) || id }, 8000)
      }
      // get_msg 各协议端/配置下 message 可能是数组，也可能是 CQ 码字符串；
      // 只认数组会让「引用」静默变空（旧版就踩过这个坑）。
      const segments = segmentsOf(data?.message ?? data?.raw_message)
      const text = segments.map((seg) => {
        const type = String(seg?.type || '')
        if (type === 'text') return String(seg?.data?.text || '')
        if (type === 'face') return `[face:${String(seg?.data?.id || '')}]`
        if (type === 'at') {
          const qq = String(seg?.data?.qq || '')
          return qq ? (qq === 'all' ? '@全体成员' : `@${qq}`) : ''
        }
        if (type === 'file') return `[文件:${String(seg?.data?.name || seg?.data?.file || '')}]`
        if (type === 'record') return '[语音]'
        return ''
      }).join('').trim()
      const images = segments
        .filter((seg) => seg?.type === 'image')
        .map((seg) => ({
          file: String(seg?.data?.file || ''),
          url: String(seg?.data?.url || ''),
          summary: String(seg?.data?.summary || ''),
        }))
      const forward = segments.find((seg) => seg?.type === 'forward')
      return {
        ok: true,
        text,
        sender: String(data?.sender?.card || data?.sender?.nickname || ''),
        images,
        forwardId: String(forward?.data?.id || forward?.data?.resid || ''),
      }
    } catch (error) {
      return { ok: false, text: '', sender: '', images: [], forwardId: '', error: String(error?.message || error) }
    }
  }

  /**
   * 拉一段历史消息（掉线补回用）。
   * 只做归一化：谁、什么时候、说了什么、带了什么图。该不该记、去不去重由调用方决定。
   * @param {string} conversation 'group:123' / 'private:456'
   * @param {{count?:number}} [options]
   */
  async getHistory(conversation, options = {}) {
    const [scope, id] = String(conversation || '').split(':')
    if (!id || (scope !== 'group' && scope !== 'private')) return []
    const count = Math.max(1, Math.min(100, Number(options.count) || 30))
    const items = []
    try {
      if (scope === 'group') {
        const data = await this.sendRaw('get_group_msg_history', { group_id: Number(id) || id, count }, 10000)
        items.push(...(Array.isArray(data) ? data : data?.messages || data?.message || []))
      } else {
        // NapCat 用 get_friend_msg_history；别的实现可能叫 get_private_msg_history
        let data = null
        for (const action of ['get_friend_msg_history', 'get_private_msg_history']) {
          try {
            data = await this.sendRaw(action, { user_id: Number(id) || id, count }, 10000)
            break
          } catch {}
        }
        items.push(...(Array.isArray(data) ? data : data?.messages || data?.message || []))
      }
    } catch {
      return []
    }
    const selfId = String(this.selfId || this.config.channel?.selfId || '')
    return items
      .map((item) => historyItem(item, { scope, id, selfId }))
      .filter(Boolean)
      .sort((a, b) => a.at - b.at)
  }

  /** 展开合并转发。limit 默认 8；read_forward_more 会要更多 */
  async getForward(id, limit = 8) {
    try {
      const data = await this.sendRaw('get_forward_msg', { id: String(id || '') }, 10000)
      const nodes = Array.isArray(data?.messages) ? data.messages : Array.isArray(data?.message) ? data.message : []
      const max = Math.max(1, Math.min(50, Number(limit) || 8))
      return nodes.slice(0, max).map((node) => {
        const sender = String(node?.sender?.card || node?.sender?.nickname || node?.nickname || '')
        const segments = Array.isArray(node?.content) ? node.content : Array.isArray(node?.message) ? node.message : []
        const text = segments.map((seg) => (seg?.type === 'text' ? String(seg?.data?.text || '') : seg?.type === 'image' ? '[图片]' : seg?.type === 'face' ? '' : '')).join('').trim()
        const images = segments.filter((seg) => seg?.type === 'image').length
        const time = Number(node?.time) * 1000 || 0
        return { sender, text, images, time }
      }).filter((row) => row.text || row.images)
    } catch {
      return []
    }
  }

  /** 取文件的下载地址：群文件、私聊文件两条接口都试，最后退回 get_file */
  async fileUrl(input = {}) {
    const fileId = String(input.fileId || input.file || '')
    if (!fileId) return { ok: false, error: '没有文件标识' }
    const attempts = []
    if (input.groupId) {
      attempts.push(['get_group_file_url', { group_id: Number(input.groupId) || input.groupId, file_id: fileId, busid: Number(input.busid) || 0 }])
    }
    if (input.userId) {
      attempts.push(['get_private_file_url', { user_id: Number(input.userId) || input.userId, file_id: fileId }])
    }
    attempts.push(['get_file', { file_id: fileId }])
    for (const [action, params] of attempts) {
      try {
        const data = await this.sendRaw(action, params, 10000)
        const url = String(data?.url || data?.file || '')
        if (/^https?:/i.test(url)) return { ok: true, url }
        if (url && /^[A-Za-z]:[\\/]/.test(url)) return { ok: true, file: url }
        if (data?.base64) return { ok: true, base64: String(data.base64) }
      } catch {}
    }
    return { ok: false, error: '拿不到下载地址' }
  }

  /** 发 QQ 空间说说。协议端没这个接口时会明确报错，不假装发成功 */
  async sendQzone(content, ugcRight = 1) {
    const text = String(content || '').trim()
    if (!text) throw new Error('说说正文是空的')
    try {
      return await this.sendRaw('send_qzone_msg', { content: text.slice(0, 2000), ugc_right: Number(ugcRight) || 1 }, 15_000)
    } catch (error) {
      throw new Error(friendlySendError(error))
    }
  }

  /** 群里 @ 一个人再说一句话。只对群生效 */
  async sayAt(groupId, uin, text) {
    const id = String(uin || '').replace(/\D/g, '')
    if (!id) throw new Error('要 @ 的 QQ 号是空的')
    const message = [
      { type: 'at', data: { qq: id } },
      { type: 'text', data: { text: ' ' + String(text || '') } },
    ]
    try {
      return await this.sendRaw('send_group_msg', { group_id: Number(groupId) || groupId, message })
    } catch (error) {
      throw new Error(friendlySendError(error))
    }
  }


  async groupMembers(id) {
    try {
      const data = await this.sendRaw('get_group_member_list', { group_id: Number(id) || id }, 10000)
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  }

  async leaveGroup(id) {
    await this.sendRaw('set_group_leave', { group_id: Number(id) || id, is_dismiss: false }, 10000)
    return { ok: true }
  }

  /** 通过协议端取图片：返回本地文件 / base64 / 新 url，避免只用过期 CDN 链接 */
  async getImage(file) {
    try {
      const data = await this.sendRaw('get_image', { file: String(file || '') }, 15000)
      return {
        file: String(data?.file || ''),
        url: String(data?.url || ''),
        base64: String(data?.base64 || ''),
      }
    } catch {
      return { file: '', url: '', base64: '' }
    }
  }

  /** 取语音文件；优先让协议端转成 wav，识别器只吃 wav */
  async getRecord(file) {
    try {
      const data = await this.sendRaw('get_record', { file: String(file || ''), out_format: 'wav' }, 15000)
      return { file: String(data?.file || ''), url: String(data?.url || ''), base64: String(data?.base64 || '') }
    } catch {
      return { file: '', url: '', base64: '' }
    }
  }

  /** 发一张本地图片（表情包）。file 为绝对路径；优先 base64，协议端读不到本地盘时也不会挂 */
  async sendImage(scope, target, file) {
    const local = String(file || '')
    if (!local) throw new Error('图片路径是空的')
    let data = null
    try {
      if (existsSync(local) && statSync(local).size <= 8 * 1024 * 1024) data = readFileSync(local)
    } catch {}
    const message = data
      ? [{ type: 'image', data: { file: 'base64://' + data.toString('base64') } }]
      : [{ type: 'image', data: { file: 'file:///' + local.replace(/\\/g, '/').replace(/ /g, '%20') } }]
    try {
      if (scope === SCOPE.GROUP) return await this.sendRaw('send_group_msg', { group_id: Number(target) || target, message })
      return await this.sendRaw('send_private_msg', { user_id: Number(target) || target, message })
    } catch (error) {
      this.#noteSendFailure('image', target, error)
      throw new Error(friendlySendError(error))
    }
  }

  /** 发一句话。scope 决定调哪个接口 —— 这是唯一会用到 scope 的地方 */
  async say(scope, target, text) {
    const raw = String(text || '')
    let message = raw
    if (/\[face:\d+\]/.test(raw)) {
      message = []
      let last = 0
      const re = /\[face:(\d+)\]/g
      let match
      while ((match = re.exec(raw))) {
        const before = raw.slice(last, match.index)
        if (before) message.push({ type: 'text', data: { text: before } })
        message.push({ type: 'face', data: { id: String(match[1]) } })
        last = match.index + match[0].length
      }
      const after = raw.slice(last)
      if (after) message.push({ type: 'text', data: { text: after } })
    }
    if (Array.isArray(message) ? message.length === 0 : !String(message).trim()) throw new Error('要发的内容是空的')
    try {
      if (scope === SCOPE.GROUP) {
        return await this.sendRaw('send_group_msg', { group_id: Number(target) || target, message })
      }
      return await this.sendRaw('send_private_msg', { user_id: Number(target) || target, message })
    } catch (error) {
      this.#noteSendFailure('say', target, error)
      throw new Error(friendlySendError(error))
    }
  }

  /**
   * 亮一下「对方正在输入」。
   *
   * 这是 NapCat 的非标准接口（set_input_status），旧协议端根本没有；
   * 所以**失败不抛**：亮不出来只是少一点真实感，不该拖累一条已经生成好的回复。
   * event_type=1 是「正在输入」。取消（0）不发 —— 消息一落地，客户端自己就清掉了。
   */
  async inputStatus(scope, target) {
    const params = scope === SCOPE.GROUP
      ? { group_id: Number(target) || target, event_type: 1 }
      : { user_id: Number(target) || target, event_type: 1 }
    try {
      return await this.sendRaw('set_input_status', params, 3000)
    } catch {
      return null
    }
  }
}

/**
 * 把发送错误翻成人话。
 *
 * 这条链上有三层会报错，处置方式完全不同 —— 所以先分类再说话：
 *   · 本地/链路：还没连上、等通道回应超时      → 查通道（去设置看连没连上）
 *   · 协议端：retcode 非 0（群不存在、没权限）  → 查目标（群号/好友关系）
 *   · QQ 内核：NTEvent 里 result 非 0           → 查账号（风控/禁言），这层最容易被当成"插件坏了"
 *
 * 以前一律原样拼上「发送失败：」，用户只能看到一坨英文和一串数字，
 * 不知道该动账号、动群设置，还是动代码。翻成人话比留原文有用。
 */
export function friendlySendError(error) {
  const raw = String((error && error.message) || error || '').replace(/\s+/g, ' ').trim()

  if (/移出该群|移出群|你已被移出|已被踢|not in group|群聊.*不存在|group.*not.*exist/i.test(raw)) {
    return '发送失败：你已不在这个群（可能被移出或群已解散），先重新加群再试。'
  }
  // 链路层：这几句是本插件自己抛的（lib/qq/onebot.mjs 的 sendRaw / ensureRetrying）
  if (/还没连上通道|等通道回应超时|通道正在断开/.test(raw)) {
    return '发送失败：和协议端的连接断了或者卡住了。去「设置 → QQ 连接」看一眼在线状态，必要时重连。'
  }
  // QQ 内核层：NTEvent 的 sendMsg 回执非 0。这类不是网络问题，是「这一条被 QQ 拒了」。
  if (/NodeIKernelMsgService\/sendMsg/i.test(raw)) {
    const code = (raw.match(/"result"\s*:\s*(-?\d+)/) || [])[1] || ''
    return `发送失败：QQ 内核拒绝了这条消息${code ? `（result ${code}）` : ''}。这不是网络问题。先拿手机 QQ 用同一个号发一条：手机也发不出就是账号被限制了（去 aq.qq.com 解限）；手机能发就查这个群有没有禁言、或者换个群再试。`
  }
  if (/禁言|mute|silence|仅管理员/i.test(raw)) {
    return '发送失败：这个群现在不让你发（可能被禁言，或设成了仅管理员发言）。'
  }
  if (/单向好友|not friend|不在好友|拉黑|blacklist|拒绝接收/i.test(raw)) {
    return '发送失败：对方可能已经删了你或拉黑了你，这条发不出去。'
  }
  return '发送失败：' + raw.slice(0, 160)
}
