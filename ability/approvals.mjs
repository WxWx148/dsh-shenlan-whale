/**
 * ability/approvals.mjs — 「要动手之前先问一句」这件事的全部机制：挂起、等人、超时、记住。
 *
 * 为什么单独成文件：沙箱的 `ask` 档从 0.34 起就一直写着「这个版本还没有确认界面」，
 * 于是那个档位实际等于不跑 —— 配置里明明有三个选项，有一个是空的。
 * 把「问」的动作做成一个可以独立测试的对象，才谈得上真的支持它。
 *
 * 四条硬规矩：
 *   1. **超时默认拒绝**。没人应答时「什么都不做」永远比「照做」安全；
 *      默认允许的弹窗，只要用户走开一次就会变成一次静默的授权。
 *   2. **只有一次机会**。同一个请求只能被决定一次；决定之后再点就是「已经结束了」，
 *      不覆盖前一次结论（否则日志里会出现两条互相矛盾的记录）。
 *   3. **每步都落盘**。发问、同意、拒绝、超时、记住、忘记 —— 六种事都写进
 *      `approvals.jsonl`，同时进审计。事后要能回答「当时谁点的、为什么」。
 *   4. **记住的是结论，不是请求**。记住之后同类请求直接按上次结论走，
 *      但日志里仍然每次记一条 `remembered` —— 「因为记住所以放行」也是放行，
 *      不能因为它没弹窗就当没发生。
 *
 * 关于超时的一点细节：界面上数的秒数和真正判超时不是同一刻。
 * 客户端倒计时走到 0 时会带着用户填的理由提交一次；服务端再多等 2 秒才收口。
 * 这 2 秒是留给那次提交在路上的时间 —— 否则理由永远写不进日志，
 * 用户填了也白填。没有客户端（面板没开）时，多等的这 2 秒无人在意。
 */

import path from 'node:path'
import { createHash } from 'node:crypto'
import { readJson, writeJson } from '../base/core.mjs'
import { Journal } from '../base/journal.mjs'

/** 默认让人想多久。配置项 `sandbox.confirmSeconds` 会覆盖它 */
const DEFAULT_TIMEOUT_MS = 60_000
/** 客户端已经超时提交、服务端再等一会儿的宽限。见文件头 */
const GRACE_MS = 2_000
/** 同时挂起的上限。堆太多会让面板变成一堵墙，也容易把过期的旧请求点错 */
const MAX_PENDING = 6
/** 理由的长度上限：一句话就够，太长的理由没人回头看 */
const MAX_REASON = 140

function cleanReason(value) {
  // 换行会让日志一行变两行，游标翻页会错位 —— 一律压成空格
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON)
}

/** 代码指纹：日志里记 hash 而不是全文，几十 KB 的代码不该把账本撑爆 */
function hashOf(text) {
  return createHash('sha1').update(String(text || ''), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 通过渠道（QQ 私聊等）问人时的那条消息。
 *
 * 必须有「项目」和「目的」两行：只写「要跑一段代码」的消息，收到的人无从判断，
 * 只能盲选；盲选的同意不叫授权，叫盖章。
 */
export function approvalText(snapshot = {}) {
  const project = String(snapshot.project || '深蓝鲸')
  const purpose = String(snapshot.purpose || '跑一段代码')
  const seconds = Math.max(1, Number(snapshot.timeoutSeconds) || 60)
  const lines = String(snapshot.preview || '').split('\n')
  const shown = lines.slice(0, 12).join('\n')
  const more = snapshot.truncated === true || lines.length > 12
  const plan = Array.isArray(snapshot.plan) && snapshot.plan.length ? `\n步骤：${snapshot.plan.join(' → ')}` : ''
  const multi = Number(snapshot.waiting) > 1 ? `\n现在共 ${snapshot.waiting} 条在等，本条编号 ${snapshot.ref}；回复时请带上编号。` : ''
  const action = snapshot.kind === 'code_write' ? '想改一处代码'
    : snapshot.kind === 'code_restore' ? '想还原一处代码'
      : snapshot.kind === 'run_command' ? '想跑一条命令'
        : '想跑一段代码'
  return [
    `【${project}】${action}，等你点头`,
    '',
    `项目：${project}`,
    `目的：${purpose}${plan}`,
    `大小：${Math.max(0, Number(snapshot.bytes) || 0)} 字节${multi}`,
    '',
    '代码：',
    shown + (more ? '\n…（后面还有，完整内容在面板）' : ''),
    '',
    `${seconds} 秒内不回按拒绝处理。回复「同意」执行，或者「拒绝 理由」不执行。`,
  ].join('\n')
}

export class ApprovalDesk {
  /**
   * @param {object} input
   * @param {string} input.dir                  落盘目录（沙箱根目录）
   * @param {() => number} [input.now]
   * @param {(kind:string, detail:object) => void} [input.log] 进审计用
   * @param {number} [input.timeoutMs]          默认等多久
   * @param {object} [input.journal]             测试可注入
   */
  constructor(input = {}) {
    this.dir = String(input.dir || '.')
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()
    this.log = typeof input.log === 'function' ? input.log : () => {}
    /**
     * 除了面板，还能走别的路问人（QQ 私聊）。
     *
     * 为什么放在这一层：谁来问是渠道的事，但「问什么、还有几条在等、谁先谁后」
     * 只有账本知道。把通知做成一个回调，渠道只管发，不碰状态。
     */
    this.notify = typeof input.notify === 'function' ? input.notify : null
    /** 这段代码属于哪个项目。面板和渠道上都要用中文写清楚 */
    this.project = String(input.project || '深蓝鲸')
    // 上限只挡住「配成 0」这种明显错误；下限留得很低是为了用例能几毫秒内跑完超时，
    // 真正给用户的秒数由 sandbox.confirmSeconds 管（10~300 秒）
    this.timeoutMs = Math.max(10, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS)
    this.graceMs = Math.max(0, Number(input.graceMs ?? GRACE_MS) || 0)
    this.maxPending = Math.max(1, Number(input.maxPending) || MAX_PENDING)
    // 计时器默认不拦着进程退出：一个挂在「等人点」上的请求不该让整个会话关不掉。
    // 用例里要等它真触发，所以允许关掉（unref: false）。
    this.unref = input.unref !== false
    this.journal = input.journal || new Journal({ dir: this.dir, name: 'approvals', now: this.now })
    this.stateFile = path.join(this.dir, 'approvals.json')

    /** id → { id, code, preview, hash, bytes, plan, label, at, expiresAt, timer, resolve } */
    this.pending = new Map()
    this.seq = 0
    const saved = readJson(this.stateFile, null)
    const value = saved.ok && saved.value && typeof saved.value === 'object' ? saved.value : {}
    this.state = {
      // 记住的结论。null 表示没记住过 —— 不要把「没记住」写成 {allow:false}，
      // 那会让「没决定过」和「记住了拒绝」变成同一个样子。
      remember: value.remember && typeof value.remember === 'object' && typeof value.remember.allow === 'boolean'
        ? { allow: value.remember.allow, reason: cleanReason(value.remember.reason), at: Number(value.remember.at) || 0 }
        : null,
    }
  }

  /** 面板改完「等多久」要立刻生效，不能等重启 */
  configure(input = {}) {
    const timeoutMs = Number(input.timeoutMs)
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) this.timeoutMs = Math.max(5_000, Math.round(timeoutMs))
  }

  /** 记住的结论（没有就 null） */
  remember() {
    return this.state.remember ? { ...this.state.remember } : null
  }

  /** 清掉记住的结论。返回之前是什么，方便回一句话 */
  forget() {
    const before = this.remember()
    if (!before) return { ok: true, cleared: false }
    this.state.remember = null
    this.#save()
    this.journal.append({ kind: 'approval', at: this.now(), decision: 'forget', allow: null })
    this.log('sandbox_approval_forget', { allow: before.allow, reason: before.reason })
    return { ok: true, cleared: true, before }
  }

  /**
   * 发问并等一个结论。
   *
   * 返回的 Promise **一定会 resolve**：超时、队列满了、没界面，各有各的结论，
   * 但绝不会有「永远等下去」这条路 —— 调用方是模型的一轮对话，挂死比拒绝糟得多。
   *
   * @returns {Promise<{ok:boolean, allowed:boolean, id:string, reason:string, remembered:boolean, timedOut:boolean}>}
   */
  request(input = {}) {
    const at = this.now()
    const code = String(input.code || '')
    const bytes = Buffer.byteLength(code, 'utf8')
    const hash = hashOf(code)
    const plan = Array.isArray(input.plan) ? input.plan.map((one) => String(one).slice(0, 80)) : []
    const label = String(input.label || '').slice(0, 120)
    // 项目名与目的必须是人话：渠道上那条消息一旦只写「要跑代码」，
    // 收到的人没法判断该不该同意 —— 问了个寂寞。
    const project = String(input.project || this.project || '深蓝鲸').slice(0, 40)
    const purpose = String(input.purpose || label || plan[0] || '跑一段代码').slice(0, 100)

    // ① 记住过就直接按结论走。仍然记一条 —— 放行也是决定，不能因为它没弹窗就没记录。
    const remembered = this.state.remember
    if (remembered) {
      this.journal.append({
        kind: 'approval',
        at,
        decision: 'remembered',
        allow: remembered.allow,
        reason: remembered.reason,
        hash,
        bytes,
        label,
      })
      this.log('sandbox_approval_remembered', { allow: remembered.allow, hash, bytes })
      return Promise.resolve({
        ok: true,
        allowed: remembered.allow,
        id: '',
        reason: remembered.reason,
        remembered: true,
        timedOut: false,
      })
    }

    // ② 堆太多就当场拒。不排队：排在后面的请求等到超时，用户看到一串「已过期」更困惑
    if (this.pending.size >= this.maxPending) {
      const message = '待确认的请求堆太多了，这一条不再排队。等面板里的处理完再试。'
      this.journal.append({ kind: 'approval', at, decision: 'overflow', allow: false, reason: message, hash, bytes, label })
      this.log('sandbox_approval_overflow', { pending: this.pending.size })
      return Promise.resolve({ ok: false, allowed: false, id: '', reason: message, remembered: false, timedOut: false })
    }

    this.seq = (this.seq + 1) % 1_000_000
    const id = `a${String(at).padStart(13, '0')}-${this.seq.toString(36)}`
    const expiresAt = at + this.timeoutMs

    return new Promise((resolve) => {
      const record = {
        id,
        kind: String(input.kind || 'sandbox'),
        code,
        // 面板只显示前 1600 字：再长的代码在弹出的框里也读不完，读不完的确认等于没确认
        preview: code.slice(0, 1600),
        truncated: code.length > 1600,
        hash,
        bytes,
        plan,
        label,
        project,
        purpose,
        // 请求来自哪个会话：群聊里主人回「同意」时，只认这一条，
        // 不能把别处挂着的代码请求一起放行。
        origin: String(input.origin || ''),
        at,
        expiresAt,
        timer: null,
        resolve,
      }
      // 服务端收口比界面倒计时晚 graceMs：给「倒计时到 0 时带着理由提交」留出在路上的时间
      record.timer = setTimeout(() => {
        this.#settle(id, {
          allowed: false,
          reason: `超时未确认（等了 ${Math.round(this.timeoutMs / 1000)} 秒，按拒绝处理）`,
          timedOut: true,
          remembered: false,
        })
      }, this.timeoutMs + this.graceMs)
      if (this.unref) record.timer.unref?.()
      this.pending.set(id, record)
      this.journal.append({ kind: 'approval', at, decision: 'asked', id, hash, bytes, label, project, purpose, plan: plan.length })
      this.log('sandbox_ask', { id, hash, bytes, timeoutMs: this.timeoutMs })
      // ③ 顺手问一句人。不 await：渠道发不出去不能挡住面板上的那一份；
      // 但发失败要让渠道自己记日志，这里只兜住异常，不让它把 run() 拖崩。
      if (this.notify) {
        try {
          const sent = this.notify(this.#snapshot(record))
          if (sent && typeof sent.catch === 'function') sent.catch(() => {})
        } catch {}
      }
    })
  }

  /** 给渠道的那一份：不带 resolve / timer / 全文，只带能让人做决定的信息 */
  #snapshot(record) {
    return {
      id: record.id,
      ref: record.id.slice(-4).toUpperCase(),
      kind: record.kind,
      project: record.project,
      purpose: record.purpose,
      plan: [...record.plan],
      preview: record.preview,
      truncated: record.truncated,
      bytes: record.bytes,
      expiresAt: record.expiresAt,
      timeoutSeconds: Math.round(this.timeoutMs / 1000),
      waiting: this.pending.size,
    }
  }

  /**
   * 把一句回话翻译成一次决定。不是决定语句就返回 null，交给正常聊天。
   *
   * 只认「同意 / 批准 / 拒绝 / 不同意」开头这几种。「行」「可以」不算 ——
   * 那几个词在闲聊里太常见，一旦吃掉一条正常消息，用户只会觉得「它突然听不懂话了」。
   */
  takeReply(text, options = {}) {
    const raw = String(text || '').trim()
    if (!raw) return null
    const allow = /^(同意|批准)(?:\s|$|[,，。:：])/u.test(raw)
    const deny = /^(拒绝|不同意)(?:\s|$|[,，。:：])/u.test(raw)
    if (!allow && !deny) return null
    // 没有等待项时不拦：主人说「同意」很可能是在同意别的事（比如它刚提的方案）。
    // 把这句话吞下来回一句「没有等你确认的事」，只会让对话突然断掉。
    if (!this.pending.size) return null
    const tail = raw.replace(/^(同意|批准|拒绝|不同意)/u, '').trim()
    const reason = deny ? tail.slice(0, MAX_REASON) : ''
    const origin = String(options.origin || '')
    let list = [...this.pending.values()].sort((a, b) => a.at - b.at)
    if (origin) {
      list = list.filter((one) => !one.origin || one.origin === origin)
      // 这个群没有等待项：不要吃掉「同意」，让它走正常聊天。
      if (!list.length) return null
    }
    let target = null
    if (list.length === 1) target = list[0]
    // 多条在等时，必须带编号（取 id 末四位），否则不知道该点哪一条。
    // 猜一个是最坏的：猜错就是把另一段代码放行了。
    if (list.length > 1) {
      const hit = list.filter((one) => raw.toUpperCase().includes(one.id.slice(-4).toUpperCase()))
      if (hit.length === 1) target = hit[0]
    }
    if (!target) {
      const codes = list.map((one) => `${one.id.slice(-4).toUpperCase()}（${one.purpose}）`).join('、')
      return { handled: true, ok: false, message: `现在有 ${list.length} 条在等，请带上编号：同意 ${codes}。` }
    }
    const verdict = this.decide(target.id, { allow, reason })
    return {
      handled: true,
      ok: verdict.ok === true,
      allowed: allow,
      reason,
      purpose: target.purpose,
      message: verdict.ok
        ? allow
          ? `好，同意了，现在去跑：${target.purpose}`
          : `好，这次不跑：${target.purpose}${reason ? `（${reason}）` : ''}`
        : String(verdict.error || '这条已经结束了'),
    }
  }

  /** 面板要画的：还有哪些在等、各剩多久 */
  list() {
    const at = this.now()
    return [...this.pending.values()]
      .sort((a, b) => a.at - b.at)
      .map((record) => ({
        id: record.id,
        // 渠道上用这四位当编号：一屏里够短，能口述，也不会撞。
        // 名字必须和下面的 `code`（源码正文）分开 —— 同名会让其中一个被覆盖，
        // 表现是「回复了编号也不认」，还查不出为什么。
        ref: record.id.slice(-4).toUpperCase(),
        kind: record.kind,
        label: record.label,
        project: record.project,
        purpose: record.purpose,
        at: record.at,
        expiresAt: record.expiresAt,
        leftMs: Math.max(0, record.expiresAt - at),
        totalMs: this.timeoutMs,
        code: record.preview,
        truncated: record.truncated,
        hash: record.hash,
        bytes: record.bytes,
        plan: record.plan,
      }))
  }

  /**
   * 给一个结论。只有第一次算数。
   *
   * @param {string} id
   * @param {{allow?: boolean, remember?: boolean, reason?: string}} input
   */
  decide(id, input = {}) {
    const key = String(id || '')
    const record = this.pending.get(key)
    if (!record) {
      return { ok: false, error: '这个确认已经结束了（可能已超时，或面板点过两次）' }
    }
    const allow = input.allow === true
    const remember = input.remember === true
    const reason = cleanReason(input.reason)

    if (remember) {
      this.state.remember = { allow, reason, at: this.now() }
      this.#save()
    }
    const verdict = this.#settle(key, { allowed: allow, reason, timedOut: false, remembered: false })
    return { ok: true, ...verdict, remembered: remember }
  }

  /** 最近的决定，给面板「留档」那一页用 */
  recent(limit = 40) {
    const page = this.journal.read({ limit: Math.max(1, Math.min(200, Number(limit) || 40)), filter: (row) => row?.kind === 'approval' })
    return page.rows
  }

  stats() {
    // 四个计数**一趟走完**。以前是四次 journal.count(…)，每次把整份记录从头扫一遍：
    // 2 万条记录时这一项要 4ms，而面板每 2.5 秒就刷新一次 —— 这 4ms 是同步阻塞的，
    // 期间同一个事件循环上的收消息、发消息全停着。数得准，但不能数得慢。
    const tally = { asked: 0, allowed: 0, denied: 0, timedOut: 0, remembered: 0 }
    this.journal.forEach((row) => {
      if (!row || row.kind !== 'approval') return
      if (row.decision === 'asked') tally.asked += 1
      else if (row.decision === 'allow') tally.allowed += 1
      else if (row.decision === 'deny') tally.denied += 1
      else if (row.decision === 'timeout') tally.timedOut += 1
      else if (row.decision === 'remembered') tally.remembered += 1
      return
    })
    return {
      pending: this.pending.size,
      timeoutSeconds: Math.round(this.timeoutMs / 1000),
      remember: this.remember(),
      asked: tally.asked,
      allowed: tally.allowed,
      denied: tally.denied,
      timedOut: tally.timedOut,
      // 「因为记住了所以直接放行」也是放行，但必须能单独数出来 ——
      // 否则用户会觉得「没人问过我，它怎么就跑了」
      remembered: tally.remembered,
    }
  }

  /** 放掉确认记录的写句柄。插件卸载前调（见 journal.mjs 里常驻句柄的说明） */
  close() {
    try { this.journal?.close?.() } catch {}
  }

  // ── 内部 ──────────────────────────────────────────────────────

  #settle(id, verdict) {
    const record = this.pending.get(id)
    if (!record) return { allowed: false, id, reason: '', remembered: false, timedOut: false }
    clearTimeout(record.timer)
    this.pending.delete(id)
    const decision = verdict.allowed ? 'allow' : verdict.timedOut ? 'timeout' : 'deny'
    this.journal.append({
      kind: 'approval',
      at: this.now(),
      id,
      decision,
      allow: verdict.allowed,
      reason: verdict.reason,
      hash: record.hash,
      bytes: record.bytes,
      label: record.label,
    })
    this.log(decision === 'allow' ? 'sandbox_approve' : 'sandbox_reject', {
      id,
      reason: verdict.reason,
      timedOut: verdict.timedOut === true,
      hash: record.hash,
    })
    record.resolve({
      ok: true,
      allowed: verdict.allowed,
      id,
      reason: verdict.reason,
      remembered: false,
      timedOut: verdict.timedOut === true,
    })
    return { allowed: verdict.allowed, id, reason: verdict.reason, remembered: false, timedOut: verdict.timedOut === true }
  }

  #save() {
    writeJson(this.stateFile, { remember: this.state.remember, at: this.now() })
  }
}
