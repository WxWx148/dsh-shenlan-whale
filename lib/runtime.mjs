/**
 * lib/runtime.mjs — 装配层：把「事件 → 路由 → 行为 → 归纳 → 权重 → 说话参数」接成一条链。
 *
 * 这一层存在的唯一理由：**别的模块各自都对，不代表它们连在一起也对。**
 *   event 打标准、behavior 路由对、evolve 权重对、style 规则对，
 *   但中间少了一根线，整条链就是死的 —— 旧版 25 条接口没人调，就是这么来的。
 *
 * 这里只做装配，不实现业务：
 *   生成对话内容在 turn.mjs；收发在 channel.mjs；限流在 guard.mjs。
 *   本层负责「谁先谁后、谁把结果交给谁」，并且让整条链可以离线跑测试。
 *
 * 一次消息在运行时里的真实路径：
 *   runtime.decide(raw)          → 事件 + 路由结果（不产生副作用，纯判断）
 *   runtime.outcome({...})       → 写行为记录
 *   runtime.reflect({...})       → 归纳 + 进化（维护阶段调用）
 *   runtime.styleOptions()       → 给 turn 的说话参数（进化值 ∩ 用户硬上限）
 */

import path from 'node:path'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { backupCorrupt, loadConfig, openJournal, paths, quarantineIfCorrupt, readJson, saveConfig, writeJson } from './core.mjs'
import { EventTagger, KIND, repairGroupConversations } from './event.mjs'
import { record, route } from './behavior.mjs'
import { induce, deriveRewards } from './induction.mjs'
import { Evolver } from './evolve.mjs'
import { SkillBook, STATE as SKILL_STATE, allToolNames, bindWeights, blockedTools as blockedToolNames, brief, implementedTools, lineOf, registerTools as registerToolNames, skillIdOfTool, toolOwners } from './skill.mjs'
import { WhaleMemory } from './memory.mjs'
import { Reminders } from './reminders.mjs'
import { loadStickers } from './stickers.mjs'
import { styleGuide } from './style.mjs'
import { card, forQq, render } from './say.mjs'
import { applyInto, set as setConfigValue } from './config.mjs'
import { PENDING_KEYS, RISK, find, isPending } from './panel.mjs'
import { auditFilter, severityOf, tracePass } from './log.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 包里唯一一份版本号，不另存一份防止对不上。
 *
 * 读一次就记住：版本号在一次进程生命周期里不会变（换了版本必须重启插件）。
 * 以前 status() 每调一次就读一遍 package.json —— 面板每 2.5 秒刷新一次，
 * 就是每 2.5 秒读一次磁盘。读失败**不缓存**：一次临时 IO 错误不该让面板
 * 从此永远显示 0.0.0。
 */
let PACKAGE_VERSION = ''
function packageVersion() {
  if (PACKAGE_VERSION) return PACKAGE_VERSION
  try {
    const raw = readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')
    PACKAGE_VERSION = String(JSON.parse(raw).version || '0.0.0')
    return PACKAGE_VERSION
  } catch {
    return '0.0.0'
  }
}

/** 今天零点（本地时区） */
function startOfDay(at) {
  const date = new Date(Number(at) || Date.now())
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 按 `a.b.c` 读一个值。审计要记「改前是什么」，得先读得出来 */
function readPath(source, key) {
  let cursor = source
  for (const part of String(key || '').split('.')) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined
    cursor = cursor[part]
  }
  return cursor
}

/**
 * 这条记录在游标之后吗？
 * 用 (时间, id) 复合比较 —— 同一毫秒可能写进好几条，只比时间会漏掉其中几条。
 */
function afterCursor(row, cursor) {
  const at = Number(row?.at || row?.ts) || 0
  if (!cursor || !cursor.at) return true
  if (at > cursor.at) return true
  if (at < cursor.at) return false
  return String(row?.id || '') > String(cursor.id || '')
}

/** 通道状态只认这几个值：面板按它显示，别在别处另造一套词 */
// 通道状态是运行时内部的说法，外面不需要知道。收成私有，减少公开面。
const CHANNEL_STATE = Object.freeze({
  OFF: 'off', // 没开
  UNKNOWN: 'unknown', // 开着，但通道层还没报告
  WAITING_QR: 'waiting_qr', // 等扫码
  ONLINE: 'online',
  OFFLINE: 'offline',
})
const CHANNEL_STATES = new Set(Object.values(CHANNEL_STATE))

export class Runtime {
  /**
   * @param {object} input
   * @param {string} input.dir      数据目录（~/.dsh/qq-fish）
   * @param {object} [input.config] 已加载的配置；不传就从磁盘读
   * @param {() => number} [input.now]
   */
  constructor(input = {}) {
    if (!input.dir) throw new TypeError('Runtime 需要数据目录 dir')
    this.dir = String(input.dir)
    this.now = input.now || (() => Date.now())
    this.p = paths(this.dir)
    try {
      this.groupRepair = repairGroupConversations(this.dir)
    } catch {
      this.groupRepair = { changed: 0, backup: '' }
    }

    const loaded = input.config ? { config: input.config, report: '', filled: [], dropped: [], repaired: [], recovered: false, readError: '', backup: '' } : loadConfig(this.dir)
    this.config = loaded.config
    this.configReport = loaded.report
    this.configIssues = { filled: loaded.filled, dropped: loaded.dropped, repaired: loaded.repaired, recovered: loaded.recovered, backup: loaded.backup }
    // 修好的值要写回磁盘。只修内存会留下一个更难查的局面：
    // 面板读内存显示 2 秒，磁盘上还是旧值，下次冷启动再修一遍，
    // 而任何直接读 config.json 的地方（脚本、编辑器、排查记录）看到的都是错的。
    // 只在「真的修过」时写，正常配置一个字节都不动。
    if (!input.config && Array.isArray(loaded.repaired) && loaded.repaired.length) {
      try { saveConfig(this.dir, this.config) } catch {}
    }
    this.memory = new WhaleMemory({ dir: this.dir, now: this.now, maxEntries: this.config.memory?.maxEntries, summaryEvery: this.config.memory?.summaryEvery, netEntries: this.config.memory?.net?.entries, netHops: this.config.memory?.net?.hops, netDecay: this.config.memory?.net?.decay })
    this.reminders = new Reminders({ dir: this.dir, now: this.now })
    try {
      this.groupBackfill = this.memory.backfillGroups(this.p.events)
    this.activeUntil = new Map()
    this.activeTurns = new Map()
    this.liveCot = new Map()
    } catch {
      this.groupBackfill = { changed: 0 }
    }

    this.tagger = new EventTagger({
      ...this.#taggerOptions(),
      now: this.now,
      isActive: (conversation) => this.isActive(conversation),
    })

    const evolveFile = readJson(this.p.evolve, null)
    // 权重历史是「学出来的东西」，手改坏了也要留原件，不能一启动就抹掉
    const evolveBackup = evolveFile.ok ? '' : backupCorrupt(this.p.evolve, this.now())
    this.evolver = new Evolver({
      state: evolveFile.ok ? evolveFile.value : null,
      options: this.config.evolve || {},
    })

    // 技能簿：开关、教过的、各自的成功次数。
    // 读不动先备份再当空的 —— 用户教的东西是唯一不可再生的资产，
    // 权重可以重学，教过的话丢了就得让他重说一遍。
    const skillFile = readJson(this.p.skills, null)
    const skillBackup = skillFile.ok ? '' : backupCorrupt(this.p.skills, this.now())
    this.skillBook = new SkillBook({ data: skillFile.ok ? skillFile.value : null, now: this.now })

    // 这一份是「真的能调」的工具表，从技能层的注册表拷一份到自己手里。
    // 为什么每个运行时各持一份而不是直接读全局：测试要能造出「什么都没接」的世界，
    // 而全局状态一改就污染同进程的其他用例。
    this.impl = new Set(implementedTools())

    // 记住「磁盘上现在是什么内容」。用途见 save()：两个进程同时写一个目录时，
    // 后写的会把先写的整份覆盖 —— 这种事必须在发生时就留痕，不能等用户发现技能少了才查。
    // 不用文件修改时间：同一毫秒内的两次写入时间戳一样，检测不出来（实测过）。
    this.skillDigest = this.#readText(this.p.skills)

    this.events = openJournal(this.dir, 'events', { now: this.now })
    this.behaviors = openJournal(this.dir, 'behaviors', { now: this.now })
    this.audit = openJournal(this.dir, 'audit', { now: this.now })
    this.cot = openJournal(this.dir, 'cot', { now: this.now })
    this.activities = openJournal(this.dir, 'activity', { now: this.now })

    // 整份日志读不动就挪走再重新开始。
    // 不处理的话，新记录会追加在垃圾后面，从此一条都读不出来，而且不报错 ——
    // 「看起来在跑，其实什么都没记住」是最难发现的一种坏。
    const quarantined = []
    for (const [name, journal] of [['events', this.events], ['behaviors', this.behaviors], ['cot', this.cot], ['audit', this.audit]]) {
      const moved = quarantineIfCorrupt(journal, this.now())
      if (moved) quarantined.push({ journal: name, moved })
    }

    this.dirtyRestart = false
    this.startedAt = this.now()
    // 通道状态由通道层报告（扫码/上线/掉线）。没报告之前是 unknown，
    // 不能默认成「在线」——面板上说在线、实际发不出去，比说「未知」糟得多。
    this.channelState = this.config.channel?.enabled ? CHANNEL_STATE.UNKNOWN : CHANNEL_STATE.OFF

    // 起过一次坏文件就要留痕：面板安全页要能看到「我回退过，原件在这」
    if (loaded.recovered || evolveBackup || skillBackup) {
      this.log('recovered', {
        config: loaded.recovered ? { error: loaded.readError, backup: loaded.backup } : null,
        evolve: evolveBackup ? { backup: evolveBackup } : null,
        skills: skillBackup ? { backup: skillBackup } : null,
      })
    }
    if (quarantined.length) {
      this.log('journal_quarantined', { items: quarantined })
    }
  }

  // ── 判断：只读放行 ────────────────────────────────────────────

  /**
   * 一条原始输入 → 事件 + 该做什么。**不写日志、不发消息**。
   *
   * 通道层是外部边界，完全可能送来畸形数据（段解析失败、字段缺失、类型不对）。
   * 一条脏包不该把消息循环打断，所以这里兜住并落一条审计；
   * 严格性由 EventTagger.tag() 保证（它照旧抛），只是不往上传。
   *
   * @param {object} raw
   * @param {object} [ctx] 由 guard / 定时器 / 指令表提供
   */
  decide(raw, ctx = {}) {
    try {
      const event = this.tagger.tag(raw)
      return { event, ...route(event, ctx) }
    } catch (error) {
      const detail = error?.message || String(error)
      this.log('invalid_event', {
        error: detail,
        source: String(raw?.source || ''),
        // 故意不叫 kind：审计记录自己的 kind 是 invalid_event，
        // 原始事件的类型放另一个名字，两者不要抢同一个字段
        eventKind: String(raw?.kind || ''),
        scope: String(raw?.scope || ''),
      })
      return { event: null, behavior: null, trigger: 'invalid_event', reason: `这条事件不合法：${detail}` }
    }
  }

  /**
   * 同一条 QQ 消息只处理一次。
   *
   * 重连补回、重复投递、多开一个连接，都可能把同一条 message_id 送两遍；
   * 不去重的话，聊天记录里同一句会出现两次，上下文也会被它多占一格。
   * 内存里留最近 5000 个；第一次用时从日志回填，重启后也能接上。
   */
  claimMessage(messageId) {
    const id = String(messageId || '')
    if (!id) return true
    if (!this.seenMessageIds) {
      this.seenMessageIds = new Set()
      try {
        const rows = this.events.read({
          limit: 1000,
          maxScan: 5000,
          filter: (row) => Boolean(row?.messageId),
        }).rows || []
        for (const row of rows) this.seenMessageIds.add(String(row.messageId))
      } catch {}
    }
    if (this.seenMessageIds.has(id)) return false
    this.seenMessageIds.add(id)
    if (this.seenMessageIds.size > 5000) {
      const oldest = this.seenMessageIds.values().next().value
      this.seenMessageIds.delete(oldest)
    }
    return true
  }

  /** 打完标就把事件落盘（只读事实先进库，后面回不回都不影响统计） */
  logEvent(event, extra = {}) {
    if (!event || !event.id) return { ok: false, error: '没有可记录的事件' }
    const text = String(event.payload?.text || '')
    const sender = String(event.payload?.senderName || '')
    const group = String(event.payload?.groupId || '')
    const replyId = String(event.payload?.replyId || '')
    // 引用摘要：有的协议端会把被引用正文塞在 reply 段里。
    // 存下来，面板/上下文在 get_msg 取不到时才有东西可看。
    const replySummary = String(event.payload?.replySummary || '').slice(0, 300)
    // message_id 是唯一能跟 QQ 对上的键：面板靠它还原引用，补回靠它跨实例去重。
    const messageId = String(event.payload?.messageId || '')
    return this.events.append({
      kind: 'event',
      id: event.id,
      source: event.source,
      type: event.kind,
      scope: event.scope,
      from: event.from,
      conversation: event.conversation,
      tags: [...event.tags],
      at: event.at,
      // 正文必须落下来。旧版只存了「谁、什么时候、哪个会话」，于是
      // 「他刚才跟谁聊了什么」这个最基本的问题，面板根本答不了；
      // 连给模型的上下文也只能是空的（prompt 里那几行 recent 永远是 0 条）。
      // 截 500 字是刻意的：事实保留，只是超长消息不整条存 —— 日志不该被一条消息撑爆。
      ...(text ? { text: text.slice(0, 500) } : {}),
      ...(sender ? { sender: sender.slice(0, 64) } : {}),
      ...(group ? { group } : {}),
      ...(replyId ? { replyId } : {}),
      ...(replySummary ? { replySummary } : {}),
      ...(messageId ? { messageId } : {}),
      ...(extra && typeof extra === 'object' ? extra : {}),
    })
  }

  /**
   * 记一条「我自己说出去的话」。
   *
   * 收发是同一段对话的两半。只记收到的那半，QQ 界面就会显示成
   * 「对方一个人自言自语」；拼上下文时也读不到自己上一句说了什么。
   *
   * @param {{conversation:string, scope:string, text:string, at?:number}} input
   */
  noteSelfMessage(input = {}) {
    const body = String(input.text || '').trim()
    if (!body) return { ok: false, error: '空消息不记' }
    const at = Number(input.at) || this.now()
    const conversation = String(input.conversation || '')
    // 群号能从不传字段里推出来：群回顾/插话判断都按 group 过滤，
    // 少了这一格，自己说过的话在群里就等于没说过。
    const group = String(input.group || '') || (/^group:(\d+)$/.exec(conversation)?.[1] || '')
    this.selfSeq = (Number(this.selfSeq) || 0) + 1
    return this.events.append({
      kind: 'event',
      id: `self_${at}_${this.selfSeq.toString(36)}`,
      source: 'internal',
      type: 'message',
      scope: String(input.scope || 'private'),
      from: 'self',
      conversation,
      tags: ['sent'],
      at,
      text: body.slice(0, 500),
      sender: '我',
      ...(group ? { group } : {}),
    })
  }

  // ── 记账：行为落盘 ────────────────────────────────────────────

  /**
   * 一次行为结束后记一笔。
   * @param {object} input
   * @param {string} input.eventId
   * @param {string} input.behavior
   */
  /**
   * 记一次行为的结果。**这是行为链与技能链唯一的接缝**。
   *
   * 行为里带 `tool` 时顺手记一次技能使用：一次回复也可能真的调用了「上网搜一下」，
   * 那一笔不该靠调用方再单独喊一次 recordSkill —— 漏喊一次，学会的证据就少一笔，
   * 而且没有任何地方会报错。接在这里，「用了什么」跟着「做了什么」一起落，跑不掉。
   */
  outcome(input = {}) {
    const result = record(this.behaviors, input)
    const used = String(input.tool || '')
    if (result.ok && used) {
      // `tool` 这一栏两种写法都有：内部路径直接给技能 id（net.search），
      // 模型那条路给的是工具名（web_search）。账要记到技能上，
      // 所以先按工具名反查一次；查不到再看它本身是不是技能 id（教的技能不走这里）。
      const id = this.skillIdOfTool(used) || (this.skillBook.find(used) ? used : '')
      if (!id) {
        // 没归属的工具调了也不记账 —— 但必须留痕，否则「有个能力在跑却没人管」
        // 永远只能靠人去数工具表。一次一行，不刷屏由调用方决定。
        this.log('tool_no_skill', { tool: used, behavior: String(input.behavior || '') })
        return result
      }
      this.recordSkill(id, input.ok !== false, {
        eventId: String(input.eventId || ''),
        behavior: String(input.behavior || ''),
        // 记下真实工具名：面板/审计里能看出「这次是用 web_search 干的」
        tool: used,
      })
    }
    return result
  }

  /**
   * 工具名 → 技能 id。含教出来的技能（它们的 tools 里写着自己的 id，那个会被跳过）。
   * 查不到就返回空串，调用方据此跳过，而不是硬记一笔静默失败的账。
   */
  skillIdOfTool(name) {
    try {
      return skillIdOfTool(name, this.skillBook?.list() || [])
    } catch {
      return ''
    }
  }

  /** 工具 → 归属技能（面板「调用工具」按技能分组要用） */
  toolOwners() {
    try {
      return toolOwners(this.skillBook?.list() || [])
    } catch {
      return new Map()
    }
  }

  /**
   * 终端这一行要不要打 —— 这是 `log.level` 唯一真正管的东西。
   *
   * 为什么单独一个方法而不是到处 `if (config.log.level === 'debug')`：
   * 那种写法散在十几个文件里，加一档就要全改一遍，而且没人知道一共几处。
   * 这里只有一条规则（严重度 <= 门槛就放行），改规则只改 lib/log.mjs。
   *
   * @param {'error'|'warn'|'info'|'debug'} level
   */
  trace(level, text, detail) {
    if (!tracePass(this.config, level)) return false
    try {
      this.tracer?.(level, text, detail)
    } catch {
      // 宿主日志不可用就安静，不影响功能
    }
    return true
  }

  /** 宿主把 logger 递进来；没递就什么都不打（不报错、不影响别的事） */
  setTracer(fn) {
    this.tracer = typeof fn === 'function' ? fn : null
    return this
  }

  /** 审计：谁改了什么、为什么拒。**落盘不脱敏**（脱敏只在出站） */
  log(kind, detail = {}) {
    // 顺序不能反：detail 里常带一个 `kind`（原始事件的类型，比如 message），
    // 写成 { kind, ...detail } 会被它覆盖，于是「非法事件」那条记录
    // 在审计里变成一条 message，按 kind 一查就查不到。
    const result = this.audit.append({ ...detail, kind: String(kind || 'note') })
    // 回声：把审计同步打到终端。默认关 —— 开着一天能刷两万行。
    // 注意它是**回声**，不是写盘条件：echo 关掉、级别调高，磁盘上都照旧一条不少。
    if (this.config?.log?.echo === true) {
      this.trace(severityOf(kind), `[audit:${String(kind || 'note')}]`, detail)
    }
    return result
  }

  /** 审计页当前该按什么过滤（面板与导出共用一处，避免两边口径不一致） */
  auditFilter() {
    return auditFilter(this.config)
  }

  /**
   * 通道层调用：报告自己现在是什么状态。
   * 只收 CHANNEL_STATE 里的值，收到别的就记一条审计并忽略 ——
   * 状态词一旦各写一套，面板上就会出现「已连接」「正常」「online」三种说法。
   */
  markChannel(state) {
    const next = String(state || '')
    if (!CHANNEL_STATES.has(next)) {
      this.log('channel_state_reject', { state: next })
      return { ok: false, error: `不认识的状态：${next || '(空)'}` }
    }
    const prev = this.channelState
    this.channelState = this.config.channel?.enabled ? next : CHANNEL_STATE.OFF
    if (prev !== this.channelState) this.log('channel_state', { before: prev, after: this.channelState })
    return { ok: true, state: this.channelState }
  }

  // ── 反思：归纳 + 进化 ────────────────────────────────────────

  /**
   * 维护阶段跑一次：先归纳，再决定要不要动权重。
   * 归纳是「看」，进化是「动」；两者分开，权重才能带得出证据。
   *
   * **归纳必须真的参与决策**：只用调用方临时给的 rewards，那统计就成了
   * 一份写给人看的报表。所以这里先由 deriveRewards(stats) 派一组基线奖励，
   * 调用方显式给的同名字段覆盖它（人比统计更懂现场）。
   *
   * @param {object} [input]
   * @param {string} [input.reason]
   * @param {string[]} [input.sample]
   * @param {object} [input.rewards]
   * @param {number} [input.responseDelta]
   * @param {number} [input.window]
   */
  reflect(input = {}) {
    const window = Math.max(1, Number(input.window) || Number(this.config.evolve?.window) || 200)
    // 一次多读一些，够判断「有没有积压」；真正处理多少由 window 决定
    const allEvents = this.events.read({ limit: Math.min(4000, window * 8) }).rows
    const allBehaviors = this.behaviors.read({ limit: Math.min(4000, window * 8) }).rows

    // ── 只能学「还没学过的」 ──────────────────────────────
    // 没有游标时，每轮都会把同一批记录再学一遍：群安静三天，权重就被同一批
    // 「该回没回」反复扣到下限 —— 和「EMA 慢性归零」是同一类病，换个入口而已。
    const cursor = this.#reflectCursor()
    const fresh = allEvents.filter((row) => afterCursor(row, cursor))
    // read 是最新在前；按时间正序取最老的 window 条，游标才能单调往前推、不跳条
    const batch = fresh.slice().reverse().slice(0, window)
    const batchMaxAt = batch.length ? Math.max(...batch.map((row) => Number(row.at || row.ts) || 0)) : 0

    const increment = induce({
      events: batch,
      behaviors: allBehaviors.filter((row) => {
        const at = Number(row.at || row.ts) || 0
        return afterCursor(row, cursor) && (!batchMaxAt || at <= batchMaxAt)
      }),
      window,
    })
    // 给面板看的「最近怎么样」始终是全窗口，不受游标影响
    const overall = induce({ events: allEvents.slice(0, window), behaviors: allBehaviors.slice(0, window), window })
    writeJson(this.p.induction, overall)

    // 统计 → 奖励：这一步是「归纳」与「进化」之间唯一的那根线。
    // 用增量而不是全窗口，否则同一批失败会被记很多次账。
    const derived = deriveRewards(increment)
    const given = input.rewards && typeof input.rewards === 'object' ? input.rewards : {}
    const rewards = {
      ...derived.rewards,
      ...given,
      behavior: { ...(derived.rewards?.behavior || {}), ...(given.behavior || {}) },
      tool: { ...(given.tool || {}) },
    }
    const hasReward = Object.keys(rewards.behavior).length > 0 || Object.keys(rewards.tool).length > 0
      || Number.isFinite(Number(rewards.maxParts)) || Number.isFinite(Number(rewards.partChars)) || Number.isFinite(Number(rewards.netDecay))

    // 证据自己造：归纳手里就有最近的事件，不该因为调用方没传 sample 就放弃学习
    const sample = (Array.isArray(input.sample) && input.sample.filter(Boolean).length)
      ? input.sample.filter(Boolean).map(String)
      : batch.slice(-5).map((row) => String(row?.id || '')).filter(Boolean)
    const reason = String(input.reason || '').trim() || derived.notes.join('；')

    const enabled = this.config.evolve?.enabled !== false
    let evolve = { ok: false, error: '进化已关闭' }
    if (!batch.length) {
      evolve = { ok: false, error: '没有新记录，这一轮不用学' }
    } else if (enabled && !hasReward) {
      evolve = { ok: false, error: '这一轮没有需要调的东西' }
    } else if (enabled) {
      evolve = this.evolver.apply({
        at: this.now(),
        reason,
        sample,
        rewards,
        responseDelta: input.responseDelta,
      })
      if (evolve.ok) {
        this.log('evolve', {
          version: evolve.version,
          changes: evolve.changes,
          autoRolledBack: !!evolve.autoRolledBack,
          why: derived.notes,
        })
        this.save()
      }
    }
    // 只有真的处理过这一批，才把游标往前推
    if (batch.length) this.#setReflectCursor(batch[batch.length - 1])
    return { stats: increment, overall, evolve, derived: derived.notes, scanned: batch.length }
  }

  /** 学到哪了。读不出来就当没学过（宁可多学一次，也不要漏学） */
  #reflectCursor() {
    const file = readJson(this.p.reflectCursor, null)
    if (!file.ok || !file.value || typeof file.value !== 'object') return { at: 0, id: '' }
    const at = Number(file.value.at) || 0
    // 游标停在「未来」说明系统时间被往回调过（时区切换、手动改表、从别的机器拷了数据）。
    // 直接信它，之后所有记录都比它早 —— 从此一条都学不到，而且完全没有报错。
    // 超过现在 5 分钟就当作无效，重新学一遍，代价是多算一轮，比永久停学好得多。
    if (at > this.now() + 5 * 60 * 1000) {
      this.log('reflect_cursor_future', { at, now: this.now() })
      return { at: 0, id: '' }
    }
    return { at, id: String(file.value.id || '') }
  }

  #setReflectCursor(row) {
    if (!row) return
    const at = Number(row.at || row.ts) || 0
    const prev = this.#reflectCursor()
    // 游标只往前走。轮转或乱序不该让它倒退，否则会把学过的东西再学一遍。
    if (at < prev.at) return
    writeJson(this.p.reflectCursor, { at, id: String(row.id || ''), savedAt: this.now() })
  }

  // ── 说话：给 turn 的参数（进化值 ∩ 用户硬上限）────────────────
  /**
   * 说话参数。用户配置是硬上限，进化只能在里面动。
   * @param {'private'|'group'} [channel]
   */
  styleOptions(channel = 'private') {
    const { maxParts, partChars } = this.evolver.styleParamsFor(this.config)
    return { channel, maxParts, maxChars: partChars }
  }

  /** 规则块（进提示词的那 198 字） */
  styleGuide(channel = 'private') {
    return styleGuide(this.styleOptions(channel))
  }

  /**
   * 出站唯一出口。**所有**发出去的东西都从这里过：
   *   qq   只发一句话（代码、事实、本地链接一律不发）
   *   panel 卡片，按密度渲染；源码只到 source 层
   *
   * 结构上的意义：只要通道只认 runtime.outbound()，代码就没有第二条路进对话。
   */
  outbound(view, target = 'qq', level = 'card') {
    // 两种入站形状：say.card() 的卡片，或者多行文本（技能直答这种）。
    // 都必须从这里出去 —— 通道拿不到别的出口，「出站必过 say」才是真的。
    // 之前技能直答返回数组、而这里只收对象，等于逼着通道自己 join 一串发出去，
    // 那条路上没有防空、没有截断、没有留痕。
    if (Array.isArray(view)) {
      const lines = view.map((line) => String(line ?? '').trim()).filter(Boolean)
      const joined = lines.join('\n')
      if (!joined) throw new TypeError('出站内容是空的，不发')
      return this.#clampOutbound(joined, target, level)
    }
    if (!view || typeof view !== 'object') throw new TypeError('出站内容必须是 say.card() 的结果')
    let text = target === 'qq' ? forQq(view) : render(view, level)
    // 空消息比不发言更糟：QQ 会发出一片空白，用户以为程序出了问题。
    // 在这里挡住，让调用方在「还没发」的时候就知道自己漏了内容。
    if (!text || !String(text).trim()) throw new TypeError('出站内容是空的，不发')
    return this.#clampOutbound(String(text), target, level)
  }

  /** 超长截断 + 留痕。两条出站路径共用，避免只在一处截 */
  #clampOutbound(text, target, level) {
    const LIMIT = 1000
    if (text.length > LIMIT) {
      this.log('outbound_too_long', { length: text.length, limit: LIMIT, level, target })
      return `${text.slice(0, LIMIT)}…`
    }
    return text
  }

  /** 造一张卡片（失败也走这里，错误会被翻成人话） */
  card(input = {}) {
    return card(input)
  }

  // ── 改配置：一条路走到底（校验 → 写盘 → 审计）─────────────────

  /**
   * 面板改一项。危险项必须带 confirm，否则不写。
   * @param {string} key
   * @param {*} value
   * @param {{confirm?: boolean, actor?: string}} [meta]
   */
  setConfig(key, value, meta = {}) {
    const item = find(key)
    const base = { key, actor: String(meta.actor || 'panel') }
    if (!item) return { ok: false, error: `没有这一项：${key}` }

    // 改之前先记住原来的值。审计只写「改成了什么」是不够的：
    // 想撤销、想回答「以前是多少」、想查「什么时候变的」，都靠这个 before。
    const beforeValue = readPath(this.config, key)

    const checked = this.#applyConfig(key, value)
    if (!checked.ok) {
      this.log('config_reject', { ...base, value: item.secret ? '***' : value, error: checked.error })
      return checked
    }
    if (checked.needConfirm && meta.confirm !== true) {
      this.log('config_confirm_needed', { ...base, label: item.label })
      return { ok: false, needConfirm: true, error: `${item.label} 影响很大，需要再确认一次` }
    }

    const save = saveConfig(this.dir, checked.config)
    if (!save.ok) {
      this.log('config_save_failed', { ...base, error: save.error })
      return { ok: false, error: `保存失败：${save.error}` }
    }
    // 就地更新，**不换对象**：Guard / 通道 / 注意力在装配时拿的是这一份引用，
    // 换掉它等于让它们继续按旧值跑（详见 config.mjs 的 applyInto）
    applyInto(this.config, checked.config)
    if (checked.needRestart) this.dirtyRestart = true
    this.#reconfigure()
    this.log('config', {
      ...base,
      label: item.label,
      before: item.secret ? '***' : beforeValue,
      after: item.secret ? '***' : checked.value,
      needRestart: !!checked.needRestart,
      // 落一条痕迹：这次改动当时并没有生效，事后查「为什么改了没用」能查到这里
      pending: isPending(key),
    })
    return {
      ok: true,
      value: checked.value,
      needRestart: !!checked.needRestart,
      // 保存成功 ≠ 已经生效。这一层差别必须当场说清：
      // 用户最怕的不是「改不了」，是「改了、看着成功了、其实什么都没发生」。
      pending: isPending(key),
      message: isPending(key)
        ? `${item.label} 已保存，但它对应的功能还没接上，暂时不会生效`
        : checked.needRestart
          ? `${item.label} 改好了，重启后生效`
          : `${item.label} 改好了，下一条消息就生效`,
    }
  }

  #applyConfig(key, value) {
    return setConfigValue(this.config, key, value)
  }

  /**
   * 重新按磁盘上的 config.json 装配一遍，并把修好的值写回。
   *
   * 什么时候需要：config.json 被外面改过（手改、脚本、副本同步），
   * 而内存里这份还是旧的 —— 面板照着旧值显示、
   * 节奏照着旧值走，怎么点按钮都改不回来。
   * 要是不重启就没法让磁盘上的修正生效，修数据这件事就永远只能靠重启。
   *
   * @returns {{ ok: boolean, filled: string[], repaired: string[], dropped: string[], recovered: boolean }}
   */
  reloadConfig() {
    const loaded = loadConfig(this.dir)
    // 同上：重载也只换内容，不换身份
    applyInto(this.config, loaded.config)
    this.configReport = loaded.report
    this.configIssues = {
      filled: loaded.filled,
      dropped: loaded.dropped,
      repaired: loaded.repaired,
      recovered: loaded.recovered,
      backup: loaded.backup,
    }
    // 和启动时同一套规则：只在真的修过东西时才落盘，正常配置一个字节都不动
    if (Array.isArray(loaded.repaired) && loaded.repaired.length) {
      try { saveConfig(this.dir, this.config) } catch {}
    }
    this.#reconfigure()
    this.log('config_reload', {
      filled: loaded.filled,
      repaired: loaded.repaired,
      dropped: loaded.dropped,
      recovered: !!loaded.recovered,
    })
    return { ok: true, ...this.configIssues }
  }

  /**
   * 打标器参数。构造与「改配置之后」共用同一份来源。
   *
   * 以前这两处各抄了一遍：想加一个别名、改一次默认作息，只改一处就会出现
   * 「启动时是这样、改一次配置又变回去」—— 最难查的一类不一致。
   */
  #taggerOptions() {
    return {
      ownerId: this.config.identity?.ownerId || '',
      selfNames: [...new Set([this.config.persona?.name || '', '深蓝鲸', '深蓝', '鲸鲸', '小鲸'].filter(Boolean))],
      nightWindow: this.config.guard?.nightWindow || '',
      mergeWindowMs: this.config.guard?.mergeWindowMs || 0,
    }
  }

  /** 配置变了要让有状态的东西跟上（打标器参数、进化参数） */
  #reconfigure() {
    this.tagger.configure(this.#taggerOptions())
    const options = this.config.evolve || {}
    this.evolver.options = {
      ...this.evolver.options,
      window: Math.max(1, Number(options.window) || this.evolver.options.window),
      ema: Math.max(0.01, Math.min(0.5, Number(options.ema) || this.evolver.options.ema)),
      clamp: Math.max(0.01, Math.min(1, Number(options.clamp) || this.evolver.options.clamp)),
      keepVersions: Math.max(1, Number(options.keepVersions) || this.evolver.options.keepVersions),
    }
    // 技能阈值跟着配置走。不接这一步，面板上的「连续失败几次自动关」就是个摆设。
    this.skillBook?.configure({
      autoOffAfterFails: this.config.skills?.autoOffAfterFails,
      maxTaught: this.config.skills?.maxTaught,
    })
    // 通道被关掉就立刻变 off；重新打开则退回 unknown，等通道层报告真实状态。
    // 不能留着上一次的 online：那是过期信息，比不知道更误导。
    if (!this.config.channel?.enabled) {
      this.channelState = CHANNEL_STATE.OFF
    } else if (this.channelState === CHANNEL_STATE.OFF) {
      this.channelState = CHANNEL_STATE.UNKNOWN
    }
  }

  // ── 落盘与状态 ───────────────────────────────────────────────

  save() {
    const config = saveConfig(this.dir, this.config)
    const evolve = writeJson(this.p.evolve, this.evolver.toJSON())
    const skills = this.#writeSkills()
    return { ok: config.ok && evolve.ok && skills.ok, config, evolve, skills }
  }

  /**
   * 只落技能簿。
   *
   * 开关一个技能、用一次工具，改的只有 skills.json。以前这三种情况都走 save()，
   * 顺手把 config.json 与 evolve.json 也重写一遍（各自一次 fsync + rename）。
   * 工具调用是聊天里的高频路径，省下的不是磁盘空间，是每条消息的延迟。
   */
  saveSkills() {
    return this.#writeSkills()
  }

  #writeSkills() {
    // 写之前先看磁盘有没有被别人动过。
    // 面板将来若独立成进程（需求里的「独立 WebUI」），两个人会各持一份内存快照，
    // 后保存的那个会把对方的改动整份抹掉，而且一声不响。
    // 这里做不了锁（跨平台成本太高），但至少做到：留证据、留原件。
    const onDisk = this.#readText(this.p.skills)
    // 基线可以是空串（启动时文件还不存在），那是**有效的**基线，不能当成「没读过」跳过。
    // 早写成 `this.skillDigest && ...` 正好把这个最该抓的场景漏掉了：
    // 两个实例都在文件不存在时启动，随后各自保存，先写的那个就静默消失。
    if (onDisk !== this.skillDigest) {
      const backup = this.#stashConflict(this.p.skills)
      this.log('skills_conflict', { backup, sizeOnDisk: onDisk.length })
    }
    const snapshot = this.skillBook.toJSON()
    const skills = writeJson(this.p.skills, snapshot)
    // 只有真写成功才更新基线：写失败时磁盘还是旧内容，把基线改掉会让下一次
    // 误判成「别人动过文件」，白留一份备份。
    if (skills.ok) this.skillDigest = `${JSON.stringify(snapshot, null, 2)}\n`
    return skills
  }

  /** 读文件原文；读不到当空串 */
  #readText(file) {
    try {
      return existsSync(file) ? readFileSync(file, 'utf8') : ''
    } catch {
      return ''
    }
  }

  /** 把当前磁盘版本另存一份，免得被自己的写入盖掉 */
  #stashConflict(file) {
    try {
      const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, '-')
      const target = `${file}.conflict-${stamp}`
      copyFileSync(file, target)
      return target
    } catch {
      return ''
    }
  }

  /**
   * 技能页要的全部内容：分组清单 + 最近学会的 + 用不了的 + 权重归位。
   *
   * 为什么把权重也塞进来：用户问「他会什么」，看到的应该是
   * 「上网搜一下 · 学会 8 次成 7 次 · 更常用」这一行；
   * 而不是左边一页技能清单、右边一页 `http_get: 1.34` 的裸权重表。
   */
  skills() {
    const impl = this.toolImpl()
    const view = this.skillBook.view({ config: this.config, at: this.now(), impl })
    const weights = bindWeights(this.evolver.current()?.toolWeight || {}, this.skillBook.list())
    return {
      ...view,
      // 用已经算好的 view，不再让 line() 内部重算一遍
      line: lineOf(view),
      weights: weights.rows,
      // 对不上任何技能的权重：说明有个能力在跑却没登记。不静默丢，让面板能报出来
      orphanWeights: weights.orphans,
      // 出厂清单要用的工具里，还有多少没接上（装配进度一眼看得见）
      unwired: allToolNames().filter((name) => !impl.has(name)),
    }
  }

  /**
   * 当前「真的能调」的工具表。
   *
   * 抽成方法而不是每次现读全局，是为了让测试能造出「什么都没接」的世界：
   * 技能页必须在这种情况下说「什么都还不会」，而不是照抄清单。
   */
  /**
   * 当前被关掉、不该再给模型用的工具名。
   * 技能开关的执行侧闸门：面板关掉一项，模型那边就真的调不到。
   */
  blockedTools() {
    try {
      return blockedToolNames({
        config: this.config,
        states: this.skillBook?.states || {},
        impl: this.toolImpl(),
        skills: this.skillBook?.list() || [],
      })
    } catch {
      // 判定失败就当成「一个都没关」：宁可多给能力，不能让整轮对话因为一张开关表挂掉
      return new Set()
    }
  }

  toolImpl() {
    return this.impl
  }

  /**
   * 接上执行器时调一次。通道、生成、沙箱执行器写完后各自注册自己那几个。
   * 注册完，面板和「你会什么」会立刻跟着变 —— 不需要再改判定逻辑。
   */
  registerTools(names = []) {
    // 判断「新不新」看的是**这个运行时自己的表**，不是全局表。
    // 原因：全局表可能早就被别的实例填过（同一个进程里起两个运行时、或测试里预先注册），
    // 但这一份实例是在那之后才构造的，对它来说这些工具就是刚接上的。
    // 装配处关心的是「这次启动接了什么」，所以返回值以实例为准。
    const added = []
    for (const raw of names) {
      const name = String(raw || '').trim()
      if (!name) continue
      registerToolNames([name]) // 同时登记到全局，将来新起的实例能直接继承
      if (this.impl.has(name)) continue
      this.impl.add(name)
      added.push(name)
    }
    // 只在真的多出来东西时留痕，避免每次启动刷一行
    if (added.length) this.log('tools_wired', { added })
    return added
  }

  /**
   * 「你会什么」的直接回答 —— 不用开面板，问一句就能收到。
   * 返回的是几行短句，通道拿它能直接发。
   */
  skillBriefing() {
    return brief(this.skillBook.view({ config: this.config, at: this.now(), impl: this.toolImpl() }))
  }

  /** 开 / 关一个技能。高危项要 confirm，与配置里的危险项同一套规矩 */
  setSkill(id, state, meta = {}) {
    const result = this.skillBook.setState(id, state, meta)
    if (!result.ok) {
      this.log('skill_reject', { id, state, error: result.error })
      return result
    }
    this.saveSkills()
    this.log('skill_state', { id, state: result.state, name: result.skill.name, actor: String(meta.actor || 'panel') })
    return { ...result, message: `${result.skill.name}${result.state === SKILL_STATE.ON ? '打开了' : '关掉了'}` }
  }

  /** 教一个新技能。教完是关着的，要用户点开才生效 */
  teachSkill(input = {}) {
    // 上限只在技能簿里判一次。之前 runtime 与 SkillBook 各判一次，
    // 两边都读同一份配置还好，一旦一个读配置一个读常量，面板改成 200 也会被 60 卡住。
    const result = this.skillBook.teach(input)
    if (!result.ok) {
      // 被拒也要留痕：名字被编码坏成问号时，这是唯一能事后发现「又坏了一次」的线索。
      // 只记长度和是否像乱码，不记原文 —— 反正原文已经是问号了，记了也没用。
      this.log('skill_teach_reject', {
        name: String(input.name || ''),
        chars: String(input.name || '').length,
        broken: /^[?\uFFFD？]+$/.test(String(input.name || '').trim()),
        error: result.error,
      })
      return result
    }
    this.saveSkills()
    this.log('skill_teach', { id: result.id, name: String(input.name || ''), duplicate: !!result.duplicate })
    return {
      ...result,
      message: result.duplicate
        ? '这个已经教过了，没重复记'
        : `学会了「${input.name}」。现在是关着的，想用点一下打开`,
    }
  }

  /** 忘掉一个教过的。出厂技能只能关，不能忘 */
  forgetSkill(id) {
    const result = this.skillBook.forget(id)
    if (!result.ok) return result
    this.saveSkills()
    this.log('skill_forget', { id, name: result.removed?.name })
    return { ...result, message: `忘掉了「${result.removed?.name || id}」` }
  }

  /**
   * 改一条教过的技能（名字/说明/分组/步骤）。
   *
   * 和「忘掉重教」的区别：id 不变，所以开关状态、用过几次、成功率都留着。
   * 名字打错、粘进去乱码时，这是唯一不丢履历的修法。
   */
  amendSkill(id, patch = {}, meta = {}) {
    const result = this.skillBook.amend(id, patch)
    if (!result.ok) {
      this.log('skill_amend_reject', { id, error: result.error })
      return result
    }
    if (!result.changed) return { ...result, message: '没改动' }
    this.saveSkills()
    this.log('skill_amend', {
      id,
      from: result.before?.name,
      to: result.skill?.name,
      actor: String(meta.actor || 'panel'),
    })
    return { ...result, message: `改好了，现在叫「${result.skill?.name || id}」` }
  }

  isActive(conversation) {
    return (this.activeUntil?.get(String(conversation || '')) || 0) > this.now()
  }

  canFollowUp(conversation) {
    const max = Math.max(1, Number(this.config.group?.followUpMaxTurns) || 5)
    return (this.activeTurns?.get(String(conversation || '')) || 0) < max
  }

  markActive(conversation, windowMs, reset = false) {
    if (!this.activeUntil) this.activeUntil = new Map()
    if (!this.activeTurns) this.activeTurns = new Map()
    const key = String(conversation || '')
    if (reset) this.activeTurns.set(key, 0)
    else this.activeTurns.set(key, (this.activeTurns.get(key) || 0) + 1)
    const seconds = Math.max(10, Number(this.config.group?.followUpSeconds) || 180)
    this.activeUntil.set(key, this.now() + Math.max(10_000, Number(windowMs) || seconds * 1000))
  }

  /** 当天简报：从事件流直接算，不花模型 token */
  dailyDigest() {
    try {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const rows = this.events.read({ limit: 1000 }).rows.filter((row) => Number(row.at) >= start.getTime() && row.kind === 'message')
      const groups = new Map()
      let privateCount = 0
      for (const row of rows) {
        if (row.scope === 'group') {
          const key = row.group || row.conversation
          groups.set(key, (groups.get(key) || 0) + 1)
        } else privateCount += 1
      }
      const lines = [`今天收到 ${rows.length} 条消息：群聊 ${rows.length - privateCount} 条，私聊 ${privateCount} 条。`]
      const top = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      if (top.length) lines.push('最活跃的群：' + top.map(([id, count]) => `${id}（${count} 条）`).join('、'))
      const recent = rows.slice(-6).map((row) => `${row.sender || row.from || '某人'}：${String(row.text || '').slice(0, 60)}`).filter(Boolean)
      if (recent.length) lines.push('最近几句：', ...recent.map((line) => '- ' + line))
      return lines.join('\n')
    } catch {
      return '今天还没有可统计的消息。'
    }
  }

  /** 记一次自主活动，只留它自己看得懂的短句 */
  logActivity(record = {}) {
    try {
      this.activities.append({
        at: Number(record.at) || this.now(),
        kind: String(record.kind || 'wonder'),
        text: String(record.text || '').slice(0, 500),
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  /** 记一次思维链。只存可读摘要与工具步骤，不存密钥 */
  noteThought(record = {}) {
    if (!this.liveCot) this.liveCot = new Map()
    const key = String(record.conversation || 'live')
    this.liveCot.set(key, {
      at: Number(record.at) || this.now(),
      conversation: key,
      text: String(record.text || '').slice(0, 8000),
      summary: '正在想…',
      live: true,
    })
  }

  liveCotRows() {
    return this.liveCot ? [...this.liveCot.values()] : []
  }

  logCot(record = {}) {
    if (this.liveCot) this.liveCot.delete(String(record.conversation || 'live'))
    try {
      this.cot.append({
        at: Number(record.at) || this.now(),
        conversation: String(record.conversation || ''),
        from: String(record.from || ''),
        kind: String(record.kind || 'reply'),
        text: String(record.text || '').slice(0, 8000),
        summary: String(record.summary || '').slice(0, 200),
        steps: Array.isArray(record.steps) ? record.steps.slice(0, 30) : [],
        // 来源跟 tokens 一起落盘：只有数字没有来源，面板上仍然是「花了但不知道花在哪」
        source: String(record.source || ''),
        tokens: record.tokens && typeof record.tokens === 'object' ? { input: Number(record.tokens.input) || 0, output: Number(record.tokens.output) || 0 } : null,
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  /**
   * 记一次技能使用结果。「学会了没有」的唯一证据来源。
   *
   * 落盘策略（这是刻意的取舍）：
   *   · 次数与成败 → 技能簿（每次更新）
   *   · 审计 → **只在状态变化时写**（首次成功 / 失败 / 自动关闭）
   * 全写的话，一个爱查资料的他/她一天能把审计刷掉几千行，
   * 真正要看的那几条就被埋了。
   */
  recordSkill(id, ok, detail = {}) {
    const result = this.skillBook.record(id, ok)
    if (!result.ok) return result
    const isFirstSuccess = ok && result.mastery?.level === 'trying' && (this.skillBook.stats[id]?.ok || 0) === 1
    if (!ok || isFirstSuccess || result.autoOff) {
      this.log('skill_use', {
        id,
        ok: !!ok,
        mastery: result.mastery?.level,
        autoOff: result.autoOff,
        ...detail,
      })
    }
    this.saveSkills()
    return result
  }

  /**
   * 面板能直接渲染的只读状态。
   *
   * 契约：**返回的键集合必须与 panel.mjs 里登记的只读项完全一致**（有用例对账）。
   * 多一个 = 面板上看不见的暗数；少一个 = 面板上永远显示「—」的假开关。
   * 算不出来的就给 null，让面板说「—」，绝不用 0 冒充「一次都没有」。
   */
  status() {
    const at = this.now()
    const since = startOfDay(at)
    // 计数必须走 count()：read 有 500 条上限，用它数「今日收发」会在大群静默少算。
    // 并且只数消息与图片 —— 心跳、通知、定时器也都在事件流里，
    // 全算进去会让「今天聊了 300 句」变成一句假话。
    const todayMessages = this.events.count((row) => {
      if (Number(row.at || row.ts) < since) return false
      const kind = String(row.type || row.kind || '')
      return kind === KIND.MESSAGE || kind === KIND.IMAGE
    })
    const auditStats = this.audit.stats()
    const cotStats = this.cot.stats()
    const behaviorStats = this.behaviors.stats()
    const evolve = this.evolver.summary(at)
    const skillCounts = this.skillBook.view({ config: this.config, at, impl: this.toolImpl() }).counts
    // 沙箱状态由执行器自己报。没接执行器就给 null —— 面板显示「—」，
    // 绝不用 0 冒充「今天一次都没跑」。
    const sandbox = this.sandbox && typeof this.sandbox.status === 'function' ? this.sandbox.status() : null
    const fuseLeft = sandbox?.fuseLeftMs || 0
    const fuseText = !sandbox
      ? null
      : fuseLeft >= 3_600_000
        ? `已熔断（还有 ${Math.ceil(fuseLeft / 3_600_000)} 小时）`
        : fuseLeft
          ? `已熔断（还有 ${Math.max(1, Math.ceil(fuseLeft / 60_000))} 分钟）`
          : '正常'

    // 记忆与表情：读不到就当「没有」，不能因此让整个状态面板算崩
    let memoryStats = { facts: 0, people: 0 }
    try {
      if (this.memory && typeof this.memory.stats === 'function') memoryStats = this.memory.stats()
    } catch {}
    let stickerCount = null
    try {
      stickerCount = loadStickers(this.dir).length
    } catch {}
    let activityToday = null
    try {
      activityToday = this.activities.count()
    } catch {}

    // 花费由 Usage 报（它和运行时是两件东西，index.js 装配时接上）。
    // 没接上就全是 null —— 面板显示「—」，而不是假装今天花了 0 元。
    let spent = null
    try {
      if (this.usage && typeof this.usage.today === 'function') spent = this.usage.today(at)
    } catch {}
    const tokens = spent ? (Number(spent.input) || 0) + (Number(spent.output) || 0) : null
    // 累计总用量走 usage.total()：它是不随按天裁剪走的另一本账。
    // 没接用量时给 null，面板显示「—」，不拿今天的数冒充历史总和。
    let lifetime = null
    try {
      if (this.usage && typeof this.usage.total === 'function') lifetime = this.usage.total(at)
    } catch {}
    const totalTokens = lifetime ? Number(lifetime.tokens) || 0 : null

    return {
      'status.version': packageVersion(),
      'status.channel': this.config.channel?.enabled ? this.channelState : CHANNEL_STATE.OFF,
      'status.uptime': at - this.startedAt,
      'status.todayMessages': todayMessages,
      'status.todayTokens': tokens,
      'status.totalTokens': totalTokens,
      'status.todayCost': spent ? Number(spent.cost) || 0 : null,
      'status.budget': spent && Number(spent.budget) > 0 ? Number(spent.budget) : null,
      'status.balance': spent && Number(spent.budget) > 0 ? Number(spent.left) || 0 : null,
      'status.memoryCount': Number(memoryStats.facts) || 0,
      'status.people': Number(memoryStats.people) || 0,
      'status.stickers': stickerCount,
      'status.activityToday': activityToday,
      'status.sandboxToday': sandbox ? sandbox.today : null,
      'status.sandboxFuse': fuseText,
      'status.auditCount': auditStats.count,
      'status.auditSpan': auditStats.oldest ? at - auditStats.oldest : null,
      'status.cotCount': cotStats.count,
      'status.behaviorCount': behaviorStats.count,
      'status.evolveVersion': evolve.version,
      'status.evolveCount': evolve.changes,
      // 面板上「改了没反应」的那些项，数量要能被看见
      'status.pendingConfig': PENDING_KEYS.length,
      'status.skillOn': skillCounts.on,
      'status.skillLearned': skillCounts.learned,
      'status.skillBlocked': skillCounts.blocked,
      // 用不了的里面有多少是「等更新」而不是「等你去开权限」——这两个数字要分开看
      'status.skillNotWired': skillCounts.notWired,
    }
  }

  /**
   * 进程退出 / 插件卸载前：审计写一条，然后把记录文件的句柄放掉。
   *
   * 为什么要关句柄：五份记录现在共用一个常驻写句柄（见 journal.mjs），
   * 换来的是每次落盘少两次系统调用。代价是**必须有人负责放掉它** ——
   * 宿主热重载插件时，旧实例的句柄如果一直开着，那份文件就一直被占着：
   * 用户想备份、想搬数据目录、想删掉重来，都会撞上「另一个程序正在使用」。
   * 之前没有句柄，所以这里不关也没事；现在不关就是漏。
   */
  close() {
    this.log('shutdown', { uptime: this.now() - this.startedAt })
    for (const journal of [this.events, this.behaviors, this.audit, this.cot]) {
      try { journal?.close?.() } catch {}
    }
    try { this.sandbox?.close?.() } catch {}
  }
}

export { RISK }
