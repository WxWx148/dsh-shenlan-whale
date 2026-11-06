/**
 * lib/host.mjs — 深蓝鲸的模型直连（版权：用户）
 * ============================================================================
 * 不再走 agent runner，也不自己管 API Key：
 *   - 使用 DSH 的 ctx.llm 统一模型服务；
 *   - provider/model 优先取面板配置，否则跟随当前对话模型；
 *   - 只取纯文本和 usage，失败返回结构化原因；
 *   - 拿不到 llm 服务时返回 null，插件其余部分照常活着。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import path from 'node:path'

/** 会话 → 稳定的 session id（给模型侧缓存/日志用） */
export function sessionIdOf(conversation) {
  const digest = createHash('sha256').update(`shenlan-whale\0${String(conversation || '')}`).digest('hex')
  return `sl-${digest.slice(0, 12)}`
}

/**
 * 数据目录下的工作区。
 *
 * 这里以前返回 `<dir>/workspace`，而真正的工作区 —— 沙箱创建、挂载并交由脚本读写的
 * 那一个 —— 是 `<dir>/sandbox/workspace`。两个「工作区」指的是不同的地方，
 * 于是这个函数的返回值指向一个**从来没有人 mkdir 过**的目录。
 * 现在两边收敛到同一个位置：改这里就等于改沙箱的工作区，不会再出现第二个。
 *
 * 只在 index.js 建 runner 时传下去（宿主 runner 目前并不读它，留着是给未来接的）。
 */
export function workspaceOf(dir) {
  return path.join(String(dir || '.'), 'sandbox', 'workspace')
}

function serviceOf(ctx, name) {
  try {
    if (ctx && typeof ctx.get === 'function') return ctx.get(name)
  } catch {}
  return ctx ? ctx[name] : null
}

/** 面板配置优先；否则跟随当前对话模型 */
export function resolveModel(ctx, config = {}) {
  if (config.modelProvider && config.model) {
    return { provider: String(config.modelProvider), model: String(config.model) }
  }
  const selector = serviceOf(ctx, 'agentDefaultModel')
  try {
    const selected = selector && typeof selector.currentSelection === 'function' ? selector.currentSelection() : null
    if (selected && selected.provider && selected.model) {
      return { provider: String(selected.provider), model: String(selected.model) }
    }
  } catch {}
  return null
}

/** 兼容不同适配器的文本分片形状 */
function textOfChunk(chunk, allowReasoning = false) {
  if (!chunk || typeof chunk !== 'object') return ''
  // 推理/思考分片不是要发出去的话
  if (!allowReasoning && /reason|think|analysis/i.test(String(chunk.type || ''))) return ''
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.textDelta === 'string') return chunk.textDelta
  if (typeof chunk.delta === 'string') return chunk.delta
  if (chunk.delta && typeof chunk.delta.text === 'string') return chunk.delta.text
  if (chunk.content && typeof chunk.content.text === 'string') return chunk.content.text
  return ''
}

/** 去掉模型误写进正文的括号思考，只留真正要说的话 */
export function cleanReply(value) {
  let text = String(value || '').trim()
  // 连续多行「（……）」属于思考，不是回复
  text = text.replace(/^(?:\s*[（(][^\n（）()]{1,300}[）)]\s*\n?)+/u, '')
  // 最后一行可能写成「（想了想）正文」
  text = text.replace(/^\s*[（(][^（）()\n]{1,300}[）)]\s*/u, '')
  return text.trim()
}

/**
 * 建立一个 runner。拿不到模型服务时返回 null。
 * @param {object} input { ctx, config, log }
 * @returns {Promise<null | ((prompt:string, meta?:object)=>Promise<{text:string,usage:object|null,model:object|null}>)>}
 */
export async function createHostRunner(input = {}) {
  const ctx = input.ctx
  const log = typeof input.log === 'function' ? input.log : () => {}
  const llm = serviceOf(ctx, 'llm')
  if (!llm || typeof llm.stream !== 'function') {
    log('[whale] 没有找到 DSH llm 服务，生成能力先不接')
    return null
  }
  const config = input.config || {}
  const timeoutMs = Math.max(10_000, Number((config.channel && config.channel.turnTimeoutMs) || 0) || 90_000)
  const model = resolveModel(ctx, config)
  if (!model) {
    log('[whale] 没有可用模型：请先在对话页选择模型，或在配置里填 modelProvider/model')
    return null
  }

  return async function runner(prompt, meta = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const conversation = String(meta.conversation || 'default')
    let text = ''
    let reasoning = ''
    let usage = null
    let finish = null
    try {
      const stream = llm.stream({
        provider: model.provider,
        model: model.model,
        sessionId: sessionIdOf(conversation),
        system:
          '你是深蓝鲸，在 QQ 上像真人一样简短自然地说话。只输出最终要发的那句话；' +
          '不要输出思考过程、内心独白、括号解释、分析、标题或“我在想什么”。' +
          // 这一句是给工具协议让路的：提示词里带了「行动规则」时，
          // 光说「只输出要说的话」会让模型把 [tool:…] 也当成不该输出的东西，
          // 结果该动手时只会嘴上答应。两条规则冲突时以行动规则为准。
          '例外：用户提示里若给了「行动规则」并要求调用工具，就只输出那几行工具调用（可以多行），不要附带解释。',
        messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt || '') || '（没有内容）' }] }],
        temperature: 1,
        maxTokens: Math.max(64, Number((config.channel && config.channel.maxOutputTokens) || 0) || 800),
        signal: controller.signal,
      })
      let lastThoughtAt = 0
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (/reason|think|analysis/i.test(String(chunk.type || ''))) {
          reasoning += textOfChunk(chunk, true)
          if (typeof meta.onThought === 'function' && Date.now() - lastThoughtAt > 800) {
            lastThoughtAt = Date.now()
            try { meta.onThought(reasoning) } catch {}
          }
        } else text += textOfChunk(chunk)
        if (chunk.type === 'finish') finish = chunk
        if (chunk.usage && (Number.isFinite(Number(chunk.usage.inputTokens ?? chunk.usage.input_tokens ?? chunk.usage.input)))) {
          const u = chunk.usage
          usage = {
            input: Number(u.inputTokens ?? u.input_tokens ?? u.input) || 0,
            output: Number(u.outputTokens ?? u.output_tokens ?? u.output) || 0,
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`模型调用超时（${timeoutMs}ms）`)
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (finish && finish.kind === 'error') {
      const failure = finish.failure || {}
      throw new Error(String(failure.message || failure.code || '模型调用失败'))
    }
    if (finish && finish.kind === 'aborted') throw new Error('模型调用已取消')
    const body = cleanReply(text)
    if (!body) {
      const reason = finish && finish.kind === 'max-tokens' ? '输出达到上限' : '模型没有返回文本'
      throw new Error(reason)
    }
    return { text: body, reasoning: reasoning.trim(), usage, model }  }
}
