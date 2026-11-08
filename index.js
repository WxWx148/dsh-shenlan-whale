/**
 * dsh-shenlan-whale — 宿主入口。
 *
 * 这个文件只做三件事（其余都在 lib/ 里分层）：
 *   1. 建运行时，并把通道、限流、计费、生成四层接起来；
 *   2. 把运行时的方法挂成 `/api/shenlan/*` 路由，面板与外部工具都走这里；
 *   3. 跟随插件生命周期起停，**任何一块失败只降级、不拖垮宿主**。
 *
 * 为什么每一块都包 try：插件挂了会连累整个宿主起不来。
 * 少一个能力最坏是「不能用」，插件崩了是「整个应用打不开」——两害相权，宁可少能力。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

import { Runtime } from './app/index.mjs'
import { Guard } from './decide/index.mjs'
import { TypingDesk } from './voice/index.mjs'
import { AttentionDesk } from './decide/index.mjs'
import { Cadence } from './decide/index.mjs'
import { Usage } from './facts/index.mjs'
import { Turn } from './turn/index.mjs'
import { Chat } from './app/index.mjs'
import { panelView, detailView } from './view/index.mjs'
import { runDebug } from './view/index.mjs'
import { tracePass } from './base/log.mjs'
import { peerOf } from './view/index.mjs'
import { card } from './voice/index.mjs'
import { createTools } from './ability/index.mjs'
import { addWant, dropWant, listWants, refuse, resolveWant, wantStats } from './mind/index.mjs'
import { describeAt, parseReminder, parseWhen } from './life/index.mjs'
import { Sandbox } from './ability/index.mjs'
import { approvalText } from './ability/index.mjs'
import { KIND, SCOPE } from './facts/index.mjs'
import { eventKeyOf, createEventHub } from './app/index.mjs'
import { listOf } from './view/index.mjs'
import { assetOf } from './app/index.mjs'
import { failure, failureFrom, normalizeFailure } from './app/index.mjs'
import { runAction } from './app/index.mjs'
import { searchWebDetailed, readWeb, configureNet, netStatus } from './ability/index.mjs'
import { runActivityStep } from './life/index.mjs'
import { activitySpend } from './life/index.mjs'
import { createHostRunner, workspaceOf } from './app/index.mjs'
import { OneBotChannel, NapCatLogin, backfillMissed } from './channel/index.mjs'
import { attachImages, pruneMedia } from './ability/index.mjs'
import { createTicker } from './base/ticker.mjs'
import { writeJson } from './base/core.mjs'

export const name = 'shenlan-whale'
export const inject = ['webServer', 'llm']

const ROUTE_PREFIX = '/api/shenlan'

/**
 * 最近一次面板请求里前端自报的现场（见 client.panel.js 的 CLIENT_REV）。
 * rev 是样式长度；w / vw / left 分别是插件根节点宽度、浏览器视口宽度、根节点左偏移；
 * ow 是因此被外层裁掉的像素数。排查"右边被切掉"时，这几个数是唯一能当作事实的东西 ——
 * 只看截图分不清是样式写宽了，还是宿主给的位置不够。
 */
let clientProbe = { rev: '', width: 0, viewport: 0, left: 0, overflow: 0, geo: '' }

/**
 * 当前配置修订号的读取器。装配完成后指向该实例的 Runtime。
 *
 * 每一个 HTTP 响应都带 revision：写操作让前端立刻刷新，读操作让前端在
 * 「别的窗口 / QQ 指令 / 外部改文件」导致配置变化时也能在下一轮轮询发现。
 * 放在 sendJson 里统一注入，而不是逐条路由加字段 —— 加一条新路由时
 * 不会有人忘记带，界面就不会出现「这一块永远不跟随」。
 */
let revisionOf = () => 0

function sendJson(res, status, value) {
  const revision = revisionOf()
  // 统一错误体的最后一道：业务模块透传的 ok:false 在这里补齐 code/hint/retry。
  // 放在 sendJson 而不是每个出口各写一遍，是因为「有没有漏」只需要看这一处。
  const normalized = value && typeof value === 'object' && !Array.isArray(value)
    ? normalizeFailure(value)
    : value
  const body = normalized && typeof normalized === 'object' && !Array.isArray(normalized) && !('revision' in normalized)
    ? { ...normalized, revision }
    : normalized
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 一句配置改动不该超过 64KB */
const MAX_BODY_BYTES = 64 * 1024

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      if (done) return
      // 按字节收，最后一次性解码。一个汉字三个字节，跨 chunk 被切开时
      // 逐块 toString() 会各自解成半个字（U+FFFD），配置里的中文就这么坏的。
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      size += buf.length
      if (size > MAX_BODY_BYTES) {
        // 超限当场给结论：destroy 之后 'end' 不一定会来，等它只会把请求挂住
        finish({})
        try { req.destroy() } catch {}
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        finish(raw ? JSON.parse(raw) : {})
      } catch {
        finish({})
      }
    })
    req.on('error', () => finish({}))
    req.on('close', () => finish({}))
  })
}

export function apply(ctx) {
  /**
   * 打到宿主控制台的一行。
   *
   * `log.level` 就是在这里生效的 —— 之前面板上那一项标着「暂不生效」，
   * 因为这里无条件 `logger.info`：改成 error 也照样刷屏。
   * 现在每条都带级别，低于门槛的直接不打（运行时没建起来时不做过滤，
   * 否则启动期的错误会被一个还没读到的配置吞掉）。
   */
  const logAt = (level, ...args) => {
    try {
      if (runtime && !tracePass(runtime.config, level)) return
      const redact = runtime?.config?.log?.redact !== false
      const token = String(runtime?.config?.channel?.token || '')
      const clean = (value) => {
        if (!redact) return value
        if (typeof value === 'string') return token ? value.split(token).join('***') : value
        if (value && typeof value === 'object') {
          try {
            const text = JSON.stringify(value)
            return token ? text.split(token).join('***') : text
          } catch { return value }
        }
        return value
      }
      const line = args.map(clean)
      // 宿主 logger 不一定有 warn/error，没有就退回 info —— 级别是过滤条件，不是接口约定
      const write = ctx.logger?.[level] || ctx.logger?.info
      write?.(...line)
    } catch {
      // 宿主日志不可用就安静，不影响功能
    }
  }

  const log = (...args) => logAt('info', ...args)

  const legacyDir = path.join(homedir(), '.dsh', 'shenlan-jing')
  const dataDir = process.env.SHENLAN_DATA_DIR || path.join(homedir(), '.dsh', 'shenlan-whale')
  try {
    if (!existsSync(dataDir) && existsSync(legacyDir)) cpSync(legacyDir, dataDir, { recursive: true })
  } catch (error) {
    log('[whale] 旧数据迁移失败，先使用新目录：' + String(error?.message || error))
  }
  const dir = dataDir

  let runtime
  try {
    runtime = new Runtime({ dir })
  } catch (error) {
    // 运行时都建不起来，说明数据目录不可写。这时挂一个只说状态的空壳，
    // 比让整个插件消失好 —— 至少面板能告诉用户「哪儿坏了」。
    log('[whale] 运行时建不起来：' + String(error?.message || error))
    return
  }
  // 把宿主 logger 交给运行时：审计回声、各模块的 trace 都走这一条出口，
  // 级别过滤只在一处判（base/log.mjs），不在每个调用点各写一遍。
  runtime.setTracer((level, text, detail) => logAt(level, text, detail))

  const guard = new Guard({ config: runtime.config })
  const usage = new Usage({ config: runtime.config, journal: runtime.audit, file: path.join(runtime.dir, 'usage.json') })
  // 把账本接到运行时上：status() 里的「今日 token / 今日花费 / 预算还剩」
  // 只有一处来源，面板不再自己拿 usage 再算一遍（算两遍迟早对不上）。
  runtime.usage = usage
  // 先接执行器，再建工具表：工具表构造时就会 registerTools，
  // 而「沙箱」到底能不能用，取决于执行器在不在这一份运行时上。
  // 确认请求要能走 QQ 私聊问人。notify 在这一行还建不出来（outbound 在后面），
  // 所以先给一个转发的壳，真正实现等出站口建好再填。
  let approvalNotifier = null
  const sandbox = new Sandbox({
    runtime,
    dir: runtime.dir,
    notify: (record) => (approvalNotifier ? approvalNotifier(record) : null),
  })
  runtime.sandbox = sandbox
  const channel = new OneBotChannel({ config: runtime.config, runtime, log })
  // 拟人打字台：全局只有一条在打（私聊群聊排同一队），按字数等、分条留缝、
  // 发之前顺手亮一下「正在输入」。节奏和 guard 的分工见 voice/typing.mjs 开头。
  const typing = new TypingDesk({ channel, log })
  // 注意力账本：群里「现在在跟谁说话」。窗口长度与轮数上限直接读 group.*，
  // 不新开配置键 —— 面板上少一个旋钮，就少一处「改了没用」的怀疑。
  const attention = new AttentionDesk({ config: runtime.config, log })
  // 掉线补回：连上后把断线期间漏掉的消息补进事件流。
  // 只记事实，不回话 —— 补回来的是「发生过」，不是「现在必须接」。
  channel.onReconnect = (info = {}) => {
    const at = Date.now()
    let since = Number(info.since) || 0
    if (!since) {
      // 进程重启也算一段空档：以上次落库的消息时间为界（按消息筛，别被心跳挡住）
      try {
        const rows = runtime.events.read({
          limit: 1,
          maxScan: 5000,
          filter: (row) => row.type === 'message' || row.type === 'image',
        }).rows || []
        since = Number(rows[0]?.at) || 0
      } catch {}
    }
    if (!since) return Promise.resolve({ ok: true, skipped: '没有上次消息时间' })
    // 最多补最近 6 小时：更早的交给面板翻，不在重连时打一串接口
    since = Math.max(since, at - 6 * 3600_000)
    // 顺手把群名刷一遍：连上之后才知道「123456 这个群叫什么」，
    // 面板上就不必先把群号摆出来再换名。
    channel.refreshGroups({ force: true }).catch(() => {})
    return backfillMissed({ runtime, channel, since, until: at, log }).catch((error) => {
      log('[whale] 掉线补回失败：' + String(error?.message || error))
      return { ok: false, error: String(error?.message || error) }
    })
  }
  /**
   * 有人申请加好友 / 申请进群：转告主人。
   *
   * 为什么不自己点同意：这是**权限**，不是聊天。主人没在场时替他把陌生人放进来，
   * 等于替他做安全决定；上游那版会自动批，代价是群可能被拉进广告号。
   * 这里只做「告诉他有人找」这一件事，点头的动作留给人。
   */
  const notifyOwnerOfRequest = (raw) => {
    const owner = String(runtime.config.identity?.ownerId || '')
    const req = raw?.payload?.request
    if (!owner || !req) return
    const isGroup = /group/.test(String(req.subType || ''))
    const what = isGroup ? `有人申请进群 ${req.groupId ?? ''}` : '有人申请加好友'
    const comment = String(req.comment || '').trim()
    const line = `${what}（QQ ${req.userId || '未知'}）${comment ? '。附言：' + comment.slice(0, 80) : '。没有附言'}`
    void outbound('private', owner, `${line}\n要同意的话去 QQ 里点一下 —— 这一步我不代劳。`).catch(() => {})
  }

  /**
   * 定时器/提醒直接发出去的话也要记成「我说过」，并顺手记一次额度。
   *
   * 两条都必须只有这一个出口：漏记「我说过」，下一轮上下文里就只有别人说的话；
   * 漏记额度，面板显示的条数与实际发出的条数会对不上，限流随之变得不可预测。
   */
  const noteSelf = (scope, target, text, count = 1, messageId = '') => {
    try {
      runtime.noteSelfMessage({ conversation: `${scope}:${target}`, scope, text, at: Date.now(), messageId })
    } catch {}
    try {
      guard.note(Date.now(), { scope, target, conversation: `${scope}:${target}` }, count)
    } catch {}
  }

  /**
   * 同一个会话最近发过的话。
   *
   * 为什么需要：注意力窗口是「热着就接话」，窗口里每条群消息都会触发一轮生成。
   * 两轮独立生成撞出同一句话时，人看到的是「它复读了」——
   * 而模型其实每次都觉得自己只说了第一遍。
   *
   * ⚠️ 但这只适用于**自发**消息（主动开口、播报、提醒），不适用于回话。
   *
   * 回话那一侧的去重在 decide/dedupe.mjs 里，口径是「同一条对方消息不回两遍」
   * 以及「同一轮生成内不说两遍一样的话」—— 跨轮次一律放行。
   * 为什么这里不能也拦内容：主人在私聊里问两遍同样的问题，
   * 深蓝答两遍是**正常的重新回答**，不是复读。
   * 把「主人再问一遍」拦掉，主人的体感是「它坏了」—— 那比复读难看得多。
   *
   * 所以这里只管自发消息之间的重复：主动开口撞车、日报重发、提醒重发。
   * 那才是真的机器人特征 —— 没人会在两分钟里主动说两遍一样的话。
   */
  const saidRecently = new Map()
  /** 复读被拦后「刚说过」这句提示的冷却：每个会话 60 秒最多一次 */
  const dupNoticeAt = new Map()
  const DUP_WINDOW_MS = 90_000
  const DUP_MIN_CHARS = 8
  const plainText = (text) => String(text || '').replace(/\s+/g, '').replace(/[，。！？、,.!?~～…—]/g, '')

  /**
   * 统一出站口 —— 回话、定时器、告警、提醒、审批都走这里，不许各自调通道。
   *
   * 收成一处之后，出站只有一条路：闸门 → 打字台 → 通道 → 记账。
   * 面板里的「代发」不走这里：那是用户点了发送，要的是立刻发出去，不是像人打字。
   */
  const outbound = async (scope, target, parts, options = {}) => {
    const list = (Array.isArray(parts) ? parts : [parts]).map((one) => String(one ?? '').trim()).filter(Boolean)
    if (!list.length) return { ok: false, reason: 'empty', lines: 0 }
    // 真正发一条：通道 + 记账必须成对。
    // 只记一边就会出现「说过但没算额度」，或者「算过额度但上下文里没有这句」，
    // 后者会让它把自己的话当成对方说的。两条路径都走它，通道出口就只有一个。
    const sendOne = async (one, record = true, count = 1) => {
      const sentOne = await channel.say(scope, target, one)
      noteSelf(scope, target, one, count, sentOne?.message_id || sentOne?.data?.message_id || '')
      if (!record) return
      // 发出去才算「说过」：发送失败不能进这份记录，否则下一句正常的话会被误拦
      const key = `${scope}:${target}`
      const rows = (saidRecently.get(key) || []).filter((row) => Date.now() - row.at < DUP_WINDOW_MS)
      rows.push({ text: one, at: Date.now() })
      saidRecently.set(key, rows)
    }
    // 系统消息：确认请求、它的回执这类。
    // 不能走打字台（按字数要等十几秒，60 秒的确认窗口等不起），
    // 也不能被夜间静音吞掉 —— 没人看见就等于默认拒绝，而用户根本不知道发生过这件事。
    if (options.system === true) {
      let lines = 0
      for (const one of list) {
        try {
          // 系统消息不是聊天回复，不占聊天额度
          await sendOne(one, true, 0)
        } catch (error) {
          return { ok: false, reason: 'send', error: String(error?.message || error), lines }
        }
        lines += 1
      }
      return { ok: true, lines }
    }
    // 复读拦截：同一会话 90 秒内已经说过一模一样的话，就不再发第二遍。
    // 放在闸门之前 —— 被拦下的本来就不该占额度，也不该出现在别人的聊天框里。
    //
    // 匹配口径：去掉标点空白后**完全一样**才算重复。
    //
    // 以前这里用的是「互相包含也算」—— 那会误伤：
    // 「今天天气不错」和「今天天气不错，你带伞了吗」互相包含，
    // 于是第二句被当成复读拦掉。可这是**两句不同的话**，
    // 主动开口说两句连贯的话是最像人的表现之一，拦掉它等于把拟人感剪掉。
    // 真人不会因为「跟刚才那句有点像」就闭嘴。
    const dupKey = `${scope}:${target}`
    const dupNow = Date.now()
    const earlier = (saidRecently.get(dupKey) || []).filter((row) => dupNow - row.at < DUP_WINDOW_MS)
    const fresh = list.filter((one) => {
      const body = plainText(one)
      if (body.length < DUP_MIN_CHARS) return true
      const hit = earlier.find((row) => plainText(row.text) === body)
      if (hit) {
        log('[whale] 复读拦下：' + one.slice(0, 30) + '（' + Math.round((dupNow - hit.at) / 1000) + ' 秒前说过）')
        runtime.log('outbound_duplicate', { conversation: dupKey, text: one.slice(0, 80), gapSeconds: Math.round((dupNow - hit.at) / 1000) })
        return false
      }
      return true
    })
    if (!fresh.length) {
      // 主人私聊里，复读被拦不再是「什么都没发生」：留一句人话，
      // 免得对方对着空气问「你怎么又不说话了」。带 60 秒冷却，不刷屏。
      const ownerId = String(runtime?.config?.identity?.ownerId || '')
      if (scope === 'private' && ownerId && String(target) === ownerId) {
        const last = Number(dupNoticeAt.get(dupKey) || 0)
        if (dupNow - last > 60_000) {
          dupNoticeAt.set(dupKey, dupNow)
          try { await sendOne('这句我刚说过，就不重复发了。', false, 0) } catch {}
        }
      }
      return { ok: false, reason: 'duplicate', lines: 0 }
    }
    list.length = 0
    list.push(...fresh)

    const gate = guard.check(Date.now(), options.event ? { event: options.event } : {})
    if (!gate.ok) {
      log('[whale] 这条没发出去：' + gate.why + '｜' + list[0].slice(0, 40))
      return { ok: false, reason: gate.why, text: gate.text, lines: 0 }
    }
    // 一条主动消息拆成几条气泡，额度上也只算一条回复
    let quotaNoted = false
    const result = await typing.typeOut({
      parts: list,
      scope,
      target,
      pace: () => guard.delay(Date.now()),
      say: async (one) => {
        const count = quotaNoted ? 0 : 1
        quotaNoted = true
        await sendOne(one, true, count)
      },
    })
    return result
  }
  /**
   * 把一条待确认请求发到 QQ 私聊。
   *
   * 只在「渠道开着 + 有主人号」时发；面板那一份永远在，不依赖这里。
   * 发不出去要记一行：用户以为「它没问过我」，其实是问了但没发出去。
   */
  approvalNotifier = async (record) => {
    const owner = String(runtime.config.identity?.ownerId || '')
    if (!owner || runtime.config.channel?.enabled === false) return { ok: false, reason: 'no_channel' }
    const text = approvalText(record)
    const result = await outbound('private', owner, text, { system: true })
    if (result?.ok !== true) {
      log('[whale] 确认请求没发到 QQ：' + String(result?.reason || result?.error || '未知原因'))
      // 进审计：只在终端留一行的话，事后问「它到底问没问我」就查不到证据。
      // 渠道掉线是常态（等扫码），这条记录让人能分清「没问」和「问了但没发出去」。
      runtime.log('sandbox_ask_undelivered', { reason: String(result?.reason || result?.error || ''), purpose: record.purpose })
    } else {
      log('[whale] 确认请求已发到 QQ：' + record.project + ' / ' + record.purpose)
    }
    return result
  }

  // 登录层：把「登录方式 / 自动出码」变成真的能执行的东西。
  // 它只负责 NapCat 的启动、登录阶段与重试；收发仍然只走 channel。
  const napcat = new NapCatLogin({ config: runtime.config, channel, log, dir })
  // 面板视图是同步的，从这里读登录快照；不要在 panel-view 里发请求。
  runtime.napcat = napcat
  // 先建通道再建工具表：发表情、@人、看头像这些工具需要通道，
  // 以前工具表先建、通道后建，只能靠运行时的全局变量补，结果是「工具在但发不出去」。
  //
  // mind / life 也是注入的（0.46.0）：能力层不再 import 心智层与生活层，
  // 「需求本怎么读、提醒怎么解析」由装配层决定。这就是 R3 想要的形状 ——
  // 依赖方向从「能力 → 心智」翻成「装配 → 两者」。
  const tools = createTools({
    runtime,
    channel,
    usage,
    dir: runtime.dir,
    mind: { addWant, dropWant, listWants, resolveWant, wantStats, refuse },
    life: { parseWhen, parseReminder, describeAt },
  })
  runtime.registerTools(['proactive'])

  function syncNapcatAutostart(config, login) {
    try {
      const startup = path.join(process.env.APPDATA || homedir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
      const file = path.join(startup, 'dsh-napcat-autostart.cmd')
      const configured = String(config.channel?.napcatBat || '')
      // 启动项优先调 NapCat 自己的 napcat.bat：用户脚本里写死的 `-q` 会无视登录方式。
      const plan = (() => {
        try {
          return login?.plan?.() || { args: [], uin: '' }
        } catch {
          return { args: [], uin: '' }
        }
      })()
      const target = plan.launchTarget || configured
      if (!target) return { ok: false, error: '没有配置 NapCat 启动脚本路径，也找不到安装目录' }
      const marker = path.join(path.dirname(configured || target), '.napcat-autostart-enabled')
      mkdirSync(startup, { recursive: true })
      // 启动项常驻；开关键只控制标记文件：关=保留启动项但跳过启动，用户自己双击。
      // 登录参数跟着配置走：扫码方式不再带 `-q`，票据/密码方式才带。
      // 密码只进进程环境，绝不写进这个 .cmd。
      const args = Array.isArray(plan.args) && plan.args.length ? ' ' + plan.args.map((one) => '"' + one + '"').join(' ') : ''
      const lines = ['@echo off', 'if not exist "' + marker + '" exit /b 0']
      if (plan.uin && plan.mode !== 'qr') lines.push('set "NAPCAT_QUICK_ACCOUNT=' + plan.uin + '"')
      lines.push('call "' + target + '"' + args)
      writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8')
      if (config.channel?.autoStartNapcat === true) writeFileSync(marker, '1', 'utf8')
      else if (existsSync(marker)) unlinkSync(marker)
      return { ok: true, enabled: config.channel?.autoStartNapcat === true }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  async function describeImageFile(file, question) {
    try { if (statSync(file).size > (Number(runtime?.config?.images?.maxBytes) || 6_000_000)) return { ok: false, error: '图片超过大小上限' } } catch { return { ok: false, error: '图片文件不存在' } }
    const agents = ctx.get('agents')
    const attachments = ctx.get('attachments')
    const llm = ctx.get('llm')
    if (!agents || !attachments || !llm) return { ok: false, error: '宿主没有 agents/attachments/llm' }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.() || {}
    const provider = String(selection.provider || '')
    const model = String(selection.model || '')
    if (!provider || !model) return { ok: false, error: '没有当前模型' }
    const info = await llm.resolveModelInfo(provider, model)
    if (!Array.isArray(info?.inputModalities) || !info.inputModalities.includes('image')) {
      return { ok: false, error: '当前模型不支持图片：' + model }
    }
    const ext = String(file).split('.').pop().toLowerCase()
    const mediaType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    const ref = await attachments.saveImage({ data: readFileSync(file), mediaType })
    const handle = await agents.create({ sessionId: 'vision-' + Date.now(), meta: { cwd: process.cwd() }, agentOptions: { provider, model } })
    try {
      const agent = handle.agent
      const session = agent.session
      const firstSeq = Number(session.seq) || 0
      agent.followup({
        id: randomUUID(),
        role: 'user',
        content: [
          { type: 'text', text: question || '这张图是什么？用中文一两句话描述，并给最多 5 个标签。' },
          { type: 'image', attachment: ref },
        ],
        source: { kind: 'user' },
      })
      await Promise.race([
        agent.whenIdle(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('看图超时')), 45000)),
      ])
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(firstSeq) : []
      let text = ''
      for (const ev of events) {
        if (ev.type === 'assistant/message') {
          const joined = (ev.data?.message?.content || []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('')
          if (joined.trim()) text = joined
        }
      }
      return text ? { ok: true, text } : { ok: false, error: '模型没有返回文字' }
    } finally {
      try { await handle.dispose() } catch {}
    }
  }

  // 定时器重入闸：同一个任务上一次还没跑完，这一次到点就跳过（见 base/ticker.mjs）。
  // 这些活里最慢的一步是模型调用，几十秒到两分钟都正常，而间隔往往就是 60 秒 ——
  // 「上一次还在跑」和「这一次到点了」会同时成立。没有这道闸，一次主动开口会发两遍、
  // 一次自主活动会重复烧两份 token，而 perDay 上限一份都拦不住（两份都在写之前读）。
  const ticker = createTicker({
    onError: (error, key) => log('[whale] 定时任务出错（' + key + '）：' + String(error?.message || error)),
  })

  /**
   * 存一次「今天已经做过什么」的状态。
   *
   * 为什么不能直接调 writeJson 就算完：它**不抛异常**，只返回 { ok:false, error }。
   * 早先这里用的是 writeFileSync，写不进去会抛，被外层 catch 记一条，事后能查到。
   * 换成原子写之后，写失败变成静默的 —— 而这几份状态正好管着「今天发过没有」：
   * 状态没存上，下一次到点就当成没发过，于是同一天再发一遍，日志里一个字都没有。
   * 所以失败必须留下痕迹。
   */
  function saveState(file, value) {
    const saved = writeJson(file, value)
    if (!saved || saved.ok !== true) {
      log('[whale] 状态没存上：' + path.basename(file) + '（' + String(saved?.error || '未知原因') + '）')
      return false
    }
    return true
  }

  /**
   * 日预算闸：超了就不再自己烧钱。
   *
   * 为什么自主这两路也要过它：预算闸挂在 turn.mjs 的回合入口上，
   * 而「主动开口」与「自主活动」根本不走回合 —— 它们各自起一次推理，
   * 绕开了回合入口的闸。结果是主人设了日预算，回话停了，
   * 但插件自己在外面照跑照烧，面板上的账还在涨。
   * 面板明明写着「超过就会停下并提醒」，而停下只对一半的路径生效。
   *
   * 与回话不同的是：这里是**静默**返回，不发消息。主人没在跟它说话，
   * 突然收到一句「我不干了」比继续跑更莫名其妙 —— 面板上的账会说明一切。
   */
  function budgetBlocks() {
    const budget = Number(runtime.config.usage?.budgetPerDay) || 0
    if (!budget) return false
    const usage = runtime.usage
    if (!usage || typeof usage.overBudget !== 'function') return false
    try {
      const state = usage.overBudget(Date.now())
      if (!state || !state.over) return false
      log('[whale] 日预算用完（' + Number(state.cost || 0).toFixed(2) + ' / ' + budget + '），自主这两路先不跑了')
      return true
    } catch {
      return false
    }
  }

  // 主动开口：默认关；每 60 秒看一次是否到点
  //
  // 节奏不按固定周期走 —— 用 Cadence（decide/cadence.mjs）：
  // 间隔在区间里随机，到点也有概率这轮忍住。
  // 固定 180 分钟整点报时是最像机器人的一种主动开口：
  // 主人看两天时间就知道它是机器，比复读还明显。
  const proactiveCadence = new Cadence({
    minMinutes: Number(runtime.config.proactive?.minGapMinutes) || undefined,
    maxMinutes: Number(runtime.config.proactive?.maxGapMinutes) || undefined,
  })
  const proactiveTimer = ticker.every(60_000, 'proactive', async () => {
    try {
      const cfg = runtime.config.proactive || {}
      if (cfg.enabled !== true || !activeRunner || channel.state() !== 'online') return
      if (budgetBlocks()) return
      const hour = new Date().getHours()
      if (hour < (cfg.startHour ?? 9) || hour >= (cfg.endHour ?? 23)) return
      const owner = String(runtime.config.identity?.ownerId || '')
      if (!owner) return
      const file = path.join(dir, 'proactive.json')
      let state = { day: '', count: 0, lastAt: 0 }
      try { state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) } } catch {}
      const day = new Date().toDateString()
      if (state.day !== day) state = { day, count: 0, lastAt: 0 }
      if (state.count >= (cfg.perDay ?? 3)) return
      // 节奏闸：间隔没到、或者到点了这轮忍住，都不说。
      // 每天上限、作息时段、预算这三道闸一个没松 —— 随机只改间隔，不改「能不能说」。
      proactiveCadence.restore(state)
      const gate = proactiveCadence.check(Date.now())
      if (!gate.ok) return
      // 老配置只按固定间隔算：没到固定间隔就不说，保持原来的行为
      if (cfg.intervalMinutes && Date.now() - Number(state.lastAt || 0) < (cfg.intervalMinutes ?? 180) * 60_000) return
      const scene = { morning: '现在是早上，说一句带早安意味的', night: '现在是深夜，说一句轻一点、别吵人的', care: '说一句关心主人身体或心情的', general: '随口说一句' }[cfg.scene] || '随口说一句'
      const result = await activeRunner('你是深蓝鲸。' + scene + '短话，20-50字，像真人随手发的，不要提问，不要解释。', { conversation: 'private:' + owner })
      // 主动开口是自主推理，不是回话：走自主活动自己的账本，不挂靠思维链。
      // 以前这一路既不写带来源的 cot、也不记 usage，面板上完全看不到这笔消耗。
      const spent = activitySpend(runtime, result, { kind: 'proactive' })
      if (!result || !result.text) return
      runtime.logActivity?.({
        at: Date.now(),
        kind: 'proactive',
        text: '主动跟主人说了一句：' + String(result.text).slice(0, 120),
        source: 'auto',
        tokens: spent,
      })
      // 主动开口和群里插话都只进活动账本，不再写思维链。
      // 思维链只保留聊天回合；自主活动在「活动」页单独看。
      await outbound('private', owner, result.text)
      state.count += 1
      state.lastAt = Date.now()
      // 把抽到的间隔一起存下来：重启后不能用新的间隔去比旧的 lastAt，
      // 否则「上次什么时候说的」和「该隔多久」对不上，节奏会乱。
      Object.assign(state, proactiveCadence.markSpoke(state.lastAt))
      saveState(file, state)
      log('[whale] 主动开口：' + result.text.slice(0, 50))
    } catch (error) {
      log('[whale] 主动开口失败：' + String(error?.message || error))
    }
  })
  proactiveTimer.unref?.()

  // 自主活动：自己的时间，只写活动日志，不打扰任何人。
  // 只记真的发生过的事：想查什么 → 真的联网查 → 把查到的原文与来源记下来。
  // 旧版让模型「写下你做了什么」，而它什么也没做 —— 那部分整个删掉。
  const activityTimer = ticker.every(60_000, 'activity', async () => {
    try {
      const cfg = runtime.config.activity || {}
      if (cfg.enabled !== true || !activeRunner) return
      if (budgetBlocks()) return
      const hour = new Date().getHours()
      if (hour < 9 || hour >= 23) return
      const stateFile = path.join(runtime.dir || '', 'activity-state.json')
      let state = { day: '', count: 0, lastAt: 0 }
      try { state = { ...state, ...JSON.parse(readFileSync(stateFile, 'utf8')) } } catch {}
      const day = new Date().toDateString()
      if (state.day !== day) state = { day, count: 0, lastAt: 0 }
      if (state.count >= (Number(cfg.maxPerDay) || 12)) return
      if (Date.now() < Number(state.nextAt || 0)) return
      if (Date.now() - Number(state.lastAt || 0) < (Number(cfg.tickMinutes) || 45) * 60_000) return
      const step = await runActivityStep({ runtime, runner: activeRunner, config: runtime.config })
      const mins = Number(step.nextMinutes) || Number(cfg.tickMinutes) || 45
      // 没想出搜索词也要按节奏推迟，否则会每分钟重试、白烧 token
      state.nextAt = Date.now() + mins * 60_000
      state.lastAt = Date.now()
      if (step.ok) state.count += 1
      saveState(stateFile, state)
    } catch (error) {
      log('[whale] 自主活动失败：' + String(error?.message || error))
    }
  })
  activityTimer.unref?.()

  // QQ 掉线且没事做时：按兴趣自己去翻网页，把看到的记进自主活动和自我认知
  let lastLearnedAt = 0
  const learnTimer = ticker.every(30 * 60_000, 'learn', async () => {
    try {
      const cfg = runtime.config.activity || {}
      if (cfg.enabled !== true || channel.state() === 'online') return
      if (Date.now() - lastLearnedAt < 45 * 60_000) return
      const interests = Array.isArray(runtime.config.group?.interests) && runtime.config.group.interests.length
        ? runtime.config.group.interests
        : ['游戏', '观鸟', '硬件', 'AI']
      const topic = String(interests[Math.floor(Math.random() * interests.length)] || '').trim()
      if (!topic) return
      const rows = await searchWebDetailed(topic + ' 最新 资讯', 3)
      if (!Array.isArray(rows) || !rows.length) return
      const pick = rows[0]
      let body = String(pick.snippet || '')
      if (pick.url) {
        const page = await readWeb(pick.url, 1200)
        if (page.ok) body = String(page.text || '').slice(0, 600)
      }
      const text = `自己翻了翻「${topic}」：${String(pick.title || '').slice(0, 80)}。${body.replace(/\s+/g, ' ').slice(0, 260)}`
      runtime.logActivity({ kind: 'learn', text })
      // 搜索摘要不是「自我认知」：这里只进活动账本，不写 memory.self。
      // 以前把整段网页摘要写进去，自我认知页看起来全是百科/新闻。
      lastLearnedAt = Date.now()
      log('[whale] 掉线自学：' + topic)
    } catch (error) {
      log('[whale] 掉线自学失败：' + String(error?.message || error))
    }
  })
  learnTimer.unref?.()

  // 掉线自愈：先重连，再让登录层判断是「没启动」还是「没登录」。
  // 正在等扫码 / 已扫码等确认时**绝不重启** —— 那会把用户正要扫的码作废。
  // 和参考实现（QQFish watchdog）对齐：断线 2 分钟才开始考虑重启，每小时最多 2 次；
  // 重启只动 NapCat 自己的进程，不碰用户正在用的 QQ.exe。
  let offlineSince = 0
  let lastWatchdogAt = 0
  let watchdogRecovering = false
  const watchdogTimer = ticker.every(60_000, 'watchdog', async () => {
    try {
      // 群名缓存顺手续一下（30 分钟节流，不额外发请求）。
      if (channel.state() === 'online') channel.refreshGroups().catch(() => {})
      const cfg = runtime.config.channel || {}
      if (cfg.watchdogEnabled !== true || cfg.enabled !== true) { offlineSince = 0; return }
      const now = Date.now()
      // 电脑睡眠 / 进程被挂起时，定时器不会跑。醒来后第一次 tick 如果看到
      // 已经离线，不能从「现在」重新等 2 分钟 —— 那等于把睡眠前那一段丢了。
      // 用两次 tick 的间隔判断是否刚醒，醒后直接按已离线处理。
      const previousTick = lastWatchdogAt
      lastWatchdogAt = now
      const justWoke = previousTick > 0 && now - previousTick > 3 * 60_000
      if (channel.state() === 'online') {
        offlineSince = 0
        watchdogRecovering = false
        return
      }
      if (!offlineSince) offlineSince = justWoke ? previousTick : now
      // 连接假死（TCP 没断、帧不再来）只有它能发现；它只动 WebSocket，不杀进程。
      try {
        if (typeof channel.checkHealth === 'function') channel.checkHealth()
        else channel.ensureRetrying?.()
      } catch {}
      const downMs = now - offlineSince
      if (downMs < Math.max(1, Number(cfg.watchdogMinutes) || 2) * 60_000) return
      // 恢复本身可能卡在 NapCat 的登录/重启流程里。给它一个硬上限，
      // 不能让 ticker 的 in-flight 闸把看门狗永久锁死。
      if (watchdogRecovering) return
      watchdogRecovering = true
      let result
      try {
        result = await Promise.race([
          napcat.recover({ downMs, reason: 'watchdog' }),
          new Promise((resolve) => setTimeout(() => resolve({
            ok: false,
            restarted: false,
            error: '看门狗恢复超时（100 秒）',
          }), 100_000)),
        ])
      } finally {
        watchdogRecovering = false
      }
      if (result?.restarted) {
        runtime.log('napcat_recover', {
          downMs,
          attempt: result.attempt,
          phase: result.phase,
          after: result.after,
          online: result.online,
          reachable: result.reachable,
          error: result.error || '',
        })
        if (result.online) log('[whale] 看门狗：协议端已恢复')
        else if (result.error) log('[whale] 看门狗：' + result.error)
        else log('[whale] 看门狗：已重启协议端，正在等登录')
      } else if (result?.error) {
        log('[whale] 看门狗：' + result.error)
      } else if (result?.skipped) {
        // 等扫码/限流这类「没重启」也要留痕，否则面板上只剩一直被跳过。
        runtime.log('watchdog_skip', {
          downMs,
          skipped: result.skipped,
          phase: result.phase || '',
          waitingMs: result.waitingMs || 0,
        })
      }
    } catch (error) {
      log('[whale] 看门狗失败：' + String(error?.message || error))
    }
  })
  watchdogTimer.unref?.()



  // 每日 09:00 自动发当天简报；同一天只发一次
  const digestTimer = ticker.every(60_000, 'digest', async () => {
    try {
      const cfg = runtime.config.proactive || {}
      // 总开关优先：说了「别主动了」就一条主动消息都不发。
      // 以前只认各自的分项开关，结果「别主动了」之后，每日简报、早上补回、
      // 冷群话题照样到点发出去 —— 开关答应了却不算数，比没有开关更气人。
      if (cfg.enabled !== true || cfg.dailyDigest === false || channel.state() !== 'online') return
      const now = new Date()
      // 窗口为什么是「09:00 之后整段」而不是 09:00–09:01：
      // 定时器 60 秒一跳，但它不等上一次返回，也可能被别的事拖住一两分钟。
      // 只要有哪一次跳过了 09:00 和 09:01 这两分钟，这一天就再也不会发 ——
      // 而用户那边只表现为「今天没有简报」，没有任何报错可查。
      // 「当天发过没有」由下面的 state.day 兜住，窗口放宽不会变成重复发。
      if (now.getHours() < 9 || now.getHours() >= 23) return
      const owner = String(runtime.config.identity?.ownerId || '')
      if (!owner) return
      const file = path.join(dir, 'digest-state.json')
      let state = { day: '' }
      try { state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) } } catch {}
      const day = now.toDateString()
      if (state.day === day) return
      const digest = runtime.dailyDigest()
      // 标明来源：这是定时简报，不是它对着某句话的回复。没有这一行，
      // 下一轮上下文里它只看到一句自己发过的摘要，会当成自己刚说的话（线上已出现）。
      await outbound('private', owner, '【今日简报】\n' + digest)
      saveState(file, { day })
      log('[whale] 已发每日简报')
    } catch (error) {
      log('[whale] 每日简报失败：' + String(error?.message || error))
    }
  })
  digestTimer.unref?.()

  runtime.describeImageFile = describeImageFile

  async function transcribeFile(file) {
    try {
      const escaped = String(file).replace(/'/g, "''")
      const script = "Add-Type -AssemblyName System.Speech; $r=New-Object System.Speech.Recognition.SpeechRecognitionEngine; $r.SetInputToWaveFile('" + escaped + "'); $r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); $x=$r.Recognize(); if($x){$x.Text}"
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000, windowsHide: true })
      const text = String(stdout || '').trim()
      return text ? { ok: true, text } : { ok: false, error: '没有识别出语音内容' }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }
  runtime.transcribeFile = transcribeFile

  syncNapcatAutostart(runtime.config, napcat)
  // 联网闸的策略由配置驱动：启动时先装一次，之后每次改白名单/次数由订阅者重装。
  // 不装的话 web.mjs 会按「白名单空＝全不许」的默认值拦下所有联网请求。
  const netAtStart = configureNet(runtime.config)
  // 默认安装时白名单是空的，联网按界面承诺全部停用。留一条可查的记录，
  // 免得用户只看到「怎么突然搜不了」却不知道去哪儿开。
  if (!netAtStart.allowlist.length) {
    runtime.log('net_policy_empty', { note: '联网白名单是空的：按界面口径「留空＝全部不许」，联网当前停用；在设置里点开或添加域名即可启用（如 cn.bing.com、www.baidu.com）' })
  }

  // ── 配置变更的唯一联动点 ────────────────────────────────────────
  // 以前这段被整段复制到 /config 与 /config/reload 两个 HTTP 路由里，
  // 而且两份还不一样（reload 漏了登录重试、通道重连、启动项同步）。
  // 更要命的是：QQ 里说「说话短一点」、工具 set_config、外部改文件 reload
  // 这些入口根本不经过那两个路由 —— 界面提示「改好了」，各层却没跟着动。
  // 现在绑到 Runtime 的变更事件上：不管从哪条路改，都走这一份清单。
  runtime.onConfigChange(async (change) => {
    const keys = Array.isArray(change.keys) ? change.keys : []
    const hit = (k) => keys.includes(k)

    // 每次都重装：这些组件要么持有 config 引用，要么构造时把值拷进自己字段。
    // 无条件刷新比「按 key 选择性刷新」安全 —— 漏一个键就是一次「改了没反应」。
    guard.configure(runtime.config)
    attention.configure(runtime.config)
    usage.configure(runtime.config)
    channel.config = runtime.config
    napcat.relink(runtime.config)
    // 界面上「联网白名单 / 每小时联网次数」拨完立刻生效，不用重启、不用去 QQ 试
    configureNet(runtime.config)

    const loginChanged = keys.some((k) => k.startsWith('channel.login.'))
    const autostartChanged = hit('channel.autoStartNapcat') || hit('channel.napcatBat') || hit('channel.selfId') || loginChanged
    const reconnectChanged = ['channel.enabled', 'channel.wsUrl', 'channel.token', 'channel.selfId'].some(hit)

    // 启动项里的参数跟着登录方式走：扫码不带 -q，票据/密码带 -q。
    if (autostartChanged) {
      try {
        const synced = syncNapcatAutostart(runtime.config, napcat)
        if (!synced.ok) log('[whale] 开机自启设置失败：' + synced.error)
      } catch (error) {
        log('[whale] 开机自启同步失败：' + String(error?.message || error))
      }
    }

    // 登录方式 / 密码改完立即试一次：这才是「改完就生效」，不用等重启 DSH。
    let note = ''
    if (hit('channel.login.mode') || hit('channel.login.password')) {
      try {
        const attempt = await napcat.retry({ mode: String(runtime.config.channel?.login?.mode || 'ticket') })
        note = String(attempt.message || attempt.error || '')
      } catch (error) {
        log('[whale] 按新登录方式重试失败：' + String(error?.message || error))
      }
    }

    // 通道地址/令牌/QQ 号/开关变了才重连；只改登录相关的不该把在线连接踢掉
    if (reconnectChanged) {
      try {
        channel.stop()
        if (runtime.config.channel?.enabled !== false) channel.start()
      } catch (error) {
        log('[whale] 通道重连失败：' + String(error?.message || error))
      }
      if (hit('channel.enabled') && runtime.config.channel?.enabled === true) {
        napcat.ensure({ reason: 'manual' }).catch((error) => log('[whale] 启动协议端失败：' + String(error?.message || error)))
      }
    }
    return { login: napcat.snapshot(), message: note }
  })
  // 把所有 HTTP 响应都带上当前修订号：面板靠它发现「不是我改的，但配置变了」。
  // sendJson 是模块级函数，装配时把读取器指到本实例的 Runtime。
  revisionOf = () => runtime.configRevision

  // 面板不再靠 5 秒一次的整包轮询判断「有没有变」：这里每秒算一次低成本摘要，
  // 变了才给连着的窗口推一句 invalidate。没有窗口连着时定时器根本不跑。
  const panelEvents = createEventHub({
    keyOf: () => eventKeyOf({ runtime, sandbox, channel, napcat }),
    interval: 1000,
  })

  // 图片缓存该清了再清：启动时顺手删掉太旧的，别等磁盘满了才想起来
  try {
    const pruned = pruneMedia(runtime.dir, { keepDays: 30, maxFiles: 3000 })
    if (pruned.removed) log('[whale] 清掉 ' + pruned.removed + ' 张过期图片缓存')
  } catch {}

  const hotParts = async (rows) => {
    const row = rows[0] || {}
    const title = typeof row === 'string' ? row : String(row.title || '')
    let body = ''
    if (row.url) {
      const page = await readWeb(row.url, 1800)
      if (page.ok) body = String(page.text || '')
    }
    if (!body) body = typeof row === 'string' ? '' : String(row.snippet || '')
    let text = (title ? title + '。' : '') + body
    text = text.replace(/…|\.{3,}/g, '，').replace(/\s+/g, ' ').trim()
    if (text.length > 700) {
      const marks = ['。', '！', '？', '；'].map((mark) => text.lastIndexOf(mark, 700)).filter((index) => index > 200)
      text = marks.length ? text.slice(0, Math.max(...marks) + 1) : text.slice(0, 700) + '。'
    }
    const parts = []
    while (text && parts.length < 2) {
      if (text.length <= 360) { parts.push(text); text = ''; break }
      const marks = ['。', '！', '？', '；'].map((mark) => text.lastIndexOf(mark, 360)).filter((index) => index > 100)
      const cut = marks.length ? Math.max(...marks) + 1 : 360
      parts.push(text.slice(0, cut).trim())
      text = text.slice(cut).trim()
    }
    if (text && parts.length) parts[parts.length - 1] += text
    return parts.filter(Boolean)
  }
  const hotStateFile = path.join(dir, 'hot-state.json')
  let hotState = { lastAt: 0, sent: [] }
  try { hotState = { ...hotState, ...JSON.parse(readFileSync(hotStateFile, 'utf8')) } } catch {}
  let lastHotNews = Number(hotState.lastAt) || 0
  const hotKey = (row) => (String(row?.title || '') + '|' + String(row?.url || '')).replace(/\s+/g, '').slice(0, 300)
  const hotSimilar = (left, right) => {
    const grams = (text) => {
      const clean = String(text || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '')
      const out = new Set()
      for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2))
      return out
    }
    const a = grams(left)
    const b = grams(right)
    if (!a.size || !b.size) return false
    let hit = 0
    for (const gram of a) if (b.has(gram)) hit += 1
    return hit / Math.min(a.size, b.size) >= 0.7
  }
  const hotNewsTimer = ticker.every(10 * 60_000, 'hotnews', async () => {
    try {
      const cfg = runtime.config.proactive || {}
      const owner = String(runtime.config.identity?.ownerId || '')
      // 与每日简报同一个总开关（见上面 digestTimer 的说明）
      if (cfg.enabled !== true || cfg.hotNews !== true || !owner || channel.state() !== 'online') return
      const hours = Math.max(1, Number(cfg.hotNewsHours) || 8)
      if (Date.now() - lastHotNews < hours * 3_600_000) return
      const rows = await searchWebDetailed('今日热点 新闻', 5)
      if (!Array.isArray(rows) || !rows.length) return
      const history = Array.isArray(hotState.sent) ? hotState.sent : []
      const fresh = rows.find((row) => {
        const key = hotKey(row)
        return !history.some((item) => item.key === key || hotSimilar(item.title, row.title))
      })
      if (!fresh) {
        lastHotNews = Date.now()
        hotState = { lastAt: lastHotNews, sent: history }
        saveState(hotStateFile, hotState)
        log('[whale] 热点都是重复内容，本次跳过')
        return
      }
      const parts = await hotParts([fresh])
      if (!parts.length) return
      const hotText = '看到个热点：' + parts[0]
      await outbound('private', owner, parts[1] ? [hotText, parts[1]] : [hotText])
      lastHotNews = Date.now()
      const keep = 30
      hotState = {
        lastAt: lastHotNews,
        sent: [...history, { key: hotKey(fresh), title: String(fresh.title || ''), at: lastHotNews }].slice(-keep),
      }
      saveState(hotStateFile, hotState)
      log('[whale] 已发热点分享')
    } catch (error) {
      log('[whale] 热点分享失败：' + String(error?.message || error))
    }
  })
  hotNewsTimer.unref?.()

  // 热群插话：群里正聊得热、他/她十分钟没被叫、一个半小时没插过话，才可能接一句。
  // 这不是「刷存在感」，是像个在旁边听的人 —— 插不上就不发。
  const interjectTimer = ticker.every(5 * 60_000, 'interject', async () => {
    try {
      const cfg = runtime.config.proactive || {}
      if (cfg.enabled !== true || !activeRunner || channel.state() !== 'online') return
      const now = Date.now()
      const hour = new Date(now).getHours()
      if (hour < (cfg.startHour ?? 9) || hour >= (cfg.endHour ?? 23)) return
      const file = path.join(dir, 'interject.json')
      let state = { day: '', count: 0, byGroup: {} }
      try { state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) } } catch {}
      const day = new Date(now).toDateString()
      if (state.day !== day) state = { day, count: 0, byGroup: {} }
      if (state.count >= 2) return
      const rows = runtime.events.read({ limit: 300 }).rows || []
      const groups = new Map()
      for (const row of rows) {
        if (row?.type !== 'message' || row.scope !== 'group' || !row.group) continue
        const gid = String(row.group)
        const entry = groups.get(gid) || { messages: [], lastMsg: 0, lastSelf: 0 }
        const at = Number(row.at) || 0
        entry.lastMsg = Math.max(entry.lastMsg, at)
        if (row.from === 'self') entry.lastSelf = Math.max(entry.lastSelf, at)
        else if (now - at < 5 * 60_000) entry.messages.push({ sender: row.sender || row.from, text: String(row.text || '').slice(0, 80), at })
        groups.set(gid, entry)
      }
      const picked = [...groups.entries()].find(([gid, entry]) => {
        if (entry.messages.length < 6) return false
        if (now - (entry.lastMsg || 0) > 2 * 60_000) return false
        if (entry.lastSelf && now - entry.lastSelf < 90 * 60_000) return false
        const last = Number(state.byGroup?.[gid] || 0)
        return !last || now - last > 90 * 60_000
      })
      if (!picked) return
      const [gid, entry] = picked
      const context = entry.messages.slice(-5).map((row) => `${row.sender}：${row.text}`).join('\n')
      // 闸门先过，再调模型。原来顺序反了：限流不放行时，模型已经跑过一次，
      // 生成出来的话注定被丢掉 —— 等于白烧一次 token。
      // 结果完全一样（都是不发），少的是那次注定浪费的调用。
      const gate = guard.check(now, {})
      if (!gate.ok) return
      // 预算闸在推理之前：超了就别烧这一次。
      if (budgetBlocks()) return
      const line = await activeRunner('群里正聊着：\n' + context + '\n你顺着这个话题插一句，短、自然、不抢戏。插不上就只回一个句号。', { conversation: 'group:' + gid })
      // 群插话算自主活动：顺着现场接一句，也是它自己的时间。
      // 只记活动账本，不写思维链。
      const spent = activitySpend(runtime, line, { kind: 'interject' })
      const text = String(line?.text || '').trim()
      if (!text || text === '。' || text.length < 4) return
      runtime.logActivity?.({
        at: Date.now(),
        kind: 'interject',
        text: '群里插了一句：' + text.slice(0, 120),
        source: 'auto',
        tokens: spent,
      })
      await outbound('group', gid, text)
      state.count += 1
      state.byGroup = { ...(state.byGroup || {}), [gid]: Date.now() }
      saveState(file, state)
      log('[whale] 群里插了一句：' + text.slice(0, 40))
    } catch (error) {
      log('[whale] 插话失败：' + String(error?.message || error))
    }
  })
  interjectTimer.unref?.()

  // 花超了要说一声：预算的 80% 提醒，一天一次。
  const tokenAlertTimer = ticker.every(10 * 60_000, 'tokenalert', async () => {
    try {
      const budget = Number(runtime.config.usage?.budgetPerDay) || 0
      const owner = String(runtime.config.identity?.ownerId || '')
      if (!budget || !owner || channel.state() !== 'online') return
      const today = usage.today()
      if (!today || today.cost < budget * 0.8) return
      const file = path.join(dir, 'token-alert.json')
      let state = { day: '' }
      try { state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) } } catch {}
      const day = new Date().toDateString()
      if (state.day === day) return
      const alert = `今天的 token 花了约 ¥${Number(today.cost).toFixed(2)}，已经到预算 ${budget} 的八成。收到 ${today.calls || 0} 条、回了这么多话。觉得吵可以跟我说「别主动了」。`
      await outbound('private', owner, alert)
      saveState(file, { day })
      log('[whale] 已发 token 预算提醒')
    } catch (error) {
      log('[whale] token 提醒失败：' + String(error?.message || error))
    }
  })
  tokenAlertTimer.unref?.()

  const morningTimer = ticker.every(10 * 60_000, 'morning', async () => {
    try {
      const cfg = runtime.config.proactive || {}
      const owner = String(runtime.config.identity?.ownerId || '')
      const now = new Date()
      if (cfg.enabled !== true || cfg.morningBackfill !== true || !owner || channel.state() !== 'online') return
      if (now.getHours() < 8 || now.getHours() > 10) return
      const file = path.join(dir, 'morning-state.json')
      let state = { day: '' }
      try { state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) } } catch {}
      const day = now.toDateString()
      if (state.day === day) return
      const events = path.join(dir, 'events.jsonl')
      const since = new Date(now)
      since.setHours(22, 0, 0, 0)
      if (now.getHours() < 12) since.setDate(since.getDate() - 1)
      const rows = []
      try {
        for (const line of readFileSync(events, 'utf8').split('\n').slice(-800)) {
          if (!line.trim()) continue
          try {
            const row = JSON.parse(line)
            if (row.kind === 'event' && row.type === 'message' && Number(row.ts) >= since.getTime() && row.from !== 'self') rows.push(row)
          } catch {}
        }
      } catch {}
      if (!rows.length) { saveState(file, { day }); return }
      const lines = rows.slice(-6).map((row) => `- ${row.sender || row.from || '有人'}：${String(row.text || '[非文字]').slice(0, 60)}`)
      const morningText = `【早上补回】昨晚到今早，有 ${rows.length} 条消息：\n${lines.join('\n')}`
      await outbound('private', owner, morningText)
      saveState(file, { day })
      log('[whale] 已发早上补回')
    } catch (error) {
      log('[whale] 早上补回失败：' + String(error?.message || error))
    }
  })
  morningTimer.unref?.()

  const coldTopicTimer = ticker.every(30 * 60_000, 'coldtopic', async () => {
    try {
      const cfg = runtime.config.proactive || {}
      if (cfg.enabled !== true || cfg.coldTopic !== true || channel.state() !== 'online') return
      const now = Date.now()
      const file = path.join(dir, 'cold-state.json')
      let state = { day: '' }
      try { state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) } } catch {}
      const day = new Date(now).toDateString()
      if (state.day === day) return
      const events = path.join(dir, 'events.jsonl')
      const lastByGroup = new Map()
      try {
        for (const line of readFileSync(events, 'utf8').split('\n').slice(-1000)) {
          if (!line.trim()) continue
          try {
            const row = JSON.parse(line)
            const match = /^group:(\d+)$/.exec(String(row.conversation || ''))
            if (!match || row.type !== 'message' || row.from === 'self') continue
            const at = Number(row.ts) || 0
            if (at > (lastByGroup.get(match[1]) || 0)) lastByGroup.set(match[1], at)
          } catch {}
        }
      } catch {}
      const groups = await channel.groupList()
      const eligible = []
      for (const group of Array.isArray(groups) ? groups : []) {
        const id = String(group.group_id || group.groupId || '')
        const last = lastByGroup.get(id) || 0
        if (!id || !last) continue
        const quiet = now - last
        if (quiet >= 6 * 3_600_000 && quiet <= 24 * 3_600_000) eligible.push({ id, name: String(group.group_name || group.groupName || '') })
      }
      if (!eligible.length) { saveState(file, { day }); return }
      const target = eligible[0]
      const topics = [
        '群里这么安静，最近有什么好玩的事吗',
        '都潜水呢，出来聊两句',
        '突然想起个事，你们最近在玩什么',
        '安静得能听见回声了，来个人说句话',
      ]
      const coldText = topics[Math.floor(Math.random() * topics.length)]
      await outbound('group', target.id, coldText)
      saveState(file, { day })
      log('[whale] 已发冷群话题：' + target.id)
    } catch (error) {
      log('[whale] 冷群话题失败：' + String(error?.message || error))
    }
  })
  coldTopicTimer.unref?.()

  const reminderTimer = ticker.every(30_000, 'reminder', async () => {
    try {
      if (!runtime.reminders || channel.state() !== 'online') return
      // 到点的相同内容只发一遍：旧数据里可能已经躺着几条「时间到了」，
      // 一次性全发出去就是刷屏。发出去之后把它们一起标记为已发。
      const sentTexts = new Set()
      for (const item of runtime.reminders.due()) {
        const mark = `${item.to}|${plainText(item.text)}`
        if (sentTexts.has(mark)) {
          runtime.reminders.markSent(item.id)
          continue
        }
        const result = await outbound('private', item.to, item.text)
        // 只有「真的发出去了」或「刚刚说过、被复读闸拦下」才算送达。
        // 限流/离线这类失败不标记，半分钟后再试 —— 否则这条提醒就永久丢了。
        if (result?.ok === true || result?.reason === 'duplicate') {
          runtime.reminders.markSent(item.id)
          sentTexts.add(mark)
          log('[whale] 已发提醒：' + item.text.slice(0, 60))
        } else {
          log('[whale] 提醒没发出去，留着重试：' + String(result?.reason || result?.error || '未知原因'))
        }
      }
    } catch (error) {
      log('[whale] 提醒发送失败：' + String(error?.message || error))
    }
  })
  reminderTimer.unref?.()

  // 生成能力：宿主给就有，不给就 null。turn 会用这个决定自己 ready 不 ready
  const runnerPromise = createHostRunner({ ctx, config: runtime.config, workspace: workspaceOf(dir), log })

  let turn = null
  // 独立对话：只有在拿到生成器之后才有意义。拿不到就一直 null，
  // 面板会显示「生成能力还没接上」——不是加载不出来，是确实没有。
  let chat = null
  let started = false
  let activeRunner = null

  const wire = async () => {
    const runner = await runnerPromise
    activeRunner = runner
    turn = new Turn({ runtime, guard, usage, channel, runner, tools, log, typing, attention })
    chat = new Chat({ dir, runtime, usage, runner, tools, now: () => Date.now() })
    // 生成器真的可用时，才把「说话」这几项登记成已实现。
    // 不登记的话技能页会一直说「还没接上」—— 反过来，没接上也绝不假装接上。
    if (runner) runtime.registerTools(['reply', 'split', 'tone'])
    log(runner ? '[whale] 模型已接通，可以生成' : '[whale] 模型未接通：状态页会显示原因')
    /**
     * 主人的「同意 / 拒绝」回话 → 一次决定。返回 true 表示这条已经被吃掉。
     *
     * 三个条件缺一不可：有正在等的请求、来自主人、且是私聊或
     * **发起请求的那个群**。群聊里只认本群的 pending，别处挂着的代码
     * 请求不能被一句「同意」顺手放行。
     */
    const takeApprovalReply = (raw) => {
      const desk = sandbox.approvals
      if (!desk || typeof desk.takeReply !== 'function' || !desk.list().length) return false
      if (raw?.kind !== KIND.MESSAGE) return false
      const isPrivate = raw.scope === SCOPE.PRIVATE
      const isGroup = raw.scope === SCOPE.GROUP
      if (!isPrivate && !isGroup) return false
      const owner = String(runtime.config.identity?.ownerId || '')
      if (!owner || String(raw.from || '') !== owner) return false
      const verdict = desk.takeReply(raw.text, { origin: isGroup ? String(raw.conversation || '') : '' })
      if (!verdict) return false
      // 事件照样落盘：主人在对话里确实说了这句，记录里不该凭空少一条
      try {
        const decision = runtime.decide(raw, { config: runtime.config })
        runtime.logEvent(decision.event, { approval: 'reply' })
      } catch {}
      const targetScope = isGroup ? SCOPE.GROUP : SCOPE.PRIVATE
      const targetId = isGroup
        ? String(raw.payload?.groupId || raw.group || '')
        : owner
      if (targetId) {
        outbound(targetScope, targetId, verdict.message, { system: true }).catch((error) => {
          log('[whale] 确认回执没发出去：' + String(error?.message || error))
        })
      } else {
        outbound('private', owner, verdict.message, { system: true }).catch(() => {})
      }
      return true
    }
    channel.onRaw = (raw) => {
      // 图片本体先落盘再进流程：事件里只有会过期的 url 和协议端的临时文件名，
      // 不落盘就等于「收到过、但永远拿不到」。这里不 await（下载十几秒也不能卡住消息），
      // 承诺挂在 pic 上，谁真需要字节谁 await。
      try {
        attachImages(raw, { dir: runtime.dir, channel, maxBytes: runtime.config.images?.maxBytes })
      } catch (error) {
        log('[whale] 图片落盘没成功：' + String(error?.message || error))
      }
      // 入群邀请 / 加好友申请：事件照样进流程（会落进事件流），另外单独提醒主人一句。
      // 不提醒的话，这类请求只会安静地躺在 jsonl 里，谁也不会去看。
      try {
        if (raw?.payload?.request) notifyOwnerOfRequest(raw)
      } catch (error) {
        log('[whale] 请求提醒没发出去：' + String(error?.message || error))
      }
      // 主人在私聊里回「同意 / 拒绝 理由」= 对一条待确认请求的决定，不是聊天。
      // 必须拦在 turn 之前：它要解开一个正在 await 的 Promise，晚一步就只剩超时。
      try {
        if (takeApprovalReply(raw)) return
      } catch (error) {
        log('[whale] 确认回复没处理成：' + String(error?.message || error))
      }
      turn.handle(raw).catch((error) => log('[whale] 处理消息出错：' + String(error?.message || error)))
    }
    started = true
  }

  ctx.effect(
    () => {
      const ready = wire().catch((error) => log('[whale] 装配失败：' + String(error?.message || error)))
      // 登录状态一直在轮询：面板每次重画读的是快照，不会自己发请求。
      napcat.startPolling()
      let bootTimer = null
      if (runtime.config.channel?.enabled !== false) {
        ready
          .then(() => {
            channel.start()
            // 给 Windows 启动项里的 NapCat 一点时间，避免两边同时拉起两份。
            bootTimer = setTimeout(() => {
              napcat.ensure({ reason: 'boot' }).catch((error) => log('[whale] 开机登录失败：' + String(error?.message || error)))
            }, 6000)
            bootTimer.unref?.()
          })
          .catch((error) => log('[whale] 通道启动失败：' + String(error?.message || error)))
      }
      return () => {
        try {
          if (bootTimer) clearTimeout(bootTimer)
          clearInterval(reminderTimer)
          clearInterval(proactiveTimer)
          clearInterval(digestTimer)
          clearInterval(activityTimer)
          clearInterval(watchdogTimer)
          clearInterval(learnTimer)
          clearInterval(hotNewsTimer)
          clearInterval(morningTimer)
          clearInterval(coldTopicTimer)
          clearInterval(interjectTimer)
          clearInterval(tokenAlertTimer)
          napcat.stop()
          channel.stop()
        } catch {
          // 停不掉就算了，进程退出会断
        }
        try {
          runtime.save()
          runtime.close?.()
        } catch {
          // 收尾失败不该抛给宿主
        }
      }
    },
    'shenlan: 运行时与通道生命周期',
  )

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = new URL(req.url, 'http://127.0.0.1')
          const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
          try {
            // `/hotnews/test` 已删：它直接给主人私聊发一条热点，绕过所有触发条件，
            // 界面上从来没有入口，也没有任何脚本/用例调它。热点正常路径在
            // 主动行为里（见 runActivityStep），不需要第二个只用于手测的出口。
            if (route === '/vision/selftest') {
              const checks = []
              const agents = ctx.get('agents')
              const attachments = ctx.get('attachments')
              const llm = ctx.get('llm')
              checks.push({ name: 'agents 服务', ok: !!agents })
              checks.push({ name: 'attachments 服务', ok: !!attachments })
              checks.push({ name: 'llm 服务', ok: !!llm })
              let provider = ''
              let model = ''
              try {
                const selection = ctx.get('agentDefaultModel')?.currentSelection?.() || {}
                provider = String(selection.provider || '')
                model = String(selection.model || '')
                checks.push({ name: '当前模型', ok: !!(provider && model), detail: model || '未选择' })
                if (provider && model && llm) {
                  const info = await llm.resolveModelInfo(provider, model)
                  checks.push({ name: '模型支持图片', ok: Array.isArray(info?.inputModalities) && info.inputModalities.includes('image'), detail: (info?.inputModalities || []).join(', ') })
                }
              } catch (error) {
                checks.push({ name: '模型检查', ok: false, detail: String(error?.message || error).slice(0, 120) })
              }
              const sample = path.join(homedir(), '.dsh', 'qq-fish', 'stickers', '6218fab9ef3e2ce46a71f4497aaf1d3b171b36bc.jpg')
              checks.push({ name: '本地测试图', ok: existsSync(sample), detail: sample })
              let sampleText = ''
              if (checks.every((item) => item.ok) && existsSync(sample)) {
                const seen = await describeImageFile(sample, '只回答图里有什么，10 字以内。')
                checks.push({ name: '真实识别', ok: seen.ok, detail: seen.ok ? String(seen.text).slice(0, 160) : String(seen.error).slice(0, 160) })
                if (seen.ok) sampleText = String(seen.text).slice(0, 200)
              }
              sendJson(res, 200, { ok: checks.every((item) => item.ok), checks, sampleText })
              return
            }
            // 七类只读列表统一走 /list/:kind。实现只有 view/list-view.mjs 一份，
            // 界面与探针都拼 kind，不再各写一份写死的路径。
            if (route.startsWith('/list/') && req.method === 'GET') {
              const kind = decodeURIComponent(route.slice('/list/'.length))
              const data = await listOf(kind, { runtime, channel, napcat, guard, usage, sandbox, tools, started, turn })
              if (!data) { sendJson(res, 404, failure('UNKNOWN_LIST', { detail: kind })); return }
              sendJson(res, 200, data)
              return
            }
            // 写操作统一入口：op 是动作名，args 是原来那份 body。
            // 实现只有 app/action.mjs 一张表；未知 op 回 404，绝不猜「最接近」的动作。
            if (route === '/action' && req.method === 'POST') {
              const body = await readBody(req)
              const op = String(body.op || '')
              const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {}
              const result = await runAction(op, args, {
                runtime, sandbox, chat, channel, guard, card, peerOf, at: () => Date.now(),
              })
              if (!result) { sendJson(res, 404, failure('UNKNOWN_OP', { detail: op })); return }
              sendJson(res, 200, result)
              return
            }
            // 二进制资源统一出口：二维码、落盘图片。判断全在 app/asset.mjs，
            // 这里只负责把字节写回去 —— 路径穿越防护因此只有一份。
            // JSON 数据源（/list/:kind、/vision/selftest）不走这里。
            if (route.startsWith('/asset/') && req.method === 'GET') {
              let name = ''
              try { name = decodeURIComponent(route.slice('/asset/'.length)) }
              catch { name = '' }
              const qrPath = String(napcat.plan().qrPath || runtime.config.channel?.qrcodePath || '')
              const hit = assetOf(name, { dir: runtime.dir, qrPath })
              if (!hit) { sendJson(res, 404, failure('UNKNOWN_ASSET', { detail: name })); return }
              res.writeHead(200, {
                'content-type': hit.type,
                'cache-control': hit.cache,
                'content-length': hit.bytes.length,
              })
              res.end(hit.bytes)
              return
            }
            if (route === '/napcat/qr/refresh' && req.method === 'POST') {
              const result = await napcat.retryQr()
              await napcat.poll()
              sendJson(res, 200, { ...result, login: napcat.snapshot() })
              return
            }
            // 登录的统一入口：状态、重试、换方式、刷新、重启协议端。
            // 面板只发一个动作词，具体怎么调用 NapCat 全在 channel/napcat.mjs 里。
            if (route === '/napcat/login') {
              if (req.method !== 'POST') {
                await napcat.poll()
                sendJson(res, 200, { ok: true, login: napcat.snapshot() })
                return
              }
              const body = await readBody(req)
              const action = String(body.action || 'retry')
              if (action === 'status') {
                await napcat.poll()
                sendJson(res, 200, { ok: true, login: napcat.snapshot() })
                return
              }
              if (action === 'ticket' || action === 'password' || action === 'qr') {
                // 换方式要写回配置：面板上的「登录方式」必须跟着变，不能只作用于这一次。
                const changed = runtime.setConfig('channel.login.mode', action)
                if (!changed.ok) { sendJson(res, 200, changed); return }
                napcat.relink(runtime.config)
              }
              let result
              if (action === 'start') result = await napcat.ensure({ reason: 'manual' })
              else if (action === 'refresh') result = await napcat.retryQr({ force: true })
              else if (action === 'restart') result = await napcat.restart({ force: true })
              else if (action === 'ticket' || action === 'password' || action === 'qr') result = await napcat.retry({ mode: action })
              else result = await napcat.retry()
              await napcat.poll()
              sendJson(res, 200, { ...result, ok: result.ok !== false, login: napcat.snapshot() })
              return
            }
            if (route === '/vision/test' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, await describeImageFile(String(body.path || ''), String(body.question || '')))
              return
            }
            // 面板事件流：只推「该重拉了」，不推数据本身。
            // 数据仍由 /panel 一次算完；判断只留一处，前端不必抄第二份状态。
            //
            // 只听 res 的 close：Node 16+ 里 req 的 close 在**请求体读完**时也会触发，
            // 挂上去会把刚建立的 SSE 立刻关掉，表现就是"连上一秒又断"。
            if (route === '/events' && req.method === 'GET') {
              res.writeHead(200, {
                'content-type': 'text/event-stream; charset=utf-8',
                'cache-control': 'no-cache, no-transform',
                connection: 'keep-alive',
                'x-accel-buffering': 'no',
              })
              res.write(': connected\n\n')
              const send = (payload) => {
                if (res.writableEnded) return
                try { res.write('data: ' + JSON.stringify(payload) + '\n\n') } catch { /* 客户端刚断 */ }
              }
              const off = panelEvents.subscribe(send)
              let closed = false
              res.on('close', () => {
                if (closed) return
                closed = true
                off()
              })
              return
            }
            // 面板要显示的所有字，在这里一次算完。
            // 前端只负责摆位置 —— 判断留在宿主，才能被 npm test 钉住。
            if (route === '/panel') {
              // 前端每次拉面板都带上自己的版本标记（见 client.js 的 CLIENT_REV）。
              // 记下来放进 head：这样"页面里跑的是哪一版前端"是个可查的事实，不用猜。
              const rev = url.searchParams.get('rev') || ''
              if (rev) {
                clientProbe = {
                  rev: String(rev).slice(0, 40),
                  // 插件根节点实得的宽度（宿主给多少）
                  width: Number(url.searchParams.get('w')) || 0,
                  // 浏览器视口宽度与根节点的左偏移：两者一减就是「真正能看见的宽度」。
                  // 少这两个数时，界面右侧被裁只能靠截图猜，改完也不知道有没有改对。
                  viewport: Number(url.searchParams.get('vw')) || 0,
                  left: Number(url.searchParams.get('left')) || 0,
                  // 被外层裁掉多少像素（0 = 刚好放下）
                  overflow: Number(url.searchParams.get('ow')) || 0,
                  // 分栏实测（nav/inner/side/main 的宽@左边界）。三栏挤不挤，看这一条
                  // 分栏实测（横竖两个方向的宽@左/高@上）。200 字放不下 9 层，放宽到 600。
                  geo: String(url.searchParams.get('geo') || '').slice(0, 600),
                }
              }
              sendJson(res, 200, panelView({ runtime, chat, usage, guard, channel, typing, attention, clientProbe }))
              return
            }
            // 数据与调试：把后端已有、界面却没有入口的核对能力收在一处。
            // 每项都在 view/debug.mjs 的同一份清单里，界面只按清单渲染。
            if (route === '/debug/run' && req.method === 'POST') {
              const body = await readBody(req)
              const result = await runDebug(String(body.kind || ''), { runtime, channel, usage, napcat })
              sendJson(res, 200, result)
              return
            }
            // 详情页：区域里的每张卡片都带一个 detail id，这里按 id 取内容。
            // 分页参数只有审计与思维链用得上，其余忽略。
            if (route === '/detail') {
              sendJson(
                res,
                200,
                detailView({
                  runtime,
                  chat,
                  usage,
                  guard,
                  channel,
                  typing,
                  attention,
                  id: url.searchParams.get('id') || '',
                  before: url.searchParams.get('before') || undefined,
                  // 不传就让详情页按自己的默认值来：群聊 100 条，审计 40 条。
                  // 以前这里兜 40，把群聊的第一页也一起压成了 40。
                  limit: Number(url.searchParams.get('limit')) || undefined,
                  // 审计页顶上的三个胶囊：级别 / 类型 / 含不含噪音。
                  // 不传就用设置里的默认口径 —— 页面上临时改只看这一次。
                  level: url.searchParams.get('level') || undefined,
                  kind: url.searchParams.get('kind') || undefined,
                  noise: url.searchParams.has('noise') ? url.searchParams.get('noise') : undefined,
                }),
              )
              return
            }
            // 单条消息的原始记录：面板「查看原文」用。
            // 顺序是「本地事件流 → 协议端」：本地最快、也不依赖网络；
            // 协议端那一层能捞回比日志更早的消息（NapCat 自己还留着）。
            if (route === '/message') {
              const conversation = String(url.searchParams.get('conversation') || '')
              const id = String(url.searchParams.get('id') || '')
              if (!id) { sendJson(res, 200, failure('MISSING_ID')); return }
              let hit = null
              try {
                const rows = runtime.events.read({
                  limit: 20,
                  maxScan: 60000,
                  filter: (row) => String(row?.messageId || '') === id
                    && (!conversation || String(row?.conversation || '') === conversation),
                }).rows || []
                hit = rows[0] || null
              } catch {
                hit = null
              }
              if (hit) {
                sendJson(res, 200, {
                  ok: true,
                  source: 'log',
                  message: {
                    messageId: id,
                    conversation: String(hit.conversation || conversation),
                    at: Number(hit.at || hit.ts) || 0,
                    who: hit.from === 'self' ? '我' : String(hit.sender || peerOf(String(hit.conversation || conversation)).id || '对方'),
                    self: hit.from === 'self',
                    type: String(hit.type || 'message'),
                    text: String(hit.text || ''),
                    images: Array.isArray(hit.payload?.images) ? hit.payload.images.length : 0,
                    replyId: String(hit.replyId || ''),
                    replySummary: String(hit.replySummary || ''),
                  },
                })
                return
              }
              // 本地没有：只有通道在线时才问得到协议端
              if (channel.state() !== 'online') {
                sendJson(res, 200, failure('MESSAGE_OFFLINE'))
                return
              }
              const remote = await channel.getMessage(id)
              if (!remote || remote.ok !== true || (!String(remote.text || '').trim() && !(remote.images || []).length)) {
                sendJson(res, 200, failure('MESSAGE_GONE'))
                return
              }
              sendJson(res, 200, {
                ok: true,
                source: 'protocol',
                message: {
                  messageId: id,
                  conversation,
                  at: 0,
                  who: String(remote.sender || '对方'),
                  self: false,
                  type: (remote.images || []).length ? 'image' : 'message',
                  text: String(remote.text || '') || (remote.images?.length ? '[图片]' : ''),
                  images: (remote.images || []).length,
                  replyId: '',
                  replySummary: '',
                },
              })
              return
            }
            // 独立对话：不经过 QQ，也不经过通道。回复只留在页面上。
            if (route === '/chat') {
              if (req.method !== 'POST') {
                sendJson(res, 200, { ok: true, ...(chat ? chat.history({ limit: 60 }) : { rows: [] }) })
                return
              }
              const body = await readBody(req)
              if (!chat) {
                sendJson(res, 200, failure('CHAT_UNAVAILABLE'))
                return
              }
              const result = await chat.send({ text: body.text })
              sendJson(res, 200, { ...result, ...chat.history({ limit: 60 }) })
              return
            }
            if (route === '/config' && req.method === 'POST') {
              const body = await readBody(req)
              // 批量写：一次提交多项。
              //
              // 为什么需要：设置页有 123 项，以前改三项就要点三次「保存」，
              // 每次都会重算整棵面板树。现在草稿攒在浏览器里，一次交上来。
              //
              // 不做"全成功或全失败"：`setConfig` 是逐项落盘 + 逐项发通知，
              // 想在它上面假装事务，只能先把所有校验走一遍再写 —— 那等于把
              // 校验逻辑复制一份出来，两份迟早不一致。这里如实返回每一项的结果，
              // 界面上直接说"存了 3 项，第 4 项没成，原因是…"。
              if (Array.isArray(body.items)) {
                const saved = []
                const failed = []
                for (const one of body.items) {
                  const key = String((one && one.key) || '')
                  const result = runtime.setConfig(key, one && one.value, { confirm: one && one.confirm === true })
                  if (result && result.ok) saved.push(key)
                  else failed.push(failure('CONFIG_FAILED', { key, message: String((result && result.error) || '没改成') }))
                }
                // 联动只跑一次：配置订阅者本来就按 revision 收，不必逐项触发。
                sendJson(res, 200, { ok: failed.length === 0, items: saved, failed })
                return
              }
              const key = String(body.key || '')
              const result = runtime.setConfig(key, body.value, { confirm: body.confirm === true })
              // 同上：别在这里再抄一份「改完要同步谁」的清单。
              // 聊天指令 / 工具 / reload 改配置时，联动走的是同一段订阅者。
              if (result.ok && result.effects) {
                for (const effect of await result.effects) {
                  if (effect.login) result.login = effect.login
                  if (effect.message) result.message = String(result.message || '改好了') + '；' + effect.message
                }
              }
              sendJson(res, 200, result)
              return
            }
            sendJson(res, 404, failure('UNKNOWN_ROUTE', { detail: route }))
          } catch (error) {
            sendJson(res, 500, failureFrom(error, 'INTERNAL'))
          }
        },
      }),
    'shenlan: /api/shenlan 路由',
  )

  log(`[whale] 已挂载｜数据目录 ${dir}｜路由 ${ROUTE_PREFIX}`)
}

/** 测试用：不经过宿主也能装一套 */
export { ROUTE_PREFIX }
