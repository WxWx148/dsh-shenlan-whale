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

import { Runtime } from './lib/runtime.mjs'
import { Guard } from './lib/guard.mjs'
import { TypingDesk } from './lib/typing.mjs'
import { AttentionDesk } from './lib/attention.mjs'
import { Usage } from './lib/usage.mjs'
import { Turn } from './lib/turn.mjs'
import { Chat } from './lib/chat.mjs'
import { panelView, detailView } from './lib/panel-view.mjs'
import { tracePass } from './lib/log.mjs'
import { peerOf } from './lib/qqview.mjs'
import { card } from './lib/say.mjs'
import { createTools } from './lib/tools.mjs'
import { Sandbox } from './lib/sandbox.mjs'
import { approvalText } from './lib/approvals.mjs'
import { KIND, SCOPE } from './lib/event.mjs'
import { searchWebDetailed, readWeb } from './lib/web.mjs'
import { runActivityStep } from './lib/activity.mjs'
import { createHostRunner, workspaceOf } from './lib/host.mjs'
import { OneBotChannel } from './lib/qq/onebot.mjs'
import { NapCatLogin } from './lib/qq/napcat.mjs'
import { backfillMissed } from './lib/qq/backfill.mjs'
import { attachImages, mediaPath, pruneMedia } from './lib/media.mjs'
import { createTicker } from './lib/ticker.mjs'
import { writeJson } from './lib/core.mjs'

export const name = 'shenlan-whale'
export const inject = ['webServer', 'llm']

const ROUTE_PREFIX = '/api/shenlan'

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
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
  // 级别过滤只在一处判（lib/log.mjs），不在每个调用点各写一遍。
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
  // 发之前顺手亮一下「正在输入」。节奏和 guard 的分工见 lib/typing.mjs 开头。
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
   * 定时器/提醒直接发出去的话也要记成「我说过」。
   * 不记的话，下一次被叫时上下文里只有别人说的话，像在跟一个失忆的人聊天。
   */
  /**
   * 定时器/提醒直接发出去的话也要记成「我说过」。
   * 不记的话，下一次被叫时上下文里只有别人说的话，像在跟一个失忆的人聊天。
   *
   * 这里顺带记一次限流（`guard.note`）。
   * 为什么写在这而不是各个发送点：`guard.note` 原先只有两处手写，
   * 剩下十来处发送（主动开口、每日简报、热点分享、早上补回、冷群话题、倒计时提醒…）
   * **一个都没记**。结果是索引显示「最近一小时 12 条」、实际发出了 40 条，
   * 限流因此变得不可预测 —— 有时怎么都不拦，有时突然全拦。
   * 「说出去了 = 算一次额度」这件事必须只有一个出口，漏记比多记难查得多。
   */
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

  const noteSelf = (scope, target, text) => {
    try {
      runtime.noteSelfMessage({ conversation: `${scope}:${target}`, scope, text, at: Date.now() })
    } catch {}
    try {
      guard.note(Date.now())
    } catch {}
  }

  /**
   * 统一出站口 —— 定时器、告警、提醒、主动开口都走这里，不许各自 `channel.say`。
   *
   * 为什么必须收成一处：回话那条链走打字台（有「正在输入」、有字数节奏、有分条留缝），
   * 而定时器们原先直接调通道 —— 于是同一台机器上两种气质：
   * 回话像人，播报像广播；而且有的记得限流、有的忘了记，额度永远算不准。
   * 收成这一处之后，**出站只有一条路**：闸门 → 打字台 → 通道 → 记账。
   *
   * 面板里的「代发」不走这里：那是用户点了发送，等的是立刻发出去，不是像人打字。
   */
  const outbound = async (scope, target, parts, options = {}) => {
    const list = (Array.isArray(parts) ? parts : [parts]).map((one) => String(one ?? '').trim()).filter(Boolean)
    if (!list.length) return { ok: false, reason: 'empty', lines: 0 }
    // 真正发一条：通道 + 记账必须成对。
    // 只记一边就会出现「说过但没算额度」，或者「算过额度但上下文里没有这句」，
    // 后者会让它把自己的话当成对方说的。两条路径都走它，通道出口就只有一个。
    const sendOne = async (one) => {
      await channel.say(scope, target, one)
      noteSelf(scope, target, one)
    }
    // 系统消息：确认请求、它的回执这类。
    // 不能走打字台（按字数要等十几秒，60 秒的确认窗口等不起），
    // 也不能被夜间静音吞掉 —— 没人看见就等于默认拒绝，而用户根本不知道发生过这件事。
    if (options.system === true) {
      let lines = 0
      for (const one of list) {
        try {
          await sendOne(one)
        } catch (error) {
          return { ok: false, reason: 'send', error: String(error?.message || error), lines }
        }
        lines += 1
      }
      return { ok: true, lines }
    }
    const gate = guard.check(Date.now(), options.event ? { event: options.event } : {})
    if (!gate.ok) {
      log('[whale] 这条没发出去：' + gate.why + '｜' + list[0].slice(0, 40))
      return { ok: false, reason: gate.why, text: gate.text, lines: 0 }
    }
    const result = await typing.typeOut({
      parts: list,
      scope,
      target,
      pace: () => guard.delay(Date.now()),
      say: sendOne,
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
  const napcat = new NapCatLogin({ config: runtime.config, channel, log })
  // 面板视图是同步的，从这里读登录快照；不要在 panel-view 里发请求。
  runtime.napcat = napcat
  // 先建通道再建工具表：发表情、@人、看头像这些工具需要通道，
  // 以前工具表先建、通道后建，只能靠运行时的全局变量补，结果是「工具在但发不出去」。
  const tools = createTools({ runtime, channel, usage, dir: runtime.dir })
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

  // 定时器重入闸：同一个任务上一次还没跑完，这一次到点就跳过（见 lib/ticker.mjs）。
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

  // 主动开口：默认关；每 60 秒看一次是否到点
  const proactiveTimer = ticker.every(60_000, 'proactive', async () => {
    try {
      const cfg = runtime.config.proactive || {}
      if (cfg.enabled !== true || !activeRunner || channel.state() !== 'online') return
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
      if (Date.now() - Number(state.lastAt || 0) < (cfg.intervalMinutes ?? 180) * 60_000) return
      const scene = { morning: '现在是早上，说一句带早安意味的', night: '现在是深夜，说一句轻一点、别吵人的', care: '说一句关心主人身体或心情的', general: '随口说一句' }[cfg.scene] || '随口说一句'
      const result = await activeRunner('你是深蓝鲸。' + scene + '短话，20-50字，像真人随手发的，不要提问，不要解释。', { conversation: 'private:' + owner })
      if (!result || !result.text) return
      // 思维链先于发言：主动开口也是它想说的话，发送前先落一条
      runtime.logCot?.({
        conversation: 'private:' + owner,
        kind: 'proactive',
        text: String(result.reasoning || '（主动开口，没有单独输出思考过程）'),
        summary: '主动开口：' + String(result.text).slice(0, 80),
        at: Date.now(),
      })
      await outbound('private', owner, result.text)
      state.count += 1
      state.lastAt = Date.now()
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
      runtime.memory?.rememberSelf?.(text.slice(0, 160))
      lastLearnedAt = Date.now()
      log('[whale] 掉线自学：' + topic)
    } catch (error) {
      log('[whale] 掉线自学失败：' + String(error?.message || error))
    }
  })
  learnTimer.unref?.()

  // 掉线自愈：先重连，再让登录层判断是「没启动」还是「没登录」。
  // 正在等扫码 / 已扫码等确认时**绝不重启** —— 那会把用户正要扫的码作废。
  let offlineSince = 0
  let lastWatchdogStart = 0
  const watchdogTimer = ticker.every(60_000, 'watchdog', async () => {
    try {
      // 群名缓存顺手续一下（30 分钟节流，不额外发请求）。
      // 放在看门狗开关之前：用户关掉掉线自愈，不等于不想要群名。
      if (channel.state() === 'online') channel.refreshGroups().catch(() => {})
      const cfg = runtime.config.channel || {}
      if (cfg.watchdogEnabled !== true || cfg.enabled !== true) { offlineSince = 0; return }
      if (channel.state() === 'online') { offlineSince = 0; return }
      const now = Date.now()
      if (!offlineSince) offlineSince = now
      if (now - offlineSince < Math.max(1, Number(cfg.watchdogMinutes) || 5) * 60_000) return
      // 不要 stop()/start()。通道自己就在按 1→30 秒退避重连，每分钟强行断一次等于
      // 把退避清零，还要写 off / unknown / offline 三条状态（实测一天四千多条），
      // 而「正在重连」和「卡住了」在面板上是两件完全不同的事。
      // 看门狗只补「没有待重连定时器」那一种：真卡住了才踢一脚。
      // 同时做一次体检：连接假死（TCP 没断、帧不再来）只有它能发现 ——
      // 面板会一直显示在线，而所有发送都在等超时。
      try {
        if (typeof channel.checkHealth === 'function') channel.checkHealth()
        else channel.ensureRetrying?.()
      } catch {}
      if (now - lastWatchdogStart < 3_600_000) return
      lastWatchdogStart = now
      const result = await napcat.ensure({ reason: 'watchdog' })
      if (result.started) log('[whale] 看门狗已拉起 NapCat')
      else if (result.error) log('[whale] 看门狗：' + result.error)
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
      await outbound('private', owner, digest)
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
      const line = await activeRunner('群里正聊着：\n' + context + '\n你顺着这个话题插一句，短、自然、不抢戏。插不上就只回一个句号。', { conversation: 'group:' + gid })
      const text = String(line?.text || '').trim()
      if (!text || text === '。' || text.length < 4) return
      // 思维链先于发言：群里的插话也要先想后说
      runtime.logCot?.({
        conversation: 'group:' + gid,
        kind: 'interject',
        text: String(line?.reasoning || '（群里插话，没有单独输出思考过程）'),
        summary: '群里插话：' + text.slice(0, 80),
        at: Date.now(),
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
      const morningText = `昨晚到今早，有 ${rows.length} 条消息：\n${lines.join('\n')}`
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
      for (const item of runtime.reminders.due()) {
        await outbound('private', item.to, item.text)
        runtime.reminders.markSent(item.id)
        log('[whale] 已发提醒：' + item.text.slice(0, 60))
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
     * 三个条件缺一不可：有正在等的请求、是私聊、来自主人。
     * 少一个就交给正常聊天 —— 否则主人在群里随口一句「同意」会被当成授权。
     */
    const takeApprovalReply = (raw) => {
      const desk = sandbox.approvals
      if (!desk || typeof desk.takeReply !== 'function' || !desk.list().length) return false
      if (raw?.kind !== KIND.MESSAGE || raw?.scope !== SCOPE.PRIVATE) return false
      const owner = String(runtime.config.identity?.ownerId || '')
      if (!owner || String(raw.from || '') !== owner) return false
      const verdict = desk.takeReply(raw.text)
      if (!verdict) return false
      // 事件照样落盘：主人在对话里确实说了这句，记录里不该凭空少一条
      try {
        const decision = runtime.decide(raw, { config: runtime.config })
        runtime.logEvent(decision.event, { approval: 'reply' })
      } catch {}
      outbound('private', owner, verdict.message, { system: true }).catch((error) => {
        log('[whale] 确认回执没发出去：' + String(error?.message || error))
      })
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
            if (route === '/hotnews/test' && req.method === 'POST') {
              const owner = String(runtime.config.identity?.ownerId || '')
              if (!owner) { sendJson(res, 200, { ok: false, error: '没有配置主人 QQ' }); return }
              const rows = await searchWebDetailed('今日热点 新闻', 3)
              if (!Array.isArray(rows) || !rows.length) { sendJson(res, 200, { ok: false, error: '没有搜到热点' }); return }
              const parts = await hotParts(rows)
              if (!parts.length) { sendJson(res, 200, { ok: false, error: '热点内容为空' }); return }
              const hotText = '看到个热点：' + parts[0]
              await outbound('private', owner, parts[1] ? [hotText, parts[1]] : [hotText])
              sendJson(res, 200, { ok: true, parts })
              return
            }
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
            if (route === '/policy') {
              // 这张表是**工具层**，不是技能层。
              // 以前每行只给「名字 + 中文标签」，而标签是从技能名抄过来的
              // （send_face 叫「发小黄脸」，和技能页那一项一模一样），
              // 于是同一批名字在两个页面各出现一次，看起来像技能混进了工具列表。
              // 现在每行都带上它属于哪一项技能、那项技能现在开没开。
              const owners = typeof runtime.toolOwners === 'function' ? runtime.toolOwners() : new Map()
              const blocked = typeof runtime.blockedTools === 'function' ? runtime.blockedTools() : null
              const rows = (typeof tools.names === 'function' ? tools.names() : []).map((name) => {
                const list = owners.get(name) || []
                return {
                  name,
                  label: typeof tools.label === 'function' ? tools.label(name) : name,
                  skill: list[0] ? { id: list[0].id, name: list[0].name } : null,
                  // 有多个技能共用同一个工具时（例如 send_sticker 被三项用），全列出来
                  skills: list.map((item) => ({ id: item.id, name: item.name })),
                  // 技能页里这一项被关掉了 —— 模型调不到，主人手动还能用
                  off: blocked instanceof Set ? blocked.has(name) : false,
                }
              })
              sendJson(res, 200, {
                ok: true,
                tools: rows,
                // 没有归属的工具：跑得动、却不在任何一项技能下，关不掉也记不了次数。
                // 面板把这一栏显出来，比让它静默存在好。
                unowned: rows.filter((row) => !row.skill).map((row) => row.name),
                toolWhitelist: Array.isArray(runtime.config.tools?.whitelist) ? runtime.config.tools.whitelist : [],
                netWhitelist: Array.isArray(runtime.config.net?.allowlist) ? runtime.config.net.allowlist : [],
              })
              return
            }
            if (route === '/groups') {
              const groups = await channel.groupList()
              sendJson(res, 200, {
                ok: true,
                groups: groups.map((g) => ({ id: String(g.group_id || g.groupId || ''), name: String(g.group_name || g.groupName || '') })),
              })
              return
            }
            // 图片本体：面板和导出都从这里取，不再依赖会过期的 CDN 链接
            if (route.startsWith('/media/') && req.method === 'GET') {
              const name = decodeURIComponent(route.slice('/media/'.length))
              const file = mediaPath(runtime.dir, name)
              if (!file || !existsSync(file)) {
                sendJson(res, 404, { ok: false, error: '没有这张图' })
                return
              }
              const data = readFileSync(file)
              const ext = name.split('.').pop().toLowerCase()
              res.writeHead(200, {
                'content-type': 'image/' + (ext === 'jpg' ? 'jpeg' : ext),
                'cache-control': 'public, max-age=86400',
                'content-length': data.length,
              })
              res.end(data)
              return
            }
            if (route === '/napcat/qr') {
              // 路径由登录层解析（启动脚本 / 默认目录），不在路由里再抄一份版本号
              const qr = String(napcat.plan().qrPath || runtime.config.channel?.qrcodePath || '')
              if (!qr || !existsSync(qr)) { sendJson(res, 404, { ok: false, error: '还没有二维码' }); return }
              const data = readFileSync(qr)
              res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': data.length })
              res.end(data)
              return
            }
            if (route === '/napcat/qr/refresh' && req.method === 'POST') {
              const result = await napcat.retryQr()
              await napcat.poll()
              sendJson(res, 200, { ...result, login: napcat.snapshot() })
              return
            }
            // 登录的统一入口：状态、重试、换方式、刷新、重启协议端。
            // 面板只发一个动作词，具体怎么调用 NapCat 全在 lib/napcat.mjs 里。
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
            if (route === '/status') {
              const status = runtime.status()
              sendJson(res, 200, {
                ok: true,
                status,
                channel: channel.state(),
                login: napcat.snapshot(),
                guard: guard.stats(),
                usage: usage.line(),
                turnReady: started && turn?.ready === true,
              })
              return
            }
            if (route === '/skills') {
              sendJson(res, 200, { ok: true, ...runtime.skills() })
              return
            }
            if (route === '/brief') {
              sendJson(res, 200, { ok: true, lines: runtime.skillBriefing() })
              return
            }
            if (route === '/memory') {
              sendJson(res, 200, {
                ok: true,
                stats: runtime.memory.stats(),
                facts: runtime.memory.facts().slice(-50),
                people: Object.values(runtime.memory.data.people || {}).slice(-30),
              })
              return
            }
            if (route === '/memory/remember' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.memory.rememberFact(String(body.text || ''), { source: 'panel' }))
              return
            }
            if (route === '/vision/test' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, await describeImageFile(String(body.path || ''), String(body.question || '')))
              return
            }
            if (route === '/reminder/cancel' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.reminders.cancel(String(body.id || '')))
              return
            }
            if (route === '/reminder/update' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.reminders.update(String(body.id || ''), { text: body.text, at: body.at }))
              return
            }
            if (route === '/memory/edit-self' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.memory.updateSelf(String(body.old || ''), String(body.text || '')))
              return
            }
            if (route === '/memory/forget-self' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.memory.forgetSelf(String(body.text || '')))
              return
            }
            // 撤销用：删错了再把这条写回去。没有这个入口的话，
            // 面板上的「删除」是单向门 —— 点歪一次就得重新跟它说一遍。
            if (route === '/memory/remember-self' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.memory.rememberSelf(String(body.text || '')))
              return
            }
            if (route === '/memory/edit' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.memory.updateFact(String(body.old || ''), String(body.text || '')))
              return
            }
            if (route === '/memory/edit-person' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.memory.updatePerson(String(body.uin || ''), { name: body.name, note: body.note, impression: body.impression }))
              return
            }
            if (route === '/memory/edit-group' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.memory.updateGroup(String(body.groupId || ''), { label: body.label, topic: body.topic }))
              return
            }
            if (route === '/memory/forget' && req.method === 'POST') {
              const body = await readBody(req)
              // 面板历史上传的是 `text`，这里读的是 `target` —— 只认一个就会删错东西。
              // 两个都收，谁先有值用谁；都没有就交给 memory 那一层的空键保护挡掉。
              const target = body.target ?? body.text ?? ''
              sendJson(res, 200, runtime.memory.forgetFact(String(target)))
              return
            }
            if (route === '/memory/forget-person' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.memory.forgetPerson(String(body.uin || '')))
              return
            }
            if (route === '/memory/forget-group' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.memory.forgetGroup(String(body.groupId || '')))
              return
            }
            if (route === '/usage') {
              sendJson(res, 200, { ok: true, today: usage.today(), line: usage.line(), total: typeof usage.total === 'function' ? usage.total() : null })
              return
            }
            // 「先问我」档的弹窗数据口。前端每隔一秒半轮一次：
            // 面板 5 秒一轮太慢，等 60 秒的倒计时要靠它显示剩几秒。
            if (route === '/approvals' && req.method === 'GET') {
              const desk = sandbox.approvals
              sendJson(res, 200, {
                ok: true,
                now: Date.now(),
                pending: desk.list(),
                remember: desk.remember(),
                stats: desk.stats(),
              })
              return
            }
            if (route === '/approvals/decide' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, sandbox.approvals.decide(String(body.id || ''), {
                allow: body.allow === true,
                remember: body.remember === true,
                reason: String(body.reason || ''),
              }))
              return
            }
            if (route === '/approvals/forget' && req.method === 'POST') {
              sendJson(res, 200, sandbox.approvals.forget())
              return
            }
            // 面板要显示的所有字，在这里一次算完。
            // 前端只负责摆位置 —— 判断留在宿主，才能被 npm test 钉住。
            if (route === '/panel') {
              sendJson(res, 200, panelView({ runtime, chat, usage, guard, channel, typing, attention }))
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
              if (!id) { sendJson(res, 200, { ok: false, error: '没说要看哪一条（缺 id）' }); return }
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
                sendJson(res, 200, { ok: false, error: '本地记录里没有这条，通道又不在线，暂时查不到原文' })
                return
              }
              const remote = await channel.getMessage(id)
              if (!remote || remote.ok !== true || (!String(remote.text || '').trim() && !(remote.images || []).length)) {
                sendJson(res, 200, { ok: false, error: '协议端也查不到这条了（可能已过期或被撤回）' })
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
                sendJson(res, 200, { ok: false, error: '生成能力还没接上：宿主没把模型给我' })
                return
              }
              const result = await chat.send({ text: body.text })
              sendJson(res, 200, { ...result, ...chat.history({ limit: 60 }) })
              return
            }
            if (route === '/chat/reset' && req.method === 'POST') {
              sendJson(res, 200, chat ? chat.reset() : { ok: false, error: '还没有对话' })
              return
            }
            // 从面板直接替它发一句。出站必须过 runtime.outbound（截断、防空、脱敏），
            // 与自动回复走同一个口 —— 面板不该有第二套发送逻辑。
            if (route === '/qq/send' && req.method === 'POST') {
              const body = await readBody(req)
              const conversation = String(body.conversation || '')
              const text = String(body.text || '').trim()
              if (!conversation) {
                sendJson(res, 200, { ok: false, error: '不知道发给谁' })
                return
              }
              if (!text) {
                sendJson(res, 200, { ok: false, error: '空消息不发' })
                return
              }
              const state = channel.state()
              if (state !== 'online') {
                sendJson(res, 200, { ok: false, error: `通道现在是「${state}」，发不出去` })
                return
              }
              const peer = peerOf(conversation)
              const scope = peer.scope === 'group' ? 'group' : 'private'
              if (scope === 'group') {
                const groups = await channel.groupList()
                if (groups.length && !groups.some((group) => String(group.group_id || group.groupId || '') === String(peer.id))) {
                  sendJson(res, 200, { ok: false, error: '这个群号不在机器人加入的群列表里，可能是旧会话把用户 QQ 当成了群号；请从新的群聊会话里发送。' })
                  return
                }
              }
              try {
                const payload = runtime.outbound(card({ line: text }), 'qq')
                await channel.say(scope, peer.id, payload)
                guard.note(Date.now())
                runtime.noteSelfMessage({ conversation, scope, text: payload, at: Date.now() })
                runtime.log('panel_send', { conversation, scope, chars: payload.length, actor: 'panel' })
                sendJson(res, 200, { ok: true, text: payload })
              } catch (error) {
                sendJson(res, 200, { ok: false, error: String(error?.message || error) })
              }
              return
            }
            if (route === '/skill/forget' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.forgetSkill(String(body.id || '')))
              return
            }
            // 改一条教过的技能：名字/说明/分组。id 不变，开关与成功率都留着。
            // 「忘掉重教」会把履历清零，打错一个字的代价不该这么大。
            if (route === '/skill/amend' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.amendSkill(String(body.id || ''), {
                name: body.name === undefined ? undefined : String(body.name),
                what: body.what === undefined ? undefined : String(body.what),
                group: body.group === undefined ? undefined : String(body.group),
              }, { actor: 'panel' }))
              return
            }
            if (route === '/skill/teach' && req.method === 'POST') {
              const body = await readBody(req)
              sendJson(res, 200, runtime.teachSkill({
                name: String(body.name || ''),
                what: String(body.what || ''),
                group: String(body.group || 'do'),
                risk: String(body.risk || 'low'),
              }))
              return
            }
            if (route === '/skill' && req.method === 'POST') {
              const body = await readBody(req)
              const id = String(body.id || '')
              // 只认 on/off 两个字面量：让前端传布尔会在「传了 'false' 字符串」时翻车，
              // 那种错表现为「点了没反应」，最难查。
              const state = body.on === true ? 'on' : 'off'
              const result = runtime.setSkill(id, state, { confirm: body.confirm === true, actor: 'panel' })
              sendJson(res, 200, result)
              return
            }
            if (route === '/config/reload' && req.method === 'POST') {
              // config.json 被外面改过（手改 / 脚本 / 副本同步）之后，
              // 内存里这份还是旧的：面板照着旧值显示，节奏照着旧值走。
              // 这里重新按磁盘装配一遍并把修好的值写回 —— 不重启也能让修正生效。
              const result = runtime.reloadConfig()
              guard.configure(runtime.config)
              attention.configure(runtime.config)
              usage.configure(runtime.config)
              channel.config = runtime.config
              napcat.relink(runtime.config)
              result.login = napcat.snapshot()
              sendJson(res, 200, result)
              return
            }
            if (route === '/config' && req.method === 'POST') {
              const body = await readBody(req)
              const key = String(body.key || '')
              const result = runtime.setConfig(key, body.value, { confirm: body.confirm === true })
              // 改了配置要同步给各层，否则「改完不生效」会变成常态
              if (result.ok) {
                guard.configure(runtime.config)
                attention.configure(runtime.config)
                usage.configure(runtime.config)
                channel.config = runtime.config
                napcat.relink(runtime.config)
                // 启动项里的参数跟着登录方式走：扫码不带 -q，票据/密码带 -q。
                // 登录方式、密码、QQ 号改了都要重写，否则下次开机又按老方式起。
                if (key === 'channel.autoStartNapcat' || key === 'channel.napcatBat' || key === 'channel.selfId' || key.startsWith('channel.login.')) {
                  const synced = syncNapcatAutostart(runtime.config, napcat)
                  if (!synced.ok) log('[whale] 开机自启设置失败：' + synced.error)
                }
                // 登录方式 / 密码改完立即试一次：这才是「改完就生效」，不用等重启 DSH。
                // autoQr 不必主动重试，下一轮轮询就会按新开关说话。
                if (key === 'channel.login.mode' || key === 'channel.login.password') {
                  try {
                    const attempt = await napcat.retry({ mode: String(runtime.config.channel?.login?.mode || 'ticket') })
                    if (attempt.login) result.login = attempt.login
                    const note = attempt.message || attempt.error
                    if (note) result.message = String(result.message || '改好了') + '；' + note
                  } catch (error) {
                    log('[whale] 按新登录方式重试失败：' + String(error?.message || error))
                  }
                }
                // 通道地址/令牌/QQ 号/开关变了才重连；只改登录相关的不该把在线连接踢掉
                if (key === 'channel.enabled' || key === 'channel.wsUrl' || key === 'channel.token' || key === 'channel.selfId') {
                  try {
                    channel.stop()
                    if (runtime.config.channel?.enabled !== false) channel.start()
                  } catch (error) {
                    log('[whale] 通道重连失败：' + String(error?.message || error))
                  }
                  if (key === 'channel.enabled' && runtime.config.channel?.enabled === true) {
                    napcat.ensure({ reason: 'manual' }).catch((error) => log('[whale] 启动协议端失败：' + String(error?.message || error)))
                  }
                }
                if (!result.login) result.login = napcat.snapshot()
              }
              sendJson(res, 200, result)
              return
            }
            sendJson(res, 404, { ok: false, error: `没有这个接口：${route}` })
          } catch (error) {
            sendJson(res, 500, { ok: false, error: String(error?.message || error) })
          }
        },
      }),
    'shenlan: /api/shenlan 路由',
  )

  log(`[whale] 已挂载｜数据目录 ${dir}｜路由 ${ROUTE_PREFIX}`)
}

/** 测试用：不经过宿主也能装一套 */
export { ROUTE_PREFIX }
