/**
 * app/chat.mjs — 不依赖 QQ 的独立对话。
 *
 * 为什么必须有这一块：
 *   QQ 那条链要协议端、要在线、要扫码。任何一环没通，人就**一句话都跟它说不上**。
 *   而「试试它说话什么味儿」是最基础的需求，不该被外部依赖卡住。
 *
 * 它和 QQ 那条链共用同一套人格与风格：同一个 persona、同一份 styleOptions、
 * 同一份进化权重、同一个账本。差别只有一个 —— 回复留在页面上，不往外发。
 *
 * 所以这里**不重写**任何说话逻辑：prompt 用 turn.buildPrompt，分条用 turn.splitReply。
 * 重写一份「差不多」的，两边迟早会说出两种话。
 */

import { openJournal } from '../base/core.mjs'
import { buildPrompt, parseToolCall, parseToolCalls, splitReply, stripToolMarks } from '../turn/index.mjs'
import { splitUsage } from '../facts/index.mjs'
import { usageSourceOfTool } from '../ability/index.mjs'

/** 独立对话挂在一个固定的会话 id 上：宿主的 agent 池按会话分，这样才能连续聊 */
const CONVERSATION = 'panel:local-chat'

/** 存进日志的一行，取出来时统一成前端好用的形状 */
function rowOf(row) {
  return {
    id: String(row?.id || ''),
    at: Number(row?.at || 0),
    from: row?.from === 'self' ? 'self' : 'me',
    text: String(row?.text || ''),
    parts: Array.isArray(row?.parts) ? row.parts.map(String) : [],
    tone: String(row?.tone || ''),
  }
}

export class Chat {
  /**
   * @param {object} input
   * @param {string} input.dir
   * @param {object} input.runtime  取人格、风格、记账
   * @param {(prompt:string, meta:object)=>Promise<{text:string, usage?:object}>} [input.runner]
   * @param {object} [input.usage]  计费
   * @param {() => number} [input.now]
   */
  constructor(input = {}) {
    this.dir = String(input.dir || '')
    // 单独一份日志：QQ 的事件流是「外面发生了什么」，这里是「我自己在面板上聊了什么」，
    // 混在一起会让统计和会话列表都变脏。
    this.journal = openJournal(this.dir, 'chat', { now: input.now })
    this.runtime = input.runtime || null
    this.usage = input.usage || null
    this.runner = typeof input.runner === 'function' ? input.runner : null
    // 工具表：有它，模型写的 [tool:…] 才会真的被执行；没有就只聊不执行。
    this.tools = input.tools || null
    this.now = typeof input.now === 'function' ? input.now : () => Date.now()
    this.busy = false
  }

  /** 有生成器才算能用。没有就直说，不假装在等回复 */
  get ready() {
    return typeof this.runner === 'function'
  }

  /**
   * 思维链落盘：对话页的发言同样先想后说。
   * 工具调用前、回复落库前各调一次 —— 顺序别反。
   */
  #logCot(result, kind, summary, steps, extra = {}) {
    if (!result || !this.runtime || typeof this.runtime.logCot !== 'function') return
    const reasoning = String(result.reasoning || '').trim()
    const fallback = String(summary || '').trim()
    const text = reasoning || (kind === 'reply' ? '（这一轮没有单独输出思考过程，直接回复）' : fallback)
    if (!text) return
    const spent = extra.tokens || result.usage
    this.runtime.logCot({
      at: this.now(),
      conversation: CONVERSATION,
      kind,
      text,
      summary: String(summary || result.text || '').slice(0, 160),
      steps: Array.isArray(steps) ? steps : [],
      source: String(extra.source || ''),
      tokens: spent ? { input: Number(spent.input) || 0, output: Number(spent.output) || 0 } : null,
    })
  }

  /** 一次推理记一笔，来源跟着走；0/0 不记（空用量不该算成一次调用） */
  #spend(result, source) {
    const usage = result?.usage
    if (!usage) return
    const input = Math.max(0, Number(usage.input) || 0)
    const output = Math.max(0, Number(usage.output) || 0)
    if (!input && !output) return
    this.usage?.record?.(input, output, {
      at: this.now(),
      model: result?.model || '',
      conversation: CONVERSATION,
      source,
    })
  }

  #spendShare(share, source, result, isFirst = false) {
    const input = Math.max(0, Number(share?.input) || 0)
    const output = Math.max(0, Number(share?.output) || 0)
    if (!input && !output) return
    this.usage?.record?.(input, output, {
      at: this.now(),
      model: result?.model || '',
      conversation: CONVERSATION,
      source,
      calls: isFirst ? 1 : 0,
    })
  }

  /** 这次推理是在读哪批工具的结果；混批归「工具调用」，不硬挑一个 */
  #causeSource(sources = []) {
    const unique = new Set(sources.filter(Boolean))
    if (unique.size === 1) return [...unique][0]
    if (unique.size === 0) return 'chat'
    return 'tool'
  }

  /**
   * 历史消息（新的在后，方便直接往屏幕上铺）。
   * @param {{limit?:number, before?:string}} [options]
   */
  history(options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 60))
    const slice = this.journal.read({ limit, before: options.before })
    return {
      rows: slice.rows.slice().reverse().map(rowOf),
      nextBefore: slice.nextBefore,
      hasMore: slice.hasMore,
    }
  }

  /** 最近几条，给 prompt 当上下文。只要文本，不要元数据 */
  #recent(limit = 6) {
    try {
      return this.journal
        .read({ limit: 20 })
        .rows.slice()
        .reverse()
        .filter((row) => row?.text)
        .slice(-limit)
        .map((row) => ({ from: row.from === 'self' ? 'self' : 'other', text: String(row.text) }))
    } catch {
      return []
    }
  }

  /**
   * 说一句，拿一句回来。
   *
   * 串行：上一条没说完就不接新的。并发会让两段回复交错，
   * 用户看到的顺序和实际说的顺序不一致，比慢更糟。
   *
   * @param {{text:string, who?:string}} input
   */
  async send(input = {}) {
    const body = String(input.text || '').trim().slice(0, 2000)
    if (!body) return { ok: false, error: '说点什么再发' }
    if (!this.ready) return { ok: false, error: '生成能力还没接上：宿主没把模型给我' }
    if (this.busy) return { ok: false, error: '上一条还在说，等它说完' }

    this.busy = true
    const at = this.now()
    // 先取历史，再落当前这句。反过来的话，刚落盘的当前消息会被 #recent 当成
    // 「刚才的对话」再读一次，buildPrompt 末尾又会把本句作为用户输入写一遍 ——
    // 模型看到的同一句话出现两次，其中一次还被标成「我说」。
    const recent = this.#recent()
    this.journal.append({ kind: 'chat', id: `me_${at}`, at, from: 'me', text: body })
    // 面板对话跟 QQ 侧共用同一份长期记忆：显式「记住…」要写进事实本，
    // 并且每次生成都要把记忆摘要塞进 prompt。以前 Chat 既不写也不读 ——
    // 面板上聊半天，记忆页永远只有 QQ 那几条，用户看到的就是「记忆没写」。
    try {
      if (this.runtime?.memory) {
        if (/^记住你自己[，,：:]?/.test(body)) {
          this.runtime.memory.rememberSelf(body.replace(/^记住你自己[，,：:]?\s*/, ''))
        } else if (/^记住[，,：:]?/.test(body)) {
          this.runtime.memory.rememberFact(body.replace(/^记住[，,：:]?\s*/, ''), { source: 'panel' })
        }
      }
    } catch {}

    const started = this.now()
    try {
      const options = this.runtime?.styleOptions?.('private') || { maxParts: 3 }
      let prompt = buildPrompt({
        event: { from: 'me', scope: 'panel', payload: { text: body, senderName: String(input.who || '我') } },
        persona: this.runtime?.config?.persona || {},
        // 灵魂文件：跟 QQ 那条链用同一份。
        // 以前这里只传 config.persona，于是对话页和 QQ 说的不是同一个人 ——
        // QQ 那边改了人设，这边还是旧的。两条链路必须读同一个真源。
        soul: this.runtime?.personaText ? this.runtime.personaText() : '',
        habitLine: this.runtime?.habitLine ? this.runtime.habitLine('private') : '',
        styleGuide: this.runtime?.styleGuide?.('private') || '',
        // 面板对话也要带长期记忆。以前这里没有 memory，模型只能看到最近几条 chat，
        // 记不住事实本里已经写下的人和事，看起来就像「每次多轮都失忆」。
        memory: this.runtime?.memory ? this.runtime.memory.digest({ query: body }) : null,
        recent,
      })
      const meta = { conversation: CONVERSATION, scope: 'panel' }
      let result = await this.runner(prompt, meta)
      let last = null

      // 工具环：模型用「[tool:名字] {…}」请求，执行完把结果喂回去。
      // 没有这一环，模型会把这行当正文发出来 —— 用户看到的就是「[tool:exec_sandbox] …」，
      // 以为工具坏了。QQ 那条链早就有这一环，对话页也必须有。
      // 一轮可以写多行：一件事分几步（先查再记）在这里同样成立。
      // 0 = 不限；与 turn.mjs 共用同一个硬顶，防止模型死循环烧预算。
      const HARD_ROUND_LIMIT = 24
      const configuredRounds = Number(this.runtime?.config?.tools?.maxRounds)
      const maxRounds = configuredRounds > 0
        ? Math.max(1, Math.min(HARD_ROUND_LIMIT, Math.floor(configuredRounds)))
        : HARD_ROUND_LIMIT
      const maxPerRound = Math.max(1, Math.min(8, Number(this.runtime?.config?.tools?.maxPerRound) || 4))
      let lastToolResult = null
      // 和 QQ 那条链同一套账法：一次推理归一次账，来源要分清，
      // 不然「对话页花了多少、工具有多少」永远只有一个合计数。
      let pending = result
      let pendingSources = []
      for (let round = 0; round < maxRounds && this.tools; round += 1) {
        const calls = parseToolCalls(pending?.text).slice(0, maxPerRound)
        if (!calls.length) {
          this.#spend(pending, this.#causeSource(pendingSources))
          pending = null
          break
        }
        const shares = splitUsage(pending?.usage, calls.length)
        const sources = calls.map((call) => usageSourceOfTool(call.name))
        calls.forEach((call, index) => this.#spendShare(shares[index], sources[index], pending, index === 0))
        lastToolResult = pending
        const results = []
        for (const [index, call] of calls.entries()) {
          // 思维链先于工具调用，且把这一步的 token 一起标上
          this.#logCot(pending, 'tool', `调用 ${call.name}`, [`${call.name}：${JSON.stringify(call.args || {}).slice(0, 160)}`], { source: sources[index], tokens: shares[index] })
          const called = await Promise.resolve(this.tools.call(call.name, call.args, { byModel: true }))
            .catch((error) => ({ ok: false, error: String(error?.message || error) }))
          // 对话页也是模型在真调工具，同样要记进技能履历 ——
          // 只在 QQ 那条链上记，「用过几次」会少掉一半（自己试一遍不算数，说不过去）。
          const skillId = this.runtime && typeof this.runtime.skillIdOfTool === 'function' ? this.runtime.skillIdOfTool(call.name) : ''
          if (skillId && typeof this.runtime.recordSkill === 'function') {
            this.runtime.recordSkill(skillId, called?.ok !== false, { behavior: 'chat', tool: call.name })
          }
          results.push({ call, called })
        }
        last = results[results.length - 1].called
        const digest = results
          .map(({ call, called }, index) => `${index + 1}. ${call.name} → ${JSON.stringify(called).slice(0, 1500)}`)
          .join('\n')
        prompt += `\n\n你刚调用了 ${results.length} 个工具，按顺序执行的结果如下：\n${digest}\n请根据结果，用一两句人话回复；不需要再动手就直接说结论。`
        const next = await this.runner(prompt, meta)
        pending = next
        pendingSources = sources
        result = next
      }
      if (pending) {
        this.#spend(pending, this.#causeSource(pendingSources))
        pending = null
      }

      let text = String(result?.text || '').trim()
      // 已经到了轮数上限还在写调用行：把标记去掉。
      // 跑过工具就把最后一次的结果拿出来说，没跑成也要说清，绝不把 "[tool:…]" 甩给用户。
      //
      // 守卫必须留着：**没有工具表时**这一行只是模型的普通文本，不该被裁掉
      // （用例：没有工具表时不假装执行，也不吞掉原话）。
      // 但清理不能只看 `/\[tool:/` —— 模型偶尔写成裸形式 `[名称] {…}`，
      // 旧判断放它过去，工具跑了、标记跟着正文一起发出去了。
      if (this.tools) text = stripToolMarks(text)
      if (!text && last) {
        text = last.ok
          ? String(last.text || '跑完了，没有输出。').slice(0, 600)
          : String(last.error || '没做成').slice(0, 300)
      }
      if (!text) {
        this.journal.append({ kind: 'chat', id: `err_${at}`, at: this.now(), from: 'self', text: '', tone: 'error' })
        return { ok: false, error: '模型没给内容' }
      }

      // 思维链先于回复：回复落库、返回之前落盘；工具轮已经记过就不重复记 reply
      if (result && result !== lastToolResult) this.#logCot(result, 'reply', text, [])

      // 分条和 QQ 上完全一致：这里也该是「几条短句」，不是一段长文
      const parts = splitReply(text, { maxParts: options.maxParts })
      this.journal.append({
        kind: 'chat',
        id: `self_${at}`,
        at: this.now(),
        from: 'self',
        text,
        parts: parts.length ? parts : [text],
      })
      return { ok: true, parts: parts.length ? parts : [text], text, ms: this.now() - started }
    } catch (error) {
      const message = String(error?.message || error)
      this.journal.append({ kind: 'chat', id: `err_${at}`, at: this.now(), from: 'self', text: '', tone: 'error' })
      return { ok: false, error: message }
    } finally {
      this.busy = false
    }
  }

  /** 清空这一屏。日志本身不删（事实留着），只是让界面从干净的地方开始 */
  reset() {
    const at = this.now()
    this.journal.append({ kind: 'chat', id: `reset_${at}`, at, from: 'me', text: '', tone: 'reset' })
    return { ok: true }
  }
}
